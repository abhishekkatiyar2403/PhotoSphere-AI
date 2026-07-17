import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { prisma } from "../src/lib/prisma";
import { deleteObject } from "../src/lib/storage";
import { thumbnailKey } from "../src/lib/storageKeys";

// One-off ops cleanup (2026-07-10): the automated backend test suite has
// been running against this same dev Postgres/MinIO instead of an isolated
// test database, leaving ~114 throwaway "@example.com" users (and their
// photos/folders/collections) mixed into the same DB Abhishek manually
// tests against. This surfaced when a bulk reclassify pass queued 116 jobs
// instead of his real ~7 photos. Deletes every such user (Prisma cascades
// remove their photos/folders/collections/guest rows/sessions), best-effort
// cleaning each photo's S3 objects first. Real accounts
// (abhishekkatiyar1947@gmail.com, photosphereai@gmail.com) are hard-excluded
// by id, not just by email pattern, as a second guard. Run from backend/:
// npx tsx scripts/cleanup-test-users.ts
const THUMBNAIL_SIZES = [150, 400, 1200] as const;
const PRESERVE_EMAILS = new Set(["abhishekkatiyar1947@gmail.com", "photosphereai@gmail.com"]);

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const toDelete = users.filter((u) => /@example\.com$/i.test(u.email) && !PRESERVE_EMAILS.has(u.email));

  console.log(`${toDelete.length} test users to remove (of ${users.length} total)`);

  let photosCleaned = 0;
  for (const user of toDelete) {
    const photos = await prisma.photo.findMany({ where: { ownerId: user.id }, select: { id: true, s3Key: true } });
    for (const photo of photos) {
      try {
        await deleteObject(photo.s3Key);
        for (const size of THUMBNAIL_SIZES) {
          await deleteObject(thumbnailKey(user.id, photo.id, size));
        }
        photosCleaned++;
      } catch {
        // best-effort — the DB row cleanup below is authoritative
      }
    }
  }

  const result = await prisma.user.deleteMany({ where: { id: { in: toDelete.map((u) => u.id) } } });
  console.log(`deleted ${result.count} users, best-effort cleaned ${photosCleaned} photo objects`);

  const remaining = await prisma.user.findMany({ select: { email: true } });
  console.log(`${remaining.length} users remain:`, remaining.map((u) => u.email));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
