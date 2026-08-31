-- Financial RPC Functions for Ghurt
-- These functions handle all financial operations server-side
-- Execute in Supabase SQL Editor

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to get or create wallet for user
CREATE OR REPLACE FUNCTION get_or_create_wallet(p_user_id UUID)
RETURNS UUID AS $$
DECLARE
  v_wallet_id UUID;
BEGIN
  -- Try to get existing wallet
  SELECT id INTO v_wallet_id FROM wallets WHERE user_id = p_user_id;
  
  -- If not exists, create new wallet
  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (user_id, available_balance, held_balance)
    VALUES (p_user_id, 0.00, 0.00)
    RETURNING id INTO v_wallet_id;
  END IF;
  
  RETURN v_wallet_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to log transaction
CREATE OR REPLACE FUNCTION log_transaction(
  p_user_id UUID,
  p_wallet_id UUID,
  p_transaction_type VARCHAR,
  p_amount DECIMAL,
  p_balance_after DECIMAL,
  p_reference_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}',
  p_device_id VARCHAR DEFAULT NULL,
  p_ip_address INET DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_transaction_id UUID;
BEGIN
  INSERT INTO transactions (
    user_id, wallet_id, transaction_type, amount, 
    balance_after, reference_id, metadata, 
    device_id, ip_address, status
  ) VALUES (
    p_user_id, p_wallet_id, p_transaction_type, p_amount,
    p_balance_after, p_reference_id, p_metadata,
    p_device_id, p_ip_address, 'completed'
  ) RETURNING id INTO v_transaction_id;
  
  RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- DEPOSIT PROCESSING
-- ============================================

