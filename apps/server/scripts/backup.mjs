#!/usr/bin/env node
/**
 * Yumi backup — a verifiable snapshot of everything that must survive a disaster.
 *
 * Usage:
 *   pnpm --filter @yumi/server backup [--out ./backups]
 *
 * What is captured: the whole Mongo database, as a single gzipped archive, plus
 * a manifest recording per-collection counts and the archive's SHA-256. The
 * manifest is what makes a restore checkable rather than hopeful — a restore
 * that silently loses a collection is the failure mode people discover late.
 *
 * What is deliberately NOT captured: Redis. Every key in it is either ephemeral
 * or derivable, and restoring a stale copy would be actively harmful:
 *
 *   session:*, usersessions:*  refresh sessions. A stale copy would resurrect
 *                              sessions that were revoked after the snapshot —
 *                              including those revoked to deprovision someone.
 *   suspended:users            the account-suspension fast path. Derivable from
 *                              User.status, and restore.mjs rebuilds it. Losing
 *                              it silently would hand suspended accounts their
 *                              access back for an access-token lifetime.
 *   presence:*, ratelimit:*,   ephemeral by construction; all TTL'd.
 *   sso:flow:*, session:active:*
 *
 * So Redis is not backed up, and restore.mjs reconciles it instead. See dr.md.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
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

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017/yumi";
const OUT_DIR = path.resolve(process.cwd(), argOf("out", "./backups"));
/** Container name used when mongodump is not installed on the host. */
const MONGO_CONTAINER = process.env.MONGO_CONTAINER ?? "yumi-mongo";

const dbNameOf = (uri) => {
  const tail = uri.split("/").pop() ?? "";
  return tail.split("?")[0] || "yumi";
};

function run(cmd, cmdArgs, { toFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", toFile ? "pipe" : "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    if (toFile) child.stdout.pipe(createWriteStream(toFile));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stderr);
      reject(new Error(`${cmd} exited ${code}\n${stderr.trim().slice(0, 2000)}`));
    });
  });
}

const hasHostTool = async (tool) => {
  try { await run("sh", ["-c", `command -v ${tool} >/dev/null 2>&1`]); return true; }
  catch { return false; }
};

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const db = dbNameOf(MONGO_URI);
  // A filesystem-safe, sortable stamp. Named after the moment the dump starts,
  // which is the point in time the archive is consistent to.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(OUT_DIR, `${db}-${stamp}`);
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, "mongo.archive.gz");

  console.log(`[backup] database   ${db}`);
  console.log(`[backup] destination ${dir}`);

  // Counts are read before the dump so a mismatch afterwards is visible rather
  // than assumed away. A busy database can legitimately drift; the manifest
  // records what was true at the start, and restore reports differences.
  await mongoose.connect(MONGO_URI);
  const collections = await mongoose.connection.db.listCollections().toArray();
  const counts = {};
  for (const c of collections.filter((c) => c.type !== "view")) {
    counts[c.name] = await mongoose.connection.db.collection(c.name).countDocuments();
  }
  // Which data regions this snapshot actually contains — read from the
  // workspaces themselves rather than from whoever's shell ran the backup, so
  // the archive can say where its contents are allowed to be restored. A
  // restore into the wrong region is the one way to move a region's data
  // without any running code noticing.
  const pinnedRegions = collections.some((c) => c.name === "workspaces")
    ? (await mongoose.connection.db.collection("workspaces")
        .distinct("settings.dataResidencyRegion")).filter(Boolean).sort()
    : [];

  /*
   * Point-in-time recovery needs the oplog, and the oplog only exists on a
   * replica set. Where there is one, the position is recorded *before* the dump
   * starts, and that is the subtle part.
   *
   * mongodump's own `--oplog` (which would make the archive internally
   * consistent) only works on a full-cluster dump, and Yumi's MONGO_URI always
   * names a database — so it is refused outright. The standard answer is this
   * one: note where the oplog stands before dumping, archive from there, and
   * replay across the dump window on the way back in. Oplog entries are
   * idempotent by construction — that is how secondaries re-apply them — so
   * replaying operations the dump already contains is safe, and it is what makes
   * the restored state consistent rather than smeared across the dump.
   *
   * A standalone mongod records this as null rather than omitting it: a manifest
   * that said nothing would leave someone believing they had PITR when their
   * backups could only ever restore whole snapshots.
   */
  const hello = await mongoose.connection.db.command({ hello: 1 });
  const replicaSet = hello.setName ?? null;
  const oplogPosition = async () => {
    const [last] = await mongoose.connection.client.db("local")
      .collection("oplog.rs").find().sort({ $natural: -1 }).limit(1).toArray();
    return last?.ts ? { t: last.ts.high, i: last.ts.low } : null;
  };
  const oplogStart = replicaSet ? await oplogPosition() : null;
  await mongoose.disconnect();

  if (replicaSet) {
    console.log(`[backup] replica set ${replicaSet} — oplog from ${oplogStart?.t}:${oplogStart?.i}`);
  } else {
    console.log("[backup] standalone mongod — no oplog, so this snapshot supports whole-snapshot restore only (see dr.md §5)");
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[backup] ${collections.length} collections, ${total} documents`);

  const dumpArgs = ["--archive", "--gzip"];
  const onHost = await hasHostTool("mongodump");
  if (onHost) {
    await run("mongodump", ["--uri", MONGO_URI, ...dumpArgs], { toFile: archive });
  } else {
    // The image ships the tools even when the host does not; --archive streams
    // to stdout, so nothing has to be copied out of the container afterwards.
    console.log(`[backup] mongodump not on PATH — using container ${MONGO_CONTAINER}`);
    await run("docker", [
      "exec", MONGO_CONTAINER, "mongodump", "--uri", MONGO_URI.replace("localhost", "127.0.0.1"),
      ...dumpArgs,
    ], { toFile: archive });
  }

  const { size } = await stat(archive);
  if (size === 0) throw new Error("mongodump produced an empty archive");
  const digest = await sha256(archive);

  const manifest = {
    tool: "yumi-backup",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    database: db,
    mongoUriHost: MONGO_URI.replace(/\/\/[^@]*@/, "//<redacted>@"),
    dumpedWith: onHost ? "host mongodump" : `docker exec ${MONGO_CONTAINER}`,
    archive: path.basename(archive),
    archiveBytes: size,
    archiveSha256: digest,
    collections: counts,
    totalDocuments: total,
    // Region pins found in the data, and the region of the deployment that took
    // the dump. restore.mjs refuses to write these into another region.
    pinnedRegions,
    deploymentRegion: process.env.REGION?.trim().toLowerCase() || null,
    // Point-in-time recovery: where the oplog stood when this dump began. The
    // archive chain continues from here, and a restore replays across the dump
    // window to reach a consistent state (see the note above).
    replicaSet,
    oplogStart,
    pitr: Boolean(replicaSet),
    // Recorded so a restore into a newer build is an informed decision.
    schemaNote: "See tracker.md §7 Migrations for the schema version this snapshot was taken under.",
    redis: "not captured — ephemeral or derivable; restore.mjs reconciles it (see dr.md)",
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`[backup] archive    ${(size / 1e6).toFixed(2)} MB`);
  console.log(`[backup] sha256     ${digest}`);
  console.log(`[backup] done       ${dir}`);
}

main().catch(async (err) => {
  console.error("[backup] FAILED:", err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
