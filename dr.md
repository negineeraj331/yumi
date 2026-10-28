# Yumi — Backup & Disaster Recovery (dr.md)

**Companion to:** `tracker.md` §6 (Phase 4), `rules.md` §3.7
**Version:** 1.0 · **Updated:** 2026-07-30

This describes what is backed up, what deliberately is not, how to restore, and
what a restore does *not* fix on its own. The scripts are
`apps/server/scripts/{backup,restore,oplog-archive}.mjs`.

---

## 1. What is protected

| Store | Backed up | Why |
|---|---|---|
| Mongo (all collections) | ✅ | Everything durable: accounts, workspaces, projects, files, the append-only CRDT log, messages, audit log, SCIM identities, analytics. |
| Redis | ❌ by design | Every key is ephemeral or derivable. See §2 — restoring a stale copy would be worse than having none. |
| Uploaded assets | n/a | There is no blob store. Canvas images are downscaled data-URLs inside the CRDT log, so they travel with Mongo (decision 2026-07-14). |
| E2EE project keys | ❌ and cannot be | Encrypted projects' keys exist only in members' browsers. A backup that could restore them would mean the server had them. If every member loses the key, that project's contents are unrecoverable — by design. |

**Objectives.** RPO is the *oplog archive* interval where point-in-time recovery
is set up (§5), and the backup interval where it is not (§6). RTO is dominated by
`mongorestore` on your data size plus one server restart; the reconciliation step
is seconds, and an oplog replay is proportional to the writes since the snapshot.

---

## 2. Why Redis is not in the backup

Restoring a stale Redis is not neutral — it is harmful. Each key family and its
disposition on restore:

| Key | On restore | Reason |
|---|---|---|
| `session:<jti>`, `usersessions:<userId>` | **dropped** | Refresh sessions. A snapshot's copy would honour sessions revoked *after* it was taken — including sessions revoked precisely to cut off someone's access. Everyone signs in again; that is the cheap direction to be wrong in. |
| `suspended:users` | **rebuilt from `User.status`** | The fast path that stops a suspended or directory-deprovisioned account before its access token expires. Not in the backup, so after a restore it is empty — and every suspended account would work again for up to one access-token lifetime. `restore.mjs` repopulates it. **This is the step that is easy to miss and the reason restore is a script rather than a `mongorestore` one-liner.** |
| `presence:<projectId>` | cleared | Who is online. TTL'd, and describes a world that no longer exists. |
| `session:active:<projectId>` | cleared | Marks an in-flight collaboration session. See §4. |
| `ratelimit:*` | cleared | Counters; refill immediately. |
| `sso:flow:<state>` | cleared | In-flight OIDC logins, valid for seconds. Any login in progress during the incident simply fails and is retried. |

---

## 3. Taking a backup

```bash
pnpm --filter @yumi/server backup            # → ./backups/<db>-<timestamp>/
pnpm --filter @yumi/server backup --out /mnt/backups
```

Each snapshot directory holds:

- `mongo.archive.gz` — a single gzipped `mongodump` archive.
- `manifest.json` — creation time, per-collection document counts, archive size
  and SHA-256, how the dump was taken, and which data regions the snapshot's
  workspaces are pinned to.

The manifest is what makes a restore checkable instead of hopeful. A restore that
silently loses a collection is a failure discovered far too late; the counts are
compared on the way back in.

`mongodump` is used from the host when present, otherwise through
`docker exec yumi-mongo` (override with `MONGO_CONTAINER`). The archive streams
over stdout, so nothing has to be copied out of the container.

Backups contain live customer data. `backups/` is gitignored. Treat a snapshot
with the same care as the database: encrypt at rest, restrict access, and note
that it includes the audit log, which is more sensitive than the content itself.

---

## 4. Restoring

```bash
pnpm --filter @yumi/server restore -- --from ./backups/yumi-2026-07-30T...
```

In order, the script:

1. Verifies the archive's SHA-256 against the manifest. **Nothing is written if
   it does not match.**
2. Checks data residency. The manifest records which regions the snapshot's
   workspaces are pinned to (read from the data itself, not from whoever ran the
   backup), and a restore into a deployment whose `REGION` is different — or
   unset — is **refused**. A restore is the one operation that can move a
   region's data with nothing running to object to it, so it is checked here
   rather than left to whoever is holding the pager at 3am. `--force` overrides,
   because a deliberate migration is a real thing; it just should not be an
   accident.
3. Refuses to overwrite a database that already holds documents unless given
   `--force`, and then asks for confirmation (`--yes` to skip, for automation).
4. Runs `mongorestore --drop`.
5. Compares every collection against the manifest and *reports* differences
   rather than failing — a snapshot taken from a live system can legitimately
   differ by a few documents written during the dump. Silence would be worse than
   a warning.
6. Reconciles Redis per §2.
7. Closes out collaboration sessions with no `endedAt`. Their Redis marker is
   gone, so the gateway can never finalise them; left alone they would sit open
   forever and never produce analytics. Participants are marked as having left at
   restore time rather than left `null`, which would misreport them as present.

