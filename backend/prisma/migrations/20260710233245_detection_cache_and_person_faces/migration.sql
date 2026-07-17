-- AlterTable
ALTER TABLE "photos" ADD COLUMN     "ai_detection" JSONB;

-- CreateTable
CREATE TABLE "person_faces" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "face_id" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_faces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "person_faces_owner_id_idx" ON "person_faces"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_faces_owner_id_face_id_key" ON "person_faces"("owner_id", "face_id");

-- AddForeignKey
ALTER TABLE "person_faces" ADD CONSTRAINT "person_faces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_faces" ADD CONSTRAINT "person_faces_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
