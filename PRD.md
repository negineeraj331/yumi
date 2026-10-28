# Yumi — Product Requirements Document

**Product:** Yumi — The Unified Collaborative Workspace
**Document type:** PRD (Strategy + Technical Specification)
**Version:** 1.0 (Draft)
**Last updated:** 2026-07-13
**Owner:** Product Management
**Status:** For leadership review and engineering handoff

---

## 0. How to Read This Document

This PRD serves two audiences simultaneously:

- **Leadership / Product / Business** — read Sections 1–4, 8, 9, and 11 for strategy, positioning, prioritization, and success criteria.
- **Engineering / Design** — read Sections 5, 6, 7, 10, and the Appendices for architecture, specifications, data models, and acceptance criteria.

Where a decision involves a trade-off between user segments, it is flagged with a **⚖️ Trade-off** callout and an explicit rationale. Requirements are tagged with **[P0]** (MVP / must-have), **[P1]** (fast-follow), or **[P2]** (differentiator / later phase) so scope can be cut cleanly without ambiguity.

---

## 1. Executive Summary

Distributed teams lose measurable time and focus to **context-switching**. A single working session routinely spans a whiteboarding tool (Miro/FigJam), a code collaboration tool (VS Code Live Share / Replit), a video tool (Zoom/Meet), and a chat tool (Slack). Each context switch fragments attention, splits the "source of truth," and creates seams where information is lost.

**Yumi is a unified workspace where a distributed team can draw, code, talk, and message on the same shared surface — without leaving the room.** A single Yumi session combines:

- A **real-time multi-user canvas** with live cursors, drawing tools, layers, and replay.
- A **collaborative code editor** with multi-cursor editing, shared terminal, file tree, and Git visibility.
- **Integrated video/audio** with screen share and graceful fallback.
- **Persistent messaging** with threads, mentions, reactions, and search.
- **Project workspaces** with role-based access, presence, activity feeds, and audit logs.

**Strategic value:** Yumi's differentiation is not any single feature — competitors win individual categories — but the **elimination of the seams between them**. When a design sketch, the code that implements it, the conversation about it, and the recording of the decision all live in one session, teams get an unbroken thread of context that fragmented toolchains structurally cannot provide.

**Priority order across segments (drives every trade-off in this document):**

1. **Remote development teams** (primary) — code collaboration, performance, security, scalability.
2. **Students / education** — affordability, simplicity, accessibility.
3. **Design / creative teams** — drawing precision, real-time sync, visual polish.
4. **Enterprise** — security, compliance, scale, support.
5. **General public** — coherent multi-use-case experience without fragmentation.

The technical stack is fixed: **React** (frontend), **Express** (backend), **Socket.io** (real-time), **Redis** (caching/session/pub-sub), **MongoDB** (persistence).

---

## 2. Product Vision & Strategy

### 2.1 Vision Statement

> One room where the whole team thinks together — sketching, building, and talking on a single living surface, so the context never leaves the work.

### 2.2 The Problem

| Symptom | Root cause | Cost |
|---|---|---|
| "Wait, which tab was that in?" | Context split across 4+ tools | Lost time, broken flow |
| Design intent lost between whiteboard and code | No shared surface between disciplines | Rework, misalignment |
| "Can you re-explain what we decided?" | Decisions live in ephemeral video, not persisted | Repeated meetings |
| Onboarding a new teammate mid-project | State scattered across tools | Slow ramp-up |
| Reviewing "what happened in that session" | No unified session history | No auditability, no replay |

### 2.3 Strategic Pillars

1. **Unified surface, not a bundle.** Yumi is not four tools in tabs. Canvas, code, and conversation share one session, one presence model, one permission model, one history. This is the moat.
2. **Developer-first, education-friendly.** The primary buyer and power user is the remote dev team; the fastest path to grassroots adoption and word-of-mouth is students. These two are designed for together — the same simplicity that helps a student helps a developer's flow.
3. **Real-time is the product.** Sub-100ms cursor/stroke latency is a hard requirement, not an aspiration. Perceived lag destroys the "same room" feeling that justifies the product's existence.
4. **Persistence gives meaning.** Everything (strokes, edits, messages, sessions) is replayable and auditable. Ephemerality is the failure mode of existing tools.

### 2.4 How the Unified Approach Serves Each Segment

The **core features are shared**; segments differ in *which* surface they lean on and *which advanced features* they activate. Yumi avoids fragmentation by building one product where segments turn features on/off via **workspace templates and plans**, rather than shipping separate apps.

| Segment | Primary surface | Leans on | Advanced features that matter most |
|---|---|---|---|
| **Remote dev teams** (P1) | Code editor | Multi-cursor code, shared terminal, Git visibility, low latency | AI code completion, conflict resolution, collaborative debugging, live preview, test integration |
| **Students / education** (P2) | Code editor + canvas | Simplicity, free tier, accessibility, shareable links | AI chat assistant (tutor), templates, session replay (review lectures) |
| **Design / creative** (P3) | Canvas | Drawing precision, live sync, visual polish | Whiteboard templates, stencil library, annotation styles, Figma integration |
| **Enterprise** (P4) | All | RBAC, audit logs, compliance, SSO, scale | Audit logs, SSO/SAML, session analytics, admin controls, data residency |
| **General public** (P5) | All | Coherent onboarding, one workspace for any job | Customizable layouts, snapshots, dark/light mode |

