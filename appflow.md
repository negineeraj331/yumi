# Yumi — Application Flow (appflow.md)

**Companion to:** `PRD.md`, `TRD.md`
**Version:** 1.0 · **Updated:** 2026-07-13
**Purpose:** End-to-end user and system flows for every core journey. Engineering uses this to understand screen-to-screen transitions, socket lifecycles, and state changes.

Legend: `→` step · `⇄` real-time bidirectional · `[role]` gate · `(async)` background.

---

## 1. Top-Level Navigation Map

```
                       ┌────────────┐
                       │  Landing   │
                       └─────┬──────┘
              login/register │  join via link
                       ┌─────▼──────┐
                       │ Auth flow  │────► OAuth (Google/GitHub)
                       └─────┬──────┘
                       ┌─────▼──────┐
                       │ Dashboard  │  workspaces, recent projects, invites
                       └─────┬──────┘
        create/open project │
                       ┌─────▼─────────────────────────────┐
                       │        SESSION WORKSPACE           │
                       │  ┌────────┬────────┬──────┬─────┐  │
                       │  │ Canvas │  Code  │ Chat │ A/V │  │
                       │  └────────┴────────┴──────┴─────┘  │
                       │  Presence · Activity · Settings    │
                       └────────────────────────────────────┘
```

---

## 2. Onboarding & Authentication Flows

### 2.1 New user — register
1. Landing → "Sign up".
2. Choose email/password **or** OAuth (Google/GitHub).
3. Email/password: validate → create `users` doc (argon2 hash) → issue JWT + refresh.
4. OAuth: provider consent → callback → find-or-create user → issue tokens.
5. First-run tour + template picker (dev starter / class assignment / wireframe board).
6. → Dashboard.

### 2.2 Returning user — login
1. Landing → "Log in" → credentials/OAuth → tokens → Dashboard.
2. Refresh token silently renews access token; revocation checked in Redis.

### 2.3 Join via shareable link (student-friendly, PM-5)
1. User opens invite link `/invite/:token`.
2. API resolves token → scope (viewer/editor), expiry, `requireLogin`, `singleUse`.
3. If `requireLogin` and not authed → prompt login/register (return to link after).
4. If guest-view allowed → enter session as viewer (no account) — can view/chat per config.
5. To edit/persist → account required → upgrade prompt.
6. → Session Workspace with granted role.

**System:** invite validated server-side; role attached to membership; `auditLogs` entry (`invite.accepted`).

---

## 3. Workspace & Project Flows

### 3.1 Create workspace
1. Dashboard → "New workspace" → name → `workspaces` doc (owner = creator).
2. Default settings: `e2ee=false`, `defaultLinkScope=viewer`.

### 3.2 Create project
1. In workspace → "New project" → choose type: **code / canvas / mixed**.
2. (If E2EE offered) choose **Standard** or **E2EE** — E2EE shows feature-loss disclosure, requires confirm.
3. `projects` doc created; empty file tree / blank canvas initialized.
4. → Session Workspace.

### 3.3 Invite members (PM-5/6) `[owner/editor per config]`
1. Project/workspace → "Invite" → email(s) or generate link.
2. Choose scope (viewer/editor), expiry, requireLogin, singleUse.
3. Email path: send invite email (async) with link.
4. `auditLogs` entry (`invite.created`).

### 3.4 Manage roles `[owner/admin]`
1. Members panel → change role (viewer↔editor↔admin) or remove.
2. Server re-checks caller is owner/admin → update `workspaces.members` → broadcast `presence:update` → `auditLogs` (`role.changed`).

---

## 4. Session Join & Presence Lifecycle (core real-time flow)

### 4.1 Join
1. Open project → client requests session bootstrap (REST): project meta, file tree, permissions.
2. Client opens Socket.io `/session`, emits `join {projectId, token}`.
3. Gateway: verify token → RBAC check → add to room → subscribe Redis `room:{projectId}`.
4. Gateway sends Yjs `sync:step1` (state vector); client responds; server sends missing updates → **documents converge**.
5. Awareness exchanged → remote cursors/presence appear.
6. Recent chat history (Redis cache → Mongo fallback) loaded.
7. Presence heartbeat starts (Redis TTL).
8. UI: all surfaces interactive; participant list populated.

### 4.2 During session
- Any surface action ⇄ Gateway ⇄ all peers (via Redis fan-out).
- Heartbeats refresh presence TTL.
- `activity` events stream to Activity Feed.

### 4.3 Leave / disconnect
1. Client `leave` or socket drop.
2. Gateway removes from room; presence TTL expiry marks offline; broadcast `presence:update`.
3. If last participant → schedule session finalize: write `sessions` record (participants, timings), (async) snapshot compaction, sandbox idle-reclaim timer starts.

---

## 5. Canvas Flow (CV-*)

### 5.1 Draw
1. User selects tool (pen/shape/text/etc.) + color/brush.
2. Pointer down/move/up → local optimistic render (0ms).
3. Stroke → Yjs canvas doc update → `doc:update` ⇄ peers → all render with user's color/label (<100ms).
4. Object added to scene graph (Y.Map/Y.Array); layer assignment.

