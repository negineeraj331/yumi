/**
 * Realtime gateway (Socket.io). Handles auth handshake, RBAC-gated room join,
 * Yjs document sync + persistence, awareness/cursor relay, chat, and presence.
 * See TRD.md §3 and appflow.md §4.
 */
import type { Server, Socket } from "socket.io";
import * as Y from "yjs";
import { SOCKET_EVENTS, roleAtLeast, chatMessageSchema, dmMessageSchema, dmChannelId, DEBUGGABLE_LANGUAGES, type Role } from "@yumi/shared";
import { verifyAccessToken } from "./auth.js";
import { getProjectAccess } from "./middleware.js";
import { regionMismatch, auditRegionBlock, egressBlockReason, auditEgressBlock } from "./residency.js";
import { CrdtUpdate, Message, User, CollabSession, Analytics, Workspace, Project, toBytes } from "./models.js";
import { redis } from "./db.js";
import { socketRateOk } from "./ratelimit.js";
import { runCode, canRun, runTests, canTest, runPerf, canProfile } from "./runner.js";
import { streamAssistant, completeCode, isAIConfigured, type AiTurn } from "./ai.js";
import { registerSfuHandlers } from "./sfu.js";
import { config } from "./config.js";
import { notify as slackNotify } from "./slack.js";
import { canDebug, getSession, startSession as startDebugSession, stopSession as stopDebugSession } from "./debugger.js";
import type { SlackEvent } from "@yumi/shared";

const PRESENCE_TTL = 45; // seconds — refreshed by client heartbeat

interface SocketData {
  userId: string;
  displayName: string;
  avatarColor: string;
  projectId?: string;
  workspaceId?: string;
  role?: Role;
  /**
   * The data region this project's workspace is pinned to, captured at join.
   * Safe to hold for the life of the socket because a pin is set once at
   * workspace creation and refused afterwards — the same reason the e2ee flag
   * below is cached without expiry.
   */
  region?: string | null;
}

/** In-memory Yjs docs, loaded lazily from the persisted update log. */
const docs = new Map<string, Y.Doc>();
const seqCounters = new Map<string, number>();

/** A single CRDT frame ceiling, so an encrypted project (which the server cannot
 * inspect at all) still cannot be used to push arbitrary blobs into storage. */
const MAX_UPDATE_BYTES = 2_000_000;

/**
 * Whether a project is end-to-end encrypted.
 *
 * Cached without expiry because the flag is fixed at creation and refused
 * afterwards — a project cannot become encrypted, or stop being encrypted,
 * while documents written under the old assumption still exist.
 */
const e2eeFlags = new Map<string, boolean>();
export async function isE2ee(projectId: string): Promise<boolean> {
  const cached = e2eeFlags.get(projectId);
  if (cached !== undefined) return cached;
  const project = await Project.findById(projectId).select("e2ee").lean().catch(() => null);
  const flag = Boolean(project?.e2ee);
  if (project) e2eeFlags.set(projectId, flag);
  return flag;
}

async function loadDoc(projectId: string, docId: string): Promise<Y.Doc> {
  const key = `${projectId}::${docId}`;
  const existing = docs.get(key);
  if (existing) return existing;

  const doc = new Y.Doc();
  const updates = await CrdtUpdate.find({ projectId, docId }).sort({ seq: 1 }).lean();
  Y.transact(doc, () => {
    for (const u of updates) {
      try {
        const bytes = toBytes(u.update);
        if (bytes.length) Y.applyUpdate(doc, bytes);
      } catch (err) {
        // Skip a corrupt persisted update rather than crashing the whole doc load.
        console.error(`[gateway] skipping bad update seq=${u.seq} doc=${docId}:`, (err as Error).message);
      }
    }
  });
  seqCounters.set(key, updates.length ? updates[updates.length - 1].seq : 0);
  docs.set(key, doc);
  return doc;
}

async function persistUpdate(projectId: string, docId: string, update: Uint8Array, userId: string) {
  const key = `${projectId}::${docId}`;
  const seq = (seqCounters.get(key) ?? 0) + 1;
  seqCounters.set(key, seq);
  await CrdtUpdate.create({ projectId, docId, seq, update: Buffer.from(update), userId });
}