### 2.5 Prioritization & Trade-offs (Explicit)

**⚖️ Trade-off — Code fidelity vs. Canvas richness.**
When engineering capacity forces a choice, **code editor fidelity wins over canvas richness** in early phases, because remote dev teams are the primary segment and the hardest technical bar (multi-cursor OT/CRDT + shared terminal) gates their adoption. Design teams get a *capable* canvas in MVP but the *delightful* canvas (advanced stencils, templates, vector precision) lands in Phase 3.
*Rationale:* the developer segment is both the primary buyer and the segment whose needs are hardest to retrofit; the canvas can be enriched incrementally without re-architecture, whereas collaborative-editing correctness cannot.

**⚖️ Trade-off — Affordability (students) vs. Enterprise features.**
A **free tier** with generous limits is required for the education/student flywheel, even though it delays enterprise-grade features that generate revenue. We accept slower monetization in exchange for bottom-up adoption.
*Rationale:* developer tools win through grassroots adoption; students become the developers and buyers of tomorrow. Enterprise features (Phase 4) monetize the base *after* it exists.

**⚖️ Trade-off — Simplicity vs. Power.**
Default UI is minimal (student/general-public friendly); power is revealed progressively (command palette, keyboard shortcuts, advanced panels) so developers are not slowed and beginners are not overwhelmed.
*Rationale:* progressive disclosure lets one product serve segments 1, 2, and 5 without forking the UX.

**⚖️ Trade-off — E2E encryption vs. Server-side features.**
True end-to-end encryption (E2EE) is **incompatible** with server-side AI suggestions, server-side search indexing, and session replay that the server can render. We therefore ship **encryption in transit (TLS) and at rest (default)** for all content, and offer **optional E2EE** for designated "sensitive" projects that *disables* server-dependent advanced features for that project.
*Rationale:* most segments value the AI/search/replay features more than E2EE; enterprise/security-sensitive users get E2EE as an explicit opt-in with clearly communicated feature loss. See §7.4.

---

## 3. Goals & Non-Goals

### 3.1 Goals (What success looks like)

- **G1 —** A team can run a complete design→code→discuss→decide session entirely inside Yumi, with zero external tools.
- **G2 —** Real-time interactions (cursors, strokes, keystrokes) feel instantaneous (<100ms p95 within-region).
- **G3 —** Any session is fully replayable and auditable after the fact.
- **G4 —** A student can go from link to collaborating in <60 seconds, no install, no payment.
- **G5 —** A developer never feels the tool is slower than their local editor for the collaborative parts they use.

### 3.2 Non-Goals (Explicitly out of scope for v1)

- **NG1 —** Not a full IDE replacement. Yumi is a *collaborative session* editor, not a replacement for daily solo development in VS Code/JetBrains. No deep language-server-per-language guarantees at launch.
- **NG2 —** Not a production CI/CD platform. Test/preview integrations *show results*; they do not replace the team's build pipeline.
- **NG3 —** Not a general project-management suite (no Jira-style boards, sprints, or ticketing) in v1.
- **NG4 —** Not a native mobile app in v1. Mobile is a responsive web experience (view + light interaction), desktop-first.
- **NG5 —** Not an offline-first application in v1. Yumi assumes connectivity; graceful degradation, not full offline editing.

---

## 4. Target Users & Personas

| Persona | Segment | Goals | Pain today | Key features |
|---|---|---|---|---|
| **Dev "Priya"** — senior engineer, remote team | Dev (P1) | Pair-program, review, debug together | Live Share is code-only; whiteboard is in another tab; decisions lost | Multi-cursor code, shared terminal, collaborative debug, Git view, AI completion |
| **Student "Marco"** — CS undergrad | Education (P2) | Group assignments, learn, get help | Can't afford paid tools; setup friction | Free tier, shareable link, AI tutor, canvas for diagrams |
| **Instructor "Dr. Chen"** | Education (P2) | Run labs, review student work, replay | Screen-share is one-way; no persisted artifact | Session replay, RBAC (viewer), presence, templates |
| **Designer "Aya"** | Design (P3) | Wireframe with engineers, hand off | Handoff seam between Figma and code | Canvas precision, Figma import, annotations, live cursors |
| **Admin "Sam"** — eng manager / IT | Enterprise (P4) | Control access, audit, ensure compliance | Shadow IT, no audit trail across 4 tools | RBAC/admin, audit logs, SSO, analytics, data controls |
| **Generalist "Jo"** — startup founder | General (P5) | One tool for everything, fast | Too many subscriptions | Everything, low config, snapshots |

---

## 5. Core Features (Functional Specification)

> Notation: **[P0]** MVP · **[P1]** fast-follow · **[P2]** later. Each area lists functional requirements (FR) with acceptance criteria (AC) in Appendix A.

### 5.1 Canvas & Drawing

