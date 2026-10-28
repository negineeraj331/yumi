/**
 * SAML 2.0 service provider (Web Browser SSO, HTTP-Redirect out / HTTP-POST back).
 *
 * **Why this one uses a library when OIDC did not.** The OIDC implementation
 * verifies a signature over a compact, unambiguous byte string, and node ships
 * everything needed for that — so writing it out was reviewable in a way that
 * left nothing to guess. SAML's signature is over an XML *tree*, verified after
 * exclusive canonicalisation, and essentially every historic SAML break is a
 * signature-wrapping attack: a mismatch between the element that was verified
 * and the element that was later read. Hand-rolling C14N would put that mismatch
 * in code written here. `@node-saml/node-saml` is the maintained implementation
 * of that machinery, and it reads the *signed* assertion rather than re-querying
 * the document, which is the property the whole protocol rests on.
 *
 * What this file owns is everything above the signature: which providers exist,
 * what is required of them, replay protection that works across processes, and
 * the deliberately strict defaults.
 *
 * Not implemented, and stated rather than implied: single logout (SLO), IdP-
 * initiated sign-in (there is no AuthnRequest to bind the response to, so
 * `InResponseTo` cannot be checked — accepting it would mean accepting an
 * unsolicited assertion), and encrypted assertions.
 */
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./db.js";

/** An opaque RelayState token. The IdP echoes it back, so it carries no meaning. */
export const randomRelayState = (): string => randomBytes(24).toString("base64url");

export interface SamlProvider {
  id: string;
  label: string;
  /** The IdP's SSO endpoint the browser is sent to. */
  entryPoint: string;
  /**
   * The IdP's entityID. Checked against the *signed* assertion's Issuer — in
   * saml.routes.ts rather than by the library, whose `idpIssuer` option turns
   * out to guard only logout messages.
   */
  idpIssuer: string;
  /** One or more X.509 certificates; several allows a rollover without downtime. */
  certs: string[];
  /** This SP's entityID, and the audience an assertion must name. */
  spEntityId: string;
  /**
   * Whether this IdP's word on an email address is good enough to attach the
   * identity to an account that already exists here. Off unless declared: see
   * ssoIdentity.ts for why that is the case worth gating.
   */
  trustEmail: boolean;
  /** Require the response envelope to be signed as well as the assertion. */
  wantResponseSigned: boolean;
  clockSkewMs: number;
}

/* ------------------------------- config ---------------------------------- */

/** Accept a bare base64 certificate body or a full PEM; node-saml wants the body. */
function normaliseCert(raw: string): string {
  return raw
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** ACS URL for a provider. Per-provider, so each IdP posts to its own endpoint. */
export const acsUrl = (id: string) =>
  `${config.publicUrl}/api/auth/sso/saml/${encodeURIComponent(id)}/acs`;

/**
 * SP entityID, per provider rather than one for the whole app.
 *
 * That makes each IdP's assertions audience-restricted to a different SP, so an
 * assertion minted by one configured IdP cannot be replayed into another's ACS
 * endpoint — which a single shared entityID would allow.
 */
export const spEntityId = (id: string) =>
  `${config.publicUrl}/api/auth/sso/saml/${encodeURIComponent(id)}/metadata`;

/**
 * Providers come from env, in the same shape as the OIDC blocks:
 *   SAML_PROVIDERS=okta
 *   SAML_OKTA_ENTRY_POINT=https://org.okta.com/app/.../sso/saml
 *   SAML_OKTA_IDP_ISSUER=http://www.okta.com/exk...
 *   SAML_OKTA_CERT=MIIC…            (comma-separate to allow a rollover)
 *   SAML_OKTA_LABEL=Okta
 *   SAML_OKTA_TRUST_EMAIL=true      (default false)
 *   SAML_OKTA_WANT_RESPONSE_SIGNED=true (default false — see below)
 */
export function loadSamlProviders(env: NodeJS.ProcessEnv = process.env): SamlProvider[] {
  const out: SamlProvider[] = [];
  const names = (env.SAML_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  for (const name of names) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const entryPoint = env[`SAML_${key}_ENTRY_POINT`];
    const idpIssuer = env[`SAML_${key}_IDP_ISSUER`];
    const certRaw = env[`SAML_${key}_CERT`];
    if (!entryPoint || !idpIssuer || !certRaw) {
      console.warn(`[saml] provider "${name}" is missing ENTRY_POINT, IDP_ISSUER or CERT — skipped`);
      continue;
    }
    const certs = certRaw.split(",").map(normaliseCert).filter(Boolean);
    if (!certs.length) {
      console.warn(`[saml] provider "${name}" has no usable certificate — skipped`);
      continue;
    }
    const id = name.toLowerCase();
    out.push({
      id,
      label: env[`SAML_${key}_LABEL`] ?? name,
      entryPoint,
      idpIssuer,
      certs,
      spEntityId: env[`SAML_${key}_SP_ENTITY_ID`] ?? spEntityId(id),
      trustEmail: env[`SAML_${key}_TRUST_EMAIL`] === "true",
      wantResponseSigned: env[`SAML_${key}_WANT_RESPONSE_SIGNED`] === "true",
      // Clocks between an SP and an IdP genuinely differ; a strict zero makes
      // sign-in fail intermittently in a way nobody can reproduce.
      clockSkewMs: Number(env[`SAML_${key}_CLOCK_SKEW_MS`] ?? 30_000),
    });
  }
  return out;
}

let providers: SamlProvider[] | null = null;
export function getSamlProviders(): SamlProvider[] {
  if (!providers) providers = loadSamlProviders();
  return providers;
}
export function getSamlProvider(id: string): SamlProvider | undefined {
  return getSamlProviders().find((p) => p.id === id);
}
/** Test seam: re-read providers after env changes. */
export function resetSamlProviders(): void {
  providers = null;
  instances.clear();
}

/* ---------------------------- replay protection --------------------------- */

/**
 * Where the ids of AuthnRequests we issued are held, so a response can be
 * matched to a request we actually made.
 *
 * In Redis rather than node-saml's in-memory default: this app runs as more than
 * one process (and is designed to), and an in-memory cache would mean a response
 * landing on a different process than the one that started the flow is refused
 * as unsolicited — turning a security control into an intermittent sign-in
 * failure that operators would be tempted to switch off.
 *
 * The entry is *consumed* on use, which is also what makes a replayed response
 * fail: the second attempt finds no matching request id.
 */
const REQUEST_TTL_SEC = 600; // a sign-in that takes longer than 10 minutes has failed
const requestKey = (id: string) => `saml:req:${id}`;

const redisCache: CacheProvider = {
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const stored = await redis.set(requestKey(key), value, "EX", REQUEST_TTL_SEC, "NX");
    // NX: never silently overwrite an id already in flight.
    return stored === "OK" ? { value, createdAt: Date.now() } : null;
  },
  async getAsync(key: string): Promise<string | null> {
    return redis.get(requestKey(key));
  },
  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    await redis.del(requestKey(key));
    return key;
  },
};

