import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedUrl as getCloudFrontUrl } from "@aws-sdk/cloudfront-signer";
import type { Readable } from "node:stream";

/**
 * Thin wrapper around the AWS S3 SDK v3 — pointed at MinIO locally, real AWS
 * S3 in production. Per CLAUDE.md ground rules: private bucket only, never a
 * public ACL, never a raw/direct URL returned to a client - every read goes
 * through getPresignedGetUrl() with a short TTL (60s per spec).
 *
 * Which one is active is decided by whether AWS_S3_BUCKET is set — unset
 * (the local/Docker-Compose default) keeps every existing MINIO_* variable
 * and behavior exactly as before; setting it (Railway production) switches
 * to a real S3 bucket with no other code change needed.
 *
 * Running under Vitest ALWAYS forces local MinIO regardless of
 * AWS_S3_BUCKET — the same shared .env that carries real AWS credentials
 * for local dev/testing also has AWS_S3_BUCKET set, and the backend test
 * suite depends on fast, local, zero-network storage (real S3's network
 * latency blows past several tests' short timeouts, confirmed empirically).
 * See lib/classification/index.ts for the identical pattern/reasoning.
 */

const usingRealS3 = Boolean(process.env.AWS_S3_BUCKET) && !process.env.VITEST;

const BUCKET = usingRealS3 ? process.env.AWS_S3_BUCKET! : process.env.MINIO_BUCKET ?? "photosphere-dev";

/**
 * CloudFront read-path (SCALABILITY_ROADMAP.md #S13) — opt-in, same
 * "presence of the env var decides the branch" pattern as usingRealS3.
 * Only ever applies to real S3 in production; local MinIO has no CDN in
 * front of it and the test suite must never require these creds, so this
 * is forced off under Vitest exactly like usingRealS3 is.
 *
 * CLOUDFRONT_PRIVATE_KEY holds a full PEM private key. Since env files
 * store single-line values, it's expected to arrive with literal "\n"
 * escapes (the standard convention for PEM-in-env-var) — decoded here once
 * at module load rather than at every sign call.
 */
const usingCloudFront = Boolean(process.env.CLOUDFRONT_DOMAIN) && usingRealS3;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const CLOUDFRONT_KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID;
const CLOUDFRONT_PRIVATE_KEY = process.env.CLOUDFRONT_PRIVATE_KEY?.replace(/\\n/g, "\n");

const s3 = usingRealS3
  ? new S3Client({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
      // No custom endpoint / forcePathStyle for real AWS — the SDK's default
      // virtual-hosted-style addressing against the real service is correct.
    })
  : new S3Client({
      endpoint: `${process.env.MINIO_USE_SSL === "true" ? "https" : "http"}://${
        process.env.MINIO_ENDPOINT ?? "localhost"
      }:${process.env.MINIO_PORT ?? "9000"}`,
      region: "us-east-1", // MinIO ignores region but the SDK requires one
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? "photosphere",
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? "photosphere123",
      },
      forcePathStyle: true, // required for MinIO (virtual-hosted-style buckets don't work locally)
    });

/**
 * Idempotent bootstrap - creates the private bucket if it doesn't already
 * exist. Run once at API/worker startup. Auto-create only applies to local
 * MinIO — a real AWS bucket is expected to already exist (created deliberately
 * in the AWS console, with its own region/lifecycle/versioning choices), so
 * this just verifies it's reachable and throws loudly if not, rather than
 * silently trying to provision infrastructure on every prod boot.
 */
export async function ensureBucketExists(): Promise<void> {
  if (usingRealS3) {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET })); // throws if missing/unreachable — fail loudly
    return;
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    // No public-read policy is ever set - bucket stays private by default.
  }
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Returns a time-limited signed GET URL for CLIENT display use — never a raw
 * storage path/key. Served via CloudFront (edge-cached, no S3 egress on a
 * cache hit) whenever CLOUDFRONT_DOMAIN is configured against real S3;
 * otherwise falls back to a direct S3/MinIO presigned URL exactly as before.
 * Callers never need to know which one they got — same key in, same shape
 * of short-lived URL out.
 */
export async function getPresignedGetUrl(key: string, expiresInSeconds = 60): Promise<string> {
  if (usingCloudFront) {
    return getCloudFrontUrl({
      url: `https://${CLOUDFRONT_DOMAIN}/${key}`,
      keyPairId: CLOUDFRONT_KEY_PAIR_ID!,
      privateKey: CLOUDFRONT_PRIVATE_KEY!,
      dateLessThan: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    });
  }
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

/**
 * Same as getPresignedGetUrl, but with S3's `response-content-disposition`
 * override set to `attachment` — this is what actually makes a browser save
 * the file instead of just navigating to/rendering it (a plain GET presigned
 * URL has no Content-Disposition of its own, so `window.open`/plain
 * navigation on it just opens the image in the tab). Used for every
 * "download this single photo" action (owner + guest) — never for the
 * thumbnail/original URLs used to just DISPLAY a photo in the UI.
 */
export async function getPresignedDownloadUrl(
  key: string,
  filename: string,
  expiresInSeconds = 60,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${sanitizeContentDispositionFilename(filename)}"`,
  });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