-- Process deposit from Intasend webhook
CREATE OR REPLACE FUNCTION process_deposit(
  p_user_id UUID,
  p_amount DECIMAL,
  p_payment_id VARCHAR,
  p_metadata JSONB DEFAULT '{}',
  p_device_id VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_wallet_id UUID;
  v_new_balance DECIMAL;
  v_transaction_id UUID;
BEGIN
  -- Validate amount
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid deposit amount';
  END IF;
  
  -- Get or create wallet
  v_wallet_id := get_or_create_wallet(p_user_id);
  
  -- Update wallet balance
  UPDATE wallets
  SET 
    available_balance = available_balance + p_amount,
    updated_at = NOW()
  WHERE id = v_wallet_id
  RETURNING available_balance INTO v_new_balance;
  
  -- Log transaction
  v_transaction_id := log_transaction(
    p_user_id, v_wallet_id, 'deposit', p_amount,
    v_new_balance, NULL, p_metadata, p_device_id, NULL
  );
  
  RETURN jsonb_build_object(
    'success', true,
    'wallet_id', v_wallet_id,
    'new_balance', v_new_balance,
    'transaction_id', v_transaction_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- WITHDRAWAL PROCESSING
-- ============================================

-- Process withdrawal request
CREATE OR REPLACE FUNCTION process_withdrawal(
  p_user_id UUID,
  p_amount DECIMAL,
  p_phone_number VARCHAR,
  p_device_id VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_new_balance DECIMAL;
  v_transaction_id UUID;
BEGIN
  -- Validate amount
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid withdrawal amount';
  END IF;
  
  -- Get wallet
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  
  -- Check sufficient balance
  IF v_wallet.available_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;
  
  -- Check if wallet is frozen
  IF v_wallet.held_balance > 0 THEN
    -- Has locked funds - might need manual review
    -- For now, allow withdrawal from available balance only
  END IF;
  
  -- Deduct from wallet
  UPDATE wallets
  SET 
    available_balance = available_balance - p_amount,
    updated_at = NOW()
  WHERE id = v_wallet.id
  RETURNING available_balance INTO v_new_balance;
  
  -- Log transaction as pending (will be updated after Intasend processing)
  INSERT INTO transactions (
    user_id, wallet_id, transaction_type, amount,
    balance_after, metadata, device_id, status
  ) VALUES (
    p_user_id, v_wallet.id, 'withdrawal', p_amount,
    v_new_balance, jsonb_build_object('phone_number', p_phone_number),
    p_device_id, 'pending'
  ) RETURNING id INTO v_transaction_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'wallet_id', v_wallet.id,
    'new_balance', v_new_balance,
    'transaction_id', v_transaction_id,
    'status', 'pending'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Confirm withdrawal after Intasend processing
CREATE OR REPLACE FUNCTION confirm_withdrawal(
  p_transaction_id UUID,
  p_success BOOLEAN,
  p_intasend_id VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  -- Get transaction
  SELECT * INTO v_transaction 
  FROM transactions 
  WHERE id = p_transaction_id AND transaction_type = 'withdrawal';
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  
  -- Update transaction status
  UPDATE transactions
  SET 
    status = CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
    metadata = jsonb_build_object(
      'intasend_id', p_intasend_id,
      'confirmed_at', NOW()
    )
  WHERE id = p_transaction_id;
  
  -- If failed, refund the amount back to wallet
  IF NOT p_success THEN
    UPDATE wallets
    SET 
      available_balance = available_balance + v_transaction.amount,
      updated_at = NOW()
    WHERE id = v_transaction.wallet_id;
  END IF;
  
  RETURN jsonb_build_object('success', true, 'status', CASE WHEN p_success THEN 'completed' ELSE 'failed' END);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- STAKE LOCKING
-- ============================================

-- Lock stake amount when joining staked game
CREATE OR REPLACE FUNCTION lock_stake(
  p_user_id UUID,
  p_amount DECIMAL,
  p_game_id UUID,
  p_device_id VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_new_available DECIMAL;
  v_new_held DECIMAL;
  v_transaction_id UUID;
BEGIN
  -- Validate user
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Validate amount
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid stake amount';
  END IF;
  
  -- Get wallet
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  
  -- Check sufficient balance
  IF v_wallet.available_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for stake';
  END IF;
  
  -- Lock funds (move from available to held)
  UPDATE wallets
  SET 
    available_balance = available_balance - p_amount,
    held_balance = held_balance + p_amount,
    updated_at = NOW()
  WHERE id = v_wallet.id
  RETURNING available_balance, held_balance INTO v_new_available, v_new_held;
  
  -- Log transaction
  v_transaction_id := log_transaction(
    p_user_id, v_wallet.id, 'stake', p_amount,
    v_new_available, p_game_id, 
    jsonb_build_object('held_balance', v_new_held),
    p_device_id, NULL
  );
  
  RETURN jsonb_build_object(
    'success', true,
    'wallet_id', v_wallet.id,
    'available_balance', v_new_available,
    'held_balance', v_new_held,
    'transaction_id', v_transaction_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- GAME WINNINGS WITH 8% FEE
-- ============================================

-- Calculate and distribute winnings with 8% platform fee
CREATE OR REPLACE FUNCTION distribute_winnings(
  p_winner_id UUID,
  p_loser_id UUID,
  p_total_pot DECIMAL,
  p_game_id UUID,
  p_device_id VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_winner_wallet RECORD;
  v_loser_wallet RECORD;
  v_platform_fee DECIMAL;
  v_winner_payout DECIMAL;
  v_new_winner_balance DECIMAL;
  v_transaction_id UUID;
BEGIN
  -- Calculate 8% platform fee
  v_platform_fee := p_total_pot * 0.08;
  v_winner_payout := p_total_pot - v_platform_fee;
  
  -- Get winner wallet
  SELECT * INTO v_winner_wallet FROM wallets WHERE user_id = p_winner_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Winner wallet not found';
  END IF;
  
  -- Release held funds and add winnings
  UPDATE wallets
  SET 
    available_balance = available_balance + v_winner_payout,
    held_balance = held_balance - (p_total_pot / 2), -- Release winner's stake
    updated_at = NOW()
  WHERE id = v_winner_wallet.id
  RETURNING available_balance INTO v_new_winner_balance;
  
  -- Log win transaction
  v_transaction_id := log_transaction(
    p_winner_id, v_winner_wallet.id, 'win', v_winner_payout,
    v_new_winner_balance, p_game_id,
    jsonb_build_object(
      'total_pot', p_total_pot,
      'platform_fee', v_platform_fee,
      'net_payout', v_winner_payout
    ),
    p_device_id, NULL
  );
  
  -- Log platform fee transaction
  INSERT INTO transactions (
    user_id, wallet_id, transaction_type, amount,
    balance_after, reference_id, metadata, status
  ) VALUES (
    p_winner_id, v_winner_wallet.id, 'fee', v_platform_fee,
    v_new_winner_balance, p_game_id,
    jsonb_build_object('fee_type', 'platform', 'percentage', 8),
    'completed'
  );
  
  -- Handle loser's held stake (move to platform or refund)
  IF p_loser_id IS NOT NULL THEN
    UPDATE wallets
    SET 
      held_balance = held_balance - (p_total_pot / 2), -- Release loser's stake
      updated_at = NOW()
    WHERE user_id = p_loser_id;
    
    -- Log loss transaction for loser
    INSERT INTO transactions (
      user_id, wallet_id, transaction_type, amount,
      balance_after, reference_id, metadata, status
    ) SELECT 
      p_loser_id, 
      id, 
      'loss', 
      p_total_pot / 2,
      available_balance,
      p_game_id,
      jsonb_build_object('lost_amount', p_total_pot / 2),
      'completed'
    FROM wallets WHERE user_id = p_loser_id;
  END IF;
  
  RETURN jsonb_build_object(
    'success', true,
    'winner_payout', v_winner_payout,
    'platform_fee', v_platform_fee,
    'winner_balance', v_new_winner_balance,
    'transaction_id', v_transaction_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- REFUND STAKE
-- ============================================

-- Refund stake in case of dispute or cancellation
CREATE OR REPLACE FUNCTION refund_stake(
  p_user_id UUID,
  p_amount DECIMAL,
  p_game_id UUID,
  p_reason VARCHAR DEFAULT 'Game cancelled'
)
RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_new_available DECIMAL;
  v_new_held DECIMAL;
  v_transaction_id UUID;
BEGIN
  -- Get wallet
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  
  -- Check sufficient held balance
  IF v_wallet.held_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient held balance for refund';
  END IF;
  
  -- Refund (move from held to available)
  UPDATE wallets
  SET 
    available_balance = available_balance + p_amount,
    held_balance = held_balance - p_amount,
    updated_at = NOW()
  WHERE id = v_wallet.id
  RETURNING available_balance, held_balance INTO v_new_available, v_new_held;
  
  -- Log refund transaction
  v_transaction_id := log_transaction(
    p_user_id, v_wallet.id, 'refund', p_amount,
    v_new_available, p_game_id,
    jsonb_build_object('reason', p_reason, 'held_balance', v_new_held),
    NULL, NULL
  );
  
  RETURN jsonb_build_object(
    'success', true,
    'wallet_id', v_wallet.id,
    'available_balance', v_new_available,
    'held_balance', v_new_held,
    'transaction_id', v_transaction_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- GET USER BALANCE
-- ============================================

-- Get user wallet balance (server-side only)
CREATE OR REPLACE FUNCTION get_user_balance(p_user_id UUID DEFAULT auth.uid())
RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
BEGIN
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id;
  
  IF NOT FOUND THEN
    -- Create wallet if doesn't exist
    INSERT INTO wallets (user_id, available_balance, held_balance)
    VALUES (p_user_id, 0.00, 0.00)
    RETURNING * INTO v_wallet;
  END IF;
  
  RETURN jsonb_build_object(
    'wallet_id', v_wallet.id,
    'available_balance', v_wallet.available_balance,
    'held_balance', v_wallet.held_balance,
    'total_balance', v_wallet.available_balance + v_wallet.held_balance
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- GET TRANSACTION HISTORY
-- ============================================

-- Get user transaction history with filters
CREATE OR REPLACE FUNCTION get_transaction_history(
  p_user_id UUID DEFAULT auth.uid(),
  p_transaction_type VARCHAR DEFAULT NULL,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  transaction_type VARCHAR,
  amount DECIMAL,
  balance_after DECIMAL,
  status VARCHAR,
  metadata JSONB,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    t.id,
    t.transaction_type,
    t.amount,
    t.balance_after,
    t.status,
    t.metadata,
    t.created_at
  FROM transactions t
  WHERE t.user_id = p_user_id
    AND (p_transaction_type IS NULL OR t.transaction_type = p_transaction_type)
  ORDER BY t.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- CLIENT-FACING OVERLOADS (resolving auth.uid() securely)
-- ============================================

-- Client-facing deposit overload
CREATE OR REPLACE FUNCTION process_deposit(
  p_amount DECIMAL,
  p_payment_id VARCHAR,
  p_metadata JSONB DEFAULT '{}',
  p_device_id VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  RETURN process_deposit(v_user_id, p_amount, p_payment_id, p_metadata, p_device_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Client-facing withdrawal overload
CREATE OR REPLACE FUNCTION process_withdrawal(
  p_amount DECIMAL,
  p_phone_number VARCHAR,
  p_device_id VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  RETURN process_withdrawal(v_user_id, p_amount, p_phone_number, p_device_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- INTASEND WEBHOOK COMPLETION HANDLER
-- ============================================

CREATE OR REPLACE FUNCTION public.complete_intasend_deposit(
  p_invoice_id TEXT,
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pending public.deposit_transactions%ROWTYPE;
  v_wallet_id UUID;
  v_new_balance DECIMAL;
  v_transaction_id UUID;
BEGIN
  IF p_invoice_id IS NULL OR length(trim(p_invoice_id)) = 0 THEN
    RAISE EXCEPTION 'Missing invoice_id';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1500 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  -- Lock deposit transaction row
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

  -- Update deposit transaction status to COMPLETE
  UPDATE public.deposit_transactions
  SET status = 'COMPLETE',
      amount = p_amount,
      updated_at = now()
  WHERE invoice_id = p_invoice_id;

  -- Get or create wallet for the user
  v_wallet_id := get_or_create_wallet(p_user_id);

  -- Update the wallet balance in the wallets table
  UPDATE wallets
  SET 
    available_balance = available_balance + p_amount,
    updated_at = NOW()
  WHERE id = v_wallet_id
  RETURNING available_balance INTO v_new_balance;

  -- Log transaction in ledger (transactions table)
  v_transaction_id := log_transaction(
    p_user_id, 
    v_wallet_id, 
    'deposit', 
    p_amount,
    v_new_balance, 
    NULL, 
    jsonb_build_object('invoice_id', p_invoice_id, 'source', 'intasend_webhook'), 
    NULL, 
    NULL
  );

  -- Keep public.users.balance in sync if needed (as fallback or legacy support)
  -- Since we have RLS, it doesn't hurt to update it too
  BEGIN
    UPDATE public.users
    SET balance = COALESCE(balance, 0) + p_amount
    WHERE id = p_user_id;
  EXCEPTION WHEN OTHERS THEN
    -- If users.balance doesn't exist or trigger fails, ignore
    NULL;
  END;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_intasend_deposit(TEXT, UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_intasend_deposit(TEXT, UUID, NUMERIC) TO service_role;

