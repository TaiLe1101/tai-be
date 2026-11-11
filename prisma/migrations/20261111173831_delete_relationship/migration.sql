/*
  Warnings:

  - You are about to drop the column `published_by_id` on the `app_releases` table. All the data in the column will be lost.
  - You are about to drop the column `uploaded_by_id` on the `app_releases` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "app_releases" DROP COLUMN "published_by_id",
DROP COLUMN "uploaded_by_id";
