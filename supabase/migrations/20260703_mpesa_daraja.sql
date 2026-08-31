-- Switch deposit tracking from IntaSend naming to Safaricom Daraja metadata.
-- Existing rows keep using invoice_id; for Daraja it stores CheckoutRequestID.

ALTER TABLE public.deposit_transactions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'mpesa_daraja',
  ADD COLUMN IF NOT EXISTS checkout_request_id TEXT,
  ADD COLUMN IF NOT EXISTS merchant_request_id TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_receipt_number TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_result_code INTEGER,
  ADD COLUMN IF NOT EXISTS mpesa_result_desc TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_tx_checkout_request
  ON public.deposit_transactions(checkout_request_id)
  WHERE checkout_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deposit_tx_provider
  ON public.deposit_transactions(provider);

ALTER TABLE public.withdrawal_transactions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'mpesa_daraja',
  ADD COLUMN IF NOT EXISTS provider_ref TEXT;

UPDATE public.withdrawal_transactions
SET provider_ref = COALESCE(provider_ref, intasend_ref)
WHERE provider_ref IS NULL
  AND intasend_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_withdrawal_tx_provider
  ON public.withdrawal_transactions(provider);

CREATE OR REPLACE FUNCTION public.complete_mpesa_deposit(
  p_checkout_request_id TEXT,
  p_amount NUMERIC,
  p_mpesa_receipt_number TEXT DEFAULT NULL,
  p_merchant_request_id TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_dep public.deposit_transactions%ROWTYPE;
  v_wid UUID;
  v_newbal NUMERIC;
BEGIN
  IF p_checkout_request_id IS NULL OR trim(p_checkout_request_id) = '' THEN
    RAISE EXCEPTION 'Missing checkout_request_id';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 1500 THEN
    RAISE EXCEPTION 'Invalid deposit amount: %', p_amount;
  END IF;

  SELECT * INTO v_dep
  FROM public.deposit_transactions
  WHERE invoice_id = p_checkout_request_id
     OR checkout_request_id = p_checkout_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown invoice: %', p_checkout_request_id;
  END IF;

  IF v_dep.status = 'COMPLETE' THEN
    RETURN FALSE;
  END IF;

  IF ABS(v_dep.amount - p_amount) > 0.50 THEN
    RAISE EXCEPTION 'Amount mismatch: expected %, got %', v_dep.amount, p_amount;
  END IF;

  UPDATE public.deposit_transactions
  SET status = 'COMPLETE',
      provider = 'mpesa_daraja',
      checkout_request_id = COALESCE(checkout_request_id, p_checkout_request_id),
      merchant_request_id = COALESCE(p_merchant_request_id, merchant_request_id),
      mpesa_receipt_number = COALESCE(p_mpesa_receipt_number, mpesa_receipt_number),
      mpesa_result_code = 0,
      mpesa_result_desc = 'The service request is processed successfully.',
      phone = COALESCE(p_phone, phone),
      updated_at = NOW()
  WHERE id = v_dep.id;

  v_wid := public.ghurt_wallet(v_dep.user_id);

  UPDATE public.wallets
  SET available_balance = available_balance + p_amount,
      updated_at = NOW()
  WHERE id = v_wid
  RETURNING available_balance INTO v_newbal;

  BEGIN
    UPDATE public.users
    SET balance = COALESCE(balance, 0) + p_amount
    WHERE id = v_dep.user_id;
  EXCEPTION WHEN OTHERS THEN NULL; END;

  PERFORM public.ghurt_ledger(
    v_dep.user_id,
    v_wid,
    'deposit',
    p_amount,
    v_newbal,
    NULL,
    jsonb_build_object(
      'checkout_request_id', p_checkout_request_id,
      'merchant_request_id', p_merchant_request_id,
      'mpesa_receipt_number', p_mpesa_receipt_number,
      'source', 'mpesa_daraja'
    ),
    NULL,
    'completed'
  );

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_mpesa_deposit(TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_mpesa_deposit(TEXT, NUMERIC, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
