-- CreateTable
CREATE TABLE "photos" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "s3_thumbnail_key" TEXT,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "exif_taken_at" TIMESTAMP(3),
    "exif_gps_lat" DOUBLE PRECISION,
    "exif_gps_lng" DOUBLE PRECISION,
    "exif_camera_make" TEXT,
    "exif_camera_model" TEXT,
    "phash" TEXT,
    "duplicate_of_photo_id" TEXT,
    "ai_labels" TEXT[],
    "ai_confidence" DOUBLE PRECISION,
    "collection_id" TEXT,
    "folder_id" TEXT,
    "ai_classification_status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" TEXT NOT NULL,
    "photo_id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL DEFAULT 'pipeline',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "photos_owner_id_idx" ON "photos"("owner_id");

-- CreateIndex
CREATE INDEX "photos_owner_id_ai_classification_status_idx" ON "photos"("owner_id", "ai_classification_status");

-- CreateIndex
CREATE INDEX "processing_jobs_photo_id_idx" ON "processing_jobs"("photo_id");

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

