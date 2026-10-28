# Yumi — What still needs a human (verification.md)

**Companion to:** `tracker.md`, `dr.md`
**Version:** 1.0 · **Updated:** 2026-07-30

Everything in Yumi that can be proved by code has a test that proves it. This
file is the rest: the things that are built and typecheck and are reviewed, but
whose *last mile* needs a camera, a credential, a network you can break, or a
person who did not write the code.

Nothing here is a known bug. Each item says what is unverified, exactly how to
verify it, what a pass looks like, and what to do if it fails. Work top to
bottom — the first four are an hour's work between them; the last three are
programmes, not tasks.

When something passes, update its row in `tracker.md` and note the date.

---

## 1. Call recording · 30 minutes · needs two machines with a camera

**Status:** built and typechecks; never run against real camera/microphone
hardware. Recording composites the video tiles onto a canvas and mixes audio
through WebAudio into a `MediaRecorder`, all in the browser.

**Why it is not tested:** a headless environment has no camera, no microphone,
and no `MediaRecorder` codec support. Faking those would test the fake.

**How to verify**

1. `pnpm dev`, then open the same project on two machines (or two browsers on
   two devices — two tabs on one machine share a camera and will mislead you).
2. Join the call on both. Confirm you can see and hear each other.
3. Press **⏺ REC** on one side. The button should change state immediately.
4. Talk for ~30 seconds. Have the other person turn their camera off and on
   again while recording.
5. Press stop. A `.webm` file should download.
6. Open it in VLC (Safari and QuickTime are unreliable with `.webm`).

**Pass:** the file plays; every participant who was present when recording
started appears; audio is present for both sides and roughly in sync; the tile
that went dark and came back does not corrupt the rest of the recording.

**Known limitation, not a bug:** someone who joins *after* recording starts is
not added to the composition (tracker Phase 2). If you need that, it is real work,
not a fix.

**If it fails:** capture the browser console. The likely failure points are codec
negotiation (the code has a fallback chain) and the canvas compositor sizing.

---

## 2. SFU media round-trip · 30 minutes · needs 5+ participants

**Status:** the server path is runtime-verified — worker, router, transports and
ICE all exercised by a smoke test. What is unverified is a real browser
publishing and consuming media through it.

**How to verify**

1. Set `CALL_MODE=sfu` in `.env` and set `MEDIASOUP_ANNOUNCED_IP` to the host's
   LAN or public IP — **not** `127.0.0.1` unless every participant is on that
   same machine. This is the single most common reason an SFU call connects and
   then shows black tiles.
2. Ensure the RTC port range (`MEDIASOUP_RTC_MIN_PORT`–`MAX_PORT`, default
   40000–40100) is reachable over UDP.
3. Restart the server; join a call from **five or more** browsers.

**Pass:** everyone sees and hears everyone; upstream bandwidth on each client
stays flat as participants are added (that is the whole point of an SFU — mesh
would grow it linearly). `chrome://webrtc-internals` will show one outbound
stream per client regardless of headcount.

**If it fails:** black tiles with a connected state almost always means
`announcedIp`. No connection at all means the UDP range is blocked.

**Also unverified:** the automatic mesh↔SFU switch by headcount does not exist —
the mode is per-deployment, by design (tracker decision 2026-07-23).

---

## 3. WebRTC fallback ladder · 1–2 hours · needs a TURN server

**Status:** the ladder is implemented per-peer — STUN+TURN → ICE restart on
failure → drop to audio-only → give up — and typechecks. It has never been made
to actually *fail* over, because that needs a relay and a network you can break.

**How to verify**

1. Stand up a TURN server. `coturn` is the usual choice:
   ```bash
   docker run -d --network host coturn/coturn \
     -n --lt-cred-mech --realm=yumi.test --user=yumi:testpass
   ```
2. Point the client at it in `apps/web/.env`:
   ```
   VITE_TURN_URLS=turn:<host>:3478
   VITE_TURN_USERNAME=yumi
   VITE_TURN_CREDENTIAL=testpass
   ```
