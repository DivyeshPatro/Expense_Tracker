-- CreateEnum
CREATE TYPE "LoanEntryKind" AS ENUM ('GAVE', 'GOT');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "cardNetwork" TEXT,
ADD COLUMN     "dueDay" INTEGER,
ADD COLUMN     "statementDay" INTEGER;

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "photo" TEXT;

-- CreateTable
CREATE TABLE "LoanEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "kind" "LoanEntryKind" NOT NULL,
    "amount" BIGINT NOT NULL,
    "accountId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "dueDate" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "LoanEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanEntry_userId_occurredAt_idx" ON "LoanEntry"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "LoanEntry_userId_participantId_idx" ON "LoanEntry"("userId", "participantId");

-- CreateIndex
CREATE INDEX "LoanEntry_accountId_idx" ON "LoanEntry"("accountId");

-- AddForeignKey
ALTER TABLE "LoanEntry" ADD CONSTRAINT "LoanEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanEntry" ADD CONSTRAINT "LoanEntry_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanEntry" ADD CONSTRAINT "LoanEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
