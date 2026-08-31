-- ============================================================
-- Migration v10: Push Tokens for OneSignal
-- Paste the ENTIRE file into Supabase SQL Editor and click Run
-- ============================================================

-- 1. Push tokens table
CREATE TABLE IF NOT EXISTS public.push_tokens (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  onesignal_player_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Enable RLS
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

-- 3. Users manage their own token
CREATE POLICY "users can manage own push token"
  ON public.push_tokens FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 4. Service role can read all tokens (for admin notification sends)
CREATE POLICY "service role can read all push tokens"
  ON public.push_tokens FOR SELECT
  USING (auth.role() = 'service_role');

-- ============================================================
-- 5. RPC: send_game_request_notification
-- Written as LANGUAGE sql (single expression, no semicolons inside $$)
-- to avoid Supabase editor splitting the function body.
-- ============================================================
CREATE OR REPLACE FUNCTION public.send_game_request_notification(
  p_target_user_id UUID,
  p_from_user_id UUID,
  p_from_username TEXT,
  p_from_avatar_url TEXT,
  p_game_mode TEXT,
  p_request_id TEXT
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE((
    SELECT net.http_post(
      url := 'https://onesignal.com/api/v1/notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Basic ' || current_setting('app.onesignal_rest_api_key', true)
      ),
      body := jsonb_build_object(
        'app_id', '3bba4559-2eaf-4eb1-a9a2-3978bdd444af',
        'include_subscription_ids', jsonb_build_array(pt.onesignal_player_id),
        'headings', jsonb_build_object('en', p_from_username || ' challenged you!'),
        'contents', jsonb_build_object('en', 'Accept the challenge to play ' || p_game_mode || '?'),
        'data', jsonb_build_object(
          'type', 'game_request',
          'from_user_id', p_from_user_id,
          'from_username', p_from_username,
          'from_avatar_url', COALESCE(p_from_avatar_url, ''),
          'game_mode', p_game_mode,
          'request_id', p_request_id
        ),
        'priority', 10
      )::TEXT
    ) > 0
    FROM public.push_tokens pt
    WHERE pt.user_id = p_target_user_id
  ), FALSE)
$$;

-- ============================================================
-- 6. RPC: send_game_response_notification
-- ============================================================
CREATE OR REPLACE FUNCTION public.send_game_response_notification(
  p_target_user_id UUID,
  p_from_user_id UUID,
  p_from_username TEXT,
  p_request_id TEXT,
  p_accepted BOOLEAN
) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE((
    SELECT net.http_post(
      url := 'https://onesignal.com/api/v1/notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Basic ' || current_setting('app.onesignal_rest_api_key', true)
      ),
      body := jsonb_build_object(
        'app_id', '3bba4559-2eaf-4eb1-a9a2-3978bdd444af',
        'include_subscription_ids', jsonb_build_array(pt.onesignal_player_id),
        'headings', jsonb_build_object('en',
          CASE WHEN p_accepted
            THEN p_from_username || ' accepted your challenge!'
            ELSE p_from_username || ' declined your challenge'
          END
        ),
        'contents', jsonb_build_object('en',
          CASE WHEN p_accepted
            THEN 'Your challenge was accepted. Time to play!'
            ELSE 'Your challenge was declined.'
          END
        ),
        'data', jsonb_build_object(
          'type', CASE WHEN p_accepted THEN 'game_request_accepted' ELSE 'game_request_declined' END,
          'from_user_id', p_from_user_id,
          'from_username', p_from_username,
          'request_id', p_request_id
        ),
        'priority', 10
      )::TEXT
    ) > 0
    FROM public.push_tokens pt
    WHERE pt.user_id = p_target_user_id
  ), FALSE)
$$;
