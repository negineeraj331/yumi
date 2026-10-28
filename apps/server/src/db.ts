import mongoose from "mongoose";
import Redis from "ioredis";
import { config } from "./config.js";

export async function connectMongo(): Promise<void> {
  mongoose.set("strictQuery", true);
  await mongoose.connect(config.mongoUri);
  console.log("[db] MongoDB connected");
}

const redisOptions = {
  lazyConnect: true,
  // Keep the process alive through transient drops (dev containers can bounce).
  maxRetriesPerRequest: null as null,
  retryStrategy: (times: number) => Math.min(times * 200, 2000),
} as const;

function makeRedis(name: string): Redis {
  const client = new Redis(config.redisUrl, redisOptions);
  // Prevent unhandled 'error' events from crashing the server.
  client.on("error", (err) => console.error(`[redis:${name}]`, err.message));
  return client;
}

/** Primary Redis client (commands). Separate clients are used for pub/sub. */
export const redis = makeRedis("cmd");

/** Dedicated pub/sub clients — a subscriber connection cannot run normal commands. */
export const redisPub = makeRedis("pub");
export const redisSub = makeRedis("sub");

export async function connectRedis(): Promise<void> {
  await Promise.all([redis.connect(), redisPub.connect(), redisSub.connect()]);
  console.log("[db] Redis connected");
}
