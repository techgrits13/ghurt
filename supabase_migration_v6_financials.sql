-- ============================================================
-- GHURT CardFlow — Supabase Migration v6 (Financials & Security)
-- PASTE THIS ENTIRE SCRIPT INTO YOUR SUPABASE SQL EDITOR AND RUN IT.
-- It establishes the deposit ledger, withdrawal ledger, and robust balance guards.
-- ============================================================

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

ALTER TABLE public.deposit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own deposits" ON public.deposit_transactions;
CREATE POLICY "Users see own deposits" ON public.deposit_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- ── 2. withdrawal_transactions table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.withdrawal_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount      NUMERIC     NOT NULL CHECK (amount >= 10),
  phone       TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_withdrawal_updated ON public.withdrawal_transactions;
CREATE TRIGGER trg_withdrawal_updated
  BEFORE UPDATE ON public.withdrawal_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_deposit_timestamp();

ALTER TABLE public.withdrawal_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own withdrawals" ON public.withdrawal_transactions;
CREATE POLICY "Users see own withdrawals" ON public.withdrawal_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- ── 3. Balance guard: block direct client balance edits ─────────────────────
CREATE OR REPLACE FUNCTION public.guard_user_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    -- Allow if bypass flag is set (by RPCs)
    IF current_setting('app.allow_balance_update', true) = 'true' THEN
      RETURN NEW;
    END IF;
    -- Allow admin roles
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    -- Otherwise reject the direct client edit
    RAISE EXCEPTION 'Balance cannot be modified directly';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_user_balance ON public.users;
CREATE TRIGGER trg_guard_user_balance
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_balance();

-- ── 4. Atomic balance crediting RPC ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_user_balance(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000 THEN
    RAISE EXCEPTION 'Invalid credit amount';
  END IF;

  -- Temporarily bypass the balance guard
  PERFORM set_config('app.allow_balance_update', 'true', true);

  UPDATE public.users
  SET balance = COALESCE(balance, 0) + p_amount
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % not found', p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_user_balance(UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_user_balance(UUID, NUMERIC) TO service_role;

-- ── 5. Atomic deposit completion (webhook uses this) ────────────────────────
CREATE OR REPLACE FUNCTION public.complete_intasend_deposit(
  p_invoice_id TEXT,
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pending public.deposit_transactions%ROWTYPE;
BEGIN
  IF p_invoice_id IS NULL OR length(trim(p_invoice_id)) = 0 THEN
    RAISE EXCEPTION 'Missing invoice_id';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  SELECT * INTO v_pending
  FROM public.deposit_transactions
  WHERE invoice_id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown invoice';
  END IF;

  IF v_pending.status = 'COMPLETE' THEN
    RETURN FALSE;
  END IF;

  IF v_pending.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'User mismatch';
  END IF;

  IF ABS(v_pending.amount - p_amount) > 0.01 THEN
    RAISE EXCEPTION 'Amount mismatch';
  END IF;

  PERFORM set_config('app.allow_balance_update', 'true', true);

  UPDATE public.users
  SET balance = COALESCE(balance, 0) + p_amount
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % not found', p_user_id;
  END IF;

  UPDATE public.deposit_transactions
  SET status = 'COMPLETE',
      amount = p_amount,
      updated_at = now()
  WHERE invoice_id = p_invoice_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_intasend_deposit(TEXT, UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_intasend_deposit(TEXT, UUID, NUMERIC) TO service_role;

-- ── 6. Request Withdrawal RPC ────────────────────────────────────────────────
-- Deducts balance and queues withdrawal
CREATE OR REPLACE FUNCTION public.request_withdrawal(p_amount NUMERIC, p_phone TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID;
  v_balance NUMERIC;
  v_withdrawal_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_amount IS NULL OR p_amount < 10 THEN
    RAISE EXCEPTION 'Minimum withdrawal is KES 10';
  END IF;

  IF p_phone IS NULL OR length(trim(p_phone)) < 9 THEN
    RAISE EXCEPTION 'Valid phone required';
  END IF;

  -- Lock user row
  SELECT balance INTO v_balance FROM public.users WHERE id = v_user_id FOR UPDATE;
  
  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;

  PERFORM set_config('app.allow_balance_update', 'true', true);

  UPDATE public.users
  SET balance = balance - p_amount
  WHERE id = v_user_id;

  INSERT INTO public.withdrawal_transactions(user_id, amount, phone, status)
  VALUES (v_user_id, p_amount, p_phone, 'PENDING')
  RETURNING id INTO v_withdrawal_id;

  RETURN v_withdrawal_id;
END;
$$;

-- Force API schema reload so functions and tables are immediately visible
NOTIFY pgrst, 'reload schema';
