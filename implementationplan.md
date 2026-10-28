# Yumi — Implementation Plan (implementationplan.md)

**Companion to:** `PRD.md`, `TRD.md`, `schema.md`
**Version:** 1.0 · **Updated:** 2026-07-13
**Purpose:** Concrete, ordered build plan mapping the phased roadmap (`PRD.md §12`) to engineering tasks, dependencies, and exit criteria. Task status lives in `tracker.md`.

> Sequencing principle: build the **spine** (infra + auth + RBAC + realtime transport) before any surface; land the **primary (developer) value** earliest; keep every phase shippable.

---

## 0. Repository & Foundation Setup

**Monorepo layout (recommended):**
```
/apps
  /web         → React SPA (Vite)
  /api         → Express REST service
  /gateway     → Express + Socket.io realtime service
  /ai          → AI service worker
  /sandbox     → exec sandbox manager
/packages
  /shared      → types, Zod schemas, constants (event names, roles)
  /crdt        → Yjs helpers, doc schemas, snapshot/compaction utils
  /ui          → React component library + theme tokens
/infra         → docker, compose, IaC, CI config
```

**Foundation tasks:**
- Monorepo tooling (pnpm/turborepo), TS config, lint/format, CI pipeline.
- Docker Compose for local: Mongo, Redis, api, gateway, web.
- Shared package: event-name constants, role enums, Zod DTOs (single source of truth for `TRD.md §3.2`).
- `.env` management + secrets via KMS/Vault (never in repo).

---

## Phase 0 — Spine (Foundations)

**Goal:** auth, workspaces, RBAC, realtime transport — no surfaces yet.

| Task | Depends on | Exit criteria |
|---|---|---|
| Mongo schemas + indexes (`schema.md`) | — | Collections created; migrations runnable |
| Redis wiring (session, presence, pubsub) | — | Pub/sub round-trips across 2 gateway instances |
| Auth: email/password (argon2) + JWT/refresh | schemas | Register/login/refresh; revocation via Redis |
| OAuth (Google, GitHub) | auth | Find-or-create user via provider |
| Workspace/project CRUD (REST) | auth | CRUD with ownership |
| RBAC middleware (REST) + socket guard | auth | Server rejects unauthorized actions |
| Invite links (scope/expiry/singleUse) | RBAC | Resolve + accept flow, audit entry |
| Socket.io gateway + room join + auth handshake | Redis, auth | Client joins room; presence tracked |
| Presence + heartbeat (Redis TTL) | gateway | Join/leave reflected; offline on TTL expiry |
| App shell (React): routing, dashboard, top bar | auth | Login → dashboard → open project |

**Phase 0 exit:** authenticated users create workspaces/projects, invite others, join a session room with live presence — no editing surfaces yet.

---

## Phase 1 — Core Collaboration MVP

**Goal:** developer + education usable; basic design. **This is the value milestone.**

### 1A. Collaborative Code Editor (primary)
| Task | Depends on | Exit criteria |
|---|---|---|
| Integrate CodeMirror 6 + Yjs binding | Phase 0 | Two clients edit, converge, no conflicts |
| Remote cursors/selections w/ user colors + labels | editor | CE-1 acceptance met (<100ms intra-region) |
| Syntax highlighting (JS/TS,Py,Java,C/C++,HTML/CSS,JSON,MD,Go,Rust) | editor | Languages render |
| Line #, folding, bracket match, auto-indent | editor | CE-4 met |
| File tree CRUD + Yjs doc per file | editor | Create/rename/delete/move sync |
| CRDT update persistence (`crdtUpdates`) + join sync | gateway | New joiner converges from snapshot+log |
| Sandbox manager + shared terminal (role-gated) | Phase 0 | terminal I/O streamed to all; reclaim on idle |

