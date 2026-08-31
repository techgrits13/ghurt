import * as SecureStore from 'expo-secure-store';
import { supabase } from '../supabaseClient';

/**
 * SECURE AUTH SERVICE
 * 
 * Uses Expo SecureStore for secure token storage
 * Never stores auth tokens in AsyncStorage or local state
 * All auth operations go through Supabase with secure token management
 */

const AUTH_TOKEN_KEY = 'ghurt_auth_token';
const REFRESH_TOKEN_KEY = 'ghurt_refresh_token';
const USER_SESSION_KEY = 'ghurt_user_session';

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  user: any;
}

/**
 * Store auth tokens securely using SecureStore
 */
export async function storeAuthTokens(session: AuthSession): Promise<void> {
  try {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, session.access_token);
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, session.refresh_token);
    await SecureStore.setItemAsync(USER_SESSION_KEY, JSON.stringify(session.user));
  } catch (error) {
    console.error('[SecureAuth] Error storing auth tokens:', error);
  }
}

/**
 * Retrieve auth tokens from SecureStore
 */
export async function getAuthTokens(): Promise<{ access_token: string | null; refresh_token: string | null }> {
  try {
    const access_token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    const refresh_token = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    return { access_token, refresh_token };
  } catch (error) {
    console.error('[SecureAuth] Error retrieving auth tokens:', error);
    return { access_token: null, refresh_token: null };
  }
}

/**
 * Clear auth tokens from SecureStore (logout)
 */
export async function clearAuthTokens(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_SESSION_KEY);
  } catch (error) {
    console.error('[SecureAuth] Error clearing auth tokens:', error);
  }
}

/**
 * Get stored user session
 */
export async function getUserSession(): Promise<any | null> {
  try {
    const sessionStr = await SecureStore.getItemAsync(USER_SESSION_KEY);
    if (sessionStr) {
      return JSON.parse(sessionStr);
    }
    return null;
  } catch (error) {
    console.error('[SecureAuth] Error retrieving user session:', error);
    return null;
  }
}

/**
 * Initialize auth session from stored tokens
 */
export async function initializeAuthSession(): Promise<any | null> {
  try {
    const { access_token, refresh_token } = await getAuthTokens();
    
    if (access_token && refresh_token) {
      // Set the session in Supabase
      const { data, error } = await supabase.auth.setSession({
        access_token,
        refresh_token
      });
      
      if (error) {
        console.error('[SecureAuth] Error setting session:', error);
        await clearAuthTokens();
        return null;
      }
      
      return data.user;
    }
    
    return null;
  } catch (error) {
    console.error('[SecureAuth] Error initializing auth session:', error);
    return null;
  }
}

/**
 * Login with email and password
 * Stores tokens securely after successful login
 */
export async function loginWithEmail(
  email: string,
  password: string
): Promise<{ success: boolean; error?: string; user?: any }> {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    
    if (error) {
      return { success: false, error: error.message };
    }
    
    if (data.session && data.user) {
      await storeAuthTokens({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user: data.user
      });
      
      return { success: true, user: data.user };
    }
    
    return { success: false, error: 'Login failed' };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Sign up with email and password
 * Stores tokens securely after successful signup
 */
export async function signUpWithEmail(
  email: string,
  password: string
): Promise<{ success: boolean; error?: string; user?: any }> {
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });
    
    if (error) {
      return { success: false, error: error.message };
    }
    
    if (data.user) {
      if (data.session) {
        // Auto-logged in
        await storeAuthTokens({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          user: data.user
        });
      }
      
      return { success: true, user: data.user };
    }
    
    return { success: false, error: 'Signup failed' };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Logout user
 * Clears tokens securely
 */
export async function logout(): Promise<{ success: boolean; error?: string }> {
  try {
    await supabase.auth.signOut();
    await clearAuthTokens();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Refresh auth token automatically
 * Called when token is about to expire
 */
export async function refreshToken(): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    
    if (error) {
      console.error('[SecureAuth] Error refreshing token:', error);
      await clearAuthTokens();
      return { success: false, error: error.message };
    }
    
    if (data.session) {
      await storeAuthTokens({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user: data.user
      });
      
      return { success: true };
    }
    
    return { success: false, error: 'Token refresh failed' };
  } catch (error: any) {
    console.error('[SecureAuth] Exception refreshing token:', error);
    await clearAuthTokens();
    return { success: false, error: error.message };
  }
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const { access_token } = await getAuthTokens();
    return access_token !== null;
  } catch (error) {
    return false;
  }
}
