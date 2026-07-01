import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export { BUCKET };
