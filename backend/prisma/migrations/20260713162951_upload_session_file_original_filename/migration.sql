/*
  Warnings:

  - Added the required column `original_filename` to the `upload_session_files` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "upload_session_files" ADD COLUMN     "original_filename" TEXT NOT NULL;
