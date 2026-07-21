import type { Request, Response } from "express";
import { redisConnection } from "./queue";
import { logger } from "./logger";

/**
 * Real-time push for the owner Share page (new access requests) and the
 * guest portal (permission/revoke changes) — replaces what used to be
 * fixed-interval client polling. Built on Redis pub/sub (the same Redis
 * BullMQ already runs against) rather than an in-process EventEmitter
 * specifically so this is correct from day one at N horizontally-scaled API
 * instances (SCALABILITY_ROADMAP.md): the mutation and the connected SSE
 * client can land on two different instances behind a load balancer, and
 * this still works, because both sides only ever talk to Redis, never to
 * each other's process memory.
 *
 * Channel naming: "sse:<scope>:<id>", e.g. "sse:owner:<ownerId>",
 * "sse:guest:<guestUserId>", "sse:access-request:<requestId>" — one channel
 * per entity a client cares about, so a client only ever subscribes to
 * exactly the events relevant to it.
 */

/** Publishes a JSON-serializable event to every subscriber of `channel`, if any. Fire-and-forget by design — nothing server-side should ever block on whether a client happens to be listening right now. */
export function publishEvent(channel: string, event: Record<string, unknown>): void {
  redisConnection.publish(channel, JSON.stringify(event)).catch((err) => {
    logger.error({ err, channel }, "failed to publish SSE event");
  });
}

// Sent well under any realistic proxy/browser idle-connection timeout (e.g.
// Railway's edge proxy, or a load balancer in front of multiple instances) —
// an SSE comment line (":...") is valid per spec and silently ignored by
// EventSource, so this exists purely to keep the TCP connection from ever
// looking idle enough to be dropped.
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Subscribes the given response to one Redis pub/sub channel and streams
 * every message published to it as an SSE `data:` frame for as long as the
 * connection stays open (until the client disconnects). Callers own
 * authorization — this only starts streaming once the caller has already
 * confirmed the requester may listen to this exact channel.
 */
export function streamChannel(req: Request, res: Response, channel: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Harmless if nothing in the deploy path is an nginx-style reverse
    // proxy; prevents one from buffering the stream into one giant chunk if
    // it ever is.
    "X-Accel-Buffering": "no",
  });
  // Flush headers immediately so the client's EventSource fires `onopen`
  // right away rather than waiting for the first real event.
  res.write(":ok\n\n");

  // A Redis connection in SUBSCRIBE mode is protocol-locked into that mode —
  // it can never issue another command on the same connection — so this
  // needs its own connection rather than reusing the shared `redisConnection`
  // (which every other part of the app uses for normal commands).
  // `.duplicate()` clones the same host/port/TLS options; it does not open a
  // second Redis server.
  const subscriber = redisConnection.duplicate();
  let closed = false;

  subscriber.subscribe(channel).catch((err) => {
    logger.error({ err, channel }, "SSE subscribe failed");
  });

  subscriber.on("message", (_channel, message) => {
    if (closed) return;
    res.write(`data: ${message}\n\n`);
  });

  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    subscriber.unsubscribe(channel).catch(() => undefined);
    subscriber.quit().catch(() => undefined);
  }

  req.on("close", cleanup);
}
