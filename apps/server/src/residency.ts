/**
 * Data residency — region pinning, and honesty about what pinning covers.
 *
 * A deployment stores data in exactly one place: the database `MONGO_URI` points
 * at. So residency cannot be a per-workspace switch that one process honours by
 * itself — that would be a label, not a guarantee. What it can be is two things
 * this module owns:
 *
 *   1. A workspace is **pinned** to the region of the deployment that created
 *      it, once, and never again. Every subsequent request for that workspace is
 *      refused unless it arrived at a deployment declaring that same region —
 *      including the realtime path, which is where the document contents
 *      actually flow, and including reads, because serving a read from
 *      elsewhere is exactly the thing a residency commitment forbids.
 *
 *   2. Pinning storage does not pin **processing**. Anything that hands the
 *      contents to a third party leaves the region no matter which database the
 *      rows are in, so those features are refused in a pinned workspace unless
 *      the operator has declared otherwise. The list is in `@yumi/shared` and is
 *      shown in the admin console, not buried here.
 *
 * The enforced topology is one database with regional application tiers, which
 * is what this codebase is. Giving each region its own database is a deployment
 * change beyond this module — but it is also the case where the app-level check
 * matters least, because a foreign region's database simply would not hold the
 * workspace. The shared-cluster case is the one where this code is the only
 * thing standing between a promise and a violation of it.
 */
import {
  isRegionId,
  RESIDENCY_EGRESS_FEATURES,
  REGION_MISMATCH_CODE,
  type RegionInfo,
  type RegionMismatch,
  type ResidencyEgressFeature,
  type ResidencyStatus,
} from "@yumi/shared";
import { redis } from "./db.js";
import { audit } from "./auth.js";

interface ResidencyConfig {
  /** This deployment's region, or null when residency is not configured. */
  region: string | null;
  regions: RegionInfo[];
  /** Features the operator accepts sending out of region. */
  allowEgress: Set<string>;
  /** Region the AI endpoint runs in, if the operator has declared one. */
  aiRegion: string | null;
}

let cached: ResidencyConfig | null = null;

/**
 * Config from env:
 *   REGION=eu                       this deployment's region ("" = residency off)
 *   REGIONS=eu,us                   the fleet, so a refusal can point somewhere
 *   REGION_EU_LABEL=EU (Frankfurt)
 *   REGION_EU_URL=https://eu.example
 *   RESIDENCY_ALLOW_EGRESS=slack,github   (or "all")
 *   AI_REGION=eu                    the model endpoint's own region
 *
 * Per-region keys follow the same shape as the OIDC provider blocks, so there is
 * one convention for "a list plus per-item settings" rather than two.
 */
