/**
 * Mongoose models — mirrors schema.md. Additive changes only; log migrations.
 */
import mongoose, { Schema, InferSchemaType, model } from "mongoose";

/**
 * Normalize a persisted Buffer field to raw bytes. Under `.lean()`, Mongoose
 * Buffer fields come back as BSON `Binary` (not a node Buffer), so a naive
 * `new Uint8Array(x)` yields an empty array. Handle both shapes. A node Buffer
 * is already a Uint8Array subclass; a BSON Binary exposes the bytes on `.buffer`.
 */
export function toBytes(x: any): Uint8Array {
  if (!x) return new Uint8Array();
  if (x instanceof Uint8Array) return x;
  if (x.buffer) return new Uint8Array(x.buffer);
  return new Uint8Array(x);
}

/* -------------------------------- User ---------------------------------- */
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    passwordHash: { type: String, default: null },
    // Linked SSO identities. Matched on (provider, providerUserId) — the
    // provider's subject is the stable key; an email can change hands.
    oauthProviders: [
      { provider: String, providerUserId: String, linkedAt: { type: Date, default: Date.now }, _id: false },
    ],
    displayName: { type: String, required: true },
    avatarColor: { type: String, required: true },
    avatarUrl: { type: String, default: null },
    prefs: {
      theme: { type: String, enum: ["system", "light", "dark"], default: "system" },
      shortcuts: { type: Schema.Types.Mixed, default: {} },
      layout: { type: Schema.Types.Mixed, default: {} },
      notifications: {
        invites: { type: Boolean, default: true },
        mentions: { type: Boolean, default: true },
        sessionStart: { type: Boolean, default: true },
      },
    },
    status: { type: String, enum: ["active", "suspended", "deleted"], default: "active" },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
userSchema.index({ "oauthProviders.provider": 1, "oauthProviders.providerUserId": 1 });
export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model("User", userSchema);

/* ------------------------------ Workspace ------------------------------- */
const workspaceSchema = new Schema(
  {
    name: { type: String, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    plan: { type: String, enum: ["free", "edu", "pro", "enterprise"], default: "free" },
    members: [
      {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        role: { type: String, enum: ["owner", "editor", "viewer"], required: true },
        joinedAt: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    settings: {
      defaultLinkScope: { type: String, enum: ["viewer", "editor"], default: "viewer" },
      // Days to keep audit entries. 0 = keep forever (the default): deleting a
      // security log must always be an explicit choice, never a silent one.
      auditRetentionDays: { type: Number, default: 0, min: 0, max: 3650 },
      // Where this workspace's data must live. Declared by schema.md at v1.0 and
      // read by nothing until residency shipped. Set once, at creation, from the
      // creating deployment's own region; null means unpinned, which is every
      // workspace that predates the feature and every deployment that runs
      // without one. Immutable afterwards — see residency.ts.
      dataResidencyRegion: { type: String, default: null },
    },
    // Directory sync (SCIM 2.0). Present only once a token has been issued.
    // The token itself is never stored — only its SHA-256 — so the console can
    // prove which token is live without being able to reproduce it.
    scim: {
      type: new Schema({
        tokenHash: { type: String, required: true },
        tokenHint: { type: String, default: "" },      // last 4 chars, to tell tokens apart
        defaultRole: { type: String, enum: ["editor", "viewer"], default: "viewer" },
        createdBy: { type: Schema.Types.ObjectId, ref: "User" },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date, default: null },
      }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true }
);
workspaceSchema.index({ "members.userId": 1 });
// Every SCIM request resolves its workspace by token hash.
workspaceSchema.index({ "scim.tokenHash": 1 });
export const Workspace = model("Workspace", workspaceSchema);

/* ------------------------------- Project -------------------------------- */
const projectSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["code", "canvas", "mixed"], default: "mixed" },
    // End-to-end encrypted: the server stores ciphertext for this project's
    // documents and messages and can never read them. Fixed at creation.
    e2ee: { type: Boolean, default: false },
    // Lets a client tell whether a pasted key belongs to this project. A digest
    // of a 256-bit random key, so it discloses nothing usable.
    e2eeKeyCheck: { type: String, default: null },
    fileTree: { type: Schema.Types.Mixed, default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    // Optional linked GitHub repo (token stored server-side only, never returned).
    github: {
      type: new Schema({
        owner: { type: String, required: true },
        repo: { type: String, required: true },
        defaultBranch: { type: String, default: "main" },
        token: { type: String, default: "" }, // PAT for private repos; redacted in responses
        linkedBy: { type: Schema.Types.ObjectId, ref: "User" },
        linkedAt: { type: Date, default: Date.now },
      }, { _id: false }),
      default: undefined,
    },
    // Optional linked Figma file (PAT stored server-side only, never returned).
    figma: {
      type: new Schema({
        fileKey: { type: String, required: true },
        fileName: { type: String, default: "" },
        token: { type: String, default: "" }, // PAT; redacted in responses
        linkedBy: { type: Schema.Types.ObjectId, ref: "User" },
        linkedAt: { type: Date, default: Date.now },
      }, { _id: false }),
      default: undefined,
    },
    // Optional Slack incoming webhook (URL is a bearer secret — never returned).
    slack: {
      type: new Schema({
        webhookUrl: { type: String, required: true }, // redacted in responses
        channelLabel: { type: String, default: "" },
        events: { type: [String], default: [] },
        linkedBy: { type: Schema.Types.ObjectId, ref: "User" },
        linkedAt: { type: Date, default: Date.now },
      }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true }
);
export const Project = model("Project", projectSchema);

/* -------------------------------- File ---------------------------------- */
const fileSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    path: { type: String, required: true },
    language: { type: String, default: "plaintext" },
    docId: { type: String, required: true },
  },
  { timestamps: true }
);
fileSchema.index({ projectId: 1, path: 1 }, { unique: true });
export const File = model("File", fileSchema);

/* ---------------------------- CRDT updates ------------------------------ */
// Append-only Yjs update log for persistence + replay (schema.md §2.6).
const crdtUpdateSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
  docId: { type: String, required: true },
  seq: { type: Number, required: true },
  update: { type: Buffer, required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User" },
  ts: { type: Date, default: Date.now },
});
crdtUpdateSchema.index({ projectId: 1, docId: 1, seq: 1 });
export const CrdtUpdate = model("CrdtUpdate", crdtUpdateSchema);

/* ------------------------------ Message --------------------------------- */
const messageSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", index: true },
  channelType: { type: String, enum: ["project", "workspace", "dm"], default: "project" },
  channelId: { type: String, required: true },
  authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  body: { type: String, required: true },
  mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
  reactions: [{ emoji: String, userIds: [Schema.Types.ObjectId], _id: false }],
  threadId: { type: Schema.Types.ObjectId, ref: "Message", default: null },
  ts: { type: Date, default: Date.now },
});
messageSchema.index({ channelId: 1, ts: -1 });
messageSchema.index({ body: "text" });
export const Message = model("Message", messageSchema);

