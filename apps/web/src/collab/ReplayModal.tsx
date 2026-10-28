/**
 * ReplayModal — time-travel viewer for a code document. Loads the append-only
 * revision timeline and lets you scrub to any point; the server reconstructs the
 * document's text as of that revision. Read-only.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface Rev { seq: number; ts: string; authorName: string; authorColor: string }

export function ReplayModal({ projectId, docId, fileName, onClose }: {
  projectId: string; docId: string; fileName: string; onClose: () => void;
}) {
  const [timeline, setTimeline] = useState<Rev[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.getDocHistory(projectId, docId)
      .then(({ timeline }) => { setTimeline(timeline); setIdx(timeline.length ? timeline.length - 1 : 0); })
      .catch((e) => setError(String(e.message ?? e)));
  }, [projectId, docId]);

  // Fetch the snapshot for the selected revision (debounced while scrubbing).
  useEffect(() => {
    if (!timeline || timeline.length === 0) return;
    const rev = timeline[idx];
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      setLoading(true);
      api.getDocReplay(projectId, docId, rev.seq)
        .then(({ text }) => setText(text))
        .catch((e) => setError(String(e.message ?? e)))
        .finally(() => setLoading(false));
    }, 120);
    return () => window.clearTimeout(debounce.current);
  }, [timeline, idx, projectId, docId]);

  const cur = timeline?.[idx];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal replay-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>⏱ Replay · {fileName}</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>

        {error && <div className="meta" style={{ color: "var(--danger, #C0392B)" }}>{error}</div>}
        {!timeline && !error && <div className="meta">Loading history…</div>}

        {timeline && timeline.length === 0 && (
          <div className="meta" style={{ marginTop: 12 }}>No edit history recorded for this file yet.</div>
        )}

        {timeline && timeline.length > 0 && (
          <>
            <div className="replay-scrub">
              <input type="range" min={0} max={timeline.length - 1} value={idx}
                onChange={(e) => setIdx(Number(e.target.value))} style={{ flex: 1 }} />
              <span className="meta" style={{ whiteSpace: "nowrap" }}>
                {idx + 1} / {timeline.length}
              </span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
              <button className="btn btn-secondary btn-sm" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>‹ Prev</button>
              <button className="btn btn-secondary btn-sm" disabled={idx === timeline.length - 1} onClick={() => setIdx((i) => Math.min(timeline.length - 1, i + 1))}>Next ›</button>
              {cur && (
                <span className="meta">
                  <span className="who" style={{ color: cur.authorColor }}>{cur.authorName}</span>
                  {" · "}{new Date(cur.ts).toLocaleString()}
                </span>
              )}
              {loading && <span className="meta">loading…</span>}
            </div>
            <pre className="replay-code">{text}</pre>
          </>
        )}
      </div>
    </div>
  );
}
