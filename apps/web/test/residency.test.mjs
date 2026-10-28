/**
 * Data residency, end-to-end.
 *
 * Four servers are started against the SAME Mongo and Redis, which is exactly
 * the topology residency has to defend: one database, several regional
 * application tiers, every one of them physically able to read and write every
 * workspace. In that arrangement the app-level check is the only thing standing
 * between a promise about where data lives and a violation of it.
 *
 *   eu   :4101  REGION=eu
 *   us   :4102  REGION=us                       — the wrong door for an eu workspace
 *   none :4103  no REGION                       — cannot claim any region
 *   euX  :4104  REGION=eu + egress allowed      — same region, looser operator policy
 *
 * Run with Mongo + Redis up (pnpm infra:up):
 *   node apps/web/test/residency.test.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { io } from "socket.io-client";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");
const uid = Date.now();

let pass = 0, fail = 0;
const check = (ok, label, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ test servers ----------------------------- */

const REGION_URLS = {
  REGIONS: "eu,us",
  REGION_EU_LABEL: "EU (Frankfurt)",
  REGION_EU_URL: "http://localhost:4101",
  REGION_US_LABEL: "US (Virginia)",
  REGION_US_URL: "http://localhost:4102",
};

const procs = [];

async function startServer(name, port, env) {
  const child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      // Mesh, not SFU: four mediasoup workers would fight over one RTC port range.
      CALL_MODE: "mesh",
      ANTHROPIC_API_KEY: "",
      ...REGION_URLS,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  let log = "";
  child.stdout.on("data", (d) => { log += d.toString(); });
  child.stderr.on("data", (d) => { log += d.toString(); });

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited early:\n${log}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { name, base, log: () => log };
    } catch { /* not up yet */ }
    await wait(200);
  }
  throw new Error(`${name} did not become healthy:\n${log}`);
}

function stopServers() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
}

/* --------------------------------- client -------------------------------- */

