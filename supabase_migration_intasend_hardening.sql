-- supabase_migration_intasend_hardening.sql
-- Run on Supabase SQL editor after supabase_migration_intasend.sql
-- Hardens deposit crediting, idempotency, and balance tamper protection.

-- ── 1. Balance guard: block direct client balance edits ─────────────────────
-- SECURITY DEFINER RPCs run as postgres and are allowed through.
CREATE OR REPLACE FUNCTION public.guard_user_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    IF current_setting('app.allow_balance_update', true) = 'true' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Balance cannot be modified directly';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_user_balance ON public.users;
CREATE TRIGGER trg_guard_user_balance
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_balance();

-- ── 2. Harden credit_user_balance (defense in depth) ────────────────────────
CREATE OR REPLACE FUNCTION public.credit_user_balance(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1500 THEN
    RAISE EXCEPTION 'Invalid credit amount';
  END IF;

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

-- ── 3. Atomic deposit completion (webhook uses this) ────────────────────────
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

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1500 THEN
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

NOTIFY pgrst, 'reload schema';
