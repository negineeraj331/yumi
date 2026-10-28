/**
 * AdminPage — workspace admin console (owner only).
 *
 * Four things an owner needs and had no way to do before: read the audit log,
 * decide how long it is kept, change member roles, and connect a directory. The audit log is the
 * sensitive part — it records who did what and from where — so every route
 * behind this page is owner-gated server-side; this UI is a convenience, not
 * the boundary.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { AUDIT_ACTIONS, AUDIT_GROUPS, auditActionLabel, AUDIT_RETENTION, ROLES } from "@yumi/shared";
import { api, type AuditEntry, type AuditStats, type WorkspaceSettings, type ScimStatus, type ResidencyStatus } from "../api";
import { useToast } from "../toast";
import { ThemeToggle } from "../theme";

type Tab = "audit" | "members" | "settings" | "directory" | "residency";

export function AdminPage() {
  const { workspaceId } = useParams();
  const { notify } = useToast();
  const [tab, setTab] = useState<Tab>("audit");
  const [denied, setDenied] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    api.getWorkspaceSettings(workspaceId!)
      .then((r) => setName(r.name))
      .catch((e) => { if (/permission/i.test(e.message)) setDenied(true); else notify(e.message, "error"); });
  }, [workspaceId, notify]);

  if (denied) {
    return (
      <div className="center-screen" style={{ flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0 }}>Owners only</h3>
        <div className="meta">The admin console is limited to workspace owners.</div>
        <Link className="btn btn-secondary btn-sm" to={`/w/${workspaceId}`}>← Back to workspace</Link>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <div className="topbar">
        <Link to={`/w/${workspaceId}`} className="meta">← {name || "Workspace"}</Link>
        <span className="chip chip-role">admin</span>
        <div className="spacer" />
        <ThemeToggle />
      </div>

      <div className="pane-tabs">
        <button className={`tab ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")}>Audit log</button>
        <button className={`tab ${tab === "members" ? "active" : ""}`} onClick={() => setTab("members")}>Members</button>
        <button className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>Retention</button>
        <button className={`tab ${tab === "directory" ? "active" : ""}`} onClick={() => setTab("directory")}>Directory sync</button>
        <button className={`tab ${tab === "residency" ? "active" : ""}`} onClick={() => setTab("residency")}>Data residency</button>
      </div>

      <div className="admin-body">
        {tab === "audit" && <AuditTab workspaceId={workspaceId!} />}
        {tab === "members" && <MembersTab workspaceId={workspaceId!} />}
        {tab === "settings" && <SettingsTab workspaceId={workspaceId!} />}
        {tab === "directory" && <DirectoryTab workspaceId={workspaceId!} />}
        {tab === "residency" && <ResidencyTab workspaceId={workspaceId!} />}
      </div>
    </div>
  );
}

/* -------------------------------- Audit ---------------------------------- */

