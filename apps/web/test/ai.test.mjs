/** AI path: without ANTHROPIC_API_KEY the server returns a graceful ai:done error
 *  (and never crashes). With a key set, it streams a real answer. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const post = async (p, b, t) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
};

async function main() {
  const reg = await post("/api/auth/register", { email: `ai${uid}@yumi.dev`, password: "password123", displayName: "AItest" });
  const t = reg.accessToken;
  const ws = await post("/api/workspaces", { name: "AI" }, t);
  const pr = await post("/api/projects", { workspaceId: ws.workspace._id, name: "AI", type: "code" }, t);
  const projectId = pr.project._id;

  const socket = io(B, { auth: { token: t } });
  await new Promise((res) => socket.on("connect", res));
  socket.emit("join", { projectId });
  await new Promise((res) => socket.on("joined", res));

  let chunks = "";
  socket.on("ai:chunk", ({ delta }) => { chunks += delta; });
  const done = await new Promise((res) => {
    socket.on("ai:done", res);
    socket.emit("ai:ask", { history: [{ role: "user", text: "Say hello in one short sentence." }], codeContext: "" });
  });

  if (done.error) {
    console.log("ai:done error (expected when no key):", done.error);
    console.log(/not configured/i.test(done.error) ? "✅ PASS: graceful degradation without API key" : "⚠️ error but not the expected message");
  } else {
    console.log("streamed answer:", JSON.stringify(chunks.slice(0, 120)));
    console.log(chunks.length > 0 ? "✅ PASS: AI streamed a real answer" : "❌ FAIL: no content");
  }
  // Server must still be alive
  const health = await fetch(`${B}/api/health`).then((r) => r.status);
  console.log("server health:", health, health === 200 ? "✅" : "❌");
  socket.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
