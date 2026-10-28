/**
 * SAML 2.0 sign-in endpoints.
 *
 * Threats, and where each is handled:
 *  - Forged assertion         → XML signature verified against the IdP's
 *                               certificate; the *signed* element is the one
 *                               read (saml.ts explains why that matters).
 *  - Unsolicited / replayed   → `InResponseTo` must match a request id this
 *    assertion                  deployment issued, and the id is consumed on
 *                               use, so a second attempt finds nothing.
 *  - Assertion aimed elsewhere→ audience must be this provider's own SP
 *                               entityID, which differs per provider.
 *  - Open redirect            → the destination is held server-side under an
 *                               opaque RelayState token and must be a relative
 *                               path; whatever the IdP echoes back is not used
 *                               as a URL.
 *  - Account takeover         → an existing account is only linked when the
 *                               deployment has declared the IdP's email
 *                               assertions trustworthy (ssoIdentity.ts).
 */
import { Router, urlencoded } from "express";
import { redis } from "../db.js";
import { config } from "../config.js";
import { issueRefreshToken, audit, clientIp } from "../auth.js";
import { safeReturnPath, failToLogin, resolveSsoUser } from "../ssoIdentity.js";
import {
  getSamlProviders, getSamlProvider, samlFor, claimsFromProfile, acsUrl, randomRelayState,
} from "../saml.js";

const router = Router();

// The ACS receives a form POST, which nothing else in this API does — so the
// parser is mounted here rather than widening what the whole app accepts.
router.use(urlencoded({ extended: false, limit: "1mb" }));

/** A sign-in attempt is short-lived; 10 minutes is generous. */
const FLOW_TTL_SEC = 600;
const relayKey = (token: string) => `saml:relay:${token}`;

/** Begin sign-in: stash the destination server-side, bounce to the IdP. */
router.get("/:provider/login", async (req, res) => {
  const provider = getSamlProvider(req.params.provider);
  if (!provider) return failToLogin(res, "Unknown sign-in provider");

  const relayState = randomRelayState();
  const returnTo = safeReturnPath(req.query.returnTo);

  try {
    // RelayState is echoed back by the IdP verbatim, so it carries an opaque
    // token rather than the destination itself — there is then nothing in it
    // an attacker could rewrite into a URL of their choosing.
    await redis.set(relayKey(relayState), JSON.stringify({ provider: provider.id, returnTo }),
      "EX", FLOW_TTL_SEC);
    const url = await samlFor(provider).getAuthorizeUrlAsync(relayState, undefined, {});
    res.redirect(url);
  } catch (e: any) {
    console.error("[saml] login failed:", e?.message);
    failToLogin(res, "Could not start sign-in with that provider");
  }
});

/** The IdP posts the assertion here. */
router.post("/:provider/acs", async (req, res) => {
  const provider = getSamlProvider(req.params.provider);
  if (!provider) return failToLogin(res, "Unknown sign-in provider");

  const body = (req.body ?? {}) as Record<string, string>;
  if (!body.SAMLResponse) return failToLogin(res, "No SAML response was posted");

  // Consume the flow first, so a replayed post finds nothing left to use even
  // before the assertion itself is looked at.
  let returnTo = "/";
  if (body.RelayState) {
    const raw = await redis.getdel(relayKey(body.RelayState));
    if (raw) {
      try {
        const flow = JSON.parse(raw);
        // A relay token minted for one provider must not be spent at another's
        // endpoint.
        if (flow.provider === provider.id) returnTo = safeReturnPath(flow.returnTo);
      } catch { /* fall back to "/" */ }
    }
  }

  try {
    const { profile, loggedOut } = await samlFor(provider).validatePostResponseAsync(body);
    if (loggedOut || !profile) throw new Error("That was not a sign-in assertion");

    // The library's `idpIssuer` option only guards logout messages — it is not
    // consulted on the sign-in path (verified against the installed version, and
    // covered by a test). Configuring an expected issuer and not enforcing it
    // would be exactly the decorative setting this codebase keeps refusing to
    // ship, so the check happens here. `profile.issuer` is read from the signed
    // assertion, so it is the IdP's authenticated claim about itself, not an
    // attacker-chosen envelope value.
    if (profile.issuer !== provider.idpIssuer) {
      throw new Error(
        `The assertion came from an unexpected issuer (expected ${provider.idpIssuer})`);
    }

    const claims = claimsFromProfile(profile);
    const user = await resolveSsoUser(
      provider.id,
      { ...claims, emailTrusted: provider.trustEmail },
      clientIp(req),
      // An enterprise IdP exists to provision its own people on first sign-in;
      // see ssoIdentity.ts for why creating differs from linking here.
      { createWithUntrustedEmail: true },
    );
    // A directory can keep asserting an identity after the account has been
    // deprovisioned here; SSO must not be a way back in.
    if (user.status !== "active") throw new Error("This account has been deactivated");

    const refreshToken = await issueRefreshToken(String(user._id));
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true, sameSite: "lax", secure: config.env === "production",
      path: "/api/auth", maxAge: config.jwt.refreshTtl * 1000,
    });
    await audit({
      actorId: String(user._id), action: "auth.sso.login",
      meta: { provider: provider.id, protocol: "saml" }, ip: clientIp(req),
    });
    res.redirect(`${config.clientOrigin}${returnTo}`);
  } catch (e: any) {
    console.error("[saml] assertion rejected:", e?.message);
    await audit({
      action: "auth.sso.failed",
      meta: { provider: provider.id, protocol: "saml", reason: e?.message }, ip: clientIp(req),
    });
    failToLogin(res, e?.message ?? "Sign-in failed");
  }
});

/**
 * SP metadata, for pasting into the IdP. Public by necessity — it is the
 * document an administrator has to hand over, and it contains only this
 * deployment's own entityID and ACS URL.
 */
router.get("/:provider/metadata", (req, res) => {
  const provider = getSamlProvider(req.params.provider);
  if (!provider) return res.status(404).json({ error: "Unknown sign-in provider" });
  res.type("application/xml").send(samlFor(provider).generateServiceProviderMetadata(null, null));
});

/** Which SAML providers exist, for the login page. Never exposes a certificate. */
export function samlProvidersForLogin() {
  return getSamlProviders().map((p) => ({
    id: p.id,
    label: p.label,
    protocol: "saml" as const,
    startPath: `/api/auth/sso/saml/${encodeURIComponent(p.id)}/login`,
    acsUrl: acsUrl(p.id),
  }));
}

export default router;
