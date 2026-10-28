/**
 * SAML 2.0 sign-in, end-to-end against a stub identity provider.
 *
 * The stub is a real IdP in every way that matters to the code under test: an
 * RSA keypair and a self-signed X.509 certificate generated for the run, and
 * assertions signed with genuine XML-DSig (exclusive canonicalisation, enveloped
 * signature, SHA-256). Everything the server is asked to accept or refuse is a
 * document that really was, or really was not, signed by that key.
 *
 * The attacks matter more than the happy path here, because a SAML SP that
 * accepts a valid assertion is easy and one that refuses every invalid one is
 * the entire job — most historic SAML breaks are signature wrapping, where the
 * element that was verified is not the element that was read.
 *
 * Needs Mongo + Redis up (pnpm infra:up) and openssl on PATH:
 *   node apps/web/test/saml.test.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { SignedXml } from "xml-crypto";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");
const PORT = 4111;
const BASE = `http://localhost:${PORT}`;
const CLIENT = "http://localhost:5173";
const uid = Date.now();

let pass = 0, fail = 0;
const check = (ok, label, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ the stub IdP ----------------------------- */

const keyDir = mkdtempSync(path.join(tmpdir(), "yumi-saml-"));
function makeKeypair(name) {
  const key = path.join(keyDir, `${name}.key`);
  const crt = path.join(keyDir, `${name}.crt`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", crt, "-days", "1", "-subj", `/CN=stub-idp-${name}`,
  ], { stdio: "ignore" });
  const pem = readFileSync(crt, "utf8");
  return {
    privateKey: readFileSync(key, "utf8"),
    certPem: pem,
    // What goes into env: the base64 body, which is how IdPs hand it over.
    certBody: pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, ""),
  };
}

const idp = makeKeypair("idp");
const attacker = makeKeypair("attacker");

const IDP_ISSUER = "http://stub-idp.test/metadata";
const ENTRY_POINT = "http://stub-idp.test/sso";
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/**
 * Build a SAML Response. Every deviation used by a test is a parameter, so the
 * attack cases differ from the valid one in exactly one respect.
 */
