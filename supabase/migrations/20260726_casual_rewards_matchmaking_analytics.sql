-- Casual rewards: winner receives 100 coins for each opponent.
CREATE OR REPLACE FUNCTION public.settle_casual_game(
  p_winner_id UUID,
  p_loser_ids UUID[],
  p_reward_amount INTEGER DEFAULT 100
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_winner_id IS NOT NULL THEN
    UPDATE public.users SET balance = COALESCE(balance, 0) + GREATEST(100, LEAST(300, p_reward_amount))
    WHERE id = p_winner_id;
  END IF;
  RETURN jsonb_build_object('reward', GREATEST(100, LEAST(300, p_reward_amount)));
END;
$$;

-- Random rooms can collect up to four humans during the short client-side
-- fill window. The client starts with 2 or 3 humans when the window ends.
CREATE OR REPLACE FUNCTION public.join_random_game(
  p_player_id TEXT, p_player_name TEXT, p_room_code VARCHAR(6), p_player1_id TEXT
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_game RECORD;
BEGIN
  SELECT * INTO v_game FROM public.games
  WHERE status = 'waiting' AND is_private = false AND player_count < 4
    AND player1_id IS DISTINCT FROM p_player1_id
  ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1;
  IF FOUND THEN
    UPDATE public.games SET joined_players = joined_players || jsonb_build_object('id', p_player_id, 'name', p_player_name),
      player_count = player_count + 1, max_players = 4, updated_at = now()
    WHERE id = v_game.id RETURNING * INTO v_game;
  ELSE
    INSERT INTO public.games (room_code, status, joined_players, player_count, max_players, is_private, player1_id, player1_name)
    VALUES (upper(p_room_code), 'waiting', jsonb_build_array(jsonb_build_object('id', p_player_id, 'name', p_player_name)), 1, 4, false, p_player1_id, p_player_name)
    RETURNING * INTO v_game;
  END IF;
  RETURN jsonb_build_object('game', row_to_json(v_game)::jsonb, 'is_start', false);
END;
$$;

CREATE INDEX IF NOT EXISTS idx_user_devices_first_seen ON public.user_devices(first_seen);
CREATE INDEX IF NOT EXISTS idx_user_devices_last_seen ON public.user_devices(last_seen);