/* ------------------------------- instances -------------------------------- */

const instances = new Map<string, SAML>();

/** The configured SAML client for a provider, built once. */
export function samlFor(provider: SamlProvider): SAML {
  const cached = instances.get(provider.id);
  if (cached) return cached;

  const saml = new SAML({
    entryPoint: provider.entryPoint,
    callbackUrl: acsUrl(provider.id),
    issuer: provider.spEntityId,
    audience: provider.spEntityId,
    idpIssuer: provider.idpIssuer,
    idpCert: provider.certs,

    // The assertion signature is not optional, ever. The response envelope's own
    // signature is: every major IdP signs the assertion by default and many sign
    // nothing else, and with the assertion signed — and node-saml reading the
    // *signed* element rather than re-querying the document — the envelope
    // signature adds little. Deployments that want both can demand it.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: provider.wantResponseSigned,

    signatureAlgorithm: "sha256",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",

    // Always: a response that does not answer a request this deployment issued
    // is an unsolicited assertion, which is also how IdP-initiated sign-in and
    // replayed responses both look.
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_SEC * 1000,
    cacheProvider: redisCache,

    acceptedClockSkewMs: provider.clockSkewMs,
    // Leave the NameID format unconstrained: IdPs are configured to emit
    // persistent, transient, unspecified or emailAddress, and demanding one
    // breaks the connection for reasons the person configuring it cannot see.
    identifierFormat: null,
    // No AuthnRequest signing key is configured, so requests go out unsigned —
    // which is the common deployment and does not weaken the response check.
    disableRequestedAuthnContext: true,
  });

  instances.set(provider.id, saml);
  return saml;
}

/* -------------------------------- claims ---------------------------------- */

/** Attribute names IdPs actually use for an email address, in order of preference. */
const EMAIL_ATTRS = [
  "email",
  "mail",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
];
const NAME_ATTRS = [
  "displayName",
  "name",
  "cn",
  "urn:oid:2.16.840.1.113730.3.1.241",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
];

const firstString = (profile: Profile, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = profile[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return undefined;
};

/**
 * Reduce a validated assertion to the identity claims the rest of the app uses.
 *
 * The subject is the NameID: it is what the IdP guarantees is stable for this
 * person, and matching on it rather than on the email is what lets someone keep
 * their account when their address changes.
 */
export function claimsFromProfile(profile: Profile): { sub: string; email?: string; name?: string } {
  const nameId = typeof profile.nameID === "string" ? profile.nameID.trim() : "";
  if (!nameId) throw new Error("The assertion carried no NameID to identify the user");

  const email = firstString(profile, EMAIL_ATTRS)
    // A NameID in email format is itself the address, and some IdPs send
    // nothing else at all.
    ?? (nameId.includes("@") ? nameId : undefined);

  return {
    sub: nameId,
    email: email?.toLowerCase(),
    name: firstString(profile, NAME_ATTRS),
  };
}

/** Log what is configured at boot, the same way residency and OIDC do. */
export function initSaml(): void {
  const list = getSamlProviders();
  if (!list.length) return;
  console.log(
    `[saml] ${list.length} provider(s): ` +
    list.map((p) => `${p.id}${p.trustEmail ? " (email trusted)" : ""}`).join(", ")
  );
}
