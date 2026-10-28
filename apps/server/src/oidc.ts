/**
 * OpenID Connect client — authorization code flow with PKCE.
 *
 * Works with any spec-compliant provider (Google, Okta, Auth0, Entra) via the
 * discovery document, so adding one is configuration rather than code. GitHub
 * is deliberately NOT supported here: it speaks plain OAuth2 with no ID token,
 * so it would need a different, less verifiable trust path.
 *
 * Everything security-relevant is enforced locally rather than trusted from the
 * provider's response: the ID token signature is checked against the issuer's
 * JWKS, and iss/aud/exp/iat/nonce are all verified. A token that merely *looks*
 * well-formed is never enough.
 *
 * Uses node's built-in JWK→KeyObject conversion, so no extra dependency.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

export interface OidcProvider {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

/**
 * Providers come from env: OIDC_PROVIDERS=google,okta plus
 * OIDC_<NAME>_{ISSUER,CLIENT_ID,CLIENT_SECRET,LABEL,SCOPES}.
 * A bare GOOGLE_CLIENT_ID/SECRET is also honoured, so the Phase 0 scaffolding
 * keeps working without being rewritten.
 */
export function loadProviders(env: NodeJS.ProcessEnv = process.env): OidcProvider[] {
  const out: OidcProvider[] = [];
  const names = (env.OIDC_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  for (const name of names) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const issuer = env[`OIDC_${key}_ISSUER`];
    const clientId = env[`OIDC_${key}_CLIENT_ID`];
    const clientSecret = env[`OIDC_${key}_CLIENT_SECRET`];
    if (!issuer || !clientId || !clientSecret) continue;
    out.push({
      id: name.toLowerCase(),
      label: env[`OIDC_${key}_LABEL`] ?? name,
      issuer: issuer.replace(/\/$/, ""),
      clientId,
      clientSecret,
      scopes: env[`OIDC_${key}_SCOPES`] ?? "openid email profile",
    });
  }

  if (!out.some((p) => p.id === "google") && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.push({
      id: "google", label: "Google",
      issuer: "https://accounts.google.com",
      clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
      scopes: "openid email profile",
    });
  }
  return out;
}

let providers: OidcProvider[] | null = null;
export function getProviders(): OidcProvider[] {
  if (!providers) providers = loadProviders();
  return providers;
}
export function getProvider(id: string): OidcProvider | undefined {
  return getProviders().find((p) => p.id === id);
}
/** Test seam: re-read providers after env changes. */
export function resetProviders(): void { providers = null; discoveryCache.clear(); jwksCache.clear(); }

/* ------------------------------- Discovery ------------------------------- */

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  fetchedAt: number;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, Discovery>();

export async function discover(provider: OidcProvider): Promise<Discovery> {
  const cached = discoveryCache.get(provider.issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached;

  const res = await fetch(`${provider.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Could not read the provider's OpenID configuration (${res.status})`);
  const d = await res.json();

  // The issuer in the document must match where we fetched it from, or a
  // compromised discovery URL could point tokens at a different issuer.
  if (String(d.issuer).replace(/\/$/, "") !== provider.issuer) {
    throw new Error("Provider issuer mismatch in discovery document");
  }
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (!d[field]) throw new Error(`Provider discovery is missing ${field}`);
  }
  const entry: Discovery = {
    issuer: provider.issuer,
    authorization_endpoint: d.authorization_endpoint,
    token_endpoint: d.token_endpoint,
    jwks_uri: d.jwks_uri,
    fetchedAt: Date.now(),
  };
  discoveryCache.set(provider.issuer, entry);
  return entry;
}

/* --------------------------------- JWKS ---------------------------------- */

interface JwksEntry { keys: Map<string, crypto.KeyObject>; fetchedAt: number }
const jwksCache = new Map<string, JwksEntry>();
const JWKS_MIN_REFETCH_MS = 5 * 60 * 1000;

