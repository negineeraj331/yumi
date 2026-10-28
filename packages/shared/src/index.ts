/**
 * @yumi/shared — single source of truth for types, roles, socket event names,
 * and DTO validation shared between server and web. See rules.md §5.
 */
import { z } from "zod";

/* ----------------------------- Roles & RBAC ----------------------------- */

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Role rank for comparisons (higher = more privilege). */
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const PROJECT_TYPES = ["code", "canvas", "mixed"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const INVITE_SCOPES = ["viewer", "editor"] as const;
export type InviteScope = (typeof INVITE_SCOPES)[number];

/* --------------------------- Socket.io events --------------------------- */
/** Namespaced constants so event names are never string-duplicated. */
export const SOCKET_EVENTS = {
  // lifecycle
  JOIN: "join",
  LEAVE: "leave",
  JOINED: "joined",
  ERROR: "error",
  PRESENCE_UPDATE: "presence:update",
  // collaborative docs (Yjs binary)
  SYNC_STEP: "sync:step",
  DOC_UPDATE: "doc:update",
  AWARENESS: "awareness",
  CURSOR: "cursor",
  // chat
  CHAT_MESSAGE: "chat:message",
  CHAT_TYPING: "chat:typing",
  CHAT_REACTION: "chat:reaction",
  // direct messages (routed to both participants' personal rooms)
  DM_MESSAGE: "dm:message",
  // activity feed
  ACTIVITY: "activity",
  // file tree changes (prompt peers to refetch)
  FILES_CHANGED: "files:changed",
  // code execution (shared terminal)
  RUN_START: "run:start",
  RUN_OUTPUT: "run:output",
  RUN_DONE: "run:done",
  // test execution (shared)
  TEST_START: "test:start",
  TEST_RUNNING: "test:running",
  TEST_DONE: "test:done",
  // performance profiling (shared)
  PERF_START: "perf:start",
  PERF_RUNNING: "perf:running",
  PERF_DONE: "perf:done",
  // collaborative debugging (one shared session per project)
  DEBUG_START: "debug:start",
  DEBUG_COMMAND: "debug:command",
  DEBUG_STATE: "debug:state",
  DEBUG_EVALUATED: "debug:evaluated",
  DEBUG_STOP: "debug:stop",
  DEBUG_ERROR: "debug:error",
  // AI assistant
  AI_ASK: "ai:ask",
  AI_CHUNK: "ai:chunk",
  AI_DONE: "ai:done",
  // AI inline completion
  AI_COMPLETE: "ai:complete",
  AI_COMPLETION: "ai:completion",
  // webrtc signaling (P2P mesh)
  RTC_SIGNAL: "rtc:signal",
  // SFU (mediasoup) — request/ack pairs + server→client notifications
  SFU_RTP_CAPS: "sfu:rtpCaps",
  SFU_CREATE_TRANSPORT: "sfu:createTransport",
  SFU_CONNECT_TRANSPORT: "sfu:connectTransport",
  SFU_PRODUCE: "sfu:produce",
  SFU_CONSUME: "sfu:consume",
  SFU_RESUME_CONSUMER: "sfu:resumeConsumer",
  SFU_JOIN: "sfu:join",
  SFU_LEAVE: "sfu:leave",
  SFU_NEW_PRODUCER: "sfu:newProducer",
  SFU_PRODUCER_CLOSED: "sfu:producerClosed",
  SFU_PEER_LEFT: "sfu:peerLeft",
} as const;

/** Call transport modes. Mesh = P2P (≤4); SFU = server-forwarded (5–50). */
export const CALL_MODES = ["mesh", "sfu"] as const;
export type CallMode = (typeof CALL_MODES)[number];

/** Languages the sandbox can execute (compile + run). Others are editor-only. */
export const RUNNABLE_LANGUAGES = [
  "javascript", "typescript", "python", "java", "cpp", "go", "rust",
] as const;
export function isRunnable(lang: string): boolean {
  return (RUNNABLE_LANGUAGES as readonly string[]).includes(lang);
}

/** Languages whose built-in/zero-dep test runner the sandbox can drive. */
export const TESTABLE_LANGUAGES = [
  "javascript", "typescript", "python", "go", "rust",
] as const;
export function isTestable(lang: string): boolean {
  return (TESTABLE_LANGUAGES as readonly string[]).includes(lang);
}

/** Languages the sandbox can profile (repeat-execute and measure). */
export const PROFILABLE_LANGUAGES = [
  "javascript", "typescript", "python", "java", "cpp", "go", "rust",
] as const;
export function isProfilable(lang: string): boolean {
  return (PROFILABLE_LANGUAGES as readonly string[]).includes(lang);
}

/**
 * Languages the shared debugger can step through — now all seven the sandbox can
 * run.
 *
 * Python uses stdlib `pdb` and Java the JDK's `jdb`, both over the sandbox's
 * stdio; JavaScript and TypeScript use a harness that speaks CDP to V8's
 * inspector from inside the container, with TypeScript running under
 * type-stripping so line positions are preserved exactly. C++ and Rust use
 * `gdb` and Go uses Delve, from sandbox images built by this repo: their stock
 * images contain no debugger, and `--network none` means one cannot be fetched
 * when a session starts, so it has to be baked in (`apps/server/sandbox`).
 */
export const DEBUGGABLE_LANGUAGES = [
  "python", "javascript", "typescript", "java", "cpp", "go", "rust",
] as const;
export function isDebuggable(lang: string): boolean {
  return (DEBUGGABLE_LANGUAGES as readonly string[]).includes(lang);
}

/** Stepping commands the shared debugger accepts (plus evaluate/breakpoints). */
export const DEBUG_COMMANDS = ["continue", "next", "step", "out"] as const;
export type DebugCommand = (typeof DEBUG_COMMANDS)[number];

export interface DebugStackFrame { file: string; line: number; func: string; source: string }

/** The shared debugger state every participant in the room sees. */
export interface DebugState {
  status: "starting" | "paused" | "running" | "exited";
  file: string | null;
  line: number | null;
  source: string | null;
  stack: DebugStackFrame[];
  locals: string;
  breakpoints: number[];
  output: string;
  exitMessage?: string;
}

/** How many timed executions a perf run performs (compile excluded). */
export const PERF_ITERATIONS = { min: 1, default: 5, max: 20 } as const;

/** One timed execution within a perf run. Times are ms; memory is KB. */
export interface PerfSample {
  wallMs: number;
  userMs: number;
  sysMs: number;
  cpuPct: number | null;
  maxRssKb: number | null;
}

/** Aggregate result of a perf run. `memoryAvailable` is false where the image lacks a max-RSS source. */
export interface PerfStats {
  samples: PerfSample[];
  iterations: number;
  bestMs: number;
  medianMs: number;
  meanMs: number;
  worstMs: number;
  stdDevMs: number;
  userMs: number;
  sysMs: number;
  cpuPct: number | null;
  maxRssKb: number | null;
  memoryAvailable: boolean;
  compileMs: number | null;
}

/* ------------------------------ Languages ------------------------------- */
/** Supported editor languages (PRD CE-3). value = stored id, ext = default file extension. */
export const LANGUAGES = [
  { value: "javascript", label: "JavaScript", ext: "js" },
  { value: "typescript", label: "TypeScript", ext: "ts" },
  { value: "python", label: "Python", ext: "py" },
  { value: "java", label: "Java", ext: "java" },
  { value: "cpp", label: "C / C++", ext: "cpp" },
  { value: "html", label: "HTML", ext: "html" },
  { value: "css", label: "CSS", ext: "css" },
  { value: "json", label: "JSON", ext: "json" },
  { value: "markdown", label: "Markdown", ext: "md" },
  { value: "go", label: "Go", ext: "go" },
  { value: "rust", label: "Rust", ext: "rs" },
  { value: "plaintext", label: "Plain text", ext: "txt" },
] as const;
export type LanguageId = (typeof LANGUAGES)[number]["value"];

/** Best-guess editor language for a filename, by extension. Defaults to plaintext. */
export function languageForFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", java: "java",
    c: "cpp", cc: "cpp", cpp: "cpp", h: "cpp", hpp: "cpp",
    html: "html", htm: "html", css: "css",
    json: "json", md: "markdown", markdown: "markdown",
    go: "go", rs: "rust",
  };
  return map[ext] ?? "plaintext";
}