/* -------------------------------- Invite -------------------------------- */
const inviteSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
  scope: { type: String, enum: ["viewer", "editor"], default: "viewer" },
  token: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, default: null },
  requireLogin: { type: Boolean, default: true },
  singleUse: { type: Boolean, default: false },
  usedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  createdAt: { type: Date, default: Date.now },
});
export const Invite = model("Invite", inviteSchema);

/* ------------------------------- Session -------------------------------- */
const sessionSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", index: true },
  projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },
  participants: [
    {
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      joinedAt: Date,
      leftAt: { type: Date, default: null },
      _id: false,
    },
  ],
  recordingRef: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
});
export const CollabSession = model("CollabSession", sessionSchema);

/* ------------------------------ Audit log ------------------------------- */
// Append-only (schema.md §2.11).
const auditLogSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", index: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  action: { type: String, required: true },
  target: { type: Schema.Types.Mixed, default: {} },
  meta: { type: Schema.Types.Mixed, default: {} },
  ip: { type: String, default: null },
  ts: { type: Date, default: Date.now },
});
auditLogSchema.index({ workspaceId: 1, ts: -1 });
export const AuditLog = model("AuditLog", auditLogSchema);

/* ------------------------------ Analytics ------------------------------- */
// Per-session analytics (schema.md §2.12).
const analyticsSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", index: true },
  projectId: { type: Schema.Types.ObjectId, ref: "Project" },
  sessionId: { type: Schema.Types.ObjectId, ref: "CollabSession" },
  metrics: {
    durationSec: { type: Number, default: 0 },
    participantCount: { type: Number, default: 0 },
    messages: { type: Number, default: 0 },
    codeRuns: { type: Number, default: 0 },
  },
  ts: { type: Date, default: Date.now },
});
analyticsSchema.index({ workspaceId: 1, ts: -1 });
export const Analytics = model("Analytics", analyticsSchema);

/* --------------------------- SCIM identity ------------------------------ */
/**
 * One directory's view of one account, scoped to a workspace.
 *
 * This is deliberately not the same thing as workspace membership. A user
 * deprovisioned by the directory stops being a member immediately, but the IdP
 * still expects to read the resource back and see `active: false` — and it must
 * never be able to read a user it did not provision, which a lookup by user id
 * alone would allow across tenants.
 */
const scimIdentitySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // The IdP's own identifier for this person. IdPs reconcile on this.
    externalId: { type: String, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
scimIdentitySchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
export const ScimIdentity = model("ScimIdentity", scimIdentitySchema);

export { mongoose };
