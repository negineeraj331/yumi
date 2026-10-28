import { Router } from "express";
import {
  createWorkspaceSchema, changeRoleSchema, updateWorkspaceSettingsSchema,
  AUDIT_ACTIONS, AUDIT_GROUPS, auditActionsInGroup,
  isRegionId, REGION_MISMATCH_STATUS,
} from "@yumi/shared";
import {
  pinForNewWorkspace, regionMismatch, residencyStatus, knownRegions, deploymentRegion,
} from "../residency.js";
import { randomBytes } from "node:crypto";
import { Workspace, User, CollabSession, Analytics, AuditLog, mongoose } from "../models.js";
import { audit, clientIp } from "../auth.js";
import { config } from "../config.js";
import { scimTokenHash } from "./scim.routes.js";
import { requireAuth, requireWorkspaceRole, type AuthedRequest } from "../middleware.js";

const router = Router();
router.use(requireAuth);

/**
 * What an owner is allowed to see in this workspace's log.
 *
 * Account-level events (sign-ins, failed sign-ins, logouts) belong to a user
 * rather than a workspace, so they carry no workspaceId and would otherwise
 * never appear here — which would hide exactly the events an owner most needs.
 * They are included when the actor is a member of this workspace.
 *
 * A failed sign-in against an unknown email has no actor to attribute, so it
 * stays out of every workspace view by necessity.
 */
async function auditScope(workspaceId: string) {
  const ws = await Workspace.findById(workspaceId).select("members.userId").lean();
  const memberIds = ((ws as any)?.members ?? []).map((m: any) => m.userId).filter(Boolean);
  return [
    { workspaceId: new mongoose.Types.ObjectId(workspaceId) },
    { workspaceId: null, actorId: { $in: memberIds }, action: { $in: auditActionsInGroup("auth") } },
  ];
}

/**
 * Resolve actor ids to display names in one query — the log stores ids, but a
 * console showing raw ObjectIds is useless for the person reading it.
 */
async function withActorNames(rows: any[]) {
  const ids = [...new Set(rows.map((r) => r.actorId).filter(Boolean).map(String))];
  const users = await User.find({ _id: { $in: ids } }).select("displayName email").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((r) => {
    const u = r.actorId ? byId.get(String(r.actorId)) : undefined;
    return {
      _id: String(r._id),
      action: r.action,
      actorId: r.actorId ? String(r.actorId) : null,
      // A deleted user still has entries; say so rather than showing a bare id.
      actorName: (u as any)?.displayName ?? (r.actorId ? "(deleted user)" : "—"),
      target: r.target ?? {},
      meta: r.meta ?? {},
      ip: r.ip ?? null,
      ts: r.ts,
    };
  });
}

/**
 * List workspaces the user belongs to.
 *
 * Workspaces pinned to another region are left out rather than listed: their
 * names are their customer's data too, and a residency commitment that leaked
 * every workspace name to every regional tier would be a strange kind of
 * commitment. What is returned instead is a count per region and where to go —
 * enough for the dashboard to say "you have 2 workspaces in the EU" and link
 * there, without any of them crossing the border to say it.
 */
router.get("/", async (req: AuthedRequest, res) => {
  const all = await Workspace.find({ "members.userId": req.userId }).lean();
  const workspaces: typeof all = [];
  const counts = new Map<string, number>();
  for (const ws of all) {
    const region = (ws as any).settings?.dataResidencyRegion ?? null;
    if (regionMismatch(region)) counts.set(region, (counts.get(region) ?? 0) + 1);
    else workspaces.push(ws);
  }
  const known = knownRegions();
  res.json({
    workspaces,
    elsewhere: [...counts.entries()].map(([region, count]) => {
      const info = known.find((r) => r.id === region);
      return { region, label: info?.label ?? region, url: info?.url ?? null, count };
    }),
  });
});