| # | Requirement | Priority | Primary segment |
|---|---|---|---|
| CV-1 | Multi-user simultaneous drawing; each user has a distinct live cursor with name + color label | **P0** | Design, Education |
| CV-2 | Tools: pen, eraser, shapes (rect/ellipse/line/arrow), text, highlighter | **P0** | Design |
| CV-3 | Real-time stroke sync, <100ms p95 cursor/stroke propagation within region | **P0** | All |
| CV-4 | Layer management (create, reorder, show/hide, lock) | **P1** | Design |
| CV-5 | Undo/redo — per-user, collaboration-safe (undo affects only your own ops) | **P0** | All |
| CV-6 | Canvas history + replay (scrub through stroke timeline) | **P1** | Education, Enterprise |
| CV-7 | Zoom & pan (infinite canvas), fit-to-content | **P0** | Design |
| CV-8 | Color palette + brush customization (size, opacity, style) | **P0** | Design |
| CV-9 | Export as PNG/SVG image and as `.yumi` project file | **P1** | Design |

**Design notes:**
- Canvas model is a **scene graph of vector objects** (not a raster bitmap) so that sync payloads are small, objects are individually addressable (for layers, selection, undo), and export to SVG is native. Raster is used only for export flattening and freehand smoothing previews.
- Freehand strokes are transmitted as **point deltas with pressure/timing**, batched at ~60fps client-side and coalesced server-side.
- Per-user undo uses an **operation log with user attribution**; undo pops the invoking user's last op, transforming against concurrent ops (see §6.3 sync model).

### 5.2 Code Editor

| # | Requirement | Priority | Primary segment |
|---|---|---|---|
| CE-1 | Multi-cursor editing; each user's cursor + selection highlighted in their color, with name label | **P0** | Dev, Education |
| CE-2 | Real-time code sync across all users, conflict-free | **P0** | Dev |
| CE-3 | Syntax highlighting for common languages (JS/TS, Python, Java, C/C++, HTML/CSS, JSON, Markdown, Go, Rust) | **P0** | Dev, Education |
| CE-4 | Line numbers, code folding, bracket matching, auto-indent | **P0** | Dev |
| CE-5 | Integrated terminal / console output, shared to all participants | **P0** | Dev |
| CE-6 | File tree navigation for project structure (create/rename/delete/move) | **P0** | Dev |
| CE-7 | Code diff visualization; changes attributed by user | **P1** | Dev, Enterprise |
| CE-8 | Git integration: commit history visible in session; branch/status read-out | **P1** | Dev, Enterprise |

**Design notes:**
- Editor is built on **CodeMirror 6** (preferred over Monaco for a lighter bundle, better mobile behavior, and a cleaner collaborative-extension model — matters for the education/general segments and mobile responsiveness). *This is a recommendation, not a stack constraint; Monaco is an acceptable alternative if the team prioritizes VS Code parity.*
- Collaborative text uses a **CRDT (Yjs)** for conflict-free convergence (see §6.3), which also underpins the "automatic conflict resolution" differentiator.
- The **shared terminal** runs in a **per-session sandboxed container** (see §6.4). Output is streamed via Socket.io; input is permission-gated (only editor/owner roles can type).

**⚖️ Trade-off — sandboxed execution cost.** Running a container per session is the single largest infra cost driver. In the free/education tier, execution is **rate-limited and resource-capped**, and idle sessions reclaim containers aggressively (see §7.5). Paid tiers get warmer, larger sandboxes.

### 5.3 Video & Audio

| # | Requirement | Priority | Primary segment |
|---|---|---|---|
| VA-1 | Video calling with screen share | **P0** | All |
| VA-2 | P2P (mesh) for small calls; **SFU relay** for larger calls | **P0** (P2P), **P1** (SFU) | All |
| VA-3 | Audio quality adaptation to bandwidth (Opus, DTX, adaptive bitrate) | **P0** | All |
| VA-4 | Participant list with online/offline/speaking status | **P0** | All |
| VA-5 | Call recording | **P1** | Enterprise, Education |
| VA-6 | Mute/unmute audio, enable/disable video, per-participant | **P0** | All |
| VA-7 | Automatic fallback if video fails (→ audio-only → text) | **P0** | All |

**Design notes:**
- **WebRTC** for media. **Mesh P2P for ≤4 participants**; beyond that, media routes through an **SFU** (e.g., mediasoup) to keep client uplink constant. Socket.io is the **signaling** channel only; media never flows through the Express app.
- Fallback ladder: full A/V → audio-only (drop video tracks) → server-relayed (TURN) → text-only banner "video unavailable, continue in chat." This satisfies the infra requirement for automatic fallback.
- Recording is **server-side (SFU-composited)** for reliability and to produce one artifact tied to the session record.

**⚖️ Trade-off — P2P vs. SFU.** P2P is cheap (no media server) and lower-latency for tiny calls, but uplink scales O(n) and dies past ~4–5 peers. SFU costs infrastructure but is required for the 5–50 concurrent-user target. We ship P2P first (covers most dev pairing + student groups) and SFU in Phase 2 to hit the upper scale band.

### 5.4 Messaging & Communication

| # | Requirement | Priority | Primary segment |
|---|---|---|---|
| MS-1 | Real-time chat with persistent message history | **P0** | All |
| MS-2 | Direct messaging between users | **P1** | All |
| MS-3 | Mentions / tagging (@username) with notification | **P0** | All |
| MS-4 | Message search and filtering | **P1** | Enterprise, Dev |
| MS-5 | Emoji + rich text (bold/italic/code blocks/links) | **P0** | All |
| MS-6 | Reactions + threading | **P1** | All |

**Design notes:**
- Messages persist in MongoDB; recent history is cached in Redis for fast session join.
- Rich text stored as a sanitized portable format (Markdown-subset or ProseMirror JSON); **code blocks render with the same highlighter as the editor** for consistency.
- Mentions trigger the notification service (§5.5) and, if the user is offline, an email/push (§7).

