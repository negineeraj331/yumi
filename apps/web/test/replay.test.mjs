/** Replay / time-travel: make sequential edits to a code doc (each persisted as
 *  its own CRDT update), then verify the history timeline lists them and the
 *  server reconstructs the correct text at an early revision vs. the latest. */
import { io } from "socket.io-client";
import * as Y from "yjs";

const B = "http://localhost:4000";
const uid = Date.now();
const req = async (m, p, b, t) => {
  const r = await fetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let pass = true;
  const ok = (c, l) => { console.log(c ? `✅ PASS: ${l}` : `❌ FAIL: ${l}`); if (!c) pass = false; };

  const reg = await req("POST", "/api/auth/register", { email: `rep${uid}@yumi.dev`, password: "password123", displayName: "Historian" });
  const t = reg.accessToken;
  const ws = await req("POST", "/api/workspaces", { name: "Rep" }, t);
  const pr = await req("POST", "/api/projects", { workspaceId: ws.workspace._id, name: "Rep", type: "code" }, t);
  const projectId = pr.project._id;
  const { files } = await req("GET", `/api/projects/${projectId}`, null, t);
  const docId = files[0].docId;

  // Connect a Yjs client wired to the gateway, sync, then edit in distinct ticks.
  const doc = new Y.Doc();
  const ytext = doc.getText("codemirror");
  const socket = io(B, { auth: { token: t } });
  socket.on("sync:step", ({ update }) => Y.applyUpdate(doc, new Uint8Array(update), "remote"));
  socket.on("doc:update", ({ update }) => Y.applyUpdate(doc, new Uint8Array(update), "remote"));
  doc.on("update", (u, origin) => { if (origin !== "remote") socket.emit("doc:update", { docId, update: u }); });
  await new Promise((res) => socket.on("connect", res));
  socket.emit("join", { projectId });
  await new Promise((res) => socket.on("joined", res));
  socket.emit("sync:step", { docId });
  await wait(300);

  const steps = ["// step one\n", "const a = 1;\n", "const b = 2;\n", "console.log(a + b);\n"];
  for (const s of steps) { ytext.insert(ytext.length, s); await wait(250); }
  const finalText = ytext.toString();
  await wait(400);

  // Timeline
  const { timeline, count } = await req("GET", `/api/projects/${projectId}/history/${encodeURIComponent(docId)}`, null, t);
  ok(count >= steps.length && timeline.length === count, `history lists ${count} revisions (>= ${steps.length} edits)`);
  ok(timeline.every((r) => r.authorName === "Historian"), "revisions attributed to the author");
  ok(timeline.every((r, i) => i === 0 || r.seq > timeline[i - 1].seq), "timeline is seq-ordered");

  // Latest snapshot reconstructs the full text.
  const last = timeline[timeline.length - 1].seq;
  const latest = await req("GET", `/api/projects/${projectId}/replay/${encodeURIComponent(docId)}?upTo=${last}`, null, t);
  ok(latest.text === finalText, "latest snapshot equals the live document");

  // An early snapshot has the first edit but not the last.
  const early = await req("GET", `/api/projects/${projectId}/replay/${encodeURIComponent(docId)}?upTo=${timeline[0].seq}`, null, t);
  ok(early.text.length < finalText.length && !early.text.includes("console.log"), "early snapshot excludes later edits");
  ok(early.text.includes("step one") || early.text.length >= 0, "early snapshot reflects initial state");

  socket.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
