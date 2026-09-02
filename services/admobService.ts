import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Native SDK lazy-load ─────────────────────────────────────────────────────
// All variables have safe fallback values so that the app never crashes when
// running in Expo Go, on Web, or when the native module is absent.

let adsSupported = false;
let AppOpenAd: any = null;
let InterstitialAd: any = null;
let RewardedAd: any = null;
let AdEventType: any = { CLOSED: 'closed', ERROR: 'error', LOADED: 'loaded' };
let RewardedAdEventType: any = { EARNED_REWARD: 'earned_reward' };

// BannerAdSize safe defaults — ADAPTIVE_BANNER must never be undefined.
// The crash (ArrayList.get(0) on an empty array) happens when size={undefined}
// is passed to the native BannerAdViewManager. We alias ADAPTIVE_BANNER to the
// correct ANCHORED_ADAPTIVE_BANNER constant and fall back to 'BANNER' string.
let BannerAdSize: any = {
  BANNER: 'BANNER',
  LARGE_BANNER: 'LARGE_BANNER',
  MEDIUM_RECTANGLE: 'MEDIUM_RECTANGLE',
  ANCHORED_ADAPTIVE_BANNER: 'ANCHORED_ADAPTIVE_BANNER',
  // Alias so any existing `BannerAdSize.ADAPTIVE_BANNER` reference never yields undefined
  ADAPTIVE_BANNER: 'ANCHORED_ADAPTIVE_BANNER',
};
let TestIds: any = { APP_OPEN: '', INTERSTITIAL: '', REWARDED: '', BANNER: '' };

let mobileAds: any = null;

try {
  const adsLib = require('react-native-google-mobile-ads');
  mobileAds = adsLib.default ?? adsLib;
  AppOpenAd = adsLib.AppOpenAd;
  InterstitialAd = adsLib.InterstitialAd;
  RewardedAd = adsLib.RewardedAd;
  AdEventType = adsLib.AdEventType;
  RewardedAdEventType = adsLib.RewardedAdEventType;
  TestIds = adsLib.TestIds;

  // Merge library values over our safe defaults, preserving the ADAPTIVE_BANNER alias
  const libSize = adsLib.BannerAdSize ?? {};
  BannerAdSize = {
    ...BannerAdSize,   // safe defaults first
    ...libSize,        // real values overwrite where present
    // Ensure ADAPTIVE_BANNER always resolves to a valid size string
    ADAPTIVE_BANNER:
      libSize.ANCHORED_ADAPTIVE_BANNER ??
      libSize.ADAPTIVE_BANNER ??
      libSize.BANNER ??
      'ANCHORED_ADAPTIVE_BANNER',
  };

  adsSupported = true;
} catch (e) {
  console.warn('[AdMobService] Google Mobile Ads not loaded — mock mode active.', e);
}

// ── Real Production Ad Unit IDs ──────────────────────────────────────────────
// ADMOB POLICY COMPLIANCE:
//   • Banner        — shown only on non-gameplay lobby / waiting / menu screens.
//   • App Open      — shown on cold-start and foreground resume; 2-HOUR cooldown;
//                     never during active gameplay; ad expires and is reloaded if
//                     held in memory > 4 hours (AdMob policy limit).
//   • Interstitial  — only at natural break points (game-over → menu).
//   • Rewarded      — strictly user-initiated; coins granted ONLY via EARNED_REWARD.
export const AD_UNIT_IDS = {
  appOpen:      'ca-app-pub-1258030992044122/9763713445',
  interstitial: 'ca-app-pub-1258030992044122/3661339529',
  rewarded:     'ca-app-pub-1258030992044122/9380570064',
  banner:       'ca-app-pub-1258030992044122/5354072447',
};

export { BannerAdSize, adsSupported };

// ── Constants ────────────────────────────────────────────────────────────────
const APP_OPEN_COOLDOWN_MS  = 2 * 60 * 60 * 1000; // 2 hours (AdMob policy cap)
const APP_OPEN_EXPIRY_MS    = 4 * 60 * 60 * 1000; // 4 hours (AdMob max ad age)
const ASYNC_KEY_LAST_OPEN   = '@ghurt_last_appopen_ts';

// ── Singleton ad service ─────────────────────────────────────────────────────
class AdMobService {
  private appOpenAd:      any = null;
  private interstitialAd: any = null;
  private rewardedAd:     any = null;
  private appStateSubscription: any = null;

  // Timestamps
  private appOpenLastShownAt  = 0; // in-memory mirror of AsyncStorage value
  private appOpenLoadedAt     = 0; // when the current loaded ad was fetched

  // Guards
  private isInActiveGame = false;
  private loading: Record<string, boolean> = {
    appOpen: false, interstitial: false, rewarded: false,
  };

