# Yumi — Data Schema (schema.md)

**Companion to:** `PRD.md`, `TRD.md`
**Database:** MongoDB (persistence) + Redis (cache/session/pubsub/presence)
**Version:** 1.0 · **Updated:** 2026-07-13
**Convention:** `_id` = ObjectId unless noted. Timestamps ISO/Date. `?` = optional. Binary = Yjs/CRDT payload.

> This document is the source of truth for collections, fields, relationships, and indexes. Changes here require a migration entry in `tracker.md`.

---

## 1. Entity-Relationship Overview

```
users ──< workspaces.members
workspaces ──< projects ──< files ──< crdtUpdates / crdtSnapshot
                       └──< canvases
workspaces ──< messages (channels / DMs)
workspaces ──< sessions ──(recordingRef)
workspaces ──< invites
workspaces ──< auditLogs
workspaces ──< analytics
```

---

## 2. MongoDB Collections

### 2.1 `users`
```jsonc
{
  "_id": ObjectId,
  "email": "string (unique, lowercased)",
  "passwordHash": "string?",              // argon2id; null if OAuth-only
  "oauthProviders": [                       // linked identities
    { "provider": "google|github", "providerUserId": "string" }
  ],
  "displayName": "string",
  "avatarColor": "string (hex)",           // used for cursor/label color
  "avatarUrl": "string?",
  "prefs": {
    "theme": "system|light|dark",
    "shortcuts": { "actionId": "keybinding" },
    "layout": { /* saved panel layout preset */ },
    "notifications": { "invites": true, "mentions": true, "sessionStart": true }
  },
  "status": "active|suspended|deleted",
  "createdAt": Date,
  "updatedAt": Date,
  "lastActiveAt": Date
}
```
**Indexes:** `{ email: 1 }` unique · `{ "oauthProviders.provider": 1, "oauthProviders.providerUserId": 1 }`.

### 2.2 `workspaces`
```jsonc
{
  "_id": ObjectId,
  "name": "string",
  "ownerId": ObjectId,                      // → users
  "plan": "free|edu|pro|enterprise",
  "members": [
    { "userId": ObjectId, "role": "owner|editor|viewer", "joinedAt": Date }
  ],
  "settings": {
    "defaultLinkScope": "viewer|editor",
    // Region this workspace's data must stay in. Set once, from the creating
    // deployment's own REGION, and immutable afterwards — the rows are already
    // written, so a later change would relabel data that has not moved. null =
    // unpinned (everything created before residency, and every deployment that
    // runs without a REGION). Any deployment outside the pinned region refuses
    // the workspace entirely, reads included.
    "dataResidencyRegion": "string?",        // enterprise
    "auditRetentionDays": 0,                 // 0 = keep forever
    "sso": { "enabled": false, "provider": "saml|oidc?", "config": {} }
  },
  "createdAt": Date,
  "updatedAt": Date
}
```
**Indexes:** `{ ownerId: 1 }` · `{ "members.userId": 1 }`.

### 2.3 `projects`
```jsonc
{
  "_id": ObjectId,
  "workspaceId": ObjectId,                  // → workspaces
  "name": "string",
  "type": "code|canvas|mixed",
  "e2ee": false,                            // if true: server AI/search/replay disabled
  "fileTree": [ /* nested { id, name, type:file|dir, children[] } */ ],
  "git": { "connected": false, "provider": "github?", "repo": "string?", "branch": "string?" },
  "createdBy": ObjectId,
  "createdAt": Date,
  "updatedAt": Date
}
```
**Indexes:** `{ workspaceId: 1, updatedAt: -1 }`.

### 2.4 `files`
```jsonc
{
  "_id": ObjectId,
  "projectId": ObjectId,                    // → projects
  "path": "string (e.g. src/index.js)",
  "language": "string",                     // for syntax highlighting
  "docId": "string",                        // Yjs doc key for this file
  "snapshotRef": ObjectId?,                 // → crdtSnapshot (latest)
  "updatedAt": Date
}
```
**Indexes:** `{ projectId: 1, path: 1 }` unique.

### 2.5 `canvases`
```jsonc
{
  "_id": ObjectId,
  "projectId": ObjectId,
  "docId": "string",                        // Yjs doc key for canvas
  "layers": [
    { "id": "string", "name": "string", "order": 0, "visible": true, "locked": false }
  ],
  "snapshotRef": ObjectId?,
  "updatedAt": Date
}
```
**Indexes:** `{ projectId: 1 }`.

### 2.6 `crdtUpdates`  (append-only replay log)
```jsonc
{
  "_id": ObjectId,
  "projectId": ObjectId,
  "docId": "string",                        // file or canvas doc
  "seq": Long,                              // monotonic per (projectId, docId)
  "update": BinData,                        // Yjs incremental update
  "userId": ObjectId,                       // authorship / attribution
  "ts": Date
}
```
**Indexes:** `{ projectId: 1, docId: 1, seq: 1 }`. **Never updated in place.** Compacted into snapshots; old tail truncated per retention.

### 2.7 `crdtSnapshot`  (compaction + named snapshots)
```jsonc
{
  "_id": ObjectId,
  "projectId": ObjectId,
  "docId": "string",
  "state": BinData,                         // full Yjs state at seq
  "seq": Long,                              // covers updates ≤ seq
  "kind": "auto|named",                     // named = user snapshot (PM)
  "label": "string?",                       // for named snapshots
  "createdBy": ObjectId?,
  "ts": Date
}
```
**Indexes:** `{ projectId: 1, docId: 1, seq: -1 }`.