3. **Force the relay path:** in Chrome, `chrome://webrtc-internals` will show the
   selected candidate pair. To force TURN, block direct UDP between the two
   machines (a firewall rule dropping UDP to the peer's subnet), or use a
   symmetric-NAT network — a phone hotspot is often enough.
4. **Force the ladder:** with a call up, kill the TURN server. The affected peer
   should attempt an ICE restart, then fall back to audio-only with an
   "audio-only" badge on that tile, then drop — and *only that peer*, not the
   whole call.

**Pass:** each step happens in order; a second, healthy peer in the same call is
unaffected throughout (per-peer degradation is the design claim); the badge
appears.

**If it fails:** the glare handling is the subtle part — the smaller peer id
drives the restart. Two peers restarting simultaneously is the bug to look for.

---

## 4. GitHub, Figma and Slack · 30 minutes · needs real accounts

**Status:** all three are verified against local stub servers — 41 end-to-end
checks covering link, browse, render, redaction, RBAC and event filtering. What
is unverified is the real APIs' actual responses, and Figma frame placement in a
real browser canvas.

**How to verify**

- **GitHub:** link a public repo with no token (public repos work tokenless).
  Browse commits, open a diff, import a file. Then link a *private* repo with a
  fine-grained PAT (`Contents: read`). Confirm the token never appears in any
  response — check the network tab for `hasToken: true` and nothing else.
- **Figma:** create a PAT (Figma has no anonymous API). Link a file by pasting
  its URL. Browse pages, preview a frame, place it on the canvas.
  **Pass:** the frame appears on the canvas at a sane size and *persists after a
  reload* — that last part exercises the data-URL-in-the-Yjs-shape decision and
  is the bit most likely to surprise.
- **Slack:** create an incoming webhook. Link it — a confirmation message should
  post immediately, and a deliberately malformed URL should be rejected at link
  time rather than accepted silently. Then make a run fail and confirm the
  channel gets a message, and make one pass and confirm it stays quiet.

**Pass:** each links, each works, no secret is ever returned to the client.

**Note:** if the workspace is region-pinned, all three are refused by design
until an operator sets `RESIDENCY_ALLOW_EGRESS` — that is not a failure. See
tracker §6 (data residency).

---

## 5. SLA · a programme, not a task

**Status:** not started, and not startable in code. An availability target is a
promise about operations, and nothing in this repo can make it true.

**What it actually requires**

1. **Decide the number.** 99.9% is ~43 minutes of downtime a month. Do not
   publish a number you have not measured for a quarter first.
2. **Measure it.** External uptime checks against `/api/health` from more than
   one region, plus latency percentiles for the realtime path (the PRD's <100ms
   p95 cursor budget is the one that matters and the one users feel).
3. **Alert on it.** Paging on symptoms (error rate, p95 latency, health-check
   failure), not causes. Alerts nobody acts on train people to ignore alerts.
4. **Staff it.** An on-call rotation with a written escalation path. An SLA
   without someone who is obliged to wake up is a marketing claim.
5. **Error budget.** What happens when you miss it — this is the part that makes
   an SLA affect engineering decisions rather than decorate a contract.

**What the code already gives you:** `/api/health`, structured logs, per-session
analytics, and the audit log. Those are inputs. They are not an SLA.

---

## 6. SOC 2 · 6–12 months, needs an auditor

**Status:** several controls exist; the audit does not. SOC 2 Type II is an
assessment of controls **over a period** — typically 6–12 months of evidence —
by an accredited firm. It cannot be produced retroactively and cannot be
produced by code.

**What Yumi already provides as evidence**

| Control area | What exists | Where |
|---|---|---|
| Access control | RBAC enforced server-side on every mutation; owner-only admin | `middleware.ts` |
| Authentication | argon2id, short-lived JWT + rotating refresh, SSO (OIDC + SAML) | `auth.ts`, `oidc.ts`, `saml.ts` |
| Provisioning / offboarding | SCIM 2.0 with real deprovisioning | `scim.routes.ts` |
| Audit logging | 22 event types, append-only, IP-attributed, exportable | `workspace.routes.ts` |
| Retention | Per-workspace, default keep-forever, changes audited | `retention.ts` |
| Encryption | TLS in transit (your deployment); E2EE mode per project | `e2ee.ts` |
| Backup / recovery | Verified restore + point-in-time recovery | `dr.md` |
| Data residency | Region pinning enforced on every path | `residency.ts` |

**What you still have to do:** pick an auditor; write the policies (access
review, incident response, change management, vendor management, onboarding /
offboarding); run them for the observation window; collect evidence continuously
(a compliance platform is worth it); remediate findings. Budget 6–12 months and
real money. Start the observation window *before* you need the report.

---

## 7. Penetration test · must be someone else

**Status:** not done, and specifically must not be done by whoever wrote the
code — including me. The value of a pen test is an adversary who does not share
the author's assumptions, and I share every one of them.

**What to hand a tester**

- The threat model already written down: `rules.md` §3, and the decision log in
  `tracker.md` §8 — it records what was defended against and why, which tells a
  tester where to push.
- The areas with the most security-relevant surface, roughly in order:
  1. **The sandbox** (`runner.ts`, `debugger.ts`) — arbitrary user code runs
     here. Container escape, resource exhaustion, the `--network none`
     assumption.
  2. **SSO** (`oidc.ts`, `saml.ts`, `ssoIdentity.ts`) — assertion forgery,
     signature wrapping, replay, account linking/takeover.
  3. **The realtime gateway** (`gateway.ts`) — authorization on every socket
     event, CRDT frame handling, rate limits.
  4. **SCIM** (`scim.routes.ts`) — cross-tenant access with a workspace-scoped
     token.
  5. **Data residency and E2EE** — whether the refusals can be bypassed.
- The test suites, so they do not spend time re-finding what is already covered:
  `apps/web/test/`.

**Ask specifically for:** authenticated multi-tenant testing (give them two
workspaces and two accounts), not just an unauthenticated scan. Every
interesting bug in an app like this is an authorization bug.

---

## 8. Not a gap: GitHub sign-in

Listed here only because people ask. GitHub OAuth sign-in is **deliberately
excluded**, not missing (tracker decision 2026-07-27): GitHub's OAuth2 has no ID
token, so trust would rest on an unauthenticated `userinfo` call — a materially
weaker path sitting behind a button that looks identical to the verified ones.
OIDC and SAML both give a signature that can be checked locally.

If you decide you want it anyway, that is a product decision. Implement it as a
*linking* mechanism for an already-authenticated account rather than as a
sign-in path, and it becomes defensible.
