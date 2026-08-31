-- Anonymous, device-level install/DAU telemetry. Device IDs are generated on
-- the handset and are not linked here to names, emails, or game history.
CREATE TABLE IF NOT EXISTS public.device_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id VARCHAR(255) NOT NULL UNIQUE,
  device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_installations_last_seen
  ON public.device_installations(last_seen DESC);

CREATE OR REPLACE FUNCTION public.record_device_install(
  p_device_id VARCHAR,
  p_device_info JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_device_id IS NULL OR length(p_device_id) < 8 THEN
    RAISE EXCEPTION 'Invalid device id';
  END IF;
  INSERT INTO public.device_installations(device_id, device_info)
  VALUES (p_device_id, COALESCE(p_device_info, '{}'::jsonb))
  ON CONFLICT (device_id) DO UPDATE
    SET last_seen = now(), device_info = EXCLUDED.device_info;
END;
$$;

REVOKE ALL ON TABLE public.device_installations FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_device_install(VARCHAR, JSONB) TO anon, authenticated;
