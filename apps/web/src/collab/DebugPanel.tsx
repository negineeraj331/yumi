/**
 * DebugPanel — the shared debugger's controls and state.
 *
 * There is one debug session per project, so what this shows is the same for
 * everyone in the room: the same paused line, stack, and locals. Editors drive;
 * viewers watch. Expression results are the asking user's alone (they're a
 * question, not a state change), so they render in a local scratch list.
 */
import { useState } from "react";
import type { DebugState } from "@yumi/shared";

export function DebugPanel({ state, editable, canDebug, busy, onStart, onCommand, onStop, evaluations, onEvaluate }: {
  state: DebugState | null;
  editable: boolean;
  canDebug: boolean;
  busy: boolean;
  onStart: () => void;
  onCommand: (cmd: string) => void;
  onStop: () => void;
  evaluations: { expression: string; value: string }[];
  onEvaluate: (expr: string) => void;
}) {
  const [expr, setExpr] = useState("");
  const live = !!state && state.status !== "exited";
  const paused = state?.status === "paused";

  if (!canDebug) {
    return (
      <div className="debug-panel">
        <div className="meta">
          Debugging supports Python and JavaScript. Open a <code>.py</code> or <code>.js</code> file
          to step through it together.
        </div>
      </div>
    );
  }

  return (
    <div className="debug-panel">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {!live ? (
          <button className="btn btn-primary btn-sm" onClick={onStart} disabled={!editable || busy}>
            {busy ? "Starting…" : "🐞 Start debugging"}
          </button>
        ) : (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => onCommand("continue")} disabled={!editable || !paused} title="Continue (run to next breakpoint)">▶</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onCommand("next")} disabled={!editable || !paused} title="Step over">⤼</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onCommand("step")} disabled={!editable || !paused} title="Step into">⤓</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onCommand("out")} disabled={!editable || !paused} title="Step out of this frame">⤒</button>
            <button className="btn btn-secondary btn-sm" onClick={onStop} disabled={!editable} title="Stop debugging">■</button>
          </>
        )}
      </div>

      {!state && (
        <div className="meta" style={{ marginTop: 12 }}>
          Click the gutter to set breakpoints, then start. Everyone in the session sees the same
          stepping, stack and variables.
        </div>
      )}

      {state && (
        <>
          <div className="meta" style={{ marginTop: 12 }}>
            {state.status === "exited"
              ? (state.exitMessage ?? "Session ended")
              : state.status === "paused"
                ? <>paused at <span className="mono">{state.file}:{state.line}</span></>
                : state.status}
          </div>
          {state.source && state.status === "paused" && (
            <div className="mono debug-source">{state.line}  {state.source}</div>
          )}

          {state.stack.length > 0 && (
            <>
              <div className="meta debug-heading">Call stack</div>
              <div className="debug-stack">
                {state.stack.map((f, i) => (
                  <div key={i} className={`mono debug-frame ${i === 0 ? "top" : ""}`}>
                    {f.func} <span className="meta">{f.file}:{f.line}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {state.locals && (
            <>
              <div className="meta debug-heading">Locals</div>
              <pre className="mono debug-locals">{state.locals}</pre>
            </>
          )}

          {editable && state.status !== "exited" && (
            <form
              className="row" style={{ gap: 6, marginTop: 10 }}
              onSubmit={(e) => { e.preventDefault(); if (expr.trim()) { onEvaluate(expr.trim()); setExpr(""); } }}
            >
              <input className="input mono" placeholder="evaluate an expression…" value={expr}
                onChange={(e) => setExpr(e.target.value)} disabled={!paused} />
              <button className="btn btn-secondary btn-sm" disabled={!paused || !expr.trim()}>=</button>
            </form>
          )}

          {evaluations.length > 0 && (
            <div className="debug-evals mono">
              {evaluations.slice(-6).map((e, i) => (
                <div key={i}><span className="meta">{e.expression} =</span> {e.value}</div>
              ))}
            </div>
          )}

          {state.output && (
            <>
              <div className="meta debug-heading">Program output</div>
              <pre className="mono debug-locals">{state.output}</pre>
            </>
          )}
        </>
      )}
    </div>
  );
}
