-- ================================================================
-- GHURT FINAL SCHEMA 2 OF 2 — Financial, Fraud & Admin RPC Functions
-- Run this SECOND in Supabase SQL Editor (after Schema 1)
-- Idempotent: safe to run multiple times
--
-- FIXES 42P13: All functions use auth.uid() INSIDE the body
--              NOT as a DEFAULT parameter value.
-- ================================================================

-- ─────────────────────────────────────────────────────────────────
-- INTERNAL HELPERS (not exposed to users)
-- ─────────────────────────────────────────────────────────────────

-- Get or create wallet for any user. Returns wallet UUID.
CREATE OR REPLACE FUNCTION public.ghurt_wallet(p_user_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id     UUID;
  v_bal    NUMERIC(12,2) := 0.00;
BEGIN
  SELECT id INTO v_id FROM public.wallets WHERE user_id = p_user_id;

  IF v_id IS NULL THEN
    -- Try to seed balance from legacy users.balance column
    BEGIN
      SELECT COALESCE(balance, 0.00) INTO v_bal
      FROM public.users WHERE id = p_user_id;
    EXCEPTION WHEN OTHERS THEN v_bal := 0.00; END;

    INSERT INTO public.wallets (user_id, available_balance, held_balance)
    VALUES (p_user_id, v_bal, 0.00)
    ON CONFLICT (user_id) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.wallets WHERE user_id = p_user_id;
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

-- Append-only ledger entry
CREATE OR REPLACE FUNCTION public.ghurt_ledger(
  p_user_id    UUID,
  p_wallet_id  UUID,
  p_type       VARCHAR,
  p_amount     NUMERIC,
  p_balance    NUMERIC,
  p_ref        UUID,
  p_meta       JSONB,
  p_device     TEXT,
  p_status     VARCHAR
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO public.transactions (
    user_id, wallet_id, transaction_type, amount,
    balance_after, reference_id, metadata, device_id, status
  ) VALUES (
    p_user_id, p_wallet_id, p_type, p_amount,
    p_balance, p_ref, COALESCE(p_meta, '{}'), p_device,
    COALESCE(p_status, 'completed')
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- get_user_balance()
-- Client calls with NO arguments. auth.uid() resolved inside.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_user_balance()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid    UUID;
  v_wid    UUID;
  v_wallet RECORD;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_wid := public.ghurt_wallet(v_uid);
  SELECT * INTO v_wallet FROM public.wallets WHERE id = v_wid;

  RETURN jsonb_build_object(
    'wallet_id',         v_wallet.id,
    'available_balance', v_wallet.available_balance,
    'held_balance',      v_wallet.held_balance,
    'total_balance',     v_wallet.available_balance + v_wallet.held_balance,
    'is_frozen',         v_wallet.is_frozen
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_balance() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_user_balance() TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- get_transaction_history(type, limit, offset)
-- All 3 params have defaults → NO 42P13. auth.uid() resolved inside.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_transaction_history(
  p_transaction_type VARCHAR DEFAULT NULL,
  p_limit            INT     DEFAULT 50,
  p_offset           INT     DEFAULT 0
)
RETURNS TABLE (
  id               UUID,
  transaction_type VARCHAR,
  amount           NUMERIC,
  balance_after    NUMERIC,
  status           VARCHAR,
  metadata         JSONB,
  created_at       TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_uid UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_limit  > 100 THEN p_limit  := 100; END IF;
  IF p_offset < 0   THEN p_offset := 0;   END IF;

  RETURN QUERY
  SELECT t.id, t.transaction_type, t.amount, t.balance_after,
         t.status, t.metadata, t.created_at
  FROM public.transactions t
  WHERE t.user_id = v_uid
    AND (p_transaction_type IS NULL OR t.transaction_type = p_transaction_type)
  ORDER BY t.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_transaction_history(VARCHAR, INT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_transaction_history(VARCHAR, INT, INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- process_withdrawal(amount, phone, device_id)
-- Client-facing. auth.uid() resolved inside. No p_user_id param.
-- Deducts from wallet AND legacy users.balance (keeps both in sync).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_withdrawal(
  p_amount      NUMERIC,
  p_phone_number TEXT,
  p_device_id   TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid          UUID;
  v_wid          UUID;
  v_wallet       RECORD;
  v_new_avail    NUMERIC;
  v_wdraw_id     UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Amount validation
  IF p_amount IS NULL OR p_amount < 10 THEN
    RAISE EXCEPTION 'Minimum withdrawal is KES 10';
  END IF;
  IF p_amount > 70000 THEN
    RAISE EXCEPTION 'Withdrawal exceeds daily limit of KES 70,000';
  END IF;

  -- Phone validation
  IF p_phone_number IS NULL OR length(trim(p_phone_number)) < 9 THEN
    RAISE EXCEPTION 'Valid M-Pesa phone number required';
  END IF;

  -- Rate limit: max 3 withdrawals per 24 hours
  DECLARE v_recent_count INT;
  BEGIN
    SELECT COUNT(*) INTO v_recent_count
    FROM public.withdrawal_transactions
    WHERE user_id = v_uid
      AND created_at > NOW() - INTERVAL '24 hours'
      AND status NOT IN ('FAILED');
    IF v_recent_count >= 3 THEN
      RAISE EXCEPTION 'Withdrawal limit: max 3 per 24 hours. Try again later.';
    END IF;
  END;

  -- Lock wallet to prevent double-spend
  SELECT w.* INTO v_wallet
  FROM public.wallets w WHERE w.user_id = v_uid FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found. Contact support.'; END IF;
  IF v_wallet.is_frozen THEN RAISE EXCEPTION 'Your wallet is frozen. Contact support.'; END IF;

  IF v_wallet.available_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: KES %', round(v_wallet.available_balance, 2);
  END IF;

  -- Deduct from wallet
  UPDATE public.wallets
  SET available_balance = available_balance - p_amount, updated_at = NOW()
  WHERE id = v_wallet.id
  RETURNING available_balance INTO v_new_avail;

  -- Keep legacy users.balance in sync
  BEGIN
    UPDATE public.users
    SET balance = GREATEST(0, COALESCE(balance, 0) - p_amount)
    WHERE id = v_uid;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  -- Queue withdrawal record
  INSERT INTO public.withdrawal_transactions (user_id, amount, phone, status)
  VALUES (v_uid, p_amount, p_phone_number, 'PENDING')
  RETURNING id INTO v_wdraw_id;

  -- Log in ledger
  PERFORM public.ghurt_ledger(
    v_uid, v_wallet.id, 'withdrawal', p_amount, v_new_avail,
    v_wdraw_id,
    jsonb_build_object('phone', p_phone_number, 'device', p_device_id),
    p_device_id, 'pending'
  );

  RETURN jsonb_build_object(
    'success',       true,
    'withdrawal_id', v_wdraw_id,
    'new_balance',   v_new_avail,
    'status',        'pending'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_withdrawal(NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.process_withdrawal(NUMERIC, TEXT, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- lock_stake(user_id, amount, game_id, device_id)
-- Moves available → held when joining a staked game.
-- Validates caller is the same user as p_user_id.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lock_stake(
  p_user_id   UUID,
  p_amount    NUMERIC,
  p_game_id   UUID,
  p_device_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_wallet    RECORD;
  v_new_avail NUMERIC;
  v_new_held  NUMERIC;
BEGIN
  -- Security: caller can only lock their own stake
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid stake amount';
  END IF;

  SELECT w.* INTO v_wallet
  FROM public.wallets w WHERE w.user_id = p_user_id FOR UPDATE;

  IF NOT FOUND    THEN RAISE EXCEPTION 'Wallet not found'; END IF;
  IF v_wallet.is_frozen THEN RAISE EXCEPTION 'Wallet is frozen'; END IF;
  IF v_wallet.available_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: KES %', round(v_wallet.available_balance, 2);
  END IF;

  UPDATE public.wallets
  SET available_balance = available_balance - p_amount,
      held_balance      = held_balance      + p_amount,
      updated_at        = NOW()
  WHERE id = v_wallet.id
  RETURNING available_balance, held_balance INTO v_new_avail, v_new_held;

  PERFORM public.ghurt_ledger(
    p_user_id, v_wallet.id, 'stake', p_amount, v_new_avail,
    p_game_id, jsonb_build_object('held', v_new_held, 'game_id', p_game_id),
    p_device_id, 'completed'
  );

  RETURN jsonb_build_object(
    'success',           true,
    'available_balance', v_new_avail,
    'held_balance',      v_new_held
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lock_stake(UUID, NUMERIC, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.lock_stake(UUID, NUMERIC, UUID, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- complete_intasend_deposit(invoice_id, user_id, amount)
-- Called ONLY by the intasend-webhook Edge Function (service_role).
-- Idempotent: returns FALSE if already credited.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_intasend_deposit(
  p_invoice_id TEXT,
  p_user_id    UUID,
  p_amount     NUMERIC
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_dep    public.deposit_transactions%ROWTYPE;
  v_wid    UUID;
  v_newbal NUMERIC;
BEGIN
  -- Input validation
  IF p_invoice_id IS NULL OR trim(p_invoice_id) = '' THEN
    RAISE EXCEPTION 'Missing invoice_id';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user_id';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1500 THEN
    RAISE EXCEPTION 'Invalid deposit amount: %', p_amount;
  END IF;

  -- Lock row for idempotency (prevents double-credit on duplicate webhook)
  SELECT * INTO v_dep
  FROM public.deposit_transactions
  WHERE invoice_id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown invoice: %', p_invoice_id;
  END IF;

  IF v_dep.status = 'COMPLETE' THEN
    RETURN FALSE; -- Already processed — safe to return without error
  END IF;

  IF v_dep.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'User mismatch for invoice %', p_invoice_id;
  END IF;

  IF ABS(v_dep.amount - p_amount) > 0.50 THEN
    RAISE EXCEPTION 'Amount mismatch: expected %, got %', v_dep.amount, p_amount;
  END IF;

  -- Mark deposit complete
  UPDATE public.deposit_transactions
  SET status = 'COMPLETE', updated_at = NOW()
  WHERE invoice_id = p_invoice_id;

  -- Credit wallet
  v_wid := public.ghurt_wallet(p_user_id);

  UPDATE public.wallets
  SET available_balance = available_balance + p_amount, updated_at = NOW()
  WHERE id = v_wid
  RETURNING available_balance INTO v_newbal;

  -- Keep legacy users.balance in sync
  BEGIN
    UPDATE public.users
    SET balance = COALESCE(balance, 0) + p_amount
    WHERE id = p_user_id;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  -- Ledger entry
  PERFORM public.ghurt_ledger(
    p_user_id, v_wid, 'deposit', p_amount, v_newbal,
    NULL, jsonb_build_object('invoice_id', p_invoice_id, 'source', 'intasend_mpesa'),
    NULL, 'completed'
  );

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_intasend_deposit(TEXT, UUID, NUMERIC) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.complete_intasend_deposit(TEXT, UUID, NUMERIC) TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- distribute_winnings(winner, loser, pot, game_id, device_id)
-- 8% platform fee enforced server-side. Called after staked game.
-- Service role only.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.distribute_winnings(
  p_winner_id UUID,
  p_loser_id  UUID,
  p_total_pot NUMERIC,
  p_game_id   UUID,
  p_device_id TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fee      NUMERIC;
  v_payout   NUMERIC;
  v_wid      UUID;
  v_newbal   NUMERIC;
  v_lwid     UUID;
  v_lbal     NUMERIC;
BEGIN
  v_fee    := ROUND(p_total_pot * 0.08, 2);
  v_payout := p_total_pot - v_fee;

  -- Winner wallet
  v_wid := public.ghurt_wallet(p_winner_id);

  UPDATE public.wallets
  SET available_balance = available_balance + v_payout,
      held_balance      = GREATEST(0, held_balance - (p_total_pot / 2)),
      updated_at        = NOW()
  WHERE id = v_wid
  RETURNING available_balance INTO v_newbal;

  -- Sync winner users.balance
  BEGIN
    UPDATE public.users SET balance = COALESCE(balance, 0) + v_payout WHERE id = p_winner_id;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  PERFORM public.ghurt_ledger(
    p_winner_id, v_wid, 'win', v_payout, v_newbal, p_game_id,
    jsonb_build_object('pot', p_total_pot, 'fee', v_fee, 'payout', v_payout),
    p_device_id, 'completed'
  );

  PERFORM public.ghurt_ledger(
    p_winner_id, v_wid, 'fee', v_fee, v_newbal, p_game_id,
    jsonb_build_object('fee_type', 'platform_8pct'),
    NULL, 'completed'
  );

  -- Loser: release held stake
  IF p_loser_id IS NOT NULL THEN
    v_lwid := public.ghurt_wallet(p_loser_id);
    UPDATE public.wallets
    SET held_balance = GREATEST(0, held_balance - (p_total_pot / 2)),
        updated_at   = NOW()
    WHERE id = v_lwid
    RETURNING available_balance INTO v_lbal;

    PERFORM public.ghurt_ledger(
      p_loser_id, v_lwid, 'loss', p_total_pot / 2, COALESCE(v_lbal, 0),
      p_game_id, jsonb_build_object('lost_to', p_winner_id),
      NULL, 'completed'
    );
  END IF;

  RETURN jsonb_build_object(
    'success',         true,
    'winner_payout',   v_payout,
    'platform_fee',    v_fee,
    'winner_balance',  v_newbal
  );
END;
$$;

REVOKE ALL ON FUNCTION public.distribute_winnings(UUID, UUID, NUMERIC, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.distribute_winnings(UUID, UUID, NUMERIC, UUID, TEXT) TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- refund_stake(user_id, amount, game_id, reason)
-- Moves held → available on dispute or cancellation.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_stake(
  p_user_id UUID,
  p_amount  NUMERIC,
  p_game_id UUID DEFAULT NULL,
  p_reason  TEXT DEFAULT 'Game cancelled'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_wallet RECORD;
  v_avail  NUMERIC;
  v_held   NUMERIC;
BEGIN
  SELECT w.* INTO v_wallet
  FROM public.wallets w WHERE w.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found'; END IF;

  IF v_wallet.held_balance < p_amount THEN
    RAISE EXCEPTION 'Held balance % < refund amount %', v_wallet.held_balance, p_amount;
  END IF;

  UPDATE public.wallets
  SET available_balance = available_balance + p_amount,
      held_balance      = held_balance      - p_amount,
      updated_at        = NOW()
  WHERE id = v_wallet.id
  RETURNING available_balance, held_balance INTO v_avail, v_held;

  -- Sync legacy balance
  BEGIN
    UPDATE public.users SET balance = COALESCE(balance, 0) + p_amount WHERE id = p_user_id;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  PERFORM public.ghurt_ledger(
    p_user_id, v_wallet.id, 'refund', p_amount, v_avail, p_game_id,
    jsonb_build_object('reason', p_reason), NULL, 'completed'
  );

  RETURN jsonb_build_object('success', true, 'new_balance', v_avail, 'held_balance', v_held);
END;
$$;

REVOKE ALL ON FUNCTION public.refund_stake(UUID, NUMERIC, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.refund_stake(UUID, NUMERIC, UUID, TEXT) TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- FRAUD DETECTION
-- ─────────────────────────────────────────────────────────────────

-- Client can check if own device is banned
CREATE OR REPLACE FUNCTION public.check_device_banned(p_device_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_dev RECORD;
BEGIN
  SELECT * INTO v_dev
  FROM public.user_devices
  WHERE device_id = p_device_id AND user_id = auth.uid();

  IF NOT FOUND        THEN RETURN FALSE; END IF;
  IF NOT v_dev.is_banned THEN RETURN FALSE; END IF;

  -- Auto-lift expired bans
  IF v_dev.ban_until IS NOT NULL AND v_dev.ban_until < NOW() THEN
    UPDATE public.user_devices
    SET is_banned = FALSE, ban_until = NULL, ban_reason = NULL
    WHERE id = v_dev.id;
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.check_device_banned(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_device_banned(TEXT) TO authenticated;

-- Track player pairs — collusion detection (service role)
CREATE OR REPLACE FUNCTION public.ghurt_track_player_pair(
  p_player1_id UUID,
  p_player2_id UUID,
  p_game_id    UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_p1   UUID;
  v_p2   UUID;
  v_pair RECORD;
  v_cnt  INT;
BEGIN
  -- Canonical ordering
  IF p_player1_id < p_player2_id THEN
    v_p1 := p_player1_id; v_p2 := p_player2_id;
  ELSE
    v_p1 := p_player2_id; v_p2 := p_player1_id;
  END IF;

  INSERT INTO public.player_pairs (player1_id, player2_id, games_played, games_together, last_played)
  VALUES (v_p1, v_p2, 1, 1, NOW())
  ON CONFLICT (player1_id, player2_id) DO UPDATE
  SET games_played   = player_pairs.games_played   + 1,
      games_together = player_pairs.games_together + 1,
      last_played    = NOW()
  RETURNING * INTO v_pair;

  -- Count games together in last 24h
  SELECT COUNT(*) INTO v_cnt
  FROM public.games g
  WHERE g.created_at > NOW() - INTERVAL '24 hours'
    AND g.joined_players::text LIKE '%' || v_p1 || '%'
    AND g.joined_players::text LIKE '%' || v_p2 || '%';

  IF v_cnt > 5 THEN
    UPDATE public.player_pairs
    SET suspicious_score = suspicious_score + 10, is_flagged = TRUE
    WHERE player1_id = v_p1 AND player2_id = v_p2;
  END IF;
END;
$$;

-- Device conflict detection — progressive banning (service role)
CREATE OR REPLACE FUNCTION public.ghurt_detect_device_conflict(
  p_user_id   UUID,
  p_device_id TEXT,
  p_game_id   UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cnt    INT;
  v_action TEXT;
  v_until  TIMESTAMPTZ;
BEGIN
  SELECT COUNT(*) INTO v_cnt
  FROM public.transactions t
  WHERE t.transaction_type = 'win'
    AND t.device_id = p_device_id
    AND t.user_id != p_user_id
    AND t.created_at > NOW() - INTERVAL '7 days';

  IF v_cnt = 0 THEN RETURN jsonb_build_object('conflict_detected', false); END IF;

  CASE
    WHEN v_cnt = 1 THEN v_action := 'warn';    v_until := NULL;
    WHEN v_cnt = 2 THEN v_action := 'ban_24h'; v_until := NOW() + INTERVAL '24 hours';
    WHEN v_cnt = 3 THEN v_action := 'ban_72h'; v_until := NOW() + INTERVAL '72 hours';
    ELSE                 v_action := 'ban_permanent'; v_until := NULL;
  END CASE;

  IF v_action != 'warn' THEN
    UPDATE public.user_devices
    SET is_banned  = TRUE,
        ban_reason = 'Multiple device conflict — suspected fraud',
        ban_until  = v_until
    WHERE device_id = p_device_id;
  END IF;

  INSERT INTO public.disputes (game_id, reporter_id, dispute_type, status, evidence)
  VALUES (
    p_game_id, p_user_id, 'both_claim_win', 'escalated',
    jsonb_build_object('device_id', p_device_id, 'conflict_count', v_cnt, 'action', v_action)
  );

  RETURN jsonb_build_object(
    'conflict_detected', true,
    'action',           v_action,
    'conflict_count',   v_cnt
  );
END;
$$;

-- Client reports a dispute (reporter = auth.uid())
CREATE OR REPLACE FUNCTION public.create_dispute(
  p_game_id      UUID,
  p_dispute_type TEXT,
  p_game_state   JSONB DEFAULT '{}',
  p_evidence     JSONB DEFAULT '{}'
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_did UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  INSERT INTO public.disputes (
    game_id, reporter_id, dispute_type, status,
    game_state_snapshot, evidence
  ) VALUES (
    p_game_id, v_uid, p_dispute_type, 'pending', p_game_state, p_evidence
  ) RETURNING id INTO v_did;

  RETURN v_did;
END;
$$;

REVOKE ALL ON FUNCTION public.create_dispute(UUID, TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_dispute(UUID, TEXT, JSONB, JSONB) TO authenticated;

-- Save game replay for dispute review
CREATE OR REPLACE FUNCTION public.save_game_replay(
  p_game_id          UUID,
  p_moves            JSONB,
  p_final_state      JSONB,
  p_duration_seconds INT  DEFAULT NULL,
  p_staked_game_id   UUID DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_rid UUID;
BEGIN
  INSERT INTO public.game_replays (game_id, staked_game_id, moves, final_state, duration_seconds)
  VALUES (p_game_id, p_staked_game_id, p_moves, p_final_state, p_duration_seconds)
  RETURNING id INTO v_rid;
  RETURN v_rid;
END;
$$;

REVOKE ALL ON FUNCTION public.save_game_replay(UUID, JSONB, JSONB, INT, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.save_game_replay(UUID, JSONB, JSONB, INT, UUID) TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- ADMIN FUNCTIONS (service_role only — never expose to client)
-- ─────────────────────────────────────────────────────────────────

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

REVOKE ALL ON FUNCTION public.admin_financial_summary(DATE, DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_financial_summary(DATE, DATE) TO service_role;

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
    'live_games', v_total, 'stuck_games', v_stuck, 'live_staked_games', v_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_live_games_stats() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_live_games_stats() TO service_role;

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

REVOKE ALL ON FUNCTION public.admin_pending_disputes() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_pending_disputes() TO service_role;

CREATE OR REPLACE FUNCTION public.admin_resolve_dispute(
  p_dispute_id UUID,
  p_action     TEXT,
  p_reason     TEXT,
  p_winner_id  UUID DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_dis RECORD; v_aid UUID;
BEGIN
  SELECT * INTO v_dis FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispute not found: %', p_dispute_id; END IF;

  UPDATE public.disputes
  SET status = 'resolved', resolution_action = p_action,
      admin_notes = p_reason, resolved_at = NOW()
  WHERE id = p_dispute_id;

  INSERT INTO public.audit_log (
    action_type, target_type, target_id, old_values, new_values, reason
  ) VALUES (
    'resolve_dispute', 'dispute', p_dispute_id,
    jsonb_build_object('status', v_dis.status),
    jsonb_build_object('status', 'resolved', 'action', p_action, 'winner', p_winner_id),
    p_reason
  ) RETURNING id INTO v_aid;

  RETURN jsonb_build_object('success', true, 'audit_id', v_aid);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute(UUID, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_resolve_dispute(UUID, TEXT, TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_freeze_wallet(
  p_target_user_id UUID,
  p_reason         TEXT,
  p_freeze         BOOLEAN DEFAULT TRUE
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_aid UUID; v_wid UUID;
BEGIN
  SELECT id INTO v_wid FROM public.wallets WHERE user_id = p_target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet not found for user %', p_target_user_id; END IF;

  UPDATE public.wallets SET is_frozen = p_freeze, updated_at = NOW()
  WHERE id = v_wid;

  INSERT INTO public.audit_log (
    action_type, target_type, target_id, new_values, reason
  ) VALUES (
    CASE WHEN p_freeze THEN 'freeze_wallet' ELSE 'unfreeze_wallet' END,
    'wallet', v_wid,
    jsonb_build_object('is_frozen', p_freeze, 'user_id', p_target_user_id),
    p_reason
  ) RETURNING id INTO v_aid;

  RETURN jsonb_build_object('success', true, 'frozen', p_freeze, 'audit_id', v_aid);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_freeze_wallet(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_freeze_wallet(UUID, TEXT, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_ban_device(
  p_device_id      TEXT,
  p_reason         TEXT,
  p_duration_hours INT DEFAULT 24
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_until TIMESTAMPTZ;
BEGIN
  v_until := CASE WHEN p_duration_hours <= 0 THEN NULL
                  ELSE NOW() + (p_duration_hours || ' hours')::INTERVAL END;

  UPDATE public.user_devices
  SET is_banned = TRUE, ban_reason = p_reason, ban_until = v_until
  WHERE device_id = p_device_id;

  INSERT INTO public.audit_log (action_type, target_type, new_values, reason)
  VALUES (
    'ban_device', 'device',
    jsonb_build_object('device_id', p_device_id, 'ban_until', v_until, 'duration_hours', p_duration_hours),
    p_reason
  );

  RETURN jsonb_build_object('success', true, 'device_id', p_device_id, 'ban_until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ban_device(TEXT, TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_ban_device(TEXT, TEXT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_suspend_user(
  p_target_user_id UUID,
  p_reason         TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_aid UUID;
BEGIN
  UPDATE auth.users
  SET raw_user_meta_data = jsonb_set(
    COALESCE(raw_user_meta_data, '{}'), '{is_suspended}', '"true"'
  )
  WHERE id = p_target_user_id;

  INSERT INTO public.audit_log (
    action_type, target_type, target_id, new_values, reason
  ) VALUES (
    'suspend_user', 'user', p_target_user_id,
    jsonb_build_object('is_suspended', true),
    p_reason
  ) RETURNING id INTO v_aid;

  RETURN jsonb_build_object('success', true, 'audit_id', v_aid);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_suspend_user(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.admin_suspend_user(UUID, TEXT) TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- admin_restore_user(user_id, reason)
-- ─────────────────────────────────────────────────────────────────
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
GRANT  EXECUTE ON FUNCTION public.admin_restore_user(UUID, TEXT) TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- BALANCE GUARD TRIGGER
-- Blocks direct client-side balance updates on users table
-- Only functions that set allow_balance_update can bypass
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ghurt_guard_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    IF current_setting('app.allow_balance_update', true) = 'true' THEN
      RETURN NEW;
    END IF;
    IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Direct balance modification denied. Use server functions only.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_balance ON public.users;
CREATE TRIGGER trg_guard_balance
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.ghurt_guard_balance();

NOTIFY pgrst, 'reload schema';

-- ================================================================
-- DONE — Schema 2 complete.
-- Your webhook endpoint is:
-- https://rrxbxzgapyzltncwclfj.supabase.co/functions/v1/intasend-webhook
-- ================================================================
