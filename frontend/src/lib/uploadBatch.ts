// specs/production-upload-batch.md — Uppy wiring for the batch upload flow.
//
// DECIDED (Abhishek, 2026-07-13): Uppy (`@uppy/core` + the S3 multipart
// plugin) drives per-part upload/retry/progress. One real deviation from the
// spec's literal package name, flagged here and in the MR draft: the spec
// names `@uppy/aws-s3-multipart`, but that package is marked "no longer
// supported" by its own maintainers on npm — Uppy folded multipart support
// into `@uppy/aws-s3` (its `shouldUseMultipart` option, default true) as of
// its current major version. `@uppy/aws-s3` is the actively-supported
// package and exposes the IDENTICAL createMultipartUpload/signPart/
// listParts/abortMultipartUpload/completeMultipartUpload hook contract the
// spec's own Feature-19 config example assumes — this is a package-name
// substitution, not a design change.
//
// Architecture note: this backend's /api/upload/initiate is BATCH-shaped —
// one call issues presigned part URLs for every file in the batch at once.
// Uppy's AwsS3Multipart plugin, however, calls createMultipartUpload/signPart
// PER FILE as each file starts uploading. To reconcile: initiate() is called
// ONCE up front for the whole selected batch (see runBatchUpload below); its
// response (key/uploadId/partUrls per file) is stashed on each Uppy file's
// `meta` before the file is added to Uppy, and the plugin's hooks below are
// then pure synchronous lookups against that already-fetched data — Uppy
// itself never makes its own signing HTTP calls.
//
// Similarly, /api/upload/complete is deliberately CHUNKED (spec: "every 50
// completed files or 30 seconds, whichever first, plus a final call"), but
// Uppy's completeMultipartUpload hook fires once per FILE as that file's
// parts finish. `CompletionBatcher` below queues each file's finished parts
// and flushes them to the real backend call on that same 50-files-or-30s
// cadence, resolving each file's own promise once its flush round-trip
// returns — satisfying both Uppy's per-file hook contract and the spec's
// batched-call requirement.

import { Uppy } from "@uppy/core";
import AwsS3Multipart from "@uppy/aws-s3";
import { uploadApi, type CompleteUploadResult, type InitiateUploadResponse } from "./api";

export const PART_SIZE_BYTES = 8 * 1024 * 1024; // PUB2 recommended default, matches backend's fixed part size

export type BatchFileMeta = {
  clientId: string;
  key: string;
  uploadId: string;
  partUrls: { partNumber: number; url: string }[];
};

const FLUSH_MAX_BATCH = 50; // spec's chunk size
const FLUSH_INTERVAL_MS = 30 * 1000; // spec's time-based flush trigger

/**
 * Queues per-file completed-parts payloads and flushes them to
 * POST /api/upload/complete in chunks of up to FLUSH_MAX_BATCH, or after
 * FLUSH_INTERVAL_MS since the oldest queued item, whichever comes first —
 * plus a final flush() call the caller makes once every file has finished
 * uploading its parts, so nothing is left stranded in the queue.
 */
export class CompletionBatcher {
  private sessionId: string;
  private queue: { clientId: string; parts: { partNumber: number; eTag: string }[] }[] = [];
  private waiters = new Map<
    string,
    { resolve: (r: CompleteUploadResult) => void; reject: (err: unknown) => void }
  >();
  private oldestQueuedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onResult: (result: CompleteUploadResult) => void;

  constructor(sessionId: string, onResult: (result: CompleteUploadResult) => void) {
    this.sessionId = sessionId;
    this.onResult = onResult;
    this.timer = setInterval(() => {
      if (this.queue.length > 0 && this.oldestQueuedAt !== null && Date.now() - this.oldestQueuedAt >= FLUSH_INTERVAL_MS) {
        void this.flush();
      }
    }, 2000);
  }

  enqueue(clientId: string, parts: { partNumber: number; eTag: string }[]): Promise<CompleteUploadResult> {
    this.queue.push({ clientId, parts });
    if (this.oldestQueuedAt === null) this.oldestQueuedAt = Date.now();

    const promise = new Promise<CompleteUploadResult>((resolve, reject) => {
      this.waiters.set(clientId, { resolve, reject });
    });

    if (this.queue.length >= FLUSH_MAX_BATCH) {
      void this.flush();
    }
    return promise;
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.oldestQueuedAt = null;

    try {
      const res = await uploadApi.complete(this.sessionId, batch);
      for (const result of res.results) {
        this.onResult(result);
        const waiter = this.waiters.get(result.clientId);
        if (waiter) {
          waiter.resolve(result);
          this.waiters.delete(result.clientId);
        }
      }
    } catch (err) {
      for (const item of batch) {
        const waiter = this.waiters.get(item.clientId);
        if (waiter) {
          waiter.reject(err);
          this.waiters.delete(item.clientId);
        }
      }
    }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** SHA-256 of a File's full contents, computed client-side (Web Crypto) —
 * used both for the /initiate duplicate pre-check and as the Photo row's
 * fileSha256 once the batch completes. */
export async function sha256OfFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Builds a fresh Uppy instance wired to this batch's already-fetched
 * /initiate response — createMultipartUpload/signPart/listParts are pure
 * lookups against `filesByClientId` (no network calls of their own);
 * completeMultipartUpload defers the real S3 assembly + Photo-row creation
 * to the CompletionBatcher (chunked, per spec) rather than calling the
 * backend once per file.
 */
export function createUppyForSession(
  initiateResponse: InitiateUploadResponse,
  batcher: CompletionBatcher,
): Uppy {
  const filesByClientId = new Map(initiateResponse.files.map((f) => [f.clientId, f]));

  const uppy = new Uppy({ autoProceed: false });

  uppy.use(AwsS3Multipart, {
    shouldUseMultipart: true,
    getChunkSize: () => PART_SIZE_BYTES,
    createMultipartUpload: async (file) => {
      const meta = filesByClientId.get(file.meta.clientId as string);
      if (!meta) throw new Error(`No initiate() data for clientId ${file.meta.clientId}`);
      return { uploadId: meta.uploadId, key: meta.key };
    },
    listParts: async () => [], // no resume-across-reload support this pass (spec Non-goals)
    signPart: async (file, { partNumber }) => {
      const meta = filesByClientId.get(file.meta.clientId as string);
      const partUrl = meta?.partUrls.find((p) => p.partNumber === partNumber);
      if (!partUrl) throw new Error(`No presigned part URL for part ${partNumber}`);
      return { method: "PUT", url: partUrl.url };
    },
    abortMultipartUpload: async () => {
      // Per-file cancel is a no-op here — this app's "cancel" affordance is
      // whole-BATCH (uploadApi.abort(sessionId), called directly by the page,
      // not through this per-file Uppy hook). A batch that's never explicitly
      // aborted and never completes is reconciled by the daily stale-session
      // cleanup job (PUB4) regardless.
    },
    completeMultipartUpload: async (file, { parts }) => {
      const clientId = file.meta.clientId as string;
      await batcher.enqueue(
        clientId,
        parts.map((p) => ({ partNumber: p.PartNumber!, eTag: p.ETag! })),
      );
      return {};
    },
  });

  return uppy;
}
