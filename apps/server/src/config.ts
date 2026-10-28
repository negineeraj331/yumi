import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from repo root (two levels up from apps/server/src)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  // Where this API is reachable from the browser — used to build the OIDC
  // redirect_uri, which must match what the provider has registered exactly.
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}`,
  mongoUri: required("MONGO_URI", "mongodb://localhost:27017/yumi"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
    refreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
    accessTtl: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
    refreshTtl: Number(process.env.REFRESH_TOKEN_TTL ?? 1209600),
  },
  // Only trust x-forwarded-for when actually behind a proxy — otherwise any
  // client could forge the header and poison the audit trail.
  trustProxy: process.env.TRUST_PROXY === "true",
  // How often the audit purge sweeps. Retention itself is per-workspace.
  auditPurgeIntervalMs: Number(process.env.AUDIT_PURGE_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
  // Call transport: "mesh" = P2P (≤4 peers), "sfu" = mediasoup server-forwarded (5–50).
  callMode: (process.env.CALL_MODE === "sfu" ? "sfu" : "mesh") as "mesh" | "sfu",
  mediasoup: {
    // IP the server advertises in ICE candidates. 127.0.0.1 for same-machine dev;
    // set to the host's public/LAN IP for real multi-device calls.
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP ?? "127.0.0.1",
    rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000),
    rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 40100),
  },
} as const;

export const isProd = config.env === "production";
