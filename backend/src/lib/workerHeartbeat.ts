import type IORedis from "ioredis";
import { logger } from "./logger";

/**
 * Worker heartbeat (2026-07-13 backend audit #14: "the worker process
 * exposes no health endpoint or heartbeat at all — a hung worker is
 * invisible"). The worker process has no HTTP server of its own to expose a
 * /health endpoint from, so instead it writes its own liveness into Redis —
 * a value both processes already share a connection to — and the API's
 * /health reads it back. A hung/crashed worker (process alive but the event
 * loop wedged, or the process gone entirely) simply stops refreshing this
 * key; /health reports it as stale once it's older than STALE_AFTER_MS.
 */
const HEARTBEAT_KEY = "photosphere:worker:heartbeat";
const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_AFTER_MS = 60_000; // 4 missed beats

export function startWorkerHeartbeat(connection: IORedis): () => void {
  const beat = () => {
    connection.set(HEARTBEAT_KEY, Date.now().toString()).catch((err) => {
      logger.error({ err }, "failed to write worker heartbeat");
    });
  };
  beat(); // immediate first beat — don't wait a full interval to become "seen"
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Reads the worker's last heartbeat back out. Returns null if the worker has
 * never beaten (never started, or Redis was flushed) — /health treats that
 * the same as "stale", just with a clearer reason.
 */
export async function getWorkerHeartbeatAgeMs(connection: IORedis): Promise<number | null> {
  const value = await connection.get(HEARTBEAT_KEY);
  if (!value) return null;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return Date.now() - timestamp;
}
