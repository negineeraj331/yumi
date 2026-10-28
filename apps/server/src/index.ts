import express from "express";
import http from "node:http";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";
import { config } from "./config.js";
import { connectMongo, connectRedis } from "./db.js";
import { attachGateway } from "./gateway.js";
import { stopAllSessions } from "./debugger.js";
import { startRetentionJob, stopRetentionJob } from "./retention.js";
import { initResidency } from "./residency.js";
import { initSaml } from "./saml.js";
import { rateLimit } from "./ratelimit.js";
import authRoutes from "./routes/auth.routes.js";
import ssoRoutes from "./routes/sso.routes.js";
import samlRoutes from "./routes/saml.routes.js";
import workspaceRoutes from "./routes/workspace.routes.js";
import projectRoutes from "./routes/project.routes.js";
import inviteRoutes from "./routes/invite.routes.js";
import messageRoutes from "./routes/message.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import scimRoutes from "./routes/scim.routes.js";

// Last-resort guards: log and keep serving rather than taking the whole
// process (and everyone's session) down on a single stray error.
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

async function main() {
  // Before anything is served: a malformed REGION must stop the process, not
  // surface as a per-request failure once traffic arrives.
  initResidency();
  initSaml();
  await connectMongo();
  await connectRedis();

  const app = express();
  app.set("trust proxy", 1); // correct req.ip behind a proxy/load balancer
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  // SCIM clients send application/scim+json; without it listed here the body
  // arrives unparsed and every provisioning call looks like an empty request.
  app.use(express.json({ limit: "1mb", type: ["application/json", "application/scim+json"] }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Stricter limits on auth (brute-force protection); general cap elsewhere.
  app.use("/api/auth", rateLimit({ scope: "auth", windowSec: 60, max: 20 }));
  app.use("/api", rateLimit({ scope: "api", windowSec: 60, max: 300 }));
  // Directory sync is machine traffic on its own path, so it gets its own
  // ceiling rather than competing with the app's budget. Generous enough for a
  // full reconciliation pass, bounded enough to matter.
  app.use("/scim", rateLimit({ scope: "scim", windowSec: 60, max: 600 }));

  app.use("/api/auth", authRoutes);
  // Mounted before the OIDC router so "saml" is never read as a provider id.
  app.use("/api/auth/sso/saml", samlRoutes);
  app.use("/api/auth/sso", ssoRoutes);
  app.use("/api/workspaces", workspaceRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/invites", inviteRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/ai", aiRoutes);
  // SCIM lives outside /api on the standard path an IdP expects to be given.
  app.use("/scim/v2", scimRoutes);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[error]", err);
    res.status(500).json({ error: "Internal server error" });
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.clientOrigin, credentials: true },
    maxHttpBufferSize: 5e6, // allow larger Yjs update frames
  });
  attachGateway(io);

  // Periodic audit-log purge (no-op unless a workspace sets a retention window).
  startRetentionJob();

  server.listen(config.port, () => {
    console.log(`[server] Yumi listening on http://localhost:${config.port}`);
    console.log(`[server] CORS origin: ${config.clientOrigin}`);
  });

  // Graceful shutdown: stop accepting connections, then close resources.
  const shutdown = (sig: string) => {
    console.log(`[server] ${sig} received — shutting down`);
    io.close();
    // Debug sessions hold live containers — never leave one orphaned.
    void stopAllSessions().catch(() => {});
    stopRetentionJob();
    server.close(() => {
      console.log("[server] HTTP closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[fatal] failed to start server", err);
  process.exit(1);
});
