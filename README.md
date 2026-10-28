# Yumi

The unified collaborative workspace — **draw, code, talk, and message on one living surface**.
See `PRD.md`, `TRD.md`, `design.md`, and `implementationplan.md` for the full spec.

## Stack
React · Express · Socket.io · Redis · MongoDB · Yjs (CRDT) · CodeMirror 6

## Monorepo layout
```
apps/
  server/   Express REST + Socket.io gateway (auth, RBAC, realtime, persistence)
  web/      React SPA (auth, dashboard, collaborative session)
packages/
  shared/   Types, roles, socket event names, Zod DTOs (single source of truth)
  ui/       Design tokens (theme.css / theme.ts)
```

## Prerequisites
- Node ≥ 20, pnpm ≥ 11
- Docker (for local Mongo + Redis)

## Quick start
```bash
pnpm install
cp .env.example .env          # already done on first setup
pnpm infra:up                 # start Mongo + Redis (docker compose)
pnpm dev                      # runs server (:4000) + web (:5173) together
```
Then open **http://localhost:5173**.

Run them separately if you prefer:
```bash
pnpm dev:server   # http://localhost:4000
pnpm dev:web      # http://localhost:5173
```

## Try it
1. Register an account, create a workspace, then a **code** or **mixed** project.
2. Open the project — you're in a live session (file tree · editor · chat · presence).
3. Open the same project in a second browser/incognito (or accept an invite link from the
   workspace page) to see **real-time multi-cursor editing, live presence, and chat**.

## Verify the flagship (headless CRDT test)
With infra + server running:
```bash
cd apps/web && node test/collab.test.mjs
```
Two clients make concurrent edits and must converge; a fresh client must load the
persisted content. Both assertions should print ✅.

## What works today (Phase 0 + Phase 1 + much of Phase 2)
- Email/password auth (argon2) with JWT access + refresh; RBAC enforced server-side
- Workspaces, projects, invite links (scope/expiry/single-use)
- Socket.io gateway with JWT handshake + RBAC-gated room join
- **Collaborative code editor** (CodeMirror 6 + Yjs): remote cursors, per-user undo, 11
  languages, file-tree CRUD, persistence + late-join sync, **AI ghost-text completion**
- **Shared terminal / sandbox**: Docker-isolated compile+run for JS/TS/Python/Java/C++/Go/Rust
- **Collaborative canvas**: pen/highlight/shapes/**arrow**/text/sticky notes/image, **dashed
  strokes**, templates (flowchart/wireframe/kanban/mindmap), live cursors, zoom/pan, PNG export
- **Chat**: persisted history, @mentions, reactions, search, **threaded replies**, **1:1 DMs**
- **Presence** + live participant list; **video/audio** (WebRTC P2P mesh ≤4 + screen share)
- **AI assistant** (claude-opus-4-8, streamed); **live HTML preview**; **activity feed + analytics**
- **Replay / time-travel** for code docs (scrub the append-only CRDT log)
- **Enterprise**: audit log + retention + admin console, SSO (**OIDC + SAML 2.0**) + SCIM directory sync,
  end-to-end encrypted projects, verified backup/restore, and **region-pinned data residency**
  (`REGION` — a workspace is pinned where it was created; any other deployment refuses it and
  says where to go, and features that would send contents to a third party are refused too)

- **Collaborative debugging** for all seven runnable languages — one shared session per
  project, clickable breakpoints, call stack, locals and private expression evaluation
  (needs `pnpm --filter @yumi/server sandbox:build` once, for C++/Go/Rust)

## Not yet built (see tracker.md)
GitHub OAuth sign-in (deliberately — no ID token to verify) and the process-side compliance
work — SLA, SOC 2, pen test. See `verification.md` for what needs a human to confirm.

## Scripts
| Command | Does |
|---|---|
| `pnpm dev` | Run server + web |
| `pnpm infra:up` / `pnpm infra:down` | Start / stop Mongo + Redis |
| `pnpm --filter @yumi/server sandbox:build` | Build the C++/Go/Rust debug images (stock image + a debugger) |
| `pnpm --filter @yumi/server backup` | Verifiable snapshot → `./backups/` (see `dr.md`) |
| `pnpm --filter @yumi/server oplog:archive -- --from <backup>` | Extend a snapshot's oplog chain, for point-in-time recovery |
| `pnpm --filter @yumi/server restore -- --from <backup> [--to <ISO time>]` | Restore, optionally to a chosen moment |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Typecheck all packages |
