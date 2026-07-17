-- AlterTable
ALTER TABLE "Intent" ADD COLUMN     "deviceName" TEXT;

-- CreateIndex
CREATE INDEX "Intent_userId_entityId_appliedAt_idx" ON "Intent"("userId", "entityId", "appliedAt");
