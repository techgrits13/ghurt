-- ================================================================
-- GHURT FINAL SCHEMA 1 OF 2 — Security & Payment Tables
-- Run this FIRST in Supabase SQL Editor
-- Idempotent: safe to run multiple times
-- Requires: games and staked_games tables to already exist (from v3/v4 migrations)
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────
-- 1. WALLETS TABLE
-- Central balance store — replaces direct users.balance writes
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wallets (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  available_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (available_balance >= 0),
  held_balance     NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (held_balance >= 0),
  is_frozen        BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Add is_frozen column safely if it was created before this migration
ALTER TABLE public.wallets ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);

-- ─────────────────────────────────────────────────────────────────
-- 2. TRANSACTIONS LEDGER
-- Every money movement recorded here — append-only audit trail
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transactions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id        UUID        NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
    'deposit','withdrawal','stake','win','loss','fee','refund','adjustment','penalty'
  )),
  amount           NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  balance_after    NUMERIC(12,2) NOT NULL,
  reference_id     UUID,
  status           VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN (
    'pending','completed','failed','cancelled'
  )),
  metadata         JSONB       NOT NULL DEFAULT '{}',
  device_id        VARCHAR(255),
  ip_address       INET,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id     ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id   ON public.transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type        ON public.transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_status      ON public.transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at  ON public.transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_device_id   ON public.transactions(device_id);
CREATE INDEX IF NOT EXISTS idx_transactions_ref         ON public.transactions(reference_id);

-- ─────────────────────────────────────────────────────────────────
-- 3. DEPOSIT TRANSACTIONS — IntaSend STK Push invoice tracking
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deposit_transactions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invoice_id TEXT        UNIQUE NOT NULL,
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  phone      TEXT,
  status     TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETE','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_tx_user_id   ON public.deposit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_tx_invoice   ON public.deposit_transactions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_deposit_tx_status    ON public.deposit_transactions(status);

-- ─────────────────────────────────────────────────────────────────
-- 4. WITHDRAWAL TRANSACTIONS
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.withdrawal_transactions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 10),
  phone         TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING','PROCESSING','COMPLETE','FAILED'
  )),
  intasend_ref  TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_tx_user_id ON public.withdrawal_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_tx_status  ON public.withdrawal_transactions(status);

-- ─────────────────────────────────────────────────────────────────
-- 5. USER DEVICES — Fraud detection, device tracking
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_devices (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id   VARCHAR(255) NOT NULL,
  device_info JSONB        NOT NULL DEFAULT '{}',
  first_seen  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_banned   BOOLEAN      NOT NULL DEFAULT FALSE,
  ban_reason  TEXT,
  ban_until   TIMESTAMPTZ,
  UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id   ON public.user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_device_id ON public.user_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_is_banned ON public.user_devices(is_banned);

-- ─────────────────────────────────────────────────────────────────
-- 6. DISPUTES — Both-claim-win, state mismatch, payment issues
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.disputes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             UUID        REFERENCES public.games(id) ON DELETE SET NULL,
  staked_game_id      UUID        REFERENCES public.staked_games(id) ON DELETE SET NULL,
  reporter_id         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  dispute_type        VARCHAR(50) NOT NULL CHECK (dispute_type IN (
    'both_claim_win','state_mismatch','timeout','replay_mismatch','payment_issue'
  )),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','resolved','escalated','rejected'
  )),
  resolution_action   VARCHAR(50) CHECK (resolution_action IN (
    'refund_both','award_winner','ban_both','manual_review','reject'
  )),
  game_state_snapshot JSONB       NOT NULL DEFAULT '{}',
  evidence            JSONB       NOT NULL DEFAULT '{}',
  admin_notes         TEXT,
  resolved_by         UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_game_id        ON public.disputes(game_id);
