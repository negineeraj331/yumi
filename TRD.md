# Yumi — Technical Requirements Document (TRD)

**Product:** Yumi — Unified Collaborative Workspace
**Companion to:** `PRD.md`
**Version:** 1.0 (Draft)
**Last updated:** 2026-07-13
**Audience:** Engineering (backend, frontend, infra, security)
**Status:** For engineering handoff

> This TRD translates the PRD's product requirements into concrete technical decisions, contracts, and constraints. Where the PRD says *what/why*, the TRD says *how*. Requirement IDs (CE-*, CV-*, etc.) map back to `PRD.md §5`.

---

## 1. Fixed Technology Stack (Non-negotiable)

| Layer | Technology | Role |
|---|---|---|
| Frontend | **React** | SPA rendering all collaborative surfaces |
| Backend | **Express** (Node.js) | REST API + Socket.io host |
| Real-time transport | **Socket.io** | WebSocket signaling, sync fan-out, presence |
| Cache / session / pub-sub | **Redis** | Sessions, presence, pub/sub bridge, hot cache, rate limits |
| Persistence | **MongoDB** | Durable store for all entities + CRDT logs |

**Recommended (not mandated) libraries** — chosen to fit the fixed stack:

| Concern | Recommendation | Alternative | Rationale |
|---|---|---|---|
| Collaborative data (code + can
e-graph on **Canvas2D/WebGL** (or Konva/Fabric as starting point) | Excalidraw-core | Object-addressable, SVG export, performance |
| Media | **WebRTC** (P2P mesh) + **mediasoup** SFU (Phase 2) | Managed WebRTC vendor | Cost/control; Socket.io = signaling only |
| Client state | **Zustand** or Redux Toolkit | — | Yjs holds shared state; store holds UI/local |
| Sandbox | Container runtime (Docker/Firecracker/gVisor) | Managed code-exec vendor | Isolation for shared terminal/run |
| Auth tokens | JWT (access) + refresh; Redis revocation | Session cookies | Works for both REST + socket handshake |
| Validation | Zod / JSON Schema | — | Contract enforcement at boundaries |

Open items on library choices are tracked in `PRD.md §14` and `tracker.md`.

---

## 2. System Architecture

### 2.1 Services

| Service | Runtime | Stateless? | Scales by | Responsibility |
|---|---|---|---|---|
| **API Service** | Express | Yes | Horizontal (LB) | Auth, workspace/project CRUD, invites, history, exports, analytics |
| **Realtime Gateway** | Express + Socket.io | Yes (state in Redis) | Horizontal + Redis pub/sub | Rooms, presence, CRDT relay, cursor coalescing, RTC signaling |
| **AI Service** | Node/py worker | Yes | Horizontal | Completion, chat assistant, perf analysis (calls latest Claude models) |
| **Exec Sandbox Manager** | Orchestrator | No (owns containers) | Pool/quotas | Provision/reclaim per-session containers |
| **SFU (Phase 2)** | mediasoup | Partially | Workers/ports | Media routing + server-side recording |
| **Redis** | Redis | — | Cluster | Sessions, presence, pub/sub, cache, rate limits |
| **MongoDB** | MongoDB | — | Replica set / shard | Durable persistence |

### 2.2 Connection topology

- Client ↔ Gateway: **WebSocket (WSS)** via Socket.io. **Sticky routing by session** at the LB is preferred, but not required because Redis pub/sub bridges instances (any gateway can serve any room; sticky just reduces cross-instance chatter).
- Client ↔ Client: **WebRTC** media (P2P ≤4) or Client ↔ SFU (>4). Media never traverses Express.
- Gateway/API ↔ Redis: session/presence/pubsub.
- Gateway/API ↔ MongoDB: persistence.

### 2.3 Horizontal scaling model

- API + Gateway are stateless; add instances behind LB.
- **Redis pub/sub** channel per session (`room:{projectId}`) fans CRDT/cursor/chat events to all gateway instances holding a member of that room.
- Presence in Redis with heartbeat TTL; expiry ⇒ user marked offline.
- MongoDB via replica set (HA); shard on `workspaceId` when needed.

---

## 3. Real-Time Sync — Technical Contract

### 3.1 Model

- **Shared structured state** (code text, canvas objects, layers) = **Yjs documents** per project (`docId` per file / per canvas).
- **Ephemeral state** (cursors, selections, presence, typing) = **Yjs Awareness** — never persisted.
- **Convergence**: CRDT guarantees all replicas converge regardless of order/offline — this *is* the "automatic conflict resolution" requirement (PRD CE-2 / differentiator).

### 3.2 Wire protocol (Socket.io events)

Namespace: `/session`, room = `projectId`.

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `join` | C→S | `{projectId, token}` | Auth + RBAC check; server adds to room, sends state vector |
| `sync:step1/step2` | C↔S | Yjs sync protocol (binary) | Initial state exchange |
| `doc:update` | C↔S | `{docId, update:Binary}` | Yjs incremental update; relayed + persisted |
| `awareness` | C↔S | `{docId, state:Binary}` | Cursors/presence; relayed, NOT persisted |
| `cursor` | C→S | `{docId, pos, color}` | Coalesced ≤30ms; convenience over raw awareness |
| `terminal:input` | C→S | `{sessionId, data}` | Role-gated (editor/owner) |
| `terminal:output` | S→C | `{sessionId, data}` | Streamed from sandbox |
| `chat:message` | C↔S | `{channelId, body, richContent, mentions}` | Persisted |
| `chat:typing` | C→S | `{channelId}` | Ephemeral |
| `rtc:signal` | C↔S | `{to, sdp?/candidate?}` | WebRTC signaling relay |
| `activity` | S→C | `{action, actor, ts}` | Activity feed |
| `presence:update` | S→C | `{users[]}` | Room membership snapshot |

### 3.3 Coalescing & batching

- Client batches local edits at ~60fps into single `doc:update` frames.
- Gateway coalesces cursor events per user to ≤1 per 30ms.
- Awareness updates debounced; only diffs sent.

### 3.4 Persistence & replay

- Every `doc:update` appended to `crdtUpdates` (append-only log).
- Periodic **snapshot compaction**: collapse updates into `crdtSnapshot` (Yjs state), truncate log tail beyond retention. Replay = load nearest snapshot + apply subsequent updates up to target timestamp (time-travel debugging / canvas replay).
- Retention tiers: free (short), paid (longer), enterprise (policy-driven).

### 3.5 Latency budget (must meet <100ms p95 intra-region)

| Hop | Budget (ms) |
|---|---|
| Local optimistic render | 0 |
| C→Gateway (WSS) | ≤30 |
| Gateway coalesce + Redis fan-out | ≤20 |
| Gateway→remote C | ≤30 |
| Remote apply+render | ≤20 |
| **Total** | **≤100 p95** |

Mitigations: regional gateway placement, optimistic UI (actor always 0ms), event coalescing, binary payloads.

---

## 4. Execution Sandbox — Technical Contract

| Property | Spec |
|---|---|
| Granularity | One container per active session (or per running project) |
| Isolation | No host net by default; egress allowlist; seccomp/gVisor; read-only base image + writable overlay |
| Limits | CPU quota, memory cap, disk cap, wall-clock timeout per run |
| Lifecycle | Lazy start on first run/terminal; idle reclaim (~10 min); files persisted to object store/Mongo, re-hydrate on next use |
| I/O | Terminal I/O over Gateway (`terminal:*`), role-gated |
| Live preview | Sandbox serves an internal port; proxied to authorized clients only |
| Tiering | Free/edu = small caps + cold starts OK; paid = warm pool + larger caps |

Security: sandbox is the highest-risk surface (runs user code). Network egress default-deny, resource caps hard-enforced, no credentials mounted, per-run timeouts, output size limits (prevent log-flood DoS).

---

## 5. Video/Audio — Technical Contract

- **Transport:** WebRTC. **Signaling** over Socket.io `rtc:signal`. **Media**: DTLS-SRTP.
- **Topology:** mesh P2P for ≤4 participants; **SFU (mediasoup)** for 5–50 (Phase 2).
- **Codecs:** Opus (audio, DTX + adaptive bitrate); VP8/VP9/H.264 (video, simulcast via SFU).
- **NAT traversal:** STUN + **TURN** relay fallback.
- **Fallback ladder (VA-7, <3s):** full A/V → audio-only (drop video) → TURN-relayed → text-only banner (chat continues).
- **Recording (P1):** server-side SFU composition → stored artifact linked to `sessions.recordingRef`. E2EE projects: no server recording (see §8).
- **Status:** speaking detection + online/offline via presence.

---

## 6. Data Persistence — Technical Contract

Collections and indexes are specified in `schema.md`. Key TRD constraints:

- **CRDT logs** (`crdtUpdates`) are append-only; never mutate in place; compact via snapshots.
- **Messages** support full-text search → Mongo text index (or external search engine if scale demands; Phase 2 decision).
- **Audit logs** are append-only and tamper-evident (hash-chain optional for enterprise).
- **GDPR erasure**: cascading delete across `users`→`messages`→`crdtUpdates` authorship→`auditLogs` (retain minimal legal record), documented purge job.
- **Backups**: automated, encrypted; restore tested; RPO ≤24h (≤1h paid), RTO ≤4h.
- **Data residency**: a workspace is pinned to the region of the deployment that created it (`settings.dataResidencyRegion`), permanently. Every regional tier refuses workspaces pinned elsewhere with **421 Misdirected Request** carrying that region's address — REST, Socket.io join, SCIM and invites, reads as well as writes. The enforced topology is one database with regional application tiers; per-region databases are a deployment change on top, not a different contract. Because pinning storage does not pin processing, features that hand content to a third party (AI, GitHub, Figma, Slack) are refused in a pinned workspace unless an operator declares otherwise (`RESIDENCY_ALLOW_EGRESS`, `AI_REGION`).

---

## 7. Authentication & Authorization — Technical Contract

- **Register/login:** email/password (argon2id hashing, per-user salt). **SSO:** OIDC (authorization code + PKCE, ID token verified against the issuer's JWKS) and SAML 2.0 (Web Browser SSO; assertion signature required, `InResponseTo` replay protection in Redis, per-provider SP entityID). **SCIM 2.0** for directory-driven provisioning and deprovisioning. GitHub sign-in is deliberately excluded: plain OAuth2 gives no ID token, so trust would rest on an unauthenticated userinfo call behind an identical-looking button.
- **Tokens:** short-lived JWT access (~15 min) + rotating refresh; refresh + revocation list in Redis.
- **Socket auth:** token verified on `connection` handshake; rejected sockets closed.
- **Authorization:** RBAC checked **server-side on every mutating action** (REST middleware + socket event guard). Client-side hiding is UX only, never the enforcement boundary.
- **Roles:** viewer / editor / owner(admin) per workspace (see PRD roles matrix). Project-level overrides optional (Phase 3+).
- **Invite links:** signed tokens with scope, expiry, `requireLogin`, `singleUse` flags.

---

## 8. Security & Encryption — Technical Contract

| Control | Spec |
|---|---|
| In transit | TLS 1.2+; WSS; DTLS-SRTP for media |
| At rest | DB + object storage encryption (default on) |
| Optional E2EE | Per-project opt-in; client-held keys; **disables** server AI, server search, server recording/replay for that project (documented pre-confirmation) |
| Secrets | Vault/KMS; never in repo or client bundle |
| Rate limiting | Redis token buckets on messages, AI, exec runs, auth attempts |
| Audit | Append-only `auditLogs` for auth, role change, export, delete, access |
| Session hygiene | Idle timeout, sandbox reclamation, presence TTL, link expiry |
| Input safety | Sanitize rich text (XSS), validate all payloads (Zod), size limits |
| Sandbox | See §4 — highest-risk surface |

E2EE ↔ feature trade-off table is authoritative in `PRD.md §7.4`.

---

## 9. Non-Functional Requirements (NFRs)

| NFR | Target |
|---|---|
| Cursor/stroke latency p95 (intra-region) | <100ms |
| Keystroke propagation p95 | <100ms |
| Concurrent users/session | 5–50 |
| Session cold join → interactive | <2s |
| Canvas 10k objects | 60fps pan/zoom |
| Message delivery p95 | <250ms |
| Video fallback resolve | <3s |
| API availability | 99.9% (paid) |
| RPO / RTO | ≤24h(≤1h paid) / ≤4h |
| Accessibility | WCAG 2.1 AA (canvas has documented limits) |
| Browser support | Latest 2 versions Chrome/Edge/Firefox/Safari |

---

## 10. Observability & Ops

- **Metrics:** per-hop latency histograms, active sessions, sandbox count/cost, error rates, WS connection counts.
- **Tracing:** distributed trace across API↔Gateway↔AI↔Sandbox.
- **Logging:** structured JSON; correlation IDs; PII-scrubbed.
- **Alerting:** latency SLO breach, error spikes, sandbox cost anomaly, security events.
- **Load testing:** simulate 50-user sessions before each scale milestone.

---

## 11. Environments & CI/CD

- **Environments:** local → dev → staging → prod.
- **CI:** lint, typecheck, unit, integration (incl. CRDT convergence tests), build.
- **CD:** containerized deploys; blue/green or rolling; DB migrations gated.
- **Config:** env-based; secrets via KMS/Vault; no secrets in client bundle.

---

## 12. Testing Strategy

| Layer | What |
|---|---|
| Unit | Reducers, RBAC guards, validators, CRDT helpers |
| Integration | API + Mongo + Redis; socket event flows |
| Realtime/convergence | Multi-client Yjs convergence; concurrent-edit fuzzing; per-user undo correctness |
| Latency | Automated p95 measurement in CI perf env |
| Security | Authz bypass tests, sandbox escape tests, input fuzzing, dependency scans |
| E2E | Full session flow (join→draw→code→chat→call→replay) |
| Load | 50-user session soak tests |

---

## 13. Traceability (Requirement → Component)

| Requirement | Owning component(s) |
|---|---|
| CE-1/2 multi-cursor, conflict-free | Client editor (CM6+Yjs), Gateway relay, crdtUpdates |
| CV-1/3/5 drawing, sync, per-user undo | Client canvas (Yjs), Gateway, UndoManager |
| CE-5 shared terminal | Sandbox Manager, Gateway, sandbox container |
| VA-* video | WebRTC client, signaling (Gateway), SFU (P2) |
| MS-* messaging | Gateway, API, Mongo, Redis cache |
| PM-1/6 RBAC | API middleware, socket guards |
| PM-7 audit | API, auditLogs |
| AI features | AI Service |
| Replay | crdtUpdates + crdtSnapshot |
| Security/E2EE | §7/§8 controls |

Full task-level tracking in `tracker.md`; build order in `implementationplan.md`.
