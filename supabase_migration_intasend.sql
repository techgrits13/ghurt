-- supabase_migration_intasend.sql
-- Run this on your Supabase project to enable IntaSend deposit tracking.

-- ── 1. deposit_transactions table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deposit_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invoice_id  TEXT        UNIQUE NOT NULL,
  amount      NUMERIC     NOT NULL CHECK (amount > 0),
  phone       TEXT,
  status      TEXT        NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'COMPLETE', 'FAILED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION public.update_deposit_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deposit_updated ON public.deposit_transactions;
CREATE TRIGGER trg_deposit_updated
  BEFORE UPDATE ON public.deposit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_deposit_timestamp();

-- Row-level security: users can only see their own deposits
ALTER TABLE public.deposit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own deposits" ON public.deposit_transactions;
CREATE POLICY "Users see own deposits" ON public.deposit_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- ── 2. credit_user_balance RPC ────────────────────────────────────────────────
-- Called by the webhook to atomically add KES to a user's balance.
CREATE OR REPLACE FUNCTION public.credit_user_balance(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.users
  SET balance = COALESCE(balance, 0) + p_amount
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % not found', p_user_id;
  END IF;
END;
$$;

-- Grant execute to the service role only (webhook runs as service role)
REVOKE ALL ON FUNCTION public.credit_user_balance(UUID, NUMERIC) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.credit_user_balance(UUID, NUMERIC) TO service_role;

-- Force API schema reload so functions and tables are immediately visible
NOTIFY pgrst, 'reload schema';
