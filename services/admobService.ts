import { AppState, AppStateStatus } from 'react-native';

let adsSupported = false;
let AppOpenAd: any = null;
let InterstitialAd: any = null;
let RewardedAd: any = null;
let BannerAdSize: any = { BANNER: 'BANNER', ADAPTIVE_BANNER: 'ADAPTIVE_BANNER' };
let TestIds: any = { APP_OPEN: '', INTERSTITIAL: '', REWARDED: '', BANNER: '' };
let AdEventType: any = { CLOSED: 'closed', ERROR: 'error', LOADED: 'loaded' };
let RewardedAdEventType: any = { EARNED_REWARD: 'earned_reward' };

try {
  const adsLib = require('react-native-google-mobile-ads');
  AppOpenAd = adsLib.AppOpenAd;
  InterstitialAd = adsLib.InterstitialAd;
  RewardedAd = adsLib.RewardedAd;
  BannerAdSize = adsLib.BannerAdSize;
  TestIds = adsLib.TestIds;
  AdEventType = adsLib.AdEventType;
  RewardedAdEventType = adsLib.RewardedAdEventType;
  adsSupported = true;
} catch (e) {
  console.warn('[AdMobService] Google Mobile Ads not loaded — mock mode active.', e);
}

// ── Ad Unit IDs ─────────────────────────────────────────────────────────────
// Use AdMob test IDs during development; replace with real IDs for production.
//
// ADMOB POLICY COMPLIANCE:
//   • Banner   — shown only on non-gameplay lobby / waiting / menu screens.
//   • App Open — 30-second cooldown; only on foreground resume.
//   • Interstitial — only on the natural game-over → menu transition.
//   • Rewarded — user-initiated; reward ONLY granted via EARNED_REWARD event.
//     Coins are NEVER granted without a completed ad view.
export const AD_UNIT_IDS = {
  appOpen:      __DEV__ ? (TestIds.APP_OPEN      || 'ca-app-pub-3940256099942544/9257395921')  : 'ca-app-pub-1258030992044122/9763713445',
  interstitial: __DEV__ ? (TestIds.INTERSTITIAL  || 'ca-app-pub-3940256099942544/1033173712') : 'ca-app-pub-1258030992044122/3661339529',
  rewarded:     __DEV__ ? (TestIds.REWARDED       || 'ca-app-pub-3940256099942544/5224354917') : 'ca-app-pub-1258030992044122/9380570064',
  banner:       __DEV__ ? (TestIds.BANNER         || 'ca-app-pub-3940256099942544/6300978111') : 'ca-app-pub-1258030992044122/5354072447',
};

export { BannerAdSize, adsSupported };

// ── Singleton ad service ─────────────────────────────────────────────────────
class AdMobService {
  private appOpenAd: any = null;
  private interstitialAd: any = null;
  private rewardedAd: any = null;
  private appStateSubscription: any = null;
  private appOpenCooldown = 0;
  private loading: Record<string, boolean> = { appOpen: false, interstitial: false, rewarded: false };

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  public init() {
    if (!adsSupported) {
      console.log('[AdMobService] Mock mode — native SDK not present');
      return;
    }
    try {
      this.loadAppOpenAd();
      this.loadInterstitialAd();
      this.loadRewardedAd();

      let lastState = AppState.currentState;
      this.appStateSubscription = AppState.addEventListener('change', (next: AppStateStatus) => {
        if (lastState.match(/inactive|background/) && next === 'active') {
          this.showAppOpenAd();
        }
        lastState = next;
      });
      console.log('[AdMobService] Initialized');
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
      const u1 = this.appOpenAd.addAdEventListener(AdEventType.CLOSED, () => {
        u1(); this.appOpenAd = null; this.loading.appOpen = false; this.loadAppOpenAd();
      });
      const u2 = this.appOpenAd.addAdEventListener(AdEventType.ERROR, (err: any) => {
        console.warn('[AdMobService] AppOpen error:', err);
        u2(); this.loading.appOpen = false;
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
      const u1 = this.interstitialAd.addAdEventListener(AdEventType.CLOSED, () => {
        u1(); this.interstitialAd = null; this.loading.interstitial = false; this.loadInterstitialAd();
      });
      const u2 = this.interstitialAd.addAdEventListener(AdEventType.ERROR, (err: any) => {
        console.warn('[AdMobService] Interstitial error:', err);
        u2(); this.loading.interstitial = false;
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
      const u1 = this.rewardedAd.addAdEventListener(AdEventType.ERROR, (err: any) => {
        console.warn('[AdMobService] Rewarded error:', err);
        u1(); this.loading.rewarded = false;
      });
      this.rewardedAd.load();
    } catch (e) {
      console.error('[AdMobService] Rewarded create error:', e);
      this.loading.rewarded = false;
    }
  }

  // ── Public show methods ────────────────────────────────────────────────────

  /** App Open ad — foreground resume with 30 s cooldown */
  public showAppOpenAd() {
    if (!adsSupported) return;
    const now = Date.now();
    if (now - this.appOpenCooldown < 30_000) return;
    if (this.appOpenAd?.loaded) {
      this.appOpenCooldown = now;
      this.appOpenAd.show();
    } else {
      this.loadAppOpenAd();
    }
  }

  /**
   * Interstitial — call only at natural break points (game-over → menu).
   * onClosed fires even if ad was not ready so navigation is never blocked.
   * ADMOB POLICY: Never shown during or immediately before gameplay.
   */
  public showInterstitialAd(onClosed?: () => void) {
    if (!adsSupported) { onClosed?.(); return; }
    if (this.interstitialAd?.loaded) {
      if (onClosed) {
        const u = this.interstitialAd.addAdEventListener(AdEventType.CLOSED, () => { u(); onClosed(); });
      }
      this.interstitialAd.show();
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
   *     (i.e. the user watched the full ad).
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
      const u1 = this.rewardedAd.addAdEventListener(
        RewardedAdEventType.EARNED_REWARD,
        (reward: any) => { u1(); onEarnedReward(reward.amount || 50); }
      );
      const u2 = this.rewardedAd.addAdEventListener(AdEventType.CLOSED, () => {
        u2();
        this.rewardedAd = null;
        this.loading.rewarded = false;
        this.loadRewardedAd();
        onClosed?.();
      });
      this.rewardedAd.show();
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
