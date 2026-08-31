-- A player who leaves an unfinished casual match forfeits 100 coins. The
-- eventual winner still receives the full original-table reward (100 per
-- opponent), even if other players left before the finish.
CREATE OR REPLACE FUNCTION public.forfeit_casual_game(p_user_id UUID, p_game_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE public.users
  SET balance = GREATEST(0, COALESCE(balance, 0) - 100)
  WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.forfeit_casual_game(UUID, UUID) TO authenticated;
