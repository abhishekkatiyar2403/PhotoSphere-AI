import { prisma } from "./prisma";

/**
 * F1's live-guest-share guard (specs/folder-mgmt-download-search.md PART P4),
 * promoted out of routes/folders.ts into a shared lib so
 * specs/trash-system.md's T2 (FINAL DECISION, REVERSED) can reuse the EXACT
 * same guard for single-photo delete and each item of a bulk-delete — same
 * posture as F1, no special-casing for single photos.
 *
 * Returns true if the folder has ANY live guest `folder_permission` —
 * revokedAt null AND (expiresAt null OR in the future).
 */
export async function hasLivePermission(folderId: string): Promise<boolean> {
  const now = new Date();
  const live = await prisma.folderPermission.findFirst({
    where: {
      folderId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  return live != null;
}
