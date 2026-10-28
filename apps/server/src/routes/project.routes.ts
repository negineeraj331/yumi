import { Router } from "express";
import { nanoid } from "nanoid";
import * as Y from "yjs";
import {
  createProjectSchema, createFileSchema, updateFileSchema,
  linkGithubSchema, importGithubSchema, languageForFilename,
  linkFigmaSchema, importFigmaSchema, parseFigmaKey,
  linkSlackSchema, updateSlackSchema, isSlackEvent,
  type ResidencyEgressFeature,
} from "@yumi/shared";
import { Project, File, CrdtUpdate, User, toBytes } from "../models.js";
import { audit, clientIp } from "../auth.js";
import {
  requireAuth, requireWorkspaceRole, requireProjectAccess, requireProjectContext,
  type AuthedRequest,
} from "../middleware.js";
import { isE2ee } from "../gateway.js";
import { egressBlockReason, auditEgressBlock } from "../residency.js";
import { getRepo, listCommits, getCommit, getContents } from "../github.js";
import { getFile as getFigmaFile, renderNodeDataUrl } from "../figma.js";
import { postWebhook } from "../slack.js";

const router = Router();
router.use(requireAuth);

// List projects in a workspace
router.get("/workspace/:workspaceId", requireWorkspaceRole("viewer"), async (req, res) => {
  const projects = await Project.find({ workspaceId: req.params.workspaceId })
    .sort({ updatedAt: -1 })
    .lean();
  res.json({ projects });
});

// Create a project (editor+), seed with a starter file for code/mixed
router.post("/", requireWorkspaceRole("editor", "body"), async (req: AuthedRequest, res) => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { workspaceId, name, type, e2ee, e2eeKeyCheck } = parsed.data;

  const project = await Project.create({
    workspaceId, name, type, createdBy: req.userId,
    e2ee: Boolean(e2ee),
    e2eeKeyCheck: e2ee ? e2eeKeyCheck : null,
  });

  if (type === "code" || type === "mixed") {
    await File.create({
      projectId: project._id,
      path: "main.js",
      language: "javascript",
      docId: `file:${nanoid(10)}`,
    });
  }
  await audit({ workspaceId, actorId: req.userId, action: "project.create", target: { projectId: String(project._id) }, ip: clientIp(req) });
  res.status(201).json({ project });
});

// Get a project + its files (any member)
router.get("/:projectId", async (req: AuthedRequest, res) => {
  const role = await requireProjectAccess(req, res, req.params.projectId);
  if (!role) return;
  const project = await Project.findById(req.params.projectId).lean();
  const files = await File.find({ projectId: req.params.projectId }).lean();
  res.json({ project, files, role });
});

// Replay timeline: chronological list of revisions (seq + author + time) for a doc.
router.get("/:projectId/history/:docId", async (req: AuthedRequest, res) => {
  if (!(await requireProjectAccess(req, res, req.params.projectId))) return;

  const updates = await CrdtUpdate.find({ projectId: req.params.projectId, docId: req.params.docId })
    .sort({ seq: 1 })
    .select("seq ts userId")
    .lean();

  // Resolve unique authors once.
  const authorIds = [...new Set(updates.map((u) => String(u.userId)).filter(Boolean))];
  const users = await User.find({ _id: { $in: authorIds } }).select("displayName avatarColor").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const timeline = updates.map((u) => {
    const a = u.userId ? byId.get(String(u.userId)) : undefined;
    return { seq: u.seq, ts: u.ts, authorName: (a as any)?.displayName ?? "Unknown", authorColor: (a as any)?.avatarColor ?? "#888" };
  });
  res.json({ docId: req.params.docId, count: timeline.length, timeline });
});

// Replay snapshot: reconstruct the doc's text content as of a given seq (inclusive).
router.get("/:projectId/replay/:docId", async (req: AuthedRequest, res) => {
  if (!(await requireProjectAccess(req, res, req.params.projectId))) return;

  // Replay works by re-applying the update log server-side. For an encrypted
  // project that log is ciphertext, so there is nothing to reconstruct — and
  // saying so is better than returning a convincing empty document.
  if (await isE2ee(req.params.projectId)) {
    return res.status(409).json({
      error: "Replay is unavailable in an end-to-end encrypted project: the server holds only ciphertext and cannot rebuild the document.",
    });
  }

  const upTo = Number(req.query.upTo);
  const filter: any = { projectId: req.params.projectId, docId: req.params.docId };
  if (Number.isFinite(upTo)) filter.seq = { $lte: upTo };

  const updates = await CrdtUpdate.find(filter).sort({ seq: 1 }).lean();
  const doc = new Y.Doc();
  Y.transact(doc, () => {
    for (const u of updates) {
      try {
        const bytes = toBytes(u.update);
        if (bytes.length) Y.applyUpdate(doc, bytes);
      } catch { /* skip a corrupt frame */ }
    }
  });
  const text = doc.getText("codemirror").toString();
  const appliedSeq = updates.length ? updates[updates.length - 1].seq : 0;
  doc.destroy();
  res.json({ docId: req.params.docId, seq: appliedSeq, text });
});

