#!/usr/bin/env node
/**
 * Yumi oplog archive — the half of point-in-time recovery that runs between
 * backups.
 *
 * A snapshot can only ever restore you to the moment it was taken. Everything
 * written since is in the oplog, and the oplog is a *capped* collection: it
 * overwrites its own oldest entries as it fills. So PITR is not a property of
 * having a replica set — it is a property of copying the oplog somewhere durable
 * before it rolls over. That is what this does.
 *
 *   pnpm --filter @yumi/server oplog:archive -- --from ./backups/yumi-2026-…
 *
 * Run it on a timer (see dr.md §5). Each run appends the entries written since
 * the last one to `<backup>/oplog/`, so the backup directory holds a base
 * snapshot plus an unbroken chain of everything after it.
 *
 * The failure this is careful about is the gap. If the oplog rolled over past
 * the point the chain had reached, the missing writes are gone and no restore
 * can invent them — so this refuses to write a segment that would leave a silent
 * hole, and says exactly what to do about it. A backup chain that quietly skips
 * an hour is worse than one that admits it stopped.
 */
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const MONGO_URI = argOf("uri", process.env.MONGO_URI ?? "mongodb://localhost:27017/yumi");
const FROM = argOf("from", null);
/** Guard against one run trying to serialise an unbounded backlog into memory. */
const BATCH = Number(argOf("batch", 5000));

const BSON = mongoose.mongo.BSON;
const tsOf = (o) => new BSON.Timestamp({ t: o.t, i: o.i });
const fmt = (o) => `${o.t}:${o.i}`;
const at = (o) => new Date(o.t * 1000).toISOString();

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { return fallback; }
}

async function main() {
  if (!FROM) throw new Error("--from <backup directory> is required");
  const dir = path.resolve(process.cwd(), FROM);
  const manifest = await readJson(path.join(dir, "manifest.json"));
  if (!manifest) throw new Error(`no manifest.json in ${dir} — is that a backup directory?`);

  if (!manifest.oplogStart) {
    throw new Error(
      "this snapshot was taken from a standalone mongod, which has no oplog.\n" +
      "  Point-in-time recovery needs a replica set. See dr.md §5 for the one-time conversion."
    );
  }

  const oplogDir = path.join(dir, "oplog");
  await mkdir(oplogDir, { recursive: true });
  const statePath = path.join(oplogDir, "state.json");
  const state = await readJson(statePath, { segments: [], lastTs: manifest.oplogStart });

  await mongoose.connect(MONGO_URI);
  const hello = await mongoose.connection.db.command({ hello: 1 });
  if (!hello.setName) {
    await mongoose.disconnect();
    throw new Error(
      `${MONGO_URI} is a standalone mongod — there is no oplog to archive.\n` +
      "  If this is the container while a native mongod holds the port, pass --uri explicitly."
    );
  }
  const oplog = mongoose.connection.client.db("local").collection("oplog.rs");

  /*
   * The chain check. `state.lastTs` is the last entry already archived; if the
   * oldest entry the oplog still holds is *newer* than that, everything between
   * them has been overwritten and is unrecoverable.
   */
  const [oldest] = await oplog.find().sort({ $natural: 1 }).limit(1).toArray();
  const from = state.lastTs;
  if (oldest?.ts && (oldest.ts.high > from.t || (oldest.ts.high === from.t && oldest.ts.low > from.i))) {
    await mongoose.disconnect();
    throw new Error(
      `the oplog has rolled past this chain.\n` +
      `  archived up to ${fmt(from)} (${at(from)})\n` +
      `  oldest still held ${oldest.ts.high}:${oldest.ts.low} (${new Date(oldest.ts.high * 1000).toISOString()})\n` +
      "  The writes in between are gone. Take a fresh base backup now, and archive more often\n" +
      "  (or give the oplog more room with --oplogSize). Continuing would leave a silent hole."
    );
  }

  /*
   * The oplog is cluster-wide, so it is narrowed to this deployment's own
   * database. Replaying another database's operations into a recovery would
   * touch data the backup never claimed to cover — and the periodic no-op
   * heartbeats every replica set writes carry nothing worth storing.
   */
  const db = (MONGO_URI.split("/").pop() ?? "").split("?")[0] || "yumi";
  /*
   * `raw: true` hands back each entry's original BSON bytes instead of a decoded
   * object, and that fidelity is the point rather than an optimisation. Decoding
   * and re-encoding loses type information the server insists on: the driver
   * promotes the entry's `t` (election term) from a BSON Long to a JS number,
   * which re-serialises as an int32, and replay then fails with
   * "BSON field 'OpTimeBase.t' is the wrong type 'int', expected type 'long'".
   * Copying the bytes verbatim cannot introduce that class of problem at all.
   */
  const cursor = oplog.find({
    ts: { $gt: tsOf(from) },
    op: { $ne: "n" },
    ns: new RegExp(`^${db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`),
  }, { raw: true }).sort({ $natural: 1 }).limit(BATCH);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const segment = path.join(oplogDir, `oplog-${stamp}.bson`);

  let count = 0;
  let lastTs = from;
  let buffer = [];
  for await (const raw of cursor) {
    // Concatenated raw BSON is exactly what `mongorestore --oplogReplay` reads,
    // so a restore needs no translation step of its own. The decode here is only
    // to record how far the chain now reaches.
    const { ts } = BSON.deserialize(raw, { promoteLongs: false });
    buffer.push(raw);
    lastTs = { t: ts.high, i: ts.low };
    count++;
    if (buffer.length >= 500) { await appendFile(segment, Buffer.concat(buffer)); buffer = []; }
  }
  if (buffer.length) await appendFile(segment, Buffer.concat(buffer));

  await mongoose.disconnect();

  if (count === 0) {
    console.log(`[oplog] nothing new since ${fmt(from)} (${at(from)})`);
    return;
  }

  state.segments.push({ file: path.basename(segment), entries: count, from, to: lastTs });
  state.lastTs = lastTs;
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  console.log(`[oplog] archived  ${count} entries → ${path.basename(segment)}`);
  console.log(`[oplog] covers    ${at(from)} → ${at(lastTs)}`);
  console.log(`[oplog] chain     ${state.segments.length} segment(s) since the base snapshot`);
  if (count === BATCH) {
    // Truthful about a bounded run: the caller needs to know to go again rather
    // than assume the chain is now current.
    console.log(`[oplog] NOTE      hit the ${BATCH}-entry batch limit — run again to continue the chain`);
  }
}

main().catch(async (err) => {
  console.error("[oplog] FAILED:", err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
