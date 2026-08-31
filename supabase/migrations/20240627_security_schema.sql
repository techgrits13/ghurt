-- Security Schema Migration for Ghurt
-- This migration creates the security-focused database schema
-- Execute in Supabase SQL Editor

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. WALLETS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  available_balance DECIMAL(10,2) DEFAULT 0.00 CHECK (available_balance >= 0),
  held_balance DECIMAL(10,2) DEFAULT 0.00 CHECK (held_balance >= 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Index for performance
CREATE INDEX idx_wallets_user_id ON wallets(user_id);

-- ============================================
-- 2. TRANSACTIONS LEDGER TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
  transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN ('deposit', 'withdrawal', 'stake', 'win', 'loss', 'fee', 'refund', 'adjustment')),
  amount DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
  balance_after DECIMAL(10,2) NOT NULL,
  reference_id UUID, -- Game ID or payment ID
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  device_id VARCHAR(255),
  ip_address INET
);

-- Indexes for performance and queries
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX idx_transactions_type ON transactions(transaction_type);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX idx_transactions_device_id ON transactions(device_id);
CREATE INDEX idx_transactions_reference_id ON transactions(reference_id);

-- ============================================
-- 3. USER DEVICES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  device_info JSONB DEFAULT '{}',
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  is_banned BOOLEAN DEFAULT FALSE,
  ban_reason TEXT,
  ban_until TIMESTAMPTZ,
  UNIQUE(user_id, device_id)
);

-- Indexes for performance
CREATE INDEX idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX idx_user_devices_device_id ON user_devices(device_id);
CREATE INDEX idx_user_devices_is_banned ON user_devices(is_banned);

-- ============================================
-- 4. DISPUTES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID REFERENCES games(id) ON DELETE SET NULL,
  staked_game_id UUID REFERENCES staked_games(id) ON DELETE SET NULL,
  reporter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  dispute_type VARCHAR(50) NOT NULL CHECK (dispute_type IN ('both_claim_win', 'state_mismatch', 'timeout', 'replay_mismatch', 'payment_issue')),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'escalated', 'rejected')),
  resolution_action VARCHAR(50) CHECK (resolution_action IN ('refund_both', 'award_winner', 'ban_both', 'manual_review', 'reject')),
  game_state_snapshot JSONB DEFAULT '{}',
  evidence JSONB DEFAULT '{}',
  admin_notes TEXT,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_disputes_game_id ON disputes(game_id);
CREATE INDEX idx_disputes_staked_game_id ON disputes(staked_game_id);
CREATE INDEX idx_disputes_reporter_id ON disputes(reporter_id);
CREATE INDEX idx_disputes_status ON disputes(status);
CREATE INDEX idx_disputes_dispute_type ON disputes(dispute_type);
CREATE INDEX idx_disputes_created_at ON disputes(created_at DESC);

-- ============================================
-- 5. AUDIT LOG TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(50) CHECK (target_type IN ('user', 'wallet', 'game', 'dispute', 'transaction', 'device')),
  target_id UUID,
  old_values JSONB DEFAULT '{}',
  new_values JSONB DEFAULT '{}',
  reason TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance and queries
CREATE INDEX idx_audit_log_admin_id ON audit_log(admin_id);
CREATE INDEX idx_audit_log_action_type ON audit_log(action_type);
CREATE INDEX idx_audit_log_target_type ON audit_log(target_type);
CREATE INDEX idx_audit_log_target_id ON audit_log(target_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);

-- ============================================
-- 6. PLAYER PAIRS TABLE (Collusion Detection)
-- ============================================
CREATE TABLE IF NOT EXISTS player_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  player2_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  games_played INT DEFAULT 0 CHECK (games_played >= 0),
  games_together INT DEFAULT 0 CHECK (games_together >= 0),
  suspicious_score INT DEFAULT 0 CHECK (suspicious_score >= 0),
  last_played TIMESTAMPTZ,
  is_flagged BOOLEAN DEFAULT FALSE,
  UNIQUE(player1_id, player2_id)
);

-- Indexes for performance
CREATE INDEX idx_player_pairs_player1 ON player_pairs(player1_id);
CREATE INDEX idx_player_pairs_player2 ON player_pairs(player2_id);
CREATE INDEX idx_player_pairs_is_flagged ON player_pairs(is_flagged);
CREATE INDEX idx_player_pairs_suspicious_score ON player_pairs(suspicious_score);

-- ============================================
-- 7. GAME REPLAYS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS game_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  staked_game_id UUID REFERENCES staked_games(id) ON DELETE SET NULL,
  game_state JSONB NOT NULL,
  moves JSONB NOT NULL DEFAULT '[]',
  duration_seconds INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_game_replays_game_id ON game_replays(game_id);
