import { Queue } from "bullmq";
import IORedis from "ioredis";

// Single shared connection + queue instance for the photo-processing
// pipeline. Redis has been running in Docker Compose since Week 1-2 but
// unused until this spec - this is the first thing that wires it in.
export const PHOTO_PROCESSING_QUEUE_NAME = "photo-processing";

declare global {
  // eslint-disable-next-line no-var
  var __photoQueueConnection: IORedis | undefined;
  // eslint-disable-next-line no-var
  var __photoQueue: Queue<PhotoProcessingJobData> | undefined;
}

export interface PhotoProcessingJobData {
  photoId: string;
}

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

if (process.env.NODE_ENV === "development") {
  global.__photoQueueConnection = connection;
  global.__photoQueue = photoProcessingQueue;
}
