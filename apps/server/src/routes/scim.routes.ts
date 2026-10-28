/**
 * SCIM 2.0 provisioning (RFC 7643 / 7644).
 *
 * This is the other half of enterprise SSO: OIDC proves who someone is, SCIM
 * decides whether they still have an account at all. The value is almost
 * entirely in deprovisioning — when someone leaves, their access has to end
 * without anyone remembering to do it by hand.
 *
 * Scope and its reasoning:
 *
 *  - A token is issued per workspace, and everything it can do is confined to
 *    that workspace. A Yumi account is global (one person, many workspaces), so
 *    letting one tenant's directory suspend an account outright would let it
 *    lock a user out of a *different* tenant. Deprovisioning therefore withdraws
 *    workspace access, and only suspends the account itself when the user has no
 *    workspace left — which is the ordinary single-tenant case.
 *  - Users only, no Groups. /ResourceTypes says so, so a client discovers it
 *    rather than failing halfway through a sync. Role comes from the workspace's
 *    configured default and stays an owner's decision.
 *  - `userName` is immutable here. It is the account's global login identity,
 *    so honouring a rename from one tenant would rewrite how that person signs
 *    in to every other one.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { Workspace, User, ScimIdentity } from "../models.js";
import { audit, clientIp, markSuspended, revokeAllSessions } from "../auth.js";
import { disconnectUser } from "../gateway.js";
import { config } from "../config.js";
import { regionMismatch, auditRegionBlock } from "../residency.js";
import { pickCollaboratorColor, REGION_MISMATCH_STATUS } from "@yumi/shared";

const router = Router();

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const MAX_RESULTS = 200;

export const scimTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

interface ScimRequest extends Request {
  workspaceId?: string;
  defaultRole?: "editor" | "viewer";
}

/** SCIM mandates its own media type and error envelope. */
function scimError(res: Response, status: number, detail: string, scimType?: string) {
  res.status(status).type("application/scim+json").json({
    schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail,
  });
}
const scimJson = (res: Response, status: number, body: unknown) =>
  res.status(status).type("application/scim+json").json(body);

/* -------------------------------- auth ---------------------------------- */

/**
 * Resolve the workspace from the bearer token.
 *
 * The token is compared by SHA-256 rather than a password KDF: it is 256 bits
 * of server-generated randomness, so there is nothing to brute-force, and a
 * deliberately slow hash on every provisioning request would only be a way to
 * exhaust the server.
 */
async function requireScimToken(req: ScimRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return scimError(res, 401, "A bearer token is required");

  const hash = scimTokenHash(token);
  const ws = await Workspace.findOne({ "scim.tokenHash": hash })
    .select("scim settings.dataResidencyRegion")
    .lean();
  // Constant-time even though the lookup already matched: keeps the comparison
  // honest if this is ever refactored to fetch a candidate by another key.
  const ok = ws?.scim?.tokenHash
    && ws.scim.tokenHash.length === hash.length
    && timingSafeEqual(Buffer.from(ws.scim.tokenHash), Buffer.from(hash));
  if (!ok) {
    // A rejected token cannot be attributed to a workspace — the record it
    // would name is exactly what is missing. It is logged unattributed, the
    // same way a failed sign-in against an unknown email is.
    await audit({
      action: "scim.auth.failed",
      meta: { tokenHint: token.slice(-4), path: req.originalUrl },
      ip: clientIp(req),
    });
    return scimError(res, 401, "Invalid directory sync token");
  }

  // A directory sync creates accounts and memberships, so it writes into
  // whichever region answers it. An IdP is configured once and then runs
  // unattended for years, which is precisely how it ends up pointed at the
  // wrong deployment after a migration — checked here, once, rather than in
  // each of the six handlers below. The detail text names the right base URL
  // because the person who has to fix it is reading the IdP's error report.
  const region = (ws as any)!.settings?.dataResidencyRegion ?? null;
  const mismatch = regionMismatch(region);
  if (mismatch) {
    await auditRegionBlock(String(ws!._id), undefined, {
      via: "scim", region: mismatch.region, path: req.originalUrl, ip: clientIp(req),
    });
    return scimError(res, REGION_MISMATCH_STATUS, mismatch.error);
  }

  req.workspaceId = String(ws!._id);
  req.defaultRole = (ws!.scim!.defaultRole as "editor" | "viewer") ?? "viewer";
  // Enough to answer "is this integration still running?" without a write per
  // request — an idle IdP polls constantly.
  const last = ws!.scim!.lastUsedAt ? new Date(ws!.scim!.lastUsedAt).getTime() : 0;
  if (Date.now() - last > 60_000) {
    await Workspace.updateOne({ _id: ws!._id }, { $set: { "scim.lastUsedAt": new Date() } });
  }
  next();
}

