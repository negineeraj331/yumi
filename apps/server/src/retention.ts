/**
 * Audit-log retention.
 *
 * Retention is per-workspace and runtime-configurable from the admin console,
 * so this is a periodic sweep rather than a Mongo TTL index: a TTL index bakes
 * its expiry into the index definition, which would mean rebuilding an index
 * every time an admin changed the policy.
 *
 * The default is 0 = keep forever. Purging a security log is destructive and
 * irreversible, so it only ever happens because someone deliberately set a
 * retention window for that workspace.
 */
import { AuditLog, Workspace } from "./models.js";
import { config } from "./config.js";

export interface PurgeSummary {
  workspacesConsidered: number;
  workspacesPurged: number;
  deleted: number;
}

/**
 * Delete audit entries older than each workspace's retention window.
 * Workspaces with retention 0 (or unset) are skipped entirely.
 */
export async function purgeExpiredAuditLogs(now: Date = new Date()): Promise<PurgeSummary> {
  const summary: PurgeSummary = { workspacesConsidered: 0, workspacesPurged: 0, deleted: 0 };

  const workspaces = await Workspace.find({ "settings.auditRetentionDays": { $gt: 0 } })
    .select("_id settings.auditRetentionDays")
    .lean();

  for (const ws of workspaces) {
    const days = (ws as any).settings?.auditRetentionDays ?? 0;
    if (!days || days <= 0) continue;
    summary.workspacesConsidered++;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    try {
      const r = await AuditLog.deleteMany({ workspaceId: ws._id, ts: { $lt: cutoff } });
      const n = r.deletedCount ?? 0;
      if (n > 0) { summary.workspacesPurged++; summary.deleted += n; }
    } catch (err) {
      // One workspace failing must not stop the sweep for the others.
      console.error(`[retention] purge failed for workspace ${ws._id}:`, (err as Error).message);
    }
  }
  return summary;
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic sweep. Runs once shortly after boot, then on an interval. */
export function startRetentionJob(): void {
  if (timer) return;
  const run = async () => {
    try {
      const s = await purgeExpiredAuditLogs();
      if (s.deleted > 0) {
        console.log(`[retention] purged ${s.deleted} audit entries across ${s.workspacesPurged} workspace(s)`);
      }
    } catch (err) {
      console.error("[retention] sweep failed:", (err as Error).message);
    }
  };
  // Delay the first run so it never competes with startup work.
  setTimeout(run, 30_000).unref();
  timer = setInterval(run, config.auditPurgeIntervalMs);
  timer.unref();
}

export function stopRetentionJob(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
