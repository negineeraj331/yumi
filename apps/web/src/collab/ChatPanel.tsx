import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { SOCKET_EVENTS, type PublicUser } from "@yumi/shared";
import { api } from "../api";
import { encryptText, decryptText } from "./e2ee";
import { useToast } from "../toast";

interface Reaction { emoji: string; userIds: string[] }
interface Msg { id: string; body: string; authorName: string; authorColor: string; ts: string; reactions: Reaction[]; threadId?: string | null; replyCount?: number }
interface Presence { userId: string; displayName: string; avatarColor: string }
interface Convo { userId: string; displayName: string; avatarColor: string; lastBody: string; lastTs: string }

const EMOJIS = ["👍", "❤️", "🎉", "😄", "🚀", "👀", "✅"];

function renderBody(body: string) {
  return body.split(/(@[\w-]+)/g).map((part, i) =>
    part.startsWith("@") ? <span key={i} className="mention">{part}</span> : <span key={i}>{part}</span>
  );
}
const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Message bodies in an encrypted project arrive as ciphertext. A body that
 * cannot be opened is shown as such rather than as empty text — silence would
 * read as "they sent nothing", which is a different and wrong statement.
 */
async function openMsg(m: any, key: CryptoKey | null): Promise<Msg> {
  const base = normalize(m);
  if (!key) return base;
  const plain = await decryptText(key, base.body);
  return { ...base, body: plain ?? "🔒 could not be decrypted with this key" };
}

function normalize(m: any): Msg {
  return {
    id: m._id ?? m.id, body: m.body,
    authorName: m.authorId?.displayName ?? m.authorName ?? "?",
    authorColor: m.authorId?.avatarColor ?? m.authorColor ?? "#888",
    ts: m.ts,
    reactions: (m.reactions ?? []).map((r: any) => ({ emoji: r.emoji, userIds: (r.userIds ?? []).map(String) })),
    threadId: m.threadId ?? null,
    replyCount: m.replyCount ?? 0,
  };
}