### 1B. Canvas MVP
| Task | Depends on | Exit criteria |
|---|---|---|
| Canvas scene-graph + Yjs shared types | Phase 0 | Objects sync across clients |
| Tools: pen, eraser, shapes, text, highlight | canvas | CV-2 met |
| Live remote cursors w/ labels | canvas | CV-1 met, <100ms |
| Color/brush customization | canvas | CV-8 met |
| Per-user undo/redo (UndoManager per origin) | canvas | Undo affects only own ops |
| Zoom/pan (infinite canvas) | canvas | CV-7 met |

### 1C. Chat + Presence + Video (P2P)
| Task | Depends on | Exit criteria |
|---|---|---|
| Chat: send/persist/history, rich text, emoji, mentions | Phase 0 | MS-1/3/5 met; mention notifies |
| Presence indicators + participant list | Phase 0 | PM-3 met |
| WebRTC P2P (≤4) + screen share + signaling | gateway | VA-1/2(P2P)/6 met |
| Fallback ladder (A/V→audio→TURN→text) | WebRTC | VA-7 met (<3s) |
| Dark/light mode + basic settings | shell | Theme toggle persists |

**Phase 1 exit:** a team completes a full **design→code→discuss** session end-to-end in Yumi with <100ms latency intra-region; shareable-link join works.

---

## Phase 2 — Scale + Intelligence

| Task | Depends on | Exit criteria |
|---|---|---|
| SFU (mediasoup) for 5–50 participants | Phase 1 video | 50-user call stable |
| Call recording (server-side) | SFU | Artifact linked to session |
| AI service + code completion (latest Claude) | editor | Inline suggestions; accept via Yjs; E2EE-aware |
| AI chat assistant (tutor) | AI service | Contextual Q&A in panel |
| Replay / time-travel (snapshot+log) | crdt persistence | Scrub code+canvas history |
| Live preview (web) via sandbox | sandbox | Preview updates on edit |
| Whiteboard templates + annotation styles | canvas | CV templates usable |
| GitHub integration + diff-by-user + Git history | editor | CE-7/8 met |
| Message search, threading, reactions, DMs | chat | MS-2/4/6 met |
| Session analytics + activity feed + audit baseline | Phase 0 | PM-2/4/7 baseline |

**Phase 2 exit:** scales to 50 users; AI + replay + GitHub live; education flywheel features shipped.

---

## Phase 3 — Segment Depth (Design + Dev power)

| Task | Exit criteria |
|---|---|
| Canvas: layers polish, stencil library, custom shapes, SVG/`.yumi` export | CV-4/9 full |
| Figma + Slack integrations | Import/notify working |
| Collaborative debugging (shared breakpoints) | Shared pause/vars |
| Live test results + performance analysis | Results shown live |
| Customizable layouts, snapshots, shortcut customization | Saved presets |

---

## Phase 4 — Enterprise & Compliance

| Task | Exit criteria |
|---|---|
| SSO SAML/OIDC + SCIM | Enterprise login/provisioning |
| Full audit logs + retention + admin console | Compliance-ready |
| Data residency (region-pinned) | Region option honored |
| E2EE sensitive-project mode | Opt-in; server features disabled + disclosed |
| Backup/DR hardening, SLA, SOC2 track, pen-test | Audited |

---

## Cross-Cutting Workstreams (run across all phases)

- **Testing** (`TRD.md §12`): unit, integration, CRDT convergence/fuzz, latency-in-CI, security, E2E, load.
- **Observability:** per-hop latency metrics, tracing, alerting from Phase 0.
- **Security:** RBAC on every mutation, input validation, sandbox hardening, dependency scans.
- **Accessibility:** WCAG AA checks per component.
- **Design system:** finalize tokens once reference arrives (`design.md`).
- **Docs:** in-app help/tutorials, template gallery.

---

## Critical Path & Risk Order

1. **Realtime transport + CRDT sync** (gateway + Yjs) — everything depends on it; build & load-test first.
2. **Sandbox** — highest security risk + cost driver; harden early.
3. **Latency <100ms** — validate continuously in CI perf env; regressions block release.
4. **SFU** — required for upper scale band; de-risk in Phase 2 start.

Detailed task status, owners, and blockers: `tracker.md`.
