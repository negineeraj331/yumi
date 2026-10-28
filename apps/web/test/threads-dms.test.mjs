/** Threads + DMs:
 *  Two users share a workspace. A posts a root message; B replies in-thread.
 *  The channel list shows the root with replyCount=1 (reply hidden from top level),
 *  the thread endpoint returns root + reply, and a DM from A routes to B live and
 *  persists to the DM history + conversation list. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const req = async (m, p, b, t) => {
  const r = await fetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait for a chat:message matching a predicate (ignores unrelated room broadcasts). */
function waitMsg(s, pred, ms = 3000) {
  return new Promise((res) => {
    const on = (m) => { if (pred(m)) { s.off("chat:message", on); res(m); } };
    s.on("chat:message", on);
    setTimeout(() => { s.off("chat:message", on); res(null); }, ms);
  });
}
function connect(token) {
  return new Promise((resolve) => {
    const s = io(B, { auth: { token } });
    s.on("connect", () => resolve(s));
  });
}

async function main() {
  let pass = true;
  const ok = (cond, label) => { console.log(cond ? `✅ PASS: ${label}` : `❌ FAIL: ${label}`); if (!cond) pass = false; };

  // Two users, one shared workspace (A owns, B joins via invite).
  const A = await req("POST", "/api/auth/register", { email: `thA${uid}@yumi.dev`, password: "password123", displayName: "Ann" });
  const Bu = await req("POST", "/api/auth/register", { email: `thB${uid}@yumi.dev`, password: "password123", displayName: "Bob" });
  const ws = await req("POST", "/api/workspaces", { name: "Threads" }, A.accessToken);
  const wsId = ws.workspace._id;
  const pr = await req("POST", "/api/projects", { workspaceId: wsId, name: "T", type: "code" }, A.accessToken);
  const projectId = pr.project._id;
  const inv = await req("POST", "/api/invites", { workspaceId: wsId, scope: "editor" }, A.accessToken);
  await req("POST", `/api/invites/${inv.token}/accept`, {}, Bu.accessToken);

  const sa = await connect(A.accessToken);
  const sb = await connect(Bu.accessToken);
  const joined = (s) => new Promise((res) => { s.emit("join", { projectId }); s.on("joined", res); });
  await joined(sa); await joined(sb);

  // ---- Threads ----
  const rootP = waitMsg(sa, (m) => m.body.startsWith("Root question"));
  sa.emit("chat:message", { projectId, body: "Root question about the parser" });
  const rootMsg = await rootP;
  const rootId = rootMsg.id;
  ok(!!rootId && !rootMsg.threadId, "root message posted (no threadId)");

  // B replies within the thread.
  const replyP = waitMsg(sb, (m) => m.body.startsWith("Reply:"));
  sb.emit("chat:message", { projectId, body: "Reply: try a Pratt parser", threadId: rootId });
  const reply = await replyP;
  ok(reply && reply.threadId === rootId, `reply carries threadId of root (got ${JSON.stringify(reply?.threadId)} want ${rootId})`);

  await wait(300);
  // Channel list: root present with replyCount 1; the reply is NOT top-level.
  const { messages } = await req("GET", `/api/messages/${projectId}`, null, A.accessToken);
  const rootRow = messages.find((m) => String(m._id) === rootId);
  ok(rootRow && rootRow.replyCount === 1, "channel list shows root with replyCount=1");
  ok(!messages.some((m) => m.body.startsWith("Reply:")), "reply hidden from top-level channel view");

  // Thread endpoint returns root + reply.
  const thread = await req("GET", `/api/messages/${projectId}/thread/${rootId}`, null, Bu.accessToken);
  ok(thread.root && thread.replies.length === 1 && thread.replies[0].body.startsWith("Reply:"), "thread endpoint returns root + 1 reply");

  // ---- DMs ----
  const dmRecv = new Promise((res) => sb.once("dm:message", res));
  sa.emit("dm:message", { toUserId: Bu.user.id, body: "Hey Bob, DM here" });
  const got = await Promise.race([dmRecv, wait(3000).then(() => null)]);
  ok(got && got.body === "Hey Bob, DM here", "DM routed live to recipient's personal room");

  await wait(200);
  const hist = await req("GET", `/api/messages/dm/${Bu.user.id}`, null, A.accessToken);
  ok(hist.messages.length >= 1 && hist.messages.at(-1).body === "Hey Bob, DM here", "DM persisted to history");

  const list = await req("GET", `/api/messages/dm`, null, Bu.accessToken);
  ok(list.conversations.some((c) => c.userId === A.user.id && c.displayName === "Ann"), "DM conversation list shows the partner");

  // Guard: DM to a stranger (no shared workspace) must be rejected.
  const C = await req("POST", "/api/auth/register", { email: `thC${uid}@yumi.dev`, password: "password123", displayName: "Cara" });
  const strangerHist = await fetch(`${B}/api/messages/dm/${C.user.id}`, { headers: { Authorization: `Bearer ${A.accessToken}` } });
  ok(strangerHist.status === 403, "DM history to non-shared user is 403");

  sa.close(); sb.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
