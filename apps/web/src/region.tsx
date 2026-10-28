/**
 * Data residency, client side.
 *
 * The server refuses any request for a workspace pinned to another region (421,
 * see residency.ts). That refusal is not an error the user made, so it must not
 * be rendered as one: it carries the region the data actually lives in and, when
 * the operator configured one, its address. This module owns both the
 * "continue over there" screen and the small badge that says where a workspace
 * is held.
 *
 * The link target always comes from the server's own region registry. Nothing
 * the caller supplied is ever followed — the same reason the SSO `returnTo` is
 * restricted to a relative path.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, isRegionMismatch, type RegionInfo, type RegionMismatch } from "./api";

/** Where this deployment stores data. null while loading, or when unconfigured. */
export function useDeploymentRegions() {
  const [state, setState] = useState<{ region: string | null; regions: RegionInfo[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api.getRegions()
      .then((r) => { if (alive) setState(r); })
      // A deployment that predates residency has no such route; that is not an
      // error worth showing anyone, it just means there is no region to name.
      .catch(() => { if (alive) setState({ region: null, regions: [] }); });
    return () => { alive = false; };
  }, []);
  return state;
}

/**
 * The wrong-region screen. Deliberately not an auto-redirect: sending a browser
 * to another host without being asked is indistinguishable from a hijack, and
 * the person may want to know why their bookmark stopped working.
 */
export function RegionNotice({ detail, backTo = "/" }: { detail: RegionMismatch; backTo?: string }) {
  return (
    <div className="center-screen">
      <div className="card" style={{ padding: 32, maxWidth: 520, textAlign: "center", display: "grid", gap: 14 }}>
        <div className="display" style={{ fontSize: 40, color: "var(--border-strong)" }}>◍</div>
        <h3 style={{ margin: 0 }}>This workspace is held in another region</h3>
        <p style={{ margin: 0, color: "var(--ink-secondary)", lineHeight: 1.5 }}>{detail.error}</p>
        {detail.redirectTo ? (
          <a className="btn btn-primary" href={detail.redirectTo} rel="noreferrer">
            Continue in {detail.region}
          </a>
        ) : (
          <div className="meta">
            No address is configured for “{detail.region}” — ask an administrator which deployment to use.
          </div>
        )}
        <Link className="meta" to={backTo}>← Back</Link>
      </div>
    </div>
  );
}

/**
 * Catch a cross-region refusal in a page's loading path.
 *
 * Returns the mismatch to render, or rethrows anything else — a page should not
 * quietly swallow real errors to get this behaviour.
 */
export function asRegionMismatch(e: unknown): RegionMismatch | null {
  return isRegionMismatch(e) ? e.detail : null;
}

/** The "held in <region>" badge, for a topbar or a workspace card. */
export function RegionChip({ region, label }: { region: string; label?: string }) {
  return (
    <span
      className="chip"
      title={`This workspace's data is stored in ${label ?? region} and is only served by that deployment. Fixed when the workspace was created.`}
    >
      ◍ {label ?? region}
    </span>
  );
}
