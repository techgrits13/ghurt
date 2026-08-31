// supabase/functions/mpesa-pay/index.ts
// Initiates a Safaricom Daraja STK Push for a GHURT deposit.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MPESA_CONSUMER_KEY = Deno.env.get('MPESA_CONSUMER_KEY') ?? '';
const MPESA_CONSUMER_SECRET = Deno.env.get('MPESA_CONSUMER_SECRET') ?? '';
const MPESA_PASSKEY = Deno.env.get('MPESA_PASSKEY') ?? '';
const MPESA_BUSINESS_SHORT_CODE = Deno.env.get('MPESA_BUSINESS_SHORT_CODE') ?? '';
const MPESA_CALLBACK_URL = Deno.env.get('MPESA_CALLBACK_URL') ?? '';
const MPESA_ENV = (Deno.env.get('MPESA_ENV') ?? 'sandbox').toLowerCase();
const MPESA_SANDBOX_PHONE = Deno.env.get('MPESA_SANDBOX_PHONE') ?? '';
const MPESA_USE_SANDBOX_TEST_PHONE = Deno.env.get('MPESA_USE_SANDBOX_TEST_PHONE') === 'true';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const MIN_DEPOSIT = 35;
const MAX_DEPOSIT = 1500;
const MPESA_BASE_URL = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalisePhone(phone: string): string | null {
  let normalised = phone.trim().replace(/\s+/g, '');
  if (normalised.startsWith('0')) normalised = `254${normalised.slice(1)}`;
  if (normalised.startsWith('+')) normalised = normalised.slice(1);
  return /^254[17]\d{8}$/.test(normalised) ? normalised : null;
}

function darajaTimestamp(): string {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
}

async function getAccessToken(): Promise<string> {
  const credentials = btoa(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`);
  const res = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') {
    console.error('Daraja token error:', JSON.stringify(data));
    throw new Error('Unable to authenticate payment provider');
  }
  return data.access_token;
}

async function resolveAuthenticatedUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token || !SUPABASE_URL) return null;

  const apiKey = req.headers.get('apikey') ?? SUPABASE_ANON_KEY;
  const supabase = createClient(SUPABASE_URL, apiKey || SUPABASE_SERVICE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    if (
      !MPESA_CONSUMER_KEY ||
      !MPESA_CONSUMER_SECRET ||
      !MPESA_PASSKEY ||
      !MPESA_BUSINESS_SHORT_CODE ||
      !MPESA_CALLBACK_URL ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_KEY
    ) {
      console.error('mpesa-pay misconfigured: missing required env vars');
      return jsonResponse({ error: 'Payment service unavailable' }, 503);
    }

    const userId = await resolveAuthenticatedUserId(req);
    if (!userId) {
      return jsonResponse({ error: 'Unauthorized - sign in required' }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const requestedPhone = typeof body.phone === 'string' ? normalisePhone(body.phone) : null;
    const parsedAmount = Number(body.amount);
    if (!requestedPhone) {
      return jsonResponse({ error: 'Invalid Kenyan phone number' }, 400);
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount < MIN_DEPOSIT || parsedAmount > MAX_DEPOSIT) {
      return jsonResponse({ error: `Amount must be between KES ${MIN_DEPOSIT} and KES ${MAX_DEPOSIT}` }, 400);
    }

    const amount = Math.round(parsedAmount);
    const sandboxPhone = MPESA_SANDBOX_PHONE ? normalisePhone(MPESA_SANDBOX_PHONE) : null;
    const stkPhone = MPESA_ENV === 'sandbox' && MPESA_USE_SANDBOX_TEST_PHONE && sandboxPhone
      ? sandboxPhone
      : requestedPhone;
    const timestamp = darajaTimestamp();
    const password = btoa(`${MPESA_BUSINESS_SHORT_CODE}${MPESA_PASSKEY}${timestamp}`);
    const accountReference = `GHURT-${Date.now()}`.slice(0, 12);
    const transactionDesc = 'GHURT Deposit';
    const token = await getAccessToken();

    const mpesaRes = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        BusinessShortCode: MPESA_BUSINESS_SHORT_CODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: stkPhone,
        PartyB: MPESA_BUSINESS_SHORT_CODE,
        PhoneNumber: stkPhone,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: accountReference,
        TransactionDesc: transactionDesc,
      }),
    });

    const mpesaData = await mpesaRes.json().catch(() => ({})) as Record<string, unknown>;
    if (!mpesaRes.ok || mpesaData.ResponseCode !== '0') {
      console.error('Daraja STK error:', JSON.stringify(mpesaData));
      const detail = typeof mpesaData.errorMessage === 'string'
        ? mpesaData.errorMessage
        : typeof mpesaData.ResponseDescription === 'string'
          ? mpesaData.ResponseDescription
          : 'M-Pesa request failed';
      return jsonResponse({ error: detail }, 502);
    }

    const checkoutRequestId = String(mpesaData.CheckoutRequestID ?? '');
    const merchantRequestId = String(mpesaData.MerchantRequestID ?? '');
    if (!checkoutRequestId) {
      console.error('Daraja success but missing CheckoutRequestID:', JSON.stringify(mpesaData));
      return jsonResponse({ error: 'Payment initiated but tracking failed. Contact support.' }, 502);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { error: dbError } = await supabase.from('deposit_transactions').upsert(
      {
        user_id: userId,
        invoice_id: checkoutRequestId,
        checkout_request_id: checkoutRequestId,
        merchant_request_id: merchantRequestId || null,
        provider: 'mpesa_daraja',
        amount,
        phone: requestedPhone,
        status: 'PENDING',
      },
      { onConflict: 'invoice_id' },
    );

    if (dbError) {
      console.error('deposit_transactions upsert failed:', dbError.message);
    }

    return jsonResponse({
      success: true,
      checkout_request_id: checkoutRequestId,
      merchant_request_id: merchantRequestId,
      sandbox: MPESA_ENV === 'sandbox',
      sandbox_test_phone_used: stkPhone !== requestedPhone,
      requested_phone: requestedPhone,
      stk_phone: stkPhone,
      message: 'STK push sent. Check your phone.',
    }, 200);
  } catch (err) {
    console.error('mpesa-pay error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return jsonResponse({ error: message }, 500);
  }
});
