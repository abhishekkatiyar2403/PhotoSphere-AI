-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "collection_id" TEXT,
    "total_files" INTEGER NOT NULL,
    "completed_files" INTEGER NOT NULL DEFAULT 0,
    "failed_files" INTEGER NOT NULL DEFAULT 0,
    "total_bytes" BIGINT NOT NULL,
    "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_session_files" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_session_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_sessions_owner_id_status_idx" ON "upload_sessions"("owner_id", "status");

-- CreateIndex
CREATE INDEX "upload_sessions_expires_at_idx" ON "upload_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "upload_session_files_session_id_status_idx" ON "upload_session_files"("session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "upload_session_files_session_id_client_id_key" ON "upload_session_files"("session_id", "client_id");

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_session_files" ADD CONSTRAINT "upload_session_files_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