/* -------------------------------- DTOs ---------------------------------- */

export const registerSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(80),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  /**
   * Where this workspace's data must live. Pinned once, at creation, and never
   * afterwards: the rows are already written by then, so a later change would
   * only relabel data that has not moved.
   *
   * A deployment can only honour its own region, so naming another one is
   * refused with that region's address rather than silently ignored.
   */
  region: z.string().max(24).optional(),
});

export const createProjectSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(120),
  type: z.enum(PROJECT_TYPES).default("mixed"),
  /**
   * End-to-end encryption is chosen once, when the project is created, and can
   * never be turned on or off afterwards: either choice would leave documents
   * written under the opposite assumption sitting in the same log.
   */
  e2ee: z.boolean().optional(),
  /**
   * A digest that lets a client check a pasted key belongs to this project.
   * Never the key: the key is 256 bits of client-side randomness and no code
   * path sends it anywhere.
   */
  e2eeKeyCheck: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).refine((v) => !v.e2ee || Boolean(v.e2eeKeyCheck), {
  message: "An encrypted project must be created with its key check",
  path: ["e2eeKeyCheck"],
});

export const createInviteSchema = z.object({
  workspaceId: z.string().min(1),
  scope: z.enum(INVITE_SCOPES).default("viewer"),
  expiresInHours: z.number().int().positive().max(24 * 30).optional(),
  requireLogin: z.boolean().default(true),
  singleUse: z.boolean().default(false),
});