/* ---------------------------- Integrations ------------------------------- */

// Redacted view of a project's linked repo (never exposes the token).
function redactGithub(gh: any) {
  if (!gh) return null;
  return { owner: gh.owner, repo: gh.repo, defaultBranch: gh.defaultBranch, linkedAt: gh.linkedAt, hasToken: !!gh.token };
}

// Redacted view of a linked Figma file (never exposes the PAT).
function redactFigma(f: any) {
  if (!f) return null;
  return { fileKey: f.fileKey, fileName: f.fileName, linkedAt: f.linkedAt, hasToken: !!f.token };
}

// Redacted view of a Slack link. The webhook URL *is* the credential, so it is
// never returned — only enough to show which channel is wired up.
function redactSlack(s: any) {
  if (!s) return null;
  return { channelLabel: s.channelLabel, events: s.events ?? [], linkedAt: s.linkedAt, hasWebhook: !!s.webhookUrl };
}

/**
 * Load the project + assert membership; optionally require editor.
 *
 * The third party is a required argument rather than an afterthought: every one
 * of these routes hands something to a service outside the deployment, so the
 * residency check belongs to *loading* the project for an integration, not to
 * whichever handler remembers to ask. The whole surface is refused together —
 * link, browse and import alike — because "you may browse this repo but not
 * link it" is not a residency rule anyone could act on.
 */
async function loadForIntegration(
  req: AuthedRequest,
  res: any,
  needEditor: boolean,
  feature: ResidencyEgressFeature,
) {
  const ctx = await requireProjectContext(req, res, req.params.projectId, needEditor ? "editor" : "viewer");
  if (!ctx) return null;

  const blocked = egressBlockReason(ctx.region, feature);
  if (blocked) {
    await auditEgressBlock(ctx.workspaceId, req.userId, feature, ctx.region!);
    res.status(409).json({ error: blocked, code: "residency_egress" });
    return null;
  }

  const project = await Project.findById(req.params.projectId);
  if (!project) { res.status(404).json({ error: "Project not found" }); return null; }
  return project;
}

const ghErr = (res: any, e: any) => res.status(e?.status === 404 ? 404 : 502).json({ error: e?.message ?? "GitHub request failed" });

// Get linked repo (any member)
router.get("/:projectId/github", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, false, "github"); if (!project) return;
  res.json({ github: redactGithub((project as any).github) });
});

// Link a repo (editor+). Validates it exists / is reachable.
router.post("/:projectId/github", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "github"); if (!project) return;
  const parsed = linkGithubSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { owner, repo, branch, token } = parsed.data;
  try {
    const meta = await getRepo(owner, repo, token);
    (project as any).github = {
      owner, repo, defaultBranch: branch || meta.defaultBranch || "main",
      token: token ?? "", linkedBy: req.userId, linkedAt: new Date(),
    };
    await project.save();
    await audit({ actorId: req.userId, action: "github.link", target: { projectId: String(project._id), repo: `${owner}/${repo}` }, ip: clientIp(req) });
    res.status(201).json({ github: redactGithub((project as any).github), repo: meta });
  } catch (e) { return ghErr(res, e); }
});

// Unlink (editor+)
router.delete("/:projectId/github", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "github"); if (!project) return;
  (project as any).github = undefined;
  await project.save();
  await audit({ actorId: req.userId, action: "github.unlink", target: { projectId: String(project._id) }, ip: clientIp(req) });
  res.json({ ok: true });
});

// Recent commits (any member)
router.get("/:projectId/github/commits", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, false, "github"); if (!project) return;
  const gh = (project as any).github;
  if (!gh) return res.status(409).json({ error: "No repo linked" });
  try {
    const branch = (req.query.branch as string) || gh.defaultBranch;
    const commits = await listCommits(gh.owner, gh.repo, gh.token, branch);
    res.json({ commits, branch });
  } catch (e) { return ghErr(res, e); }
});

// Commit detail + per-file diffs (any member)
router.get("/:projectId/github/commit/:sha", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, false, "github"); if (!project) return;
  const gh = (project as any).github;
  if (!gh) return res.status(409).json({ error: "No repo linked" });
  try {
    res.json({ commit: await getCommit(gh.owner, gh.repo, req.params.sha, gh.token) });
  } catch (e) { return ghErr(res, e); }
});

