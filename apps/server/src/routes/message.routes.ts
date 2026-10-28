import { Router } from "express";
import mongoose from "mongoose";
import { Message, Workspace, User } from "../models.js";
import { requireAuth, requireProjectAccess, type AuthedRequest } from "../middleware.js";
import { isE2ee } from "../gateway.js";
import { dmChannelId } from "@yumi/shared";

const router = Router();
router.use(requireAuth);

/** Recent DM conversation partners for the current user (most recent first). */
router.get("/dm", async (req: AuthedRequest, res) => {
  const me = req.userId!;
  const prefix = `dm:`;
  const rows = await Message.aggregate([
    { $match: { channelType: "dm", channelId: new RegExp(`(^|:)${me}(:|$)`) } },
    { $sort: { ts: -1 } },
    { $group: { _id: "$channelId", lastTs: { $first: "$ts" }, lastBody: { $first: "$body" }, lastAuthor: { $first: "$authorId" } } },
    { $sort: { lastTs: -1 } },
    { $limit: 50 },
  ]);
  // Resolve the "other" participant per channel.
  const convos = await Promise.all(
    rows.map(async (r) => {
      const ids = String(r._id).slice(prefix.length).split(":");
      const otherId = ids.find((id) => id !== me);
      if (!otherId) return null;
      const other = await User.findById(otherId).select("displayName avatarColor").lean();
      if (!other) return null;
      return {
        userId: otherId,
        displayName: (other as any).displayName,
        avatarColor: (other as any).avatarColor,
        lastBody: r.lastBody,
        lastTs: r.lastTs,
      };
    })
  );
  res.json({ conversations: convos.filter(Boolean) });
});

/** DM history with a specific user (both must share a workspace). */
router.get("/dm/:userId", async (req: AuthedRequest, res) => {
  const me = req.userId!;
  const other = req.params.userId;
  if (me === other) return res.status(400).json({ error: "Cannot DM yourself" });
  const shared = await Workspace.countDocuments({
    $and: [
      { $or: [{ ownerId: me }, { "members.userId": me }] },
      { $or: [{ ownerId: other }, { "members.userId": other }] },
    ],
  });
  if (!shared) return res.status(403).json({ error: "No shared workspace" });

  const messages = await Message.find({ channelType: "dm", channelId: dmChannelId(me, other) })
    .sort({ ts: -1 })
    .limit(100)
    .populate("authorId", "displayName avatarColor")
    .lean();
  res.json({ messages: messages.reverse() });
});

/** All replies within a thread (root message id). */
router.get("/:projectId/thread/:rootId", async (req: AuthedRequest, res) => {
  if (!(await requireProjectAccess(req, res, req.params.projectId))) return;

  const root = await Message.findOne({ _id: req.params.rootId, channelId: req.params.projectId })
    .populate("authorId", "displayName avatarColor")
    .lean();
  if (!root) return res.status(404).json({ error: "Thread not found" });

  const replies = await Message.find({ channelId: req.params.projectId, threadId: req.params.rootId })
    .sort({ ts: 1 })
    .populate("authorId", "displayName avatarColor")
    .lean();
  res.json({ root, replies });
});

// Recent messages for a project channel (any member). Supports ?q= search.
// Returns only top-level messages, each annotated with its reply count.
router.get("/:projectId", async (req: AuthedRequest, res) => {
  if (!(await requireProjectAccess(req, res, req.params.projectId))) return;

  const q = (req.query.q as string) || "";
  // Search runs on the stored text. In an encrypted project that text is
  // ciphertext, so a query would silently return nothing and read as "no
  // matches" rather than "cannot search".
  if (q && await isE2ee(req.params.projectId)) {
    return res.status(409).json({
      error: "Message search is unavailable in an end-to-end encrypted project: the server cannot read the messages.",
    });
  }
  const filter: any = { channelId: req.params.projectId };
  if (q) filter.$text = { $search: q };
  else filter.threadId = null; // top-level only in the main channel view; search spans all

  const messages = await Message.find(filter)
    .sort({ ts: -1 })
    .limit(100)
    .populate("authorId", "displayName avatarColor")
    .lean();
  const ordered = messages.reverse();

  // Annotate reply counts for the returned top-level messages.
  const ids = ordered.map((m) => m._id);
  const counts = await Message.aggregate([
    { $match: { channelId: req.params.projectId, threadId: { $in: ids.map((i) => new mongoose.Types.ObjectId(String(i))) } } },
    { $group: { _id: "$threadId", n: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
  const withCounts = ordered.map((m) => ({ ...m, replyCount: countMap.get(String(m._id)) ?? 0 }));

  res.json({ messages: withCounts });
});

export default router;