/** True if two users belong to (or own) at least one common workspace — DM eligibility. */
async function shareAWorkspace(a: string, b: string): Promise<boolean> {
  const count = await Workspace.countDocuments({
    $and: [
      { $or: [{ ownerId: a }, { "members.userId": a }] },
      { $or: [{ ownerId: b }, { "members.userId": b }] },
    ],
  });
  return count > 0;
}

const presenceKey = (projectId: string) => `presence:${projectId}`;
const activeSessionKey = (projectId: string) => `session:active:${projectId}`;

async function roomPresence(projectId: string) {
  const raw = await redis.hgetall(presenceKey(projectId));
  return Object.values(raw).map((v) => JSON.parse(v));
}

/** Emit a live activity-feed event to everyone in the room. */
function emitActivity(io: Server, projectId: string, ev: {
  action: string; actor: string; actorColor: string; detail?: string;
}) {
  io.to(projectId).emit(SOCKET_EVENTS.ACTIVITY, { ...ev, ts: Date.now() });
}

/**
 * Fire a Slack notification for a project, if it has one linked and the event
 * enabled. Fire-and-forget: notifications must never delay or break a session,
 * so this is never awaited on the hot path and can't reject.
 */
function slackFire(projectId: string, event: SlackEvent, ctx: { actor?: string; fileName?: string }, data: any = {}) {
  void (async () => {
    try {
      const { Project } = await import("./models.js");
      const p: any = await Project.findById(projectId).lean();
      if (!p?.slack?.webhookUrl) return;
      // Linking Slack in a pinned workspace is refused, but a link can outlive
      // the permission that allowed it — an operator narrowing
      // RESIDENCY_ALLOW_EGRESS must stop the posts, not just future links.
      const ws: any = await Workspace.findById(p.workspaceId).select("settings.dataResidencyRegion").lean();
      const region = ws?.settings?.dataResidencyRegion ?? null;
      if (egressBlockReason(region, "slack")) {
        await auditEgressBlock(String(p.workspaceId), undefined, "slack", region);
        return;
      }
      await slackNotify(p.slack, event, { projectName: p.name, ...ctx }, data);
    } catch (err) {
      console.warn(`[slack] ${event} lookup failed:`, (err as Error).message);
    }
  })();
}

/** Start a session record when the room goes empty→active. */
async function startSession(workspaceId: string, projectId: string, userId: string) {
  const existing = await redis.get(activeSessionKey(projectId));
  if (existing) return;
  const doc = await CollabSession.create({
    workspaceId, projectId, participants: [{ userId, joinedAt: new Date() }], startedAt: new Date(),
  });
  await redis.set(activeSessionKey(projectId), String(doc._id), "EX", 60 * 60 * 12);
}

async function addParticipant(projectId: string, userId: string) {
  const sid = await redis.get(activeSessionKey(projectId));
  if (!sid) return;
  const s = await CollabSession.findById(sid);
  if (!s) return;
  if (!s.participants.some((p) => String(p.userId) === userId)) {
    s.participants.push({ userId: userId as any, joinedAt: new Date(), leftAt: null });
    await s.save();
  }
}

/** Finalize a session when the room empties: write endedAt + analytics. */
async function finalizeSession(projectId: string) {
  // The room is empty — no one is left to drive or watch the debugger.
  await stopDebugSession(projectId).catch(() => {});
  const sid = await redis.get(activeSessionKey(projectId));
  if (!sid) return;
  await redis.del(activeSessionKey(projectId));
  const s = await CollabSession.findById(sid);
  if (!s || s.endedAt) return;
  const endedAt = new Date();
  s.endedAt = endedAt;
  for (const p of s.participants) if (!p.leftAt) p.leftAt = endedAt;
  await s.save();

  const durationSec = Math.round((endedAt.getTime() - s.startedAt.getTime()) / 1000);
  const messages = await Message.countDocuments({ channelId: projectId, ts: { $gte: s.startedAt } });
  await Analytics.create({
    workspaceId: s.workspaceId, projectId, sessionId: s._id,
    metrics: { durationSec, participantCount: s.participants.length, messages },
  });
  slackFire(projectId, "session.ended", {}, { durationSec, participantCount: s.participants.length, messages });
}

/**
 * The live server, so access can be withdrawn from someone who is already
 * connected. A socket is authenticated once at handshake, so without this a
 * deprovisioned user would sit in the room until they chose to leave.
 */
let liveIo: Server | null = null;

