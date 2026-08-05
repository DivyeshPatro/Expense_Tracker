-- Enable Row-Level Security on every table in the public schema.
--
-- WHY: Ledgerly reaches Postgres directly through Prisma as the `postgres` role,
-- which OWNS these tables and has BYPASSRLS — so it is exempt from RLS and the
-- app is completely unaffected. But Supabase independently exposes the same
-- public tables through its auto-generated REST API (PostgREST) via the public
-- `anon` / `authenticated` roles, which ARE subject to RLS. The tables were
-- created by Prisma with RLS disabled, so those roles could read/edit/delete
-- everything (Supabase alerts: rls_disabled_in_public, sensitive_columns_exposed).
--
-- FIX: enable RLS with NO policies. RLS defaults to deny, so `anon` /
-- `authenticated` (i.e. anyone hitting the public REST API) are blocked, while
-- the app's `postgres` connection continues unaffected. No policies are added
-- because the app never uses those roles — the only client is Prisma.
--
-- Covers all 29 tables present at this migration: Account, AuditLog, AuthAccount,
-- Bill, Budget, Category, CreditCard, ExpenseSplit, Group, GroupMember,
-- ImportBatch, ImportMapping, Intent, Invitation, LoanAllocation, LoanEntry,
-- MerchantRule, Notification, Participant, Receipt, RecurringRule, Session,
-- Settlement, Tag, Transaction, TransactionTag, User, Verification,
-- _prisma_migrations. The loop enables it on each (idempotent — re-enabling is a
-- no-op). NOTE: any NEW public table added by a later migration must enable RLS
-- in that migration, or it re-opens the same hole.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
  END LOOP;
END $$;
