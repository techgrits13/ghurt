-- ============================================================
-- Migration v11 — Scalability Indexes for 50k+ Users
-- ============================================================
-- Run this in the Supabase SQL editor.
-- NOTE: CONCURRENTLY is intentionally omitted because the
-- Supabase SQL editor runs inside a transaction block.
-- Tables will be briefly locked during index creation, which
-- is fine for initial setup. For a zero-downtime build on a
-- very large live table, run each statement individually
-- via psql outside a transaction.
-- ============================================================

-- Step 1: Enable pg_trgm (required for GIN trigram index)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Step 2: GIN trigram index for fast ILIKE username search
-- Fixes full-table-scans on: WHERE username ILIKE '%search%'
CREATE INDEX IF NOT EXISTS idx_users_username_trgm
  ON users USING GIN (username gin_trgm_ops);

-- Step 3: Incoming challenge requests (inbox)
-- Fixes: WHERE receiver_id =  AND status = 'pending'
CREATE INDEX IF NOT EXISTS idx_game_requests_receiver
  ON game_requests (receiver_id, status);

-- Step 4: Outgoing challenge requests (outbox)
-- Fixes: WHERE sender_id =  AND status = 'pending'
CREATE INDEX IF NOT EXISTS idx_game_requests_sender
  ON game_requests (sender_id, status);

-- Step 5: Partial index for matchmaking (waiting rooms only)
-- Fixes: SELECT ... FROM games WHERE status = 'waiting'
CREATE INDEX IF NOT EXISTS idx_games_status_waiting
  ON games (status)
  WHERE status = 'waiting';

-- Step 6: Partial index for admin live-games dashboard
-- Fixes: ORDER BY updated_at WHERE status = 'playing'
CREATE INDEX IF NOT EXISTS idx_games_updated_at
  ON games (updated_at ASC)
  WHERE status = 'playing';