### 5.5 Collaborative Project Management

| # | Requirement | Priority | Primary segment |
|---|---|---|---|
| PM-1 | Shared workspaces with RBAC: **owner, editor, viewer** | **P0** | All, Enterprise |
| PM-2 | Activity feed of real-time actions by all users | **P1** | Enterprise, Dev |
| PM-3 | Presence indicators (who is active, in which surface) | **P0** | All |
| PM-4 | Session history + timestamps for all sessions | **P1** | Enterprise, Education |
| PM-5 | Invite via email or shareable link (with link scopes) | **P0** | All |
| PM-6 | Permission management: read-only, edit, admin | **P0** | Enterprise |
| PM-7 | Audit logs of all actions | **P1→P0 for Enterprise** | Enterprise |

**Roles matrix:**

| Capability | Viewer | Editor | Owner/Admin |
|---|---|---|---|
| View canvas/code/chat | ✅ | ✅ | ✅ |
| Draw / edit code / run terminal | ❌ | ✅ | ✅ |
| Send messages | ✅ | ✅ | ✅ |
| Invite users | ❌ | ⚙️ configurable | ✅ |
| Change roles / delete workspace | ❌ | ❌ | ✅ |
| Access audit logs / analytics | ❌ | ❌ | ✅ |

- **Shareable links** carry a scope (`viewer` default, `editor` optional) and can be set to expire, require login, or be single-use — important for both student ease-of-use (open link) and enterprise control (expiring, login-required).

---

## 6. Technical Requirements & Architecture

### 6.1 Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                          CLIENT (React SPA)                     │
│  Canvas engine │ Code editor (CodeMirror6 + Yjs) │ Chat │ RTC   │
│  State: local CRDT replicas · optimistic UI · presence          │
└───────────────▲───────────────────────────▲────────────────────┘
        Socket.io│(WS)               WebRTC   │(media, P2P/SFU)
┌───────────────┴───────────────────────────┴────────────────────┐
│                     EDGE / LOAD BALANCER (sticky by session)     │
└───────────────▲──────────────────────────────────▲──────────────┘
                │                                   │
   ┌────────────┴───────────┐          ┌────────────┴───────────┐
   │  REALTIME GATEWAY       │          │  API SERVICE (Express)  │
   │  (Express + Socket.io)  │◄────────►│  REST: auth, workspaces │
   │  rooms, presence, sync  │  Redis   │  invites, history       │
   │  fan-out relay          │  pub/sub │                         │
   └───────┬─────────┬───────┘          └───────────┬─────────────┘
           │         │                              │
      ┌────┴───┐ ┌───┴────┐                    ┌────┴─────┐
      │ REDIS  │ │  SFU    │                    │ MongoDB  │
      │ cache/ │ │ media   │                    │ persist  │
      │ pubsub/│ │ (Phase2)│                    │          │
      │ session│ └─────────┘                    └──────────┘
      └────────┘
                    ┌──────────────┐  ┌──────────────┐
                    │ EXEC SANDBOX  │  │ AI SERVICE    │
                    │ (per-session  │  │ (completion,  │
                    │  container)   │  │  chat, perf)  │
                    └──────────────┘  └──────────────┘
