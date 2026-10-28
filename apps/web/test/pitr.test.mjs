/**
 * Point-in-time recovery — a real disaster drill.
 *
 * The claim being tested is the whole reason PITR exists: that recovery can land
 * on a chosen moment rather than only on whole snapshots. So the drill writes
 * something, takes a backup, writes more, notes a moment, *then* destroys data —
 * and recovers to the moment. Passing means the good writes came back and the
 * destructive ones did not.
 *
 * The refusals matter as much as the recovery. A backup chain that quietly skips
 * an hour, or a `--to` that silently restores less than asked for, is worse than
 * one that admits it cannot: those cases are checked too.
 *
 * Runs against a scratch database (never the real one). Needs a replica set —
 * the oplog does not exist without one — and says how to get one if there isn't.
 *
 *   node apps/web/test/pitr.test.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");
const DB = "yumi_pitr_drill";

// Resolved from the server package: this drill exercises server-side scripts,
// and pnpm's strict layout does not expose mongoose to apps/web.
const mongoose = (await import(path.join(SERVER_DIR, "node_modules/mongoose/index.js"))).default;

let pass = 0, fail = 0;
const check = (ok, label, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one of the backup/restore scripts and hand back its combined output. */
function script(name, args, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [`scripts/${name}`, ...args], {
      cwd: SERVER_DIR, env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => resolve({ code, out }));
  });
}

/**
 * Find a replica set to drill against.
 *
 * The app's own MONGO_URI is tried first. Failing that, the compose container is
 * tried directly by IP — on a machine where a native mongod already holds
 * port 27017, the container is shadowed and only reachable that way.
 */
async function findReplicaSet() {
  const candidates = [];
  const configured = process.env.MONGO_URI ?? "mongodb://localhost:27017/yumi";
  const base = configured.replace(/\/[^/?]*(\?|$)/, `/${DB}$1`);
  candidates.push(base);
  try {
    const ip = execFileSync("docker", [
      "inspect", "yumi-mongo", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    ]).toString().trim();
    if (ip) candidates.push(`mongodb://${ip}:27017/${DB}?directConnection=true`);
  } catch { /* docker not available — the first candidate is all there is */ }

  for (const uri of candidates) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
      const hello = await mongoose.connection.db.command({ hello: 1 });
      await mongoose.disconnect();
      if (hello.setName) return { uri, setName: hello.setName };
    } catch { /* try the next */ }
    try { await mongoose.disconnect(); } catch { /* not connected */ }
  }
  return null;
}

const names = async (uri) => {
  await mongoose.connect(uri);
  const docs = await mongoose.connection.db.collection("notes").find().toArray();
  await mongoose.disconnect();
  return docs.map((d) => d.name).sort();
};

async function main() {
  const found = await findReplicaSet();
  if (!found) {
    console.log("⏭  SKIPPED — no replica set reachable, so there is no oplog to drill against.");
    console.log("   Point-in-time recovery requires one. Either:");
    console.log("     • use the bundled container:  pnpm infra:up   (docker-compose runs mongod --replSet rs0)");
    console.log("     • or convert your own mongod: add `replication: {replSetName: rs0}` to mongod.conf,");
    console.log("       restart it, then run rs.initiate() once. Existing data is kept.");
    console.log("   See dr.md §5.");
    return true;
  }
  const { uri, setName } = found;
  console.log(`Drilling against replica set "${setName}"\n  ${uri}\n`);

  const out = mkdtempSync(path.join(tmpdir(), "yumi-pitr-"));
  const env = { MONGO_URI: uri };

  try {
    /* --------------------------- set the scene ---------------------------- */
    await mongoose.connect(uri);
    const notes = mongoose.connection.db.collection("notes");
    await notes.deleteMany({});
    await notes.insertOne({ name: "before-backup" });
    await mongoose.disconnect();

    const backup = await script("backup.mjs", ["--out", out], env);
    check(backup.code === 0 && /replica set/.test(backup.out),
      "a backup from a replica set records its oplog position", backup.out.slice(-200));
    const dir = path.join(out, readdirSync(out)[0]);
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    check(Boolean(manifest.oplogStart) && manifest.pitr === true,
      "and the manifest says point-in-time recovery is possible", JSON.stringify(manifest.oplogStart));

    /* ------------------- write, mark the moment, destroy ------------------- */
    await mongoose.connect(uri);
    const live = mongoose.connection.db.collection("notes");
    await live.insertOne({ name: "good-write" });
    await wait(2000);
    const moment = new Date().toISOString();
    await wait(2000);
    // The disaster: a write that should never have happened, and a delete of
    // something that should still exist.
    await live.deleteMany({ name: "before-backup" });
    await live.insertOne({ name: "the-disaster" });
    await mongoose.disconnect();
    check(JSON.stringify(await names(uri)) === JSON.stringify(["good-write", "the-disaster"]),
      "the database is now in the state nobody wanted");

    /* ------------------------------ archive ------------------------------- */
    const archived = await script("oplog-archive.mjs", ["--from", dir], env);
    check(archived.code === 0 && /archived\s+\d+ entries/.test(archived.out),
      "the oplog written since the backup is archived", archived.out.slice(-200));
    const second = await script("oplog-archive.mjs", ["--from", dir], env);
    check(second.code === 0 && /nothing new/.test(second.out),
      "archiving again is a no-op rather than a duplicate segment", second.out.slice(-120));

    /* ------------------------------ recover ------------------------------- */
    const recovered = await script("restore.mjs", ["--from", dir, "--to", moment, "--force", "--yes"], env);
    check(recovered.code === 0 && /recovered to/.test(recovered.out),
      "the restore replays the oplog up to the chosen moment", recovered.out.slice(-260));

    const after = await names(uri);
    check(after.includes("before-backup"), "a document deleted by the disaster is back", JSON.stringify(after));
    check(after.includes("good-write"), "a write made after the backup survived", JSON.stringify(after));
    check(!after.includes("the-disaster"),
      "and the write that caused the disaster is gone", JSON.stringify(after));

    /* ------------------------------ refusals ------------------------------ */
    const tooLate = await script("restore.mjs", ["--from", dir, "--to", "2099-01-01T00:00:00Z", "--force", "--yes"], env);
    check(tooLate.code !== 0 && /archived chain only reaches/.test(tooLate.out),
      "recovering past the end of the chain is refused, not silently truncated");

    const tooEarly = await script("restore.mjs", ["--from", dir, "--to", "2000-01-01T00:00:00Z", "--force", "--yes"], env);
    check(tooEarly.code !== 0 && /cannot go backwards/.test(tooEarly.out),
      "recovering to before the snapshot is refused");

    const nonsense = await script("restore.mjs", ["--from", dir, "--to", "yesterday-ish", "--force", "--yes"], env);
    check(nonsense.code !== 0 && /not a date I can read/.test(nonsense.out),
      "an unreadable timestamp is refused");

    // A chain with a hole in it must fail loudly: the writes in the gap are
    // gone, and a segment written over the top would hide that forever.
    const statePath = path.join(dir, "oplog", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.lastTs = { t: 1_000_000_000, i: 1 };   // long before anything the oplog still holds
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    const gap = await script("oplog-archive.mjs", ["--from", dir], env);
    check(gap.code !== 0 && /rolled past this chain/.test(gap.out),
      "a gap in the chain stops the archive rather than leaving a silent hole");
  } finally {
    await mongoose.connect(uri).catch(() => {});
    await mongoose.connection.db?.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    rmSync(out, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}

main()
  .then((good) => process.exit(good ? 0 : 1))
  .catch((e) => { console.error(e); process.exit(1); });
