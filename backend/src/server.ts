import dotenv from "dotenv";
import path from "node:path";

// Load the repo-root .env (one level up from /backend) so a single .env
// file covers both frontend and backend, per the scaffolding spec.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { validateEnv } from "./lib/validateEnv";

// Fail fast on a misconfigured production deploy (missing real-provider
// credentials) rather than surfacing as a confusing runtime error on the
// first request that happens to touch that provider.
validateEnv();

import { createApp } from "./app";
import { ensureBucketExists } from "./lib/storage";
import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";

const PORT = Number(process.env.PORT ?? 4000);

const app = createApp();

let httpServer: import("node:http").Server | undefined;

ensureBucketExists()
  .catch((err) => {
    logger.error({ err }, "failed to ensure MinIO bucket exists");
  })
  .finally(() => {
    httpServer = app.listen(PORT, () => {
      logger.info({ port: PORT }, "backend listening");
    });
  });

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish (bounded by a timeout so one stuck request can't hang a deploy
// forever), then disconnect Prisma. Without this, a deploy's SIGTERM kills
// in-flight requests mid-response — the worker already handles its own
// shutdown correctly (worker.ts), this brings the API up to the same bar.
async function shutdown() {
  logger.info("backend shutting down");
  if (httpServer) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10_000);
      httpServer!.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
