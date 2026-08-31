-- ============================================================
-- GHURT Card Game — Master Supabase Schema
-- Run this entire script in your Supabase SQL Editor
-- This script is completely idempotent and handles all errors safely.
-- ============================================================

-- ──────────────────────────────────────────
-- 1. USERS TABLE (extends Supabase Auth)
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE,
    display_name TEXT NOT NULL DEFAULT 'Player',
    avatar_id TEXT NOT NULL DEFAULT '1',
    elo INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS on users safely
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
    FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;
CREATE POLICY "Users can insert own profile" ON public.users
    FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create user profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.users (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', 'Player')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ──────────────────────────────────────────
-- 2. GAMES TABLE
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.games (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code VARCHAR(6) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'waiting',
    joined_players JSONB NOT NULL DEFAULT '[]'::jsonb,
    player_count INT NOT NULL DEFAULT 0,
    max_players INT NOT NULL DEFAULT 4,
    game_state JSONB,
    host_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexes (idempotent because of IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_games_room_code ON public.games(room_code);
CREATE INDEX IF NOT EXISTS idx_games_status ON public.games(status) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_games_updated_at ON public.games(updated_at DESC);

-- Enable RLS safely
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read" ON public.games;
CREATE POLICY "Allow public read" ON public.games FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public insert" ON public.games;
CREATE POLICY "Allow public insert" ON public.games FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public update" ON public.games;
CREATE POLICY "Allow public update" ON public.games FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow public delete" ON public.games;
CREATE POLICY "Allow public delete" ON public.games FOR DELETE USING (true);

-- Safely add to realtime (skip if already a member)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.games;
EXCEPTION WHEN duplicate_object THEN
  -- Already a member, that's fine
  NULL;
END;
$$;


-- ──────────────────────────────────────────
-- 3. ATOMIC RPCs
-- ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION join_private_room(p_room_code VARCHAR(6), p_player_id TEXT, p_player_name TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_game RECORD;
BEGIN
    SELECT * INTO v_game FROM public.games
    WHERE room_code = upper(p_room_code) AND status = 'waiting' FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Room not found or already started'; END IF;
    IF v_game.player_count >= v_game.max_players THEN RAISE EXCEPTION 'Room is full'; END IF;

    UPDATE public.games SET
        joined_players = joined_players || jsonb_build_object('id', p_player_id, 'name', p_player_name),
        player_count = player_count + 1, updated_at = now()
    WHERE id = v_game.id RETURNING * INTO v_game;

    RETURN row_to_json(v_game)::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION join_random_game(p_player_id TEXT, p_player_name TEXT, p_room_code VARCHAR(6))
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_game RECORD;
BEGIN
    SELECT * INTO v_game FROM public.games
    WHERE status = 'waiting' AND player_count < max_players
    FOR UPDATE SKIP LOCKED LIMIT 1;

    IF FOUND THEN
        UPDATE public.games SET
            joined_players = joined_players || jsonb_build_object('id', p_player_id, 'name', p_player_name),
            player_count = player_count + 1, updated_at = now()
        WHERE id = v_game.id RETURNING * INTO v_game;
    ELSE
        INSERT INTO public.games (room_code, joined_players, player_count)
        VALUES (upper(p_room_code), jsonb_build_array(jsonb_build_object('id', p_player_id, 'name', p_player_name)), 1)
        RETURNING * INTO v_game;
    END IF;

    RETURN row_to_json(v_game)::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION start_game(p_game_id UUID, p_initial_state JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_game RECORD;
BEGIN
    SELECT * INTO v_game FROM public.games WHERE id = p_game_id AND status = 'waiting' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Game not found or already started'; END IF;

    UPDATE public.games SET status = 'playing', game_state = p_initial_state, updated_at = now()
    WHERE id = p_game_id RETURNING * INTO v_game;

    RETURN row_to_json(v_game)::jsonb;
END;
$$;

-- Cleanup stale rooms
CREATE OR REPLACE FUNCTION cleanup_stale_games()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM public.games WHERE status = 'waiting' AND created_at < NOW() - INTERVAL '30 minutes';
    DELETE FROM public.games WHERE status = 'finished' AND updated_at < NOW() - INTERVAL '2 hours';
END;
$$;
