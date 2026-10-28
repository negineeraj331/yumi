/** Multi-language run test: exercises whichever runtimes are pulled. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const post = async (p, b, t) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SNIPPETS = {
  java: 'public class Main { public static void main(String[] a){ System.out.println("java " + (6*7)); } }',
  go: 'package main\nimport "fmt"\nfunc main(){ fmt.Println("go", 6*7) }',
  cpp: '#include <iostream>\nint main(){ std::cout << "cpp " << 6*7 << std::endl; }',
  rust: 'fn main(){ println!("rust {}", 6*7); }',
};

function runOnce(socket, language, code) {
  return new Promise((resolve) => {
    const onDone = (r) => { socket.off("run:done", onDone); resolve(r); };
    socket.on("run:done", onDone);
    socket.emit("run:start", { language, code, fileName: `main.${language}` });
  });
}

async function main() {
  const reg = await post("/api/auth/register", { email: `langs${uid}@yumi.dev`, password: "password123", displayName: "Langs" });
  const t = reg.accessToken;
  const ws = await post("/api/workspaces", { name: "L" }, t);
  const pr = await post("/api/projects", { workspaceId: ws.workspace._id, name: "L", type: "code" }, t);
  const projectId = pr.project._id;

  const socket = io(B, { auth: { token: t } });
  await new Promise((res) => socket.on("connect", res));
  socket.emit("join", { projectId });
  await new Promise((res) => socket.on("joined", res));

  for (const [lang, code] of Object.entries(SNIPPETS)) {
    process.stdout.write(`${lang.padEnd(5)}: `);
    const r = await runOnce(socket, lang, code);
    if (r.error && /still being prepared/.test(r.error)) console.log("⏳ image still downloading");
    else if (r.ok && (r.stdout || "").includes("42")) console.log(`✅ ${JSON.stringify(r.stdout.trim())}`);
    else console.log(`❌ ok=${r.ok} err=${r.error || ""} stderr=${(r.stderr||"").slice(0,80)}`);
    await wait(500);
  }
  socket.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
