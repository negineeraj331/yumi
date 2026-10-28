# Yumi — Engineering Rules & Conventions (rules.md)

**Companion to:** `TRD.md`, `implementationplan.md`
**Version:** 1.0 · **Updated:** 2026-07-13
**Purpose:** The non-negotiable engineering rules, conventions, and guardrails for building Yumi. Read before writing code. These encode the architectural decisions so they aren't accidentally violated.

---

## 1. Stack Rules (Hard Constraints)

1. **Do not substitute the core stack.** Frontend = React. Backend = Express. Realtime = Socket.io. Cache/session/pubsub = Redis. Persistence = MongoDB. Any deviation requires a Decision Log entry (`tracker.md §8`) and sign-off.
2. **Media never flows through Express.** Socket.io is signaling only; WebRTC/SFU carries media.
3. **Shared collaborative state lives in Yjs (CRDT), not ad-hoc JSON diffing.** Cursors/presence go through Awareness (ephemeral), never the persisted doc log.
4. **Redis is not the source of truth.** MongoDB is durable; Redis is cache/session/presence/pubsub only. Never store data whose loss is unacceptable solely in Redis.

---

## 2. Real-Time Rules

1. **Optimistic UI always.** The acting user sees their action at 0ms; never block local render on server ack.
2. **Latency budget is a contract.** Cursor/stroke/keystroke propagation must stay <100ms p95 intra-region. Any change that regresses the CI latency test **blocks release**.
3. **Coalesce high-frequency events.** Cursors ≤1/30ms; edits batched ~60fps. Never emit per-pixel/per-keystroke unbatched.
4. **Awareness is ephemeral.** Never persist cursor/presence to Mongo; never append it to the CRDT update log.
5. **CRDT convergence is sacred.** Never mutate shared state outside Yjs transactions. All concurrent-edit correctness relies on this; add a convergence test for any new shared type.
6. **Per-user undo.** Undo uses UndoManager scoped to the user's origin; it must never undo another user's operation.

---

## 3. Security & Authorization Rules

1. **Server-side authorization on every mutation.** REST middleware + socket event guards re-check role for the target workspace/project. **Client-side gating is UX only — never the enforcement boundary.**
2. **Never trust the client.** Validate every payload (Zod/JSON Schema) at the boundary; enforce size limits.
3. **Auth on socket handshake.** Reject/close unauthenticated sockets. Re-verify token validity; honor Redis revocation list.
4. **Secrets never in the repo or client bundle.** Use KMS/Vault + env. No API keys, no DB creds, no signing keys client-side.
5. **Sandbox is hostile-by-default.** User code runs with: no host network (egress allowlist only), resource caps, execution timeouts, no mounted credentials, output size limits. Treat every sandbox change as security-critical review.
6. **Sanitize all rich text** (chat/messages) against XSS before render/persist.
7. **Rate-limit** messages, AI calls, exec runs, and auth attempts via Redis counters.
8. **Audit security-relevant actions** (auth, role change, invite, export, delete, access) to append-only `auditLogs`. Never mutate audit entries.
9. **E2EE projects disable server-dependent features** (AI, server search, server recording/replay). Enforce this in code, and surface the disclosure in UI before project creation. Never silently send E2EE content to the AI service.
10. **A pinned data region is enforced server-side, on every path, reads included.** A deployment outside a workspace's region refuses it (421) — REST, socket, SCIM and invites alike. The pin is set at creation and is immutable. And because pinning storage does not pin *processing*, anything that hands content to a third party (AI, GitHub, Figma, Slack) is refused in a pinned workspace unless an operator has explicitly declared otherwise. Never let a residency setting be decorative.

---

## 4. Data & Schema Rules