/* ------------------------------ serialisation ---------------------------- */

function toScimUser(user: any, identity: any, baseUrl: string) {
  const id = String(user._id);
  return {
    schemas: [USER_SCHEMA],
    id,
    ...(identity.externalId ? { externalId: identity.externalId } : {}),
    userName: user.email,
    name: { formatted: user.displayName },
    displayName: user.displayName,
    emails: [{ value: user.email, primary: true, type: "work" }],
    // Reflects this workspace's view: an account can be live elsewhere and
    // still be deprovisioned here.
    active: Boolean(identity.active) && user.status === "active",
    meta: {
      resourceType: "User",
      created: identity.createdAt,
      lastModified: identity.updatedAt,
      location: `${baseUrl}/Users/${id}`,
    },
  };
}

const baseUrlFor = () => `${config.publicUrl}/scim/v2`;

/* -------------------------------- filters -------------------------------- */

/**
 * The sliver of SCIM filter syntax that IdPs actually send on a user sync:
 * `userName eq "x"`, `externalId eq "x"`, `active eq true`. Anything else is
 * refused rather than silently ignored — a filter quietly treated as "match
 * everything" would hand the directory the whole member list.
 */
function parseFilter(filter: string): { field: string; value: string } | { error: string } {
  const m = filter.trim().match(/^(\w+)\s+eq\s+"?([^"]*)"?$/i);
  if (!m) return { error: `Unsupported filter: ${filter}` };
  const field = m[1].toLowerCase();
  if (!["username", "externalid", "active"].includes(field)) {
    return { error: `Unsupported filter attribute: ${m[1]}` };
  }
  return { field, value: m[2] };
}

const asBool = (v: unknown): boolean =>
  typeof v === "boolean" ? v : String(v).toLowerCase() === "true";

/* ------------------------------ discovery -------------------------------- */

router.get("/ServiceProviderConfig", (_req, res) => {
  scimJson(res, 200, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://datatracker.ietf.org/doc/html/rfc7644",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description: "A token issued in the Yumi admin console for one workspace.",
      primary: true,
    }],
  });
});

router.get("/ResourceTypes", (_req, res) => {
  // Only User. Saying so here is what stops a client starting a group sync it
  // cannot finish.
  scimJson(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults: 1, itemsPerPage: 1, startIndex: 1,
    Resources: [{
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA,
      meta: { resourceType: "ResourceType", location: `${baseUrlFor()}/ResourceTypes/User` },
    }],
  });
});

router.get("/Schemas", (_req, res) => {
  scimJson(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults: 1, itemsPerPage: 1, startIndex: 1,
    Resources: [{
      id: USER_SCHEMA, name: "User", description: "SCIM core User",
      attributes: [
        { name: "userName", type: "string", required: true, uniqueness: "server", mutability: "immutable" },
        { name: "displayName", type: "string", required: false, mutability: "readWrite" },
        { name: "active", type: "boolean", required: false, mutability: "readWrite" },
        { name: "externalId", type: "string", required: false, mutability: "readWrite" },
      ],
      meta: { resourceType: "Schema", location: `${baseUrlFor()}/Schemas/${USER_SCHEMA}` },
    }],
  });
});