// Create a workspace (creator becomes owner)
router.post("/", async (req: AuthedRequest, res) => {
  const parsed = createWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // The workspace is pinned to the region of the deployment that creates it,
  // because that is where the insert below actually lands. Asking for a
  // different region is refused with that region's address: honouring it would
  // write the rows here and merely label them as living somewhere else.
  const pin = pinForNewWorkspace();
  if (parsed.data.region) {
    const want = parsed.data.region.trim().toLowerCase();
    if (!isRegionId(want)) return res.status(400).json({ error: "Not a valid region id" });
    const mismatch = regionMismatch(want);
    if (mismatch) return res.status(REGION_MISMATCH_STATUS).json(mismatch);
  }

  const ws = await Workspace.create({
    name: parsed.data.name,
    ownerId: req.userId,
    members: [{ userId: req.userId, role: "owner" }],
    settings: { dataResidencyRegion: pin },
  });
  await audit({ workspaceId: String(ws._id), actorId: req.userId, action: "workspace.create", ip: clientIp(req) });
  if (pin) {
    // Recorded separately from the creation itself: where a customer's data is
    // held is a compliance fact, and it should be findable in the log under its
    // own action rather than inferred from a field on another event.
    await audit({
      workspaceId: String(ws._id), actorId: req.userId, action: "residency.pinned",
      meta: { region: pin, immutable: true }, ip: clientIp(req),
    });
  }
  res.status(201).json({ workspace: ws });
});

/**
 * Where this deployment stores data, and which regions it knows how to point at
 * — so the dashboard can name the region a new workspace will be pinned to
 * before anyone commits to it. Deliberately says nothing about any workspace,
 * and is declared above `/:workspaceId` so "regions" isn't read as an id.
 */
router.get("/regions", (_req, res) => {
  res.json({ region: deploymentRegion(), regions: knownRegions() });
});

// Get one workspace (with member details)
router.get("/:workspaceId", requireWorkspaceRole("viewer"), async (req, res) => {
  const ws = await Workspace.findById(req.params.workspaceId)
    .populate("members.userId", "displayName email avatarColor")
    .lean();
  res.json({ workspace: ws });
});

// Recent collaborative sessions in a workspace (with analytics) — any member
router.get("/:workspaceId/sessions", requireWorkspaceRole("viewer"), async (req, res) => {
  const sessions = await CollabSession.find({ workspaceId: req.params.workspaceId })
    .sort({ startedAt: -1 })
    .limit(20)
    .populate("projectId", "name type")
    .populate("participants.userId", "displayName avatarColor")
    .lean();
  const analytics = await Analytics.find({
    sessionId: { $in: sessions.map((s) => s._id) },
  }).lean();
  const byId = new Map(analytics.map((a) => [String(a.sessionId), a.metrics]));
  res.json({
    sessions: sessions.map((s) => ({ ...s, metrics: byId.get(String(s._id)) ?? null })),
  });
});

/* ------------------------- Admin console (owner) ------------------------- */

/**
 * Audit log query. Owner-only: the log records who did what and from which IP,
 * so it is strictly more sensitive than the workspace contents themselves.
 * Cursor pagination on `ts` — an append-only log is only ever read newest-first,
 * and skip/limit would drift as new entries land mid-scroll.
 */
router.get("/:workspaceId/audit", requireWorkspaceRole("owner"), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const filter: Record<string, unknown> = { $or: await auditScope(req.params.workspaceId) };

  const { action, group, actorId, from, to, before } = req.query as Record<string, string>;
  if (action) filter.action = action;
  else if (group && (AUDIT_GROUPS as readonly string[]).includes(group)) {
    filter.action = { $in: auditActionsInGroup(group) };
  }
  if (actorId) filter.actorId = actorId;

  const ts: Record<string, Date> = {};
  if (from && !Number.isNaN(Date.parse(from))) ts.$gte = new Date(from);
  if (to && !Number.isNaN(Date.parse(to))) ts.$lte = new Date(to);
  // `before` is the cursor: strictly older than the last row already shown.
  if (before && !Number.isNaN(Date.parse(before))) ts.$lt = new Date(before);
  if (Object.keys(ts).length) filter.ts = ts;

  // Fetch one extra row to know whether another page exists.
  const rows = await AuditLog.find(filter).sort({ ts: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    entries: await withActorNames(page),
    hasMore,
    nextCursor: hasMore ? page[page.length - 1].ts : null,
  });
});