export const changeRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ROLES),
});

export const createFileSchema = z.object({
  path: z.string().min(1).max(200),
  language: z.string().min(1).max(40).default("plaintext"),
});

export const updateFileSchema = z.object({
  language: z.string().min(1).max(40).optional(),
  path: z.string().min(1).max(200).optional(),
});

export const chatMessageSchema = z.object({
  projectId: z.string().min(1),
  body: z.string().min(1).max(4000),
  mentions: z.array(z.string()).max(50).optional().default([]),
  /** When set, this message is a reply within the given thread (root message id). */
  threadId: z.string().min(1).optional(),
});

export const dmMessageSchema = z.object({
  toUserId: z.string().min(1),
  body: z.string().min(1).max(4000),
});

/** Stable DM channel id for a pair of users (order-independent). */
export function dmChannelId(a: string, b: string): string {
  return "dm:" + [String(a), String(b)].sort().join(":");
}

export const linkGithubSchema = z.object({
  owner: z.string().min(1).max(120),
  repo: z.string().min(1).max(140),
  branch: z.string().min(1).max(200).optional(),
  token: z.string().max(255).optional(),
});

export const importGithubSchema = z.object({
  path: z.string().min(1).max(400),
  ref: z.string().max(200).optional(),
  as: z.string().min(1).max(200).optional(), // target filename in the project
});

/* ------------------------------- Audit ---------------------------------- */

/**
 * Audit actions the admin console knows how to label and filter by. Grouped so
 * the console can offer "all auth events" without listing each one. Unknown
 * actions still record and display — this registry is for presentation, not a
 * whitelist, so a new event is never silently dropped.
 */
export const AUDIT_ACTIONS = [
  { id: "auth.register", group: "auth", label: "Account created" },
  { id: "auth.login", group: "auth", label: "Signed in" },
  { id: "auth.login.failed", group: "auth", label: "Failed sign-in", security: true },
  { id: "auth.logout", group: "auth", label: "Signed out" },
  { id: "auth.profile.updated", group: "auth", label: "Profile updated" },
  { id: "auth.sso.login", group: "auth", label: "Signed in via SSO" },
  { id: "auth.sso.registered", group: "auth", label: "Account created via SSO", security: true },
  { id: "auth.sso.linked", group: "auth", label: "SSO identity linked to account", security: true },
  { id: "auth.sso.failed", group: "auth", label: "Failed SSO sign-in", security: true },
  { id: "workspace.create", group: "workspace", label: "Workspace created" },
  { id: "workspace.settings.updated", group: "workspace", label: "Workspace settings changed", security: true },
  { id: "role.changed", group: "workspace", label: "Member role changed", security: true },
  { id: "invite.created", group: "workspace", label: "Invite created", security: true },
  { id: "invite.accepted", group: "workspace", label: "Invite accepted" },
  { id: "project.create", group: "project", label: "Project created" },
  { id: "file.create", group: "project", label: "File created" },
  { id: "file.rename", group: "project", label: "File renamed" },
  { id: "file.delete", group: "project", label: "File deleted", security: true },
  { id: "github.link", group: "integration", label: "GitHub linked", security: true },
  { id: "github.unlink", group: "integration", label: "GitHub unlinked" },
  { id: "figma.link", group: "integration", label: "Figma linked", security: true },
  { id: "figma.unlink", group: "integration", label: "Figma unlinked" },
  { id: "slack.link", group: "integration", label: "Slack connected", security: true },
  { id: "slack.unlink", group: "integration", label: "Slack disconnected" },
  { id: "slack.events.updated", group: "integration", label: "Slack events changed" },
  { id: "scim.token.created", group: "directory", label: "Directory sync token issued", security: true },
  { id: "scim.token.revoked", group: "directory", label: "Directory sync token revoked", security: true },
  { id: "scim.auth.failed", group: "directory", label: "Rejected directory sync request", security: true },
  { id: "scim.user.provisioned", group: "directory", label: "User provisioned by directory", security: true },
  { id: "scim.user.linked", group: "directory", label: "Existing account linked by directory", security: true },
  { id: "scim.user.updated", group: "directory", label: "User updated by directory" },
  { id: "scim.user.deactivated", group: "directory", label: "User deprovisioned by directory", security: true },
  { id: "scim.user.reactivated", group: "directory", label: "User reactivated by directory", security: true },
  { id: "residency.pinned", group: "residency", label: "Data region pinned", security: true },
  { id: "residency.blocked", group: "residency", label: "Request refused from another region", security: true },
  { id: "residency.egress.blocked", group: "residency", label: "Out-of-region feature refused", security: true },
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number]["id"];
export const AUDIT_GROUPS = ["auth", "workspace", "project", "integration", "directory", "residency"] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];

