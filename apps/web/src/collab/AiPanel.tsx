import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { SOCKET_EVENTS } from "@yumi/shared";

interface Turn { role: "user" | "assistant"; text: string }

export function AiPanel({ socket, getCodeContext }: { socket: Socket; getCodeContext: () => string | undefined }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onChunk = ({ delta }: { delta: string }) =>
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") last.text += delta;
        return next;
      });
    const onDone = ({ error }: { error?: string }) => {
      setBusy(false);
      if (error) setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.text) last.text = `⚠️ ${error}`;
        return next;
      });
    };
    socket.on(SOCKET_EVENTS.AI_CHUNK, onChunk);
    socket.on(SOCKET_EVENTS.AI_DONE, onDone);
    return () => { socket.off(SOCKET_EVENTS.AI_CHUNK, onChunk); socket.off(SOCKET_EVENTS.AI_DONE, onDone); };
  }, [socket]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);

  function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    const history = [...turns, { role: "user" as const, text: draft.trim() }];
    setTurns([...history, { role: "assistant", text: "" }]);
    setDraft(""); setBusy(true);
    socket.emit(SOCKET_EVENTS.AI_ASK, { history, codeContext: getCodeContext() });
  }

  return (
    <div className="chat">
      <div className="chat-list">
        {turns.length === 0 && (
          <div style={{ color: "var(--ink-muted)", fontSize: 13, lineHeight: 1.5 }}>
            Ask the AI about your code — “explain this”, “find the bug”, “add error handling”.
            The current file is sent as context.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`ai-msg ai-${t.role}`}>
            <div className="meta" style={{ color: t.role === "user" ? "var(--accent-strong)" : "var(--ink-muted)" }}>
              {t.role === "user" ? "You" : "Yumi AI"}
            </div>
            <div className="ai-body">{t.text || (busy ? "…" : "")}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="chat-compose" onSubmit={ask}>
        <input className="input" placeholder={busy ? "Thinking…" : "Ask the AI…"} value={draft}
          onChange={(e) => setDraft(e.target.value)} disabled={busy} />
        <button className="btn btn-primary btn-sm" disabled={busy}>Ask</button>
      </form>
    </div>
  );
}
