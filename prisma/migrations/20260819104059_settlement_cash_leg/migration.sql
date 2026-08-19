-- The cash leg of a settlement.
--
-- Settling was recorded only in "Settlement", which touches no account and
-- creates no transaction. Money leaving was counted (the original expense),
-- money coming back was not, so account balances drifted from the bank and
-- "cash outflow" was permanently overstated.
--
-- Nullable and unique: a settlement may have no cash leg (recorded without an
-- account, e.g. cash in hand), and every row created before this has none.
-- ON DELETE SET NULL so removing the transaction never destroys the settlement
-- itself -- the debt record is the source of truth, the cash leg is a mirror.
ALTER TABLE "Settlement" ADD COLUMN "transactionId" TEXT;

CREATE UNIQUE INDEX "Settlement_transactionId_key" ON "Settlement"("transactionId");

ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
