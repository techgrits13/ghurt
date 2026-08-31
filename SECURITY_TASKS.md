# Ghurt Security & Admin Dashboard Implementation Tasks

## CRITICAL SECURITY REQUIREMENTS

### Core Security Principles
- **NEVER** trust client-side financial operations
- All wallet balance updates, withdrawals, deposit confirmations, and winnings calculations MUST be server-side
- Use Row Level Security (RLS) in Supabase
- Use Expo SecureStore for sensitive tokens
- Implement device ID tracking for fraud detection
- 8% platform fee on all winnings/pots
- Use ledger system instead of simple balance storage

## DATABASE SCHEMA CHANGES

### 1. Wallets Table
```sql
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  available_balance DECIMAL(10,2) DEFAULT 0.00,
  held_balance DECIMAL(10,2) DEFAULT 0.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
```

### 2. Transactions Ledger Table
```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
  transaction_type VARCHAR(50) NOT NULL, -- 'deposit', 'withdrawal', 'stake', 'win', 'loss', 'fee', 'refund'
  amount DECIMAL(10,2) NOT NULL,
  balance_after DECIMAL(10,2) NOT NULL,
  reference_id UUID, -- Game ID or payment ID
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'cancelled'
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  device_id VARCHAR(255),
  ip_address INET
);
```

### 3. Device Tracking Table
```sql
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  device_info JSONB,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  is_banned BOOLEAN DEFAULT FALSE,
  ban_reason TEXT,
  ban_until TIMESTAMPTZ,
  UNIQUE(user_id, device_id)
);
```

### 4. Disputes Table
```sql
CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID REFERENCES games(id),
  staked_game_id UUID REFERENCES staked_games(id),
  reporter_id UUID REFERENCES auth.users(id),
  dispute_type VARCHAR(50) NOT NULL, -- 'both_claim_win', 'state_mismatch', 'timeout', 'replay_mismatch'
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'resolved', 'escalated'
  resolution_action VARCHAR(50), -- 'refund_both', 'award_winner', 'ban_both', 'manual_review'
  game_state_snapshot JSONB,
  evidence JSONB,
  admin_notes TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 5. Audit Log Table
```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES auth.users(id),
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(50), -- 'user', 'wallet', 'game', 'dispute'
  target_id UUID,
  old_values JSONB,
  new_values JSONB,
  reason TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6. Collusion Detection Table
```sql
CREATE TABLE player_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id UUID REFERENCES auth.users(id),
  player2_id UUID REFERENCES auth.users(id),
  games_played INT DEFAULT 0,
  games_together INT DEFAULT 0,
  suspicious_score INT DEFAULT 0,
  last_played TIMESTAMPTZ,
  is_flagged BOOLEAN DEFAULT FALSE,
  UNIQUE(player1_id, player2_id)
);
```

## SERVER-SIDE FUNCTIONS (PostgreSQL RPC)

### Financial Operations (CRITICAL - Server-Side Only)
1. `process_deposit()` - Validate Intasend webhook, update ledger
2. `process_withdrawal()` - Server-side validation, balance check, Intasend API call
3. `calculate_game_winnings()` - Calculate winnings with 8% fee, update ledger
4. `lock_stake()` - Lock funds in held_balance when joining staked game
5. `release_stake()` - Release held_balance to winner after game completion
6. `refund_stake()` - Refund held_balance in case of disputes/cancellations

### Fraud Detection Functions
1. `detect_device_conflict()` - Check if same device claims multiple wins
2. `check_collusion_pattern()` - Analyze player pair frequency
3. `flag_suspicious_activity()` - Auto-flag patterns for review
4. `apply_device_ban()` - Ban device ID temporarily or permanently

### Game Integrity Functions
1. `validate_game_state()` - Verify game state integrity
2. `detect_game_state_mismatch()` - Compare client vs server state
3. `create_dispute()` - Auto-create dispute on conflicts
4. `resolve_dispute()` - Admin resolution with audit logging

## ADMIN DASHBOARD FEATURES

### 1. Live Games Monitor
- Real-time count of ongoing games
- Stuck games detection (games > 30 minutes without activity)
- Game state viewer
- Force terminate capability

### 2. Wallet & Transaction Ledger
- Real-time wallet balances
- Transaction history with filters:
  - Per day
  - Per game
  - Per month
  - Per user
  - Per transaction type
- Deposit/Withdrawal pending queues
- Fee collection reports (8% platform fee)

### 3. Dispute & Conflict Queue
- Both players claim win scenarios
- Game state mismatch detection
- Timeout disputes
- Replay mismatch detection
- Action buttons:
  - Ban (temporary/permanent)
  - Refund both
  - Award winner
  - Escalate to manual review
  - Request additional evidence

### 4. Game Replay Viewer
- Full game state replay
- Move-by-move analysis
- Card play verification
- Timestamp tracking
- Critical for dispute resolution

