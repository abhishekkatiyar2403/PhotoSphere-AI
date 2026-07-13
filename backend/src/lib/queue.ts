import { Queue } from "bullmq";
import IORedis from "ioredis";

// Single shared connection + queue instance for the photo-processing
// pipeline. Redis has been running in Docker Compose since Week 1-2 but
// unused until this spec - this is the first thing that wires it in.
export const PHOTO_PROCESSING_QUEUE_NAME = "photo-processing";

// specs/trash-system.md T4: the daily auto-purge job name, registered on
// THIS SAME queue (spec's own recommendation — reuse rather than stand up a
// second queue). `PhotoProcessingJobData` alone (just `{ photoId }`) is
// genuinely awkward for a job with no single photo target, so the queue's
// job-data type is widened to a union below rather than duplicating a whole
// second Queue/Worker pair for one repeatable job.
export const TRASH_PURGE_JOB_NAME = "trash-purge";

// specs/production-upload-batch.md (PUB4, DECIDED: option (a) — a daily
// BullMQ repeatable job, same pattern as the trash-purge job above).
// Registered on THIS SAME queue for the same reason T4's job was — reuse
// rather than stand up a second queue for one repeatable sweep.
export const UPLOAD_SESSION_CLEANUP_JOB_NAME = "upload-session-cleanup";

declare global {
  // eslint-disable-next-line no-var
  var __photoQueueConnection: IORedis | undefined;
  // eslint-disable-next-line no-var
  var __photoQueue: Queue<PhotoProcessingJobData> | undefined;
}

export interface PipelineJobData {
  photoId: string;
}

// The repeatable purge job carries no payload — it always operates on
// "everything past retention" at run time, never a specific target.
export interface TrashPurgeJobData {
  photoId?: undefined;
}

// Same "no payload, operates on everything past its own cutoff" shape as
// TrashPurgeJobData above.
export interface UploadSessionCleanupJobData {
  photoId?: undefined;
}

export type PhotoProcessingJobData = PipelineJobData | TrashPurgeJobData | UploadSessionCleanupJobData;

function createConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null, // required by BullMQ's blocking connections
  });
}

const connection = global.__photoQueueConnection ?? createConnection();

// Exported so /health (app.ts) can PING the same Redis connection the queue
// itself depends on, rather than opening a second one just to check
// reachability (2026-07-13 backend audit #14).
export const redisConnection = connection;

export const photoProcessingQueue: Queue<PhotoProcessingJobData> =
  global.__photoQueue ??
  new Queue<PhotoProcessingJobData>(PHOTO_PROCESSING_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 500 },
      removeOnFail: false, // keep failed jobs visible for debugging, matches processing_jobs.error_message
    },
  });

/**
 * specs/trash-system.md T4: register the daily repeatable purge job.
 * Idempotent — `upsertJobScheduler` UPSERTS rather than duplicating, so this
 * is safe to call on every worker/API boot without accumulating duplicate
 * scheduled jobs (Developer-verified acceptance criterion). Called once at
 * worker startup (worker.ts's main()); NOT called from the API process, so
 * only one process owns the registration call (still idempotent either way).
 */
export async function registerTrashPurgeJob(): Promise<void> {
  await photoProcessingQueue.upsertJobScheduler(
    TRASH_PURGE_JOB_NAME,
    { pattern: "0 3 * * *" }, // once daily at 03:00 — retention is 7 days, no finer granularity needed
    {
      name: TRASH_PURGE_JOB_NAME,
      data: {},
      opts: { removeOnComplete: { count: 50 }, removeOnFail: false },
    },
  );
}

/**
 * specs/production-upload-batch.md PUB4 (DECIDED): register the daily
 * repeatable stale-upload-session cleanup job. Same idempotent
 * upsertJobScheduler pattern as registerTrashPurgeJob above — safe to call
 * on every worker/API boot without accumulating duplicate scheduled jobs.
 * Called once at worker startup (worker.ts's main()), alongside the existing
 * trash-purge registration.
 */
export async function registerUploadSessionCleanupJob(): Promise<void> {
  await photoProcessingQueue.upsertJobScheduler(
    UPLOAD_SESSION_CLEANUP_JOB_NAME,
    { pattern: "0 4 * * *" }, // once daily at 04:00 — offset from the 03:00 trash-purge job
    {
      name: UPLOAD_SESSION_CLEANUP_JOB_NAME,
      data: {},
      opts: { removeOnComplete: { count: 50 }, removeOnFail: false },
    },
  );
}

if (process.env.NODE_ENV === "development") {
  global.__photoQueueConnection = connection;
  global.__photoQueue = photoProcessingQueue;
}
