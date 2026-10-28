/** Chat reactions + search: send a message, toggle a reaction (add then remove),
 *  and verify text search returns it. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const req = async (m, p, b, t) => {
  const r = await fetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const reg = await req("POST", "/api/auth/register", { email: `chat${uid}@yumi.dev`, password: "password123", displayName: "Chatter" });
  const t = reg.accessToken, myId = reg.user.id;
  const ws = await req("POST", "/api/workspaces", { name: "Chat" }, t);
  const pr = await req("POST", "/api/projects", { workspaceId: ws.workspace._id, name: "Chat", type: "code" }, t);
  const projectId = pr.project._id;

  const s = io(B, { auth: { token: t } });
  await new Promise((r) => s.on("connect", r));
  s.emit("join", { projectId });
  await new Promise((r) => s.on("joined", r));

  const msg = await new Promise((res) => { s.on("chat:message", res); s.emit("chat:message", { projectId, body: "hello @Chatter reactive world" }); });
  console.log("message id:", msg.id);

  const add = await new Promise((res) => { s.on("chat:reaction", res); s.emit("chat:reaction", { messageId: msg.id, emoji: "👍" }); });
  const added = add.reactions?.[0]?.emoji === "👍" && add.reactions[0].userIds.includes(myId);
  console.log("after add:", JSON.stringify(add.reactions), added ? "✅" : "❌");

  const rem = await new Promise((res) => { const h = (r) => { s.off("chat:reaction", h); res(r); }; s.on("chat:reaction", h); s.emit("chat:reaction", { messageId: msg.id, emoji: "👍" }); });
  const removed = (rem.reactions?.length ?? 0) === 0;
  console.log("after toggle-off:", JSON.stringify(rem.reactions), removed ? "✅" : "❌");

  const { messages } = await req("GET", `/api/messages/${projectId}?q=reactive`, null, t);
  const found = messages.some((m) => m.body.includes("reactive"));
  console.log("search 'reactive':", found ? "✅ found" : "❌ not found");

  console.log(added && removed && found ? "\n✅ PASS: reactions toggle + search work" : "\n❌ FAIL");
  s.close();
  process.exit(added && removed && found ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
