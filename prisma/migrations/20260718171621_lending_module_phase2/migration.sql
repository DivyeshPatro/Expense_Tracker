-- CreateTable
CREATE TABLE "LoanAllocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gaveEntryId" TEXT NOT NULL,
    "gotEntryId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanAllocation_userId_gaveEntryId_idx" ON "LoanAllocation"("userId", "gaveEntryId");

-- CreateIndex
CREATE INDEX "LoanAllocation_gotEntryId_idx" ON "LoanAllocation"("gotEntryId");

-- AddForeignKey
ALTER TABLE "LoanAllocation" ADD CONSTRAINT "LoanAllocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanAllocation" ADD CONSTRAINT "LoanAllocation_gaveEntryId_fkey" FOREIGN KEY ("gaveEntryId") REFERENCES "LoanEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanAllocation" ADD CONSTRAINT "LoanAllocation_gotEntryId_fkey" FOREIGN KEY ("gotEntryId") REFERENCES "LoanEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