**Then restart the server.** It holds an in-memory cache of Yjs documents, which
must be rebuilt from the restored update log. Skipping this is the one way to
lose data *after* a successful restore: a cached document from before the
incident could be persisted over the restored log.

### Verifying a restore worked

Beyond the automatic count check:

```bash
# a deprovisioned account must still be refused
curl -si localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"<deprovisioned>","password":"x"}' | head -1     # expect 403
```

Open a restored project and confirm the document renders — that exercises the
CRDT log end to end, which a document count does not.

---

## 5. Point-in-time recovery

A snapshot restores you to the moment it was taken. That is the wrong granularity
for the most common disaster, which is not "the disk died" but "a bad migration
ran at 14:05 and nobody noticed until 15:30" — restoring last night loses the
whole day, and restoring nothing loses the data the migration ate.

Point-in-time recovery closes that gap by replaying the **oplog** on top of a
snapshot, stopping at a chosen second:

```bash
pnpm --filter @yumi/server restore -- --from ./backups/yumi-… --to 2026-07-30T14:05:00Z
```

**It requires a replica set**, because the oplog does not exist without one. A
single member is enough — this is about having an operation log, not about
availability. The bundled `docker-compose.yml` already runs `mongod --replSet
rs0` and initiates it on first boot. To convert a mongod you run yourself, add

```yaml
replication:
  replSetName: rs0
```

to its `mongod.conf`, restart it, and run `rs.initiate()` once from `mongosh`.
Existing data is kept; the conversion does not rewrite it.

**It also requires the oplog to be archived**, and this is the part that is easy
to get wrong. The oplog is a *capped* collection: it overwrites its own oldest
entries as it fills, so on a busy system it may only hold a few hours. PITR is
therefore not a property of having a replica set — it is a property of copying
the oplog somewhere durable before it rolls over:

```bash
# after each backup, and then on a timer between backups
pnpm --filter @yumi/server oplog:archive -- --from ./backups/yumi-…
```

Each run appends everything written since the last one into `<backup>/oplog/`,
so a backup directory holds a base snapshot plus an unbroken chain after it.
**If the oplog rolls past where the chain reached, the writes in between are
gone** — `oplog:archive` refuses to write a segment that would leave a silent
hole, and tells you to take a fresh base backup. Archive more often than your
oplog turns over.

Two properties worth knowing:

- **Recovery is accurate to the second.** `mongorestore` replays entries strictly
  below its limit, so `--to` means "everything up to and including that second".
- **The base snapshot is not internally consistent on its own, and does not need
  to be.** mongodump's `--oplog` only works on a full-cluster dump and Yumi's
  connection string always names a database, so the position is recorded *before*
  the dump instead and the chain is replayed across the dump window. Oplog
  entries are idempotent by construction — that is how a secondary re-applies
  them — so replaying operations the dump already contains is safe.

The drill in `apps/web/test/pitr.test.mjs` does exactly this end to end: write,
back up, write, note a moment, destroy data, then recover to the moment and check
that the good writes returned and the destructive one did not.

---

## 6. Scheduling

Not wired up here, because the right answer depends on the deployment. A
reasonable default:

```cron
# nightly base snapshot, retained by whatever manages /mnt/backups
0 3 * * * cd /srv/yumi && pnpm --filter @yumi/server backup --out /mnt/backups >> /var/log/yumi-backup.log 2>&1

# every 10 minutes, extend that snapshot's oplog chain (see §5)
*/10 * * * * cd /srv/yumi && pnpm --filter @yumi/server oplog:archive -- --from "$(ls -d /mnt/backups/*/ | tail -1)" >> /var/log/yumi-oplog.log 2>&1
```

The interval for the second one is not a preference: it has to be comfortably
shorter than the time your oplog takes to turn over, or the chain breaks. Check
with `db.getReplicationInfo().timeDiffHours` on the live server.

Two things to get right whatever the interval:

- **Test the restore, not the backup.** An untested backup is a belief, not a
  capability. Restore into a scratch database on a schedule.
- **Store snapshots off the machine that holds the database.** A backup on the
  same disk protects against a bad migration, not a lost disk.

---

## 7. What this does not cover

Stated plainly, because these appear in the same tracker row and code does not
discharge them:

- **SLA.** A published availability target needs monitoring, alerting, an
  on-call rotation and error-budget policy. None of that exists yet.
- **SOC 2.** An audit of controls over a period. The audit log, retention
  controls and access reviews built in Phase 4 are inputs to it, not a substitute
  for it.
- **Penetration test.** Must be done by someone who did not write the code.
- **Moving a workspace between regions.** Restoring a region's snapshot into
  another region is refused (see §4), and there is no supported way to re-pin a
  workspace in place — the pin is immutable by design. A genuine migration means
  creating the workspace in the target region and moving its contents
  deliberately, which is not built.
- **Continuous archiving to somewhere else.** §5's oplog chain lands next to the
  base snapshot. Getting both off the machine, on a schedule, is deployment work
  this repo does not do for you (§6).