export function loadResidency(env: NodeJS.ProcessEnv = process.env): ResidencyConfig {
  const raw = (env.REGION ?? "").trim().toLowerCase();
  const region = raw && isRegionId(raw) ? raw : null;
  if (raw && !region) {
    // Refusing to guess: a malformed region id would produce a deployment that
    // claims a residency it cannot be matched against.
    throw new Error(`Invalid REGION "${raw}": expected lowercase letters, digits and dashes (e.g. "eu", "us-east").`);
  }

  const ids = (env.REGIONS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // The deployment's own region is always known, even if REGIONS omits it.
  if (region && !ids.includes(region)) ids.unshift(region);

  const regions: RegionInfo[] = [];
  for (const id of ids) {
    if (!isRegionId(id)) {
      console.warn(`[residency] ignoring malformed region id in REGIONS: "${id}"`);
      continue;
    }
    if (regions.some((r) => r.id === id)) continue;
    const key = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const url = (env[`REGION_${key}_URL`] ?? "").trim().replace(/\/$/, "");
    regions.push({
      id,
      label: env[`REGION_${key}_LABEL`]?.trim() || id,
      url: url || null,
      self: id === region,
    });
  }

  const allowRaw = (env.RESIDENCY_ALLOW_EGRESS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowEgress = new Set<string>();
  for (const name of allowRaw) {
    if (name === "all") {
      for (const f of RESIDENCY_EGRESS_FEATURES) allowEgress.add(f.id);
      continue;
    }
    if (!RESIDENCY_EGRESS_FEATURES.some((f) => f.id === name)) {
      // Named but unrecognised: say so rather than quietly leaving a feature
      // blocked the operator believes they enabled.
      console.warn(`[residency] RESIDENCY_ALLOW_EGRESS mentions unknown feature "${name}" — ignored`);
      continue;
    }
    allowEgress.add(name);
  }

  const aiRaw = (env.AI_REGION ?? "").trim().toLowerCase();
  return { region, regions, allowEgress, aiRegion: aiRaw && isRegionId(aiRaw) ? aiRaw : null };
}

function cfg(): ResidencyConfig {
  if (!cached) cached = loadResidency();
  return cached;
}

/** Test seam: re-read env after changing it. */
export function resetResidency(): void {
  cached = null;
}

/**
 * Parse at boot rather than on the first request, and say what is in force.
 * A deployment whose REGION is malformed should refuse to start: the alternative
 * is a process that looks healthy and serves every pinned workspace a 421.
 */
export function initResidency(): void {
  const c = cfg();
  if (!c.region) {
    console.log("[residency] not configured (REGION unset) — new workspaces are unpinned");
    return;
  }
  const others = c.regions.filter((r) => !r.self).map((r) => r.id);
  console.log(
    `[residency] serving region "${c.region}"` +
    (others.length ? ` · knows ${others.join(", ")}` : " · no other regions configured") +
    ` · out-of-region features allowed: ${c.allowEgress.size ? [...c.allowEgress].join(", ") : "none"}` +
    (c.aiRegion ? ` · AI endpoint declared in "${c.aiRegion}"` : "")
  );
}

/** This deployment's region, or null when residency is not configured here. */
export function deploymentRegion(): string | null {
  return cfg().region;
}

/** Regions this deployment can point a caller at. */
export function knownRegions(): RegionInfo[] {
  return cfg().regions;
}

/** The region a new workspace would be pinned to. null = pin nothing. */
export function pinForNewWorkspace(): string | null {
  return cfg().region;
}

function regionLabel(id: string): string {
  return cfg().regions.find((r) => r.id === id)?.label ?? id;
}
function regionUrl(id: string): string | null {
  return cfg().regions.find((r) => r.id === id)?.url ?? null;
}

/**
 * Whether this deployment may serve a workspace pinned to `pinned`.
 *
 * An unpinned workspace returns null (allowed): every workspace that existed
 * before residency shipped is unpinned, and so is every workspace on a
 * deployment that never set REGION. Residency has to be opt-in per workspace or
 * turning it on for one customer would lock out everybody else.
 *
 * A pinned workspace on a deployment with no region declared is a **mismatch**,
 * not a pass. Failing open here would mean writing data whose required location
 * this process cannot even name — and unlike a revoked session, data written to
 * the wrong country cannot be un-written once the mistake is noticed.
 */
export function regionMismatch(pinned: string | null | undefined): RegionMismatch | null {
  if (!pinned) return null;
  const self = cfg().region;
  if (self === pinned) return null;

  const url = regionUrl(pinned);
  const where = url ? ` Continue at ${url}.` : "";
  const error = self
    ? `This workspace's data is held in ${regionLabel(pinned)}, and this is the ${regionLabel(self)} deployment.${where}`
    : `This workspace's data is held in ${regionLabel(pinned)}, and this deployment does not declare a region, so it cannot serve it.${where}`;

  return {
    error,
    code: REGION_MISMATCH_CODE,
    servedBy: self ?? "unconfigured",
    region: pinned,
    redirectTo: url,
  };
}

/**
 * Record a cross-region attempt — it is the signal that something is pointed at
 * the wrong deployment, or that someone is trying to be.
 *
 * Deduplicated per workspace+user for ten minutes: a misconfigured client
 * retries on a timer, and an audit log flooded by one loop is a log nobody can
 * read. The first attempt in each window is always recorded.
 */
export async function auditRegionBlock(
  workspaceId: string,
  userId: string | undefined,
  detail: { path?: string; via: string; region: string; ip?: string },
): Promise<void> {
  try {
    const key = `residency:blocked:${workspaceId}:${userId ?? "anon"}:${detail.via}`;
    const first = await redis.set(key, "1", "EX", 600, "NX");
    if (first !== "OK") return;
  } catch {
    // Redis unavailable — record it rather than dropping the event.
  }
  const { ip, ...meta } = detail;
  await audit({
    workspaceId,
    actorId: userId,
    action: "residency.blocked",
    target: { workspaceId },
    meta: { ...meta, servedBy: cfg().region ?? "unconfigured" },
    ip,
  });
}

/* ------------------------------- Egress ---------------------------------- */

/**
 * Why `feature` is refused for a workspace pinned to `pinned`, or null if it is
 * allowed. Allowed means one of two different things, and the distinction is
 * kept because they are not equally strong claims:
 *
 *   - the operator declared the feature's processing to be in-region (AI_REGION)
 *   - the operator accepted that it leaves the region (RESIDENCY_ALLOW_EGRESS)
 */
export function egressBlockReason(
  pinned: string | null | undefined,
  feature: ResidencyEgressFeature,
): string | null {
  if (!pinned) return null; // nothing pinned, nothing promised
  const c = cfg();
  if (c.allowEgress.has(feature)) return null;
  if (feature === "ai" && c.aiRegion && c.aiRegion === pinned) return null;

  const meta = RESIDENCY_EGRESS_FEATURES.find((f) => f.id === feature)!;
  return (
    `${meta.label} is unavailable in a workspace pinned to ${regionLabel(pinned)}: ${meta.detail} ` +
    `An operator can enable it by setting ${meta.declaredBy}.`
  );
}

/** True when the feature would be refused — for callers that only need the flag. */
export function egressBlocked(pinned: string | null | undefined, feature: ResidencyEgressFeature): boolean {
  return egressBlockReason(pinned, feature) !== null;
}

/** Log a refused out-of-region feature. Deduplicated like the region block. */
export async function auditEgressBlock(
  workspaceId: string | null,
  userId: string | undefined,
  feature: ResidencyEgressFeature,
  region: string,
): Promise<void> {
  try {
    const key = `residency:egress:${workspaceId ?? "-"}:${userId ?? "anon"}:${feature}`;
    if ((await redis.set(key, "1", "EX", 600, "NX")) !== "OK") return;
  } catch {
    /* record it anyway */
  }
  await audit({
    workspaceId: workspaceId ?? undefined,
    actorId: userId,
    action: "residency.egress.blocked",
    meta: { feature, region },
  });
}

/* ------------------------------- Status ---------------------------------- */

/** What the admin console shows for a workspace. Includes what is *not* covered. */
export function residencyStatus(pinned: string | null | undefined): ResidencyStatus {
  const c = cfg();
  const blockedEgress: ResidencyStatus["blockedEgress"] = [];
  const allowedEgress: ResidencyStatus["allowedEgress"] = [];
  for (const f of RESIDENCY_EGRESS_FEATURES) {
    if (egressBlocked(pinned, f.id)) {
      blockedEgress.push({ id: f.id, label: f.label, detail: f.detail, declaredBy: f.declaredBy });
    } else {
      allowedEgress.push({ id: f.id, label: f.label });
    }
  }
  return {
    deploymentRegion: c.region,
    pinnedRegion: pinned ?? null,
    inRegion: regionMismatch(pinned) === null,
    regions: c.regions,
    blockedEgress,
    allowedEgress,
  };
}
