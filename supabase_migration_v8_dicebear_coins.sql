-- ============================================================
-- GHURT CardFlow — Supabase Migration v8 (Welcome Coins & Match Stakes)
-- PASTE THIS ENTIRE SCRIPT INTO YOUR SUPABASE SQL EDITOR AND RUN IT.
-- ============================================================

-- 1. Update default balance to 1500.00 KES/Coins
ALTER TABLE public.users ALTER COLUMN balance SET DEFAULT 1500.00;

-- Use a DiceBear identifier for all new profiles. Existing numeric avatar IDs
-- are retained as deterministic DiceBear seeds so no player loses their identity.
ALTER TABLE public.users ALTER COLUMN avatar_id SET DEFAULT 'bottts:player';
UPDATE public.users
SET avatar_id = 'bottts:legacy-' || avatar_id
WHERE avatar_id ~ '^[0-9]+$';

-- 2. Update existing users with less than 1500 balance
UPDATE public.users 
SET balance = 1500.00 
WHERE balance < 1500.00 OR balance IS NULL;

-- 3. Update handle_new_user trigger to award 1500 starting balance
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.users (id, email, display_name, username, balance)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'username', 'Player'),
        COALESCE(NEW.raw_user_meta_data->>'username', 'player_' || substring(NEW.id::text from 1 for 8)),
        1500.00
    )
    ON CONFLICT (id) DO UPDATE SET
        balance = GREATEST(public.users.balance, 1500.00);
    RETURN NEW;
END;
$$;

-- 4. Atomic RPC to settle casual matches (+100 for winner, -50 for loser)
CREATE OR REPLACE FUNCTION public.settle_casual_game(p_winner_id UUID, p_loser_ids UUID[])
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_loser_id UUID;
BEGIN
    -- Award winner +100 coins
    IF p_winner_id IS NOT NULL THEN
        UPDATE public.users 
        SET balance = balance + 100.00, updated_at = NOW() 
        WHERE id = p_winner_id;
    END IF;

    -- Deduct 50 coins from each loser
    IF p_loser_ids IS NOT NULL THEN
        FOREACH v_loser_id IN ARRAY p_loser_ids LOOP
            IF v_loser_id IS NOT NULL THEN
                UPDATE public.users 
                SET balance = GREATEST(0.00, balance - 50.00), updated_at = NOW() 
                WHERE id = v_loser_id;
            END IF;
        END LOOP;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;

NOTIFY pgrst, 'reload schema';