/** Never throws on a non-2xx: the status IS the assertion in most checks here. */
async function call(base, method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

const ok = async (base, method, path, body, token) => {
  const r = await call(base, method, path, body, token);
  if (r.status >= 300) throw new Error(`${method} ${path} on ${base} → ${r.status} ${r.text}`);
  return r.body;
};

function joinSocket(base, token, projectId) {
  return new Promise((resolve) => {
    const s = io(base, { auth: { token }, forceNew: true, transports: ["websocket"] });
    const done = (result) => { s.close(); resolve(result); };
    s.on("joined", (d) => done({ joined: d }));
    s.on("error", (e) => done({ error: e }));
    s.on("connect", () => s.emit("join", { projectId }));
    s.on("connect_error", (e) => done({ connectError: e.message }));
    setTimeout(() => done({ timeout: true }), 6000);
  });
}

/* ---------------------------------- run ---------------------------------- */

async function main() {
  console.log("Starting four regional servers against one database…");
  const [eu, us, none, euX] = await Promise.all([
    startServer("eu", 4101, { REGION: "eu" }),
    startServer("us", 4102, { REGION: "us" }),
    startServer("none", 4103, { REGION: "" }),
    startServer("euX", 4104, { REGION: "eu", RESIDENCY_ALLOW_EGRESS: "github,figma,slack", AI_REGION: "eu" }),
  ]);

  check(/serving region "eu"/.test(eu.log()), "eu deployment reports its region at boot");
  check(/not configured \(REGION unset\)/.test(none.log()), "unconfigured deployment says residency is off");

  /* --- accounts (global: one database, so both tiers see the same users) --- */
  const owner = await ok(eu.base, "POST", "/api/auth/register", {
    email: `res${uid}@yumi.dev`, password: "password123", displayName: "Owner",
  });
  const outsider = await ok(eu.base, "POST", "/api/auth/register", {
    email: `out${uid}@yumi.dev`, password: "password123", displayName: "Outsider",
  });
  const T = owner.accessToken, TO = outsider.accessToken;

  /* ------------------------------ pinning -------------------------------- */
  const regions = await ok(eu.base, "GET", "/api/workspaces/regions", null, T);
  check(regions.region === "eu" && regions.regions.some((r) => r.id === "us"),
    "deployment advertises its region and the fleet", JSON.stringify(regions));

  const { workspace: ws } = await ok(eu.base, "POST", "/api/workspaces", { name: "Pinned" }, T);
  const wsId = ws._id;
  check(ws.settings?.dataResidencyRegion === "eu",
    "a workspace is pinned to the creating deployment's region", JSON.stringify(ws.settings));

  const wrongPin = await call(eu.base, "POST", "/api/workspaces", { name: "Nope", region: "us" }, T);
  check(wrongPin.status === 421 && wrongPin.body?.redirectTo === "http://localhost:4102",
    "creating a workspace in another region is refused, with that region's address",
    `${wrongPin.status} ${wrongPin.text}`);

  const rightPin = await call(eu.base, "POST", "/api/workspaces", { name: "Explicit eu", region: "eu" }, T);
  check(rightPin.status === 201, "naming this deployment's own region is accepted", String(rightPin.status));

  const badPin = await call(eu.base, "POST", "/api/workspaces", { name: "Bad", region: "Not A Region!" }, T);
  check(badPin.status === 400, "a malformed region id is rejected", String(badPin.status));

  /* ----------------------- serving from the wrong region ------------------ */
  const inRegion = await call(eu.base, "GET", `/api/workspaces/${wsId}`, null, T);
  check(inRegion.status === 200, "the pinned region serves the workspace", String(inRegion.status));

  const wrongRegion = await call(us.base, "GET", `/api/workspaces/${wsId}`, null, T);
  check(wrongRegion.status === 421 && wrongRegion.body?.code === "region_mismatch"
    && wrongRegion.body?.region === "eu" && wrongRegion.body?.servedBy === "us"
    && wrongRegion.body?.redirectTo === "http://localhost:4101",
    "another region refuses with 421 and points at the right one", wrongRegion.text);

  const unconfigured = await call(none.base, "GET", `/api/workspaces/${wsId}`, null, T);
  check(unconfigured.status === 421 && unconfigured.body?.servedBy === "unconfigured",
    "a deployment with no region declared refuses rather than failing open", unconfigured.text);

  const stranger = await call(us.base, "GET", `/api/workspaces/${wsId}`, null, TO);
  check(stranger.status === 403,
    "a non-member gets 403, not the region — the refusal is not an existence oracle", stranger.text);

  /* ------------------------- project + realtime paths -------------------- */
  const { project } = await ok(eu.base, "POST", "/api/projects",
    { workspaceId: wsId, name: "Res", type: "code" }, T);
  const pid = project._id;

  check((await call(eu.base, "GET", `/api/projects/${pid}`, null, T)).status === 200,
    "project reads work in region");
  check((await call(us.base, "GET", `/api/projects/${pid}`, null, T)).status === 421,
    "project reads are refused out of region");
  const wrongWrite = await call(us.base, "POST", `/api/projects/${pid}/files`,
    { path: "leak.js", language: "javascript" }, T);
  check(wrongWrite.status === 421, "a write is refused out of region", wrongWrite.text);
  check((await call(us.base, "GET", `/api/messages/${pid}`, null, T)).status === 421,
    "message history is refused out of region");

  const joinHere = await joinSocket(eu.base, T, pid);
  check(Boolean(joinHere.joined), "socket join succeeds in region", JSON.stringify(joinHere));
  const joinThere = await joinSocket(us.base, T, pid);
  check(joinThere.error?.code === "region_mismatch" && joinThere.error?.region === "eu",
    "socket join is refused out of region with the same payload", JSON.stringify(joinThere));

  /* -------------------------------- invites ------------------------------ */
  const { token: invite } = await ok(eu.base, "POST", "/api/invites",
    { workspaceId: wsId, scope: "editor" }, T);
  check((await call(us.base, "GET", `/api/invites/${invite}`)).status === 421,
    "an invite preview out of region does not even disclose the workspace name");
  check((await call(us.base, "POST", `/api/invites/${invite}/accept`, null, TO)).status === 421,
    "accepting an invite out of region is refused");
  const accepted = await call(eu.base, "POST", `/api/invites/${invite}/accept`, null, TO);
  check(accepted.status === 200, "accepting in region still works", accepted.text);

  /* --------------------------------- SCIM -------------------------------- */
  const { token: scimToken } = await ok(eu.base, "POST", `/api/workspaces/${wsId}/scim/token`,
    { defaultRole: "viewer" }, T);
  const scimHere = await call(eu.base, "GET", "/scim/v2/Users", null, scimToken);
  check(scimHere.status === 200, "directory sync works in region", scimHere.text);
  const scimThere = await call(us.base, "GET", "/scim/v2/Users", null, scimToken);
  check(scimThere.status === 421 && /EU \(Frankfurt\)/.test(scimThere.text),
    "directory sync is refused out of region, naming where to point the IdP", scimThere.text);

  /* -------------------------------- egress ------------------------------- */
  const ghBlocked = await call(eu.base, "GET", `/api/projects/${pid}/github`, null, T);
  check(ghBlocked.status === 409 && ghBlocked.body?.code === "residency_egress",
    "a third-party integration is refused in a pinned workspace", ghBlocked.text);
  check(/RESIDENCY_ALLOW_EGRESS/.test(ghBlocked.body?.error ?? ""),
    "the refusal names the setting that would enable it", ghBlocked.body?.error);

  const slackBlocked = await call(eu.base, "POST", `/api/projects/${pid}/slack`,
    { webhookUrl: "https://hooks.slack.com/services/T/B/x" }, T);
  check(slackBlocked.status === 409, "linking Slack is refused in a pinned workspace", slackBlocked.text);

  const ghAllowed = await call(euX.base, "GET", `/api/projects/${pid}/github`, null, T);
  check(ghAllowed.status === 200,
    "the same workspace allows it on a deployment whose operator enabled egress", ghAllowed.text);

  const status = await ok(eu.base, "GET", `/api/workspaces/${wsId}/residency`, null, T);
  check(status.residency.pinnedRegion === "eu" && status.residency.inRegion === true
    && status.residency.blockedEgress.length === 4 && status.residency.allowedEgress.length === 0,
    "residency status lists every feature that would leave the region", JSON.stringify(status.residency));

  const statusX = await ok(euX.base, "GET", `/api/workspaces/${wsId}/residency`, null, T);
  check(statusX.residency.blockedEgress.length === 0 && statusX.residency.allowedEgress.length === 4,
    "AI_REGION covers the assistant, and the allow-list covers the rest",
    JSON.stringify(statusX.residency));

  /* ------------------------- AI refusal ordering ------------------------- */
  // No ANTHROPIC_API_KEY is set for any of these servers, so this proves the
  // residency refusal is reached *before* the "configure a key" one — an
  // operator must not be sent to fix something that would not help.
  const aiAnswer = await new Promise((resolve) => {
    const s = io(eu.base, { auth: { token: T }, forceNew: true, transports: ["websocket"] });
    s.on("connect", () => s.emit("join", { projectId: pid }));
    s.on("joined", () => s.emit("ai:ask", { history: [{ role: "user", text: "hi" }] }));
    s.on("ai:done", (d) => { s.close(); resolve(d); });
    setTimeout(() => { s.close(); resolve({ timeout: true }); }, 6000);
  });
  check(/pinned to EU \(Frankfurt\)/.test(aiAnswer.error ?? ""),
    "the AI refuses on residency grounds before mentioning the API key", JSON.stringify(aiAnswer));

  /* --------------------------- unpinned workspaces ----------------------- */
  const { workspace: free } = await ok(none.base, "POST", "/api/workspaces", { name: "Unpinned" }, T);
  check(!free.settings?.dataResidencyRegion,
    "a deployment without a region pins nothing", JSON.stringify(free.settings));
  check((await call(eu.base, "GET", `/api/workspaces/${free._id}`, null, T)).status === 200
    && (await call(us.base, "GET", `/api/workspaces/${free._id}`, null, T)).status === 200,
    "an unpinned workspace is served by every region — existing data keeps working");
  const { project: freeProject } = await ok(eu.base, "POST", "/api/projects",
    { workspaceId: free._id, name: "Free", type: "code" }, T);
  check((await call(eu.base, "GET", `/api/projects/${freeProject._id}/github`, null, T)).status === 200,
    "and its integrations are not gated");

  /* ------------------------------ immutability --------------------------- */
  const moveAttempt = await call(eu.base, "PATCH", `/api/workspaces/${wsId}/settings`,
    { dataResidencyRegion: "us" }, T);
  check(moveAttempt.status === 409 && /cannot be changed/.test(moveAttempt.body?.error ?? ""),
    "the pin cannot be changed after creation", moveAttempt.text);
  const after = await ok(eu.base, "GET", `/api/workspaces/${wsId}/settings`, null, T);
  check(after.settings.dataResidencyRegion === "eu", "and the stored value is untouched");

  /* --------------------------- listing elsewhere ------------------------- */
  const listThere = await ok(us.base, "GET", "/api/workspaces", null, T);
  const names = JSON.stringify(listThere);
  check(!listThere.workspaces.some((w) => String(w._id) === String(wsId)),
    "a foreign-region workspace is absent from the list");
  check(!names.includes("Pinned"),
    "and its name appears nowhere in the response", names.slice(0, 200));
  const elsewhere = listThere.elsewhere?.find((e) => e.region === "eu");
  check(elsewhere?.count >= 1 && elsewhere?.url === "http://localhost:4101",
    "it is reported as a count plus where to go", JSON.stringify(listThere.elsewhere));

  /* --------------------------------- audit ------------------------------- */
  // The blocked attempts above were made by this user; more attempts now should
  // not multiply the entries, because a misconfigured client retries on a timer.
  for (let i = 0; i < 3; i++) await call(us.base, "GET", `/api/workspaces/${wsId}`, null, T);
  await wait(400);
  const audit = await ok(eu.base, "GET", `/api/workspaces/${wsId}/audit?group=residency&limit=200`, null, T);
  const actions = audit.entries.map((e) => e.action);
  check(actions.includes("residency.pinned"), "pinning is recorded in the audit log");
  check(actions.includes("residency.blocked"), "a cross-region attempt is recorded");
  check(actions.includes("residency.egress.blocked"), "a refused out-of-region feature is recorded");
  const restBlocks = audit.entries.filter((e) => e.action === "residency.blocked" && e.meta?.via === "rest").length;
  check(restBlocks === 1,
    "repeated attempts are deduplicated so one loop cannot flood the log", `saw ${restBlocks}`);
  const scimBlock = audit.entries.find((e) => e.action === "residency.blocked" && e.meta?.via === "scim");
  check(Boolean(scimBlock), "the directory refusal is recorded separately from the REST one");
  check(audit.entries.every((e) => e.meta?.servedBy !== "eu"),
    "and every refusal records which deployment answered");

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}

main()
  .then((good) => { stopServers(); process.exit(good ? 0 : 1); })
  .catch((e) => { console.error(e); stopServers(); process.exit(1); });