### 5.2 Layers / undo / zoom (CV-4/5/7)
- Layer panel: reorder/hide/lock → mutate Y.Array of layers.
- **Undo/redo:** UndoManager scoped to user origin → pops only that user's last op.
- Zoom/pan: client viewport transform (not shared unless "follow" mode).

### 5.3 Replay (CV-6)
1. Open replay → load nearest `crdtSnapshot` + stream `crdtUpdates` up to scrub position.
2. Timeline scrubber reconstructs canvas state at time T.

### 5.4 Export (CV-9)
1. Export → choose PNG/SVG/`.yumi`.
2. Server (or client) flattens scene graph → file → download.

---

## 6. Code Editor Flow (CE-*)

### 6.1 Edit
1. Open file from file tree → editor binds to Yjs doc for that file.
2. Keystrokes → local render (0ms) → Yjs update → `doc:update` ⇄ peers (<100ms).
3. Concurrent edits converge automatically (CRDT) — no conflict dialog.
4. Remote cursors/selections shown in user colors with name labels.

### 6.2 File tree ops (CE-6) `[editor+]`
- Create/rename/delete/move → update `files` + `projects.fileTree` → broadcast.

### 6.3 Shared terminal (CE-5) `[editor+ to type]`
1. First run → Sandbox Manager provisions container (lazy).
2. `terminal:input` (role-gated) → sandbox → `terminal:output` streamed ⇄ all viewers.
3. Idle → container reclaimed; files persisted.

### 6.4 Git & diff (CE-7/8)
- Git history/status read from repo → shown in panel.
- Diff view attributes changes by user (from CRDT authorship / commit metadata).

### 6.5 Live preview (advanced)
1. Web project → sandbox serves port → proxied preview pane updates on save/edit.

---

## 7. Communication Flows

### 7.1 Chat (MS-*)
1. Type message (rich text/emoji) → `chat:message` → Gateway persists (Mongo) + caches (Redis) → ⇄ peers.
2. @mention → notification service → in-app; if offline → email/push (async).
3. Reactions/threads → update message doc → broadcast.
4. Search → REST query (text index) → results.

### 7.2 Video/Audio (VA-*)
1. "Start call" → signaling via `rtc:signal`.
2. ≤4 participants → mesh P2P; >4 → SFU (Phase 2).
3. Screen share → additional track.
4. Mute/video toggle → track enable/disable + presence status.
5. **Failure → fallback ladder:** full → audio-only → TURN → text banner (<3s).
6. Recording (P1) → server composites → `sessions.recordingRef`.

---

## 8. Advanced Feature Flows

### 8.1 AI code completion
1. Editor context (cursor + surrounding code) → `ai:suggest:request` → AI Service (latest Claude model).
2. Suggestion → `ai:suggest:result` → shown inline; accept inserts via Yjs update (visible to all).
3. E2EE project → feature disabled (server can't read).

### 8.2 AI chat assistant (tutor)
1. Ask question in AI panel → AI Service with optional code context → answer streamed.

### 8.3 Time-travel debugging / replay
1. Open history → snapshot + updates reconstruct code state at step N → step forward/back.

### 8.4 Collaborative debugging (Phase 3)
1. Set breakpoint (shared) → sandbox debug adapter → paused state broadcast → all see current line/vars.

### 8.5 Integrations
- GitHub: OAuth → repo import/commit view.
- Figma: import frames to canvas.
- Slack: notifications out.

---

## 9. Settings, Notifications, Snapshots

- **Settings:** profile, theme (dark/light), shortcuts, layout presets, notifications, connected accounts, data controls (export/delete — GDPR).
- **Notifications:** invites, @mentions, session-start, role changes → in-app + email/push per prefs.
- **Snapshots:** "Save snapshot" → named checkpoint (`crdtSnapshot` + metadata); "Load" restores.

---

## 10. Error & Edge-Case Flows

| Scenario | Handling |
|---|---|
| Socket drop mid-session | Auto-reconnect w/ backoff; Yjs re-syncs (no data loss); presence restored |
| Concurrent edits same spot | CRDT converges; no conflict dialog |
| Video connection fails | Fallback ladder (§7.2) |
| Sandbox crash/timeout | Error to terminal; container reclaimed; files preserved |
| Permission denied action | Server rejects; client shows toast; no state change |
| Invite expired/used | Resolve fails → friendly error → request new invite |
| Offline (no connectivity) | Read-only local view; queue local edits; sync on reconnect (best-effort, not full offline in v1) |
| Session timeout (idle) | Warn → disconnect → cleanup |
| E2EE project + AI request | Feature hidden/disabled with explanation |

---

## 11. State Summary (client)

- **Shared (Yjs):** code docs, canvas scene graph, layers.
- **Ephemeral (Awareness):** cursors, selections, presence, typing.
- **Local (store):** UI layout, active tool, theme, panel sizes, transient dialogs.
- **Server-authoritative:** roles/permissions, membership, message persistence, audit, session records.
