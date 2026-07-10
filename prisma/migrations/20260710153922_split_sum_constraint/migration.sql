-- Enforce: for any transaction that has splits, Σ ExpenseSplit.owedAmount = Transaction.amount.
-- Cross-row invariant ⇒ deferred constraint trigger, checked at COMMIT so a
-- transaction and its splits can be written together in one DB transaction.

CREATE OR REPLACE FUNCTION check_split_sum() RETURNS trigger AS $$
DECLARE
  tx_id TEXT;
  tx_amount BIGINT;
  split_sum BIGINT;
  split_count INT;
BEGIN
  IF TG_TABLE_NAME = 'ExpenseSplit' THEN
    tx_id := COALESCE(NEW."txId", OLD."txId");
  ELSE
    tx_id := NEW."id";
  END IF;

  SELECT "amount" INTO tx_amount FROM "Transaction" WHERE "id" = tx_id;
  IF tx_amount IS NULL THEN
    RETURN NULL; -- transaction deleted; cascade removed splits
  END IF;

  SELECT COALESCE(SUM("owedAmount"), 0), COUNT(*)
    INTO split_sum, split_count
    FROM "ExpenseSplit" WHERE "txId" = tx_id;

  IF split_count > 0 AND split_sum <> tx_amount THEN
    RAISE EXCEPTION 'Split sum (%) does not equal transaction amount (%) for tx %',
      split_sum, tx_amount, tx_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER expense_split_sum_check
  AFTER INSERT OR UPDATE OR DELETE ON "ExpenseSplit"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_split_sum();

CREATE CONSTRAINT TRIGGER transaction_split_sum_check
  AFTER UPDATE OF "amount" ON "Transaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_split_sum();