CREATE INDEX idx_game_replays_staked_game_id ON game_replays(staked_game_id);
CREATE INDEX idx_game_replays_created_at ON game_replays(created_at DESC);

-- ============================================
-- 8. PAYMENT WEBHOOK LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS payment_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  processing_result TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_payment_webhook_logs_payment_id ON payment_webhook_logs(payment_id);
CREATE INDEX idx_payment_webhook_logs_processed ON payment_webhook_logs(processed);
CREATE INDEX idx_payment_webhook_logs_created_at ON payment_webhook_logs(created_at DESC);

-- ============================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- Enable RLS on all tables
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Wallets RLS Policies
CREATE POLICY "Users can view own wallet" ON wallets
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage wallets" ON wallets
  FOR ALL USING (auth.role() = 'service_role');

-- Transactions RLS Policies
CREATE POLICY "Users can view own transactions" ON transactions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage transactions" ON transactions
  FOR ALL USING (auth.role() = 'service_role');

-- User Devices RLS Policies
CREATE POLICY "Users can view own devices" ON user_devices
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage user devices" ON user_devices
  FOR ALL USING (auth.role() = 'service_role');

-- Disputes RLS Policies
CREATE POLICY "Users can view own disputes" ON disputes
  FOR SELECT USING (auth.uid() = reporter_id);

CREATE POLICY "Service role can manage disputes" ON disputes
  FOR ALL USING (auth.role() = 'service_role');

-- Audit Log RLS Policies (Append-only for service role, read-only for admins)
CREATE POLICY "Service role can insert audit logs" ON audit_log
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can view audit logs" ON audit_log
  FOR SELECT USING (auth.role() = 'service_role');

-- Player Pairs RLS Policies
CREATE POLICY "Service role can manage player pairs" ON player_pairs
  FOR ALL USING (auth.role() = 'service_role');

-- Game Replays RLS Policies
CREATE POLICY "Users can view own game replays" ON game_replays
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM games g 
      WHERE g.id = game_replays.game_id 
      AND g.joined_players::text LIKE '%' || auth.uid()::text || '%'
    )
  );

CREATE POLICY "Service role can manage game replays" ON game_replays
  FOR ALL USING (auth.role() = 'service_role');

-- Payment Webhook Logs RLS Policies
CREATE POLICY "Service role can manage payment webhooks" ON payment_webhook_logs
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- FUNCTIONS AND TRIGGERS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for wallets table
CREATE TRIGGER update_wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to create wallet on user signup
CREATE OR REPLACE FUNCTION create_wallet_on_signup()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO wallets (user_id, available_balance, held_balance)
  VALUES (NEW.id, 0.00, 0.00);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create wallet on new user
DROP TRIGGER IF EXISTS on_auth_user_created_wallet ON auth.users;
CREATE TRIGGER on_auth_user_created_wallet
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_wallet_on_signup();

-- ============================================
9. PAYMENT FLOW TABLES (Deposit / Withdrawal)
-- ============================================

CREATE TABLE IF NOT EXISTS deposit_transactions (
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

CREATE TABLE IF NOT EXISTS withdrawal_transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount      NUMERIC     NOT NULL CHECK (amount >= 10),
  phone       TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE deposit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_transactions ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Users see own deposits" ON deposit_transactions;
CREATE POLICY "Users see own deposits" ON deposit_transactions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage deposits" ON deposit_transactions;
CREATE POLICY "Service role can manage deposits" ON deposit_transactions
  FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Users see own withdrawals" ON withdrawal_transactions;
CREATE POLICY "Users see own withdrawals" ON withdrawal_transactions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage withdrawals" ON withdrawal_transactions;
CREATE POLICY "Service role can manage withdrawals" ON withdrawal_transactions
  FOR ALL USING (auth.role() = 'service_role');

-- Triggers for payment flows
DROP TRIGGER IF EXISTS trg_deposit_updated ON deposit_transactions;
CREATE TRIGGER trg_deposit_updated
  BEFORE UPDATE ON deposit_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_withdrawal_updated ON withdrawal_transactions;
CREATE TRIGGER trg_withdrawal_updated
  BEFORE UPDATE ON withdrawal_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- INITIAL DATA
-- ============================================

-- Create wallets for existing users
INSERT INTO wallets (user_id, available_balance, held_balance)
SELECT id, 0.00, 0.00
FROM auth.users
WHERE NOT EXISTS (
  SELECT 1 FROM wallets WHERE wallets.user_id = auth.users.id
);
