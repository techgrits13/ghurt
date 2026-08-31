-- ============================================================
-- GHURT CardFlow — Supabase Migration v4 (Staking Platform)
-- PASTE THIS ENTIRE SCRIPT INTO YOUR SUPABASE SQL EDITOR AND RUN IT.
-- ============================================================

-- ──────────────────────────────────────────
-- 1. STAKED GAMES TABLE
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staked_games (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code VARCHAR(6) UNIQUE NOT NULL,
    stake_amount NUMERIC(12, 2) NOT NULL,
    pot NUMERIC(12, 2) NOT NULL,
    fee NUMERIC(12, 2) NOT NULL,
    player1_id UUID NOT NULL REFERENCES public.users(id),
    player1_name TEXT NOT NULL,
    player2_id UUID REFERENCES public.users(id),
    player2_name TEXT,
    status TEXT NOT NULL DEFAULT 'waiting', -- waiting, playing, finished, cancelled
    winner_id UUID REFERENCES public.users(id),
    game_state JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS for staked_games
ALTER TABLE public.staked_games ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read staked_games" ON public.staked_games;
CREATE POLICY "Allow public read staked_games" ON public.staked_games FOR SELECT USING (true);
-- Normal users can't directly insert/update; must use RPCs.

-- ──────────────────────────────────────────
-- 2. WITHDRAWAL REQUESTS TABLE
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    amount NUMERIC(12, 2) NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processed, failed
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS for withdrawal_requests
ALTER TABLE public.withdrawal_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own withdrawals" ON public.withdrawal_requests;
CREATE POLICY "Users can read own withdrawals" ON public.withdrawal_requests FOR SELECT USING (auth.uid() = user_id);

-- ──────────────────────────────────────────
-- 3. FEE CALCULATOR FUNCTION
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_fee(p_pot NUMERIC) RETURNS NUMERIC AS $$
BEGIN
    IF p_pot < 100 THEN RETURN 5; END IF;
    IF p_pot < 200 THEN RETURN 10; END IF;
    IF p_pot < 300 THEN RETURN 15; END IF;
    IF p_pot < 500 THEN RETURN 20; END IF;
    IF p_pot < 1000 THEN RETURN 35; END IF;
    IF p_pot < 2000 THEN RETURN 60; END IF;
    RETURN 100;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ──────────────────────────────────────────
-- 4. RPC: request_withdrawal (SECURITY DEFINER)
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION request_withdrawal(p_amount NUMERIC, p_phone TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user public.users%ROWTYPE;
    v_request public.withdrawal_requests%ROWTYPE;
BEGIN
    IF p_amount < 10 THEN RAISE EXCEPTION 'Minimum withdrawal is 10 KES'; END IF;
    
    SELECT * INTO v_user FROM public.users WHERE id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
    IF v_user.balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;

    -- Deduct balance
    UPDATE public.users SET balance = balance - p_amount WHERE id = auth.uid();
    
    -- Insert request
    INSERT INTO public.withdrawal_requests (user_id, amount, phone)
    VALUES (auth.uid(), p_amount, p_phone) RETURNING * INTO v_request;

    RETURN row_to_json(v_request)::jsonb;
END;
$$;

-- ──────────────────────────────────────────
-- 5. RPC: join_staked_lobby (SECURITY DEFINER)
-- Deducts stake upon joining/creating
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION join_staked_lobby(p_stake_amount NUMERIC, p_player_name TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_user public.users%ROWTYPE;
    v_game public.staked_games%ROWTYPE;
    v_pot NUMERIC;
    v_fee NUMERIC;
    v_code VARCHAR(6);
BEGIN
    -- Validate user & balance
    SELECT * INTO v_user FROM public.users WHERE id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
    IF v_user.balance < p_stake_amount THEN RAISE EXCEPTION 'Insufficient balance to stake % KES', p_stake_amount; END IF;
    
    -- Try to find waiting game with exact stake
    SELECT * INTO v_game FROM public.staked_games
    WHERE status = 'waiting' AND stake_amount = p_stake_amount AND player1_id != auth.uid()
    FOR UPDATE SKIP LOCKED LIMIT 1;
    
    IF FOUND THEN
        -- Deduct from P2
        UPDATE public.users SET balance = balance - p_stake_amount WHERE id = auth.uid();
        
        -- Join and start game
        v_pot := p_stake_amount * 2;
        v_fee := calculate_fee(v_pot);
        
        UPDATE public.staked_games SET
            player2_id = auth.uid(),
            player2_name = p_player_name,
            status = 'playing',
            pot = v_pot,
            fee = v_fee,
            updated_at = NOW()
        WHERE id = v_game.id RETURNING * INTO v_game;
    ELSE
        -- Deduct from P1
        UPDATE public.users SET balance = balance - p_stake_amount WHERE id = auth.uid();
        
        -- Create new waiting game
        v_code := upper(substring(md5(random()::text) from 1 for 6));
        INSERT INTO public.staked_games (room_code, stake_amount, pot, fee, player1_id, player1_name, status)
        VALUES (v_code, p_stake_amount, p_stake_amount * 2, calculate_fee(p_stake_amount * 2), auth.uid(), p_player_name, 'waiting')
        RETURNING * INTO v_game;
    END IF;
    
    RETURN row_to_json(v_game)::jsonb;
END;
$$;

-- ──────────────────────────────────────────
-- 6. RPC: cancel_waiting_staked_game (SECURITY DEFINER)
-- Refunds stake if player cancels before someone joins
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION cancel_waiting_staked_game(p_game_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_game public.staked_games%ROWTYPE;
BEGIN
    SELECT * INTO v_game FROM public.staked_games WHERE id = p_game_id AND status = 'waiting' AND player1_id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Game not found or not in waiting state'; END IF;
    
    -- Refund
    UPDATE public.users SET balance = balance + v_game.stake_amount WHERE id = auth.uid();
    
    -- Cancel
    UPDATE public.staked_games SET status = 'cancelled', updated_at = NOW() WHERE id = p_game_id;
    
    RETURN TRUE;
END;
$$;

-- ──────────────────────────────────────────
-- 7. RPC: forfeit_staked_game (SECURITY DEFINER)
-- Penalizes abandoner (-5 KES from actual balance, plus stake lost), awards pot to other player
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION forfeit_staked_game(p_game_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_game public.staked_games%ROWTYPE;
    v_winner_id UUID;
    v_payout NUMERIC;
BEGIN
    SELECT * INTO v_game FROM public.staked_games WHERE id = p_game_id AND status = 'playing' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active game not found'; END IF;
    
    -- Determine winner (the one who didn't call forfeit)
    IF auth.uid() = v_game.player1_id THEN
        v_winner_id := v_game.player2_id;
    ELSIF auth.uid() = v_game.player2_id THEN
        v_winner_id := v_game.player1_id;
    ELSE
        RAISE EXCEPTION 'Not a player in this game';
    END IF;
    
    v_payout := v_game.pot - v_game.fee;
    
    -- Award winner
    UPDATE public.users SET balance = balance + v_payout WHERE id = v_winner_id;
    
    -- Penalize abandoner (auth.uid()) 5 KES penalty
    UPDATE public.users SET balance = balance - 5 WHERE id = auth.uid();
    
    -- End game
    UPDATE public.staked_games SET status = 'finished', winner_id = v_winner_id, updated_at = NOW()
    WHERE id = p_game_id RETURNING * INTO v_game;
    
    RETURN row_to_json(v_game)::jsonb;
END;
$$;

-- ──────────────────────────────────────────
-- 8. RPC: settle_staked_game (SECURITY DEFINER)
-- ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION settle_staked_game(p_game_id UUID, p_winner_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_game public.staked_games%ROWTYPE;
    v_payout NUMERIC;
BEGIN
    SELECT * INTO v_game FROM public.staked_games WHERE id = p_game_id AND status = 'playing' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active game not found'; END IF;
    
    -- Verify the caller is one of the players
    IF auth.uid() != v_game.player1_id AND auth.uid() != v_game.player2_id THEN
        RAISE EXCEPTION 'Not a player in this game';
    END IF;
    
    -- Validate winner
    IF p_winner_id != v_game.player1_id AND p_winner_id != v_game.player2_id THEN
        RAISE EXCEPTION 'Invalid winner';
    END IF;

    v_payout := v_game.pot - v_game.fee;
    
    -- Payout
    UPDATE public.users SET balance = balance + v_payout WHERE id = p_winner_id;
    
    -- End game
    UPDATE public.staked_games SET status = 'finished', winner_id = p_winner_id, updated_at = NOW()
    WHERE id = p_game_id RETURNING * INTO v_game;
    
    RETURN row_to_json(v_game)::jsonb;
END;
$$;

NOTIFY pgrst, 'reload schema';
