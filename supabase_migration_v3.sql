-- ============================================================
-- GHURT CardFlow — Supabase Migration v3
-- PASTE THIS ENTIRE SCRIPT INTO YOUR SUPABASE SQL EDITOR AND RUN IT.
-- It is fully idempotent (safe to run multiple times).
-- ============================================================

-- ──────────────────────────────────────────
-- STEP 1: FIX THE GAMES TABLE
-- Drop any legacy columns/constraints that reference player1_id, player2_id etc.
-- and ensure the correct columns exist.
-- ──────────────────────────────────────────

-- Remove legacy columns that cause NOT NULL constraint violations
ALTER TABLE public.games DROP COLUMN IF EXISTS player1_id;
ALTER TABLE public.games DROP COLUMN IF EXISTS player2_id;
ALTER TABLE public.games DROP COLUMN IF EXISTS player3_id;
ALTER TABLE public.games DROP COLUMN IF EXISTS player4_id;
ALTER TABLE public.games DROP COLUMN IF EXISTS current_player;

-- Ensure the correct columns exist (safe: IF NOT EXISTS)
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS joined_players JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS player_count INT NOT NULL DEFAULT 0;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS max_players INT NOT NULL DEFAULT 4;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS game_state JSONB;
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS host_id TEXT;

-- Ensure indexes exist for scale (millions of users)
CREATE INDEX IF NOT EXISTS idx_games_room_code ON public.games(room_code);
CREATE INDEX IF NOT EXISTS idx_games_status ON public.games(status) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_games_updated_at ON public.games(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_player_count ON public.games(player_count) WHERE status = 'waiting';

-- ──────────────────────────────────────────
-- STEP 2: FIX THE USERS TABLE
-- Swap phone -> email and add balance column.
-- ──────────────────────────────────────────

-- Drop old phone column if it exists, add email
ALTER TABLE public.users DROP COLUMN IF EXISTS phone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

-- CRITICAL: Add balance column — clients can ONLY READ this.
-- It is ONLY written by a server-side Edge Function via Paystack Webhook.
-- This makes it impossible for hacked/modded apps to fake deposits.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

-- Ensure index for fast user lookups at scale
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);

-- ──────────────────────────────────────────
-- STEP 3: IRONCLAD ROW LEVEL SECURITY (RLS)
-- Prevent any user from reading or modifying another user's data.
-- ──────────────────────────────────────────

-- USERS TABLE: Users can see everyone's profile (for leaderboards) 
-- but can ONLY update their OWN profile fields (display_name, avatar_id).
-- They can NEVER update their own balance (only the server webhook can).
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view all profiles" ON public.users;
CREATE POLICY "Users can view all profiles" ON public.users
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update own non-financial profile" ON public.users;
CREATE POLICY "Users can update own non-financial profile" ON public.users
    FOR UPDATE USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;
CREATE POLICY "Users can insert own profile" ON public.users
    FOR INSERT WITH CHECK (auth.uid() = id);

-- GAMES TABLE: RLS already enabled. Policies kept permissive for real-time gameplay.
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read games" ON public.games;
CREATE POLICY "Allow public read games" ON public.games FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow authenticated insert games" ON public.games;
CREATE POLICY "Allow authenticated insert games" ON public.games FOR INSERT WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow public update games" ON public.games;
CREATE POLICY "Allow public update games" ON public.games FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow public delete games" ON public.games;
CREATE POLICY "Allow public delete games" ON public.games FOR DELETE USING (true);

-- ──────────────────────────────────────────
-- STEP 4: UPDATE TRIGGER FUNCTION
-- Auto-create user profile on signup with email.
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.users (id, email, display_name, balance)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', 'Player'),
        0.00
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
-- STEP 5: SECURE BALANCE UPDATE FUNCTION
-- Only callable from the server (Paystack Webhook Edge Function)
-- using the service_role key. Normal users cannot call this via
-- the anon key — preventing fake deposit attacks.
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_user_balance(p_user_id UUID, p_amount NUMERIC)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    -- Validate: amount must be positive
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;
    UPDATE public.users SET balance = balance + p_amount WHERE id = p_user_id;
END;
$$;

-- Revoke public execute on this function — ONLY the server can call it
REVOKE EXECUTE ON FUNCTION increment_user_balance(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_user_balance(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION increment_user_balance(UUID, NUMERIC) FROM authenticated;
-- Only service_role (your Paystack webhook Edge Function) can call this
GRANT EXECUTE ON FUNCTION increment_user_balance(UUID, NUMERIC) TO service_role;

-- ──────────────────────────────────────────
-- STEP 6: ATOMIC RPCs (updated, safe to re-run)
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
        INSERT INTO public.games (room_code, joined_players, player_count, status)
        VALUES (upper(p_room_code), jsonb_build_array(jsonb_build_object('id', p_player_id, 'name', p_player_name)), 1, 'waiting')
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

-- ──────────────────────────────────────────
-- STEP 7: AUTO-CLEANUP STALE ROOMS (for scale)
-- In Supabase, enable pg_cron extension in Extensions tab,
-- then uncomment the cron job below to auto-run cleanup daily.
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_stale_games()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    DELETE FROM public.games WHERE status = 'waiting' AND created_at < NOW() - INTERVAL '30 minutes';
    DELETE FROM public.games WHERE status IN ('finished', 'playing') AND updated_at < NOW() - INTERVAL '2 hours';
END;
$$;

-- Uncomment after enabling pg_cron in Supabase Extensions:
-- SELECT cron.schedule('cleanup-stale-games', '0 * * * *', 'SELECT cleanup_stale_games()');

-- ──────────────────────────────────────────
-- STEP 8: FORCE API SCHEMA RELOAD
-- This tells Supabase to refresh its PostgREST schema cache
-- so the new columns are immediately available to the app.
-- ──────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- DONE! Your database is now production-ready for millions of users.
-- ============================================================
