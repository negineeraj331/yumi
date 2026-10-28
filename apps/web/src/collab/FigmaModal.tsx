/**
 * FigmaModal — link a Figma file to the project, browse its pages and frames,
 * preview a frame and drop it onto the collaborative canvas as an image.
 *
 * Read-only: nothing is ever written back to Figma. The personal access token
 * is stored server-side and never returned, so this UI only knows whether one
 * is set (hasToken). Frame images are proxied by the server (Figma's render
 * URLs expire and are cross-origin), arriving here as data URLs.
 */
import { useEffect, useState } from "react";
import { api, type FigmaLink, type FigmaFile, type FigmaFrame } from "../api";
import { useToast } from "../toast";

export function FigmaModal({ projectId, editable, canInsert, onInsert, onClose }: {
  projectId: string;
  editable: boolean;
  /** False when the project has no canvas, or the canvas isn't the open tab. */
  canInsert: boolean;
  onInsert: (dataUrl: string, frameName: string) => Promise<void>;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const [link, setLink] = useState<FigmaLink | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getFigma(projectId)
      .then(({ figma }) => setLink(figma))
      .catch((e) => setError(String(e.message ?? e)));
  }, [projectId]);

  async function unlink() {
    if (!window.confirm("Unlink this Figma file? Frames already placed on the canvas stay.")) return;
    try { await api.unlinkFigma(projectId); setLink(null); notify("Figma file unlinked", "info"); }
    catch (e: any) { notify(e.message, "error"); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal replay-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>
            ◈ Figma {link && <span className="mono" style={{ fontSize: 13, color: "var(--ink-muted)" }}>· {link.fileName || link.fileKey}</span>}
          </h3>
          <div className="row" style={{ gap: 8 }}>
            {link && editable && <button className="btn btn-secondary btn-sm" onClick={unlink}>Unlink</button>}
            <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>

        {error && <div className="meta" style={{ color: "var(--error)", marginTop: 12 }}>{error}</div>}
        {link === undefined && !error && <div className="meta" style={{ marginTop: 12 }}>Loading…</div>}
        {link === null && !error && <LinkForm projectId={projectId} editable={editable} onLinked={setLink} />}
        {link && <FramesTab projectId={projectId} canInsert={canInsert} editable={editable} onInsert={onInsert} />}
      </div>
    </div>
  );
}

/* ---------------------------------- Link ---------------------------------- */

function LinkForm({ projectId, editable, onLinked }: {
  projectId: string; editable: boolean; onLinked: (l: FigmaLink) => void;
}) {
  const { notify } = useToast();
  const [file, setFile] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  if (!editable) return <div className="meta" style={{ marginTop: 16 }}>No Figma file linked. An editor can link one.</div>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file.trim() || !token.trim()) { notify("Paste a Figma file URL and a personal access token", "error"); return; }
    setBusy(true);
    try {
      const { figma, file: meta } = await api.linkFigma(projectId, { file: file.trim(), token: token.trim() });
      notify(`Linked ${meta.name}`, "success");
      onLinked(figma);
    } catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="field">
        <label className="label">Figma file</label>
        <input className="input" placeholder="https://figma.com/design/<key>/…  or  the file key"
          value={file} onChange={(e) => setFile(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label className="label">Personal access token</label>
        <input className="input" type="password" placeholder="figd_…" value={token}
          onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      </div>
      <div className="meta">
        Figma has no anonymous API, so a token is required. Create one in Figma under
        Settings → Security → Personal access tokens. It is stored server-side, never shown again,
        and is only used to read this file.
      </div>
      <button className="btn btn-primary" disabled={busy}>{busy ? "Linking…" : "Link Figma file"}</button>
    </form>
  );
}

/* --------------------------------- Frames --------------------------------- */

function FramesTab({ projectId, canInsert, editable, onInsert }: {
  projectId: string; canInsert: boolean; editable: boolean;
  onInsert: (dataUrl: string, frameName: string) => Promise<void>;
}) {
  const { notify } = useToast();
  const [file, setFile] = useState<FigmaFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ frame: FigmaFrame; dataUrl: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    api.getFigmaFile(projectId)
      .then(({ file }) => { setFile(file); setPageId(file.pages[0]?.id ?? null); })
      .catch((e) => setError(String(e.message ?? e)));
  }, [projectId]);

  if (error) return <div className="meta" style={{ color: "var(--error)", marginTop: 14 }}>{error}</div>;
  if (!file) return <div className="meta" style={{ marginTop: 14 }}>Loading frames…</div>;

  const page = file.pages.find((p) => p.id === pageId) ?? file.pages[0];

  async function render(frame: FigmaFrame) {
    setBusyId(frame.id);
    try {
      const { dataUrl } = await api.renderFigmaNode(projectId, { nodeId: frame.id, scale: 2 });
      setPreview({ frame, dataUrl });
    } catch (e: any) { notify(e.message, "error"); }
    finally { setBusyId(null); }
  }

  async function insert(frame: FigmaFrame, dataUrl: string) {
    try {
      await onInsert(dataUrl, frame.name);
      notify(`“${frame.name}” placed on the canvas`, "success");
    } catch (e: any) { notify(e?.message ?? "Could not place the frame", "error"); }
  }

  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 14 }}>
        <span className="meta">Page</span>
        <select className="lang-select" value={page?.id ?? ""} onChange={(e) => { setPageId(e.target.value); setPreview(null); }}>
          {file.pages.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.frames.length})</option>)}
        </select>
        <div className="spacer" />
        {file.lastModified && <span className="meta">updated {new Date(file.lastModified).toLocaleDateString()}</span>}
      </div>

      {!canInsert && editable && (
        <div className="meta" style={{ marginTop: 10 }}>Open the Canvas tab to place a frame on the board.</div>
      )}

      {page && page.frames.length === 0 && (
        <div className="meta" style={{ marginTop: 14 }}>This page has no top-level frames.</div>
      )}

      <div style={{ marginTop: 12, maxHeight: 280, overflowY: "auto" }}>
        {page?.frames.map((f) => (
          <div key={f.id} className="shortcut-row">
            <span>
              {f.name}{" "}
              <span className="meta">
                {f.type.toLowerCase()}{f.width && f.height ? ` · ${f.width}×${f.height}` : ""}
              </span>
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => render(f)} disabled={busyId === f.id}>
              {busyId === f.id ? "Rendering…" : "Preview"}
            </button>
          </div>
        ))}
      </div>

      {preview && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span className="meta">{preview.frame.name}</span>
            <div className="row" style={{ gap: 8 }}>
              {canInsert && editable && (
                <button className="btn btn-primary btn-sm" onClick={() => insert(preview.frame, preview.dataUrl)}>
                  Place on canvas
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => setPreview(null)}>Dismiss</button>
            </div>
          </div>
          <img src={preview.dataUrl} alt={preview.frame.name}
            style={{ maxWidth: "100%", maxHeight: 240, display: "block", margin: "0 auto", borderRadius: "var(--r-sm)", border: "1px solid var(--border)" }} />
        </div>
      )}
    </>
  );
}