// Browse repo contents — dir listing or file content (any member)
router.get("/:projectId/github/contents", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, false, "github"); if (!project) return;
  const gh = (project as any).github;
  if (!gh) return res.status(409).json({ error: "No repo linked" });
  try {
    const path = (req.query.path as string) || "";
    const ref = (req.query.ref as string) || gh.defaultBranch;
    res.json(await getContents(gh.owner, gh.repo, path, gh.token, ref));
  } catch (e) { return ghErr(res, e); }
});

// Import a repo file as a new collaborative file, seeded with its content (editor+)
router.post("/:projectId/github/import", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "github"); if (!project) return;
  const gh = (project as any).github;
  if (!gh) return res.status(409).json({ error: "No repo linked" });
  const parsed = importGithubSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  // Import works by seeding a Yjs document on the server, which would write
  // plaintext into a project whose whole premise is that the server holds none.
  if (await isE2ee(req.params.projectId)) {
    return res.status(409).json({
      error: "Importing into an end-to-end encrypted project is not supported: the server would have to write the file's contents in the clear.",
    });
  }

  try {
    const ref = parsed.data.ref || gh.defaultBranch;
    const file = await getContents(gh.owner, gh.repo, parsed.data.path, gh.token, ref);
    if (file.kind !== "file") return res.status(400).json({ error: "Path is a directory, not a file" });

    const targetPath = parsed.data.as || file.name;
    const exists = await File.findOne({ projectId: project._id, path: targetPath });
    if (exists) return res.status(409).json({ error: "A file with that name already exists" });

    const docId = `file:${nanoid(10)}`;
    const created = await File.create({
      projectId: project._id, path: targetPath,
      language: languageForFilename(targetPath), docId,
    });

    // Seed the Yjs doc with the file content so it opens pre-populated.
    const doc = new Y.Doc();
    doc.getText("codemirror").insert(0, file.content as string);
    const update = Y.encodeStateAsUpdate(doc);
    await CrdtUpdate.create({ projectId: project._id, docId, seq: 1, update: Buffer.from(update), userId: req.userId });
    doc.destroy();

    res.status(201).json({ file: created });
  } catch (e) { return ghErr(res, e); }
});

/* -------------------------------- Figma ---------------------------------- */

const figErr = (res: any, e: any) =>
  res.status(e?.status === 404 ? 404 : e?.status === 413 ? 413 : 502).json({ error: e?.message ?? "Figma request failed" });

// Get the linked Figma file (any member)
router.get("/:projectId/figma", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, false, "figma"); if (!project) return;
  res.json({ figma: redactFigma((project as any).figma) });
});

// Link a Figma file (editor+). Validates the key/URL and that the token can read it.
router.post("/:projectId/figma", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "figma"); if (!project) return;
  const parsed = linkFigmaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const fileKey = parseFigmaKey(parsed.data.file);
  if (!fileKey) return res.status(400).json({ error: "Not a Figma file key or URL" });

  try {
    const meta = await getFigmaFile(fileKey, parsed.data.token);
    (project as any).figma = {
      fileKey, fileName: meta.name, token: parsed.data.token,
      linkedBy: req.userId, linkedAt: new Date(),
    };
    await project.save();
    await audit({ actorId: req.userId, action: "figma.link", target: { projectId: String(project._id) }, ip: clientIp(req) });
    res.status(201).json({ figma: redactFigma((project as any).figma), file: meta });
  } catch (e) { return figErr(res, e); }
});

// Unlink (editor+)
router.delete("/:projectId/figma", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "figma"); if (!project) return;
  (project as any).figma = undefined;
  await project.save();
  await audit({ actorId: req.userId, action: "figma.unlink", target: { projectId: String(project._id) }, ip: clientIp(req) });
  res.json({ ok: true });
});

// Browse pages + frames of the linked file (any member)
router.get("/:projectId/figma/file", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, false, "figma"); if (!project) return;
  const fig = (project as any).figma;
  if (!fig) return res.status(409).json({ error: "No Figma file linked" });
  try {
    res.json({ file: await getFigmaFile(fig.fileKey, fig.token) });
  } catch (e) { return figErr(res, e); }
});

// Render one frame to an inline data URL, ready to place on the canvas (editor+).
// Proxied server-side: Figma's render URLs expire and are cross-origin.
router.post("/:projectId/figma/render", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "figma"); if (!project) return;
  const fig = (project as any).figma;
  if (!fig) return res.status(409).json({ error: "No Figma file linked" });
  const parsed = importFigmaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const out = await renderNodeDataUrl(fig.fileKey, parsed.data.nodeId, fig.token, parsed.data.scale ?? 2);
    res.json(out);
  } catch (e) { return figErr(res, e); }
});

/* -------------------------------- Slack ---------------------------------- */