/* --------------------------------- Users --------------------------------- */

router.use(requireScimToken);

/** Membership and identity are changed together, so they never disagree. */
async function grantAccess(workspaceId: string, userId: string, role: "editor" | "viewer") {
  const ws = await Workspace.findById(workspaceId);
  if (!ws) return;
  const existing = ws.members.find((m) => String(m.userId) === String(userId));
  // Never demote someone who already holds a higher role — an owner promoted by
  // hand must not be reset to "viewer" by the next directory sync.
  if (!existing) {
    ws.members.push({ userId: userId as any, role, joinedAt: new Date() } as any);
    await ws.save();
  }
}

async function withdrawAccess(workspaceId: string, userId: string) {
  const ws = await Workspace.findById(workspaceId);
  if (!ws) return;
  // The last owner cannot be removed, or the workspace becomes unadministrable.
  const owners = ws.members.filter((m) => m.role === "owner");
  const isLastOwner = owners.length === 1 && String(owners[0].userId) === String(userId);
  if (isLastOwner) return "last-owner";
  ws.members = ws.members.filter((m) => String(m.userId) !== String(userId)) as any;
  await ws.save();

  // Suspend the account itself only when there is nowhere left for it to be
  // used. Doing it unconditionally would let one tenant lock a user out of
  // another tenant's workspace.
  const remaining = await Workspace.countDocuments({ "members.userId": userId });
  if (remaining === 0) {
    await User.updateOne({ _id: userId }, { $set: { status: "suspended" } });
    await markSuspended(String(userId), true);
  }
  await revokeAllSessions(String(userId));
  // A socket is only authenticated at handshake, so an open session would
  // otherwise outlive the access it was granted under.
  disconnectUser(String(userId));
  return "removed";
}

// List — the IdP's reconciliation pass.
router.get("/Users", async (req: ScimRequest, res) => {
  const startIndex = Math.max(1, Number(req.query.startIndex ?? 1));
  const count = Math.min(MAX_RESULTS, Math.max(0, Number(req.query.count ?? 100)));

  const query: Record<string, unknown> = { workspaceId: req.workspaceId };
  let emailFilter: string | null = null;
  if (typeof req.query.filter === "string" && req.query.filter.trim()) {
    const parsed = parseFilter(req.query.filter);
    if ("error" in parsed) return scimError(res, 400, parsed.error, "invalidFilter");
    if (parsed.field === "externalid") query.externalId = parsed.value;
    else if (parsed.field === "active") query.active = asBool(parsed.value);
    else emailFilter = parsed.value.toLowerCase();
  }

  if (emailFilter) {
    const user = await User.findOne({ email: emailFilter }).lean();
    if (!user) return scimJson(res, 200, { schemas: [LIST_SCHEMA], totalResults: 0, startIndex, itemsPerPage: 0, Resources: [] });
    query.userId = user._id;
  }

  const totalResults = await ScimIdentity.countDocuments(query);
  const identities = await ScimIdentity.find(query).sort({ createdAt: 1 }).skip(startIndex - 1).limit(count).lean();
  const users = await User.find({ _id: { $in: identities.map((i) => i.userId) } }).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const Resources = identities
    .map((i) => { const u = byId.get(String(i.userId)); return u ? toScimUser(u, i, baseUrlFor()) : null; })
    .filter(Boolean);

  scimJson(res, 200, { schemas: [LIST_SCHEMA], totalResults, startIndex, itemsPerPage: Resources.length, Resources });
});

