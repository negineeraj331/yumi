/** Resilience: send malformed/empty doc:update frames — server must NOT crash,
 *  and must keep serving requests afterward. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const post = async (p, b, t) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const reg = await post("/api/auth/register", { email: `bad${uid}@yumi.dev`, password: "password123", displayName: "Chaos" });
  const t = reg.accessToken;
  const ws = await post("/api/workspaces", { name: "Bad" }, t);
  const pr = await post("/api/projects", { workspaceId: ws.workspace._id, name: "Bad", type: "code" }, t);
  const projectId = pr.project._id;

  const socket = io(B, { auth: { token: t } });
  await new Promise((res) => socket.on("connect", res));
  socket.emit("join", { projectId });
  await wait(300);

  // Fire garbage at the CRDT handler
  socket.emit("doc:update", { docId: "file:garbage", update: new Uint8Array([]) });           // empty
  socket.emit("doc:update", { docId: "file:garbage", update: new Uint8Array([255, 254, 1]) }); // malformed
  socket.emit("doc:update", { docId: "file:garbage", update: null });                          // null
  socket.emit("sync:step", { docId: "file:garbage" });
  await wait(600);

  // Server should still be alive and answering
  const health = await fetch(`${B}/api/health`).then((r) => r.status).catch(() => 0);
  console.log("health after bad frames:", health);
  const stillWorks = health === 200;
  const reg2 = await post("/api/auth/register", { email: `bad2${uid}@yumi.dev`, password: "password123", displayName: "OK" }).then(() => true).catch(() => false);
  console.log(stillWorks && reg2 ? "✅ PASS: server survived bad frames + still registers" : "❌ FAIL: server affected");
  socket.close();
  process.exit(stillWorks && reg2 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
