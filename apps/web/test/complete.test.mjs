/** AI inline completion path: emitting ai:complete must be handled gracefully.
 *  Without ANTHROPIC_API_KEY the server simply does not answer (client would time
 *  out → no ghost text). With a key it replies ai:completion with insertion text.
 *  Either way the server must never crash. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const post = async (p, b, t) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
};

async function main() {
  const reg = await post("/api/auth/register", { email: `cmpl${uid}@yumi.dev`, password: "password123", displayName: "Cmpl" });
  const t = reg.accessToken;
  const ws = await post("/api/workspaces", { name: "C" }, t);
  const pr = await post("/api/projects", { workspaceId: ws.workspace._id, name: "C", type: "code" }, t);
  const projectId = pr.project._id;

  const socket = io(B, { auth: { token: t } });
  await new Promise((res) => socket.on("connect", res));
  socket.emit("join", { projectId });
  await new Promise((res) => socket.on("joined", res));

  const id = "cmpl-1";
  const reply = await new Promise((res) => {
    let settled = false;
    socket.on("ai:completion", (d) => { if (d.id === id && !settled) { settled = true; res(d); } });
    socket.emit("ai:complete", { id, prefix: "function add(a, b) {\n  return ", suffix: "\n}", language: "javascript" });
    setTimeout(() => { if (!settled) { settled = true; res(null); } }, 6000);
  });

  if (reply) {
    console.log("ai:completion text:", JSON.stringify(String(reply.text).slice(0, 80)));
    console.log("✅ PASS: completion round-trip returned (API key configured)");
  } else {
    console.log("no completion within timeout (expected when no API key — client shows no ghost text)");
    console.log("✅ PASS: graceful — no crash, no phantom suggestion");
  }
  const health = await fetch(`${B}/api/health`).then((r) => r.status);
  console.log("server health:", health, health === 200 ? "✅" : "❌");
  socket.close();
  process.exit(health === 200 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
