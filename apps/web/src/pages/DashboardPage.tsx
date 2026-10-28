import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type WorkspacesElsewhere } from "../api";
import { useAuth } from "../auth";
import { ThemeToggle } from "../theme";
import { useDeploymentRegions } from "../region";
import { SettingsModal } from "./SettingsModal";

export function DashboardPage() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [elsewhere, setElsewhere] = useState<WorkspacesElsewhere[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deployment = useDeploymentRegions();
  const here = deployment?.regions.find((r) => r.self);

  async function load() {
    const { workspaces, elsewhere } = await api.listWorkspaces();
    setWorkspaces(workspaces);
    // Workspaces in other regions are counted, not named — see the route.
    setElsewhere(elsewhere ?? []);
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const { workspace } = await api.createWorkspace(name.trim());
      setName("");
      nav(`/w/${workspace._id}`);
    } finally { setCreating(false); }
  }

  return (
    <div>
      <div className="topbar">
        <div className="display" style={{ fontSize: 22 }}>Yumi<span style={{ color: "var(--accent)" }}>.</span></div>
        <div className="spacer" />
        <span className="meta">{user?.displayName}</span>
        <div className="avatar" style={{ background: user?.avatarColor }}>{user?.displayName[0]}</div>
        <ThemeToggle />
        <button className="btn btn-secondary btn-sm" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
        <button className="btn btn-secondary btn-sm" onClick={() => logout()}>Log out</button>
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      <div className="page-pad">
        <h1 className="display" style={{ fontSize: "clamp(36px,6vw,64px)", margin: "0 0 8px" }}>Workspaces</h1>
        <p className="meta" style={{ marginBottom: 28 }}>Your shared rooms for drawing, code &amp; conversation</p>

        <form onSubmit={create} style={{ marginBottom: 28, maxWidth: 460 }}>
          <div className="row" style={{ gap: 10 }}>
            <input className="input" placeholder="New workspace name…" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" disabled={creating}>Create</button>
          </div>
          {/* Stated before the fact, not after: the region is fixed at creation
              and there is no way to move a workspace afterwards. */}
          {deployment?.region && (
            <div className="meta" style={{ marginTop: 8, textTransform: "none", letterSpacing: 0 }}>
              Data will be stored in <b>{here?.label ?? deployment.region}</b> and cannot be moved later.
            </div>
          )}
        </form>

        {elsewhere.length > 0 && (
          <div className="card" style={{ padding: 16, marginBottom: 24, display: "grid", gap: 8 }}>
            <div className="meta">Held in another region</div>
            {elsewhere.map((e) => (
              <div key={e.region} className="row" style={{ gap: 10, alignItems: "center" }}>
                <span style={{ color: "var(--ink-secondary)" }}>
                  {e.count} workspace{e.count !== 1 ? "s" : ""} in {e.label}
                </span>
                <div className="spacer" />
                {e.url
                  ? <a className="btn btn-secondary btn-sm" href={e.url} rel="noreferrer">Open {e.region}</a>
                  : <span className="meta">no address configured</span>}
              </div>
            ))}
            <div className="meta" style={{ textTransform: "none", letterSpacing: 0 }}>
              Their names and contents stay in their own region, so they are counted here rather than listed.
            </div>
          </div>
        )}

        {workspaces.length === 0 ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)" }}>
            <div className="display" style={{ fontSize: 40, color: "var(--border-strong)" }}>01</div>
            No workspaces yet — create your first one above.
          </div>
        ) : (
          <div className="grid-cards">
            {workspaces.map((w) => (
              <div key={w._id} className="card tile" onClick={() => nav(`/w/${w._id}`)}>
                <div className="meta">{w.plan}</div>
                <div className="display" style={{ fontSize: 22, marginTop: 6 }}>{w.name}</div>
                <div style={{ marginTop: 10, fontSize: 13, color: "var(--ink-muted)" }}>
                  {w.members.length} member{w.members.length !== 1 ? "s" : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
