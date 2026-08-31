-- ================================================================
-- GHURT INCREMENTAL SECURITY & APPEALS MIGRATION
-- Run this in Supabase SQL Editor to apply new updates
-- ================================================================

-- 1. Create Appeals Table
CREATE TABLE IF NOT EXISTS public.appeals (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS and public insert policy for appeals
ALTER TABLE public.appeals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public insert on appeals" ON public.appeals;
CREATE POLICY "Allow public insert on appeals" ON public.appeals
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Service manages appeals" ON public.appeals;
CREATE POLICY "Service manages appeals" ON public.appeals
  FOR ALL USING (auth.role() = 'service_role');

-- 2. Create admin_restore_user function
CREATE OR REPLACE FUNCTION public.admin_restore_user(
  p_target_user_id UUID,
  p_reason         TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_aid UUID;
BEGIN
  UPDATE auth.users
  SET raw_user_meta_data = jsonb_set(
    COALESCE(raw_user_meta_data, '{}'), '{is_suspended}', '"false"'
  )
  WHERE id = p_target_user_id;

  INSERT INTO public.audit_log (
    action_type, target_type, target_id, new_values, reason
  ) VALUES (
    'restore_user', 'user', p_target_user_id,
    jsonb_build_object('is_suspended', false),
    p_reason
  ) RETURNING id INTO v_aid;

  RETURN jsonb_build_object('success', true, 'audit_id', v_aid);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_restore_user(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_restore_user(UUID, TEXT) TO service_role;

-- 3. Update admin_live_games_stats to count playing games in staked_games only
CREATE OR REPLACE FUNCTION public.admin_live_games_stats()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_total INT; v_stuck INT; v_staked INT;
BEGIN
  -- Count active games from staked_games (since we only care about real money games)
  SELECT COUNT(*) INTO v_total FROM public.staked_games WHERE status = 'playing';
  -- Stuck playing games
  SELECT COUNT(*) INTO v_stuck FROM public.staked_games 
    WHERE status = 'playing' AND updated_at < NOW() - INTERVAL '30 minutes';
  
  RETURN jsonb_build_object(
    'live_games', v_total, 
    'stuck_games', v_stuck, 
    'live_staked_games', v_total
  );
END;
$$;

-- 4. Update admin_pending_disputes to exclude ones older than 14 days (2 weeks)
CREATE OR REPLACE FUNCTION public.admin_pending_disputes()
RETURNS SETOF public.disputes LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM public.disputes
  WHERE status IN ('pending', 'escalated')
    AND created_at > NOW() - INTERVAL '14 days'
  ORDER BY status DESC, created_at ASC;
END;
$$;

-- 5. Update admin_financial_summary to return total_users count
CREATE OR REPLACE FUNCTION public.admin_financial_summary(
  p_start_date DATE DEFAULT NULL,
  p_end_date   DATE DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_start DATE;
  v_end   DATE;
  v_dep   NUMERIC; v_wdr NUMERIC; v_fee NUMERIC; v_wallets INT; v_users INT;
BEGIN
  v_start := COALESCE(p_start_date, CURRENT_DATE - 30);
  v_end   := COALESCE(p_end_date,   CURRENT_DATE);

  SELECT COALESCE(SUM(amount), 0) INTO v_dep
  FROM public.transactions
  WHERE transaction_type = 'deposit'
    AND created_at::date BETWEEN v_start AND v_end;

  SELECT COALESCE(SUM(amount), 0) INTO v_wdr
  FROM public.transactions
  WHERE transaction_type = 'withdrawal' AND status = 'completed'
    AND created_at::date BETWEEN v_start AND v_end;

  SELECT COALESCE(SUM(amount), 0) INTO v_fee
  FROM public.transactions
  WHERE transaction_type = 'fee'
    AND created_at::date BETWEEN v_start AND v_end;

  SELECT COUNT(*) INTO v_wallets FROM public.wallets;
  SELECT COUNT(*) INTO v_users FROM public.users;

  RETURN jsonb_build_object(
    'total_deposits',    v_dep,
    'total_withdrawals', v_wdr,
    'total_fees',        v_fee,
    'net_revenue',       v_fee,
    'wallet_count',      v_wallets,
    'total_users',       v_users,
    'period_start',      v_start,
    'period_end',        v_end
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