router.get("/Users/:id", async (req: ScimRequest, res) => {
  const identity = await ScimIdentity.findOne({ workspaceId: req.workspaceId, userId: req.params.id }).lean().catch(() => null);
  if (!identity) return scimError(res, 404, "User not found");
  const user = await User.findById(identity.userId).lean();
  if (!user) return scimError(res, 404, "User not found");
  scimJson(res, 200, toScimUser(user, identity, baseUrlFor()));
});

// Provision.
router.post("/Users", async (req: ScimRequest, res) => {
  const body = req.body ?? {};
  const email = String(body.userName ?? body.emails?.[0]?.value ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return scimError(res, 400, "userName must be an email address", "invalidValue");
  }
  const displayName = String(
    body.displayName || body.name?.formatted
      || [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ")
      || email.split("@")[0]
  ).slice(0, 100);
  const externalId = body.externalId ? String(body.externalId) : null;
  const active = body.active === undefined ? true : asBool(body.active);

  let user = await User.findOne({ email });
  let linked = false;
  if (user) {
    linked = true;
    const existing = await ScimIdentity.findOne({ workspaceId: req.workspaceId, userId: user._id }).lean();
    if (existing?.active) return scimError(res, 409, "User already provisioned", "uniqueness");
  } else {
    user = await User.create({
      email,
      displayName,
      avatarColor: pickCollaboratorColor(Date.now() + email.length),
      // No password: a provisioned account signs in through the directory.
      passwordHash: null,
    });
  }

  // Provisioning an account that was suspended by an earlier deprovision has to
  // put it back, or the user is created but still locked out.
  if (active && user.status !== "active") {
    await User.updateOne({ _id: user._id }, { $set: { status: "active" } });
    await markSuspended(String(user._id), false);
  }

  const identity = await ScimIdentity.findOneAndUpdate(
    { workspaceId: req.workspaceId, userId: user._id },
    { $set: { externalId, active } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  if (active) await grantAccess(req.workspaceId!, String(user._id), req.defaultRole!);

  await audit({
    workspaceId: req.workspaceId,
    action: linked ? "scim.user.linked" : "scim.user.provisioned",
    target: { userId: String(user._id), email },
    meta: { externalId, role: req.defaultRole, via: "scim" },
    ip: clientIp(req),
  });

  const fresh = await User.findById(user._id).lean();
  scimJson(res, 201, toScimUser(fresh, identity, baseUrlFor()));
});

/** Apply an active/displayName change, whichever verb asked for it. */
async function applyChange(
  req: ScimRequest, res: Response,
  changes: { active?: boolean; displayName?: string; externalId?: string | null; userName?: string },
) {
  const identity = await ScimIdentity.findOne({ workspaceId: req.workspaceId, userId: req.params.id }).catch(() => null);
  if (!identity) return scimError(res, 404, "User not found");
  const user = await User.findById(identity.userId);
  if (!user) return scimError(res, 404, "User not found");

  if (changes.userName && changes.userName.toLowerCase() !== user.email) {
    return scimError(res, 400,
      "userName cannot be changed through directory sync: it is the account's login identity across every workspace",
      "mutability");
  }

  if (changes.displayName && changes.displayName !== user.displayName) {
    user.displayName = changes.displayName.slice(0, 100);
    await user.save();
    await audit({
      workspaceId: req.workspaceId, action: "scim.user.updated",
      target: { userId: String(user._id), email: user.email },
      meta: { displayName: user.displayName }, ip: clientIp(req),
    });
  }
  if (changes.externalId !== undefined) identity.externalId = changes.externalId;

  if (changes.active !== undefined && changes.active !== identity.active) {
    identity.active = changes.active;
    if (changes.active) {
      await User.updateOne({ _id: user._id }, { $set: { status: "active" } });
      await markSuspended(String(user._id), false);
      await grantAccess(req.workspaceId!, String(user._id), req.defaultRole!);
    } else {
      const outcome = await withdrawAccess(req.workspaceId!, String(user._id));
      if (outcome === "last-owner") {
        return scimError(res, 400,
          "This user is the workspace's only owner and cannot be deprovisioned; transfer ownership first",
          "mutability");
      }
    }
    await audit({
      workspaceId: req.workspaceId,
      action: changes.active ? "scim.user.reactivated" : "scim.user.deactivated",
      target: { userId: String(user._id), email: user.email },
      meta: { via: "scim" }, ip: clientIp(req),
    });
  }
  await identity.save();

  const fresh = await User.findById(user._id).lean();
  scimJson(res, 200, toScimUser(fresh, identity.toObject(), baseUrlFor()));
}

// Replace.
router.put("/Users/:id", async (req: ScimRequest, res) => {
  const body = req.body ?? {};
  await applyChange(req, res, {
    active: body.active === undefined ? undefined : asBool(body.active),
    displayName: body.displayName || body.name?.formatted || undefined,
    externalId: body.externalId === undefined ? undefined : (body.externalId ? String(body.externalId) : null),
    userName: body.userName ? String(body.userName) : undefined,
  });
});

/**
 * Patch. The shape differs by vendor and both are in the wild: Okta sends
 * `{op:"replace", value:{active:false}}` with no path, Entra sends
 * `{op:"replace", path:"active", value:"False"}` — a *string*. Both are handled,
 * because this one operation is how nearly every deprovision actually arrives.
 */
router.patch("/Users/:id", async (req: ScimRequest, res) => {
  const body = req.body ?? {};
  const ops = Array.isArray(body.Operations) ? body.Operations : Array.isArray(body.operations) ? body.operations : null;
  if (!ops) return scimError(res, 400, "Operations is required", "invalidSyntax");
  if (body.schemas && !body.schemas.includes(PATCH_SCHEMA)) {
    return scimError(res, 400, `Body must declare ${PATCH_SCHEMA}`, "invalidSyntax");
  }

  const changes: { active?: boolean; displayName?: string; externalId?: string | null; userName?: string } = {};
  for (const op of ops) {
    const verb = String(op?.op ?? "").toLowerCase();
    if (verb !== "replace" && verb !== "add") continue;   // "remove" has no meaning for these fields
    const path = op.path ? String(op.path).toLowerCase().replace(/^urn:[^:]+:.*:/, "") : null;
    if (path) {
      if (path === "active") changes.active = asBool(op.value);
      else if (path === "displayname" || path === "name.formatted") changes.displayName = String(op.value);
      else if (path === "externalid") changes.externalId = op.value ? String(op.value) : null;
      else if (path === "username") changes.userName = String(op.value);
    } else if (op.value && typeof op.value === "object") {
      const v = op.value;
      if (v.active !== undefined) changes.active = asBool(v.active);
      if (v.displayName || v.name?.formatted) changes.displayName = String(v.displayName || v.name.formatted);
      if (v.externalId !== undefined) changes.externalId = v.externalId ? String(v.externalId) : null;
      if (v.userName !== undefined) changes.userName = String(v.userName);
    }
  }
  await applyChange(req, res, changes);
});

// Delete is the same withdrawal as active:false — IdPs use whichever they use.
router.delete("/Users/:id", async (req: ScimRequest, res) => {
  const identity = await ScimIdentity.findOne({ workspaceId: req.workspaceId, userId: req.params.id }).catch(() => null);
  if (!identity) return scimError(res, 404, "User not found");
  if (identity.active) {
    const outcome = await withdrawAccess(req.workspaceId!, String(identity.userId));
    if (outcome === "last-owner") {
      return scimError(res, 400,
        "This user is the workspace's only owner and cannot be deprovisioned; transfer ownership first",
        "mutability");
    }
    identity.active = false;
    await identity.save();
    await audit({
      workspaceId: req.workspaceId, action: "scim.user.deactivated",
      target: { userId: String(identity.userId) }, meta: { via: "scim-delete" }, ip: clientIp(req),
    });
  }
  res.status(204).end();
});

export default router;