### 2.8 `messages`
```jsonc
{
  "_id": ObjectId,
  "workspaceId": ObjectId,
  "channelType": "project|workspace|dm",
  "channelId": "string",                    // projectId, workspaceId, or dmPairKey
  "authorId": ObjectId,
  "body": "string (plain fallback)",
  "richContent": { /* ProseMirror/Markdown-subset JSON */ },
  "mentions": [ ObjectId ],                 // → users
  "reactions": [ { "emoji": "string", "userIds": [ObjectId] } ],
  "threadId": ObjectId?,                     // parent message for threading
  "editedAt": Date?,
  "ts": Date
}
```
**Indexes:** `{ workspaceId: 1, channelId: 1, ts: -1 }` · text index on `body` (search MS-4) · `{ threadId: 1 }`.
`dmPairKey` = sorted `userIdA:userIdB`.

### 2.9 `sessions`  (collaborative session records)
```jsonc
{
  "_id": ObjectId,
  "workspaceId": ObjectId,
  "projectId": ObjectId,
  "participants": [
    { "userId": ObjectId, "joinedAt": Date, "leftAt": Date? }
  ],
  "recordingRef": ObjectId?,                // → recording artifact (object store)
  "startedAt": Date,
  "endedAt": Date?
}
```
**Indexes:** `{ workspaceId: 1, startedAt: -1 }` · `{ projectId: 1, startedAt: -1 }`.

### 2.10 `invites`
```jsonc
{
  "_id": ObjectId,
  "workspaceId": ObjectId,
  "projectId": ObjectId?,                   // project-scoped invite optional
  "scope": "viewer|editor",
  "token": "string (signed, unique)",
  "expiresAt": Date?,
  "requireLogin": true,
  "singleUse": false,
  "usedBy": [ ObjectId ],
  "createdBy": ObjectId,
  "createdAt": Date
}
```
**Indexes:** `{ token: 1 }` unique · `{ workspaceId: 1 }` · TTL on `expiresAt`.

### 2.11 `auditLogs`  (append-only)
```jsonc
{
  "_id": ObjectId,
  "workspaceId": ObjectId,
  "actorId": ObjectId,
  "action": "auth.login|role.changed|invite.created|export|delete|access|...",
  "target": { "type": "string", "id": "string" },
  "meta": { /* action-specific */ },
  "ip": "string?",
  "prevHash": "string?",                    // optional hash-chain (enterprise tamper-evidence)
  "hash": "string?",
  "ts": Date
}
```
**Indexes:** `{ workspaceId: 1, ts: -1 }` · `{ actorId: 1, ts: -1 }`. **Never mutated.**

### 2.12 `analytics`  (session analytics)
```jsonc
{
  "_id": ObjectId,
  "workspaceId": ObjectId,
  "sessionId": ObjectId,
  "metrics": {
    "durationSec": 0,
    "participantCount": 0,
    "codeChanges": 0,
    "canvasObjects": 0,
    "messages": 0,
    "aiSuggestionsAccepted": 0
  },
  "ts": Date
}
```
**Indexes:** `{ workspaceId: 1, ts: -1 }` · `{ sessionId: 1 }`.

---

## 3. Redis Keyspace

| Key pattern | Type | TTL | Purpose |
|---|---|---|---|
| `session:{refreshTokenId}` | hash | refresh TTL | Auth session / refresh record |
| `revoked:{jti}` | string | token TTL | Access-token revocation list |
| `presence:{projectId}` | hash (userId→meta) | heartbeat TTL | Who is in room + status |
| `presence:hb:{projectId}:{userId}` | string | ~30s | Heartbeat key (expiry ⇒ offline) |
| `room:{projectId}` | pub/sub channel | — | Cross-instance event fan-out |
| `chat:recent:{channelId}` | list (capped) | rolling | Hot cache of recent messages |
| `doc:awareness:{docId}` | hash | ephemeral | Current awareness (cursors) |
| `ratelimit:{scope}:{userId}` | counter | window | Rate limiting (msg/AI/exec/auth) |
| `sandbox:{sessionId}` | hash | idle TTL | Sandbox container binding/state |

---

## 4. Relationships & Integrity Rules

- `workspaces.members[].userId` → `users._id`.
- `projects.workspaceId` → `workspaces._id`; delete workspace ⇒ cascade projects, files, canvases, crdt*, sessions, invites.
- `files.projectId` / `canvases.projectId` → `projects._id`.
- `crdtUpdates`/`crdtSnapshot` keyed by `(projectId, docId)`; `docId` links to `files.docId` or `canvases.docId`.
- `messages.mentions[]` / `reactions[].userIds[]` → `users._id`.
- **Append-only:** `crdtUpdates`, `auditLogs` — inserts only.
- **GDPR erasure:** on user delete → anonymize authorship (`userId` → tombstone), purge PII in `users`, remove from memberships; retain minimal `auditLogs` for legal compliance.

---

## 5. Migration & Versioning

- Schema version tracked; each change → migration script + `tracker.md` entry.
- Additive changes preferred; destructive migrations require snapshot backup first.
- `crdt*` log format tied to Yjs version — pin and record.

---

## 6. Open Schema Questions

1. Externalize message search to a dedicated engine at scale? (Mongo text index for v1.)
2. Store recording artifacts in object storage with only `recordingRef` in Mongo — confirm storage backend.
3. Hash-chain audit logs for all plans or enterprise-only?
4. Snapshot compaction cadence + retention per plan tier (needs cost model).
