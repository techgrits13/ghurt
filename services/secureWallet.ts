import { supabase } from '../supabaseClient';
import { getOrCreateDeviceId } from '../utils/deviceId';

/**
 * SECURE WALLET SERVICE
 * 
 * All financial operations are server-side only.
 * Client never stores or manipulates balance locally.
 * All balance checks and updates go through Supabase RPC functions.
 */

export interface WalletBalance {
  wallet_id: string;
  available_balance: number;
  held_balance: number;
  total_balance: number;
}

export interface Transaction {
  id: string;
  transaction_type: string;
  amount: number;
  balance_after: number;
  status: string;
  metadata: any;
  created_at: string;
}

/**
 * Get user wallet balance from server
 * Never store balance locally - always fetch from server
 */
export async function getWalletBalance(): Promise<WalletBalance | null> {
  try {
    const { data, error } = await supabase.rpc('get_user_balance');
    
    if (error) {
      console.error('[SecureWallet] Error fetching balance:', error);
      return null;
    }
    
    return data as WalletBalance;
  } catch (error) {
    console.error('[SecureWallet] Exception fetching balance:', error);
    return null;
  }
}

/**
 * Process deposit (server-side only)
 * Called by Intasend webhook, not by client
 */
export async function processDeposit(
  amount: number,
  paymentId: string,
  metadata: any = {}
): Promise<{ success: boolean; error?: string; data?: any }> {
  try {
    const deviceId = await getOrCreateDeviceId();
    
    const { data, error } = await supabase.rpc('process_deposit', {
      p_amount: amount,
      p_payment_id: paymentId,
      p_metadata: metadata,
      p_device_id: deviceId
    });
    
    if (error) {
      return { success: false, error: error.message };
    }
    
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Request withdrawal (server-side validation)
 * Balance check happens server-side
 */
export async function requestWithdrawal(
  amount: number,
  phoneNumber: string
): Promise<{ success: boolean; error?: string; data?: any }> {
  try {
    const deviceId = await getOrCreateDeviceId();
    
    const { data, error } = await supabase.rpc('process_withdrawal', {
      p_amount: amount,
      p_phone_number: phoneNumber,
      p_device_id: deviceId
    });
    
    if (error) {
      return { success: false, error: error.message };
    }
    
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Lock stake amount (server-side validation)
 * Balance check happens server-side
 */
export async function lockStake(
  amount: number,
  gameId: string
): Promise<{ success: boolean; error?: string; data?: any }> {
  try {
    const deviceId = await getOrCreateDeviceId();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user?.id) {
      return { success: false, error: 'User not authenticated' };
    }
    
    const { data, error } = await supabase.rpc('lock_stake', {
      p_user_id: user.id,
      p_amount: amount,
      p_game_id: gameId,
      p_device_id: deviceId
    });
    
    if (error) {
      return { success: false, error: error.message };
    }
    
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Check if user has sufficient balance for stake (server-side)
 */
export async function canAffordStake(amount: number): Promise<boolean> {
  try {
    const balance = await getWalletBalance();
    if (!balance) return false;
    
    return balance.available_balance >= amount;
  } catch (error) {
    console.error('[SecureWallet] Error checking stake affordability:', error);
    return false;
  }
}

/**
 * Get transaction history from server
 */
export async function getTransactionHistory(
  transactionType?: string,
  limit: number = 50,
  offset: number = 0
): Promise<Transaction[]> {
  try {
    const { data, error } = await supabase.rpc('get_transaction_history', {
      p_transaction_type: transactionType || null,
      p_limit: limit,
      p_offset: offset
    });
    
    if (error) {
      console.error('[SecureWallet] Error fetching transaction history:', error);
      return [];
    }
    
    return data as Transaction[];
  } catch (error) {
    console.error('[SecureWallet] Exception fetching transaction history:', error);
    return [];
  }
}

/**
 * Format balance for display
 */
export function formatBalance(balance: number): string {
  return `KES ${balance.toFixed(2)}`;
}

/**
 * Validate withdrawal amount (client-side validation only)
 * Server-side validation is the authoritative check
 */
export function validateWithdrawalAmount(
  amount: number,
  availableBalance: number
): { valid: boolean; error?: string } {
  if (isNaN(amount) || amount <= 0) {
    return { valid: false, error: 'Invalid amount' };
  }
  
  if (amount < 10) {
    return { valid: false, error: 'Minimum withdrawal is KES 10' };
  }
  
  if (amount > availableBalance) {
    return { valid: false, error: `Insufficient balance. Available: KES ${availableBalance.toFixed(2)}` };
  }
  
  return { valid: true };
}
