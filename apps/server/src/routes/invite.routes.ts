import { Router } from "express";
import { nanoid } from "nanoid";
import { createInviteSchema } from "@yumi/shared";
import { Invite, Workspace } from "../models.js";
import { audit, clientIp } from "../auth.js";
import { requireAuth, requireWorkspaceRole, type AuthedRequest } from "../middleware.js";
import { regionMismatch, auditRegionBlock } from "../residency.js";
import { REGION_MISMATCH_STATUS } from "@yumi/shared";

const router = Router();

/**
 * An invite is the one path into a workspace that does not start from
 * membership, so it cannot lean on the guards in middleware.ts — a link mailed
 * to someone will be opened wherever their browser happens to resolve, and
 * accepting writes a member row. Holding the token is itself the claim to know
 * about the workspace, so the refusal names where to continue instead.
 */
async function wrongRegion(req: AuthedRequest, res: any, ws: { _id: unknown; settings?: any }) {
  const mismatch = regionMismatch(ws.settings?.dataResidencyRegion ?? null);
  if (!mismatch) return false;
  await auditRegionBlock(String(ws._id), req.userId, {
    via: "invite", region: mismatch.region, path: req.originalUrl, ip: clientIp(req),
  });
  res.status(REGION_MISMATCH_STATUS).json(mismatch);
  return true;
}

// Create an invite link (editor+). Returns a shareable token.
router.post("/", requireAuth, requireWorkspaceRole("editor", "body"), async (req: AuthedRequest, res) => {
  const parsed = createInviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { workspaceId, scope, expiresInHours, requireLogin, singleUse } = parsed.data;

  const invite = await Invite.create({
    workspaceId,
    scope,
    token: nanoid(24),
    expiresAt: expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000) : null,
    requireLogin,
    singleUse,
    createdBy: req.userId,
  });
  await audit({ workspaceId, actorId: req.userId, action: "invite.created", meta: { scope }, ip: clientIp(req) });
  res.status(201).json({ token: invite.token, scope: invite.scope });
});

// Resolve invite metadata (public — no auth needed to preview)
router.get("/:token", async (req, res) => {
  const invite = await Invite.findOne({ token: req.params.token }).lean();
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.expiresAt && invite.expiresAt < new Date())
    return res.status(410).json({ error: "Invite expired" });
  const ws = await Workspace.findById(invite.workspaceId).lean();
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  // Even the workspace's name stays in its region.
  if (await wrongRegion(req as AuthedRequest, res, ws)) return;
  res.json({
    workspaceName: ws.name,
    scope: invite.scope,
    requireLogin: invite.requireLogin,
  });
});

// Accept an invite (must be authenticated) — adds membership at invite scope
router.post("/:token/accept", requireAuth, async (req: AuthedRequest, res) => {
  const invite = await Invite.findOne({ token: req.params.token });
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  if (invite.expiresAt && invite.expiresAt < new Date())
    return res.status(410).json({ error: "Invite expired" });
  if (invite.singleUse && invite.usedBy.length > 0)
    return res.status(410).json({ error: "Invite already used" });

  const ws = await Workspace.findById(invite.workspaceId);
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  if (await wrongRegion(req, res, ws)) return;

  const already = ws.members.find((m) => String(m.userId) === req.userId);
  if (!already) {
    ws.members.push({ userId: req.userId as any, role: invite.scope, joinedAt: new Date() });
    await ws.save();
  }
  invite.usedBy.push(req.userId as any);
  await invite.save();

  await audit({ workspaceId: String(ws._id), actorId: req.userId, action: "invite.accepted", ip: clientIp(req) });
  res.json({ workspaceId: String(ws._id), role: already?.role ?? invite.scope });
});

export default router;