### 5. Intasend Payment Monitor
- Pending deposit confirmations
- Webhook failure detection
- Failed payment tracking
- Duplicate payment detection
- Automatic retry logic
- Payment reconciliation

### 6. Account Action Panel
- Suspend user account
- Freeze wallet (prevent transactions)
- Lock withdrawals
- Shadow ban matchmaking
- View user device history
- View user game history

### 7. Audit Log
- Every admin action logged:
  - Who did it (admin_id)
  - What they did (action_type)
  - Target (target_type, target_id)
  - Before/after values (old_values, new_values)
  - Reason (reason)
  - When (created_at)
  - Where (ip_address, user_agent)
- Immutable log (no delete permissions)
- Searchable and filterable

## SECURITY ARCHITECTURE

### Client-Side (Mobile App)
- Use Expo SecureStore for auth tokens
- Never store or manipulate financial data
- Send only game moves to server
- Receive only display data from server
- Include device ID in all requests

### Server-Side (Supabase Edge Functions)
- All financial calculations
- All wallet balance updates
- All deposit/withdrawal processing
- Game state validation
- Fraud detection logic
- Intasend API integration

### Database Security
- Row Level Security (RLS) on all tables
- Users can only read their own data
- Only service role can modify financial data
- Audit log is append-only
- Device ID tracking for all transactions

## FRAUD DETECTION RULES

### Device Conflict Detection
1. First conflict: Auto refund, log warning
2. Second conflict: 24-hour ban
3. Third conflict: 72-hour ban
4. Fourth+ conflict: Permanent ban
5. Escalate to admin dashboard for review

### Collusion Detection
1. Track player pair frequency
2. Flag if same pair plays > 5 times/day
3. Analyze win/loss patterns
4. Detect intentional losing patterns
5. Flag for manual review if suspicious_score > threshold

### Payment Fraud
1. Detect duplicate payment IDs
2. Validate Intasend webhook signatures
3. Cross-reference transaction amounts
4. Flag unusual withdrawal patterns
5. Implement withdrawal limits

## SCALABILITY CONSIDERATIONS

### Load Balancing
- Use Supabase built-in scaling
- Implement connection pooling
- Cache frequently accessed data
- Use database indexes for performance

### Performance Optimization
- Index on user_id, device_id, transaction_type, created_at
- Partition large tables by date
- Use materialized views for reports
- Implement pagination for admin dashboard

### Rate Limiting
- Implement API rate limiting
- Limit withdrawal frequency
- Limit game creation frequency
- Detect and prevent bot activity

## IMPLEMENTATION ORDER (Easiest to Hardest)

### Phase 1: Database Schema & Basic Security
1. Create new database tables
2. Implement RLS policies
3. Create audit log table
4. Set up device ID tracking

### Phase 2: Server-Side Financial Functions
1. Create transaction ledger system
2. Implement deposit processing
3. Implement withdrawal processing
4. Add 8% fee calculation
5. Create wallet locking mechanism

### Phase 3: Fraud Detection
1. Implement device conflict detection
2. Create dispute system
3. Add collusion detection
4. Implement auto-ban logic

### Phase 4: Admin Dashboard Backend
1. Create admin RPC functions
2. Implement audit logging
3. Add dispute resolution endpoints
4. Create game replay storage

### Phase 5: Admin Dashboard Frontend
1. Build live games monitor
2. Create wallet ledger viewer
3. Implement dispute queue UI
4. Add game replay viewer
5. Build payment monitor
6. Create account action panel
7. Implement audit log viewer

### Phase 6: Client-Side Security
1. Remove all client-side financial logic
2. Implement SecureStore
3. Add device ID to all requests
4. Update mobile app to use server-side APIs

### Phase 7: Testing & Deployment
1. Security audit
2. Load testing
3. Fraud detection testing
4. Admin dashboard testing
5. Gradual rollout

## CRITICAL SECURITY CHECKLIST

- [ ] No client-side wallet balance updates
- [ ] No client-side withdrawal approvals
- [ ] No client-side deposit confirmations
- [ ] No client-side winnings calculations
- [ ] All financial operations server-side
- [ ] RLS enabled on all tables
- [ ] Audit log for all admin actions
- [ ] Device ID tracking implemented
- [ ] 8% platform fee enforced
- [ ] Ledger system instead of balance
- [ ] Fraud detection rules active
- [ ] Admin dashboard functional
- [ ] Game replay system working
- [ ] Intasend integration secure
- [ ] Collusion detection active
- [ ] Rate limiting implemented
- [ ] Scalability tested

## NOTES

- This is a security-critical project
- Test thoroughly before deployment
- Monitor fraud detection closely
- Adjust rules based on real data
- Keep audit logs secure
- Regular security audits required
- Plan for million+ users
