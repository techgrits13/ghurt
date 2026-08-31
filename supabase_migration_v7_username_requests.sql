-- ============================================================
-- GHURT CardFlow — Supabase Migration v7 (Username & Game Requests)
-- PASTE THIS ENTIRE SCRIPT INTO YOUR SUPABASE SQL EDITOR AND RUN IT.
-- ============================================================

-- ──────────────────────────────────────────
-- 1. ADD USERNAME & ONLINE COLUMNS TO USERS
-- ──────────────────────────────────────────

-- Add username column if it doesn't exist
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT;

-- Make username column unique
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_username_key;
ALTER TABLE public.users ADD CONSTRAINT users_username_key UNIQUE (username);

-- Add online status columns if they don't exist
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill usernames for existing users who do not have one
UPDATE public.users 
SET username = COALESCE(username, 'player_' || substring(id::text from 1 for 8))
WHERE username IS NULL;

-- ──────────────────────────────────────────
-- 2. UPDATE TRIGGER FUNCTION FOR NEW USERS
-- ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.users (id, email, display_name, username)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'username', 'Player'),
        COALESCE(NEW.raw_user_meta_data->>'username', 'player_' || substring(NEW.id::text from 1 for 8))
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- ──────────────────────────────────────────
-- 3. CREATE GAME REQUESTS TABLE
-- ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.game_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    sender_name TEXT NOT NULL,
    receiver_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, accepted, declined
    room_code VARCHAR(6) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS on game_requests
ALTER TABLE public.game_requests ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────
-- 4. ROW LEVEL SECURITY (RLS) POLICIES
-- ──────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view own game requests" ON public.game_requests;
CREATE POLICY "Users can view own game requests" ON public.game_requests
    FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

DROP POLICY IF EXISTS "Users can insert own game requests" ON public.game_requests;
CREATE POLICY "Users can insert own game requests" ON public.game_requests
    FOR INSERT WITH CHECK (auth.uid() = sender_id);

DROP POLICY IF EXISTS "Users can update own game requests" ON public.game_requests;
CREATE POLICY "Users can update own game requests" ON public.game_requests
    FOR UPDATE USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

DROP POLICY IF EXISTS "Users can delete own game requests" ON public.game_requests;
CREATE POLICY "Users can delete own game requests" ON public.game_requests
    FOR DELETE USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- ──────────────────────────────────────────
-- 5. ENABLE REALTIME ON USERS & GAME REQUESTS
-- ──────────────────────────────────────────

-- Safely add users to realtime
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;

-- Safely add game_requests to realtime
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.game_requests;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;

NOTIFY pgrst, 'reload schema';
