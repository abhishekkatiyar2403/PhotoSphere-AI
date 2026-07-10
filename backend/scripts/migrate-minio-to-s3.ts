import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "../src/lib/prisma";
import { thumbnailKey } from "../src/lib/storageKeys";

// One-off ops script (2026-07-10): a handful of Abhishek's real photos were
// uploaded back when storage pointed at local MinIO, before AWS_S3_BUCKET
// was configured this session. The app now reads/writes real S3
// exclusively (lib/storage.ts), so those older objects became unreachable —
// surfaced when a bulk reclassify pass hit "Failed to fetch original from
// storage (status 404)" for exactly this set. This copies the original +
// every thumbnail size, object-by-object, from MinIO into the real bucket,
// skipping anything already present in S3 or missing in MinIO (safe to
// re-run). Run from backend/: npx tsx scripts/migrate-minio-to-s3.ts
const THUMBNAIL_SIZES = [150, 400, 1200] as const;

const minio = new S3Client({
  endpoint: `${process.env.MINIO_USE_SSL === "true" ? "https" : "http"}://${process.env.MINIO_ENDPOINT ?? "localhost"}:${process.env.MINIO_PORT ?? "9000"}`,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? "photosphere",
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? "photosphere123",
  },
  forcePathStyle: true,
});
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "photosphere-dev";

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
const S3_BUCKET = process.env.AWS_S3_BUCKET!;

async function existsInS3(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function copyOne(key: string, contentType: string): Promise<"copied" | "already-in-s3" | "missing-in-minio"> {
  if (await existsInS3(key)) return "already-in-s3";
  try {
    const got = await minio.send(new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key }));
    const bytes = await got.Body!.transformToByteArray();
    await s3.send(
      new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: Buffer.from(bytes), ContentType: contentType }),
    );
    return "copied";
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return "missing-in-minio";
    throw err;
  }
}

async function main() {
  const ownerId = process.argv[2];
  if (!ownerId) {
    console.error("usage: npx tsx scripts/migrate-minio-to-s3.ts <ownerId>");
    process.exit(1);
  }

  const photos = await prisma.photo.findMany({
    where: { ownerId, deletedAt: null },
    select: { id: true, ownerId: true, originalFilename: true, s3Key: true, mimeType: true },
  });

  for (const photo of photos) {
    const originalResult = await copyOne(photo.s3Key, photo.mimeType);
    console.log(`${photo.originalFilename} original: ${originalResult}`);
    for (const size of THUMBNAIL_SIZES) {
      const key = thumbnailKey(photo.ownerId, photo.id, size);
      const result = await copyOne(key, "image/jpeg");
      console.log(`${photo.originalFilename} thumb_${size}: ${result}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
