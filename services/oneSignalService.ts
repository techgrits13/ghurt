import { OneSignal, NotificationWillDisplayEvent, NotificationClickEvent } from 'react-native-onesignal';
import { supabase } from '../supabaseClient';

const ONESIGNAL_APP_ID = '3bba4559-2eaf-4eb1-a9a2-3978bdd444af';

// ─── Types ───────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'game_request'
  | 'game_request_accepted'
  | 'game_request_declined'
  | 'admin';

export interface GameRequestPayload {
  type: 'game_request';
  from_user_id: string;
  from_username: string;
  from_avatar_url?: string;
  game_mode: string;
  request_id: string;
}

export interface GameRequestResponsePayload {
  type: 'game_request_accepted' | 'game_request_declined';
  from_user_id: string;
  from_username: string;
  request_id: string;
}

export interface AdminPayload {
  type: 'admin';
  message: string;
}

export type NotificationPayload =
  | GameRequestPayload
  | GameRequestResponsePayload
  | AdminPayload;

// ─── Service ─────────────────────────────────────────────────────────────────

class OneSignalService {
  private initialized = false;
  private openHandlers: Array<(payload: NotificationPayload) => void> = [];
  private fgHandler: ((event: NotificationWillDisplayEvent) => void) | null = null;
  private clickHandler: ((event: NotificationClickEvent) => void) | null = null;

  /** Call once at app startup */
  init() {
    if (this.initialized) return;
    this.initialized = true;

    OneSignal.initialize(ONESIGNAL_APP_ID);

    // Request push permission on first launch (shows native OS prompt)
    OneSignal.Notifications.requestPermission(true);

    // Show notifications when app is in foreground
    this.fgHandler = (event: NotificationWillDisplayEvent) => {
      event.getNotification().display();
    };
    OneSignal.Notifications.addEventListener('foregroundWillDisplay', this.fgHandler);

    // Handle notification tap (app opened from background/killed via push)
    this.clickHandler = (event: NotificationClickEvent) => {
      const data = event.notification.additionalData as NotificationPayload | undefined;
      if (data) {
        this.openHandlers.forEach((handler) => handler(data));
      }
    };
    OneSignal.Notifications.addEventListener('click', this.clickHandler);

    console.log('[OneSignal] Initialized');
  }

  /** Link OneSignal subscription to the logged-in Supabase user */
  async setExternalUserId(userId: string) {
    try {
      OneSignal.login(userId);

      // Persist the OneSignal subscription ID server-side for admin sends
      const playerId = await this.getPlayerId();
      if (playerId) {
        await supabase.from('push_tokens').upsert(
          {
            user_id: userId,
            onesignal_player_id: playerId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        );
      }
    } catch (err) {
      console.warn('[OneSignal] setExternalUserId error:', err);
    }
  }

  /** Unlink user on sign-out */
  logout() {
    try {
      OneSignal.logout();
    } catch (_) {}
  }

  /** Get the current OneSignal subscription/player ID */
  async getPlayerId(): Promise<string | null> {
    try {
      const id = await OneSignal.User.pushSubscription.getIdAsync();
      return id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Send a game-request push to another player.
   * Calls a Supabase RPC which forwards to OneSignal REST API server-side
   * (so the REST API key is never exposed in the client bundle).
   */
  async sendGameRequest(params: {
    targetUserId: string;
    fromUserId: string;
    fromUsername: string;
    fromAvatarUrl?: string;
    gameMode: string;
    requestId: string;
  }): Promise<boolean> {
    try {
      const { data, error } = await supabase.rpc('send_game_request_notification', {
        p_target_user_id: params.targetUserId,
        p_from_user_id: params.fromUserId,
        p_from_username: params.fromUsername,
        p_from_avatar_url: params.fromAvatarUrl ?? null,
        p_game_mode: params.gameMode,
        p_request_id: params.requestId,
      });

      if (error) {
        console.warn('[OneSignal] sendGameRequest RPC error:', error.message);
        return false;
      }
      return data === true;
    } catch (err) {
      console.warn('[OneSignal] sendGameRequest error:', err);
      return false;
    }
  }

  /**
   * Send an accept/decline response notification back to the challenger.
   */
  async sendGameRequestResponse(params: {
    targetUserId: string;
    fromUserId: string;
    fromUsername: string;
    requestId: string;
    accepted: boolean;
  }): Promise<boolean> {
    try {
      const { data, error } = await supabase.rpc('send_game_response_notification', {
        p_target_user_id: params.targetUserId,
        p_from_user_id: params.fromUserId,
        p_from_username: params.fromUsername,
        p_request_id: params.requestId,
        p_accepted: params.accepted,
      });

      if (error) {
        console.warn('[OneSignal] sendGameRequestResponse RPC error:', error.message);
        return false;
      }
      return data === true;
    } catch (err) {
      console.warn('[OneSignal] sendGameRequestResponse error:', err);
      return false;
    }
  }

  /**
   * Register a callback that fires when the user taps a push notification.
   * Returns an unsubscribe function.
   */
  onNotificationOpen(handler: (payload: NotificationPayload) => void): () => void {
    this.openHandlers.push(handler);
    return () => {
      this.openHandlers = this.openHandlers.filter((h) => h !== handler);
    };
  }
}

export const oneSignalService = new OneSignalService();
