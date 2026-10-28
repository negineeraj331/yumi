/** Session lifecycle + activity feed + analytics:
 *  two clients join (session starts, activity emitted), both leave (session
 *  finalizes with analytics), then the workspace sessions endpoint reflects it. */
import { io } from "socket.io-client";

const B = "http://localhost:4000";
const uid = Date.now();
const req = async (m, p, b, t) => {
  const r = await fetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function join(token, projectId) {
  return new Promise((resolve) => {
    const s = io(B, { auth: { token } });
    const acts = [];
    s.on("activity", (a) => acts.push(a));
    s.on("connect", () => s.emit("join", { projectId }));
    s.on("joined", () => setTimeout(() => resolve({ s, acts }), 300));
  });
}

async function main() {
  const reg = await req("POST", "/api/auth/register", { email: `sess${uid}@yumi.dev`, password: "password123", displayName: "Host" });
  const t = reg.accessToken;
  const ws = await req("POST", "/api/workspaces", { name: "Sess" }, t);
  const wsId = ws.workspace._id;
  const pr = await req("POST", "/api/projects", { workspaceId: wsId, name: "Sess", type: "code" }, t);
  const projectId = pr.project._id;

  const a = await join(t, projectId);
  const b = await join(t, projectId);
  await wait(400);

  const aSaw = a.acts.some((x) => x.action === "joined") || b.acts.some((x) => x.action === "joined");
  console.log(aSaw ? "✅ PASS: activity 'joined' broadcast" : "❌ FAIL: no join activity");

  a.s.close(); b.s.close();
  await wait(1500); // allow finalize

  const { sessions } = await req("GET", `/api/workspaces/${wsId}/sessions`, null, t);
  const s0 = sessions[0];
  console.log("sessions:", sessions.length, "| participants:", s0?.participants?.length, "| metrics:", JSON.stringify(s0?.metrics));
  const ok = sessions.length >= 1 && s0.participants.length >= 1 && s0.metrics && typeof s0.metrics.durationSec === "number";
  console.log(ok ? "✅ PASS: session recorded with analytics" : "❌ FAIL: session/analytics missing");
  process.exit(ok && aSaw ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