export function auditActionLabel(id: string): string {
  return AUDIT_ACTIONS.find((a) => a.id === id)?.label ?? id;
}
export function auditActionsInGroup(group: string): string[] {
  return AUDIT_ACTIONS.filter((a) => a.group === group).map((a) => a.id);
}

/**
 * Audit retention in days. 0 means keep forever — deliberately the default, so
 * enabling deletion of an append-only security log is always an explicit choice.
 */
export const AUDIT_RETENTION = { min: 0, max: 3650, default: 0 } as const;

export const updateWorkspaceSettingsSchema = z.object({
  auditRetentionDays: z.number().int().min(AUDIT_RETENTION.min).max(AUDIT_RETENTION.max).optional(),
  defaultLinkScope: z.enum(INVITE_SCOPES).optional(),
});

/**
 * Directory sync (SCIM 2.0). Provisioning is scoped to one workspace: the token
 * an IdP holds can only ever affect that workspace's membership.
 */
export const SCIM_DEFAULT_ROLES = ["viewer", "editor"] as const;
export type ScimDefaultRole = (typeof SCIM_DEFAULT_ROLES)[number];

/** What the admin console is told about directory sync. Never the token itself. */
export interface ScimStatus {
  configured: boolean;
  tokenHint: string | null;
  defaultRole: ScimDefaultRole;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** The base URL to paste into the IdP. */
  baseUrl: string;
}

export interface AuditEntry {
  _id: string;
  action: string;
  actorId: string | null;
  actorName: string;
  target: Record<string, unknown>;
  meta: Record<string, unknown>;
  ip: string | null;
  ts: string;
}

/* ------------------------------- Figma ---------------------------------- */

/**
 * A Figma file is identified by its key. Accept either the bare key or any
 * file/design URL — figma.com/file/<key>/... and figma.com/design/<key>/...
 */
export function parseFigmaKey(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  return /^[A-Za-z0-9]{10,64}$/.test(s) ? s : null;
}

export const linkFigmaSchema = z.object({
  // Bare key or a pasted Figma URL; the server normalises via parseFigmaKey.
  file: z.string().min(1).max(500),
  token: z.string().min(1).max(255), // Figma has no anonymous API — a PAT is required
});

export const importFigmaSchema = z.object({
  nodeId: z.string().min(1).max(120),
  scale: z.number().min(0.25).max(4).optional(),
});

/* ------------------------------- Slack ---------------------------------- */

/** Events a project can forward to Slack. Failure-biased by default: quiet unless something needs attention. */
export const SLACK_EVENTS = [
  { id: "run.failed", label: "Code run fails" },
  { id: "tests.failed", label: "Tests fail" },
  { id: "member.joined", label: "Someone joins the session" },
  { id: "session.ended", label: "Session ends (with a summary)" },
] as const;

export type SlackEvent = (typeof SLACK_EVENTS)[number]["id"];

export function isSlackEvent(v: string): v is SlackEvent {
  return SLACK_EVENTS.some((e) => e.id === v);
}

export const linkSlackSchema = z.object({
  webhookUrl: z.string().url().max(500)
    .refine((u) => u.startsWith("https://"), "Webhook URL must be https")
    .refine((u) => !/\s/.test(u), "Webhook URL must not contain whitespace"),
  channelLabel: z.string().max(120).optional(), // display only; Slack decides the real channel
  events: z.array(z.string()).max(SLACK_EVENTS.length).optional(),
});

export const updateSlackSchema = z.object({
  events: z.array(z.string()).max(SLACK_EVENTS.length),
});

/* --------------------------- Data residency ----------------------------- */

/**
 * Region ids are chosen by whoever runs the deployment ("eu", "us-east",
 * "in-mum") rather than drawn from a fixed list — the set of places a customer
 * can be served from is an infrastructure fact, not something this code knows.
 * The shape is constrained so an id is safe to put in a URL, a log line and a
 * Mongo query without escaping.
 */
