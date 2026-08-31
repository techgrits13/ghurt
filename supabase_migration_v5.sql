-- ============================================================
-- GHURT CardFlow — Supabase Migration v5 (Matchmaking Sync & Robustness)
-- PASTE THIS ENTIRE SCRIPT INTO YOUR SUPABASE SQL EDITOR AND RUN IT.
-- It is fully idempotent (safe to run multiple times).
-- ============================================================

-- ──────────────────────────────────────────
-- 1. ENSURE ALL REQUIRED columns exist on games table
-- ──────────────────────────────────────────
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS max_players INT NOT NULL DEFAULT 4;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS game_state JSONB;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS host_id TEXT;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

-- ──────────────────────────────────────────
-- 2. ENSURE balance column exists on users table
-- ──────────────────────────────────────────
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT;

-- ──────────────────────────────────────────
-- 3. REMOVE UUID constraints on player1_id
--    and make it nullable TEXT so guest IDs work
-- ──────────────────────────────────────────
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN (
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' 
          AND tc.table_name = 'games' 
          AND ccu.column_name IN ('player1_id', 'player2_id')
    ) LOOP
        EXECUTE 'ALTER TABLE public.games DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
    END LOOP;
END $$;

-- Add columns if missing, then convert to nullable TEXT
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS player1_id TEXT NULL;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS player1_name TEXT NULL;

DO $$
BEGIN
    BEGIN
        ALTER TABLE public.games ALTER COLUMN player1_id TYPE TEXT USING player1_id::text;
    EXCEPTION WHEN others THEN NULL;
    END;
    BEGIN
        ALTER TABLE public.games ALTER COLUMN player1_id DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
    BEGIN
        ALTER TABLE public.games ALTER COLUMN player1_name TYPE TEXT;
    EXCEPTION WHEN others THEN NULL;
    END;
    BEGIN
        ALTER TABLE public.games ALTER COLUMN player1_name DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
END $$;

-- ──────────────────────────────────────────
-- 4. Ensure indexes exist for scale
-- ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_games_status ON public.games(status) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_games_player_count ON public.games(player_count) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_games_room_code ON public.games(room_code);
CREATE INDEX IF NOT EXISTS idx_games_updated_at ON public.games(updated_at DESC);

-- ──────────────────────────────────────────
-- 5. CREATE ATOMIC MATCHMAKING RPC
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION join_random_game(
    p_player_id TEXT,
    p_player_name TEXT,
    p_room_code VARCHAR(6),
    p_player1_id TEXT
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE 
    v_game RECORD;
    v_is_start BOOLEAN := FALSE;
BEGIN
    -- Search for an active waiting matchmaking game (not private)
    -- where the creator is not the current player (NULL-safe IS DISTINCT FROM)
    -- FOR UPDATE SKIP LOCKED prevents race conditions atomically
    SELECT * INTO v_game FROM public.games
    WHERE status = 'waiting' 
      AND is_private = false 
      AND player_count < max_players
      AND player1_id IS DISTINCT FROM p_player1_id
    FOR UPDATE SKIP LOCKED LIMIT 1;

    IF FOUND THEN
        -- Atomic join: append player, bump count
        UPDATE public.games SET
            joined_players = joined_players || jsonb_build_object('id', p_player_id, 'name', p_player_name),
            player_count = player_count + 1,
            updated_at = now()
        WHERE id = v_game.id RETURNING * INTO v_game;
        
        v_is_start := TRUE;
    ELSE
        -- No game found: create a new 1v1 matchmaking waiting room
        INSERT INTO public.games (
            room_code, 
            status, 
            joined_players, 
            player_count, 
            max_players, 
            is_private, 
            player1_id, 
            player1_name
        )
        VALUES (
            upper(p_room_code), 
            'waiting', 
            jsonb_build_array(jsonb_build_object('id', p_player_id, 'name', p_player_name)), 
            1, 
            2,     -- matchmaking is always 1v1
            false, 
            p_player1_id,
            p_player_name
        )
        RETURNING * INTO v_game;
    END IF;

    RETURN jsonb_build_object('game', row_to_json(v_game)::jsonb, 'is_start', v_is_start);
END;
$$;

-- Force API schema reload so all new columns & functions are immediately available
NOTIFY pgrst, 'reload schema';