```

### 6.2 Component Responsibilities

- **React SPA** — renders all surfaces; holds local CRDT replicas; applies optimistic updates; manages WebRTC peer connections; renders presence. State management: lightweight store (Zustand/Redux Toolkit) + Yjs docs bound to editor and canvas.
- **Realtime Gateway (Express + Socket.io)** — authenticates socket connections (JWT handshake), manages **rooms per session**, relays CRDT updates and cursor/presence events, fans out via **Redis pub/sub** so any gateway instance can serve any session member (horizontal scale). Coalesces high-frequency cursor events.
- **API Service (Express)** — REST for auth, workspace CRUD, invites, roles, session history, exports, snapshots. Stateless; scales horizontally.
- **Redis** — (a) **session store** for auth sessions, (b) **presence** (who's in which room, TTL heartbeats), (c) **pub/sub** to broadcast realtime events across gateway instances, (d) **hot cache** of recent messages and current CRDT document state / awareness, (e) rate-limiting counters.
- **MongoDB** — durable store for users, workspaces, projects, files, message history, canvas snapshots, CRDT update logs (for replay), audit logs, session metadata.
- **SFU (Phase 2)** — media routing for calls >4 participants; server-side recording.
- **Exec Sandbox** — ephemeral container per active session for terminal/run/test; network-restricted, resource-capped, auto-reclaimed.
- **AI Service** — code completion, chat assistant, performance analysis; called from gateway/API, not exposed directly to clients.

### 6.3 Real-Time Synchronization Model (core technical decision)

**Decision: CRDT (Yjs) for both code and canvas structured state; ephemeral awareness channel for cursors/presence.**

| Concern | Approach | Why |
|---|---|---|
| Concurrent code edits | **Yjs CRDT** — automatic, conflict-free convergence | Directly satisfies "automatic conflict resolution for simultaneous edits" (differentiator) without a central OT server bottleneck; converges offline-tolerant |
| Canvas objects | **Yjs shared types** (Y.Map of objects, Y.Array of layers) | Same convergence guarantees; object-level granularity for layers/undo |
| Cursors, selections, presence | **Awareness protocol** (ephemeral, not persisted) | High-frequency, disposable; must not bloat the document log |
| Undo/redo per user | **Yjs UndoManager** scoped per origin (user) | Per-user undo that is collaboration-safe |
| Persistence & replay | Append CRDT updates to MongoDB update log + periodic state snapshots | Enables time-travel/replay (differentiator); snapshot compaction bounds storage |
| Cross-instance fan-out | Gateway relays Yjs updates over Socket.io; Redis pub/sub bridges instances | Horizontal scale of gateway |

**Latency budget (target <100ms p95, cursors/strokes, intra-region):**

| Hop | Budget |
|---|---|
| Client capture → local optimistic render | ~0ms (immediate) |
| Client → gateway (WS) | ≤30ms |
| Gateway coalesce + fan-out (incl. Redis) | ≤20ms |
| Gateway → remote client | ≤30ms |
| Remote apply + render | ≤20ms |
| **Total (remote sees local action)** | **≤100ms p95** |

*Cross-region participants exceed this by physics; mitigated by regional gateway placement and, for global sessions, honest expectation-setting. Local optimistic rendering means the *acting* user always feels 0ms.*

### 6.4 Execution Sandbox

- One **ephemeral container per active session** (or per project within a session), spun up on first run/terminal use.
- **Isolation:** no host network by default; egress allowlist; CPU/memory/disk caps; wall-clock execution timeout.
- **Reclamation:** idle timeout (e.g., 10 min no activity) reclaims the container; state (files) persisted to MongoDB/object store, re-hydrated on next use.
- **Tiering:** free/education = small caps, cold starts acceptable; paid = larger, warm pool.

### 6.5 Performance & Scale Targets

| Metric | Target |
|---|---|
| Concurrent users per session | 5–50 (P2P ≤4 video; SFU beyond) |
| Cursor/stroke latency (p95, intra-region) | <100ms |
| Code keystroke propagation (p95) | <100ms |
| Session join (cold) → interactive | <2s |
| Canvas with 10k objects | 60fps pan/zoom |
| Message delivery (p95) | <250ms |
| Video fallback trigger → resolved | <3s |
| Gateway horizontal scale | Stateless + Redis pub/sub; add instances linearly |

### 6.6 Data Model (MongoDB — key collections)

```
users        { _id, email, passwordHash?, oauthProviders[], displayName,
               avatarColor, prefs{theme, shortcuts, layout}, createdAt }

workspaces   { _id, name, ownerId, plan, members[{userId, role}],
               settings{e2ee, defaultLinkScope}, createdAt }

projects     { _id, workspaceId, name, type(code|canvas|mixed),
               fileTree, gitRepo?, createdAt, updatedAt }

files        { _id, projectId, path, language, snapshotRef, updatedAt }

crdtUpdates  { _id, projectId, docId, seq, update(Binary), userId, ts }   // replay log
crdtSnapshot { _id, projectId, docId, state(Binary), seq, ts }           // compaction

canvases     { _id, projectId, sceneGraphRef, layers[], updatedAt }

messages     { _id, workspaceId, channelId|dmPairId, authorId, body,
               richContent, mentions[], reactions[], threadId?, ts }

sessions     { _id, workspaceId, projectId, participants[{userId, joinedAt, leftAt}],
               recordingRef?, startedAt, endedAt }

invites      { _id, workspaceId, scope, token, expiresAt, requireLogin,
               singleUse, createdBy }

auditLogs    { _id, workspaceId, actorId, action, target, meta, ts }

