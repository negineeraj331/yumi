#!/usr/bin/env node
/**
 * Yumi restore — bring a snapshot back, then make the running system consistent
 * with it.
 *
 * Usage:
 *   pnpm --filter @yumi/server restore -- --from ./backups/yumi-2026-... [--force] [--yes]
 *
 * Restoring the database is the easy half. The half that is usually missed is
 * that Yumi keeps live state in Redis which the snapshot does not contain, and
 * which is *wrong* the moment Mongo moves backwards in time:
 *
 *   1. suspended:users is the fast path that makes a suspended account stop
 *      working before its access token expires. It is not in the backup, so
 *      after a restore it is empty — and every suspended or directory-
 *      deprovisioned account would be usable again for an access-token lifetime.
 *      It is rebuilt here from User.status, which is the source of truth.
 *   2. Refresh sessions must be dropped, not kept. Keeping them would honour
 *      sessions revoked after the snapshot was taken, including ones revoked in
 *      order to remove someone's access. Everyone signs in again; that is the
 *      correct trade, and the cheap direction to be wrong in.
 *   3. Presence, active-session markers, rate-limit counters and in-flight SSO
 *      flows all describe a world that no longer exists. They are cleared.
 *   4. A collaboration session whose Redis marker is gone can never be
 *      finalised, so it would sit with no endedAt forever and never produce
 *      analytics. Those are closed out here.
 *
 * Nothing is written until the archive's checksum matches its manifest.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, appendFile, mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import mongoose from "mongoose";
import Redis from "ioredis";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017/yumi";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const MONGO_CONTAINER = process.env.MONGO_CONTAINER ?? "yumi-mongo";
const FROM = argOf("from", null);
/** ISO 8601 moment to recover to. Absent = restore the snapshot as it stands. */
const TO = argOf("to", null);

function run(cmd, cmdArgs, { fromFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: [fromFile ? "pipe" : "ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    if (fromFile) createReadStream(fromFile).pipe(child.stdin);
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

const confirm = (question) => new Promise((resolve) => {
  if (has("yes")) return resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`${question} [y/N] `, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
});

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { return fallback; }
}

/** Same server, no default database — keeps any query string intact. */
function uriWithoutDb(uri) {
  const [head, query] = uri.split("?");
  const at = head.lastIndexOf("/");
  const base = at > head.indexOf("//") + 1 ? head.slice(0, at + 1) : `${head}/`;
  return query ? `${base}?${query}` : base;
}

/**
 * Replay archived oplog segments on top of the restored snapshot, stopping at
 * the requested moment.
 *
 * This is what turns "restore last night's backup" into "restore to 14:05, just
 * before the bad migration". mongorestore replays entries with a timestamp
 * strictly *below* `--oplogLimit`, so the limit is the second after the one
 * asked for: recovery is accurate to the second, and pretending otherwise by
 * accepting milliseconds would be a false promise.
 */
async function replayTo(dir, manifest, onHost) {
  if (!manifest.oplogStart) {
    throw new Error(
      "--to needs a snapshot taken from a replica set; this one came from a standalone mongod,\n" +
      "  which has no oplog. Restore without --to, or see dr.md §5."
    );
  }
  const target = new Date(TO);
  if (Number.isNaN(target.getTime())) throw new Error(`--to "${TO}" is not a date I can read (use ISO 8601)`);

  const oplogDir = path.join(dir, "oplog");
  const state = await readJson(path.join(oplogDir, "state.json"));
  const segments = state?.segments ?? [];
  if (!segments.length) {
    throw new Error(
      "no archived oplog segments in this backup, so there is nothing to replay forward.\n" +
      "  Point-in-time recovery needs `oplog:archive` to have been running between backups (dr.md §5)."
    );
  }

  const baseAt = new Date(manifest.oplogStart.t * 1000);
  if (target < baseAt) {
    throw new Error(
      `this snapshot begins at ${baseAt.toISOString()}, which is after ${target.toISOString()}.\n` +
      "  Replaying forward cannot go backwards — restore an older snapshot instead."
    );
  }
  const reach = new Date(state.lastTs.t * 1000);
  if (target > reach) {
    // Better to refuse than to restore less than asked for and say nothing.
    throw new Error(
      `the archived chain only reaches ${reach.toISOString()}, earlier than ${target.toISOString()}.\n` +
      "  Run `oplog:archive` against the live server first, if it is still available."
    );
  }

  // mongorestore wants a directory whose root holds oplog.bson. Segments are
  // raw concatenated BSON documents, so joining them end to end is valid.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "yumi-oplog-"));
  const targetBsonPath = path.join(tmp, "oplog.bson");
  for (const seg of segments) {
    await appendFile(targetBsonPath, await readFile(path.join(oplogDir, seg.file)));
  }
  const limit = Math.floor(target.getTime() / 1000) + 1;

  /*
   * The database has to come out of the URI for this call. mongorestore reads a
   * database in the connection string as "restore only this one", and refuses
   * `--oplogReplay with includes specified` — the oplog is cluster-wide, so it
   * will not let you scope it. Each entry names its own namespace, and
   * oplog-archive only ever stored this database's, so the writes still land
   * exactly where they came from.
   */
  const replayUri = uriWithoutDb(MONGO_URI);

  console.log(`[restore] replaying ${segments.length} oplog segment(s) up to ${target.toISOString()}`);
  if (onHost) {
    await run("mongorestore", ["--uri", replayUri, "--oplogReplay", "--oplogLimit", String(limit), "--dir", tmp]);
  } else {
    // The container cannot see a host temp directory, so the file goes in first.
    await run("docker", ["cp", tmp, `${MONGO_CONTAINER}:/tmp/yumi-oplog`]);
    await run("docker", [
      "exec", MONGO_CONTAINER, "mongorestore",
      "--uri", replayUri.replace("localhost", "127.0.0.1"),
      "--oplogReplay", "--oplogLimit", String(limit), "--dir", "/tmp/yumi-oplog",
    ]);
    await run("docker", ["exec", MONGO_CONTAINER, "rm", "-rf", "/tmp/yumi-oplog"]);
  }
  await rm(tmp, { recursive: true, force: true });
  console.log(`[restore] recovered to ${target.toISOString()} (to the second)`);
}

/** Delete keys by pattern with SCAN — never KEYS, which blocks the server. */
async function deletePattern(redis, pattern) {
  let cursor = "0";
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length) removed += await redis.del(...keys);
  } while (cursor !== "0");
  return removed;
}

