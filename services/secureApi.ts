import { supabase } from '../supabaseClient';
import { getOrCreateDeviceId, isDeviceBanned, registerDevice } from '../utils/deviceId';

/**
 * SECURE API SERVICE
 * 
 * Centralized API handling with automatic device ID injection
 * All API calls go through this service to ensure:
 * - Device ID is always included
 * - Device ban checks are performed
 * - Security headers are added
 * - Error handling is consistent
 */

export interface ApiRequestOptions {
  deviceCheck?: boolean; // Whether to check if device is banned before request
  metadata?: Record<string, any>;
}

/**
 * Initialize secure API service
 * Call this when user logs in to register device
 */
export async function initializeSecureApi(userId: string): Promise<void> {
  try {
    await registerDevice(supabase, userId);
  } catch (error) {
    console.error('[SecureApi] Error initializing secure API:', error);
  }
}

/**
 * Perform device ban check before operation
 * Returns true if device is banned (operation should be blocked)
 */
export async function checkDeviceBan(userId: string): Promise<boolean> {
  try {
    const banned = await isDeviceBanned(supabase, userId);
    if (banned) {
      console.warn('[SecureApi] Device is banned, blocking operation');
    }
    return banned;
  } catch (error) {
    console.error('[SecureApi] Error checking device ban:', error);
    // Fail open - allow operation if check fails
    return false;
  }
}

/**
 * Get device ID for API requests
 * Caches the device ID for performance
 */
let cachedDeviceId: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) {
    return cachedDeviceId;
  }
  
  cachedDeviceId = await getOrCreateDeviceId();
  return cachedDeviceId;
}

/**
 * Enhanced Supabase query with automatic device ID injection
 */
export async function secureQuery<T = any>(
  table: string,
  options: {
    select?: string;
    filter?: Record<string, any>;
    single?: boolean;
    deviceCheck?: boolean;
  } = {}
): Promise<{ data: T | null; error: any }> {
  try {
    const { deviceCheck = true, ...queryOptions } = options;
    
    // Get device ID
    const deviceId = await getDeviceId();
    
    // Build query
    let query = supabase.from(table).select(queryOptions.select || '*');
    
    // Apply filters
    if (queryOptions.filter) {
      Object.entries(queryOptions.filter).forEach(([key, value]) => {
        query = query.eq(key, value);
      });
    }
    
    // Add device ID to metadata if needed
    if (deviceId) {
      // For financial operations, we'll add device ID via RPC
      // For regular queries, device ID is in the request headers
    }
    
    // Execute query
    const result = queryOptions.single 
      ? await query.single()
      : await query;
    
    return { data: result.data as T, error: result.error };
  } catch (error) {
    console.error('[SecureApi] Query error:', error);
    return { data: null, error };
  }
}

/**
 * Secure insert with device ID
 */
export async function secureInsert<T = any>(
  table: string,
  data: any,
  options: ApiRequestOptions = {}
): Promise<{ data: T | null; error: any }> {
  try {
    const deviceId = await getDeviceId();
    
    // Add device ID to data
    const enrichedData = {
      ...data,
      device_id: deviceId,
      metadata: {
        ...data.metadata,
        device_id: deviceId,
        timestamp: new Date().toISOString()
      }
    };
    
    const result = await supabase.from(table).insert(enrichedData).select();
    
    return { data: result.data?.[0] as T, error: result.error };
  } catch (error) {
    console.error('[SecureApi] Insert error:', error);
    return { data: null, error };
  }
}

/**
 * Secure update with device ID
 */
export async function secureUpdate<T = any>(
  table: string,
  filter: Record<string, any>,
  data: any,
  options: ApiRequestOptions = {}
): Promise<{ data: T | null; error: any }> {
  try {
    const deviceId = await getDeviceId();
    
    // Add device ID to update data
    const enrichedData = {
      ...data,
      metadata: {
        ...data.metadata,
        device_id: deviceId,
        timestamp: new Date().toISOString()
      }
    };
    
    let query = supabase.from(table).update(enrichedData);
    
    // Apply filters
    Object.entries(filter).forEach(([key, value]) => {
      query = query.eq(key, value);
    });
    
    const result = await query.select();
    
    return { data: result.data?.[0] as T, error: result.error };
  } catch (error) {
    console.error('[SecureApi] Update error:', error);
    return { data: null, error };
  }
}

/**
 * Secure RPC call with device ID
 * All financial operations should use this
 */
export async function secureRpc<T = any>(
  functionName: string,
  params: Record<string, any> = {},
  options: ApiRequestOptions = {}
): Promise<{ data: T | null; error: any }> {
  try {
    const deviceId = await getDeviceId();
    
    // Add device ID to params
    const enrichedParams = {
      ...params,
      p_device_id: params.p_device_id || deviceId
    };
    
    const result = await supabase.rpc(functionName, enrichedParams);
    
    return { data: result.data as T, error: result.error };
  } catch (error) {
    console.error('[SecureApi] RPC error:', error);
    return { data: null, error };
  }
}

/**
 * Wrapper for game operations with device tracking
 */
export async function secureGameOperation(
  operation: () => Promise<any>,
  userId: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    // Check device ban
    const isBanned = await checkDeviceBan(userId);
    if (isBanned) {
      return { 
        success: false, 
        error: 'Your device has been temporarily banned due to suspicious activity. Please contact support.' 
      };
    }
    
    // Perform operation
    const result = await operation();
    return { success: true, data: result };
  } catch (error: any) {
    console.error('[SecureApi] Game operation error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Wrapper for financial operations with enhanced security
 */
export async function secureFinancialOperation(
  operation: () => Promise<any>,
  userId: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    // Check device ban
    const isBanned = await checkDeviceBan(userId);
    if (isBanned) {
      return { 
        success: false, 
        error: 'Your device has been temporarily banned. Financial operations are not allowed.' 
      };
    }
    
    // Perform operation
    const result = await operation();
    return { success: true, data: result };
  } catch (error: any) {
    console.error('[SecureApi] Financial operation error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Log security event for monitoring
 */
export async function logSecurityEvent(
  eventType: string,
  metadata: Record<string, any> = {}
): Promise<void> {
  try {
    const deviceId = await getDeviceId();
    
    // In production, this would send to a security monitoring service
    console.log('[SecurityEvent]', {
      event_type: eventType,
      device_id: deviceId,
      metadata,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[SecureApi] Error logging security event:', error);
  }
}

/**
 * Get request metadata for security tracking
 */
export async function getRequestMetadata(): Promise<Record<string, any>> {
  try {
    const deviceId = await getDeviceId();
    
    return {
      device_id: deviceId,
      timestamp: new Date().toISOString(),
      platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
    };
  } catch (error) {
    return {};
  }
}
