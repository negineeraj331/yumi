/**
 * The screen shown when an encrypted project is opened without its key.
 *
 * There is no "recover" or "email me a link" here, and that absence is the
 * feature: a key the server could send you is a key the server has. The only
 * way in is a key another member gives you outside Yumi.
 */
import { useState } from "react";
import { Link } from "react-router-dom";

export function E2eeKeyGate({ projectName, workspaceId, onSubmit }: {
  projectName: string;
  workspaceId?: string;
  onSubmit: (key: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const accepted = await onSubmit(value.trim());
    if (!accepted) setError("That key does not open this project. Check it with whoever shared it.");
    setBusy(false);
  }

  return (
    <div className="center-screen" style={{ flexDirection: "column", gap: 14, maxWidth: 460, margin: "0 auto", padding: 24 }}>
      <div style={{ fontSize: 30 }}>🔒</div>
      <h3 style={{ margin: 0, textAlign: "center" }}>{projectName} is end-to-end encrypted</h3>
      <div className="meta" style={{ textAlign: "center" }}>
        Its contents are encrypted in your browser, so the server stores only ciphertext
        and cannot read it. Enter the project key to open it — a member who already has
        access can share it with you.
      </div>
      <form onSubmit={submit} style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
        <input className="input mono" autoFocus placeholder="Project key"
          value={value} onChange={(e) => setValue(e.target.value)} />
        {error && <div className="meta" style={{ color: "var(--danger, #c0392b)" }}>{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
      <div className="meta" style={{ textAlign: "center" }}>
        Yumi cannot recover this key for you. If everyone loses it, the contents are gone
        for good — that is what end-to-end encrypted means.
      </div>
      {workspaceId && <Link className="btn btn-secondary btn-sm" to={`/w/${workspaceId}`}>← Back to workspace</Link>}
    </div>
  );
}
