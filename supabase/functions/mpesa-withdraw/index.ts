// supabase/functions/mpesa-withdraw/index.ts
// Verifies user password, reserves wallet funds, then calls Safaricom Daraja B2C.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MPESA_CONSUMER_KEY = Deno.env.get('MPESA_CONSUMER_KEY') ?? '';
const MPESA_CONSUMER_SECRET = Deno.env.get('MPESA_CONSUMER_SECRET') ?? '';
const MPESA_ENV = (Deno.env.get('MPESA_ENV') ?? 'sandbox').toLowerCase();
const MPESA_BUSINESS_SHORT_CODE = Deno.env.get('MPESA_BUSINESS_SHORT_CODE') ?? '';
const MPESA_INITIATOR_NAME = Deno.env.get('MPESA_INITIATOR_NAME') ?? '';
const MPESA_SECURITY_CREDENTIAL = Deno.env.get('MPESA_SECURITY_CREDENTIAL') ?? '';
const MPESA_B2C_RESULT_URL = Deno.env.get('MPESA_B2C_RESULT_URL') ?? '';
const MPESA_B2C_TIMEOUT_URL = Deno.env.get('MPESA_B2C_TIMEOUT_URL') ?? '';
const MPESA_B2C_COMMAND_ID = Deno.env.get('MPESA_B2C_COMMAND_ID') ?? 'BusinessPayment';

const MPESA_BASE_URL = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
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

async function getAccessToken(): Promise<string> {
  const credentials = btoa(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`);
  const res = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') {
    console.error('[withdraw] Daraja token error:', JSON.stringify(data));
    throw new Error('Unable to authenticate payment provider');
  }
  return data.access_token;
}

function hasB2CConfig(): boolean {
  return Boolean(
    MPESA_CONSUMER_KEY &&
    MPESA_CONSUMER_SECRET &&
    MPESA_BUSINESS_SHORT_CODE &&
    MPESA_INITIATOR_NAME &&
    MPESA_SECURITY_CREDENTIAL &&
    MPESA_B2C_RESULT_URL &&
    MPESA_B2C_TIMEOUT_URL
  );
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
      console.error('[withdraw] Missing Supabase env vars');
      return json({ error: 'Service unavailable' }, 503);
    }
    if (!hasB2CConfig()) {
      console.error('[withdraw] Missing Daraja B2C env vars');
      return json({ error: 'M-Pesa withdrawals are not configured yet.' }, 503);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Missing Authorization header' }, 401);
    }

    const { amount, phone, password } = await req.json();
    const parsedAmount = Math.round(Number(amount));
    const recipient = typeof phone === 'string' ? normalisePhone(phone) : null;

    if (!Number.isFinite(parsedAmount) || parsedAmount < 10) {
      return json({ error: 'Minimum withdrawal is KES 10.' }, 400);
    }
    if (parsedAmount > 70000) {
      return json({ error: 'Amount exceeds maximum withdrawal of KES 70,000' }, 400);
    }
    if (!recipient) {
      return json({ error: 'Valid M-Pesa phone number required' }, 400);
    }
    if (typeof password !== 'string' || !password.trim()) {
      return json({ error: 'Password is required' }, 400);
    }

    const svcClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authErr } = await svcClient.auth.getUser(
      authHeader.replace('Bearer ', ''),
    );
    if (authErr || !user?.email) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error: signInErr } = await authClient.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (signInErr) {
      return json({ error: 'Incorrect password. Withdrawal denied.' }, 403);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: rpcResult, error: rpcErr } = await userClient.rpc('process_withdrawal', {
      p_amount: parsedAmount,
      p_phone_number: recipient,
      p_device_id: null,
    });

    if (rpcErr) {
      console.error('[withdraw] process_withdrawal RPC error:', rpcErr.message);
      return json({ error: rpcErr.message }, 400);
    }

    const withdrawalId = String(rpcResult?.withdrawal_id ?? '');
    const token = await getAccessToken();

    const mpesaRes = await fetch(`${MPESA_BASE_URL}/mpesa/b2c/v3/paymentrequest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        InitiatorName: MPESA_INITIATOR_NAME,
        SecurityCredential: MPESA_SECURITY_CREDENTIAL,
        CommandID: MPESA_B2C_COMMAND_ID,
        Amount: parsedAmount,
        PartyA: MPESA_BUSINESS_SHORT_CODE,
        PartyB: recipient,
        Remarks: 'GHURT withdrawal',
        QueueTimeOutURL: MPESA_B2C_TIMEOUT_URL,
        ResultURL: MPESA_B2C_RESULT_URL,
        Occassion: 'GHURT',
      }),
    });

    const mpesaData = await mpesaRes.json().catch(() => ({})) as Record<string, unknown>;
    const providerRef = String(mpesaData.ConversationID ?? mpesaData.OriginatorConversationID ?? '');

    if (withdrawalId && mpesaRes.ok) {
      await svcClient
        .from('withdrawal_transactions')
        .update({
          status: 'PROCESSING',
          provider: 'mpesa_daraja',
          provider_ref: providerRef || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', withdrawalId);
    }

    if (!mpesaRes.ok) {
      const errMsg = typeof mpesaData.errorMessage === 'string'
        ? mpesaData.errorMessage
        : JSON.stringify(mpesaData);

      if (withdrawalId) {
        await svcClient
          .from('withdrawal_transactions')
          .update({
            status: 'FAILED',
            provider: 'mpesa_daraja',
            error_message: errMsg,
            updated_at: new Date().toISOString(),
          })
          .eq('id', withdrawalId);
      }

      await svcClient.rpc('refund_stake', {
        p_user_id: user.id,
        p_amount: parsedAmount,
        p_game_id: null,
        p_reason: `M-Pesa payout failed: ${errMsg}`,
      });

      console.error(`[withdraw] Daraja B2C failed for user ${user.id}:`, errMsg);
      return json({ error: `Payout failed: ${errMsg}. Balance restored.` }, 502);
    }

    return json({
      success: true,
      tracking_id: providerRef,
      message: 'Withdrawal initiated. M-Pesa payment in progress.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[withdraw] Unhandled error:', msg);
    return json({ error: 'Internal server error' }, 500);
  }
});
