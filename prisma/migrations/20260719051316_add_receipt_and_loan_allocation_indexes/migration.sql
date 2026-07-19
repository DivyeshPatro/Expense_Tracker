-- CreateIndex
CREATE INDEX "LoanAllocation_gaveEntryId_idx" ON "LoanAllocation"("gaveEntryId");

-- CreateIndex
CREATE INDEX "Receipt_txId_idx" ON "Receipt"("txId");

-- CreateIndex
CREATE INDEX "Receipt_userId_idx" ON "Receipt"("userId");
