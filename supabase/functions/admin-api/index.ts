// supabase/functions/admin-api/index.ts
// Secure Admin API — only users with is_admin=true in public.users can call this.
// The admin dashboard calls this function with a Bearer JWT.
// All operations are logged to audit_log.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** Verify JWT and return user record if they are admin */
async function resolveAdmin(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const svc = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

  const { data: { user }, error } = await svc.auth.getUser(token);
  if (error || !user) return null;

  // Check is_admin flag in public.users
  const { data: row, error: rowErr } = await svc
    .from('users')
    .select('id, is_admin')
    .eq('id', user.id)
    .single();

  if (rowErr || !row?.is_admin) return null;
  return user;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const admin = await resolveAdmin(req.headers.get('Authorization'));
  if (!admin) return json({ error: 'Forbidden — admin access only' }, 403);

  const svc = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
  const url = new URL(req.url);
  const op  = url.searchParams.get('op') ?? '';

  try {
    // ── GET OPERATIONS ─────────────────────────────────────────
    if (req.method === 'GET') {
      // Financial summary
      if (op === 'financial_summary') {
        const start = url.searchParams.get('start') ?? undefined;
        const end   = url.searchParams.get('end')   ?? undefined;
        const { data, error } = await svc.rpc('admin_financial_summary', {
          p_start_date: start ?? null,
          p_end_date:   end   ?? null,
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Live games stats
      if (op === 'live_games') {
        const { data, error } = await svc.rpc('admin_live_games_stats');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Device analytics: installs are unique registered devices; DAU is the
      // number of unique devices seen since the start of the current UTC day.
      if (op === 'device_analytics') {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const [{ count: installs, error: installError }, { count: dau, error: dauError }] = await Promise.all([
          svc.from('device_installations').select('id', { count: 'exact', head: true }),
          svc.from('device_installations').select('id', { count: 'exact', head: true }).gte('last_seen', today.toISOString()),
        ]);
        if (installError || dauError) return json({ error: installError?.message ?? dauError?.message }, 500);
        return json({ installs: installs ?? 0, dau: dau ?? 0 });
      }

      // Pending disputes (limited to 14 days)
      if (op === 'disputes') {
        const { data, error } = await svc.rpc('admin_pending_disputes');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Appeals
      if (op === 'appeals') {
        const { data, error } = await svc.from('appeals')
          .select('*')
          .eq('status', 'pending')
          .order('created_at', { ascending: true });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Audit log
      if (op === 'audit_log') {
        const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
        const offset = parseInt(url.searchParams.get('offset') ?? '0');
        const { data, error } = await svc.from('audit_log')
          .select('*')
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Wallet ledger for a user
      if (op === 'user_transactions') {
        const uid = url.searchParams.get('user_id');
        if (!uid) return json({ error: 'user_id required' }, 400);
        const { data, error } = await svc.from('transactions')
          .select('*')
          .eq('user_id', uid)
          .order('created_at', { ascending: false })
          .limit(100);
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Pending deposits
      if (op === 'pending_deposits') {
        const { data, error } = await svc.from('deposit_transactions')
          .select('*, users!inner(display_name, email)')
          .eq('status', 'PENDING')
          .order('created_at', { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Pending withdrawals
      if (op === 'pending_withdrawals') {
        const { data, error } = await svc.from('withdrawal_transactions')
          .select('*, users!inner(display_name, email)')
          .eq('status', 'PENDING')
          .order('created_at', { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // User devices
      if (op === 'user_devices') {
        const uid = url.searchParams.get('user_id');
        const { data, error } = await svc.from('user_devices')
          .select('*')
          .eq('user_id', uid ?? '')
          .order('last_seen', { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Flagged player pairs
      if (op === 'suspicious_pairs') {
        const { data, error } = await svc.from('player_pairs')
          .select('*')
          .eq('is_flagged', true)
          .order('suspicious_score', { ascending: false })
          .limit(50);
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Users list
      if (op === 'users') {
        const q = url.searchParams.get('q') ?? '';
        let query = svc.from('users')
          .select('id, display_name, email, balance, is_admin, created_at')
          .order('created_at', { ascending: false })
          .limit(50);
        if (q) query = query.ilike('display_name', `%${q}%`);
        const { data, error } = await query;
        if (error) return json({ error: error.message }, 500);

        // Fetch auth details for each user to get suspend flag (since metadata is in auth.users)
        const enrichedUsers = await Promise.all(data.map(async (u) => {
          const { data: authUser } = await svc.auth.admin.getUserById(u.id);
          const isSuspended = authUser?.user?.user_metadata?.is_suspended === 'true' || authUser?.user?.user_metadata?.is_suspended === true;
          return { ...u, is_suspended: isSuspended };
        }));

        return json(enrichedUsers);
      }

      // Wallet for a user
      if (op === 'user_wallet') {
        const uid = url.searchParams.get('user_id');
        if (!uid) return json({ error: 'user_id required' }, 400);
        const { data, error } = await svc.from('wallets')
          .select('*')
          .eq('user_id', uid)
          .single();
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      return json({ error: 'Unknown op' }, 400);
    }

    // ── POST OPERATIONS ────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json();

      // Resolve dispute
      if (op === 'resolve_dispute') {
        const { dispute_id, action, reason, winner_id } = body;
        if (!dispute_id || !action || !reason) {
          return json({ error: 'dispute_id, action, reason required' }, 400);
        }
        const { data, error } = await svc.rpc('admin_resolve_dispute', {
          p_dispute_id: dispute_id,
          p_action:     action,
          p_reason:     reason,
          p_winner_id:  winner_id ?? null,
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Freeze / unfreeze wallet
      if (op === 'freeze_wallet') {
        const { user_id, freeze, reason } = body;
        if (!user_id || !reason) return json({ error: 'user_id, reason required' }, 400);
        const { data, error } = await svc.rpc('admin_freeze_wallet', {
          p_target_user_id: user_id,
          p_reason:         reason,
          p_freeze:         freeze !== false,
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Ban device
      if (op === 'ban_device') {
        const { device_id, reason, duration_hours } = body;
        if (!device_id || !reason) return json({ error: 'device_id, reason required' }, 400);
        const { data, error } = await svc.rpc('admin_ban_device', {
          p_device_id:      device_id,
          p_reason:         reason,
          p_duration_hours: duration_hours ?? 24,
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Suspend user
      if (op === 'suspend_user') {
        const { user_id, reason } = body;
        if (!user_id || !reason) return json({ error: 'user_id, reason required' }, 400);
        const { data, error } = await svc.rpc('admin_suspend_user', {
          p_target_user_id: user_id,
          p_reason:         reason,
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Restore user
      if (op === 'restore_user') {
        const { user_id, reason } = body;
        if (!user_id || !reason) return json({ error: 'user_id, reason required' }, 400);
        const { data, error } = await svc.rpc('admin_restore_user', {
          p_target_user_id: user_id,
          p_reason:         reason,
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Resolve appeal
      if (op === 'resolve_appeal') {
        const { appeal_id, action, reason } = body;
        if (!appeal_id || !action) return json({ error: 'appeal_id, action required' }, 400);

        // Fetch appeal
        const { data: appeal, error: appErr } = await svc.from('appeals')
          .select('*')
          .eq('id', appeal_id)
          .single();
        if (appErr || !appeal) return json({ error: 'Appeal not found' }, 404);

        if (action === 'approve') {
          // Restore user
          const { error: restoreErr } = await svc.rpc('admin_restore_user', {
            p_target_user_id: appeal.user_id,
            p_reason:         reason ?? 'Appeal approved by admin',
          });
          if (restoreErr) return json({ error: restoreErr.message }, 500);

          await svc.from('appeals')
            .update({ status: 'resolved' })
            .eq('id', appeal_id);
        } else {
          // Reject appeal
          await svc.from('appeals')
            .update({ status: 'rejected' })
            .eq('id', appeal_id);
          
          await svc.from('audit_log').insert({
            action_type: 'reject_appeal',
            target_type: 'user',
            target_id: appeal.user_id,
            reason: reason ?? 'Appeal rejected by admin',
          });
        }

        return json({ success: true });
      }

      // Refund stake manually
      if (op === 'refund_stake') {
        const { user_id, amount, reason } = body;
        if (!user_id || !amount) return json({ error: 'user_id, amount required' }, 400);
        const { data, error } = await svc.rpc('refund_stake', {
          p_user_id: user_id,
          p_amount:  amount,
          p_reason:  reason ?? 'Admin manual refund',
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }

      // Force terminate a stuck staked game
      if (op === 'terminate_game') {
        const { game_id, reason } = body;
        if (!game_id) return json({ error: 'game_id required' }, 400);
        const { error } = await svc.from('staked_games')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', game_id);
        if (error) return json({ error: error.message }, 500);

        // Refund stakes
        const { data: game } = await svc.from('staked_games')
          .select('player1_id, player2_id, stake_amount')
          .eq('id', game_id)
          .single();

        if (game) {
          if (game.player1_id) {
            await svc.rpc('refund_stake', {
              p_user_id: game.player1_id,
              p_amount:  game.stake_amount,
              p_game_id: game_id,
              p_reason:  reason ?? 'Stuck game cancelled by admin',
            });
          }
          if (game.player2_id) {
            await svc.rpc('refund_stake', {
              p_user_id: game.player2_id,
              p_amount:  game.stake_amount,
              p_game_id: game_id,
              p_reason:  reason ?? 'Stuck game cancelled by admin',
            });
          }
        }

        await svc.from('audit_log').insert({
          action_type: 'terminate_game',
          target_type: 'game',
          target_id: game_id,
          new_values: { status: 'cancelled' },
          reason: reason ?? 'Admin force terminated & refunded stakes',
        });
        return json({ success: true });
      }

      return json({ error: 'Unknown op' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error('[admin-api] Error:', msg);
    return json({ error: msg }, 500);
  }
});
