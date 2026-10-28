import { Router } from "express";
import { registerSchema, loginSchema, pickCollaboratorColor, type PublicUser } from "@yumi/shared";
import { User } from "../models.js";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  audit,
  clientIp,
} from "../auth.js";
import { requireAuth, type AuthedRequest } from "../middleware.js";
import { config } from "../config.js";

const router = Router();

function toPublicUser(u: any): PublicUser {
  return { id: String(u._id), email: u.email, displayName: u.displayName, avatarColor: u.avatarColor };
}

function setRefreshCookie(res: any, token: string) {
  res.cookie("refresh_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.env === "production",
    maxAge: config.jwt.refreshTtl * 1000,
    path: "/api/auth",
  });
}

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, displayName } = parsed.data;

  const existing = await User.findOne({ email });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const user = await User.create({
    email,
    passwordHash: await hashPassword(password),
    displayName,
    avatarColor: pickCollaboratorColor(Date.now() + email.length),
  });

  const accessToken = signAccessToken(String(user._id));
  const refreshToken = await issueRefreshToken(String(user._id));
  setRefreshCookie(res, refreshToken);
  await audit({ actorId: String(user._id), action: "auth.register", ip: clientIp(req) });
  res.status(201).json({ user: toPublicUser(user), accessToken });
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password } = parsed.data;

  const user = await User.findOne({ email });
  if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    // Record the attempt — a failed sign-in is the single most useful thing an
    // audit log can show. Never log the password, and only record the account
    // id when the email actually matched one.
    await audit({
      actorId: user ? String(user._id) : undefined,
      action: "auth.login.failed",
      meta: { email, reason: user ? "bad_password" : "unknown_email" },
      ip: clientIp(req),
    });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Deprovisioned accounts keep their credentials but lose their access. The
  // reason is stated plainly: hiding it behind "invalid credentials" would send
  // someone to reset a password that was never the problem.
  if (user.status !== "active") {
    await audit({
      actorId: String(user._id),
      action: "auth.login.failed",
      meta: { email, reason: `account_${user.status}` },
      ip: clientIp(req),
    });
    return res.status(403).json({ error: "This account has been deactivated" });
  }

  const accessToken = signAccessToken(String(user._id));
  const refreshToken = await issueRefreshToken(String(user._id));
  setRefreshCookie(res, refreshToken);
  await audit({ actorId: String(user._id), action: "auth.login", ip: clientIp(req) });
  res.json({ user: toPublicUser(user), accessToken });
});

router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ error: "No refresh token" });
  const userId = await verifyRefreshToken(token);
  if (!userId) return res.status(401).json({ error: "Invalid refresh token" });
  // A long-lived refresh token must not outlive the account it belongs to.
  const user = await User.findById(userId).select("status").lean();
  if (!user || user.status !== "active") {
    return res.status(403).json({ error: "This account has been deactivated" });
  }
  const accessToken = signAccessToken(userId);
  res.json({ accessToken });
});

router.post("/logout", async (req, res) => {
  const token = req.cookies?.refresh_token;
  if (token) {
    // Resolve the owner before revoking, so the entry names who signed out.
    const userId = await verifyRefreshToken(token).catch(() => null);
    await revokeRefreshToken(token);
    await audit({ actorId: userId ?? undefined, action: "auth.logout", ip: clientIp(req) });
  }
  res.clearCookie("refresh_token", { path: "/api/auth" });
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: toPublicUser(user) });
});

router.patch("/me", requireAuth, async (req: AuthedRequest, res) => {
  const { displayName, avatarColor, theme } = req.body ?? {};
  const update: Record<string, unknown> = {};
  if (typeof displayName === "string" && displayName.trim()) update.displayName = displayName.trim().slice(0, 80);
  if (typeof avatarColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(avatarColor)) update.avatarColor = avatarColor;
  if (["system", "light", "dark"].includes(theme)) update["prefs.theme"] = theme;

  const user = await User.findByIdAndUpdate(req.userId, { $set: update }, { new: true });
  if (!user) return res.status(404).json({ error: "User not found" });
  await audit({
    actorId: req.userId, action: "auth.profile.updated",
    meta: { fields: Object.keys(update) }, ip: clientIp(req),
  });
  res.json({ user: toPublicUser(user) });
});

export default router;