async function fetchJwks(uri: string): Promise<JwksEntry> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Could not fetch the provider's signing keys (${res.status})`);
  const body = await res.json();
  const keys = new Map<string, crypto.KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid) continue;
    // Signing keys only — an encryption key must never validate a signature.
    if (jwk.use && jwk.use !== "sig") continue;
    try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" })); }
    catch { /* unusable key type; skip rather than fail the whole set */ }
  }
  const entry = { keys, fetchedAt: Date.now() };
  jwksCache.set(uri, entry);
  return entry;
}

/** Key for `kid`, refetching once if it's unknown (providers rotate keys). */
async function keyFor(uri: string, kid: string): Promise<crypto.KeyObject> {
  let entry = jwksCache.get(uri);
  if (!entry) entry = await fetchJwks(uri);
  let key = entry.keys.get(kid);
  if (!key && Date.now() - entry.fetchedAt > JWKS_MIN_REFETCH_MS) {
    entry = await fetchJwks(uri);
    key = entry.keys.get(kid);
  }
  if (!key) throw new Error("The provider signed with a key we don't recognise");
  return key;
}

/* --------------------------------- PKCE ---------------------------------- */

const b64url = (b: Buffer) => b.toString("base64url");

export function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomToken = () => b64url(crypto.randomBytes(32));

/* ------------------------------ Authorize -------------------------------- */

export async function buildAuthUrl(provider: OidcProvider, args: {
  redirectUri: string; state: string; nonce: string; codeChallenge: string;
}): Promise<string> {
  const d = await discover(provider);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", provider.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("scope", provider.scopes);
  u.searchParams.set("state", args.state);
  u.searchParams.set("nonce", args.nonce);
  u.searchParams.set("code_challenge", args.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/* ------------------------------ Token swap ------------------------------- */

export async function exchangeCode(provider: OidcProvider, args: {
  code: string; codeVerifier: string; redirectUri: string;
}): Promise<{ id_token?: string; access_token?: string }> {
  const d = await discover(provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: args.codeVerifier,
  });
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Provider rejected the sign-in: ${json.error ?? res.status}`);
  }
  return json;
}

/* --------------------------- ID token verify ----------------------------- */

export interface OidcClaims {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

/** Signature algorithms we accept. `none` and HMAC are excluded on purpose. */
const ALLOWED_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384"] as const;

/**
 * Verify an ID token completely. Anything short of this — decoding without
 * verifying, or skipping nonce — would let a forged token sign someone in.
 */
export async function verifyIdToken(
  provider: OidcProvider, idToken: string, expectedNonce: string,
): Promise<OidcClaims> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === "string") throw new Error("Malformed ID token");

  const alg = decoded.header.alg;
  if (!(ALLOWED_ALGS as readonly string[]).includes(alg)) {
    throw new Error(`Unsupported ID token algorithm: ${alg}`);
  }
  const kid = decoded.header.kid;
  if (!kid) throw new Error("ID token has no key id");

  const d = await discover(provider);
  const key = await keyFor(d.jwks_uri, kid);

  let claims: any;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: [alg as jwt.Algorithm],
      issuer: provider.issuer,
      audience: provider.clientId,
      clockTolerance: 60,
    });
  } catch (e: any) {
    throw new Error(`ID token rejected: ${e?.message ?? "invalid"}`);
  }

  // jwt.verify covers iss/aud/exp; nonce binding is ours to check and is what
  // stops a token minted for another sign-in being replayed into this one.
  if (!claims.nonce || claims.nonce !== expectedNonce) {
    throw new Error("ID token nonce does not match this sign-in");
  }
  if (!claims.sub) throw new Error("ID token has no subject");

  return {
    sub: String(claims.sub),
    email: claims.email ? String(claims.email).toLowerCase() : undefined,
    // Providers send this as a boolean or the string "true"; anything else is
    // treated as unverified, which is the safe default for account linking.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: claims.name ? String(claims.name) : undefined,
  };
}
