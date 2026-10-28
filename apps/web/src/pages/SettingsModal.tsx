import { useState } from "react";
import { COLLABORATOR_COLORS } from "@yumi/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useTheme } from "../theme";
import { useToast } from "../toast";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { user, setUser, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { notify } = useToast();
  const [name, setName] = useState(user?.displayName ?? "");
  const [color, setColor] = useState(user?.avatarColor ?? COLLABORATOR_COLORS[0]);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const { user } = await api.updateProfile({ displayName: name.trim(), avatarColor: color });
      setUser(user);
      notify("Settings saved", "success");
      onClose();
    } catch (e: any) {
      notify(e.message, "error");
    } finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
          <h2 className="display" style={{ fontSize: 26, margin: 0 }}>Settings</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
        </div>

        <div className="field" style={{ marginBottom: 18 }}>
          <label className="label">Display name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="field" style={{ marginBottom: 18 }}>
          <label className="label">Your color</label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {COLLABORATOR_COLORS.map((c) => (
              <button key={c} className={`cswatch ${color === c ? "active" : ""}`} style={{ background: c, width: 28, height: 28 }}
                onClick={() => setColor(c)} title={c} />
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <div className="avatar" style={{ background: color, width: 34, height: 34 }}>{name[0]?.toUpperCase() ?? "?"}</div>
            <span className="meta">Preview · used for your cursor &amp; avatar everywhere</span>
          </div>
        </div>

        <div className="field" style={{ marginBottom: 18 }}>
          <label className="label">Appearance</label>
          <button className="btn btn-secondary" onClick={toggle}>
            {theme === "light" ? "🌙 Switch to dark" : "☀️ Switch to light"}
          </button>
        </div>

        <div className="field" style={{ marginBottom: 24 }}>
          <label className="label">Account</label>
          <div className="meta">{user?.email}</div>
        </div>

        <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={() => logout()}>Log out</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}