CREATE INDEX IF NOT EXISTS idx_disputes_staked_game_id ON public.disputes(staked_game_id);
CREATE INDEX IF NOT EXISTS idx_disputes_reporter_id    ON public.disputes(reporter_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status         ON public.disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_created_at     ON public.disputes(created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 7. AUDIT LOG — Immutable. No DELETE policy ever. Every admin action logged.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_log (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(50)  CHECK (target_type IN (
    'user','wallet','game','dispute','transaction','device'
  )),
  target_id   UUID,
  old_values  JSONB        NOT NULL DEFAULT '{}',
  new_values  JSONB        NOT NULL DEFAULT '{}',
  reason      TEXT,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_admin_id   ON public.audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON public.audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_target_id  ON public.audit_log(target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON public.audit_log(created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 8. PLAYER PAIRS — Collusion detection
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.player_pairs (
  id               UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id       UUID  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player2_id       UUID  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  games_played     INT   NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  games_together   INT   NOT NULL DEFAULT 0 CHECK (games_together >= 0),
  suspicious_score INT   NOT NULL DEFAULT 0 CHECK (suspicious_score >= 0),
  last_played      TIMESTAMPTZ,
  is_flagged       BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(player1_id, player2_id)
);

CREATE INDEX IF NOT EXISTS idx_player_pairs_p1         ON public.player_pairs(player1_id);
CREATE INDEX IF NOT EXISTS idx_player_pairs_p2         ON public.player_pairs(player2_id);
CREATE INDEX IF NOT EXISTS idx_player_pairs_is_flagged ON public.player_pairs(is_flagged);

-- ─────────────────────────────────────────────────────────────────
-- 9. GAME REPLAYS — For dispute resolution
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.game_replays (
  id               UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id          UUID  REFERENCES public.games(id) ON DELETE CASCADE,
  staked_game_id   UUID  REFERENCES public.staked_games(id) ON DELETE SET NULL,
  moves            JSONB NOT NULL DEFAULT '[]',
  final_state      JSONB NOT NULL DEFAULT '{}',
  duration_seconds INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_replays_game_id        ON public.game_replays(game_id);
CREATE INDEX IF NOT EXISTS idx_game_replays_staked_game_id ON public.game_replays(staked_game_id);
CREATE INDEX IF NOT EXISTS idx_game_replays_created_at     ON public.game_replays(created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- ENABLE ROW LEVEL SECURITY ON ALL TABLES
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.wallets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deposit_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawal_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_devices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_pairs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_replays          ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────
-- RLS POLICIES
-- ─────────────────────────────────────────────────────────────────

-- Wallets
DROP POLICY IF EXISTS "Users see own wallet"    ON public.wallets;
CREATE POLICY "Users see own wallet"            ON public.wallets
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages wallets" ON public.wallets;
CREATE POLICY "Service manages wallets"         ON public.wallets
  FOR ALL USING (auth.role() = 'service_role');

-- Transactions
DROP POLICY IF EXISTS "Users see own transactions"    ON public.transactions;
CREATE POLICY "Users see own transactions"            ON public.transactions
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages transactions"  ON public.transactions;
CREATE POLICY "Service manages transactions"          ON public.transactions
  FOR ALL USING (auth.role() = 'service_role');

-- Deposits
DROP POLICY IF EXISTS "Users see own deposits"   ON public.deposit_transactions;
CREATE POLICY "Users see own deposits"           ON public.deposit_transactions
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages deposits" ON public.deposit_transactions;
CREATE POLICY "Service manages deposits"         ON public.deposit_transactions
  FOR ALL USING (auth.role() = 'service_role');

-- Withdrawals
DROP POLICY IF EXISTS "Users see own withdrawals"   ON public.withdrawal_transactions;
CREATE POLICY "Users see own withdrawals"           ON public.withdrawal_transactions
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages withdrawals" ON public.withdrawal_transactions;
CREATE POLICY "Service manages withdrawals"         ON public.withdrawal_transactions
  FOR ALL USING (auth.role() = 'service_role');

-- User Devices
DROP POLICY IF EXISTS "Users see own devices"   ON public.user_devices;
CREATE POLICY "Users see own devices"           ON public.user_devices
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages devices" ON public.user_devices;
CREATE POLICY "Service manages devices"         ON public.user_devices
  FOR ALL USING (auth.role() = 'service_role');

-- Disputes: reporter sees own disputes
DROP POLICY IF EXISTS "Users see own disputes"   ON public.disputes;
CREATE POLICY "Users see own disputes"           ON public.disputes
  FOR SELECT USING (auth.uid() = reporter_id);
DROP POLICY IF EXISTS "Service manages disputes" ON public.disputes;
CREATE POLICY "Service manages disputes"         ON public.disputes
  FOR ALL USING (auth.role() = 'service_role');

-- Audit Log: service role INSERT only — nobody can DELETE (no delete policy = denied)
DROP POLICY IF EXISTS "Service inserts audit" ON public.audit_log;
CREATE POLICY "Service inserts audit"         ON public.audit_log
  FOR INSERT WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS "Service reads audit"   ON public.audit_log;
CREATE POLICY "Service reads audit"           ON public.audit_log
  FOR SELECT USING (auth.role() = 'service_role');

-- Player Pairs: service role only
DROP POLICY IF EXISTS "Service manages player pairs" ON public.player_pairs;
CREATE POLICY "Service manages player pairs"         ON public.player_pairs
  FOR ALL USING (auth.role() = 'service_role');

-- Game Replays: service role only
DROP POLICY IF EXISTS "Service manages game replays" ON public.game_replays;
CREATE POLICY "Service manages game replays"         ON public.game_replays
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────
-- TRIGGERS
-- ─────────────────────────────────────────────────────────────────

-- Auto-update updated_at (uniquely named to avoid conflicts)
CREATE OR REPLACE FUNCTION public.ghurt_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_wallets_ts           ON public.wallets;
CREATE TRIGGER trg_wallets_ts
  BEFORE UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.ghurt_set_updated_at();

DROP TRIGGER IF EXISTS trg_deposit_tx_ts        ON public.deposit_transactions;
CREATE TRIGGER trg_deposit_tx_ts
  BEFORE UPDATE ON public.deposit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.ghurt_set_updated_at();

DROP TRIGGER IF EXISTS trg_withdrawal_tx_ts     ON public.withdrawal_transactions;
CREATE TRIGGER trg_withdrawal_tx_ts
  BEFORE UPDATE ON public.withdrawal_transactions
  FOR EACH ROW EXECUTE FUNCTION public.ghurt_set_updated_at();

-- Auto-create wallet on user signup
-- Named ghurt_wallet_signup to NOT conflict with existing on_auth_user_created triggers
CREATE OR REPLACE FUNCTION public.ghurt_create_wallet_on_signup()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.wallets (user_id, available_balance, held_balance)
  VALUES (NEW.id, 0.00, 0.00)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ghurt_wallet_signup ON auth.users;
CREATE TRIGGER ghurt_wallet_signup
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.ghurt_create_wallet_on_signup();

-- ─────────────────────────────────────────────────────────────────
-- BACKFILL: Create wallets for users who signed up before this migration
-- Seeds available_balance from users.balance if it exists
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT au.id,
           COALESCE((SELECT u.balance FROM public.users u WHERE u.id = au.id), 0.00) AS bal
    FROM auth.users au
    WHERE NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = au.id)
  LOOP
    INSERT INTO public.wallets (user_id, available_balance, held_balance)
    VALUES (r.id, r.bal, 0.00)
    ON CONFLICT (user_id) DO NOTHING;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- ADMIN FLAG on users table
-- Lets the admin dashboard authenticate via DB flag
-- Set your user as admin:
--   UPDATE public.users SET is_admin = TRUE WHERE id = '<your-user-id>';
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────
-- APPEALS TABLE — for suspended users to request account restoration
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.appeals (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.appeals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public insert on appeals" ON public.appeals;
CREATE POLICY "Allow public insert on appeals" ON public.appeals
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Service manages appeals" ON public.appeals;
CREATE POLICY "Service manages appeals" ON public.appeals
  FOR ALL USING (auth.role() = 'service_role');

NOTIFY pgrst, 'reload schema';

-- ================================================================
-- DONE — Schema 1 complete. Run Schema 2 next.
-- ================================================================
