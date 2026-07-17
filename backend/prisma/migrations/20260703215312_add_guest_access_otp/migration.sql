-- CreateTable
CREATE TABLE "guest_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "guest_user_id" TEXT NOT NULL,
    "collection_id" TEXT,
    "created_by" TEXT NOT NULL,
    "max_uses" INTEGER,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folder_permissions" (
    "id" TEXT NOT NULL,
    "guest_user_id" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "permission_level" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "granted_by" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folder_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "invite_token_id" TEXT NOT NULL,
    "guest_user_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "device_info" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "otp_hash" TEXT,
    "otp_expires_at" TIMESTAMP(3),
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "session_claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_sessions" (
    "id" TEXT NOT NULL,
    "guest_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_users_created_by_idx" ON "guest_users"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "invite_tokens_token_hash_key" ON "invite_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "invite_tokens_guest_user_id_idx" ON "invite_tokens"("guest_user_id");

-- CreateIndex
CREATE INDEX "folder_permissions_guest_user_id_idx" ON "folder_permissions"("guest_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "folder_permissions_guest_user_id_folder_id_key" ON "folder_permissions"("guest_user_id", "folder_id");

-- CreateIndex
CREATE INDEX "access_requests_status_created_at_idx" ON "access_requests"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "guest_sessions_token_hash_key" ON "guest_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "guest_sessions_guest_user_id_idx" ON "guest_sessions"("guest_user_id");

-- AddForeignKey
ALTER TABLE "guest_users" ADD CONSTRAINT "guest_users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_guest_user_id_fkey" FOREIGN KEY ("guest_user_id") REFERENCES "guest_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder_permissions" ADD CONSTRAINT "folder_permissions_guest_user_id_fkey" FOREIGN KEY ("guest_user_id") REFERENCES "guest_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder_permissions" ADD CONSTRAINT "folder_permissions_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_invite_token_id_fkey" FOREIGN KEY ("invite_token_id") REFERENCES "invite_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_guest_user_id_fkey" FOREIGN KEY ("guest_user_id") REFERENCES "guest_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_guest_user_id_fkey" FOREIGN KEY ("guest_user_id") REFERENCES "guest_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
