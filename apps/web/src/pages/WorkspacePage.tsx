import { useEffect, useState } from "react";
import { generateProjectKey, keyCheck, storeKey } from "../collab/e2ee";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api";
import { ThemeToggle } from "../theme";
import { useToast } from "../toast";
import { useAuth } from "../auth";
import { RegionNotice, RegionChip, asRegionMismatch } from "../region";
import type { RegionMismatch } from "@yumi/shared";

export function WorkspacePage() {
  const { workspaceId } = useParams();
  const nav = useNavigate();
  const { notify } = useToast();
  const [ws, setWs] = useState<any>(null);
  const [regionBlock, setRegionBlock] = useState<RegionMismatch | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("mixed");
  const [encrypted, setEncrypted] = useState(false);
  // Shown exactly once, right after creation. There is no way to ask for it again.
  const [newKey, setNewKey] = useState<{ key: string; projectId: string } | null>(null);
  const [inviteLink, setInviteLink] = useState("");
  const { user } = useAuth();
  // Owner of *this* workspace, from the membership list the server returned.
  const isOwner = !!ws?.members?.some(
    (m: any) => String(m.userId?._id ?? m.userId) === user?.id && m.role === "owner");

  async function load() {
    const [{ workspace }, { projects }, { sessions }] = await Promise.all([
      api.getWorkspace(workspaceId!),
      api.listProjects(workspaceId!),
      api.getSessions(workspaceId!).catch(() => ({ sessions: [] })),
    ]);
    setWs(workspace);
    setProjects(projects);
    setSessions(sessions);
  }
  useEffect(() => {
    load().catch((e: any) => {
      const region = asRegionMismatch(e);
      if (region) { setRegionBlock(region); return; }
      notify(e.message ?? "Failed to open workspace", "error");
    });
  }, [workspaceId]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!encrypted) {
      const { project } = await api.createProject({ workspaceId: workspaceId!, name: name.trim(), type });
      nav(`/p/${project._id}`);
      return;
    }
    // The key is generated here and never leaves the browser — the server is
    // sent only a digest, so it can tell a member whether a pasted key is the
    // right one without ever being able to derive it.
    const key = generateProjectKey();
    const { project } = await api.createProject({
      workspaceId: workspaceId!, name: name.trim(), type,
      e2ee: true, e2eeKeyCheck: await keyCheck(key),
    });
    storeKey(project._id, key);
    setNewKey({ key, projectId: project._id });
  }

  async function makeInvite(scope: string) {
    try {
      const { token } = await api.createInvite({ workspaceId: workspaceId!, scope, expiresInHours: 168 });
      const link = `${window.location.origin}/invite/${token}`;
      setInviteLink(link);
      try { await navigator.clipboard.writeText(link); notify("Invite link copied to clipboard", "success"); }
      catch { notify("Invite link created", "success"); }
    } catch (e: any) { notify(e.message, "error"); }
  }

  if (regionBlock) return <RegionNotice detail={regionBlock} />;
  if (!ws) return <div className="center-screen">Loading workspace…</div>;

  return (
    <div>
      <div className="topbar">
        <Link to="/" className="meta">← Workspaces</Link>
        {ws.settings?.dataResidencyRegion && <RegionChip region={ws.settings.dataResidencyRegion} />}
        <div className="spacer" />
        {/* Owner-only console; the routes behind it are gated server-side too. */}
        {isOwner && (
          <Link className="btn btn-secondary btn-sm" to={`/w/${workspaceId}/admin`}
            title="Audit log, members and retention">⚙ Admin</Link>
        )}
        <ThemeToggle />
        <div className="avstack">
          {ws.members.map((m: any) => (
            <div key={m.userId?._id ?? m.userId} className="avatar"
              style={{ background: m.userId?.avatarColor ?? "var(--ink-muted)" }}
              title={m.userId?.displayName}>
              {(m.userId?.displayName ?? "?")[0]}
            </div>
          ))}
        </div>
      </div>

      <div className="page-pad">
        <h1 className="display" style={{ fontSize: "clamp(32px,5vw,52px)", margin: "0 0 4px" }}>{ws.name}</h1>
        <p className="meta" style={{ marginBottom: 24 }}>Projects · Members · Invites</p>

        <div className="row" style={{ gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
          <button className="btn btn-secondary btn-sm" onClick={() => makeInvite("editor")}>Invite as editor</button>
          <button className="btn btn-secondary btn-sm" onClick={() => makeInvite("viewer")}>Invite as viewer</button>
          {inviteLink && (
            <input className="input mono" style={{ fontSize: 12, maxWidth: 420 }} readOnly value={inviteLink}
              onFocus={(e) => e.target.select()} />
          )}
        </div>

        <form onSubmit={createProject} className="row" style={{ gap: 10, marginBottom: 28, flexWrap: "wrap" }}>
          <input className="input" style={{ maxWidth: 300 }} placeholder="New project name…"
            value={name} onChange={(e) => setName(e.target.value)} />
          <select className="input" style={{ maxWidth: 140 }} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="mixed">Mixed</option>
            <option value="code">Code</option>
            <option value="canvas">Canvas</option>
          </select>
          <label className="row" style={{ gap: 6, alignItems: "center" }} title="Contents are encrypted in your browser. The server stores only ciphertext and cannot read, search, or recover them.">
            <input type="checkbox" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} />
            <span className="meta">🔒 End-to-end encrypted</span>
          </label>
          <button className="btn btn-primary">Create project</button>
        </form>

        {encrypted && !newKey && (
          <div className="meta" style={{ marginTop: -18, marginBottom: 24, maxWidth: 620 }}>
            You will be shown a project key once. Share it with collaborators outside Yumi —
            anyone without it sees only ciphertext. AI assistance, message search and replay
            are unavailable in an encrypted project, and running a file still sends it to the
            sandbox in the clear.
          </div>
        )}

        {newKey && (
          <div className="card" style={{ marginBottom: 24, maxWidth: 620, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="display" style={{ fontSize: 18 }}>🔒 Save this project key</div>
            <div className="meta">
              It is stored in this browser only. Yumi has no copy and cannot recover it — if
              everyone loses it, the project's contents are gone permanently.
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input className="input mono" readOnly value={newKey.key} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-secondary btn-sm" type="button"
                onClick={() => { void navigator.clipboard?.writeText(newKey.key); notify("Key copied", "success"); }}>
                Copy
              </button>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => nav(`/p/${newKey.projectId}`)}>
                I have saved it — open the project
              </button>
            </div>
          </div>
        )}

        <div className="grid-cards">
          {projects.map((p) => (
            <div key={p._id} className="card tile" onClick={() => nav(`/p/${p._id}`)}>
              <div className="meta">{p.type}</div>
              <div className="display" style={{ fontSize: 20, marginTop: 6 }}>{p.name}</div>
            </div>
          ))}
          {projects.length === 0 && (
            <div style={{ color: "var(--ink-muted)" }}>No projects yet — create one above.</div>
          )}
        </div>

        {sessions.length > 0 && (
          <div style={{ marginTop: 40 }}>
            <h2 className="display" style={{ fontSize: 24, margin: "0 0 4px" }}>Recent sessions</h2>
            <p className="meta" style={{ marginBottom: 12 }}>Session history &amp; analytics</p>
            {sessions.map((s) => {
              const mins = s.metrics ? Math.max(1, Math.round(s.metrics.durationSec / 60)) : null;
              return (
                <div key={s._id} className="session-row">
                  <span style={{ fontWeight: 600, minWidth: 120 }}>{s.projectId?.name ?? "Project"}</span>
                  <div className="avstack">
                    {(s.participants ?? []).slice(0, 5).map((p: any, i: number) => (
                      <div key={i} className="avatar" style={{ background: p.userId?.avatarColor ?? "var(--ink-muted)" }}
                        title={p.userId?.displayName}>{(p.userId?.displayName ?? "?")[0]}</div>
                    ))}
                  </div>
                  <span className="meta">
                    {s.participants?.length ?? 0} participant{(s.participants?.length ?? 0) !== 1 ? "s" : ""}
                    {mins != null ? ` · ${mins} min` : s.endedAt ? "" : " · live"}
                    {s.metrics?.messages ? ` · ${s.metrics.messages} msgs` : ""}
                  </span>
                  <span className="act-time" style={{ marginLeft: "auto" }}>
                    {new Date(s.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
