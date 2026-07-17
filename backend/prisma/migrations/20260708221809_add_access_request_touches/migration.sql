-- CreateTable
CREATE TABLE "access_request_touches" (
    "id" TEXT NOT NULL,
    "access_request_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "device_info" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_request_touches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_request_touches_access_request_id_idx" ON "access_request_touches"("access_request_id");

-- AddForeignKey
ALTER TABLE "access_request_touches" ADD CONSTRAINT "access_request_touches_access_request_id_fkey" FOREIGN KEY ("access_request_id") REFERENCES "access_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