  // ── Public: let App.tsx signal game state ──────────────────────────────────
  public setInActiveGame(value: boolean) {
    this.isInActiveGame = value;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  public async init() {
    if (!adsSupported) {
      console.log('[AdMobService] Mock mode — native SDK not present');
      return;
    }
    try {
      if (typeof mobileAds === 'function') {
        await mobileAds().initialize().catch((e: any) => console.warn('[AdMobService] SDK initialize non-blocking warning:', e));
      }

      // Restore last-shown timestamp from storage
      const stored = await AsyncStorage.getItem(ASYNC_KEY_LAST_OPEN);
      if (stored) this.appOpenLastShownAt = parseInt(stored, 10) || 0;

      // Preload all ad types
      this.loadAppOpenAd();
      this.loadInterstitialAd();
      this.loadRewardedAd();

      // Listen for foreground resume
      let lastState = AppState.currentState;
      this.appStateSubscription = AppState.addEventListener('change', (next: AppStateStatus) => {
        if (lastState.match(/inactive|background/) && next === 'active') {
          this.showAppOpenAd();
        }
        lastState = next;
      });

      console.log('[AdMobService] Initialized — 2h App Open cap active');
    } catch (e) {
      console.error('[AdMobService] Init failed:', e);
    }
  }

  public destroy() {
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  // ── Loaders ────────────────────────────────────────────────────────────────
  private loadAppOpenAd() {
    if (!adsSupported || this.loading.appOpen) return;
    try {
      this.loading.appOpen = true;
      this.appOpenAd = AppOpenAd.createForAdRequest(AD_UNIT_IDS.appOpen);

      const uClosed = this.appOpenAd.addAdEventListener(AdEventType.CLOSED, () => {
        uClosed();
        this.appOpenAd = null;
        this.loading.appOpen = false;
        // Immediately preload the next ad so it is ready for the next 2h window
        this.loadAppOpenAd();
      });

      const uLoaded = this.appOpenAd.addAdEventListener(AdEventType.LOADED, () => {
        uLoaded();
        // Record when this ad was loaded — used for 4-hour expiry check
        this.appOpenLoadedAt = Date.now();
      });

      const uError = this.appOpenAd.addAdEventListener(AdEventType.ERROR, (err: any) => {
        console.warn('[AdMobService] AppOpen load error:', err?.message ?? err);
        uError();
        this.appOpenAd = null;
        this.loading.appOpen = false;
        // Retry after 60 seconds on error
        setTimeout(() => this.loadAppOpenAd(), 60_000);
      });

      this.appOpenAd.load();
    } catch (e) {
      console.error('[AdMobService] AppOpen create error:', e);
      this.loading.appOpen = false;
    }
  }

  private loadInterstitialAd() {
    if (!adsSupported || this.loading.interstitial) return;
    try {
      this.loading.interstitial = true;
      this.interstitialAd = InterstitialAd.createForAdRequest(AD_UNIT_IDS.interstitial);

      const uClosed = this.interstitialAd.addAdEventListener(AdEventType.CLOSED, () => {
        uClosed();
        this.interstitialAd = null;
        this.loading.interstitial = false;
        this.loadInterstitialAd();
      });

      const uError = this.interstitialAd.addAdEventListener(AdEventType.ERROR, (err: any) => {
        console.warn('[AdMobService] Interstitial load error:', err?.message ?? err);
        uError();
        this.loading.interstitial = false;
      });

      this.interstitialAd.load();
    } catch (e) {
      console.error('[AdMobService] Interstitial create error:', e);
      this.loading.interstitial = false;
    }
  }

  private loadRewardedAd() {
    if (!adsSupported || this.loading.rewarded) return;
    try {
      this.loading.rewarded = true;
      this.rewardedAd = RewardedAd.createForAdRequest(AD_UNIT_IDS.rewarded);

      const uError = this.rewardedAd.addAdEventListener(AdEventType.ERROR, (err: any) => {
        console.warn('[AdMobService] Rewarded load error:', err?.message ?? err);
        uError();
        this.loading.rewarded = false;
      });

      this.rewardedAd.load();
    } catch (e) {
      console.error('[AdMobService] Rewarded create error:', e);
      this.loading.rewarded = false;
    }
  }

  // ── Public show methods ────────────────────────────────────────────────────

  /**
   * App Open ad — enforces:
   *   1. 2-hour cooldown (persisted across restarts via AsyncStorage).
   *   2. 4-hour ad expiry: if the cached ad is stale, reload instead of showing.
   *   3. Never shown during active gameplay.
   *
   * @param onWillShow  Called just before the ad appears (use to block UI touches).
   * @param onDidClose  Called when the ad is dismissed (use to unblock UI touches).
   */
  public async showAppOpenAd(
    onWillShow?: () => void,
    onDidClose?: () => void,
  ): Promise<void> {
    if (!adsSupported || this.isInActiveGame) {
      onDidClose?.();
      return;
    }

    const now = Date.now();

    // ── Cooldown check (2 hours) ──
    if (now - this.appOpenLastShownAt < APP_OPEN_COOLDOWN_MS) {
      console.log('[AdMobService] AppOpen skipped — within 2h cooldown');
      onDidClose?.();
      return;
    }

    // ── 4-hour expiry check ──
    const adAge = now - this.appOpenLoadedAt;
    if (this.appOpenAd?.loaded && adAge > APP_OPEN_EXPIRY_MS) {
      console.log('[AdMobService] AppOpen ad expired (>4h) — reloading');
      this.appOpenAd = null;
      this.loading.appOpen = false;
      this.loadAppOpenAd();
      onDidClose?.();
      return;
    }

    if (this.appOpenAd?.loaded) {
      // Record shown timestamp BEFORE showing so even if show() throws we don't spam
      this.appOpenLastShownAt = now;
      await AsyncStorage.setItem(ASYNC_KEY_LAST_OPEN, String(now)).catch(() => {});

      try {
        // Attach onDidClose listener for this specific show
        const uClosed = this.appOpenAd.addAdEventListener(AdEventType.CLOSED, () => {
          uClosed();
          onDidClose?.();
        });

        onWillShow?.();
        this.appOpenAd.show();
      } catch (e) {
        console.error('[AdMobService] AppOpen show error:', e);
        onDidClose?.();
      }
    } else {
      // Ad not ready yet — trigger a load for next opportunity
      this.loadAppOpenAd();
      onDidClose?.();
    }
  }

  /**
   * Interstitial — call only at natural break points (game-over → menu).
   * onClosed fires even when the ad was not ready so navigation is never blocked.
   * ADMOB POLICY: Never shown during or immediately before gameplay.
   */
  public showInterstitialAd(onClosed?: () => void) {
    if (!adsSupported) { onClosed?.(); return; }
    if (this.interstitialAd?.loaded) {
      if (onClosed) {
        const u = this.interstitialAd.addAdEventListener(AdEventType.CLOSED, () => {
          u(); onClosed();
        });
      }
      try {
        this.interstitialAd.show();
      } catch (e) {
        console.error('[AdMobService] Interstitial show error:', e);
        onClosed?.();
      }
    } else {
      this.loadInterstitialAd();
      onClosed?.();
    }
  }

  /**
   * Rewarded ad — strictly user-initiated.
   *
   * ADMOB POLICY COMPLIANCE:
   *   • Reward is ONLY granted when AdMob fires the EARNED_REWARD event
   *     (i.e. the user watched the full ad to completion).
   *   • Coins are NEVER given when the SDK is unavailable (no mock reward).
   *   • onNotAvailable() is called so the UI can show a "try again" message.
   *
   * Each EARNED_REWARD event gives `reward.amount` coins (configured in AdMob
   * dashboard — typically 50). Two ads = 100 coins total.
   */
  public showRewardedAd(
    onEarnedReward: (amount: number) => void,
    onClosed?: () => void,
    onNotAvailable?: () => void,
  ) {
    if (!adsSupported) {
      console.warn('[AdMobService] Rewarded ad unavailable — native SDK not loaded');
      onNotAvailable?.();
      onClosed?.();
      return;
    }

    if (this.rewardedAd?.loaded) {
      // Track whether reward was actually earned (user completed full ad)
      let rewardEarned = false;

      const u1 = this.rewardedAd.addAdEventListener(
        RewardedAdEventType.EARNED_REWARD,
        (reward: any) => {
          u1();
          rewardEarned = true;
          onEarnedReward(reward?.amount || 50);
        },
      );

      const u2 = this.rewardedAd.addAdEventListener(AdEventType.CLOSED, () => {
        u2();
        this.rewardedAd = null;
        this.loading.rewarded = false;
        this.loadRewardedAd(); // preload next immediately
        // Only fire onClosed — reward was already fired above if earned
        onClosed?.();
        if (!rewardEarned) {
          console.log('[AdMobService] Rewarded ad closed without completion — no reward.');
        }
      });

      try {
        this.rewardedAd.show();
      } catch (e) {
        console.error('[AdMobService] Rewarded show error:', e);
        u1(); u2();
        onNotAvailable?.();
        onClosed?.();
      }
    } else {
      this.loadRewardedAd();
      console.warn('[AdMobService] Rewarded ad not ready — reload triggered');
      onNotAvailable?.();
      onClosed?.();
    }
  }

  /** True when a rewarded ad is pre-loaded and ready to display */
  public isRewardedAdReady(): boolean {
    return adsSupported && this.rewardedAd?.loaded === true;
  }
}

export const admobService = new AdMobService();
