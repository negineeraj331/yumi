/** Verify the shared code runner: JS and Python execute in the sandbox and
 *  stream real output back to the room. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const post = async (p, b, t) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};

function runOnce(socket, projectId, language, code) {
  return new Promise((resolve) => {
    const onDone = (r) => { socket.off("run:done", onDone); resolve(r); };
    socket.on("run:done", onDone);
    socket.emit("run:start", { language, code, fileName: `main.${language}` });
  });
}

async function main() {
  const reg = await post("/api/auth/register", { email: `run${uid}@yumi.dev`, password: "password123", displayName: "Runner" });
  const t = reg.accessToken;
  const ws = await post("/api/workspaces", { name: "Run" }, t);
  const pr = await post("/api/projects", { workspaceId: ws.workspace._id, name: "Run", type: "code" }, t);
  const projectId = pr.project._id;

  const socket = io(B, { auth: { token: t } });
  await new Promise((res) => socket.on("connect", res));
  socket.emit("join", { projectId });
  await new Promise((res) => socket.on("joined", res));

  console.log("Running JavaScript…");
  const js = await runOnce(socket, projectId, "javascript", "console.log('hello from JS', 2+3)");
  console.log("  stdout:", JSON.stringify(js.stdout), "ok:", js.ok);

  console.log("Running Python…");
  const py = await runOnce(socket, projectId, "python", "print('hello from Py', 6*7)");
  console.log("  stdout:", JSON.stringify(py.stdout), "ok:", py.ok);

  console.log("Running failing code (expect nonzero exit)…");
  const bad = await runOnce(socket, projectId, "javascript", "throw new Error('boom')");
  console.log("  stderr has 'boom':", /boom/.test(bad.stderr), "ok:", bad.ok);

  const pass =
    js.ok && js.stdout.includes("hello from JS 5") &&
    py.ok && py.stdout.includes("hello from Py 42") &&
    !bad.ok && /boom/.test(bad.stderr);
  console.log(pass ? "\n✅ PASS: sandbox runs JS + Python and reports errors" : "\n❌ FAIL");
  socket.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("test error:", e); process.exit(1); });
