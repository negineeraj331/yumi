/**
 * GithubModal — link a GitHub repo to the project, then browse its commit
 * history (with per-file diffs) and file tree, and import any file into the
 * session as a new collaborative document. Linking/importing require editor+;
 * viewers get read-only browsing. Tokens are stored server-side and never
 * returned, so this UI only ever knows whether one is set (hasToken).
 */
import { useEffect, useState } from "react";
import { api, type GithubLink, type GithubCommit, type GithubCommitDetail, type GithubContents } from "../api";
import { useToast } from "../toast";

type Tab = "commits" | "browse";

export function GithubModal({ projectId, editable, onImported, onClose }: {
  projectId: string; editable: boolean; onImported: () => void; onClose: () => void;
}) {
  const { notify } = useToast();
  const [link, setLink] = useState<GithubLink | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("commits");

  useEffect(() => {
    api.getGithub(projectId)
      .then(({ github }) => setLink(github))
      .catch((e) => setError(String(e.message ?? e)));
  }, [projectId]);

  async function unlink() {
    if (!window.confirm("Unlink this repository? Imported files stay; the link is removed.")) return;
    try { await api.unlinkGithub(projectId); setLink(null); notify("Repository unlinked", "info"); }
    catch (e: any) { notify(e.message, "error"); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal replay-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>⑂ GitHub {link && <span className="mono" style={{ fontSize: 13, color: "var(--ink-muted)" }}>· {link.owner}/{link.repo}</span>}</h3>
          <div className="row" style={{ gap: 8 }}>
            {link && editable && <button className="btn btn-secondary btn-sm" onClick={unlink}>Unlink</button>}
            <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>

        {error && <div className="meta" style={{ color: "var(--danger, #C0392B)", marginTop: 12 }}>{error}</div>}
        {link === undefined && !error && <div className="meta" style={{ marginTop: 12 }}>Loading…</div>}

        {link === null && !error && (
          <LinkForm projectId={projectId} editable={editable} onLinked={setLink} />
        )}

        {link && (
          <>
            <div className="pane-tabs" style={{ marginTop: 14, borderRadius: "var(--r-md)" }}>
              <button className={`tab ${tab === "commits" ? "active" : ""}`} onClick={() => setTab("commits")}>Commits</button>
              <button className={`tab ${tab === "browse" ? "active" : ""}`} onClick={() => setTab("browse")}>Browse files</button>
              <div className="spacer" />
              <span className="meta">default: {link.defaultBranch}{link.hasToken ? " · token set" : ""}</span>
            </div>
            {tab === "commits"
              ? <CommitsTab projectId={projectId} branch={link.defaultBranch} />
              : <BrowseTab projectId={projectId} defaultBranch={link.defaultBranch} editable={editable} onImported={onImported} />}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- Link ---------------------------------- */

function LinkForm({ projectId, editable, onLinked }: {
  projectId: string; editable: boolean; onLinked: (l: GithubLink) => void;
}) {
  const { notify } = useToast();
  const [ownerRepo, setOwnerRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  if (!editable) return <div className="meta" style={{ marginTop: 16 }}>No repository linked. An editor can link one.</div>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Accept "owner/repo", a full URL, or paste with .git suffix.
    const cleaned = ownerRepo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    const [owner, repo] = cleaned.split("/");
    if (!owner || !repo) { notify("Enter owner/repo (e.g. facebook/react)", "error"); return; }
    setBusy(true);
    try {
      const { github, repo: meta } = await api.linkGithub(projectId, {
        owner, repo, branch: branch.trim() || undefined, token: token.trim() || undefined,
      });
      notify(`Linked ${meta.fullName}${meta.private ? " (private)" : ""}`, "success");
      onLinked(github);
    } catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="field">
        <label className="label">Repository</label>
        <input className="input" placeholder="owner/repo  or  https://github.com/owner/repo"
          value={ownerRepo} onChange={(e) => setOwnerRepo(e.target.value)} autoFocus />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="label">Branch <span className="meta">(optional)</span></label>
          <input className="input" placeholder="default branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label">Access token <span className="meta">(private repos)</span></label>
          <input className="input" type="password" placeholder="ghp_… (optional)" value={token}
            onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className="meta">Public repos work without a token. A token is stored server-side, never shown again, and unlocks private repos + higher rate limits.</div>
      <button className="btn btn-primary" disabled={busy}>{busy ? "Linking…" : "Link repository"}</button>
    </form>
  );
}

/* --------------------------------- Commits -------------------------------- */

function CommitsTab({ projectId, branch }: { projectId: string; branch: string }) {
  const [commits, setCommits] = useState<GithubCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GithubCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    setCommits(null); setError(null);
    api.getGithubCommits(projectId, branch)
      .then(({ commits }) => setCommits(commits))
      .catch((e) => setError(String(e.message ?? e)));
  }, [projectId, branch]);

  function toggle(sha: string) {
    if (openSha === sha) { setOpenSha(null); setDetail(null); return; }
    setOpenSha(sha); setDetail(null); setLoadingDetail(true);
    api.getGithubCommit(projectId, sha)
      .then(({ commit }) => setDetail(commit))
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoadingDetail(false));
  }

  if (error) return <div className="meta" style={{ color: "var(--danger, #C0392B)", marginTop: 12 }}>{error}</div>;
  if (!commits) return <div className="meta" style={{ marginTop: 12 }}>Loading commits…</div>;
  if (commits.length === 0) return <div className="meta" style={{ marginTop: 12 }}>No commits on {branch}.</div>;

  return (
    <div className="gh-scroll">
      {commits.map((c) => (
        <div key={c.sha} className="gh-commit">
          <div className="gh-commit-head" onClick={() => toggle(c.sha)}>
            <span className="gh-caret">{openSha === c.sha ? "▾" : "▸"}</span>
            <span className="gh-msg">{c.message.split("\n")[0]}</span>
            <span className="spacer" />
            <span className="meta" style={{ whiteSpace: "nowrap" }}>{c.authorName}</span>
            <code className="gh-sha">{c.sha.slice(0, 7)}</code>
          </div>
          {openSha === c.sha && (
            <div className="gh-commit-body">
              {loadingDetail && <div className="meta">Loading diff…</div>}
              {detail && (
                <>
                  <div className="meta" style={{ marginBottom: 6 }}>
                    {detail.date && new Date(detail.date).toLocaleString()}
                    {detail.stats && <> · <span style={{ color: "var(--success, #2E7D32)" }}>+{detail.stats.additions}</span> <span style={{ color: "var(--danger, #C0392B)" }}>−{detail.stats.deletions}</span> across {detail.files.length} file(s)</>}
                    {" · "}<a href={detail.url} target="_blank" rel="noreferrer">view on GitHub ↗</a>
                  </div>
                  {detail.files.map((f) => (
                    <div key={f.filename} className="gh-file-diff">
                      <div className="gh-diff-name mono">
                        <span className={`gh-status gh-status-${f.status}`}>{f.status}</span> {f.filename}
                        <span className="meta" style={{ marginLeft: 8 }}>+{f.additions} −{f.deletions}</span>
                      </div>
                      {f.patch
                        ? <pre className="gh-patch">{f.patch.split("\n").map((ln, i) => (
                            <div key={i} className={ln.startsWith("+") ? "gh-add" : ln.startsWith("-") ? "gh-del" : ln.startsWith("@@") ? "gh-hunk" : ""}>{ln || " "}</div>
                          ))}</pre>
                        : <div className="meta" style={{ padding: "6px 10px" }}>Binary or no textual diff.</div>}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------- Browse --------------------------------- */

function BrowseTab({ projectId, defaultBranch, editable, onImported }: {
  projectId: string; defaultBranch: string; editable: boolean; onImported: () => void;
}) {
  const { notify } = useToast();
  const [path, setPath] = useState("");
  const [data, setData] = useState<GithubContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    setData(null); setError(null);
    api.getGithubContents(projectId, path, defaultBranch)
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, [projectId, path, defaultBranch]);

  const segments = path ? path.split("/") : [];
  function goTo(i: number) { setPath(segments.slice(0, i + 1).join("/")); }

  async function importFile(filePath: string) {
    setImporting(true);
    try {
      const { file } = await api.importGithubFile(projectId, { path: filePath, ref: defaultBranch });
      notify(`Imported ${file.path}`, "success");
      onImported();
    } catch (e: any) { notify(e.message, "error"); }
    finally { setImporting(false); }
  }

  return (
    <div>
      {/* Breadcrumb */}
      <div className="gh-crumbs">
        <button className="gh-crumb" onClick={() => setPath("")}>{defaultBranch}</button>
        {segments.map((s, i) => (
          <span key={i}><span className="gh-sep">/</span><button className="gh-crumb" onClick={() => goTo(i)}>{s}</button></span>
        ))}
      </div>

      {error && <div className="meta" style={{ color: "var(--danger, #C0392B)" }}>{error}</div>}
      {!data && !error && <div className="meta">Loading…</div>}

      {data?.kind === "dir" && (
        <div className="gh-scroll">
          {[...data.entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)).map((e) => (
            <div key={e.path} className="gh-entry">
              {e.type === "dir" ? (
                <button className="gh-entry-btn" onClick={() => setPath(e.path)}>📁 {e.name}</button>
              ) : (
                <>
                  <button className="gh-entry-btn" onClick={() => setPath(e.path)}>📄 {e.name}</button>
                  {editable && (
                    <button className="btn btn-secondary btn-sm" disabled={importing} onClick={() => importFile(e.path)} title="Import into session">Import</button>
                  )}
                </>
              )}
            </div>
          ))}
          {data.entries.length === 0 && <div className="meta">Empty directory.</div>}
        </div>
      )}

      {data?.kind === "file" && (
        <div>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: "8px 0" }}>
            <span className="mono meta">{data.path} · {(data.size / 1024).toFixed(1)} KB</span>
            {editable && (
              <button className="btn btn-primary btn-sm" disabled={importing} onClick={() => importFile(data.path)}>
                {importing ? "Importing…" : "Import into session"}
              </button>
            )}
          </div>
          <pre className="replay-code">{data.content}</pre>
        </div>
      )}
    </div>
  );
}