async function main() {
  if (!FROM) throw new Error("--from <backup directory> is required");
  const dir = path.resolve(process.cwd(), FROM);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const archive = path.join(dir, manifest.archive);

  console.log(`[restore] snapshot   ${manifest.createdAt} (${manifest.database})`);
  console.log(`[restore] contents   ${manifest.totalDocuments} documents in ${Object.keys(manifest.collections).length} collections`);

  const digest = await sha256(archive);
  if (digest !== manifest.archiveSha256) {
    throw new Error(`archive checksum mismatch — refusing to restore\n  expected ${manifest.archiveSha256}\n  actual   ${digest}`);
  }
  console.log("[restore] checksum   verified");

  // Residency: a restore writes whatever the archive holds into whatever
  // database MONGO_URI names, so it is the one operation that can move a
  // region's data with nothing running to object. The archive records the pins
  // it contains (backup.mjs), so the mismatch is checkable rather than left to
  // whoever is holding the pager. Refused by default, overridable with --force
  // because a deliberate migration is a real thing — it just should not be an
  // accident at 3am.
  const target = process.env.REGION?.trim().toLowerCase() || null;
  const foreign = (manifest.pinnedRegions ?? []).filter((r) => r !== target);
  if (foreign.length) {
    console.log(`[restore] snapshot holds workspaces pinned to: ${manifest.pinnedRegions.join(", ")}`);
    if (!has("force")) {
      throw new Error(
        `this snapshot contains data pinned to ${foreign.join(", ")}, but REGION here is ` +
        `${target ? `"${target}"` : "unset"}.\n` +
        "  Restoring it would move that data out of the region it is committed to.\n" +
        "  Restore into that region's database, or re-run with --force if this is a deliberate migration."
      );
    }
    console.log("[restore] --force given — restoring foreign-region data anyway");
  } else if (manifest.pinnedRegions?.length) {
    console.log(`[restore] residency  snapshot and this deployment are both "${target}"`);
  }

  // Refuse to overwrite a populated database unless told to, explicitly.
  await mongoose.connect(MONGO_URI);
  const existing = await mongoose.connection.db.listCollections().toArray();
  const existingDocs = await (async () => {
    let n = 0;
    for (const c of existing.filter((c) => c.type !== "view")) {
      n += await mongoose.connection.db.collection(c.name).countDocuments();
    }
    return n;
  })();
  if (existingDocs > 0 && !has("force")) {
    await mongoose.disconnect();
    throw new Error(
      `the target database already holds ${existingDocs} documents.\n` +
      "  Re-run with --force to replace it. That is destructive and not reversible."
    );
  }
  if (existingDocs > 0) {
    console.log(`[restore] target holds ${existingDocs} documents — they will be REPLACED`);
    if (!(await confirm("Replace the current database with this snapshot?"))) {
      await mongoose.disconnect();
      console.log("[restore] cancelled");
      return;
    }
  }
  await mongoose.disconnect();

  const onHost = await hasHostTool("mongorestore");
  const baseArgs = ["--archive", "--gzip", "--drop"];
  if (onHost) {
    await run("mongorestore", ["--uri", MONGO_URI, ...baseArgs], { fromFile: archive });
  } else {
    console.log(`[restore] mongorestore not on PATH — using container ${MONGO_CONTAINER}`);
    await run("docker", [
      "exec", "-i", MONGO_CONTAINER, "mongorestore",
      "--uri", MONGO_URI.replace("localhost", "127.0.0.1"), ...baseArgs,
    ], { fromFile: archive });
  }
  console.log("[restore] database   restored");

  /* ------------------------- point-in-time replay --------------------------- */
  if (TO) {
    await replayTo(dir, manifest, onHost);
  } else if (manifest.oplogStart) {
    const segments = (await readJson(path.join(dir, "oplog", "state.json")))?.segments ?? [];
    if (segments.length) {
      // Say it, rather than let someone believe a plain restore used the chain
      // they have been carefully archiving.
      console.log(`[restore] note       ${segments.length} oplog segment(s) present but not replayed — pass --to <time> for point-in-time recovery`);
    }
  }

  /* --------------------------- verify against the manifest ------------------ */
  await mongoose.connect(MONGO_URI);
  const drift = [];
  for (const [name, expected] of Object.entries(manifest.collections)) {
    const actual = await mongoose.connection.db.collection(name).countDocuments();
    if (actual !== expected) drift.push(`${name}: expected ${expected}, found ${actual}`);
  }
  if (drift.length) {
    // Reported, not thrown: a snapshot taken from a live system can legitimately
    // differ by a few documents written during the dump. Silence would be worse.
    console.warn("[restore] count differences vs the manifest:");
    for (const line of drift) console.warn(`             ${line}`);
  } else {
    console.log("[restore] verified   every collection matches the manifest");
  }

  /* ------------------------------ reconcile Redis --------------------------- */
  const redis = new Redis(REDIS_URL);
  const users = mongoose.connection.db.collection("users");

  const dropped =
    (await deletePattern(redis, "session:*")) +
    (await deletePattern(redis, "usersessions:*"));
  console.log(`[restore] sessions   ${dropped} stale refresh session keys dropped — everyone signs in again`);

  const ephemeral =
    (await deletePattern(redis, "presence:*")) +
    (await deletePattern(redis, "ratelimit:*")) +
    (await deletePattern(redis, "sso:flow:*"));
  console.log(`[restore] ephemeral  ${ephemeral} presence/rate-limit/SSO-flow keys cleared`);

  // The one thing that must be rebuilt rather than cleared. Without this a
  // suspended account works again until its access token expires.
  await redis.del("suspended:users");
  const suspended = await users.find({ status: { $ne: "active" } }).project({ _id: 1 }).toArray();
  if (suspended.length) {
    await redis.sadd("suspended:users", ...suspended.map((u) => String(u._id)));
  }
  console.log(`[restore] suspended  ${suspended.length} non-active account(s) re-marked from User.status`);

  // A session whose marker is gone can never be finalised by the gateway.
  const sessions = mongoose.connection.db.collection("collabsessions");
  const dangling = await sessions.find({ endedAt: null }).toArray();
  if (dangling.length) {
    const now = new Date();
    for (const s of dangling) {
      await sessions.updateOne(
        { _id: s._id },
        {
          $set: {
            endedAt: now,
            // Every participant left when the system did; leaving these null
            // would misreport them as still present.
            participants: (s.participants ?? []).map((p) => ({ ...p, leftAt: p.leftAt ?? now })),
          },
        }
      );
    }
  }
  console.log(`[restore] sessions   ${dangling.length} unfinished collaboration session(s) closed out`);

  await redis.quit();
  await mongoose.disconnect();
  console.log("[restore] done — restart the server so its in-memory document cache is rebuilt from the restored log");
}

main().catch(async (err) => {
  console.error("[restore] FAILED:", err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
