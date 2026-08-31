-- Fraud Detection and Dispute System RPC Functions
-- Execute in Supabase SQL Editor

-- ============================================
-- DEVICE CONFLICT DETECTION
-- ============================================

-- Check for device conflicts (same device claiming multiple wins)
CREATE OR REPLACE FUNCTION detect_device_conflict(
  p_user_id UUID,
  p_device_id VARCHAR,
  p_game_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_conflict_count INT;
  v_recent_conflicts INT;
  v_device_record RECORD;
BEGIN
  -- Check if this device has recent wins from different users
  SELECT COUNT(*) INTO v_conflict_count
  FROM transactions t
  JOIN user_devices ud ON t.device_id = ud.device_id
  WHERE t.transaction_type = 'win'
    AND t.device_id = p_device_id
    AND t.user_id != p_user_id
    AND t.created_at > NOW() - INTERVAL '24 hours';
  
  -- If conflict detected
  IF v_conflict_count > 0 THEN
    -- Get device record
    SELECT * INTO v_device_record
    FROM user_devices
    WHERE device_id = p_device_id;
    
    -- Count total conflicts for this device
    SELECT COUNT(*) INTO v_recent_conflicts
    FROM transactions t
    WHERE t.transaction_type = 'win'
      AND t.device_id = p_device_id
      AND t.created_at > NOW() - INTERVAL '7 days';
    
    -- Determine action based on conflict history
    IF v_recent_conflicts = 1 THEN
      -- First conflict: Auto refund, log warning
      RETURN jsonb_build_object(
        'conflict_detected', true,
        'conflict_count', v_recent_conflicts,
        'action', 'auto_refund',
        'message', 'First device conflict detected. Auto-refunding.'
      );
    ELSIF v_recent_conflicts = 2 THEN
      -- Second conflict: 24-hour ban
      UPDATE user_devices
      SET 
        is_banned = true,
        ban_reason = 'Second device conflict detected',
        ban_until = NOW() + INTERVAL '24 hours'
      WHERE device_id = p_device_id;
      
      -- Create dispute for admin review
      INSERT INTO disputes (
        game_id, reporter_id, dispute_type, status,
        game_state_snapshot, evidence
      ) VALUES (
        p_game_id, p_user_id, 'both_claim_win', 'escalated',
        jsonb_build_object('device_id', p_device_id),
        jsonb_build_object(
          'conflict_count', v_recent_conflicts,
          'device_banned', true,
          'ban_duration', '24 hours'
        )
      );
      
      RETURN jsonb_build_object(
        'conflict_detected', true,
        'conflict_count', v_recent_conflicts,
        'action', 'ban_24h',
        'message', 'Second device conflict. Device banned for 24 hours.'
      );
    ELSIF v_recent_conflicts = 3 THEN
      -- Third conflict: 72-hour ban
      UPDATE user_devices
      SET 
        is_banned = true,
        ban_reason = 'Third device conflict detected',
        ban_until = NOW() + INTERVAL '72 hours'
      WHERE device_id = p_device_id;
      
      -- Create dispute for admin review
      INSERT INTO disputes (
        game_id, reporter_id, dispute_type, status,
        game_state_snapshot, evidence
      ) VALUES (
        p_game_id, p_user_id, 'both_claim_win', 'escalated',
        jsonb_build_object('device_id', p_device_id),
        jsonb_build_object(
          'conflict_count', v_recent_conflicts,
          'device_banned', true,
          'ban_duration', '72 hours'
        )
      );
      
      RETURN jsonb_build_object(
        'conflict_detected', true,
        'conflict_count', v_recent_conflicts,
        'action', 'ban_72h',
        'message', 'Third device conflict. Device banned for 72 hours.'
      );
    ELSE
      -- Fourth+ conflict: Permanent ban
      UPDATE user_devices
      SET 
        is_banned = true,
        ban_reason = 'Multiple device conflicts - permanent ban',
        ban_until = NULL
      WHERE device_id = p_device_id;
      
      -- Create dispute for admin review
      INSERT INTO disputes (
        game_id, reporter_id, dispute_type, status,
        game_state_snapshot, evidence
      ) VALUES (
        p_game_id, p_user_id, 'both_claim_win', 'escalated',
        jsonb_build_object('device_id', p_device_id),
        jsonb_build_object(
          'conflict_count', v_recent_conflicts,
          'device_banned', true,
          'ban_duration', 'permanent'
        )
      );
      
      RETURN jsonb_build_object(
        'conflict_detected', true,
        'conflict_count', v_recent_conflicts,
        'action', 'ban_permanent',
        'message', 'Multiple device conflicts. Permanent ban applied.'
      );
    END IF;
  END IF;
  
  -- No conflict detected
  RETURN jsonb_build_object(
    'conflict_detected', false,
    'message', 'No device conflict detected'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- COLLUSION DETECTION
-- ============================================

-- Track player pairs and detect collusion patterns
CREATE OR REPLACE FUNCTION track_player_pair(
  p_player1_id UUID,
  p_player2_id UUID,
  p_game_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_pair RECORD;
  v_games_together_today INT;
BEGIN
  -- Ensure consistent ordering (smaller ID first)
  IF p_player1_id > p_player2_id THEN
    -- Swap IDs
    p_player1_id := p_player2_id;
    p_player2_id := p_player1_id;
  END IF;
  
  -- Get or create player pair record
  SELECT pc.* INTO v_pair
  FROM player_pairs pc
  WHERE pc.player1_id = p_player1_id AND pc.player2_id = p_player2_id;
  
  IF NOT FOUND THEN
    INSERT INTO player_pairs (player1_id, player2_id, games_played, games_together, last_played)
    VALUES (p_player1_id, p_player2_id, 1, 1, NOW())
    RETURNING * INTO v_pair;
  ELSE
    -- Update counters
    UPDATE player_pairs
    SET 
      games_played = games_played + 1,
      games_together = games_together + 1,
      last_played = NOW()
    WHERE id = v_pair.id
    RETURNING * INTO v_pair;
  END IF;
  
  -- Check if they played together too frequently today
  SELECT COUNT(*) INTO v_games_together_today
  FROM games g
  WHERE g.status = 'playing'
    AND g.joined_players @> '[{"id": "' || p_player1_id || '"}]'::jsonb
    AND g.joined_players @> '[{"id": "' || p_player2_id || '"}]'::jsonb
    AND g.created_at > NOW() - INTERVAL '24 hours';
  
  -- Flag if suspicious (more than 5 games together in 24 hours)
  IF v_games_together_today > 5 THEN
    UPDATE player_pairs
    SET 
      suspicious_score = suspicious_score + 10,
      is_flagged = true
    WHERE id = v_pair.id;
    
    RETURN jsonb_build_object(
      'suspicious', true,
      'games_together_today', v_games_together_today,
      'suspicious_score', v_pair.suspicious_score + 10,
      'action', 'flagged_for_review'
    );
  END IF;
  
  RETURN jsonb_build_object(
    'suspicious', false,
    'games_together', v_pair.games_together,
    'suspicious_score', v_pair.suspicious_score
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- DISPUTE CREATION
-- ============================================

-- Auto-create dispute on game state mismatch
CREATE OR REPLACE FUNCTION create_dispute(
  p_game_id UUID,
  p_reporter_id UUID,
  p_dispute_type VARCHAR,
  p_game_state JSONB DEFAULT NULL,
  p_evidence JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  v_dispute_id UUID;
BEGIN
  INSERT INTO disputes (
    game_id, reporter_id, dispute_type, status,
    game_state_snapshot, evidence
  ) VALUES (
    p_game_id, p_reporter_id, p_dispute_type, 'pending',
    p_game_state, p_evidence
  ) RETURNING id INTO v_dispute_id;
  
  RETURN v_dispute_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- DISPUTE RESOLUTION
-- ============================================

-- Resolve dispute with audit logging
CREATE OR REPLACE FUNCTION resolve_dispute(
  p_dispute_id UUID,
  p_admin_id UUID,
  p_resolution_action VARCHAR,
  p_reason TEXT,
  p_ip_address INET DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_dispute RECORD;
  v_audit_id UUID;
BEGIN
  -- Get dispute details
  SELECT * INTO v_dispute FROM disputes WHERE id = p_dispute_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;
  
  -- Update dispute
  UPDATE disputes
  SET 
    status = 'resolved',
    resolution_action = p_resolution_action,
    resolved_by = p_admin_id,
    resolved_at = NOW(),
    admin_notes = p_reason
  WHERE id = p_dispute_id;
  
  -- Log audit entry
  INSERT INTO audit_log (
    admin_id, action_type, target_type, target_id,
    old_values, new_values, reason, ip_address
  ) VALUES (
    p_admin_id, 
    'resolve_dispute', 
    'dispute', 
    p_dispute_id,
    jsonb_build_object('status', v_dispute.status),
    jsonb_build_object(
      'status', 'resolved',
      'resolution_action', p_resolution_action
    ),
    p_reason,
    p_ip_address
  ) RETURNING id INTO v_audit_id;
  
  -- Execute resolution action
  IF p_resolution_action = 'refund_both' THEN
    -- Refund both players' stakes
    IF v_dispute.game_id IS NOT NULL THEN
      -- Handle regular game
      PERFORM refund_stake(
        (SELECT player1_id FROM games WHERE id = v_dispute.game_id),
        (SELECT stake_amount FROM games WHERE id = v_dispute.game_id),
        v_dispute.game_id,
        'Dispute resolution - refund both'
      );
      PERFORM refund_stake(
        (SELECT player2_id FROM games WHERE id = v_dispute.game_id),
        (SELECT stake_amount FROM games WHERE id = v_dispute.game_id),
        v_dispute.game_id,
        'Dispute resolution - refund both'
      );
    ELSIF v_dispute.staked_game_id IS NOT NULL THEN
      -- Handle staked game
      PERFORM refund_stake(
        (SELECT player1_id FROM staked_games WHERE id = v_dispute.staked_game_id),
        (SELECT stake_amount FROM staked_games WHERE id = v_dispute.staked_game_id),
        v_dispute.staked_game_id,
        'Dispute resolution - refund both'
      );
      PERFORM refund_stake(
        (SELECT player2_id FROM staked_games WHERE id = v_dispute.staked_game_id),
        (SELECT stake_amount FROM staked_games WHERE id = v_dispute.staked_game_id),
        v_dispute.staked_game_id,
        'Dispute resolution - refund both'
      );
    END IF;
  ELSIF p_resolution_action = 'award_winner' THEN
    -- Award to winner (logic depends on specific case)
    -- This would need additional parameters for winner_id
    NULL;
  ELSIF p_resolution_action = 'ban_both' THEN
    -- Ban both users temporarily
    NULL;
  END IF;
  
  RETURN jsonb_build_object(
    'success', true,
    'dispute_id', p_dispute_id,
    'audit_id', v_audit_id,
    'resolution_action', p_resolution_action
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- GAME REPLAY STORAGE
-- ============================================

-- Save game replay for dispute resolution
CREATE OR REPLACE FUNCTION save_game_replay(
  p_game_id UUID,
  p_staked_game_id UUID DEFAULT NULL,
  p_game_state JSONB,
  p_moves JSONB DEFAULT '[]',
  p_duration_seconds INT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_replay_id UUID;
BEGIN
  INSERT INTO game_replays (
    game_id, staked_game_id, game_state, moves, duration_seconds
  ) VALUES (
    p_game_id, p_staked_game_id, p_game_state, p_moves, p_duration_seconds
  ) RETURNING id INTO v_replay_id;
  
  RETURN v_replay_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- ADMIN FUNCTIONS
-- ============================================

-- Suspend user account
CREATE OR REPLACE FUNCTION suspend_user(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_reason TEXT,
  p_ip_address INET DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_audit_id UUID;
BEGIN
  -- Log audit entry
  INSERT INTO audit_log (
    admin_id, action_type, target_type, target_id,
    new_values, reason, ip_address
  ) VALUES (
    p_admin_id, 
    'suspend_user', 
    'user', 
    p_target_user_id,
    jsonb_build_object('suspended', true),
    p_reason,
    p_ip_address
  ) RETURNING id INTO v_audit_id;
  
  -- Update user status (would need a user_status field in auth.users or separate table)
  -- For now, we'll use metadata
  UPDATE auth.users
  SET raw_user_meta_data = jsonb_set(
    COALESCE(raw_user_meta_data, '{}'),
    '{is_suspended}',
    'true'
  )
  WHERE id = p_target_user_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_target_user_id,
    'audit_id', v_audit_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Freeze wallet
CREATE OR REPLACE FUNCTION freeze_wallet(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_reason TEXT,
  p_ip_address INET DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_audit_id UUID;
BEGIN
  -- Log audit entry
  INSERT INTO audit_log (
    admin_id, action_type, target_type, target_id,
    new_values, reason, ip_address
  ) VALUES (
    p_admin_id, 
    'freeze_wallet', 
    'wallet', 
    (SELECT id FROM wallets WHERE user_id = p_target_user_id),
    jsonb_build_object('frozen', true),
    p_reason,
    p_ip_address
  ) RETURNING id INTO v_audit_id;
  
  -- Add frozen flag to wallet metadata (would need to add frozen column)
  -- For now, we'll use a separate approach
  
  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_target_user_id,
    'audit_id', v_audit_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- ADMIN DASHBOARD QUERIES
-- ============================================

-- Get live games count
CREATE OR REPLACE FUNCTION get_live_games_stats()
RETURNS JSONB AS $$
DECLARE
  v_total_games INT;
  v_stuck_games INT;
  v_staked_games INT;
BEGIN
  SELECT COUNT(*) INTO v_total_games
  FROM games WHERE status = 'playing';
  
  SELECT COUNT(*) INTO v_stuck_games
  FROM games 
  WHERE status = 'playing' 
    AND updated_at < NOW() - INTERVAL '30 minutes';
  
  SELECT COUNT(*) INTO v_staked_games
  FROM staked_games WHERE status = 'playing';
  
  RETURN jsonb_build_object(
    'total_live_games', v_total_games,
    'stuck_games', v_stuck_games,
    'live_staked_games', v_staked_games
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get pending disputes
CREATE OR REPLACE FUNCTION get_pending_disputes()
RETURNS TABLE (
  id UUID,
  game_id UUID,
  reporter_id UUID,
  dispute_type VARCHAR,
  status VARCHAR,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    d.id, d.game_id, d.reporter_id, d.dispute_type, d.status, d.created_at
  FROM disputes d
  WHERE d.status = 'pending'
  ORDER BY d.created_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get financial summary
CREATE OR REPLACE FUNCTION get_financial_summary(
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_total_deposits DECIMAL;
  v_total_withdrawals DECIMAL;
  v_total_fees DECIMAL;
  v_total_winnings DECIMAL;
BEGIN
  IF p_start_date IS NULL THEN
    p_start_date := CURRENT_DATE - INTERVAL '30 days';
  END IF;
  
  IF p_end_date IS NULL THEN
    p_end_date := CURRENT_DATE;
  END IF;
  
  SELECT COALESCE(SUM(amount), 0) INTO v_total_deposits
  FROM transactions
  WHERE transaction_type = 'deposit'
    AND created_at >= p_start_date
    AND created_at <= p_end_date + INTERVAL '1 day';
  
  SELECT COALESCE(SUM(amount), 0) INTO v_total_withdrawals
  FROM transactions
  WHERE transaction_type = 'withdrawal'
    AND status = 'completed'
    AND created_at >= p_start_date
    AND created_at <= p_end_date + INTERVAL '1 day';
  
  SELECT COALESCE(SUM(amount), 0) INTO v_total_fees
  FROM transactions
  WHERE transaction_type = 'fee'
    AND created_at >= p_start_date
    AND created_at <= p_end_date + INTERVAL '1 day';
  
  SELECT COALESCE(SUM(amount), 0) INTO v_total_winnings
  FROM transactions
  WHERE transaction_type = 'win'
    AND created_at >= p_start_date
    AND created_at <= p_end_date + INTERVAL '1 day';
  
  RETURN jsonb_build_object(
    'total_deposits', v_total_deposits,
    'total_withdrawals', v_total_withdrawals,
    'total_fees', v_total_fees,
    'total_winnings', v_total_winnings,
    'net_revenue', v_total_fees,
    'period_start', p_start_date,
    'period_end', p_end_date
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
