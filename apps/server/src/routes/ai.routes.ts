import { Router } from "express";
import { requireAuth } from "../middleware.js";
import { isAIConfigured } from "../ai.js";

const router = Router();

// Whether the AI features are available (an API key is configured).
router.get("/status", requireAuth, (_req, res) => {
  res.json({ enabled: isAIConfigured() });
});

export default router;
