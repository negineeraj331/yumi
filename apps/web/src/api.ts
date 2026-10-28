import type {
  PublicUser, ScimStatus, RegionInfo, RegionMismatch, ResidencyStatus,
} from "@yumi/shared";
import { REGION_MISMATCH_CODE, REGION_MISMATCH_STATUS } from "@yumi/shared";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * The request reached a deployment that does not hold this workspace's data.
 *
 * Given its own type because the one thing that must not happen is for it to
 * surface as a generic "Request failed" toast: the caller is not doing anything
 * wrong, and the answer — which region to continue in — is in the response.
 */
export class RegionMismatchError extends Error {
  constructor(public readonly detail: RegionMismatch) {
    super(detail.error);
    this.name = "RegionMismatchError";
  }
}

export function isRegionMismatch(e: unknown): e is RegionMismatchError {
  return e instanceof RegionMismatchError;
}

let accessToken: string | null = null;
export function setAccessToken(t: string | null) {
  accessToken = t;
}
export function getAccessToken() {
  return accessToken;
}

async function request<T>(path: string, opts: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(opts.headers ?? {}),
    },
  });

  // Try a silent refresh once on 401
  if (res.status === 401 && retry && path !== "/api/auth/refresh") {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, opts, false);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === REGION_MISMATCH_STATUS && body?.code === REGION_MISMATCH_CODE) {
      throw new RegionMismatchError(body as RegionMismatch);
    }
    throw new Error(body.error?.formErrors?.[0] ?? body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/auth/refresh`, { method: "POST", credentials: "include" });
    if (!res.ok) return false;
    const { accessToken: t } = await res.json();
    accessToken = t;
    return true;
  } catch {
    return false;
  }
}

export const api = {
  register: (data: { email: string; password: string; displayName: string }) =>
    request<{ user: PublicUser; accessToken: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  login: (data: { email: string; password: string }) =>
    request<{ user: PublicUser; accessToken: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  refresh: tryRefresh,
  me: () => request<{ user: PublicUser }>("/api/auth/me"),
  updateProfile: (data: { displayName?: string; avatarColor?: string; theme?: string }) =>
    request<{ user: PublicUser }>("/api/auth/me", { method: "PATCH", body: JSON.stringify(data) }),

  /** `elsewhere` counts workspaces held in other regions — never their names. */
  listWorkspaces: () =>
    request<{ workspaces: any[]; elsewhere: WorkspacesElsewhere[] }>("/api/workspaces"),
  createWorkspace: (name: string, region?: string) =>
    request<{ workspace: any }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(region ? { name, region } : { name }),
    }),
  getWorkspace: (id: string) => request<{ workspace: any }>(`/api/workspaces/${id}`),
  getSessions: (id: string) => request<{ sessions: any[] }>(`/api/workspaces/${id}/sessions`),
  changeRole: (workspaceId: string, userId: string, role: string) =>
    request<{ workspace: any }>(`/api/workspaces/${workspaceId}/members`, {
      method: "PATCH",
      body: JSON.stringify({ userId, role }),
    }),

  listProjects: (workspaceId: string) =>
    request<{ projects: any[] }>(`/api/projects/workspace/${workspaceId}`),
  createProject: (data: { workspaceId: string; name: string; type: string; e2ee?: boolean; e2eeKeyCheck?: string }) =>
    request<{ project: any }>("/api/projects", { method: "POST", body: JSON.stringify(data) }),
  getProject: (id: string) =>
    request<{ project: any; files: any[]; role: string }>(`/api/projects/${id}`),
  createFile: (projectId: string, path: string, language: string) =>
    request<{ file: any }>(`/api/projects/${projectId}/files`, {
      method: "POST",
      body: JSON.stringify({ path, language }),
    }),
  updateFile: (projectId: string, fileId: string, data: { language?: string; path?: string }) =>
    request<{ file: any }>(`/api/projects/${projectId}/files/${fileId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteFile: (projectId: string, fileId: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" }),

  createInvite: (data: { workspaceId: string; scope: string; expiresInHours?: number }) =>
    request<{ token: string; scope: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getInvite: (token: string) =>
    request<{ workspaceName: string; scope: string; requireLogin: boolean }>(`/api/invites/${token}`),
  acceptInvite: (token: string) =>
    request<{ workspaceId: string; role: string }>(`/api/invites/${token}/accept`, { method: "POST" }),

  getMessages: (projectId: string, q?: string) =>
    request<{ messages: any[] }>(`/api/messages/${projectId}${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  getThread: (projectId: string, rootId: string) =>
    request<{ root: any; replies: any[] }>(`/api/messages/${projectId}/thread/${rootId}`),

  getDmConversations: () =>
    request<{ conversations: any[] }>(`/api/messages/dm`),

  getDmHistory: (userId: string) =>
    request<{ messages: any[] }>(`/api/messages/dm/${userId}`),

  getDocHistory: (projectId: string, docId: string) =>
    request<{ docId: string; count: number; timeline: { seq: number; ts: string; authorName: string; authorColor: string }[] }>(
      `/api/projects/${projectId}/history/${encodeURIComponent(docId)}`),

  getDocReplay: (projectId: string, docId: string, upTo: number) =>
    request<{ docId: string; seq: number; text: string }>(
      `/api/projects/${projectId}/replay/${encodeURIComponent(docId)}?upTo=${upTo}`),

  /* ------------------------------ GitHub ------------------------------ */
  getGithub: (projectId: string) =>
    request<{ github: GithubLink | null }>(`/api/projects/${projectId}/github`),
  linkGithub: (projectId: string, data: { owner: string; repo: string; branch?: string; token?: string }) =>
    request<{ github: GithubLink; repo: { fullName: string; defaultBranch: string; private: boolean; description: string | null } }>(
      `/api/projects/${projectId}/github`, { method: "POST", body: JSON.stringify(data) }),
  unlinkGithub: (projectId: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}/github`, { method: "DELETE" }),
  getGithubCommits: (projectId: string, branch?: string) =>
    request<{ commits: GithubCommit[]; branch: string }>(
      `/api/projects/${projectId}/github/commits${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`),
  getGithubCommit: (projectId: string, sha: string) =>
    request<{ commit: GithubCommitDetail }>(`/api/projects/${projectId}/github/commit/${sha}`),
  getGithubContents: (projectId: string, path = "", ref?: string) =>
    request<GithubContents>(
      `/api/projects/${projectId}/github/contents?path=${encodeURIComponent(path)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`),
  importGithubFile: (projectId: string, data: { path: string; ref?: string; as?: string }) =>
    request<{ file: any }>(`/api/projects/${projectId}/github/import`, { method: "POST", body: JSON.stringify(data) }),

  /* ------------------------------- Figma ------------------------------- */
  getFigma: (projectId: string) =>
    request<{ figma: FigmaLink | null }>(`/api/projects/${projectId}/figma`),
  linkFigma: (projectId: string, data: { file: string; token: string }) =>
    request<{ figma: FigmaLink; file: FigmaFile }>(
      `/api/projects/${projectId}/figma`, { method: "POST", body: JSON.stringify(data) }),
  unlinkFigma: (projectId: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}/figma`, { method: "DELETE" }),
  getFigmaFile: (projectId: string) =>
    request<{ file: FigmaFile }>(`/api/projects/${projectId}/figma/file`),
  renderFigmaNode: (projectId: string, data: { nodeId: string; scale?: number }) =>
    request<{ nodeId: string; dataUrl: string }>(
      `/api/projects/${projectId}/figma/render`, { method: "POST", body: JSON.stringify(data) }),

  /* ------------------------------- Slack ------------------------------- */
  getSlack: (projectId: string) =>
    request<{ slack: SlackLink | null }>(`/api/projects/${projectId}/slack`),
  linkSlack: (projectId: string, data: { webhookUrl: string; channelLabel?: string; events?: string[] }) =>
    request<{ slack: SlackLink }>(`/api/projects/${projectId}/slack`, { method: "POST", body: JSON.stringify(data) }),
  updateSlackEvents: (projectId: string, events: string[]) =>
    request<{ slack: SlackLink }>(`/api/projects/${projectId}/slack`, { method: "PATCH", body: JSON.stringify({ events }) }),
  unlinkSlack: (projectId: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}/slack`, { method: "DELETE" }),
  testSlack: (projectId: string) =>
    request<{ ok: true }>(`/api/projects/${projectId}/slack/test`, { method: "POST" }),

  /** Configured SSO providers across both protocols; empty when there are none. */
  getSsoProviders: () =>
    request<{ providers: { id: string; label: string; protocol: "oidc" | "saml"; startPath: string }[] }>(
      `/api/auth/sso/providers`),

  /* --------------------------- Admin console --------------------------- */
  getAudit: (workspaceId: string, q: AuditQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
    return request<{ entries: AuditEntry[]; hasMore: boolean; nextCursor: string | null }>(
      `/api/workspaces/${workspaceId}/audit?${p}`);
  },
  getAuditStats: (workspaceId: string, days = 30) =>
    request<AuditStats>(`/api/workspaces/${workspaceId}/audit/stats?days=${days}`),
  getWorkspaceSettings: (workspaceId: string) =>
    request<{ name: string; settings: WorkspaceSettings }>(`/api/workspaces/${workspaceId}/settings`),
  updateWorkspaceSettings: (workspaceId: string, data: Partial<WorkspaceSettings>) =>
    request<{ settings: WorkspaceSettings }>(`/api/workspaces/${workspaceId}/settings`,
      { method: "PATCH", body: JSON.stringify(data) }),
  /* --------------------------- Data residency -------------------------- */
  /** Where this deployment stores data, and the regions it can point at. */
  getRegions: () =>
    request<{ region: string | null; regions: RegionInfo[] }>(`/api/workspaces/regions`),
  /** One workspace's pin, plus what the pin does and does not cover. */
  getResidency: (workspaceId: string) =>
    request<{ residency: ResidencyStatus }>(`/api/workspaces/${workspaceId}/residency`),

  getScim: (workspaceId: string) =>
    request<{ scim: ScimStatus }>(`/api/workspaces/${workspaceId}/scim`),
  // The only response that ever carries the token — it is not stored anywhere
  // it could be read back.
  createScimToken: (workspaceId: string, defaultRole: "editor" | "viewer") =>
    request<{ token: string; scim: ScimStatus }>(`/api/workspaces/${workspaceId}/scim/token`,
      { method: "POST", body: JSON.stringify({ defaultRole }) }),
  revokeScimToken: (workspaceId: string) =>
    request<{ scim: ScimStatus }>(`/api/workspaces/${workspaceId}/scim/token`, { method: "DELETE" }),
  changeMemberRole: (workspaceId: string, userId: string, role: string) =>
    request<{ workspace: any }>(`/api/workspaces/${workspaceId}/members`,
      { method: "PATCH", body: JSON.stringify({ userId, role }) }),

  /** CSV comes back as a file, not JSON — fetch it directly and hand back a blob URL. */
  auditCsvUrl: async (workspaceId: string, q: { action?: string; from?: string; to?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
    const res = await fetch(`${API}/api/workspaces/${workspaceId}/audit/export.csv?${p}`, {
      credentials: "include",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },
};

export interface AuditQuery {
  action?: string; group?: string; actorId?: string;
  from?: string; to?: string; before?: string; limit?: number;
}
export interface AuditEntry {
  _id: string; action: string; actorId: string | null; actorName: string;
  target: Record<string, unknown>; meta: Record<string, unknown>;
  ip: string | null; ts: string;
}
export interface AuditStats {
  days: number; total: number; securityEvents: number; failedLogins: number;
  byAction: { action: string; count: number }[];
}
export interface WorkspaceSettings {
  defaultLinkScope: string;
  auditRetentionDays: number;
  /** null = unpinned. Read-only: fixed when the workspace was created. */
  dataResidencyRegion?: string | null;
}
/** A region holding workspaces this deployment will not serve, and how many. */
export interface WorkspacesElsewhere { region: string; label: string; url: string | null; count: number }
export type { ScimStatus, RegionInfo, RegionMismatch, ResidencyStatus };

export interface GithubLink { owner: string; repo: string; defaultBranch: string; linkedAt: string; hasToken: boolean }
export interface GithubCommit { sha: string; message: string; authorName: string; authorLogin: string | null; date: string | null; url: string }
export interface GithubDiffFile { filename: string; status: string; additions: number; deletions: number; patch: string | null }
export interface GithubCommitDetail extends GithubCommit { stats: { additions: number; deletions: number; total: number } | null; files: GithubDiffFile[] }
export type GithubContents =
  | { kind: "dir"; entries: { name: string; path: string; type: string; size: number }[] }
  | { kind: "file"; path: string; name: string; size: number; content: string };

export interface FigmaLink { fileKey: string; fileName: string; linkedAt: string; hasToken: boolean }
export interface FigmaFrame { id: string; name: string; type: string; width: number | null; height: number | null }
export interface FigmaPage { id: string; name: string; frames: FigmaFrame[] }
export interface FigmaFile { fileKey: string; name: string; lastModified: string | null; pages: FigmaPage[] }

/** No webhook URL here by design — it is the credential and never leaves the server. */
export interface SlackLink { channelLabel: string; events: string[]; linkedAt: string; hasWebhook: boolean }

export { API };
