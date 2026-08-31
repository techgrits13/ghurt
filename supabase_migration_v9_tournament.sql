-- ============================================================
-- GHURT CardFlow — Supabase Migration v9 (Tournaments & Admin Toggle)
-- PASTE THIS ENTIRE SCRIPT INTO YOUR SUPABASE SQL EDITOR AND RUN IT.
-- Safe to re-run (idempotent).
--
-- Each function is written on a single line to prevent the editor
-- client from splitting or truncating the statement on inner newlines.
-- ============================================================

-- 1. Tournament settings table
CREATE TABLE IF NOT EXISTS public.tournament_settings (id INT PRIMARY KEY DEFAULT 1, is_open BOOLEAN NOT NULL DEFAULT false, key_price NUMERIC(12,2) NOT NULL DEFAULT 50.00, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

INSERT INTO public.tournament_settings (id, is_open, key_price) VALUES (1, false, 50.00) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.tournament_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ts_public_read" ON public.tournament_settings;
CREATE POLICY "ts_public_read" ON public.tournament_settings FOR SELECT USING (true);

-- 2. Extra columns on users table
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tournament_keys INT NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tournament_points INT NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- 3. get_tournament_dashboard()
CREATE OR REPLACE FUNCTION public.get_tournament_dashboard() RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$ SELECT jsonb_build_object('is_open', COALESCE((SELECT is_open FROM public.tournament_settings WHERE id = 1), false), 'key_count', COALESCE((SELECT tournament_keys FROM public.users WHERE id = auth.uid()), 0), 'points', COALESCE((SELECT tournament_points FROM public.users WHERE id = auth.uid()), 0), 'is_admin', COALESCE((SELECT is_admin FROM public.users WHERE id = auth.uid()), false), 'leaderboard', COALESCE((SELECT jsonb_agg(row_to_json(lb)) FROM (SELECT id, display_name, username, tournament_points AS points, avatar_id FROM public.users ORDER BY tournament_points DESC, updated_at DESC LIMIT 10) lb), '[]'::jsonb)) $$;

-- 4. buy_tournament_key()
CREATE OR REPLACE FUNCTION public.buy_tournament_key() RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$ WITH updated AS (UPDATE public.users SET balance = balance - (SELECT COALESCE(key_price, 50.00) FROM public.tournament_settings WHERE id = 1), tournament_keys = tournament_keys + 1, updated_at = NOW() WHERE id = auth.uid() AND balance >= (SELECT COALESCE(key_price, 50.00) FROM public.tournament_settings WHERE id = 1) RETURNING id) SELECT jsonb_build_object('success', EXISTS (SELECT 1 FROM updated)) $$;

-- 5. enter_tournament()
CREATE OR REPLACE FUNCTION public.enter_tournament() RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$ WITH updated AS (UPDATE public.users SET tournament_keys = tournament_keys - 1, tournament_points = tournament_points + 10, updated_at = NOW() WHERE id = auth.uid() AND tournament_keys >= 1 AND COALESCE((SELECT is_open FROM public.tournament_settings WHERE id = 1), false) = true RETURNING id) SELECT jsonb_build_object('success', EXISTS (SELECT 1 FROM updated)) $$;

-- 6. set_tournament_open(p_is_open)
CREATE OR REPLACE FUNCTION public.set_tournament_open(p_is_open BOOLEAN) RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$ WITH updated AS (UPDATE public.tournament_settings SET is_open = p_is_open, updated_at = NOW() WHERE id = 1 AND COALESCE((SELECT is_admin FROM public.users WHERE id = auth.uid()), false) = true RETURNING is_open) SELECT jsonb_build_object('success', EXISTS (SELECT 1 FROM updated), 'is_open', p_is_open) $$;

-- Force API schema reload
NOTIFY pgrst, 'reload schema';
