import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { prisma } from "../src/lib/prisma";
import { photoProcessingQueue, type PhotoProcessingJobData } from "../src/lib/queue";

// Ops script: re-enqueue a "reclassify" job for EVERY live, non-duplicate
// photo (first used 2026-07-10 to re-sort the library under the new
// dominance-scoring + face-grouping rules). Duplicates are deliberately
// excluded — reclassify clears the duplicate verdict by design, and a bulk
// pass shouldn't quietly overturn dedup decisions.
//
// Mirrors POST /api/photos/:id/reclassify's atomic claim exactly, so a photo
// already pending/processing is skipped, never double-enqueued. Run from
// backend/: npx tsx scripts/bulk-reclassify.ts
async function main() {
  const photos = await prisma.photo.findMany({
    where: { deletedAt: null, duplicateOfPhotoId: null },
    select: { id: true, originalFilename: true },
    orderBy: { createdAt: "asc" },
  });

  let enqueued = 0;
  let skipped = 0;
  for (const photo of photos) {
    const claimed = await prisma.photo.updateMany({
      where: { id: photo.id, aiClassificationStatus: { notIn: ["pending", "processing"] } },
      data: { aiClassificationStatus: "pending" },
    });
    if (claimed.count !== 1) {
      skipped++;
      continue;
    }
    const job = await prisma.processingJob.create({
      data: { photoId: photo.id, jobType: "reclassify", status: "queued" },
    });
    await photoProcessingQueue.add(
      "reclassify",
      { photoId: photo.id } satisfies PhotoProcessingJobData,
      { jobId: job.id },
    );
    enqueued++;
    console.log(`enqueued: ${photo.originalFilename}`);
  }

  console.log(`\ndone: ${enqueued} enqueued, ${skipped} skipped (already in progress), ${photos.length} total`);
  await photoProcessingQueue.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
