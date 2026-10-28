import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, isSuspended, clientIp } from "./auth.js";
import { Workspace, Project } from "./models.js";
import { roleAtLeast, REGION_MISMATCH_STATUS, type Role } from "@yumi/shared";
import { regionMismatch, auditRegionBlock } from "./residency.js";

export interface AuthedRequest extends Request {
  userId?: string;
}

/** Requires a valid access token (Authorization: Bearer <token>). */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  // An access token is self-contained, so a suspended account would otherwise
  // keep working until the token expired — the opposite of what deprovisioning
  // is for. This is the same Redis round-trip the rate limiter already makes.
  try {
    if (await isSuspended(payload.sub)) {
      return res.status(401).json({ error: "This account has been deactivated" });
    }
  } catch (err) {
    // Fail open, loudly. This check is a fast path on top of the database,
    // which is still consulted wherever a token is issued — and issuing is
    // already impossible while Redis is down, since refresh sessions live
    // there too. So the exposure is one access-token lifetime, against
    // signing every user out for the duration of a cache blip.
    console.warn("[auth] suspension check unavailable, allowing request:", (err as Error).message);
  }
  req.userId = payload.sub;
  next();
}

/**
 * A user's standing in a workspace: their role, and where the workspace's data
 * is pinned. Both come from the one document read, because every guard needs
 * both and asking twice would double the cost of the hottest query there is.
 */
export interface WorkspaceAccess {
  role: Role | null;
  region: string | null;
}

export async function getWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceAccess> {
  const ws = await Workspace.findById(workspaceId)
    .select("members.userId members.role settings.dataResidencyRegion")
    .lean()
    .catch(() => null);
  if (!ws) return { role: null, region: null };
  const member = (ws.members ?? []).find((m) => String(m.userId) === String(userId));
  return {
    role: (member?.role as Role) ?? null,
    region: (ws as any).settings?.dataResidencyRegion ?? null,
  };
}

/** Resolve a user's role in a workspace, or null if not a member. */
export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<Role | null> {
  return (await getWorkspaceAccess(workspaceId, userId)).role;
}

/**
 * Answer a request that reached the wrong region, and record the attempt.
 *
 * Membership is checked *before* this, deliberately: telling a stranger which
 * region a workspace lives in would turn every endpoint into an oracle for
 * whether a given workspace id exists. A non-member gets the same 403 they
 * always did; only someone with legitimate access is told where to go instead.
 */
async function refuseWrongRegion(
  req: AuthedRequest,
  res: Response,
  workspaceId: string,
  mismatch: NonNullable<ReturnType<typeof regionMismatch>>,
  via: string,
) {
  await auditRegionBlock(workspaceId, req.userId, {
    via,
    region: mismatch.region,
    path: req.originalUrl ?? req.path,
    ip: clientIp(req),
  });
  return res.status(REGION_MISMATCH_STATUS).json(mismatch);
}

/** Express guard: require at least `min` role in the workspace named by param/body. */
export function requireWorkspaceRole(min: Role, source: "param" | "body" = "param") {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const workspaceId =
      source === "param" ? req.params.workspaceId : (req.body?.workspaceId as string);
    if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });
    const { role, region } = await getWorkspaceAccess(workspaceId, req.userId!);
    if (!role || !roleAtLeast(role, min)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    // Reads are gated too: serving a pinned workspace's contents from another
    // region moves the data out of it just as surely as writing would.
    const mismatch = regionMismatch(region);
    if (mismatch) return refuseWrongRegion(req, res, workspaceId, mismatch, "rest");
    next();
  };
}

/**
 * Role + residency for a project, resolved through its workspace. Every project
 * and message route funnels through here, which is what makes one check enough.
 */
export interface ProjectAccess {
  role: Role | null;
  region: string | null;
  workspaceId: string | null;
}

export async function getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess> {
  const project = await Project.findById(projectId).select("workspaceId").lean().catch(() => null);
  if (!project) return { role: null, region: null, workspaceId: null };
  const workspaceId = String(project.workspaceId);
  const { role, region } = await getWorkspaceAccess(workspaceId, userId);
  return { role, region, workspaceId };
}

/** Resolve the workspace role for a given project (used by socket + project routes). */
export async function getProjectRole(projectId: string, userId: string): Promise<Role | null> {
  return (await getProjectAccess(projectId, userId)).role;
}

/**
 * Guard for a project-scoped route: resolves the caller's role, or answers the
 * request itself and returns null. Callers do `if (!role) return;` — which
 * replaces a 403 that was hand-written at every call site, and means the region
 * check cannot be forgotten at a new one.
 */
export async function requireProjectContext(
  req: AuthedRequest,
  res: Response,
  projectId: string,
  min: Role = "viewer",
): Promise<{ role: Role; region: string | null; workspaceId: string } | null> {
  const { role, region, workspaceId } = await getProjectAccess(projectId, req.userId!);
  if (!role || !roleAtLeast(role, min)) {
    res.status(403).json({ error: "Insufficient permissions" });
    return null;
  }
  const mismatch = regionMismatch(region);
  if (mismatch) {
    await refuseWrongRegion(req, res, workspaceId!, mismatch, "rest");
    return null;
  }
  return { role, region, workspaceId: workspaceId! };
}

/** The common case: only the role is wanted. */
export async function requireProjectAccess(
  req: AuthedRequest,
  res: Response,
  projectId: string,
  min: Role = "viewer",
): Promise<Role | null> {
  return (await requireProjectContext(req, res, projectId, min))?.role ?? null;
}