function buildResponse({
  provider,
  inResponseTo,
  email,
  nameId = email,
  displayName = "SAML User",
  audience,                       // defaults to the provider's SP entityID
  notOnOrAfter = iso(5 * 60_000),
  notBefore = iso(-60_000),
  issuer = IDP_ISSUER,
  sign = true,
  signingKey = idp,
  tamperAfterSigning = null,      // (xml) => xml
  wrap = false,                   // signature wrapping (XSW)
}) {
  const acs = `${BASE}/api/auth/sso/saml/${provider}/acs`;
  const aud = audience ?? `${BASE}/api/auth/sso/saml/${provider}/metadata`;
  const assertionId = `_a${Math.random().toString(36).slice(2)}`;
  const responseId = `_r${Math.random().toString(36).slice(2)}`;

  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
      `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
        `<saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${notOnOrAfter}" Recipient="${acs}"/>` +
      `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
      `<saml:AudienceRestriction><saml:Audience>${aud}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="${assertionId}">` +
      `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
      `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
      `<saml:Attribute Name="displayName"><saml:AttributeValue>${displayName}</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement>` +
  `</saml:Assertion>`;

  let signedAssertion = assertion;
  if (sign) {
    const sig = new SignedXml({
      privateKey: signingKey.privateKey,
      publicCert: signingKey.certPem,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: `//*[local-name(.)='Assertion']`,
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    sig.computeSignature(assertion, {
      location: { reference: `//*[local-name(.)='Issuer']`, action: "after" },
    });
    signedAssertion = sig.getSignedXml();
  }

  // Signature wrapping: keep the genuinely signed assertion in the document so
  // its signature still verifies, but put an unsigned attacker-authored one
  // where a naive implementation would look for the subject.
  const body = wrap
    ? `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evil" Version="2.0" IssueInstant="${iso(0)}">` +
        `<saml:Issuer>${issuer}</saml:Issuer>` +
        `<saml:Subject><saml:NameID>attacker@evil.test</saml:NameID>` +
          `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
            `<saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${notOnOrAfter}" Recipient="${acs}"/>` +
          `</saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
          `<saml:AudienceRestriction><saml:Audience>${aud}</saml:Audience></saml:AudienceRestriction>` +
        `</saml:Conditions>` +
        `<saml:AttributeStatement>` +
          `<saml:Attribute Name="email"><saml:AttributeValue>attacker@evil.test</saml:AttributeValue></saml:Attribute>` +
        `</saml:AttributeStatement>` +
        `<saml:Advice>${signedAssertion}</saml:Advice>` +
      `</saml:Assertion>`
    : signedAssertion;

  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acs}" InResponseTo="${inResponseTo}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    body +
  `</samlp:Response>`;

  if (tamperAfterSigning) xml = tamperAfterSigning(xml);
  return Buffer.from(xml, "utf8").toString("base64");
}

/* ------------------------------- the server ------------------------------ */

let child = null;
let serverLog = "";

async function startServer() {
  child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      CALL_MODE: "mesh",
      CLIENT_ORIGIN: CLIENT,
      PUBLIC_URL: BASE,
      REGION: "",
      SAML_PROVIDERS: "stub,trusted",
      SAML_STUB_ENTRY_POINT: ENTRY_POINT,
      SAML_STUB_IDP_ISSUER: IDP_ISSUER,
      SAML_STUB_CERT: idp.certBody,
      SAML_STUB_LABEL: "Stub IdP",
      // Deliberately NOT trusted: linking to an account that already exists must
      // be refused unless the deployment has said this IdP's email is good.
      SAML_TRUSTED_ENTRY_POINT: ENTRY_POINT,
      SAML_TRUSTED_IDP_ISSUER: IDP_ISSUER,
      SAML_TRUSTED_CERT: idp.certBody,
      SAML_TRUSTED_LABEL: "Trusted IdP",
      SAML_TRUSTED_TRUST_EMAIL: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { serverLog += d.toString(); });
  child.stderr.on("data", (d) => { serverLog += d.toString(); });

  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${serverLog}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await wait(200);
  }
  throw new Error(`server did not become healthy:\n${serverLog}`);
}

const stop = () => { try { child?.kill("SIGKILL"); } catch { /* gone */ } rmSync(keyDir, { recursive: true, force: true }); };

/* -------------------------------- helpers -------------------------------- */

/**
 * Clear this test's auth rate-limit counter.
 *
 * One sign-in is a handful of requests to /api/auth; a suite that drives thirty
 * of them from one address trips the 20/minute brute-force limit, which is the
 * limiter working correctly. Resetting the counter keeps the test measuring
 * SAML rather than the rate limiter — which has tests of its own upstream.
 */
async function clearAuthRateLimit() {
  const { default: Redis } = await import(path.join(SERVER_DIR, "node_modules/ioredis/built/index.js"));
  const r = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const keys = await r.keys("ratelimit:auth:*");
  if (keys.length) await r.del(...keys);
  await r.quit();
}

/**
 * Start a real sign-in and pull the AuthnRequest id out of the redirect, so the
 * assertion answers a request the server actually issued. Exercises the Redis
 * request cache as a side effect.
 */
async function beginLogin(provider, returnTo = "/") {
  await clearAuthRateLimit();
  const res = await fetch(
    `${BASE}/api/auth/sso/saml/${provider}/login?returnTo=${encodeURIComponent(returnTo)}`,
    { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const url = new URL(location);
  const deflated = Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64");
  const xml = zlib.inflateRawSync(deflated).toString("utf8");
  return {
    status: res.status,
    entryPoint: `${url.origin}${url.pathname}`,
    relayState: url.searchParams.get("RelayState"),
    requestId: xml.match(/ID="([^"]+)"/)?.[1] ?? null,
    xml,
  };
}

async function postAcs(provider, samlResponse, relayState) {
  await clearAuthRateLimit();
  const form = new URLSearchParams({ SAMLResponse: samlResponse });
  if (relayState) form.set("RelayState", relayState);
  const res = await fetch(`${BASE}/api/auth/sso/saml/${provider}/acs`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  const location = res.headers.get("location") ?? "";
  return {
    status: res.status,
    location,
    cookie: res.headers.get("set-cookie") ?? "",
    // A refusal always comes back as a redirect to the login page carrying the
    // reason; a success goes to the app.
    error: location.includes("sso_error")
      ? decodeURIComponent(new URL(location).searchParams.get("sso_error") ?? "")
      : null,
  };
}

/** One full valid sign-in, returning the ACS result. */
async function signIn(provider, email, overrides = {}) {
  const begin = await beginLogin(provider, overrides.returnTo ?? "/");
  const response = buildResponse({
    provider, inResponseTo: begin.requestId, email, ...overrides,
  });
  return { begin, response, acs: await postAcs(provider, response, overrides.relayState ?? begin.relayState) };
}

/* ---------------------------------- run ---------------------------------- */

async function main() {
  await startServer();
  await clearAuthRateLimit();
  check(/\[saml\] 2 provider\(s\)/.test(serverLog), "both providers load at boot", serverLog.slice(0, 200));

  /* ------------------------------ discovery ----------------------------- */
  const { providers } = await (await fetch(`${BASE}/api/auth/sso/providers`)).json();
  const stub = providers.find((p) => p.id === "stub");
  check(stub?.protocol === "saml" && stub?.startPath === "/api/auth/sso/saml/stub/login",
    "the login page is offered both protocols in one list", JSON.stringify(providers));

  const metadata = await (await fetch(`${BASE}/api/auth/sso/saml/stub/metadata`)).text();
  check(metadata.includes(`${BASE}/api/auth/sso/saml/stub/acs`)
    && metadata.includes(`entityID="${BASE}/api/auth/sso/saml/stub/metadata"`),
    "SP metadata names this provider's own ACS URL and entityID", metadata.slice(0, 160));
  check(metadata.includes(`WantAssertionsSigned="true"`),
    "and states that assertions must be signed");

  /* ------------------------------ happy path ---------------------------- */
  const begin = await beginLogin("stub", "/w/somewhere");
  check(begin.status === 302 && begin.entryPoint === ENTRY_POINT && Boolean(begin.requestId),
    "login redirects to the IdP with a fresh AuthnRequest", `${begin.status} ${begin.entryPoint}`);
  check(begin.relayState !== null && !begin.relayState.includes("/"),
    "RelayState is an opaque token, not the destination", String(begin.relayState));

  const email = `saml${uid}@corp.test`;
  const good = buildResponse({ provider: "stub", inResponseTo: begin.requestId, email });
  const acs = await postAcs("stub", good, begin.relayState);
  check(acs.status === 302 && acs.location === `${CLIENT}/w/somewhere`,
    "a valid assertion signs in and returns to where the user started", `${acs.status} ${acs.location}`);
  check(/refresh_token=/.test(acs.cookie) && /HttpOnly/i.test(acs.cookie),
    "and sets an httpOnly refresh cookie", acs.cookie.slice(0, 60));

  // The session is real: exchange the cookie for an access token and read the account.
  const refreshCookie = acs.cookie.split(";")[0];
  await clearAuthRateLimit();
  const refreshed = await fetch(`${BASE}/api/auth/refresh`, {
    method: "POST", headers: { cookie: refreshCookie },
  });
  const { accessToken } = await refreshed.json();
  const me = await (await fetch(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })).json();
  check(me.user?.email === email, "the account it created is usable", JSON.stringify(me));

  /* -------------------------------- replay ------------------------------ */
  const replayed = await postAcs("stub", good, begin.relayState);
  check(replayed.error !== null,
    "the same assertion cannot be posted twice", `${replayed.status} ${replayed.location}`);

  /* ------------------------------- attacks ------------------------------ */
  const attacks = [
    {
      name: "an unsigned assertion is refused",
      overrides: { sign: false },
    },
    {
      name: "an assertion signed by another key is refused",
      overrides: { signingKey: attacker },
    },
    {
      name: "an attribute changed after signing is refused",
      overrides: {
        tamperAfterSigning: (xml) => xml.replace(
          /<saml:Attribute Name="email"><saml:AttributeValue>[^<]+/,
          `<saml:Attribute Name="email"><saml:AttributeValue>attacker@evil.test`),
      },
    },
    {
      name: "a NameID changed after signing is refused",
      overrides: {
        tamperAfterSigning: (xml) => xml.replace(
          /(<saml:NameID[^>]*>)[^<]+/, `$1attacker@evil.test`),
      },
    },
    {
      name: "signature wrapping — an unsigned assertion beside a signed one — is refused",
      overrides: { wrap: true },
    },
    {
      name: "an assertion for another audience is refused",
      overrides: { audience: "https://someone-elses-sp.test/metadata" },
    },
    {
      name: "an expired assertion is refused",
      overrides: { notOnOrAfter: iso(-60_000), notBefore: iso(-120_000) },
    },
    {
      name: "an assertion not yet valid is refused",
      overrides: { notBefore: iso(10 * 60_000), notOnOrAfter: iso(20 * 60_000) },
    },
    {
      name: "an assertion from an unexpected issuer is refused",
      overrides: { issuer: "http://evil-idp.test/metadata" },
    },
  ];

  for (const { name, overrides } of attacks) {
    const b = await beginLogin("stub");
    const xml = buildResponse({
      provider: "stub", inResponseTo: b.requestId, email: `atk${uid}@corp.test`, ...overrides,
    });
    const r = await postAcs("stub", xml, b.relayState);
    check(r.error !== null && !/refresh_token=/.test(r.cookie), name, `${r.status} ${r.location}`);
  }

  // Unsolicited: a perfectly valid assertion that answers no request we made.
  const unsolicited = buildResponse({
    provider: "stub", inResponseTo: "_never-issued", email: `un${uid}@corp.test`,
  });
  const unsolicitedRes = await postAcs("stub", unsolicited, null);
  check(unsolicitedRes.error !== null,
    "an unsolicited assertion (no matching AuthnRequest) is refused",
    `${unsolicitedRes.status} ${unsolicitedRes.location}`);

  // Cross-provider: an assertion minted for "stub" replayed at "trusted"'s ACS.
  const bStub = await beginLogin("stub");
  const forOther = buildResponse({
    provider: "stub", inResponseTo: bStub.requestId, email: `x${uid}@corp.test`,
  });
  const crossed = await postAcs("trusted", forOther, bStub.relayState);
  check(crossed.error !== null,
    "an assertion for one provider cannot be spent at another's endpoint",
    `${crossed.status} ${crossed.location}`);

  /* --------------------------- open redirect ---------------------------- */
  for (const evil of ["https://evil.test/", "//evil.test/", "/\\evil.test"]) {
    const b = await beginLogin("stub", evil);
    const xml = buildResponse({
      provider: "stub", inResponseTo: b.requestId, email: `red${uid}@corp.test`,
    });
    const r = await postAcs("stub", xml, b.relayState);
    check(r.location.startsWith(CLIENT) && !r.location.includes("evil.test"),
      `returnTo "${evil}" cannot redirect off the app`, r.location);
  }

  // A RelayState the server never issued must not become a destination either.
  const bRelay = await beginLogin("stub");
  const relayXml = buildResponse({
    provider: "stub", inResponseTo: bRelay.requestId, email: `rel${uid}@corp.test`,
  });
  const relayRes = await postAcs("stub", relayXml, "https://evil.test/pwned");
  check(relayRes.location === `${CLIENT}/`,
    "a forged RelayState falls back to the app root", relayRes.location);

  /* ------------------------- account takeover --------------------------- */
  // An account that already exists, created with a password by its real owner.
  const victimEmail = `victim${uid}@corp.test`;
  await clearAuthRateLimit();
  await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: victimEmail, password: "password123", displayName: "Victim" }),
  });

  const takeover = await signIn("stub", victimEmail);
  check(takeover.acs.error !== null && /already registered/i.test(takeover.acs.error),
    "an untrusted IdP cannot attach itself to an account that already exists",
    takeover.acs.error ?? takeover.acs.location);

  const linked = await signIn("trusted", victimEmail);
  check(linked.acs.error === null && /refresh_token=/.test(linked.acs.cookie),
    "an IdP the deployment has declared trustworthy may link it",
    linked.acs.error ?? linked.acs.location);

  /* ----------------------------- provisioning --------------------------- */
  // First sign-in for someone with no account: allowed, because provisioning is
  // what an enterprise IdP is for, and a new address takes nothing over.
  const fresh = await signIn("stub", `new${uid}@corp.test`);
  check(fresh.acs.error === null, "a new person is provisioned on first sign-in",
    fresh.acs.error ?? "");

  /* ---------------------------- deprovisioned --------------------------- */
  // SSO must not be a way back in for an account whose access was withdrawn.
  const suspendEmail = `susp${uid}@corp.test`;
  const first = await signIn("stub", suspendEmail);
  check(first.acs.error === null, "baseline: the account signs in", first.acs.error ?? "");
  const mongoose = (await import(path.join(SERVER_DIR, "node_modules/mongoose/index.js"))).default;
  await mongoose.connect(process.env.MONGO_URI ?? "mongodb://localhost:27017/yumi");
  await mongoose.connection.db.collection("users")
    .updateOne({ email: suspendEmail }, { $set: { status: "suspended" } });
  await mongoose.disconnect();
  const afterSuspend = await signIn("stub", suspendEmail);
  check(/deactivated/i.test(afterSuspend.acs.error ?? ""),
    "a deprovisioned account cannot sign back in through SAML",
    afterSuspend.acs.error ?? afterSuspend.acs.location);

  /* -------------------------------- audit -------------------------------- */
  check(/\[saml\] assertion rejected/.test(serverLog),
    "refusals are logged server-side with a reason");

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0;
}

main()
  .then((good) => { stop(); process.exit(good ? 0 : 1); })
  .catch((e) => { console.error(e); console.error(serverLog.slice(-2000)); stop(); process.exit(1); });
