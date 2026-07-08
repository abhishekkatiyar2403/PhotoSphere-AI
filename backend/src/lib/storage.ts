import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";

/**
 * Thin wrapper around the AWS S3 SDK v3, pointed at MinIO's endpoint.
 * Per CLAUDE.md ground rules: private bucket only, never a public ACL,
 * never a raw/direct URL returned to a client - every read goes through
 * getPresignedGetUrl() with a short TTL (60s per spec).
 */

const BUCKET = process.env.MINIO_BUCKET ?? "photosphere-dev";
const useSSL = process.env.MINIO_USE_SSL === "true";

const s3 = new S3Client({
  endpoint: `${useSSL ? "https" : "http"}://${process.env.MINIO_ENDPOINT ?? "localhost"}:${
    process.env.MINIO_PORT ?? "9000"
  }`,
  region: "us-east-1", // MinIO ignores region but the SDK requires one
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? "photosphere",
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? "photosphere123",
  },
  forcePathStyle: true, // required for MinIO (virtual-hosted-style buckets don't work locally)
});

/** Idempotent bootstrap - creates the private bucket if it doesn't already exist. Run once at API/worker startup. */
export async function ensureBucketExists(): Promise<void> {
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

/** Returns a time-limited pre-signed GET URL. Never return a raw storage path/key to a client. */
export async function getPresignedGetUrl(key: string, expiresInSeconds = 60): Promise<string> {
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

export { BUCKET };
