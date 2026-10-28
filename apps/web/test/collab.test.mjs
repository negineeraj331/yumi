/**
 * Headless convergence test: two Socket.io + Yjs clients edit the same doc
 * concurrently and must converge to an identical document (CRDT guarantee).
 * Run with server + infra up:  node apps/server/test/collab.test.mjs
 */
import { io } from "socket.io-client";
import * as Y from "yjs";

const B = "http://localhost:4000";
const uid = Date.now();

async function post(path, body, token) {
  const res = await fetch(B + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function makeClient(token, projectId, docId) {
  return new Promise((resolve) => {
    const socket = io(B, { auth: { token } });
    const doc = new Y.Doc();
    const ytext = doc.getText("codemirror");

    socket.on("connect", () => socket.emit("join", { projectId }));
    socket.on("joined", () => socket.emit("sync:step", { docId }));

    socket.on("sync:step", ({ update }) => Y.applyUpdate(doc, new Uint8Array(update), "remote"));
    socket.on("doc:update", ({ update }) => Y.applyUpdate(doc, new Uint8Array(update), "remote"));

    doc.on("update", (update, origin) => {
      if (origin !== "remote") socket.emit("doc:update", { docId, update });
    });

    // give the join+sync a beat before returning the handle
    setTimeout(() => resolve({ socket, doc, ytext }), 500);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Owner registers, makes workspace + project (which seeds a file)
  const reg = await post("/api/auth/register", {
    email: `conv${uid}@yumi.dev`, password: "password123", displayName: "Owner",
  });
  const token = reg.accessToken;
  const ws = await post("/api/workspaces", { name: "Conv WS" }, token);
  const wsId = ws.workspace._id;
  const pr = await post("/api/projects", { workspaceId: wsId, name: "Conv", type: "code" }, token);
  const projectId = pr.project._id;

  const detail = await (await fetch(`${B}/api/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const docId = detail.files[0].docId;

  // Two clients (same user token is fine for a convergence test)
  const a = await makeClient(token, projectId, docId);
  const b = await makeClient(token, projectId, docId);
  await wait(400);

  // Concurrent edits at different positions
  a.ytext.insert(0, "function hello() {\n");
  b.ytext.insert(0, "// header comment\n");
  await wait(300);
  a.ytext.insert(a.ytext.length, "  return 42;\n}\n");
  b.ytext.insert(0, "'use strict';\n");
  await wait(800);

  const textA = a.ytext.toString();
  const textB = b.ytext.toString();

  console.log("---- client A ----\n" + textA);
  console.log("---- client B ----\n" + textB);

  const converged = textA === textB && textA.length > 0;
  console.log(converged ? "\n✅ PASS: documents converged (CRDT)" : "\n❌ FAIL: divergence");

  // Verify persistence: a fresh client should load the same content
  const c = await makeClient(token, projectId, docId);
  await wait(600);
  const persisted = c.ytext.toString() === textA;
  console.log(persisted ? "✅ PASS: persisted + late-join sync matches" : "❌ FAIL: persistence/late-join mismatch");

  a.socket.close(); b.socket.close(); c.socket.close();
  process.exit(converged && persisted ? 0 : 1);
}

main().catch((e) => { console.error("test error:", e); process.exit(1); });
