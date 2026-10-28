/** Canvas convergence: two clients on canvas:<projectId> — a shape drawn by one
 *  must appear on the other, and persist for a late joiner. */
import { io } from "socket.io-client";
import * as Y from "yjs";

const B = "http://localhost:4000";
const uid = Date.now();
const post = async (p, b, t) => {
  const r = await fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(token, projectId, docId) {
  return new Promise((resolve) => {
    const socket = io(B, { auth: { token } });
    const doc = new Y.Doc();
    socket.on("connect", () => socket.emit("join", { projectId }));
    socket.on("joined", () => socket.emit("sync:step", { docId }));
    socket.on("sync:step", ({ update }) => Y.applyUpdate(doc, new Uint8Array(update), "remote"));
    socket.on("doc:update", ({ update }) => Y.applyUpdate(doc, new Uint8Array(update), "remote"));
    doc.on("update", (u, origin) => { if (origin !== "remote") socket.emit("doc:update", { docId, update: u }); });
    setTimeout(() => resolve({ socket, doc, shapes: doc.getArray("shapes") }), 500);
  });
}

async function main() {
  const reg = await post("/api/auth/register", { email: `canv${uid}@yumi.dev`, password: "password123", displayName: "Designer" });
  const t = reg.accessToken;
  const ws = await post("/api/workspaces", { name: "Canv" }, t);
  const pr = await post("/api/projects", { workspaceId: ws.workspace._id, name: "Board", type: "canvas" }, t);
  const projectId = pr.project._id;
  const docId = `canvas:${projectId}`;

  const a = await client(t, projectId, docId);
  const b = await client(t, projectId, docId);
  await wait(400);

  // Client A draws a pen stroke (Y.Map with nested Y.Array of points)
  const m = new Y.Map();
  m.set("type", "pen"); m.set("color", "#C4622D"); m.set("size", 3);
  const pts = new Y.Array(); pts.push([10, 10, 20, 30, 40, 50]); m.set("pts", pts);
  a.shapes.push([m]);

  // Client B draws a rectangle
  const r = new Y.Map();
  r.set("type", "rect"); r.set("color", "#2F5FE0"); r.set("size", 2);
  r.set("x", 100); r.set("y", 100); r.set("w", 80); r.set("h", 40);
  b.shapes.push([r]);

  // Client A draws a dashed arrow (new annotation style)
  const arr = new Y.Map();
  arr.set("type", "arrow"); arr.set("color", "#C6317E"); arr.set("size", 3); arr.set("dash", true);
  arr.set("x", 0); arr.set("y", 0); arr.set("w", 120); arr.set("h", 60);
  a.shapes.push([arr]);
  await wait(700);

  const bothSeeThree = a.shapes.length === 3 && b.shapes.length === 3;
  console.log(`A sees ${a.shapes.length} shapes, B sees ${b.shapes.length}`);
  console.log(bothSeeThree ? "✅ PASS: canvas shapes converged" : "❌ FAIL: canvas divergence");

  const c = await client(t, projectId, docId);
  await wait(600);
  const arrowShape = c.shapes.toArray().find((s) => s.get("type") === "arrow");
  const persisted = c.shapes.length === 3 && !!arrowShape && arrowShape.get("dash") === true;
  console.log(persisted ? "✅ PASS: canvas persisted (incl. dashed arrow) for late joiner" : "❌ FAIL: canvas persistence");

  a.socket.close(); b.socket.close(); c.socket.close();
  process.exit(bothSeeThree && persisted ? 0 : 1);
}
main().catch((e) => { console.error("test error:", e); process.exit(1); });