analytics    { _id, workspaceId, sessionId, metrics{...}, ts }
```

- **Indexes:** `messages` on `{workspaceId, channelId, ts}` + text index on `body` for search; `crdtUpdates` on `{projectId, docId, seq}`; `auditLogs` on `{workspaceId, ts}`; `sessions` on `{workspaceId, startedAt}`.

### 6.7 API Surface (representative, REST + Socket events)

**REST (Express):**
```
POST   /auth/register | /auth/login | /auth/oauth/:provider | /auth/refresh
GET    /workspaces | POST /workspaces | PATCH /workspaces/:id
POST   /workspaces/:id/members | PATCH .../members/:userId (role) | DELETE ...
POST   /workspaces/:id/invites | GET /invites/:token (resolve)
GET    /projects/:id | POST /projects | PATCH | DELETE
GET    /projects/:id/history (replay index) | GET /sessions/:id
POST   /projects/:id/export (png|svg|yumi) | POST /projects/:id/snapshots
GET    /messages?channelId=&q=  (search)
GET    /workspaces/:id/audit | GET /workspaces/:id/analytics
```

**Socket.io events (namespaced per session room):**
```
join / leave / presence:update / awareness:cursor
doc:update (Yjs binary)      canvas:update (Yjs binary)
terminal:input / terminal:output
chat:message / chat:reaction / chat:typing
rtc:signal (offer/answer/ice)   ai:suggest:request / ai:suggest:result
activity:event
```

### 6.8 Frontend Requirements

- **Responsive, desktop-first**; canvas usable on tablets/mobile (pan/zoom/view, light annotation). Panels collapse into a mobile layout.
- **Customizable layouts** — dockable/resizable panels (canvas | code | video | chat), saved per user.
- **Dark/light mode** with system default.
- **Keyboard shortcuts** — command palette + customizable bindings; sensible defaults matching common editors.
- **Accessibility** — WCAG 2.1 AA target: keyboard navigation, ARIA labels, sufficient contrast in both themes, screen-reader support for chat and structure (canvas has known a11y limits — provide text alternatives / object list).

---

## 7. Infrastructure, Security & Compliance

### 7.1 Authentication & Authorization

- **Auth:** email/password (bcrypt/argon2 hashing) + **OAuth** (Google, GitHub — GitHub especially for devs). **SSO/SAML/OIDC** for enterprise (Phase 4).
- **Sessions:** JWT access tokens (short-lived) + refresh tokens; session state and revocation list in **Redis**. Socket connections authenticate via token on handshake.
- **Authorization:** RBAC enforced at API and gateway; every socket action re-checks the user's role for the target workspace/project (never trust the client).

### 7.2 Encryption

- **In transit:** TLS 1.2+ everywhere; WSS for sockets; DTLS-SRTP for WebRTC media.
- **At rest:** database + object storage encryption (default on).
- **Optional E2EE:** per-project opt-in for "sensitive" projects (see §7.4).

### 7.3 Compliance & Data Governance

- **GDPR:** lawful basis, data export (right to access/portability), deletion (right to erasure) with cascading purge across collections, consent for analytics, DPA for enterprise.
- **Data residency (enterprise, Phase 4):** region-pinned storage option.
- **Audit logs:** immutable append-only log of security-relevant actions (auth, role changes, exports, deletions, access).
- **Backups & recovery:** automated encrypted backups (MongoDB) with tested restore; RPO ≤24h (target ≤1h for paid), RTO ≤4h.
- **Automatic session timeout & cleanup:** idle sessions time out; sandboxes reclaimed; presence TTLs expire; temporary link scopes enforced.

### 7.4 Encryption vs. Feature Trade-off (detailed)

| Mode | Content protection | AI features | Server search | Server replay/recording | Segment |
|---|---|---|---|---|---|
| **Standard** (default) | TLS + at-rest | ✅ | ✅ | ✅ | All |
| **E2EE project** (opt-in) | End-to-end (client keys) | ❌ (would require plaintext on server) | ❌ (client-side only) | ⚠️ client-side replay only; no server recording | Security-sensitive, some enterprise |

The mode is chosen at project creation, clearly labeled, and its feature implications are shown before confirmation. *This is the single most important security-vs-functionality trade-off in the product and is surfaced explicitly to users.*

### 7.5 Cost & Resource Guardrails

- Free/education tier: session-minute caps, sandbox resource caps, participant caps, aggressive idle reclamation.
- Rate limiting (Redis counters) on messages, AI calls, exec runs.
- Observability: metrics (latency histograms per hop), tracing, structured logs, alerting on latency SLO breaches.

---

## 8. Advanced & Differentiating Features

Each is tagged with the segment(s) that benefit most and a rough phase.

| Feature | What it does | Benefits most | Phase | Notes |
|---|---|---|---|---|
| **AI code completion (collaborative)** | Inline suggestions during shared editing; suggestions visible/attributable | Dev, Education | P2 | Uses latest Claude models via AI service; respects E2EE opt-out |
| **Automatic conflict resolution** | CRDT guarantees convergence with no merge conflicts | Dev | **P0 (foundational)** | Falls out of the Yjs choice — a core architectural win |
| **Time-travel debugging / replay** | Step through code/canvas change history | Dev, Education, Enterprise | P2 | Built on CRDT update log + snapshots |
| **Code performance analysis** | Static + runtime hints, optimization suggestions | Dev | P3 | AI service + sandbox profiling |
| **Whiteboard templates** | Wireframe, flowchart, architecture, retro, etc. | Design, Education | P2 | Seeds canvas adoption |
| **Custom shapes / stencil library** | Reusable shape sets (UML, cloud icons, UI kits) | Design | P3 | |
| **Annotation styles** | Freehand, arrow, comment boxes | Design, All | P1 | |
| **Integrations: GitHub, Figma, Slack** | Import/export, notifications, repo sync | Dev, Design, Enterprise | P2–P3 | GitHub first (dev), then Figma (design), Slack (all) |
| **Dark/light mode** | Theme toggle | All | **P0** | |
| **Customizable layouts** | Dockable panels, saved presets | All, Dev | P1 | |
| **Save/load snapshots** | Named project checkpoints | All | P1 | |
| **Session analytics** | Time, participants, changes made | Enterprise, Education | P2 | Instructor + manager value |
| **Collaborative debugging** | Shared breakpoints, shared debug session | Dev | P3 | Hard; depends on sandbox + debug adapter |
| **Live preview (web projects)** | Rendered preview of HTML/JS updating live | Dev, Education | P2 | Served from sandbox |
| **AI chat assistant** | Ask code questions in-workspace | Education, Dev | P2 | "Tutor" framing for students |
| **Live test results** | Test framework output shown live | Dev, Enterprise | P3 | Runs in sandbox |
| **Keyboard shortcut customization** | Rebindable keys | Dev | P1 | |

**Differentiation narrative for leadership:** Individually, several of these exist elsewhere. Yumi's edge is that they operate on **one shared, persisted, permissioned session**: the AI suggestion appears in the same doc the whole team sees; the replay covers *the whole session* (drawing + code + who said what), not just one tool; the debugging breakpoints are shared in the same editor the design sketch sits beside. **The integration is the product.**

---

## 9. User Stories

> Format: *As a [persona], I want [capability], so that [outcome].* Grouped by segment. (≥15; acceptance criteria in Appendix A.)

### Developers (P1)
1. As a **developer**, I want to see my teammate's cursor and edits live in the shared file, so that we can pair-program as if in the same room.
2. As a **developer**, I want edits to merge automatically without conflicts, so that we never stop to resolve a merge.
3. As a **developer**, I want a shared terminal whose output everyone sees, so that we debug the same run together.
4. As a **developer**, I want AI code completion during the session, so that we move faster without leaving the workspace.
5. As a **developer**, I want to see Git commit history and diffs attributed by user, so that I understand who changed what.
6. As a **developer**, I want to replay the session's code changes step-by-step, so that I can understand how a bug was introduced.
7. As a **developer**, I want a live preview of our web project, so that we see UI changes as we type.

### Students / Education (P2)
8. As a **student**, I want to join a group project from a shared link with no install or payment, so that we can start immediately.
9. As a **student**, I want an AI assistant to answer code questions in-context, so that I can learn without switching tabs.
10. As a **student**, I want to sketch diagrams on the canvas next to our code, so that I can explain my thinking visually.
11. As an **instructor**, I want to join sessions as a viewer and replay them later, so that I can review student work and grade fairly.
12. As an **instructor**, I want to share a workspace with 30 students under my control, so that I can run a lab session.

### Designers / Creative (P3)
13. As a **designer**, I want precise drawing tools with layers, so that I can produce clean wireframes collaboratively.
14. As a **designer**, I want to import from Figma and annotate, so that I can bridge design and engineering in one place.
15. As a **designer**, I want live cursors with names while we brainstorm, so that a group can ideate on one canvas.
16. As a **designer**, I want to use flowchart/wireframe templates, so that I don't start from a blank canvas.

### Enterprise / Admin (P4)
17. As an **admin**, I want role-based access (owner/editor/viewer) and the ability to change roles, so that I control who can edit.
18. As an **admin**, I want audit logs of all actions, so that I can meet compliance and security requirements.
19. As an **admin**, I want SSO and expiring/login-required invite links, so that access aligns with corporate policy.
20. As an **admin**, I want session analytics, so that I can understand usage and ROI.
21. As a **security-conscious admin**, I want an E2EE mode for sensitive projects, so that even the vendor can't read our code — accepting the loss of server-side AI/search.

### General (P5)
22. As a **founder**, I want one workspace to sketch, build, and talk, so that I stop paying for four tools.
23. As **any user**, I want dark mode, customizable layouts, and saved snapshots, so that the tool fits how I work.
24. As **any user**, I want reliable video with automatic fallback to audio/chat, so that a bad connection doesn't end the session.

---

## 10. UX, Onboarding & Notifications

- **Onboarding:** progressive — link-join for instant collaboration (no account needed to *view*; account to *edit*/persist); interactive first-run tour; sample project templates per segment (dev starter, class assignment, wireframe board).
- **Notifications:** in-app + email/push for invites, @mentions, session-start, role changes. Preferences per user; respect quiet hours.
- **Settings & preferences:** profile, theme, shortcuts, layout presets, notification prefs, connected accounts (OAuth/integrations), privacy/data controls (export/delete).
- **Help & tutorials:** in-app docs, contextual tips, keyboard-shortcut cheat sheet, template gallery.

---

## 11. Success Metrics

### 11.1 North Star
**Weekly Collaborative Session Minutes** — total minutes teams spend in *active multi-user* Yumi sessions. It captures the core value (people actually working together in one place) and is hard to game.

### 11.2 Metrics by dimension

| Category | Metric | Target (12 mo) | Segment signal |
|---|---|---|---|
| **Activation** | % new users reaching first multi-user session | >60% | All (esp. Education) |
| **Engagement** | WAU/MAU stickiness | >45% | Dev |
| **Retention** | Week-4 team retention | >40% | Dev, Enterprise |
| **Performance** | p95 cursor/stroke latency | <100ms | All |
| **Performance** | Session join success rate | >99% | All |
| **Reliability** | Video call completion (no unrecovered failure) | >98% | All |
| **Unification** | Avg. distinct surfaces used per session (canvas/code/chat/video) | >2.5 | Validates "one tool" thesis |
| **Education** | Free→edu active workspaces | growth MoM | Education |
| **Design** | Canvas objects created / session | trend up | Design |
| **Enterprise** | Paid seats; audit-log adoption; SSO orgs | pipeline | Enterprise |
| **AI** | Suggestion acceptance rate | >25% | Dev, Education |
| **Business** | Free→paid conversion | >3% | All |

### 11.3 Guardrail metrics
- Latency SLO breach rate, error rate, sandbox cost per active session, support tickets per 100 sessions, security incidents (target 0).

---

## 12. Roadmap (Phased Rollout)

Core functionality first (serves the primary dev segment + gives every segment a usable base), then segment-specific depth.

### Phase 0 — Foundations (Weeks 0–6)
Infra skeleton: React app shell, Express API, Socket.io gateway, Redis (session/presence/pubsub), MongoDB schemas, auth (email + OAuth), workspaces + RBAC, invite links. *No collaboration surfaces yet — the spine.*

### Phase 1 — Core Collaboration MVP (Weeks 6–16) — **serves Dev + Education + basic Design**
- **Code editor** with multi-cursor, CRDT sync, syntax highlighting, file tree, shared terminal (sandbox). *(Dev P1)*
- **Canvas** MVP: pen/eraser/shapes/text/highlight, live cursors, zoom/pan, color/brush, per-user undo. *(Design)*
- **Chat** with history, mentions, rich text; **presence**.
- **Video** P2P (≤4) + screen share + fallback ladder.
- Dark/light mode. Shareable-link join.
- **Exit criteria:** a team completes a full design→code→discuss session in Yumi; <100ms latency met intra-region.

### Phase 2 — Scale + Intelligence (Weeks 16–28) — **deepens Dev, opens Education**
- **SFU** for 5–50 participants; call recording.
- **AI**: code completion + chat assistant (tutor).
- **Replay / time-travel** (code + canvas).
- **Live preview** (web).
- Whiteboard **templates**; annotation styles.
- **GitHub integration**; diff-by-user; Git history.
- Message search, threading, reactions, DMs.
- Session analytics; activity feed; audit logs (baseline).

### Phase 3 — Segment Depth (Weeks 28–40) — **Design + Dev power**
- Canvas richness: layers polish, **stencil library**, custom shapes, SVG export, `.yumi` files.
- **Figma** + **Slack** integrations.
- **Collaborative debugging** (shared breakpoints), **live test results**, **performance analysis**.
- Customizable layouts, snapshots, shortcut customization.

### Phase 4 — Enterprise & Compliance (Weeks 40–52) — **Enterprise**
- **SSO/SAML/OIDC**, SCIM provisioning, data residency.
- Full **audit logs** + retention policies, admin console, advanced analytics.
- **E2EE** sensitive-project mode.
- SLA, support tiers, backup/DR hardening, pen-test + SOC2 track.

**Phasing rationale:** each phase leaves a coherent, shippable product; primary (dev) value lands earliest; the free/education flywheel starts in Phase 1–2; revenue-generating enterprise features come last, monetizing a base that already exists — consistent with the §2.5 trade-offs.

---

## 13. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Latency target missed at scale | Core value undermined | Med | Regional gateways, event coalescing, load testing early, optimistic UI |
| Sandbox execution cost explodes | Margin erosion | Med-High | Aggressive reclamation, tiered caps, warm pools only for paid |
| Doing everything → mediocre at each | Differentiation lost | Med | Anchor on dev excellence first; "integration is the moat," not per-feature superiority |
| CRDT storage growth (replay log) | Storage cost, slow load | Med | Snapshot compaction, GC of ephemeral awareness, tiered retention |
| E2EE vs. features confusion | User frustration | Low-Med | Explicit labeling + pre-confirmation feature-loss disclosure |
| WebRTC reliability across networks | Calls fail | Med | TURN relay, fallback ladder, SFU |
| Security breach (code is sensitive) | Trust loss | Low/High-impact | RBAC everywhere, encryption, audit logs, pen-testing, E2EE option |
| Scope creep from 5-segment ambition | Slipped timeline | High | Strict P0/P1/P2 tags; segment depth gated to Phases 3–4 |

---

## 14. Open Questions

1. CodeMirror 6 vs. Monaco — final call pending a spike on collaborative-extension ergonomics and mobile bundle size.
2. Build vs. buy for SFU (mediasoup self-host vs. managed WebRTC vendor) — cost/control trade-off.
3. AI model hosting — managed API vs. self-host for enterprise data-residency customers.
4. Exact free-tier limits (session minutes, sandbox specs, participant cap) — needs cost modeling.
5. Guest (no-account) editing scope — how much can an anonymous link-editor do before an account is required?

---

## Appendix A — Sample Acceptance Criteria (illustrative)

**CE-1 Multi-cursor editing**
- Given two users in a file, when User A types, User B sees the character within <100ms p95 (intra-region).
- Each remote cursor shows the user's color and name label; selections are highlighted in the user's color.
- Simultaneous edits at the same position converge to an identical document on all clients (CRDT), with no manual conflict resolution.

**CV-1 Multi-user drawing**
- Given N users drawing simultaneously, each stroke appears on all clients attributed to the correct user color within <100ms p95.
- A user's undo removes only that user's most recent operation and does not disturb others' work.

**VA-7 Video fallback**
- Given a video connection failure, the system falls back to audio-only within <3s; if audio also fails, a text banner appears and chat remains functional.

**PM-1 RBAC**
- A viewer cannot edit code, draw, or run the terminal; attempts are rejected server-side (not merely hidden in UI).
- Only owner/admin can change roles or delete a workspace; enforced at API and socket layers.

**MS-3 Mentions**
- @mentioning a user notifies them in-app; if offline, an email/push is sent per their preferences.

## Appendix B — Glossary
- **CRDT** — Conflict-free Replicated Data Type; enables automatic convergence of concurrent edits.
- **Awareness** — ephemeral, non-persisted presence/cursor channel (Yjs).
- **SFU** — Selective Forwarding Unit; media server routing WebRTC streams to scale calls.
- **P2P mesh** — direct peer connections; each peer sends to every other (scales poorly past ~4).
- **E2EE** — End-to-end encryption; only clients hold keys, server cannot read content.
- **RBAC** — Role-Based Access Control.
- **RPO/RTO** — Recovery Point/Time Objective.
```
