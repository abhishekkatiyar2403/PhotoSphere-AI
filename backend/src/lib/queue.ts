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

export type PhotoProcessingJobData = PipelineJobData | TrashPurgeJobData;

function createConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null, // required by BullMQ's blocking connections
  });
}

const connection = global.__photoQueueConnection ?? createConnection();

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

if (process.env.NODE_ENV === "development") {
  global.__photoQueueConnection = connection;
  global.__photoQueue = photoProcessingQueue;
}