// Strips characters that would break the header value or allow injecting
// extra header directives via a crafted originalFilename.
function sanitizeContentDispositionFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f"\\]/g, "_");
}

/**
 * Returns an AUTHORIZED server-side read stream for one MinIO object. The
 * backend holds the credentials; this is used by the on-the-fly folder-zip
 * assembly (lib/folderZip.ts) to pipe object bytes into the archive WITHOUT
 * ever handing the client a raw key or pre-signed URL — the client only ever
 * receives the resulting zip bytes. Distinct from getPresignedGetUrl (which
 * hands the CLIENT a short-lived URL for a single image); this one keeps the
 * bytes flowing inside the backend for bulk streaming.
 *
 * Throws if the object does not exist / the read fails — callers streaming a
 * zip catch this and abort the archive (Z5), never emitting a partial 200.
 */
export async function getObjectStream(key: string): Promise<Readable> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const response = await s3.send(command);
  const body = response.Body;
  if (!body) {
    throw new Error(`No body returned for object ${key}`);
  }
  // In Node the SDK v3 Body is a Readable stream (IncomingMessage). The union
  // type includes browser ReadableStream/Blob, which never occur under Node.
  return body as Readable;
}

/**
 * Permanently delete one MinIO object. Used ONLY by the trash system's
 * permanent-purge path (specs/trash-system.md, routes/trash.ts + the daily
 * auto-purge job) — never by the soft-delete endpoints, which never touch
 * storage.
 *
 * A not-found object is treated as a NO-OP SUCCESS, not an error (mirrors
 * getPresignedGetUrl's "omit rather than error" thumbnail philosophy): the
 * purge job must be safe to run twice on the same already-purged item
 * (idempotency, specs/trash-system.md hard requirement) without erroring on
 * an object that's already gone. S3's DeleteObjectCommand is itself already
 * idempotent by spec (deleting a nonexistent key succeeds silently), but this
 * defensively swallows a 404/NoSuchKey-shaped error too in case MinIO's
 * behavior ever differs — any OTHER error still propagates.
 */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    const code =
      (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code;
    if (code === "NoSuchKey" || code === "NotFound") {
      return; // already gone — no-op success
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// specs/production-upload-batch.md — presigned multipart batch upload.
// Additive only, following the exact usingRealS3 branch-free pattern above:
// the same `s3` client instance already branches MinIO vs. real S3, and
// multipart commands work identically against both. No change to any
// function above this point.
// ---------------------------------------------------------------------------

/** Starts a multipart upload and returns its S3/MinIO UploadId. */
export async function createMultipartUpload(
  key: string,
  contentType: string,
): Promise<{ uploadId: string }> {
  const result = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
  );
  if (!result.UploadId) {
    throw new Error(`createMultipartUpload for ${key} did not return an UploadId`);
  }
  return { uploadId: result.UploadId };
}

/**
 * Returns a time-limited pre-signed URL for uploading ONE part directly
 * from the browser to MinIO/S3 — no backend code runs while this URL is
 * used, no file bytes ever pass through the Node process (spec's core
 * architectural goal). A longer TTL than the read-side helpers (spec
 * decision, PUB3 recommended default: 3600s) since a single part on a
 * slow/mobile connection can legitimately take longer than 60 seconds.
 */
export async function getPresignedUploadPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds = 3600,
): Promise<string> {
  const command = new UploadPartCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

/**
 * Assembles the final object from its uploaded parts. Throws (propagates) on
 * any S3-side integrity failure (e.g. a missing/mismatched part/ETag) — the
 * caller (POST /api/upload/complete) must not create a Photo row if this
 * throws, per spec.
 */
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { partNumber: number; eTag: string }[],
): Promise<void> {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .slice()
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag })),
      },
    }),
  );
}

/**
 * Aborts an in-progress multipart upload, freeing any already-uploaded parts
 * server-side. Idempotent-safe the same way deleteObject already is — an
 * already-aborted/not-found upload is a no-op success, not an error, since
 * the abort endpoint and the stale-session cleanup job can both legitimately
 * race to abort the same upload (spec).
 */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  try {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
  } catch (err) {
    const code =
      (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code;
    if (code === "NoSuchUpload" || code === "NoSuchKey" || code === "NotFound") {
      return; // already gone/aborted — no-op success
    }
    throw err;
  }
}

export { BUCKET };
