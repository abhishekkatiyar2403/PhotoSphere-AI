/**
 * Storage key conventions (userId/photoId/... under the MinIO/S3 bucket).
 * Pulled out of routes/photos.ts into its own module so it can be shared by
 * lib/photoCard.ts (thumbnail URL generation) without a circular import
 * between routes/photos.ts and routes/folders.ts / lib/photoCard.ts.
 */
export function thumbnailKey(ownerId: string, photoId: string, size: number): string {
  return `${ownerId}/${photoId}/thumb_${size}.jpg`;
}

export function originalKey(ownerId: string, photoId: string, extension: string): string {
  return `${ownerId}/${photoId}/original.${extension}`;
}
