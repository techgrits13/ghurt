import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const DEVICE_ID_KEY = 'ghurt_device_id';

/**
 * Gets or creates a unique device ID for fraud detection
 * This ID persists across app installations and is used for:
 * - Detecting device conflicts (multiple users claiming wins from same device)
 * - Fraud detection and prevention
 * - Security auditing
 */
export async function getOrCreateDeviceId(): Promise<string> {
  try {
    // Try to get existing device ID
    const existingDeviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    
    if (existingDeviceId) {
      return existingDeviceId;
    }
    
    // Generate new device ID if none exists
    const newDeviceId = generateDeviceId();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, newDeviceId);
    return newDeviceId;
  } catch (error) {
    console.error('[DeviceId] Error getting/creating device ID:', error);
    // Fallback to a session-based ID if SecureStore fails
    return generateDeviceId();
  }
}

/**
 * Generates a unique device ID using multiple factors
 */
function generateDeviceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 15);
  const platform = typeof navigator !== 'undefined' ? navigator.platform : 'unknown';
  return `${platform}_${timestamp}_${random}`;
}

/**
 * Gets device info for security tracking
 */
export async function getDeviceInfo(): Promise<Record<string, string>> {
  try {
    const deviceId = await getOrCreateDeviceId();
    
    return {
      device_id: deviceId,
      platform: Platform.OS,
      os_version: Platform.Version?.toString() || 'unknown',
      app_version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[DeviceId] Error getting device info:', error);
    return {};
  }
}

/**
 * Registers device with server for tracking
 * Call this when user logs in or signs up
 */
export async function registerDevice(supabase: any, userId: string): Promise<void> {
  try {
    const deviceInfo = await getDeviceInfo();
    const deviceId = deviceInfo.device_id;
    
    if (!deviceId) return;
    
    // Check if device is already registered
    const { data: existingDevice } = await supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .single();
    
    if (existingDevice) {
      // Update last_seen
      await supabase
        .from('user_devices')
        .update({ 
          last_seen: new Date().toISOString(),
          device_info: deviceInfo 
        })
        .eq('id', existingDevice.id);
    } else {
      // Register new device
      await supabase
        .from('user_devices')
        .insert({
          user_id: userId,
          device_id: deviceId,
          device_info: deviceInfo,
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString(),
        });
    }
  } catch (error) {
    console.error('[DeviceId] Error registering device:', error);
  }
}

/**
 * Checks if device is banned before allowing operations
 */
export async function isDeviceBanned(supabase: any, userId: string): Promise<boolean> {
  try {
    const deviceInfo = await getDeviceInfo();
    const deviceId = deviceInfo.device_id;
    
    if (!deviceId) return false;
    
    const { data: device } = await supabase
      .from('user_devices')
      .select('is_banned, ban_until')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .single();
    
    if (!device || !device.is_banned) return false;
    
    // Check if ban has expired
    if (device.ban_until && new Date(device.ban_until) < new Date()) {
      // Auto-unban if expired
      await supabase
        .from('user_devices')
        .update({ 
          is_banned: false, 
          ban_until: null,
          ban_reason: null 
        })
        .eq('user_id', userId)
        .eq('device_id', deviceId);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('[DeviceId] Error checking device ban status:', error);
    return false;
  }
}

/**
 * Gets all devices for a user (for admin dashboard)
 */
export async function getUserDevices(supabase: any, userId: string) {
  try {
    const { data, error } = await supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .order('last_seen', { ascending: false });
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[DeviceId] Error getting user devices:', error);
    return [];
  }
}