1. **`schema.md` is the source of truth.** Any collection/field/index change updates `schema.md` + adds a migration row in `tracker.md §7`.
2. **Append-only means append-only.** `crdtUpdates` and `auditLogs` are never updated or deleted in place (except retention/compaction jobs and legal purges).
3. **Index before you query at scale.** Every hot query path must have a matching index (see `schema.md`).
4. **GDPR erasure must cascade.** User deletion anonymizes authorship + purges PII across collections; retain only minimal legally-required audit records.
5. **Prefer additive migrations.** Destructive migrations require a verified backup first.
6. **Snapshot + compact** CRDT logs on schedule; never let the update log grow unbounded.

---

## 5. Code Quality & Structure Rules

1. **TypeScript everywhere**, strict mode on. Shared types live in `/packages/shared` — event names, role enums, DTOs are defined once and imported (no string-duplicated socket event names).
2. **Match surrounding code.** Follow existing naming, structure, and comment density in the file you edit. Don't reformat unrelated code.
3. **No dead/speculative code.** Build what the phase needs; defer the rest (tracked in `tracker.md`).
4. **Errors are handled, not swallowed.** Surface actionable errors to the client (toast) and log structured server-side with correlation IDs.
5. **Pure/testable core.** Keep RBAC checks, validators, and CRDT helpers as pure, unit-tested functions.
6. **Feature flags** for phased/segment features (e.g., E2EE, SFU, AI) — ship dark, enable deliberately.

---

## 6. Testing Rules

1. **No merge without tests** for new logic: unit (reducers/guards/validators), integration (API+Mongo+Redis), and — for shared state — a **CRDT convergence test**.
2. **Latency test in CI** must pass; treat p95 regression as a build failure.
3. **Authorization tests** must cover the negative case (viewer cannot edit/draw/run — rejected server-side).
4. **Sandbox escape / isolation tests** required for any sandbox change.
5. **E2E happy path** (join→draw→code→chat→call→replay) runs before each release.

---

## 7. Performance Rules

1. **Binary payloads** for CRDT/awareness; don't JSON-serialize Yjs updates.
2. **Canvas: object-addressable scene graph**, not raster; target 60fps at 10k objects.
3. **Lazy-load** heavy surfaces (editor, canvas, video) and sandbox (provision on first use).
4. **Cache recent messages** in Redis for fast session join; fall back to Mongo.
5. **Reclaim idle resources** (sandboxes, presence TTLs, sessions) aggressively — especially on free/edu tier.

---

## 8. UX & Accessibility Rules

1. **Progressive disclosure.** Default UI minimal; power features behind command palette / advanced panels. Don't overwhelm students; don't slow developers.
2. **Collaborator color identity is consistent** across cursor, selection, attribution, avatar, and activity feed. Treat as a hard requirement.
3. **WCAG 2.1 AA.** Keyboard navigation, focus rings, ARIA labels, AA contrast in both themes. Validate the collaborator palette for contrast + colorblind safety.
4. **Respect `prefers-reduced-motion`** and `prefers-color-scheme`.
5. **Every component ships all states** (default/hover/focus/active/disabled/loading/error/empty) in light + dark.
6. **Design tokens only.** Use theme variables from the design system — no hardcoded colors/spacing once `design.md` is finalized.

---

## 9. Git & Process Rules

1. **Branch per task**; never commit directly to `main`.
2. **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
3. **PRs reference the tracker task** and update `tracker.md` status.
4. **Commit/push only when asked**; keep secrets and generated artifacts out of VCS (`.gitignore`).
5. **Decisions get logged** in `tracker.md §8`; architectural changes update `TRD.md`.
6. **Docs move with code.** Changing behavior updates the relevant `.md` (PRD/TRD/appflow/schema) in the same PR.

---

## 10. Definition of Done (per task)

A task is **Done** only when:
- [ ] Meets its acceptance criteria (PRD/TRD).
- [ ] Server-side authorization enforced (if it mutates).
- [ ] Tests written and passing (incl. convergence/latency/authz where relevant).
- [ ] Latency budget respected (real-time paths).
- [ ] Accessibility checked (UI).
- [ ] Docs updated (schema/TRD/appflow as needed).
- [ ] `tracker.md` status set to ✅ with notes.
- [ ] No secrets committed; feature-flagged if phased.
