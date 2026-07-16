-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Intent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "clientTs" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Intent_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE INDEX "Intent_userId_appliedAt_idx" ON "Intent"("userId", "appliedAt");