/** Counts per action + a security-event total, for the console's summary row. */
router.get("/:workspaceId/audit/stats", requireWorkspaceRole("owner"), async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await AuditLog.aggregate([
    { $match: { $or: await auditScope(req.params.workspaceId), ts: { $gte: since } } },
    { $group: { _id: "$action", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const byAction = rows.map((r: any) => ({ action: r._id, count: r.count }));
  const securityIds = new Set(AUDIT_ACTIONS.filter((a) => (a as any).security).map((a) => a.id));
  res.json({
    days,
    total: byAction.reduce((n: number, r: any) => n + r.count, 0),
    securityEvents: byAction.filter((r: any) => securityIds.has(r.action)).reduce((n: number, r: any) => n + r.count, 0),
    failedLogins: byAction.find((r: any) => r.action === "auth.login.failed")?.count ?? 0,
    byAction,
  });
});

/** CSV export of the current filter — capped so one request can't stream the whole log. */
router.get("/:workspaceId/audit/export.csv", requireWorkspaceRole("owner"), async (req: AuthedRequest, res) => {
  const filter: Record<string, unknown> = { $or: await auditScope(req.params.workspaceId) };
  const { action, from, to } = req.query as Record<string, string>;
  if (action) filter.action = action;
  const ts: Record<string, Date> = {};
  if (from && !Number.isNaN(Date.parse(from))) ts.$gte = new Date(from);
  if (to && !Number.isNaN(Date.parse(to))) ts.$lte = new Date(to);
  if (Object.keys(ts).length) filter.ts = ts;

  const rows = await withActorNames(await AuditLog.find(filter).sort({ ts: -1 }).limit(10_000).lean());

  // Quote every field and double embedded quotes; a leading =,+,-,@ is prefixed
  // with a quote so spreadsheets don't execute it as a formula.
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const header = ["timestamp", "action", "actor", "actorId", "ip", "target", "meta"];
  const body = rows.map((r) =>
    [r.ts, r.action, r.actorName, r.actorId, r.ip, r.target, r.meta].map(cell).join(","));

  await audit({
    workspaceId: req.params.workspaceId, actorId: req.userId,
    action: "workspace.settings.updated", meta: { exported: rows.length, what: "audit.csv" }, ip: clientIp(req),
  });

  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="yumi-audit-${req.params.workspaceId}.csv"`);
  res.send([header.join(","), ...body].join("\n"));
});

/** Workspace settings incl. audit retention (owner only). */
router.get("/:workspaceId/settings", requireWorkspaceRole("owner"), async (req, res) => {
  const ws = await Workspace.findById(req.params.workspaceId).select("settings name").lean();
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  res.json({
    name: (ws as any).name,
    settings: {
      defaultLinkScope: (ws as any).settings?.defaultLinkScope ?? "viewer",
      auditRetentionDays: (ws as any).settings?.auditRetentionDays ?? 0,
      dataResidencyRegion: (ws as any).settings?.dataResidencyRegion ?? null,
    },
  });
});

/** Residency for one workspace, plus what the pin does and does not cover (any member). */
router.get("/:workspaceId/residency", requireWorkspaceRole("viewer"), async (req, res) => {
  const ws = await Workspace.findById(req.params.workspaceId).select("settings.dataResidencyRegion").lean();
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  res.json({ residency: residencyStatus((ws as any).settings?.dataResidencyRegion ?? null) });
});

router.patch("/:workspaceId/settings", requireWorkspaceRole("owner"), async (req: AuthedRequest, res) => {
  // The DTO has no region field, and zod would strip one silently — which is
  // exactly how a setting ends up looking changeable while changing nothing.
  // The pin is fixed at creation, so an attempt to move it is answered.
  if (req.body && "dataResidencyRegion" in req.body) {
    return res.status(409).json({
      error: "A workspace's data region cannot be changed after it is created. The data is already written; relabelling it would not move it. Create a workspace in the target region and migrate deliberately.",
    });
  }
  const parsed = updateWorkspaceSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ws = await Workspace.findById(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });

  const before = {
    defaultLinkScope: (ws as any).settings?.defaultLinkScope ?? "viewer",
    auditRetentionDays: (ws as any).settings?.auditRetentionDays ?? 0,
  };
  if (parsed.data.auditRetentionDays !== undefined) {
    (ws as any).settings.auditRetentionDays = parsed.data.auditRetentionDays;
  }
  if (parsed.data.defaultLinkScope !== undefined) {
    (ws as any).settings.defaultLinkScope = parsed.data.defaultLinkScope;
  }
  await ws.save();

  // Changing retention decides when evidence disappears — always record it.
  await audit({
    workspaceId: String(ws._id), actorId: req.userId, action: "workspace.settings.updated",
    meta: { before, after: parsed.data }, ip: clientIp(req),
  });
  res.json({ settings: (ws as any).settings });
});

/* ------------------------- Directory sync (SCIM) ------------------------- */

/** What the console may see. The token itself exists in plaintext exactly once. */
function scimStatus(ws: any) {
  const s = ws?.scim;
  return {
    configured: Boolean(s?.tokenHash),
    tokenHint: s?.tokenHint || null,
    defaultRole: (s?.defaultRole as "editor" | "viewer") ?? "viewer",
    createdAt: s?.createdAt ?? null,
    lastUsedAt: s?.lastUsedAt ?? null,
    baseUrl: `${config.publicUrl}/scim/v2`,
  };
}

router.get("/:workspaceId/scim", requireWorkspaceRole("owner"), async (req, res) => {
  const ws = await Workspace.findById(req.params.workspaceId).select("scim").lean();
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  res.json({ scim: scimStatus(ws) });
});

/**
 * Issue a token. Generating a second one replaces the first — a directory
 * integration has exactly one credential, and "which of these three is live?"
 * is not a question an owner should have to answer during an incident.
 */
router.post("/:workspaceId/scim/token", requireWorkspaceRole("owner"), async (req: AuthedRequest, res) => {
  const role = req.body?.defaultRole === "editor" ? "editor" : "viewer";
  const ws = await Workspace.findById(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });

  const token = `yscim_${randomBytes(32).toString("base64url")}`;
  const replaced = Boolean((ws as any).scim?.tokenHash);
  (ws as any).scim = {
    tokenHash: scimTokenHash(token),
    tokenHint: token.slice(-4),
    defaultRole: role,
    createdBy: req.userId,
    createdAt: new Date(),
    lastUsedAt: null,
  };
  await ws.save();

  await audit({
    workspaceId: String(ws._id), actorId: req.userId, action: "scim.token.created",
    meta: { defaultRole: role, replacedPrevious: replaced }, ip: clientIp(req),
  });
  // The only time the token is ever returned.
  res.status(201).json({ token, scim: scimStatus(ws) });
});

router.delete("/:workspaceId/scim/token", requireWorkspaceRole("owner"), async (req: AuthedRequest, res) => {
  const ws = await Workspace.findById(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  if (!(ws as any).scim?.tokenHash) return res.status(404).json({ error: "Directory sync is not configured" });
  (ws as any).scim = undefined;
  await ws.save();
  await audit({
    workspaceId: String(ws._id), actorId: req.userId, action: "scim.token.revoked",
    ip: clientIp(req),
  });
  res.json({ scim: scimStatus(ws) });
});

// Change a member's role (owner only)
router.patch("/:workspaceId/members", requireWorkspaceRole("owner"), async (req: AuthedRequest, res) => {
  const parsed = changeRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { userId, role } = parsed.data;

  const ws = await Workspace.findById(req.params.workspaceId);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });

  // Prevent removing the last owner
  if (role !== "owner") {
    const owners = ws.members.filter((m) => m.role === "owner");
    if (owners.length === 1 && String(owners[0].userId) === userId) {
      return res.status(400).json({ error: "Cannot demote the last owner" });
    }
  }

  const member = ws.members.find((m) => String(m.userId) === userId);
  // Capture the prior role before mutating — a role change is only meaningful
  // in the audit log if it says what it changed *from*.
  const previous = member?.role;
  if (member) member.role = role;
  else ws.members.push({ userId: userId as any, role, joinedAt: new Date() });
  await ws.save();

  await audit({
    workspaceId: String(ws._id),
    actorId: req.userId,
    action: "role.changed",
    target: { userId },
    meta: { role, previousRole: previous ?? null },
    ip: clientIp(req),
  });
  res.json({ workspace: ws });
});

export default router;
