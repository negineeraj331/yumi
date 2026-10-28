/**
 * SSO sign-in over OpenID Connect (authorization code + PKCE).
 *
 * Threats this guards against, and how:
 *  - CSRF on the callback      → `state` is single-use, server-generated, and
 *                                held in Redis; a replayed one is refused.
 *  - Token replay across flows → `nonce` is bound into the ID token and checked.
 *  - Stolen authorization code → PKCE: the code is useless without the verifier,
 *                                which never leaves the server.
 *  - Open redirect             → the post-login destination must be a relative
 *                                path on this app; anything else is discarded.
 *  - Account takeover          → an existing account is only ever linked when the
 *                                provider says the email is verified.
 */
import { Router } from "express";
import { redis } from "../db.js";
import { config } from "../config.js";
import {
  getProviders, getProvider, discover, buildAuthUrl, exchangeCode,
  verifyIdToken, createPkce, randomToken,
} from "../oidc.js";
import { issueRefreshToken, audit, clientIp } from "../auth.js";
import { safeReturnPath, failToLogin as fail, resolveSsoUser } from "../ssoIdentity.js";
import { samlProvidersForLogin } from "./saml.routes.js";

const router = Router();

/** Sign-in attempts are short-lived; 10 minutes is generous for a login. */
const FLOW_TTL_SEC = 600;
const flowKey = (state: string) => `sso:flow:${state}`;

const callbackUrl = (providerId: string) =>
  `${config.publicUrl}/api/auth/sso/${encodeURIComponent(providerId)}/callback`;

/**
 * Which providers the login page should offer, across both protocols. Never
 * exposes a client secret or a certificate — only what a button needs.
 */
router.get("/providers", (_req, res) => {
  res.json({
    providers: [
      ...getProviders().map((p) => ({
        id: p.id,
        label: p.label,
        protocol: "oidc" as const,
        startPath: `/api/auth/sso/${encodeURIComponent(p.id)}/start`,
      })),
      ...samlProvidersForLogin().map(({ id, label, protocol, startPath }) => ({ id, label, protocol, startPath })),
    ],
  });
});

/** Begin sign-in: stash the flow secrets server-side and bounce to the IdP. */
router.get("/:provider/start", async (req, res) => {
  const provider = getProvider(req.params.provider);
  if (!provider) return fail(res, "Unknown sign-in provider");

  const state = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = createPkce();
  const returnTo = safeReturnPath(req.query.returnTo);

  try {
    // The verifier and nonce stay here — the browser only ever carries `state`.
    await redis.set(
      flowKey(state),
      JSON.stringify({ provider: provider.id, nonce, verifier, returnTo }),
      "EX", FLOW_TTL_SEC,
    );
    res.redirect(await buildAuthUrl(provider, {
      redirectUri: callbackUrl(provider.id), state, nonce, codeChallenge: challenge,
    }));
  } catch (e: any) {
    console.error("[sso] start failed:", e?.message);
    fail(res, "Could not reach the sign-in provider");
  }
});

/** Provider returns here with ?code&state. */
router.get("/:provider/callback", async (req, res) => {
  const provider = getProvider(req.params.provider);
  if (!provider) return fail(res, "Unknown sign-in provider");

  const { code, state, error } = req.query as Record<string, string>;
  if (error) return fail(res, `Provider reported: ${error}`);
  if (!code || !state) return fail(res, "Incomplete response from the provider");

  // Single-use: consume the flow before doing anything else, so a replayed
  // callback finds nothing left to use.
  const raw = await redis.getdel(flowKey(state));
  if (!raw) return fail(res, "This sign-in link has expired or was already used");

  let flow: { provider: string; nonce: string; verifier: string; returnTo: string };
  try { flow = JSON.parse(raw); } catch { return fail(res, "Corrupt sign-in state"); }
  // State must belong to the provider it came back on.
  if (flow.provider !== provider.id) return fail(res, "Sign-in state does not match this provider");

  try {
    const tokens = await exchangeCode(provider, {
      code, codeVerifier: flow.verifier, redirectUri: callbackUrl(provider.id),
    });
    if (!tokens.id_token) throw new Error("Provider returned no ID token");

    const claims = await verifyIdToken(provider, tokens.id_token, flow.nonce);
    // `email_verified` is this protocol's answer to "may this address be
    // trusted?"; SAML answers the same question from configuration.
    const user = await resolveSsoUser(
      provider.id,
      { sub: claims.sub, email: claims.email, name: claims.name, emailTrusted: claims.emailVerified },
      clientIp(req),
    );
    // A directory can keep asserting an identity after the account has been
    // deprovisioned here; SSO must not be a way back in.
    if (user.status !== "active") throw new Error("This account has been deactivated");

    const refreshToken = await issueRefreshToken(String(user._id));
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true, sameSite: "lax", secure: config.env === "production",
      path: "/api/auth", maxAge: config.jwt.refreshTtl * 1000,
    });
    await audit({ actorId: String(user._id), action: "auth.sso.login", meta: { provider: provider.id }, ip: clientIp(req) });

    // The access token is fetched by the client via /auth/refresh — keeping it
    // out of the URL means it never lands in history or a Referer header.
    res.redirect(`${config.clientOrigin}${flow.returnTo}`);
  } catch (e: any) {
    console.error("[sso] callback failed:", e?.message);
    await audit({ action: "auth.sso.failed", meta: { provider: provider.id, reason: e?.message }, ip: clientIp(req) });
    fail(res, e?.message ?? "Sign-in failed");
  }
});

export default router;
