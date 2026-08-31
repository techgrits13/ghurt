// supabase/functions/mpesa-callback/index.ts
// Receives Daraja STK callback events and credits user balances on successful payment.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getCallbackItem(items: unknown, name: string): unknown {
  if (!Array.isArray(items)) return null;
  const match = items.find((item) => {
    return typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>).Name === name;
  });
  return typeof match === 'object' && match !== null
    ? (match as Record<string, unknown>).Value
    : null;
}

serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error('mpesa-callback misconfigured: missing Supabase env vars');
      return jsonResponse({ error: 'Service unavailable' }, 503);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ error: 'Bad Request' }, 400);
    }

    const stkCallback = ((payload.Body as Record<string, unknown> | undefined)
      ?.stkCallback ?? payload.stkCallback ?? payload) as Record<string, unknown>;
    const checkoutRequestId = String(stkCallback.CheckoutRequestID ?? '');
    const merchantRequestId = String(stkCallback.MerchantRequestID ?? '');
    const resultCode = Number(stkCallback.ResultCode);
    const resultDesc = String(stkCallback.ResultDesc ?? '');

    if (!checkoutRequestId) {
      console.warn('M-Pesa callback missing CheckoutRequestID:', JSON.stringify(payload));
      return jsonResponse({ received: true, warn: 'Missing CheckoutRequestID' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (resultCode !== 0) {
      await supabase
        .from('deposit_transactions')
        .update({
          status: 'FAILED',
          provider: 'mpesa_daraja',
          merchant_request_id: merchantRequestId || null,
          mpesa_result_code: resultCode,
          mpesa_result_desc: resultDesc,
          updated_at: new Date().toISOString(),
        })
        .eq('invoice_id', checkoutRequestId);

      console.log(`M-Pesa deposit ${checkoutRequestId} failed: ${resultCode} ${resultDesc}`);
      return jsonResponse({ received: true });
    }

    const metadata = (stkCallback.CallbackMetadata as Record<string, unknown> | undefined)?.Item;
    const amount = Number(getCallbackItem(metadata, 'Amount'));
    const mpesaReceiptNumber = String(getCallbackItem(metadata, 'MpesaReceiptNumber') ?? '');
    const phoneNumber = String(getCallbackItem(metadata, 'PhoneNumber') ?? '');

    if (!Number.isFinite(amount) || amount <= 0) {
      console.warn(`M-Pesa callback ${checkoutRequestId} missing valid amount`);
      return jsonResponse({ received: true, warn: 'Missing amount' });
    }

    const { data: completed, error: rpcError } = await supabase.rpc('complete_mpesa_deposit', {
      p_checkout_request_id: checkoutRequestId,
      p_amount: amount,
      p_mpesa_receipt_number: mpesaReceiptNumber || null,
      p_merchant_request_id: merchantRequestId || null,
      p_phone: phoneNumber || null,
    });

    if (rpcError) {
      const msg = rpcError.message ?? '';
      if (msg.includes('already credited') || msg.includes('Unknown invoice')) {
        console.log(`M-Pesa checkout ${checkoutRequestId}: ${msg}`);
        return jsonResponse({ received: true });
      }
      if (msg.includes('mismatch')) {
        console.warn(`M-Pesa checkout ${checkoutRequestId} validation failed: ${msg}`);
        return jsonResponse({ received: true, warn: 'Validation failed' });
      }
      console.error('complete_mpesa_deposit failed:', msg);
      return jsonResponse({ error: 'Failed to credit balance' }, 500);
    }

    if (completed === false) {
      console.log(`M-Pesa checkout ${checkoutRequestId} already credited - skipping`);
      return jsonResponse({ received: true });
    }

    console.log(`Credited KES ${amount} for M-Pesa checkout ${checkoutRequestId}`);
    return jsonResponse({ received: true, credited: amount });
  } catch (err) {
    console.error('mpesa-callback unhandled error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