// Get the Slack link (any member) — webhook URL is never included
router.get("/:projectId/slack", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, false, "slack"); if (!project) return;
  res.json({ slack: redactSlack((project as any).slack) });
});

// Link a webhook (editor+). Verified by posting a confirmation message, so a
// bad URL is rejected at link time rather than silently failing forever.
router.post("/:projectId/slack", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "slack"); if (!project) return;
  const parsed = linkSlackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const events = (parsed.data.events ?? []).filter(isSlackEvent);
  const check = await postWebhook(parsed.data.webhookUrl, {
    text: `:link: *${project.name}* is now connected to Slack from Yumi.`,
    context: ["You'll get notifications for the events selected in the project."],
  });
  if (!check.ok) return res.status(502).json({ error: check.reason ?? "Slack rejected that webhook" });

  (project as any).slack = {
    webhookUrl: parsed.data.webhookUrl,
    channelLabel: parsed.data.channelLabel ?? "",
    events, linkedBy: req.userId, linkedAt: new Date(),
  };
  await project.save();
  await audit({ actorId: req.userId, action: "slack.link", target: { projectId: String(project._id) }, ip: clientIp(req) });
  res.status(201).json({ slack: redactSlack((project as any).slack) });
});

// Change which events notify (editor+)
router.patch("/:projectId/slack", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "slack"); if (!project) return;
  const slack = (project as any).slack;
  if (!slack) return res.status(409).json({ error: "Slack is not linked" });
  const parsed = updateSlackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  slack.events = parsed.data.events.filter(isSlackEvent);
  await project.save();
  await audit({
    actorId: req.userId, action: "slack.events.updated",
    target: { projectId: String(project._id) }, meta: { events: slack.events }, ip: clientIp(req),
  });
  res.json({ slack: redactSlack(slack) });
});

// Unlink (editor+)
router.delete("/:projectId/slack", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "slack"); if (!project) return;
  (project as any).slack = undefined;
  await project.save();
  await audit({ actorId: req.userId, action: "slack.unlink", target: { projectId: String(project._id) }, ip: clientIp(req) });
  res.json({ ok: true });
});

// Send a test message to the linked channel (editor+)
router.post("/:projectId/slack/test", async (req: AuthedRequest, res) => {
  const project = await loadForIntegration(req, res, true, "slack"); if (!project) return;
  const slack = (project as any).slack;
  if (!slack?.webhookUrl) return res.status(409).json({ error: "Slack is not linked" });
  const r = await postWebhook(slack.webhookUrl, {
    text: `:bell: Test notification from *${project.name}* (Yumi).`,
    context: ["If you can read this, notifications are working."],
  });
  if (!r.ok) return res.status(502).json({ error: r.reason ?? "Slack rejected the message" });
  res.json({ ok: true });
});

// Create a file in a project (editor+)
router.post("/:projectId/files", async (req: AuthedRequest, res) => {
  if (!(await requireProjectAccess(req, res, req.params.projectId, "editor"))) return;
  const parsed = createFileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const exists = await File.findOne({ projectId: req.params.projectId, path: parsed.data.path });
  if (exists) return res.status(409).json({ error: "A file with that name already exists" });

  const file = await File.create({
    projectId: req.params.projectId,
    path: parsed.data.path,
    language: parsed.data.language,
    docId: `file:${nanoid(10)}`,
  });
  await audit({
    actorId: req.userId, action: "file.create",
    target: { projectId: req.params.projectId, path: file.path }, ip: clientIp(req),
  });
  res.status(201).json({ file });
});

// Update a file's language or path (editor+)
router.patch("/:projectId/files/:fileId", async (req: AuthedRequest, res) => {
  if (!(await requireProjectAccess(req, res, req.params.projectId, "editor"))) return;
  const parsed = updateFileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const file = await File.findOneAndUpdate(
    { _id: req.params.fileId, projectId: req.params.projectId },
    { $set: parsed.data },
    { new: true }
  );
  if (!file) return res.status(404).json({ error: "File not found" });
  await audit({
    actorId: req.userId, action: "file.rename",
    target: { projectId: req.params.projectId, path: file.path },
    meta: { changed: Object.keys(parsed.data) }, ip: clientIp(req),
  });
  res.json({ file });
});

// Delete a file (editor+)
router.delete("/:projectId/files/:fileId", async (req: AuthedRequest, res) => {
  if (!(await requireProjectAccess(req, res, req.params.projectId, "editor"))) return;
  const file = await File.findOneAndDelete({ _id: req.params.fileId, projectId: req.params.projectId });
  if (!file) return res.status(404).json({ error: "File not found" });
  await audit({
    actorId: req.userId, action: "file.delete",
    target: { projectId: req.params.projectId, path: file.path }, ip: clientIp(req),
  });
  res.json({ ok: true });
});

export default router;