function AuditTab({ workspaceId }: { workspaceId: string }) {
  const { notify } = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [group, setGroup] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const r = await api.getAudit(workspaceId, {
        group: action ? undefined : group || undefined,
        action: action || undefined,
        from: from || undefined,
        to: to || undefined,
        before: append ? cursor ?? undefined : undefined,
      });
      setEntries((prev) => (append ? [...prev, ...r.entries] : r.entries));
      setHasMore(r.hasMore);
      setCursor(r.nextCursor);
    } catch (e: any) { notify(e.message, "error"); }
    finally { setLoading(false); }
  }, [workspaceId, group, action, from, to, cursor, notify]);

  // Reload from the top whenever a filter changes (cursor deliberately excluded).
  useEffect(() => { setCursor(null); load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [group, action, from, to]);
  useEffect(() => { api.getAuditStats(workspaceId).then(setStats).catch(() => {}); }, [workspaceId]);

  async function exportCsv() {
    try {
      const url = await api.auditCsvUrl(workspaceId, { action: action || undefined, from: from || undefined, to: to || undefined });
      const a = document.createElement("a");
      a.href = url; a.download = `yumi-audit-${workspaceId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      notify("Export downloaded", "success");
    } catch (e: any) { notify(e.message, "error"); }
  }

  return (
    <>
      {stats && (
        <div className="admin-stats">
          <Stat label={`Events (${stats.days}d)`} value={stats.total} />
          <Stat label="Security events" value={stats.securityEvents} />
          <Stat label="Failed sign-ins" value={stats.failedLogins} tone={stats.failedLogins > 0 ? "warn" : undefined} />
        </div>
      )}

      <div className="row admin-filters">
        <select className="lang-select" value={group} onChange={(e) => { setGroup(e.target.value); setAction(""); }}>
          <option value="">All groups</option>
          {AUDIT_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select className="lang-select" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {AUDIT_ACTIONS.filter((a) => !group || a.group === group).map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
        <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
        <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
        <div className="spacer" />
        <button className="btn btn-secondary btn-sm" onClick={exportCsv}>Export CSV</button>
      </div>

      {entries.length === 0 && !loading && <div className="meta" style={{ padding: 16 }}>No matching audit entries.</div>}

      <div className="audit-list">
        {entries.map((e) => {
          const isSecurity = AUDIT_ACTIONS.find((a) => a.id === e.action && (a as any).security);
          return (
            <div key={e._id} className={`audit-row ${isSecurity ? "security" : ""}`}
              onClick={() => setExpanded(expanded === e._id ? null : e._id)}>
              <span className="audit-time mono">{new Date(e.ts).toLocaleString()}</span>
              <span className="audit-action">{auditActionLabel(e.action)}</span>
              <span className="audit-actor">{e.actorName}</span>
              <span className="audit-ip mono">{e.ip ?? "—"}</span>
              {expanded === e._id && (
                <pre className="audit-detail mono">
                  {JSON.stringify({ action: e.action, target: e.target, meta: e.meta }, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {hasMore && (
        <button className="btn btn-secondary btn-sm" style={{ margin: 12 }} disabled={loading}
          onClick={() => load(true)}>{loading ? "Loading…" : "Load older"}</button>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div className="admin-stat">
      <div className={`admin-stat-value ${tone === "warn" ? "warn" : ""}`}>{value}</div>
      <div className="meta">{label}</div>
    </div>
  );
}

/* ------------------------------- Members --------------------------------- */

function MembersTab({ workspaceId }: { workspaceId: string }) {
  const { notify } = useToast();
  const [members, setMembers] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getWorkspace(workspaceId)
      .then((r: any) => setMembers(r.workspace?.members ?? []))
      .catch((e: any) => notify(e.message, "error"));
  }, [workspaceId, notify]);
  useEffect(load, [load]);

  async function change(userId: string, role: string) {
    setBusy(userId);
    try { await api.changeMemberRole(workspaceId, userId, role); notify("Role updated", "success"); load(); }
    catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(null); }
  }

  return (
    <div style={{ padding: 12 }}>
      {members.length === 0 && <div className="meta">No members loaded.</div>}
      {members.map((m) => {
        const u = m.userId ?? {};
        const id = String(u._id ?? m.userId);
        return (
          <div key={id} className="shortcut-row">
            <span>
              {u.displayName ?? id} <span className="meta">{u.email ?? ""}</span>
            </span>
            <select className="lang-select" value={m.role} disabled={busy === id}
              onChange={(e) => change(id, e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        );
      })}
      <div className="meta" style={{ marginTop: 10 }}>
        The last owner cannot be demoted — the server refuses it, so a workspace can never be left without one.
      </div>
    </div>
  );
}

/* ------------------------------- Settings -------------------------------- */

function SettingsTab({ workspaceId }: { workspaceId: string }) {
  const { notify } = useToast();
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [days, setDays] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getWorkspaceSettings(workspaceId)
      .then((r) => { setSettings(r.settings); setDays(r.settings.auditRetentionDays); })
      .catch((e) => notify(e.message, "error"));
  }, [workspaceId, notify]);

  if (!settings) return <div className="meta" style={{ padding: 16 }}>Loading…</div>;
  const dirty = days !== settings.auditRetentionDays;

  async function save() {
    if (days > 0 && !window.confirm(
      `Audit entries older than ${days} days will be permanently deleted, and will keep being deleted as they age out. This cannot be undone. Continue?`
    )) return;
    setBusy(true);
    try {
      const r = await api.updateWorkspaceSettings(workspaceId, { auditRetentionDays: days });
      setSettings(r.settings);
      notify("Retention updated", "success");
    } catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 16, maxWidth: 560, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="field">
        <label className="label">Audit log retention</label>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <input className="input" type="number" min={AUDIT_RETENTION.min} max={AUDIT_RETENTION.max}
            value={days} onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))} style={{ width: 120 }} />
          <span className="meta">days · 0 = keep forever</span>
        </div>
      </div>
      <div className="meta">
        {days === 0
          ? "Entries are kept indefinitely. Nothing is deleted."
          : `Entries older than ${days} days are deleted by a periodic sweep. Deletion is permanent.`}
      </div>
      <div>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : dirty ? "Save retention" : "Saved"}
        </button>
      </div>
      <div className="meta" style={{ marginTop: 8 }}>
        Changing this is itself recorded in the audit log, with the old and new values.
      </div>
    </div>
  );
}

/* ------------------------------ Residency -------------------------------- */

/**
 * Where this workspace's data is held — and, at least as importantly, what that
 * does not cover. Anything sent to a third party leaves the region however the
 * storage is pinned, so the features which do that are listed by name: refused
 * ones with the reason, enabled ones as a standing disclosure rather than a
 * footnote nobody reads.
 */
function ResidencyTab({ workspaceId }: { workspaceId: string }) {
  const { notify } = useToast();
  const [r, setR] = useState<ResidencyStatus | null>(null);

  useEffect(() => {
    api.getResidency(workspaceId).then((x) => setR(x.residency)).catch((e) => notify(e.message, "error"));
  }, [workspaceId, notify]);

  if (!r) return <div className="meta" style={{ padding: 16 }}>Loading…</div>;

  const label = (id: string | null) => r.regions.find((x) => x.id === id)?.label ?? id ?? "—";

  return (
    <div style={{ padding: 16, maxWidth: 680, display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="field">
        <label className="label">This workspace's data region</label>
        {r.pinnedRegion ? (
          <div style={{ color: "var(--ink-secondary)" }}>
            Stored in <b>{label(r.pinnedRegion)}</b> · pinned when the workspace was created and
            not changeable. Every request for it — pages, realtime editing, directory sync and
            invites alike — is refused by any deployment outside that region.
          </div>
        ) : (
          <div style={{ color: "var(--ink-secondary)" }}>
            Not pinned. This workspace is served by whichever deployment receives the request,
            which is the behaviour for everything created before residency was configured.
            Pinning happens at creation, so an existing workspace cannot be pinned in place.
          </div>
        )}
      </div>

      <div className="field">
        <label className="label">This deployment</label>
        <div style={{ color: "var(--ink-secondary)" }}>
          {r.deploymentRegion
            ? <>Stores data in <b>{label(r.deploymentRegion)}</b>.</>
            : <>Does not declare a region, so it cannot serve any pinned workspace.</>}
          {r.regions.length > 1 && (
            <> Known regions: {r.regions.map((x) => x.label).join(", ")}.</>
          )}
        </div>
      </div>

      {r.blockedEgress.length > 0 && (
        <div className="field">
          <label className="label">Refused here — would leave the region</label>
          <div style={{ display: "grid", gap: 10 }}>
            {r.blockedEgress.map((f) => (
              <div key={f.id} style={{ color: "var(--ink-secondary)" }}>
                <b>{f.label}</b> — {f.detail}
                <div className="meta" style={{ textTransform: "none", letterSpacing: 0, marginTop: 2 }}>
                  An operator enables it by setting <code>{f.declaredBy}</code>.
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {r.allowedEgress.length > 0 && (
        <div className="field">
          <label className="label">
            {r.pinnedRegion ? "Enabled by the operator — data leaves the region" : "Available"}
          </label>
          <div style={{ color: "var(--ink-secondary)" }}>
            {r.allowedEgress.map((f) => f.label).join(" · ")}
          </div>
        </div>
      )}

      <div className="field">
        <label className="label">What pinning does not cover</label>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--ink-secondary)", lineHeight: 1.6 }}>
          <li>
            <b>Calls.</b> Audio and video go peer-to-peer or through the configured relay, whose
            location is a deployment setting this page cannot verify.
          </li>
          <li>
            <b>Direct messages.</b> A DM belongs to two people rather than to a workspace and is
            readable from anywhere they both are, so it is not pinned to any one region.
          </li>
          <li>
            <b>Browsers.</b> Anyone you invite can read the workspace from wherever they are;
            residency governs where data is stored and processed, not who you share it with.
          </li>
        </ul>
      </div>

      <div className="meta" style={{ textTransform: "none", letterSpacing: 0 }}>
        Running, testing, profiling and debugging happen in this deployment's own sandbox, so they
        stay in region. Refused cross-region requests and refused features are both recorded in the
        audit log under “residency”.
      </div>
    </div>
  );
}

/**
 * Directory sync (SCIM). The token is shown exactly once, on creation — the
 * server keeps only its hash, so there is no "show it again" to offer.
 */
function DirectoryTab({ workspaceId }: { workspaceId: string }) {
  const { notify } = useToast();
  const [scim, setScim] = useState<ScimStatus | null>(null);
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getScim(workspaceId)
      .then((r) => { setScim(r.scim); setRole(r.scim.defaultRole); })
      .catch((e) => notify(e.message, "error"));
  }, [workspaceId, notify]);

  if (!scim) return <div className="meta" style={{ padding: 16 }}>Loading…</div>;

  async function generate() {
    if (scim!.configured && !window.confirm(
      "Generating a new token immediately invalidates the current one. Your identity provider will stop syncing until you paste the new token into it. Continue?"
    )) return;
    setBusy(true);
    try {
      const r = await api.createScimToken(workspaceId, role);
      setScim(r.scim);
      setIssued(r.token);
      notify("Token generated — copy it now", "success");
    } catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(false); }
  }

  async function revoke() {
    if (!window.confirm(
      "Revoking stops all directory sync for this workspace. Existing members keep their access; no one new will be provisioned or deprovisioned. Continue?"
    )) return;
    setBusy(true);
    try {
      const r = await api.revokeScimToken(workspaceId);
      setScim(r.scim);
      setIssued(null);
      notify("Directory sync revoked", "success");
    } catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 16, maxWidth: 620, display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="meta">
        Let your identity provider create and remove members automatically. When someone is
        deprovisioned there, they lose access here — their sessions end immediately and they
        cannot sign back in.
      </div>

      <div className="field">
        <label className="label">SCIM base URL</label>
        <input className="input" readOnly value={scim.baseUrl} onFocus={(e) => e.currentTarget.select()} />
      </div>

      <div className="field">
        <label className="label">Role for provisioned members</label>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <select className="input" style={{ width: 160 }} value={role}
            onChange={(e) => setRole(e.target.value as "editor" | "viewer")}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
          </select>
          <span className="meta">Applied when an account is first added. Roles changed here are never overwritten by a later sync.</span>
        </div>
      </div>

      {scim.configured ? (
        <div className="meta">
          Active token ends in <b>…{scim.tokenHint}</b> · created{" "}
          {scim.createdAt ? new Date(scim.createdAt).toLocaleString() : "—"} · last used{" "}
          {scim.lastUsedAt ? new Date(scim.lastUsedAt).toLocaleString() : "never"}
        </div>
      ) : (
        <div className="meta">Directory sync is not set up for this workspace.</div>
      )}

      {issued && (
        <div className="field">
          <label className="label">New token — copy it now, it is not shown again</label>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" readOnly value={issued} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn-secondary btn-sm"
              onClick={() => { void navigator.clipboard?.writeText(issued); notify("Copied", "success"); }}>
              Copy
            </button>
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={generate} disabled={busy}>
          {busy ? "Working…" : scim.configured ? "Replace token" : "Generate token"}
        </button>
        {scim.configured && (
          <button className="btn btn-secondary btn-sm" onClick={revoke} disabled={busy}>Revoke</button>
        )}
      </div>

      <div className="meta">
        Users only — groups are not synced, so roles stay a decision made here. Every
        provisioning action is recorded in the audit log under “directory”.
      </div>
    </div>
  );
}