export const REGION_ID_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;
export function isRegionId(v: unknown): v is string {
  return typeof v === "string" && REGION_ID_RE.test(v);
}

/**
 * Features that necessarily send a workspace's content out of its region.
 *
 * Pinning storage to a region does not pin *processing*, and a residency
 * promise that quietly excludes the parts which phone out is not a promise. So
 * each of these is refused in a pinned workspace unless the operator declares
 * that its processing happens in-region too — and the same list is shown in the
 * admin console, rather than only living in a comment here.
 */
export const RESIDENCY_EGRESS_FEATURES = [
  {
    id: "ai",
    label: "AI assistant and inline completion",
    detail: "Prompts carry the file you are editing to the model provider's API.",
    /** Env var that declares this feature's processing to be in-region. */
    declaredBy: "AI_REGION",
  },
  {
    id: "github",
    label: "GitHub",
    detail: "Linking, browsing and importing send repository paths and file contents to github.com.",
    declaredBy: "RESIDENCY_ALLOW_EGRESS",
  },
  {
    id: "figma",
    label: "Figma",
    detail: "Browsing and placing frames fetches them from figma.com through this server.",
    declaredBy: "RESIDENCY_ALLOW_EGRESS",
  },
  {
    id: "slack",
    label: "Slack",
    detail: "Notifications post project names, file names and failure output to slack.com.",
    declaredBy: "RESIDENCY_ALLOW_EGRESS",
  },
] as const;

export type ResidencyEgressFeature = (typeof RESIDENCY_EGRESS_FEATURES)[number]["id"];

export function isResidencyEgressFeature(v: string): v is ResidencyEgressFeature {
  return RESIDENCY_EGRESS_FEATURES.some((f) => f.id === v);
}
export function residencyEgressLabel(id: string): string {
  return RESIDENCY_EGRESS_FEATURES.find((f) => f.id === id)?.label ?? id;
}

/** One region in the fleet, as advertised by whichever deployment answered. */
export interface RegionInfo {
  id: string;
  label: string;
  /** Where to reach that region, when the operator has configured it. */
  url: string | null;
  /** True for the deployment that produced this response. */
  self: boolean;
}

/** What the admin console is told about a workspace's residency. */
export interface ResidencyStatus {
  /** Region this deployment stores in. null = residency is not configured here. */
  deploymentRegion: string | null;
  /** Where the workspace is pinned. null = not pinned (created without residency). */
  pinnedRegion: string | null;
  /** Whether this deployment is allowed to serve the workspace at all. */
  inRegion: boolean;
  /** Regions this deployment knows how to point at. */
  regions: RegionInfo[];
  /** Egress features refused here, with the reason, and those the operator has declared in-region. */
  blockedEgress: { id: ResidencyEgressFeature; label: string; detail: string; declaredBy: string }[];
  allowedEgress: { id: ResidencyEgressFeature; label: string }[];
}

/**
 * The body of a cross-region refusal. `code` is what the client keys off — the
 * prose is for a person and may change; and `redirectTo` is only ever a URL the
 * *server* has configured for that region, never anything the caller supplied,
 * so this response can't be turned into an open redirect.
 */
export interface RegionMismatch {
  error: string;
  code: "region_mismatch";
  /** The region that answered (this deployment). */
  servedBy: string;
  /** Where the workspace actually lives. */
  region: string;
  redirectTo: string | null;
}

export const REGION_MISMATCH_CODE = "region_mismatch" as const;

/**
 * 421 Misdirected Request: the request reached a server that is not able to
 * produce a response for it, and the client should re-send elsewhere. That is
 * exactly this situation, and it distinguishes "wrong door" from a 403 (not
 * allowed) or 404 (nothing there), both of which would be actively misleading
 * about data the caller may well have legitimate access to.
 */
export const REGION_MISMATCH_STATUS = 421;

/* ------------------------------ API models ------------------------------ */

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
}

export interface WorkspaceMember {
  userId: string;
  role: Role;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  plan: string;
  members: WorkspaceMember[];
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  type: ProjectType;
  e2ee: boolean;
  createdAt: string;
}

/** 8 collaborator identity colors (design.md §2.4). */
export const COLLABORATOR_COLORS = [
  "#C79A1E", "#3C8C43", "#0E8F82", "#2E86C1",
  "#2F5FE0", "#7A4FE0", "#9B3FA8", "#C6317E",
] as const;

export function pickCollaboratorColor(seed: number): string {
  return COLLABORATOR_COLORS[Math.abs(seed) % COLLABORATOR_COLORS.length];
}