export function ChatPanel({ socket, projectId, user, presence = [], cryptoKey = null }: {
  socket: Socket; projectId: string; user: PublicUser; presence?: Presence[];
  /** Present when the project is end-to-end encrypted. DMs are never encrypted:
   *  they belong to the people, not the project, and have no project key. */
  cryptoKey?: CryptoKey | null;
}) {
  const { notify } = useToast();
  const [mode, setMode] = useState<"channel" | "direct">("channel");

  // ---- Channel state ----
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Msg[] | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [thread, setThread] = useState<{ root: Msg; replies: Msg[] } | null>(null);
  const [threadDraft, setThreadDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  // Message ids already handled — makes the live handler idempotent so a message
  // can never render twice (e.g. a duplicate socket delivery, or history/live overlap).
  const seenIds = useRef<Set<string>>(new Set());

  // ---- Direct-message state ----
  const [convos, setConvos] = useState<Convo[]>([]);
  const [activeDm, setActiveDm] = useState<string | null>(null); // other user's id
  const [dmMsgs, setDmMsgs] = useState<Msg[]>([]);
  const [dmDraft, setDmDraft] = useState("");
  const dmEndRef = useRef<HTMLDivElement>(null);

  /** Seal an outgoing body when the project is encrypted; pass it through otherwise. */
  const sealed = useCallback(
    async (text: string) => (cryptoKey ? encryptText(cryptoKey, text) : text),
    [cryptoKey],
  );

  // Channel history + live wiring.
  useEffect(() => {
    api.getMessages(projectId).then(async ({ messages }) => {
      messages.forEach((m: any) => seenIds.current.add(m.id));
      setMessages(await Promise.all(messages.map((m: any) => openMsg(m, cryptoKey))));
    });
    const onMsg = async (m: any) => {
      // Idempotent: ignore a message id we've already processed.
      if (seenIds.current.has(m.id)) return;
      seenIds.current.add(m.id);
      const opened = await openMsg(m, cryptoKey);
      if (m.threadId) {
        // A reply: bump the parent's count; append if that thread is open.
        setMessages((prev) => prev.map((x) => (x.id === m.threadId ? { ...x, replyCount: (x.replyCount ?? 0) + 1 } : x)));
        setThread((prev) => (prev && prev.root.id === m.threadId ? { ...prev, replies: [...prev.replies, opened] } : prev));
      } else {
        setMessages((prev) => [...prev, opened]);
      }
      // Mentions are matched on the decrypted text — the server cannot see it.
      if (m.authorName !== user.displayName && new RegExp(`@${user.displayName}\\b`, "i").test(opened.body)) {
        notify(`${m.authorName} mentioned you`, "info");
      }
    };
    const onReaction = ({ messageId, reactions }: { messageId: string; reactions: Reaction[] }) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
      setThread((prev) => prev ? {
        root: prev.root.id === messageId ? { ...prev.root, reactions } : prev.root,
        replies: prev.replies.map((r) => (r.id === messageId ? { ...r, reactions } : r)),
      } : prev);
    };
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, onMsg);
    socket.on(SOCKET_EVENTS.CHAT_REACTION, onReaction);
    return () => { socket.off(SOCKET_EVENTS.CHAT_MESSAGE, onMsg); socket.off(SOCKET_EVENTS.CHAT_REACTION, onReaction); };
  }, [socket, projectId, user.displayName, cryptoKey]);

  // Direct-message live wiring (independent of channel).
  useEffect(() => {
    const onDm = (m: any) => {
      if (seenIds.current.has(m.id)) return;
      seenIds.current.add(m.id);
      const otherId = m.authorId === user.id ? m.toUserId : m.authorId;
      setConvos((prev) => {
        const rest = prev.filter((c) => c.userId !== otherId);
        const existing = prev.find((c) => c.userId === otherId);
        const name = m.authorId === user.id ? existing?.displayName ?? "" : m.authorName;
        const color = m.authorId === user.id ? existing?.avatarColor ?? "#888" : m.authorColor;
        return [{ userId: otherId, displayName: name, avatarColor: color, lastBody: m.body, lastTs: m.ts }, ...rest];
      });
      setActiveDm((cur) => {
        if (cur === otherId) setDmMsgs((prev) => [...prev, normalize(m)]);
        else if (m.authorId !== user.id) notify(`DM from ${m.authorName}`, "info");
        return cur;
      });
    };
    socket.on(SOCKET_EVENTS.DM_MESSAGE, onDm);
    return () => { socket.off(SOCKET_EVENTS.DM_MESSAGE, onDm); };
  }, [socket, user.id]);

  useEffect(() => { if (mode === "channel" && !results && !openThread) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, results, mode, openThread]);
  useEffect(() => { if (mode === "direct" && activeDm) dmEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [dmMsgs, mode, activeDm]);
  useEffect(() => { if (mode === "direct") api.getDmConversations().then(({ conversations }) => setConvos(conversations)); }, [mode]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    void sealed(draft.trim()).then((body) => socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, { projectId, body }));
    setDraft("");
  }
  function react(messageId: string, emoji: string) {
    socket.emit(SOCKET_EVENTS.CHAT_REACTION, { messageId, emoji });
    setPickerFor(null);
  }
  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) { setResults(null); return; }
    // The server refuses to search an encrypted project rather than returning
    // an empty result that would read as "no matches".
    try {
      const { messages } = await api.getMessages(projectId, query.trim());
      setResults(await Promise.all(messages.map((m: any) => openMsg(m, cryptoKey))));
    } catch (err: any) {
      setResults([]);
      notify(err.message ?? "Search failed", "error");
    }
  }
  async function openThreadView(rootId: string) {
    setOpenThread(rootId);
    setThread(null);
    const { root, replies } = await api.getThread(projectId, rootId);
    setThread({
      root: await openMsg(root, cryptoKey),
      replies: await Promise.all(replies.map((r: any) => openMsg(r, cryptoKey))),
    });
  }
  function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!threadDraft.trim() || !openThread) return;
    void sealed(threadDraft.trim()).then((body) => socket.emit(SOCKET_EVENTS.CHAT_MESSAGE, { projectId, body, threadId: openThread }));
    setThreadDraft("");
  }
  async function openDm(userId: string) {
    setActiveDm(userId);
    const { messages } = await api.getDmHistory(userId);
    setDmMsgs(messages.map(normalize));
  }
  function sendDm(e: React.FormEvent) {
    e.preventDefault();
    if (!dmDraft.trim() || !activeDm) return;
    socket.emit(SOCKET_EVENTS.DM_MESSAGE, { toUserId: activeDm, body: dmDraft.trim() });
    setDmDraft("");
  }

  const list = useMemo(() => results ?? messages, [results, messages]);
  // People to start a DM with: everyone currently present except me, minus existing convos.
  const dmCandidates = useMemo(() => {
    const known = new Set(convos.map((c) => c.userId));
    return presence.filter((p) => p.userId !== user.id && !known.has(p.userId));
  }, [presence, convos, user.id]);
  const activePartner = convos.find((c) => c.userId === activeDm)
    ?? presence.find((p) => p.userId === activeDm);

  function MsgRow({ m, canThread }: { m: Msg; canThread: boolean }) {
    return (
      <div className="msg" onMouseLeave={() => setPickerFor(null)}>
        <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
          <span className="who" style={{ color: m.authorColor }}>{m.authorName}</span>
          <span className="act-time">{time(m.ts)}</span>
          {!results && <button className="react-add" title="React" onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}>＋</button>}
        </div>
        <div className="body">{renderBody(m.body)}</div>
        {pickerFor === m.id && (
          <div className="react-picker">{EMOJIS.map((e) => <button key={e} onClick={() => react(m.id, e)}>{e}</button>)}</div>
        )}
        {m.reactions.length > 0 && (
          <div className="react-row">
            {m.reactions.map((r) => (
              <button key={r.emoji} className={`react-chip ${r.userIds.includes(user.id) ? "mine" : ""}`} onClick={() => react(m.id, r.emoji)}>{r.emoji} {r.userIds.length}</button>
            ))}
          </div>
        )}
        {canThread && !results && (
          <button className="thread-link" onClick={() => openThreadView(m.id)}>
            {m.replyCount ? `💬 ${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}` : "💬 Reply in thread"}
          </button>
        )}
      </div>
    );
  }

  // ---- Thread drawer ----
  if (mode === "channel" && openThread) {
    return (
      <div className="chat">
        <div className="chat-search" style={{ gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { setOpenThread(null); setThread(null); }}>← Back</button>
          <span className="meta">Thread</span>
        </div>
        <div className="chat-list">
          {!thread ? <div className="meta">Loading…</div> : (
            <>
              <MsgRow m={thread.root} canThread={false} />
              <div className="meta" style={{ margin: "6px 0" }}>{thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}</div>
              {thread.replies.map((r) => <div key={r.id} className="thread-reply"><MsgRow m={r} canThread={false} /></div>)}
            </>
          )}
          <div ref={endRef} />
        </div>
        <form className="chat-compose" onSubmit={sendReply}>
          <input className="input" placeholder="Reply…" value={threadDraft} onChange={(e) => setThreadDraft(e.target.value)} />
          <button className="btn btn-primary btn-sm">Reply</button>
        </form>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="pane-tabs" style={{ padding: "6px 10px" }}>
        <button className={`tab ${mode === "channel" ? "active" : ""}`} onClick={() => setMode("channel")}>Channel</button>
        <button className={`tab ${mode === "direct" ? "active" : ""}`} onClick={() => setMode("direct")}>Direct</button>
      </div>

      {mode === "channel" ? (
        <>
          <form className="chat-search" onSubmit={runSearch}>
            <input className="input" placeholder="Search messages…" value={query}
              onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setResults(null); }} />
            {results && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setQuery(""); setResults(null); }}>✕</button>}
          </form>
          <div className="chat-list">
            {results && <div className="meta" style={{ marginBottom: 4 }}>{list.length} result{list.length !== 1 ? "s" : ""}</div>}
            {list.map((m) => <MsgRow key={m.id} m={m} canThread={true} />)}
            <div ref={endRef} />
          </div>
          {!results && (
            <form className="chat-compose" onSubmit={send}>
              <input className="input" placeholder="Message… (@name to mention)" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button className="btn btn-primary btn-sm">Send</button>
            </form>
          )}
        </>
      ) : activeDm ? (
        <>
          <div className="chat-search" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setActiveDm(null)}>← Back</button>
            <span className="who" style={{ color: activePartner?.avatarColor }}>{activePartner?.displayName ?? "Direct message"}</span>
          </div>
          <div className="chat-list">
            {dmMsgs.length === 0 && <div className="meta">No messages yet — say hello.</div>}
            {dmMsgs.map((m) => (
              <div key={m.id} className="msg">
                <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
                  <span className="who" style={{ color: m.authorColor }}>{m.authorName}</span>
                  <span className="act-time">{time(m.ts)}</span>
                </div>
                <div className="body">{renderBody(m.body)}</div>
              </div>
            ))}
            <div ref={dmEndRef} />
          </div>
          <form className="chat-compose" onSubmit={sendDm}>
            <input className="input" placeholder={`Message ${activePartner?.displayName ?? ""}…`} value={dmDraft} onChange={(e) => setDmDraft(e.target.value)} />
            <button className="btn btn-primary btn-sm">Send</button>
          </form>
        </>
      ) : (
        <div className="chat-list">
          {convos.length === 0 && dmCandidates.length === 0 && <div className="meta">No one to message yet. When teammates join the session, start a DM here.</div>}
          {convos.map((c) => (
            <button key={c.userId} className="dm-convo" onClick={() => openDm(c.userId)}>
              <span className="who" style={{ color: c.avatarColor }}>{c.displayName}</span>
              <span className="body" style={{ opacity: 0.7 }}>{c.lastBody}</span>
            </button>
          ))}
          {dmCandidates.length > 0 && <div className="meta" style={{ margin: "8px 0 4px" }}>In this session</div>}
          {dmCandidates.map((p) => (
            <button key={p.userId} className="dm-convo" onClick={() => openDm(p.userId)}>
              <span className="who" style={{ color: p.avatarColor }}>{p.displayName}</span>
              <span className="body" style={{ opacity: 0.6 }}>Start a conversation</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