/** Disconnect every socket belonging to a user. Safe to call when they have none. */
export function disconnectUser(userId: string): number {
  if (!liveIo) return 0;
  let dropped = 0;
  for (const socket of liveIo.sockets.sockets.values()) {
    if ((socket.data as SocketData)?.userId === String(userId)) {
      socket.disconnect(true);
      dropped++;
    }
  }
  return dropped;
}

export function attachGateway(io: Server) {
  liveIo = io;
  // --- Auth handshake: reject unauthenticated sockets (rules.md §3.3) ---
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("No auth token"));
    try {
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub).lean();
      if (!user) return next(new Error("User not found"));
      // The handshake already has the account in hand, so this costs nothing.
      if (user.status !== "active") return next(new Error("This account has been deactivated"));
      const data = socket.data as SocketData;
      data.userId = String(user._id);
      data.displayName = user.displayName;
      data.avatarColor = user.avatarColor;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;

    // Personal room for direct messages — reachable regardless of project room.
    socket.join(`user:${data.userId}`);

    // SFU media signaling (only exercised when the room runs in "sfu" call mode).
    registerSfuHandlers(io, socket, () => ({ projectId: data.projectId, userId: data.userId }));

    // --- Join a project session room (RBAC enforced server-side) ---
    socket.on(SOCKET_EVENTS.JOIN, async ({ projectId }: { projectId: string }) => {
      const { role, region, workspaceId } = await getProjectAccess(projectId, data.userId);
      if (!role) {
        socket.emit(SOCKET_EVENTS.ERROR, { error: "Access denied to project" });
        return;
      }
      // The realtime path is where document contents actually travel, so the
      // region check has to live here too — a REST-only check would refuse the
      // page that lists the files while the editor itself synced happily.
      const mismatch = regionMismatch(region);
      if (mismatch) {
        await auditRegionBlock(workspaceId!, data.userId, { via: "socket", region: mismatch.region });
        socket.emit(SOCKET_EVENTS.ERROR, mismatch);
        return;
      }
      data.projectId = projectId;
      data.workspaceId = workspaceId ?? undefined;
      data.region = region;
      data.role = role;
      socket.join(projectId);

      await redis.hset(
        presenceKey(projectId),
        data.userId,
        JSON.stringify({
          userId: data.userId,
          displayName: data.displayName,
          avatarColor: data.avatarColor,
          role,
        })
      );
      await redis.expire(presenceKey(projectId), PRESENCE_TTL);

      // Session lifecycle: start on first participant, else attach.
      const size = await redis.hlen(presenceKey(projectId));
      const { Project } = await import("./models.js");
      const project = await Project.findById(projectId).lean();
      if (project) {
        if (size <= 1) await startSession(String(project.workspaceId), projectId, data.userId);
        else await addParticipant(projectId, data.userId);
      }

      socket.emit(SOCKET_EVENTS.JOINED, { projectId, role, callMode: config.callMode });
      io.to(projectId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, { users: await roomPresence(projectId) });
      emitActivity(io, projectId, { action: "joined", actor: data.displayName, actorColor: data.avatarColor });
      if ((project as any)?.slack?.webhookUrl) {
        slackFire(projectId, "member.joined", { actor: data.displayName }, { participants: size });
      }
    });

    // --- Heartbeat: refresh presence TTL so stale/zombie clients expire ---
    socket.on("heartbeat", async () => {
      if (data.projectId) await redis.expire(presenceKey(data.projectId), PRESENCE_TTL);
    });

    // --- Yjs: client requests full state for a doc (late-join sync) ---
    socket.on(SOCKET_EVENTS.SYNC_STEP, async ({ docId }: { docId: string }) => {
      if (!data.projectId || typeof docId !== "string") return;
      try {
        if (await isE2ee(data.projectId)) {
          // Nothing here can be merged, because none of it can be read. The
          // client gets the log and rebuilds the document itself.
          const rows = await CrdtUpdate.find({ projectId: data.projectId, docId })
            .sort({ seq: 1 }).select("update").lean();
          socket.emit(SOCKET_EVENTS.SYNC_STEP, {
            docId, updates: rows.map((r) => Buffer.from(toBytes(r.update))),
          });
          return;
        }
        const doc = await loadDoc(data.projectId, docId);
        const state = Y.encodeStateAsUpdate(doc);
        socket.emit(SOCKET_EVENTS.SYNC_STEP, { docId, update: Buffer.from(state) });
      } catch (err) {
        console.error(`[gateway] sync:step failed doc=${docId}:`, (err as Error).message);
      }
    });

    // --- Yjs: incremental doc update — apply, persist, broadcast ---
    socket.on(
      SOCKET_EVENTS.DOC_UPDATE,
      async ({ docId, update }: { docId: string; update: ArrayBuffer }) => {
        if (!data.projectId || !data.role || typeof docId !== "string") return;
        if (!roleAtLeast(data.role, "editor")) return; // viewers cannot mutate
        if (!update) return;
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(update);
          if (!bytes.length) return; // ignore empty frames
          if (bytes.length > MAX_UPDATE_BYTES) return;
          // An encrypted project's updates are opaque: there is nothing to
          // apply, and trying would only corrupt a document the server has no
          // business reconstructing.
          if (!(await isE2ee(data.projectId))) {
            const doc = await loadDoc(data.projectId, docId);
            Y.applyUpdate(doc, bytes); // throws on malformed input — caught below
          }
        } catch (err) {
          console.error(`[gateway] rejecting bad doc:update doc=${docId}:`, (err as Error).message);
          return; // never crash the process on a bad frame
        }
        await persistUpdate(data.projectId, docId, bytes, data.userId);
        socket.to(data.projectId).emit(SOCKET_EVENTS.DOC_UPDATE, { docId, update });
      }
    );

    // --- Awareness / cursors: ephemeral, relay only (never persisted) ---
    socket.on(SOCKET_EVENTS.AWARENESS, ({ docId, update }: { docId: string; update: ArrayBuffer }) => {
      if (!data.projectId) return;
      socket.to(data.projectId).emit(SOCKET_EVENTS.AWARENESS, { docId, update });
    });

    // --- Chat message: persist + broadcast ---
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, async (payload) => {
      const parsed = chatMessageSchema.safeParse(payload);
      if (!parsed.success || !data.projectId) return;
      if (parsed.data.projectId !== data.projectId) return;
      // Flood control: max 20 messages / 10s per user.
      if (!(await socketRateOk("chat", data.userId, 10, 20))) return;

      // Thread reply: validate the root exists in this channel and is itself top-level.
      let threadId: string | null = null;
      if (parsed.data.threadId) {
        const root = await Message.findOne({ _id: parsed.data.threadId, channelId: data.projectId }).lean();
        if (!root) return;
        threadId = String((root as any).threadId ?? root._id);
      }

      const msg = await Message.create({
        channelType: "project",
        channelId: data.projectId,
        authorId: data.userId,
        body: parsed.data.body,
        mentions: parsed.data.mentions,
        threadId,
      });
      io.to(data.projectId).emit(SOCKET_EVENTS.CHAT_MESSAGE, {
        id: String(msg._id),
        body: msg.body,
        authorId: data.userId,
        authorName: data.displayName,
        authorColor: data.avatarColor,
        threadId,
        ts: msg.ts,
      });
    });

    // --- Direct message: persist under a stable DM channel + route to both users ---
    socket.on(SOCKET_EVENTS.DM_MESSAGE, async (payload) => {
      const parsed = dmMessageSchema.safeParse(payload);
      if (!parsed.success) return;
      const toUserId = parsed.data.toUserId;
      if (toUserId === data.userId) return; // no DMs to self
      if (!(await socketRateOk("dm", data.userId, 10, 20))) return;
      // Recipient must exist and share at least one workspace with the sender.
      const recipient = await User.findById(toUserId).lean();
      if (!recipient || !(await shareAWorkspace(data.userId, toUserId))) return;

      const channelId = dmChannelId(data.userId, toUserId);
      const msg = await Message.create({
        channelType: "dm",
        channelId,
        authorId: data.userId,
        body: parsed.data.body,
      });
      const out = {
        id: String(msg._id),
        channelId,
        body: msg.body,
        authorId: data.userId,
        authorName: data.displayName,
        authorColor: data.avatarColor,
        toUserId,
        ts: msg.ts,
      };
      io.to(`user:${toUserId}`).emit(SOCKET_EVENTS.DM_MESSAGE, out);
      io.to(`user:${data.userId}`).emit(SOCKET_EVENTS.DM_MESSAGE, out);
    });

    // --- Run code in the sandbox; stream result to the whole room (shared terminal) ---
    socket.on(SOCKET_EVENTS.RUN_START, async ({ language, code, fileName }: { language: string; code: string; fileName?: string }) => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      if (typeof code !== "string" || !canRun(language)) {
        socket.emit(SOCKET_EVENTS.RUN_DONE, { ok: false, error: `Cannot run "${language}"`, stdout: "", stderr: "" });
        return;
      }
      if (code.length > 200_000) return;
      // Limit runs: 15 per minute per user.
      if (!(await socketRateOk("run", data.userId, 60, 15))) {
        socket.emit(SOCKET_EVENTS.RUN_DONE, { ok: false, error: "Run rate limit reached — wait a moment.", stdout: "", stderr: "" });
        return;
      }
      io.to(data.projectId).emit(SOCKET_EVENTS.RUN_OUTPUT, {
        status: "running", by: data.displayName, fileName, ts: Date.now(),
      });
      emitActivity(io, data.projectId, { action: "ran", actor: data.displayName, actorColor: data.avatarColor, detail: fileName });
      const result = await runCode(language, code);
      io.to(data.projectId).emit(SOCKET_EVENTS.RUN_DONE, { ...result, by: data.displayName, fileName });
      if (!result.ok) {
        slackFire(data.projectId, "run.failed", { actor: data.displayName, fileName },
          { exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr, error: result.error });
      }
    });

    // --- Run the file's tests in the sandbox; stream result to the whole room ---
    socket.on(SOCKET_EVENTS.TEST_START, async ({ language, code, fileName }: { language: string; code: string; fileName?: string }) => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      if (typeof code !== "string" || !canTest(language)) {
        socket.emit(SOCKET_EVENTS.TEST_DONE, { ok: false, error: `Cannot test "${language}"`, stdout: "", stderr: "", passed: 0, failed: 0, total: 0 });
        return;
      }
      if (code.length > 200_000) return;
      // Share the rate budget with runs (both spawn a container).
      if (!(await socketRateOk("run", data.userId, 60, 15))) {
        socket.emit(SOCKET_EVENTS.TEST_DONE, { ok: false, error: "Rate limit reached — wait a moment.", stdout: "", stderr: "", passed: 0, failed: 0, total: 0 });
        return;
      }
      io.to(data.projectId).emit(SOCKET_EVENTS.TEST_RUNNING, { by: data.displayName, fileName, ts: Date.now() });
      emitActivity(io, data.projectId, { action: "ran tests", actor: data.displayName, actorColor: data.avatarColor, detail: fileName });
      const result = await runTests(language, code);
      io.to(data.projectId).emit(SOCKET_EVENTS.TEST_DONE, { ...result, by: data.displayName, fileName });
      if (!result.ok) {
        slackFire(data.projectId, "tests.failed", { actor: data.displayName, fileName },
          { passed: result.passed, failed: result.failed, total: result.total, stderr: result.stderr, error: result.error });
      }
    });

    // --- Profile the file in the sandbox; stream metrics to the whole room ---
    socket.on(SOCKET_EVENTS.PERF_START, async ({ language, code, fileName, iterations }: { language: string; code: string; fileName?: string; iterations?: number }) => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      if (typeof code !== "string" || !canProfile(language)) {
        socket.emit(SOCKET_EVENTS.PERF_DONE, { ok: false, error: `Cannot profile "${language}"`, samples: [], iterations: 0 });
        return;
      }
      if (code.length > 200_000) return;
      // A perf run is N executions in one container — charge it 3 of the shared
      // run budget so profiling can't be used to sidestep the sandbox limit.
      if (!(await socketRateOk("run", data.userId, 60, 15, 3))) {
        socket.emit(SOCKET_EVENTS.PERF_DONE, { ok: false, error: "Rate limit reached — wait a moment.", samples: [], iterations: 0 });
        return;
      }
      const n = Math.max(1, Math.min(20, Math.floor(Number(iterations)) || 5));
      io.to(data.projectId).emit(SOCKET_EVENTS.PERF_RUNNING, { by: data.displayName, fileName, iterations: n, ts: Date.now() });
      emitActivity(io, data.projectId, { action: "profiled", actor: data.displayName, actorColor: data.avatarColor, detail: fileName });
      const result = await runPerf(language, code, n);
      io.to(data.projectId).emit(SOCKET_EVENTS.PERF_DONE, { ...result, by: data.displayName, fileName, language });
    });

    // --- Collaborative debugging: one shared session per project ---
    // Editors drive; everyone in the room watches the same state.
    socket.on(SOCKET_EVENTS.DEBUG_START, async ({ language, code, fileName, breakpoints }: {
      language: string; code: string; fileName?: string; breakpoints?: number[];
    }) => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      if (typeof code !== "string" || !canDebug(language)) {
        socket.emit(SOCKET_EVENTS.DEBUG_ERROR, { error: `Cannot debug "${language}" — ${DEBUGGABLE_LANGUAGES.join(", ")} are supported.` });
        return;
      }
      if (code.length > 200_000) return;
      // A debug session holds a container for as long as it runs, so it costs
      // more of the shared sandbox budget than a one-shot run.
      if (!(await socketRateOk("run", data.userId, 60, 15, 5))) {
        socket.emit(SOCKET_EVENTS.DEBUG_ERROR, { error: "Rate limit reached — wait a moment." });
        return;
      }
      const projectId = data.projectId;
      const lines = Array.isArray(breakpoints)
        ? breakpoints.filter((n) => Number.isInteger(n) && n > 0).slice(0, 100)
        : [];
      try {
        emitActivity(io, projectId, { action: "started debugging", actor: data.displayName, actorColor: data.avatarColor, detail: fileName });
        const state = await startDebugSession(projectId, language, fileName ?? "main.py", code, lines,
          // Must broadcast the callback's own argument: `state` is still in its
          // temporal dead zone while start() is running.
          (s) => io.to(projectId).emit(SOCKET_EVENTS.DEBUG_STATE, { state: s, by: data.displayName, fileName }));
        io.to(projectId).emit(SOCKET_EVENTS.DEBUG_STATE, { state, by: data.displayName, fileName });
      } catch (err) {
        socket.emit(SOCKET_EVENTS.DEBUG_ERROR, { error: `Could not start the debugger: ${(err as Error).message}` });
        await stopDebugSession(projectId).catch(() => {});
      }
    });

    socket.on(SOCKET_EVENTS.DEBUG_COMMAND, async ({ cmd, arg }: { cmd: string; arg?: string | number }) => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      const session = getSession(data.projectId);
      if (!session) {
        socket.emit(SOCKET_EVENTS.DEBUG_ERROR, { error: "No debug session is running." });
        return;
      }
      const allowed = ["continue", "next", "step", "out", "setBreakpoint", "clearBreakpoint", "evaluate"];
      if (!allowed.includes(cmd)) return;
      if (cmd === "evaluate" && (typeof arg !== "string" || arg.length > 500)) return;

      const result = await session.command(cmd, arg);
      if ("evaluated" in (result as any)) {
        // An evaluation is the asking user's business, not the whole room's.
        socket.emit(SOCKET_EVENTS.DEBUG_EVALUATED, { expression: arg, value: (result as any).evaluated });
      } else {
        io.to(data.projectId).emit(SOCKET_EVENTS.DEBUG_STATE, { state: result, by: data.displayName });
      }
    });

    socket.on(SOCKET_EVENTS.DEBUG_STOP, async () => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      const projectId = data.projectId;
      if (!getSession(projectId)) return;
      await stopDebugSession(projectId);
      emitActivity(io, projectId, { action: "stopped debugging", actor: data.displayName, actorColor: data.avatarColor });
    });

    // --- AI assistant: stream a reply to the asking user (any member) ---
    socket.on(SOCKET_EVENTS.AI_ASK, async ({ history, codeContext }: { history: AiTurn[]; codeContext?: string }) => {
      if (!data.projectId) return;
      // Checked before configuration: in an encrypted project the assistant is
      // unavailable whatever the deployment has set up, so "add an API key"
      // would send an operator to fix something that would not help.
      if (await isE2ee(data.projectId)) {
        socket.emit(SOCKET_EVENTS.AI_DONE, {
          error: "The AI assistant is unavailable in an end-to-end encrypted project — it would have to be given the contents this project exists to keep private.",
        });
        return;
      }
      // Also before the configuration check, and for the same reason: a prompt
      // carries the file to the model provider, so in a region-pinned workspace
      // no API key makes this available.
      const egress = egressBlockReason(data.region, "ai");
      if (egress) {
        await auditEgressBlock(data.workspaceId ?? null, data.userId, "ai", data.region!);
        socket.emit(SOCKET_EVENTS.AI_DONE, { error: egress });
        return;
      }
      if (!isAIConfigured()) {
        socket.emit(SOCKET_EVENTS.AI_DONE, { error: "AI is not configured. Add ANTHROPIC_API_KEY to the server .env to enable it." });
        return;
      }
      if (!Array.isArray(history) || history.length === 0) return;
      if (!(await socketRateOk("ai", data.userId, 60, 20))) {
        socket.emit(SOCKET_EVENTS.AI_DONE, { error: "AI rate limit reached — wait a moment." });
        return;
      }
      try {
        await streamAssistant(history.slice(-12), codeContext, (delta) => {
          socket.emit(SOCKET_EVENTS.AI_CHUNK, { delta });
        });
        socket.emit(SOCKET_EVENTS.AI_DONE, {});
      } catch (err) {
        socket.emit(SOCKET_EVENTS.AI_DONE, { error: (err as Error).message });
      }
    });

    // --- AI inline completion: short ghost-text suggestion for the asking user ---
    socket.on(SOCKET_EVENTS.AI_COMPLETE, async ({ id, prefix, suffix, language }: { id: string; prefix: string; suffix: string; language: string }) => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      if (await isE2ee(data.projectId)) return;   // same reason as the assistant
      if (egressBlockReason(data.region, "ai")) return;  // and the same for residency
      if (!isAIConfigured() || typeof prefix !== "string") return;
      if (!(await socketRateOk("ai-complete", data.userId, 60, 120))) return;
      try {
        const text = await completeCode(prefix, suffix ?? "", language ?? "plaintext");
        socket.emit(SOCKET_EVENTS.AI_COMPLETION, { id, text });
      } catch {
        socket.emit(SOCKET_EVENTS.AI_COMPLETION, { id, text: "" });
      }
    });

    // --- File tree changed: relay so peers refetch (editor+ only) ---
    socket.on(SOCKET_EVENTS.FILES_CHANGED, () => {
      if (!data.projectId || !data.role || !roleAtLeast(data.role, "editor")) return;
      socket.to(data.projectId).emit(SOCKET_EVENTS.FILES_CHANGED, {});
      emitActivity(io, data.projectId, { action: "updated files", actor: data.displayName, actorColor: data.avatarColor });
    });

    // --- Chat reaction: toggle this user's emoji, broadcast raw reactions ---
    socket.on(SOCKET_EVENTS.CHAT_REACTION, async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      if (!data.projectId || typeof emoji !== "string" || emoji.length > 8) return;
      const msg = await Message.findById(messageId);
      if (!msg || String(msg.channelId) !== data.projectId) return;
      const r = msg.reactions.find((x) => x.emoji === emoji);
      if (!r) {
        msg.reactions.push({ emoji, userIds: [data.userId as any] });
      } else {
        const idx = r.userIds.findIndex((u) => String(u) === data.userId);
        if (idx >= 0) {
          r.userIds.splice(idx, 1);
          if (r.userIds.length === 0) {
            const ri = msg.reactions.findIndex((x) => x.emoji === emoji);
            if (ri >= 0) msg.reactions.splice(ri, 1);
          }
        } else {
          r.userIds.push(data.userId as any);
        }
      }
      await msg.save();
      io.to(data.projectId).emit(SOCKET_EVENTS.CHAT_REACTION, {
        messageId,
        reactions: msg.reactions.map((x) => ({ emoji: x.emoji, userIds: x.userIds.map(String) })),
      });
    });

    // --- WebRTC signaling relay (media never touches the server) ---
    socket.on(SOCKET_EVENTS.RTC_SIGNAL, (payload) => {
      if (!data.projectId) return;
      socket.to(data.projectId).emit(SOCKET_EVENTS.RTC_SIGNAL, { ...payload, from: data.userId });
    });

    // --- Disconnect: clear presence, broadcast ---
    socket.on("disconnect", async () => {
      if (data.projectId) {
        await redis.hdel(presenceKey(data.projectId), data.userId);
        io.to(data.projectId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, {
          users: await roomPresence(data.projectId),
        });
        emitActivity(io, data.projectId, { action: "left", actor: data.displayName, actorColor: data.avatarColor });
        if ((await redis.hlen(presenceKey(data.projectId))) === 0) await finalizeSession(data.projectId);
      }
    });
  });
}
