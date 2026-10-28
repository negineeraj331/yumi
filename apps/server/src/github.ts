/**
 * Thin GitHub REST API wrapper. Public repos work tokenless (rate-limited);
 * a stored PAT lifts limits and unlocks private repos. Tokens live server-side
 * only and are never returned to clients. See TRD (Phase 2 integrations).
 */
const API = "https://api.github.com";

function ghHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Yumi",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function gh(path: string, token?: string): Promise<any> {
  const res = await fetch(API + path, { headers: ghHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(
      res.status === 404 ? "Repository or path not found (is it private?)"
      : res.status === 403 ? "GitHub rate limit or access denied — add a token."
      : `GitHub error ${res.status}: ${body.slice(0, 160)}`
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export interface RepoMeta { fullName: string; defaultBranch: string; private: boolean; description: string | null; }

export async function getRepo(owner: string, repo: string, token?: string): Promise<RepoMeta> {
  const r = await gh(`/repos/${owner}/${repo}`, token);
  return { fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, description: r.description };
}

export async function listCommits(owner: string, repo: string, token?: string, branch?: string, perPage = 30): Promise<any[]> {
  const q = new URLSearchParams({ per_page: String(perPage) });
  if (branch) q.set("sha", branch);
  const rows = await gh(`/repos/${owner}/${repo}/commits?${q}`, token);
  return (rows as any[]).map((c) => ({
    sha: c.sha,
    message: c.commit?.message ?? "",
    authorName: c.commit?.author?.name ?? c.author?.login ?? "unknown",
    authorLogin: c.author?.login ?? null,
    date: c.commit?.author?.date ?? null,
    url: c.html_url,
  }));
}

export async function getCommit(owner: string, repo: string, sha: string, token?: string): Promise<any> {
  const c = await gh(`/repos/${owner}/${repo}/commits/${sha}`, token);
  return {
    sha: c.sha,
    message: c.commit?.message ?? "",
    authorName: c.commit?.author?.name ?? "unknown",
    date: c.commit?.author?.date ?? null,
    url: c.html_url,
    stats: c.stats ?? null,
    files: (c.files ?? []).map((f: any) => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions, patch: f.patch ?? null,
    })),
  };
}

/** Directory listing or a single file's decoded content. */
export async function getContents(owner: string, repo: string, path: string, token?: string, ref?: string): Promise<any> {
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const data = await gh(`/repos/${owner}/${repo}/contents/${safePath}${q}`, token);
  if (Array.isArray(data)) {
    return {
      kind: "dir",
      entries: data.map((e: any) => ({ name: e.name, path: e.path, type: e.type, size: e.size })),
    };
  }
  const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : (data.content ?? "");
  return { kind: "file", path: data.path, name: data.name, size: data.size, content };
}
