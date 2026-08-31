-- Casual-game scaling foundations.
-- Run this migration before increasing matchmaking traffic. It keeps the
-- `FOR UPDATE SKIP LOCKED` lookup narrow as the games table grows.

CREATE INDEX IF NOT EXISTS idx_games_waiting_matchmaking
  ON public.games (player_count, updated_at ASC)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_games_playing_updated
  ON public.games (updated_at ASC)
  WHERE status = 'playing';

CREATE INDEX IF NOT EXISTS idx_users_online_last_seen
  ON public.users (last_seen_at DESC)
  WHERE is_online = true;

-- Expire abandoned waiting rooms instead of allowing them to grow without
-- bound. Call this from a scheduled server-side job, not from the client.
CREATE OR REPLACE FUNCTION public.expire_abandoned_casual_rooms(
  p_idle_minutes integer DEFAULT 10
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.games
  WHERE status = 'waiting'
    AND updated_at < now() - make_interval(mins => GREATEST(p_idle_minutes, 1));

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_abandoned_casual_rooms(integer) FROM PUBLIC;
