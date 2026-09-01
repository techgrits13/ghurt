import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, Animated, FlatList, BackHandler, Alert, AppState, Image } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from './supabaseClient';
import { getDeviceInfo, registerDevice } from './utils/deviceId';
import { admobService, AD_UNIT_IDS, BannerAdSize, adsSupported as adsSupportedNative } from './services/admobService';
import { oneSignalService } from './services/oneSignalService';

// Lazy-load the Banner component â€” only imports when native SDK is present
// (avoids crash on Web / Expo Go where the module is unavailable)
let BannerAd: any = null;
try {
  const adsLib = require('react-native-google-mobile-ads');
  BannerAd = adsLib.BannerAd;
} catch (_) {}

WebBrowser.maybeCompleteAuthSession();

// Error boundary to catch and log crashes
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    console.error('[ErrorBoundary] Caught error:', error);
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Error info:', errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorMessage}>{this.state.error?.message || 'Unknown error'}</Text>
          <TouchableOpacity style={styles.errorButton} onPress={() => this.setState({ hasError: false, error: null })}>
            <Text style={styles.errorButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}
import { 
  GameState, 
  Card, 
  initializeGame, 
  playCard, 
  drawCard, 
  getCurrentPlayer, 
  getTopCard, 
  isGameOver, 
  getGameSummary,
  canPlayCard,
  Suit,
  playCards,
  calculateElo,
  removePlayerFromGame
} from './gameLogic';
import { getRandomBotProfile, getMultipleBotProfiles, getBotDecision, executeBotDecision, BotProfile } from './botAI';
import { GhurtMCTSEngine } from './mctsAI';
import { VoiceRoomManager } from './voiceRoom';
import { RTCView } from 'react-native-webrtc';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DiceBear Avatar Styles & Profile Card Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DICEBEAR_STYLES = [
  { id: 'bottts', label: 'ðŸ¤– Robots' },
  { id: 'adventurer', label: 'âš”ï¸ Adventurers' },
  { id: 'avataaars', label: 'ðŸ‘¤ Avataaars' },
  { id: 'fun-emoji', label: 'ðŸ˜œ Emojis' },
  { id: 'lorelei', label: 'âœ¨ Anime' },
  { id: 'pixel-art', label: 'ðŸ‘¾ Pixel Art' },
  { id: 'notionists', label: 'ðŸŽ¨ Notion' },
  { id: 'big-smile', label: 'ðŸ˜„ Big Smile' }
];

type MatchHistoryEntry = { id: string; playerName: string; cards: Card[]; action: 'played' | 'drew'; createdAt: number };

const getDiceBearUrl = (avatarId: string | undefined, defaultSeed: string = 'player') => {
  if (!avatarId) return `https://api.dicebear.com/9.x/bottts/png?seed=${defaultSeed}`;
  if (avatarId.includes(':')) {
    const [style, seed] = avatarId.split(':');
    return `https://api.dicebear.com/9.x/${style || 'bottts'}/png?seed=${encodeURIComponent(seed || defaultSeed)}`;
  }
  // Fallback for legacy numeric IDs
  return `https://api.dicebear.com/9.x/bottts/png?seed=${avatarId || defaultSeed}`;
};

const getRankStars = (elo: number): string => {
  if (elo < 100) return 'â­';
  if (elo < 300) return 'â­â­';
  if (elo < 600) return 'â­â­â­';
  if (elo < 1000) return 'â­â­â­â­';
  if (elo < 1500) return 'â­â­â­â­â­';
  if (elo < 2100) return 'ðŸŒŸðŸŒŸðŸŒŸðŸŒŸðŸŒŸ';
  if (elo < 2800) return 'ðŸ‘‘ðŸ‘‘ðŸ‘‘ðŸ‘‘';
  return 'ðŸ‘‘ðŸ‘‘ðŸ‘‘ðŸ‘‘ðŸ‘‘';
};

const calculateWinRate = (wins: number = 0, losses: number = 0): string => {
  const total = wins + losses;
  if (total === 0) return '0%';
  return `${Math.round((wins / total) * 100)}%`;
};

const ProfileCard = ({ user, style: containerStyle }: { user: any, style?: any }) => {
  const avatarUrl = getDiceBearUrl(user.avatar_id || user.avatarId, user.username || user.display_name || user.name || 'player');
  const displayName = user.display_name || user.displayName || user.name || 'Player';
  const username = user.username ? `@${user.username}` : (user.email ? `@${user.email.split('@')[0]}` : '@player');
  const elo = typeof user.elo === 'number' ? user.elo : 0;
  const balance = typeof user.balance === 'number' ? user.balance : (user.balance ? Number(user.balance) : 1500);
  const wins = typeof user.wins === 'number' ? user.wins : 0;
  const losses = typeof user.losses === 'number' ? user.losses : 0;
  
  const getRankName = (eloVal: number) => {
    if (eloVal < 100) return 'Private';
    if (eloVal < 300) return 'Corporal';
    if (eloVal < 600) return 'Sergeant';
    if (eloVal < 1000) return 'Lieutenant';
    if (eloVal < 1500) return 'Captain';
    if (eloVal < 2100) return 'Major';
    if (eloVal < 2800) return 'Colonel';
    return 'General';
  };

  const rank = getRankName(elo);
  const stars = getRankStars(elo);
  const winRate = calculateWinRate(wins, losses);

  return (
    <View style={[{
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
      borderRadius: 16,
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.15)',
      padding: 14,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      marginVertical: 6,
    }, containerStyle]}>
      {/* Left side: DiceBear Avatar */}
      <View style={{
        width: 72,
        height: 72,
        borderRadius: 36,
        backgroundColor: 'rgba(138, 43, 226, 0.25)',
        borderWidth: 2,
        borderColor: '#9c27b0',
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden'
      }}>
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: 68, height: 68, borderRadius: 34 }}
          resizeMode="cover"
        />
      </View>

      {/* Right side: Player Info */}
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#fff', fontSize: 17, fontWeight: 'bold' }} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={{ color: '#e040fb', fontSize: 13, fontWeight: '600', marginBottom: 2 }}>
          {username}
        </Text>
        <Text style={{ color: '#f1c40f', fontSize: 13, fontWeight: 'bold' }}>
          ðŸ’° Net Worth: {balance.toLocaleString()} Coins
        </Text>
        <Text style={{ color: 'rgba(255, 255, 255, 0.85)', fontSize: 12, marginTop: 2 }}>
          ðŸŽ–ï¸ Rank: {rank}
        </Text>
        <Text style={{ fontSize: 12, marginTop: 1 }}>
          {stars}
        </Text>
        <Text style={{ color: '#4ade80', fontSize: 12, fontWeight: '600', marginTop: 2 }}>
          ðŸ† Win Rate: {winRate} ({wins}W / {losses}L)
        </Text>
      </View>
    </View>
  );
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Custom In-App Error / Alert Component
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface AlertModalProps {
  visible: boolean;
  title: string;
  message: string;
  onClose: () => void;
  type?: 'error' | 'info' | 'warning';
}

function AlertModal({ visible, title, message, onClose, type = 'info' }: AlertModalProps) {
  if (!visible) return null;
  const colorMap = { error: '#e74c3c', info: '#3498db', warning: '#f1c40f' };
  const accent = colorMap[type];
  return (
    <View style={styles.modalOverlay}>
      <View style={[styles.alertCard, { borderTopColor: accent }]}>
        <Text style={[styles.alertTitle, { color: accent }]}>{title}</Text>
        <Text style={styles.alertMessage}>{message}</Text>
        <TouchableOpacity style={[styles.alertButton, { backgroundColor: accent }]} onPress={onClose}>
          <Text style={styles.alertButtonText}>OK</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Bot count selector
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface BotCountModalProps {
  visible: boolean;
  onSelect: (count: number, difficulty: 'easy' | 'medium' | 'hard') => void;
  onClose: () => void;
}
function BotCountModal({ visible, onSelect, onClose }: BotCountModalProps) {
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  if (!visible) return null;
  return (
    <View style={styles.modalOverlay}>
      <View style={styles.modalCard}>
        <Text style={styles.modalTitle}>Select AI Opponents</Text>
        <Text style={styles.rulesText}>Choose difficulty & number of bots to play offline</Text>
        
        {/* Difficulty Selection */}
        <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 4, marginVertical: 14 }}>
          {(['easy', 'medium', 'hard'] as const).map(d => (
            <TouchableOpacity
              key={d}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 10,
                alignItems: 'center',
                backgroundColor: difficulty === d ? (d === 'easy' ? '#4ade80' : d === 'medium' ? '#f1c40f' : '#ef4444') : 'transparent',
              }}
              onPress={() => setDifficulty(d)}
            >
              <Text style={{
                color: difficulty === d ? '#000' : 'rgba(255,255,255,0.7)',
                fontWeight: '800',
                fontSize: 13,
                textTransform: 'uppercase'
              }}>
                {d === 'easy' ? 'ðŸŸ¢ Easy' : d === 'medium' ? 'ðŸŸ¡ Medium' : 'ðŸ”¥ Hard'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {[1, 2, 3].map(n => (
          <TouchableOpacity key={n} style={[styles.glassButton, styles.botButton, { marginTop: 8 }]} onPress={() => onSelect(n, difficulty)}>
            <Text style={styles.buttonText}>{n} Bot{n > 1 ? 's' : ''}</Text>
            <Text style={styles.buttonSubtext}>{n + 1} players total ({difficulty.toUpperCase()})</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[styles.modalButton, styles.cancelButton, { marginTop: 30 }]} onPress={onClose}>
          <Text style={styles.modalButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Main App
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function AppContent() {
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [matchHistory, setMatchHistory] = useState<MatchHistoryEntry[]>([]);
  const [showBotCountModal, setShowBotCountModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showDepositWebView, setShowDepositWebView] = useState(false);
  const [depositPhone, setDepositPhone] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [depositTermsAgreed, setDepositTermsAgreed] = useState(false);
  const [depositStatus, setDepositStatus] = useState<'idle' | 'loading' | 'sent' | 'error'>('idle');
  const [depositError, setDepositError] = useState('');
  const [depositSuccessMessage, setDepositSuccessMessage] = useState('');
  const [withdrawNumber, setWithdrawNumber] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawPassword, setWithdrawPassword] = useState('');
  const [userProfile, setUserProfile] = useState({ displayName: '', avatarId: 'bottts:player', elo: 0, wins: 0, losses: 0, balance: 1500, username: '' });
  const [processedGameOver, setProcessedGameOver] = useState(false);

  // Tournament state
  const [showTournamentModal, setShowTournamentModal] = useState(false);
  const [tournamentDashboard, setTournamentDashboard] = useState<any>({ is_open: false, key_count: 0, is_admin: false, points: 0, leaderboard: [] });
  const [isTournamentMatch, setIsTournamentMatch] = useState(false);
  // Rewarded-ad progress counter (2 ads = 100 coins; 50 per ad)
  const [adsWatchedForReward, setAdsWatchedForReward] = useState(0);

  // Auth state
  const [authScreen, setAuthScreen] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authUser, setAuthUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true); // starts true while checking session
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [showSuitPicker, setShowSuitPicker] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  
  // AI Coach state
  const [isCoachThinking, setIsCoachThinking] = useState(false);
  const [coachHint, setCoachHint] = useState<{ tipText: string, alternatives: any[] } | null>(null);

  // Voice Chat State
  const voiceRoomRef = useRef<VoiceRoomManager | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, any>>({});

  // Bot management â€” array now supports multiple bots
  const [botProfiles, setBotProfiles] = useState<BotProfile[]>([]);
  const botTimersRef = useRef<{ [botId: string]: NodeJS.Timeout | null }>({});
  const matchmakingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [gameId, setGameId] = useState<string | null>(null);
  const latestGameUpdateRef = useRef(0);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [isWaitingForOpponent, setIsWaitingForOpponent] = useState(false);
  const [isMatchmaking, setIsMatchmaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lobbyPlayers, setLobbyPlayers] = useState<{ id: string; name: string }[]>([]);

  // Username & Game Requests State
  const [authUsername, setAuthUsername] = useState('');
  const [showChallengeModal, setShowChallengeModal] = useState(false);
  const [searchUsername, setSearchUsername] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [incomingRequests, setIncomingRequests] = useState<any[]>([]);
  const [activeSentRequest, setActiveSentRequest] = useState<any>(null);
  const [onlineStatuses, setOnlineStatuses] = useState<Record<string, boolean>>({});
  const [challengeTab, setChallengeTab] = useState<'search' | 'incoming'>('search');

  // Shuffling animation
  const [isShuffling, setIsShuffling] = useState(false);
  const [shuffledGameId, setShuffledGameId] = useState<string | null>(null);
  const shuffleAnim = useRef(new Animated.Value(1)).current;

  // In-app alert state
  const [alertState, setAlertState] = useState<{ visible: boolean; title: string; message: string; type: 'error' | 'info' | 'warning' }>({
    visible: false, title: '', message: '', type: 'info',
  });

  const showAlert = (title: string, message: string, type: 'error' | 'info' | 'warning' = 'info') => {
    setAlertState({ visible: true, title, message, type });
  };
  const hideAlert = () => setAlertState(s => ({ ...s, visible: false }));
  const getMatchReward = (playerCount: number) => Math.max(100, (Math.min(4, playerCount) - 1) * 100);
  const recordMatchAction = (playerName: string, cards: Card[], action: MatchHistoryEntry['action']) => {
    const entry = { id: `${Date.now()}-${Math.random()}`, playerName, cards, action, createdAt: Date.now() };
    setMatchHistory(previous => {
      const next = [...previous, entry];
      AsyncStorage.setItem('@ghurt_active_match_history', JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  };

  const getRank = (elo: number) => {
    if (elo < 100) return 'Private';
    if (elo < 300) return 'Corporal';
    if (elo < 600) return 'Sergeant';
    if (elo < 1000) return 'Lieutenant';
    if (elo < 1500) return 'Captain';
    if (elo < 2100) return 'Major';
    if (elo < 2800) return 'Colonel';
    return 'General';
  };

  const calculateFee = (pot: number): number => {
    if (pot < 100) return 5;
    if (pot < 200) return 10;
    if (pot < 300) return 15;
    if (pot < 500) return 20;
    if (pot < 1000) return 35;
    if (pot < 2000) return 60;
    return 100;
  };

  const [showSuspendedModal, setShowSuspendedModal] = useState(false);
  const [appealReason, setAppealReason] = useState('');
  const [appealStatus, setAppealStatus] = useState<'idle' | 'loading' | 'success'>('idle');
  const suspendedUserIdRef = useRef<string | null>(null);
  // App Open ad splash gate â€” blocks UI touches while the cold-start ad is showing
  const [appReady, setAppReady] = useState(false);
  // Search debounce ref (300 ms) â€” prevents full-table-scans on every keystroke
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);


  const checkSuspension = (user: any): boolean => {
    if (user?.user_metadata?.is_suspended === 'true' || user?.user_metadata?.is_suspended === true) {
      suspendedUserIdRef.current = user.id;
      supabase.auth.signOut();
      setAuthUser(null);
      setShowSuspendedModal(true);
      return true;
    }
    return false;
  };

  useEffect(() => {
    // Initialize AdMob service (async â€” loads AsyncStorage cooldown timestamp)
    // then attempt cold-start App Open ad before showing lobby.
    // A full-screen overlay (appReady=false) blocks accidental touches until
    // the ad is dismissed or a 5-second safety timeout fires.
    const initAds = async () => {
      await admobService.init();

      // Safety valve: if ad never fires onWillShow/onDidClose within 5s, unblock anyway
      const safetyTimer = setTimeout(() => setAppReady(true), 5000);

      await admobService.showAppOpenAd(
        /* onWillShow  */ () => { /* overlay already shown via appReady=false */ },
        /* onDidClose  */ () => {
          clearTimeout(safetyTimer);
          setAppReady(true);
        },
      );
    };
    initAds();

    // Initialize OneSignal push notifications
    oneSignalService.init();

    // Handle notification taps (e.g., from a game request)
    const unsubscribeNotification = oneSignalService.onNotificationOpen((payload) => {
      if (payload.type === 'game_request') {
        // Open the challenge modal so the user can accept/decline
        setShowChallengeModal(true);
        setChallengeTab('incoming');
      } else if (payload.type === 'game_request_accepted') {
        showAlert('Challenge Accepted! ðŸŽ‰', `${(payload as any).from_username} accepted your challenge!`, 'info');
      } else if (payload.type === 'game_request_declined') {
        showAlert('Challenge Declined', `${(payload as any).from_username} declined your challenge.`, 'info');
      }
    });

    // Check existing Supabase session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      const isSusp = checkSuspension(session?.user);
      if (!isSusp) {
        setAuthUser(session?.user ?? null);
      }
      setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const isSusp = checkSuspension(session?.user);
      if (!isSusp) {
        setAuthUser(session?.user ?? null);
        // Link OneSignal subscription to this Supabase user
        if (session?.user?.id) {
          oneSignalService.setExternalUserId(session.user.id);
        } else {
          oneSignalService.logout();
        }
      }
    });

    // Load local profile â€” merge with defaults so old saves never crash
    AsyncStorage.getItem('@ghurt_profile').then(data => {
      if (data) {
        try {
          const p = sanitizeProfile(JSON.parse(data));
          setUserProfile(p);
          if (p.displayName) setPlayerName(p.displayName);
        } catch (e) {
          console.warn('[Profile] Failed to parse local profile:', e);
        }
      }
    });

    return () => {
      subscription.unsubscribe();
      admobService.destroy();
      unsubscribeNotification();
    };
  }, []);

  // Signal AdMob service whether the user is in an active game
  // so App Open ads are never shown during gameplay.
  useEffect(() => {
    admobService.setInActiveGame(gameState !== null);
  }, [gameState]);

  useEffect(() => {
    // Installation and daily-activity telemetry is device based, not account
    // based. It contains no name, email, or gameplay data.
    getDeviceInfo().then(info => supabase.rpc('record_device_install', {
      p_device_id: info.device_id,
      p_device_info: info,
    })).catch(err => console.warn('Device analytics unavailable:', err));
  }, []);


  useEffect(() => {
    if (!gameState || matchHistory.length) return;
    AsyncStorage.getItem('@ghurt_active_match_history').then(raw => {
      if (!raw) return;
      try { setMatchHistory(JSON.parse(raw)); } catch { AsyncStorage.removeItem('@ghurt_active_match_history'); }
    });
  }, [gameState?.id]);

  useEffect(() => {
    if (!gameState?.moveHistory?.length) return;
    setMatchHistory(gameState.moveHistory);
    AsyncStorage.setItem('@ghurt_active_match_history', JSON.stringify(gameState.moveHistory)).catch(() => undefined);
  }, [gameState?.moveHistory]);

  useEffect(() => {
    if (!authUser) return;

    // One stable SecureStore ID per device lets the admin measure installs and
    // active daily devices without exposing it to other players.
    registerDevice(supabase, authUser.id);

    const fetchUserProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('users')
          .select('display_name, avatar_id, elo, wins, losses, balance, username')
          .eq('id', authUser.id)
          .single();
        
        if (error) throw error;
        if (data) {
          const updatedProfile = {
            displayName: data.display_name || '',
            avatarId: data.avatar_id || '1',
            elo: data.elo || 0,
            wins: data.wins || 0,
            losses: data.losses || 0,
            balance: Number(data.balance) || 0,
            username: data.username || ''
          };
          setUserProfile(updatedProfile);
          if (updatedProfile.displayName) setPlayerName(updatedProfile.displayName);
          await AsyncStorage.setItem('@ghurt_profile', JSON.stringify(updatedProfile));
        }
      } catch (err) {
        console.warn('Failed to fetch user profile from DB:', err);
      }
    };

    fetchUserProfile();
  }, [authUser]);

  useEffect(() => {
    if (!authUser?.id) return;

    const updateOnlineStatus = async (online: boolean) => {
      try {
        await supabase
          .from('users')
          .update({ is_online: online, last_seen_at: new Date().toISOString() })
          .eq('id', authUser.id);
      } catch (err) {
        console.warn('Failed to update online status:', err);
      }
    };

    // Set online on mount
    updateOnlineStatus(true);

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        updateOnlineStatus(true);
      } else {
        updateOnlineStatus(false);
      }
    });

    return () => {
      subscription.remove();
      updateOnlineStatus(false);
    };
  }, [authUser]);

  // â”€â”€â”€ SUBSCRIBE TO INCOMING CHALLENGES & ONLINE STATUSES â”€â”€â”€
  useEffect(() => {
    if (!authUser?.id) return;

    // 1. Fetch initial pending requests
    const fetchPendingRequests = async () => {
      try {
        const { data, error } = await supabase
          .from('game_requests')
          .select('*')
          .eq('receiver_id', authUser.id)
          .eq('status', 'pending');
        if (error) throw error;
        setIncomingRequests(data || []);
      } catch (e) {
        console.warn('Error fetching pending requests:', e);
      }
    };
    fetchPendingRequests();

    // 2. Subscribe to realtime updates for game requests where we are the receiver
    const channel = supabase.channel(`incoming_requests:${authUser.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'game_requests', filter: `receiver_id=eq.${authUser.id}`
      }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newRequest = payload.new;
          setIncomingRequests(prev => {
            if (prev.some(r => r.id === newRequest.id)) return prev;
            return [...prev, newRequest];
          });
          showAlert('New Challenge!', `${newRequest.sender_name} has challenged you to a game.`, 'info');
        } else if (payload.eventType === 'UPDATE') {
          const updatedRequest = payload.new;
          if (updatedRequest.status !== 'pending') {
            setIncomingRequests(prev => prev.filter(r => r.id !== updatedRequest.id));
          }
        } else if (payload.eventType === 'DELETE') {
          const deletedId = payload.old.id;
          setIncomingRequests(prev => prev.filter(r => r.id !== deletedId));
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [authUser]);

  useEffect(() => {
    if (!authUser?.id) return;

    // Subscribe to realtime updates for user online statuses
    const channel = supabase.channel('users_online_status')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'users'
      }, (payload) => {
        const updatedUser = payload.new;
        if (updatedUser && updatedUser.id) {
          setOnlineStatuses(prev => ({
            ...prev,
            [updatedUser.id]: updatedUser.is_online
          }));
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [authUser]);

  useEffect(() => {
    if (lobbyPlayers.length > 0) {
      const ids = lobbyPlayers.map(p => p.id);
      fetchOnlineStatuses(ids);
    }
  }, [lobbyPlayers]);

  const handleSignup = async () => {
    const email = authEmail.trim();
    const username = authUsername.trim();
    if (!email || !authPassword || !username) { 
      showAlert('Missing Fields', 'Please enter your email, username, and password.', 'warning'); 
      return; 
    }
    if (authPassword !== authConfirmPassword) { 
      showAlert('Password Mismatch', 'Passwords do not match.', 'error'); 
      return; 
    }
    if (authPassword.length < 6) { 
      showAlert('Weak Password', 'Password must be at least 6 characters.', 'warning'); 
      return; 
    }
    if (username.length < 3) {
      showAlert('Invalid Username', 'Username must be at least 3 characters.', 'warning');
      return;
    }
    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (!usernameRegex.test(username)) {
      showAlert('Invalid Username', 'Username can only contain letters, numbers, and underscores.', 'warning');
      return;
    }

    setAuthLoading(true);
    try {
      // Uniqueness check
      const { data: existingUser, error: checkError } = await supabase
        .from('users')
        .select('id')
        .eq('username', username)
        .limit(1);

      if (checkError) {
        console.warn('Username check warning:', checkError);
      }

      if (existingUser && existingUser.length > 0) {
        showAlert('Username Taken', 'This username is already taken. Please choose another one.', 'warning');
        setAuthLoading(false);
        return;
      }

      const { data, error } = await supabase.auth.signUp({ 
        email, 
        password: authPassword,
        options: {
          data: {
            username: username,
            display_name: username
          }
        }
      });
      if (error) throw error;
      if (data.user) {
        const isSusp = checkSuspension(data.user);
        if (!isSusp) {
          setAuthUser(data.user);
          showAlert('Account Created!', `Welcome to CardFlow, @${username}!`, 'info');
        }
      } else {
        showAlert('Verify Email', 'Please check your email to verify your account.', 'info');
      }
    } catch (err: any) {
      showAlert('Signup Failed', err.message || 'Could not create account.', 'error');
    } finally { setAuthLoading(false); }
  };

  const handleLogin = async () => {
    const email = authEmail.trim();
    if (!email || !authPassword) { showAlert('Missing Fields', 'Enter your email address and password.', 'warning'); return; }
    setAuthLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password: authPassword });
      if (error) throw error;
      const isSusp = checkSuspension(data.user);
      if (!isSusp) {
        setAuthUser(data.user);
      }
    } catch (err: any) {
      showAlert('Login Failed', err.message || 'Incorrect email or password.', 'error');
    } finally { setAuthLoading(false); }
  };

  const renderOnlineDot = (userId: string) => {
    const isUserOnline = userId === myPlayerId || userId === authUser?.id || onlineStatuses[userId];
    return (
      <View 
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: isUserOnline ? '#4caf50' : '#757575',
          marginLeft: 8,
          alignSelf: 'center',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.2)'
        }}
      />
    );
  };

  // â”€â”€â”€ SEARCH PLAYERS â”€â”€â”€
  const fetchOnlineStatuses = async (userIds: string[]) => {
    const uuids = userIds.filter(id => id.match(/^[0-9a-fA-F-]{36}$/));
    if (uuids.length === 0) return;

    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, is_online')
        .in('id', uuids);
      if (error) throw error;
      
      const newStatuses: Record<string, boolean> = {};
      data?.forEach((row: any) => {
        newStatuses[row.id] = row.is_online;
      });
      setOnlineStatuses(prev => ({ ...prev, ...newStatuses }));
    } catch (e) {
      console.warn('Error fetching online statuses:', e);
    }
  };

  const handleSearchPlayers = async (query?: string) => {
    const searchTerm = (query !== undefined ? query : searchUsername).trim();
    if (!searchTerm) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, display_name, username, avatar_id, elo, wins, losses, balance, is_online')
        .ilike('username', `%${searchTerm}%`)
        .neq('id', authUser?.id)
        .limit(10);
      if (error) throw error;
      setSearchResults(data || []);
      
      // Update online status cache
      if (data) {
        const newStatuses: Record<string, boolean> = {};
        data.forEach((row: any) => {
          newStatuses[row.id] = !!row.is_online;
        });
        setOnlineStatuses(prev => ({ ...prev, ...newStatuses }));
      }
    } catch (err: any) {
      showAlert('Search Failed', err.message || 'Could not search players.', 'error');
    } finally {
      setSearchLoading(false);
    }
  };

  // â”€â”€â”€ CHALLENGE FLOW â”€â”€â”€
  const handleSendChallenge = async (targetUser: any) => {
    if (!playerName.trim()) { 
      showAlert('Name Required', 'Please enter your name first.', 'warning'); 
      return; 
    }
    setLoading(true);
    try {
      const code = generateRoomCode();
      const myId = authUser?.id || `player_${Date.now()}`;
      const initialPlayers = [{ id: myId, name: playerName.trim() }];
      
      // Create the game room
      const { data: gameData, error: gameError } = await supabase.from('games').insert([{
        room_code: code,
        status: 'waiting',
        joined_players: initialPlayers,
        player_count: 1,
        is_private: true,
        player1_id: authUser?.id || myId,
        player1_name: playerName.trim(),
      }]).select();

      if (gameError) throw gameError;
      if (!gameData?.length) throw new Error('Failed to create game room');

      const newRequest = {
        sender_id: authUser.id,
        sender_name: playerName.trim(),
        receiver_id: targetUser.id,
        status: 'pending',
        room_code: code
      };

      // Create the challenge request
      const { data: requestData, error: requestError } = await supabase
        .from('game_requests')
        .insert([newRequest])
        .select();

      if (requestError) {
        // clean up game if request creation failed
        await supabase.from('games').delete().eq('id', gameData[0].id);
        throw requestError;
      }

      if (!requestData?.length) throw new Error('Failed to send request');

      const createdRequest = requestData[0];

      // Send push notification to challenged player
      if (authUser?.id && targetUser?.id) {
        oneSignalService.sendGameRequest({
          targetUserId: targetUser.id,
          fromUserId: authUser.id,
          fromUsername: playerName.trim(),
          gameMode: 'Ghurt Card Game',
          requestId: createdRequest.id,
        }).catch(() => {}); // fire-and-forget
      }

      // Configure waiting state
      setRoomCode(code);
      setGameId(gameData[0].id);
      setMyPlayerId(myId);
      setLobbyPlayers(initialPlayers);
      setIsOnline(true);
      setIsWaitingForOpponent(true);
      setActiveSentRequest(createdRequest);
      setShowChallengeModal(false);

      // Subscribe to this specific request's update event to watch if B accepts/declines
      const requestChannel = supabase.channel(`request_status:${createdRequest.id}`)
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'game_requests', filter: `id=eq.${createdRequest.id}`
        }, (payload) => {
          const updatedRequest = payload.new;
          if (updatedRequest) {
            if (updatedRequest.status === 'accepted') {
              supabase.removeChannel(requestChannel);
            } else if (updatedRequest.status === 'declined') {
              showAlert('Challenge Declined', `${targetUser.display_name} declined your challenge.`, 'info');
              handleLeaveLobby();
              supabase.removeChannel(requestChannel);
            }
          }
        })
        .subscribe();

    } catch (err: any) {
      console.error('Challenge Creation Error:', err);
      showAlert('Challenge Failed', err.message || 'Could not send challenge.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptChallenge = async (req: any) => {
    if (!playerName.trim()) { 
      showAlert('Name Required', 'Please enter your name first.', 'warning'); 
      return; 
    }
    setLoading(true);
    try {
      // 1. Fetch the game room
      const { data: games, error: queryError } = await supabase
        .from('games')
        .select('*')
        .eq('room_code', req.room_code)
        .eq('status', 'waiting')
        .limit(1);

      if (queryError) throw queryError;
      if (!games?.length) { 
        showAlert('Game Expired', 'This game has already started or been cancelled.', 'warning');
        // Delete request from list
        await supabase.from('game_requests').delete().eq('id', req.id);
        setIncomingRequests(prev => prev.filter(r => r.id !== req.id));
        setLoading(false);
        return; 
      }

      const game = games[0];
      const myId = authUser?.id || `player_${Date.now()}`;
      const updatedPlayers = [...(game.joined_players || []), { id: myId, name: playerName.trim() }];
      const newCount = updatedPlayers.length;

      // 2. Accept request in DB
      const { error: requestUpdateError } = await supabase
        .from('game_requests')
        .update({ status: 'accepted' })
        .eq('id', req.id);
      
      if (requestUpdateError) throw requestUpdateError;

      // Notify challenger via push that their request was accepted
      if (authUser?.id && req.sender_id) {
        oneSignalService.sendGameRequestResponse({
          targetUserId: req.sender_id,
          fromUserId: authUser.id,
          fromUsername: playerName.trim(),
          requestId: req.id,
          accepted: true,
        }).catch(() => {});
      }

      // 3. Join the game room
      const { error: updateError } = await supabase.from('games').update({
        joined_players: updatedPlayers,
        player_count: newCount,
      }).eq('id', game.id);
      
      if (updateError) throw updateError;

      setGameId(game.id);
      setMyPlayerId(myId);
      setRoomCode(game.room_code);
      setLobbyPlayers(updatedPlayers);
      setIsOnline(true);
      setIsWaitingForOpponent(true);
      setShowChallengeModal(false);

    } catch (err: any) {
      console.error('Accept Challenge Error:', err);
      showAlert('Error', err.message || 'Could not accept challenge.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDeclineChallenge = async (req: any) => {
    try {
      await supabase
        .from('game_requests')
        .update({ status: 'declined' })
        .eq('id', req.id);

      // Notify challenger via push that their request was declined
      if (authUser?.id && req.sender_id) {
        oneSignalService.sendGameRequestResponse({
          targetUserId: req.sender_id,
          fromUserId: authUser.id,
          fromUsername: playerName.trim(),
          requestId: req.id,
          accepted: false,
        }).catch(() => {});
      }

      setIncomingRequests(prev => prev.filter(r => r.id !== req.id));
    } catch (err: any) {
      console.warn('Decline challenge warning:', err);
    }
  };

  const handleSubmitAppeal = async () => {
    if (!appealReason.trim()) {
      showAlert('Reason Required', 'Please explain why your account should be restored.', 'warning');
      return;
    }
    setAppealStatus('loading');
    try {
      const { error } = await supabase.from('appeals').insert({
        user_id: suspendedUserIdRef.current || '00000000-0000-0000-0000-000000000000',
        email: authEmail.trim() || 'suspended-user@ghurt.app',
        reason: appealReason.trim(),
        status: 'pending'
      });
      if (error) throw error;
      setAppealStatus('success');
      setAppealReason('');
    } catch (e: any) {
      setAppealStatus('idle');
      showAlert('Appeal Failed', e.message || 'Could not submit appeal.', 'error');
    }
  };

  const handleLogout = async () => {
    oneSignalService.logout();
    await supabase.auth.signOut();
    setAuthUser(null);
    handleBackToMenu();
  };

  const sanitizeProfile = (p: any): typeof userProfile => {
    return {
      displayName: typeof p?.displayName === 'string' ? p.displayName : '',
      avatarId: typeof p?.avatarId === 'string' && p.avatarId ? p.avatarId : 'bottts:player',
      elo: typeof p?.elo === 'number' && !isNaN(p.elo) ? Math.max(0, p.elo) : 0,
      wins: typeof p?.wins === 'number' && !isNaN(p.wins) ? Math.max(0, p.wins) : 0,
      losses: typeof p?.losses === 'number' && !isNaN(p.losses) ? Math.max(0, p.losses) : 0,
      balance: typeof p?.balance === 'number' && !isNaN(p.balance) ? Math.max(0, p.balance) : 1500,
      username: typeof p?.username === 'string' ? p.username : '',
    };
  };

  const saveProfile = async (profile: any) => {
    const clean = sanitizeProfile(profile);
    const profileWithUsername = { ...clean, username: profile.username || userProfile.username || '' };
    setUserProfile(profileWithUsername);
    await AsyncStorage.setItem('@ghurt_profile', JSON.stringify(profileWithUsername));

    if (authUser?.id) {
      try {
        await supabase
          .from('users')
          .update({
            display_name: clean.displayName,
            avatar_id: clean.avatarId,
            elo: clean.elo,
            wins: clean.wins,
            losses: clean.losses
          })
          .eq('id', authUser.id);
      } catch (err) {
        console.warn('Failed to update remote profile:', err);
      }
    }
  };

  useEffect(() => {
    if (gameState && isGameOver(gameState) && !processedGameOver) {
      setProcessedGameOver(true);
      const me = gameState.players.find(p => p.id === myPlayerId);
      if (me) {
        const isWin = me.hand.length === 0;
        const opponentElo = 1000; // Baseline opponent ELO 
        const newElo = calculateElo(userProfile.elo, opponentElo, isWin);
        const newWins = userProfile.wins + (isWin ? 1 : 0);
        const newLosses = userProfile.losses + (isWin ? 0 : 1);
        // IMPORTANT: Preserve current balance â€” do NOT overwrite coins earned
        // from rewarded ads before the game. Only elo/wins/losses change here.
        const newProfile = { ...userProfile, elo: newElo, wins: newWins, losses: newLosses, balance: userProfile.balance };
        saveProfile(newProfile);

        // MATCH COIN SETTLEMENT (+100 for winner, -50 for losers)
        if (gameState) {
          const winner = gameState.players.find(p => p.hand.length === 0);
          const losers = gameState.players.filter(p => p.hand.length > 0);
          if (winner) {
            const winnerId = winner.id === myPlayerId ? authUser?.id : (winner.id.match(/^[0-9a-fA-F-]{36}$/) ? winner.id : null);
            const loserUuids = losers.map(l => l.id === myPlayerId ? authUser?.id : (l.id.match(/^[0-9a-fA-F-]{36}$/) ? l.id : null)).filter(Boolean);
            if (winnerId || loserUuids.length > 0) {
              supabase.rpc('settle_casual_game', { p_winner_id: winnerId, p_loser_ids: loserUuids, p_reward_amount: getMatchReward(gameState.initialPlayerCount || gameState.players.length) })
                .then(() => {
                  if (authUser?.id) {
                    supabase.from('users').select('balance').eq('id', authUser.id).single()
                      .then(({ data }) => {
                        if (data?.balance !== undefined) {
                          const updated = { ...newProfile, balance: Number(data.balance) };
                          setUserProfile(updated);
                          AsyncStorage.setItem('@ghurt_profile', JSON.stringify(updated));
                        }
                      });
                  }
                }, err => console.warn('Casual settlement error:', err));
            }
          }

          // Keep local/offline games consistent with the same +100 / -50 rules.
          // Signed-in users are subsequently refreshed from the authoritative RPC balance.
          if (!authUser?.id) {
            const updated = {
              ...newProfile,
              balance: Math.max(0, newProfile.balance + (isWin ? getMatchReward(gameState.initialPlayerCount || gameState.players.length) : 0)),
            };
            setUserProfile(updated);
            AsyncStorage.setItem('@ghurt_profile', JSON.stringify(updated));
          }
        }
      }
    }
  }, [gameState, processedGameOver, userProfile, myPlayerId, gameId, authUser]);

  // Back button interception during active online games
  useEffect(() => {
    const backAction = () => {
      if (isOnline && gameState && !isGameOver(gameState)) {
        Alert.alert(
          'Leave Game?',
          'Are you sure you want to leave this active game?',
          [
            { text: 'Stay', style: 'cancel' },
            { text: 'Leave', style: 'destructive', onPress: handleBackToMenu },
          ]
        );
        return true;
      }
      return false;
    };
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [isOnline, gameState, gameId]);

  const generateRoomCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
  };

  // â”€â”€â”€ CREATE PRIVATE ROOM â”€â”€â”€
  const handleCreateRoom = async () => {
    if (!playerName.trim()) { showAlert('Name Required', 'Please enter your name before creating a room.', 'warning'); return; }
    setLoading(true);
    setIsMatchmaking(false);
    try {
      const code = generateRoomCode();
      const myId = `player_${Date.now()}`;
      const initialPlayers = [{ id: myId, name: playerName.trim() }];
      const { data, error } = await supabase.from('games').insert([{
        room_code: code,
        status: 'waiting',
        joined_players: initialPlayers,
        player_count: 1,
        is_private: true, // â† Private room: hidden from random matchmaking
        player1_id: authUser?.id || myId,
        player1_name: playerName.trim(),
      }]).select();
      if (error) throw error;
      if (!data?.length) throw new Error('Failed to create game room');
      setRoomCode(code);
      setGameId(data[0].id);
      setMyPlayerId(myId);
      setLobbyPlayers(initialPlayers);
      setIsOnline(true);
      setIsWaitingForOpponent(true);
    } catch (err) {
      console.error('Room Creation Error:', err);
      showAlert('Error', err instanceof Error ? `Could not create room: ${err.message}` : 'Could not create room. Try again.', 'error');
    } finally { setLoading(false); }
  };

  // â”€â”€â”€ JOIN PRIVATE ROOM â”€â”€â”€
  const handleJoinRoom = async () => {
    if (!playerName.trim()) { showAlert('Name Required', 'Please enter your name before joining.', 'warning'); return; }
    if (!roomCode.trim()) { showAlert('Code Required', 'Please enter a room code.', 'warning'); return; }
    setLoading(true);
    try {
      const upperCode = roomCode.toUpperCase().trim();
      const { data: games, error: queryError } = await supabase.from('games').select('*').eq('room_code', upperCode).eq('status', 'waiting').limit(1);
      if (queryError) throw queryError;
      if (!games?.length) { showAlert('Room Not Found', 'This room does not exist or is already full/started.', 'warning'); return; }

      const game = games[0];
      if ((game.player_count ?? 1) >= (game.max_players ?? 4)) {
        showAlert('Room Full', 'This room is already at max capacity!', 'error'); return;
      }

      const myId = `player_${Date.now()}`;
      const updatedPlayers = [...(game.joined_players || []), { id: myId, name: playerName.trim() }];
      const newCount = updatedPlayers.length;

      const { error: updateError } = await supabase.from('games').update({
        joined_players: updatedPlayers,
        player_count: newCount,
      }).eq('id', game.id);
      if (updateError) throw updateError;

      setGameId(game.id);
      setMyPlayerId(myId);
      setRoomCode(upperCode);
      setLobbyPlayers(updatedPlayers);
      setIsOnline(true);
      setIsWaitingForOpponent(true);
      setShowJoinModal(false);
    } catch (err) {
      showAlert('Error', err instanceof Error ? err.message : 'Could not join room. Try again.', 'error');
    } finally { setLoading(false); }
  };

  // â”€â”€â”€ FIND RANDOM PLAYER (Server-side atomic matchmaking, no race conditions) â”€â”€â”€
  const handleFindRandom = async () => {
    if (!playerName.trim()) { showAlert('Name Required', 'Please enter your name first.', 'warning'); return; }
    setLoading(true);
    setIsMatchmaking(true);

    // Generate a stable ID for this session â€” used as both player ID and host identity
    const myId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const myHostId = authUser?.id || myId;
    const code = generateRoomCode();

    try {
      // â”€â”€ STEP 1: Call the server-side atomic RPC â”€â”€
      // The RPC safely finds a waiting room (not private, not ours) using FOR UPDATE SKIP LOCKED
      // and joins it atomically. If none found, it creates a new one. No client-side race condition.
      const { data: rpcResult, error: rpcError } = await supabase.rpc('join_random_game', {
        p_player_id: myId,
        p_player_name: playerName,
        p_room_code: code,
        p_player1_id: myHostId,
      });

      if (rpcError) throw rpcError;
      if (!rpcResult) throw new Error('No result from matchmaking server');

      const game = rpcResult.game;
      const isStart = rpcResult.is_start; // true = we joined someone else's room

      setRoomCode(game.room_code);
      setGameId(game.id);
      setMyPlayerId(myId);
      setLobbyPlayers(Array.isArray(game.joined_players) ? game.joined_players : [{ id: myId, name: playerName.trim() }]);
      setIsOnline(true);

      if (isStart) {
        // â”€â”€ We joined an existing room: we are Player 2 â”€â”€
        // Only Player 2 initializes the game state to avoid a double-init race.
        const allPlayers: { id: string; name: string }[] = Array.isArray(game.joined_players)
          ? game.joined_players
          : [];

        if (allPlayers.length >= 4) {
          const initState = initializeGame(allPlayers);
          // Push the initialized game state to the DB; Player 1 receives it via realtime
          const { error: startError } = await supabase.from('games').update({
            status: 'playing',
            game_state: initState,
            updated_at: new Date().toISOString(),
          }).eq('id', game.id).eq('status', 'waiting'); // eq guard prevents double-start
          if (startError) console.warn('Start game update warning:', startError.message);
        }

        setIsWaitingForOpponent(allPlayers.length < 4);
        setIsMatchmaking(false);
      } else {
        // â”€â”€ We created a new room: we are Player 1, waiting â”€â”€
        setIsWaitingForOpponent(true);

        // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const waitingGameId = game.id;
        matchmakingTimeoutRef.current = setTimeout(async () => {
          try {
            // Only inject bot if still waiting (no human joined)
            const { data: check } = await supabase
              .from('games')
              .select('id, status, joined_players')
              .eq('id', waitingGameId)
              .eq('status', 'waiting')
              .limit(1);

            if (check?.length) {
              // Double check if player backed out or changed rooms
              if (matchmakingTimeoutRef.current === null) return;

              // Still waiting â€” inject exactly 1 bot for a fast 1v1 match
              const humanPlayers = Array.isArray(check[0].joined_players) ? check[0].joined_players : [{ id: myId, name: playerName }];
              const minimumPlayers = Math.max(2, humanPlayers.length);
              const targetPlayers = minimumPlayers + Math.floor(Math.random() * (5 - minimumPlayers));
              const bots = getMultipleBotProfiles(Math.max(0, targetPlayers - humanPlayers.length));
              const botPlayers = bots.map((bot, index) => ({ id: `player_${Date.now()}_${index}`, name: bot.name }));
              const allPlayers = [...humanPlayers, ...botPlayers];
              const initState = initializeGame(allPlayers);

              const { data: botMatch, error: botMatchError } = await supabase.from('games').update({
                joined_players: allPlayers,
                player_count: allPlayers.length,
                status: 'playing',
                game_state: initState,
                updated_at: new Date().toISOString(),
              }).eq('id', waitingGameId).eq('status', 'waiting').select('id'); // guard: only update if still waiting

              // A bot is used only after the human matchmaking window expires and
              // only if this guarded update actually won the race. If a human joins
              // first, the game remains human-vs-human and no local bot is started.
              if (botMatchError) throw botMatchError;
              if (botMatch?.length && bots.length) setBotProfiles(bots.map((bot, index) => ({ ...bot, _botId: botPlayers[index].id } as any)));
            }
          } catch (e) { console.error('Bot fallback error:', e); }
        // Give real players a meaningful chance to join before any bot is added.
        }, 20000);
      }
    } catch (err) {
      console.error('Matchmaking Error:', err);
      setIsMatchmaking(false);
      showAlert('Matchmaking Error', err instanceof Error ? `Could not connect: ${err.message}` : 'Could not connect. Try again.', 'error');
    } finally { setLoading(false); }
  };

  // â”€â”€â”€ PLAY VS BOT â”€â”€â”€
  const handlePlayVsBot = () => {
    if (!playerName.trim()) { showAlert('Name Required', 'Please enter your name first.', 'warning'); return; }
    setShowBotCountModal(true);
  };

  const startBotGame = (botCount: number, difficulty: 'easy' | 'medium' | 'hard' = 'medium') => {
    setShowBotCountModal(false);
    const bots = getMultipleBotProfiles(botCount, difficulty);
    const myId = 'player_human';
    const players = [
      { id: myId, name: playerName },
      ...bots.map((b, i) => ({ id: `bot_${i}`, name: b.name })),
    ];
    const newGame = initializeGame(players);
    setBotProfiles(bots.map((b, i) => ({ ...b, _botId: `bot_${i}` } as any)));
    setGameState(newGame);
    setMyPlayerId(myId);
    setIsOnline(false);
  };

  // â”€â”€â”€ HOST START GAME â”€â”€â”€
  const handleHostStartGame = async () => {
    if (!gameId) return;
    setLoading(true);
    try {
      const { data: games } = await supabase.from('games').select('*').eq('id', gameId).limit(1);
      if (!games?.length) { showAlert('Error', 'Room not found.', 'error'); return; }
      const game = games[0];
      const players: { id: string; name: string }[] = game.joined_players || [];

      if (players.length < 2 || !players[1].id) { showAlert('Not Enough Players', 'You need 2 players to start.', 'warning'); return; }
      const initState = initializeGame(players);
      const { error } = await supabase.from('games').update({ status: 'playing', game_state: initState }).eq('id', gameId);
      if (error) throw error;
    } catch (err) {
      showAlert('Error', err instanceof Error ? err.message : 'Could not start game.', 'error');
    } finally { setLoading(false); }
  };

  const refreshTournamentDashboard = async () => {
    if (!authUser?.id) return;
    const { data, error } = await supabase.rpc('get_tournament_dashboard');
    if (error) throw error;
    setTournamentDashboard(data || { is_open: false, key_count: 0, is_admin: false, points: 0, leaderboard: [] });
  };

  const openTournament = async () => {
    if (!authUser) {
      showAlert('Login Required', 'Sign in to view tournaments.', 'warning');
      return;
    }
    setLoading(true);
    try {
      await refreshTournamentDashboard();
    } catch {
      // Silently ignore â€” tournament RPCs may not exist yet in this build.
      // Modal opens with safe default state.
      setTournamentDashboard({ is_open: false, key_count: 0, is_admin: false, points: 0, leaderboard: [] });
    } finally {
      setShowTournamentModal(true);
      setLoading(false);
    }
  };

  const buyTournamentKey = () => {
    // Tournament purchases are coming in the next update.
    showAlert(
      'ðŸ† Coming Soon',
      'Tournament key purchases will be unlocked in the upcoming update. Stay tuned â€” championships are on the way!',
      'info',
    );
  };

  const enterTournament = () => {
    // Tournament entry is coming in the next update.
    showAlert(
      'ðŸ† Coming Soon',
      'Tournament entry and championship events will be available in the upcoming update. Keep winning to earn your spot!',
      'info',
    );
  };



  const setTournamentOpen = async (isOpen: boolean) => {
    setLoading(true);
    try {
      const { error } = await supabase.rpc('set_tournament_open', { p_is_open: isOpen });
      if (error) throw error;
      await refreshTournamentDashboard();
    } catch (err: any) {
      showAlert('Admin Action Failed', err.message || 'Only tournament administrators can change this setting.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleLeaveLobby = async () => {
    if (activeSentRequest) {
      try {
        await supabase.from('game_requests').delete().eq('id', activeSentRequest.id);
      } catch (err) {
        console.warn('Failed to delete active game request:', err);
      }
      setActiveSentRequest(null);
    }
    if (gameId && myPlayerId) {
      try {
        if (authUser?.id && gameState && !isGameOver(gameState)) {
          await supabase.rpc('forfeit_casual_game', { p_user_id: authUser.id, p_game_id: gameId });
        }
        const { data: games } = await supabase.from('games').select('*').eq('id', gameId).limit(1);
        if (games?.length) {
          const game = games[0];
          const remaining = (game.joined_players || []).filter((p: any) => p.id !== myPlayerId);
          if (remaining.length === 0) {
            await supabase.from('games').delete().eq('id', gameId);
          } else {
            const updatedState = game.game_state ? removePlayerFromGame(game.game_state, myPlayerId) : null;
            await supabase.from('games').update({
              joined_players: remaining,
              player_count: remaining.length,
              ...(updatedState ? { game_state: updatedState, status: updatedState.status } : {}),
            }).eq('id', gameId);
          }
        }
      } catch (e) { console.error('Leave lobby error:', e); }
    }
    handleBackToMenu();
  };

  const handleCardPress = (card: Card) => {
    if (!gameState || isGameOver(gameState)) return;
    const currentPlayer = getCurrentPlayer(gameState);
    if (currentPlayer.id !== myPlayerId) { showAlert('Not Your Turn', 'Wait for your turn!', 'warning'); return; }
    
    setSelectedCardIds(prev => {
      // If already selected, deselect it
      if (prev.includes(card.id)) {
        return prev.filter(id => id !== card.id);
      }
      
      // If none selected, start new selection
      if (prev.length === 0) {
        return [card.id];
      }
      
      // Multi-card plays are same-rank only; this also prevents a suit-matched
      // King from being appended while defending an attack.
      const lastSelectedId = prev[prev.length - 1];
      const lastSelectedCard = currentPlayer.hand.find(c => c.id === lastSelectedId);
      if (lastSelectedCard && lastSelectedCard.rank === card.rank) {
        return [...prev, card.id];
      } else {
        // Does not match last card: start new selection with just this card
        return [card.id];
      }
    });
  };

  const handlePlaySelected = async () => {
    if (!gameState || isGameOver(gameState) || selectedCardIds.length === 0) return;
    const currentPlayer = getCurrentPlayer(gameState);
    if (currentPlayer.id !== myPlayerId) return;

    // Check Ace logic: if the last selected card is an Ace, we need a suit
    const lastCardId = selectedCardIds[selectedCardIds.length - 1];
    const lastCard = currentPlayer.hand.find(c => c.id === lastCardId);
    if (lastCard?.rank === 'Ace') {
      setShowSuitPicker(true);
      return;
    }

    try {
      const newState = playCards(gameState, currentPlayer.id, selectedCardIds);
      recordMatchAction(currentPlayer.name, currentPlayer.hand.filter(card => selectedCardIds.includes(card.id)), 'played');
      setGameState(newState);
      setSelectedCardIds([]); // clear selection
      setCoachHint(null); // clear hint after play
      if (isOnline && gameId) {
        const updated_at = new Date().toISOString();
        latestGameUpdateRef.current = Date.parse(updated_at);
        const { error } = await supabase.from('games').update({ game_state: newState, status: newState.status, updated_at }).eq('id', gameId);
        if (error) showAlert('Sync Error', 'Your move may not have synced. Check your connection.', 'warning');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('Cannot win with a power card')) {
        showAlert('Forbidden Finish!', 'You cannot win the game with a Power Card as your last card.\n\nPlay a standard card (4â€“10) to win.', 'error');
      } else if (msg.includes('Must play attack card')) {
        showAlert('Defend Yourself!', 'You have a 2, 3, or Ace in hand â€” you MUST play it to defend against the attack!', 'warning');
      } else {
        showAlert('Error', msg, 'error');
      }
      setSelectedCardIds([]); // clear selection on error
    }
  };

  const handleSuitSelect = async (suit: Suit) => {
    if (!gameState || selectedCardIds.length === 0) return;
    const currentPlayer = getCurrentPlayer(gameState);
    
    try {
      const newState = playCards(gameState, currentPlayer.id, selectedCardIds, suit);
      recordMatchAction(currentPlayer.name, currentPlayer.hand.filter(card => selectedCardIds.includes(card.id)), 'played');
      setGameState(newState);
      setShowSuitPicker(false);
      setSelectedCardIds([]); // clear selection
      if (isOnline && gameId) {
        const updated_at = new Date().toISOString();
        latestGameUpdateRef.current = Date.parse(updated_at);
        await supabase.from('games').update({ game_state: newState, status: newState.status, updated_at }).eq('id', gameId);
      }
    } catch (err) {
      showAlert('Error', err instanceof Error ? err.message : 'Error playing Ace.', 'error');
      setShowSuitPicker(false);
      setSelectedCardIds([]);
    }
  };

  const handleDrawCard = async () => {
    if (!gameState || isGameOver(gameState)) return;
    const currentPlayer = getCurrentPlayer(gameState);
    if (currentPlayer.id !== myPlayerId) { showAlert('Not Your Turn', 'Wait for your turn!', 'warning'); return; }
    try {
      const newState = drawCard(gameState, currentPlayer.id);
      const updatedPlayer = newState.players.find(player => player.id === currentPlayer.id);
      const drawnCards = updatedPlayer ? updatedPlayer.hand.filter(card => !currentPlayer.hand.some(before => before.id === card.id)) : [];
      recordMatchAction(currentPlayer.name, drawnCards, 'drew');
      setGameState(newState);
      if (isOnline && gameId) {
        const updated_at = new Date().toISOString();
        latestGameUpdateRef.current = Date.parse(updated_at);
        await supabase.from('games').update({ game_state: newState, status: newState.status, updated_at }).eq('id', gameId);
      }
      setCoachHint(null); // clear hint after turn
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      if (msg.includes('Must play attack card')) {
        showAlert('Defend First!', 'You have a 2, 3, or Ace. You must play one of those to defend â€” you cannot draw while you can defend!', 'warning');
      } else {
        showAlert('Draw Error', msg, 'error');
      }
    }
  };

  const handleGetHint = async () => {
    if (!gameState || !myPlayerId) return;
    setIsCoachThinking(true);
    setCoachHint(null);
    try {
      const engine = new GhurtMCTSEngine(myPlayerId);
      const insight = await engine.getBestMoveWithInsights(gameState, 1500, 100);
      if (insight) {
        setCoachHint(insight);
        // Auto-select the cards to help the player
        if (insight.playAction.cardIds) {
          setSelectedCardIds(insight.playAction.cardIds);
        } else {
          setSelectedCardIds([]);
        }
      } else {
        showAlert('Coach', 'No moves found.', 'info');
      }
    } catch (e) {
      console.error(e);
      showAlert('Coach Error', 'Could not compute hint.', 'error');
    } finally {
      setIsCoachThinking(false);
    }
  };

  const handleExitGamePress = () => {
    handleBackToMenu();
  };

  const handleBackToMenu = () => {
    const wasGameOver = gameState && isGameOver(gameState);
    
    const goBack = () => {
      setGameState(null);
      setGameId(null);
      setMyPlayerId(null);
      setProcessedGameOver(false);
      setIsOnline(false);
      setIsWaitingForOpponent(false);
      setIsMatchmaking(false);
      setShowSuitPicker(false);
      setShowHistoryModal(false);
      setShuffledGameId(null);
      setIsShuffling(false);
      setBotProfiles([]);
      setLobbyPlayers([]);
      setMatchHistory([]);
      AsyncStorage.removeItem('@ghurt_active_match_history').catch(() => undefined);

      // Clear matchmaking fallback timer
      if (matchmakingTimeoutRef.current) {
        clearTimeout(matchmakingTimeoutRef.current);
        matchmakingTimeoutRef.current = null;
      }

      Object.values(botTimersRef.current).forEach(t => t && clearTimeout(t));
      botTimersRef.current = {};
      
      // Voice Teardown
      if (voiceRoomRef.current) {
        voiceRoomRef.current.cleanUpAll();
        voiceRoomRef.current = null;
      }
      setRemoteStreams({});
      setIsMicMuted(false);
      setIsDeafened(false);
    };

    if (wasGameOver) {
      admobService.showInterstitialAd(goBack);
    } else {
      goBack();
    }
  };

  // â”€â”€â”€ REALTIME SUBSCRIPTION â”€â”€â”€
  useEffect(() => {
    if (!gameId || !isOnline) return;
    const channel = supabase.channel(`game:${gameId}`).on('postgres_changes', {
      event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}`,
    }, (payload: any) => {
      if (payload.eventType === 'DELETE') {
        showAlert('Room Closed', 'The host closed the room or the game ended.', 'warning');
        handleBackToMenu(); return;
      }
      const updatedGame = payload.new;
      if (updatedGame) {
        const updateTime = Date.parse(updatedGame.updated_at || '') || 0;
        if (updateTime && updateTime < latestGameUpdateRef.current) return;
        if (updateTime) latestGameUpdateRef.current = updateTime;
        if (Array.isArray(updatedGame.joined_players)) {
          setLobbyPlayers(updatedGame.joined_players);
        }
        if (updatedGame.status === 'playing') setIsWaitingForOpponent(false);
        if (updatedGame.game_state) setGameState(updatedGame.game_state);
      }
    }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [gameId, isOnline]);

  // â”€â”€â”€ VOICE CHAT INITIALIZATION â”€â”€â”€
  useEffect(() => {
    if (isOnline && roomCode && myPlayerId && !voiceRoomRef.current) {
      const vrm = new VoiceRoomManager(
        myPlayerId,
        roomCode,
        (peerId, stream) => {
          setRemoteStreams(prev => ({ ...prev, [peerId]: stream }));
        },
        (peerId) => {
          setRemoteStreams(prev => {
            const next = { ...prev };
            delete next[peerId];
            return next;
          });
        }
      );
      vrm.initialize().catch(e => console.error("Voice Room error:", e));
      voiceRoomRef.current = vrm;
    }
  }, [isOnline, roomCode, myPlayerId]);

  // â”€â”€â”€ SHUFFLE ANIMATION â”€â”€â”€
  useEffect(() => {
    const activeGameId = gameId || 'bot-game';
    if (gameState && shuffledGameId !== activeGameId) {
      setIsShuffling(true);
      Animated.sequence([
        Animated.timing(shuffleAnim, { toValue: 1.2, duration: 280, useNativeDriver: true }),
        Animated.timing(shuffleAnim, { toValue: 0.9, duration: 200, useNativeDriver: true }),
        Animated.timing(shuffleAnim, { toValue: 1.15, duration: 200, useNativeDriver: true }),
        Animated.timing(shuffleAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(shuffleAnim, { toValue: 1.1, duration: 180, useNativeDriver: true }),
        Animated.timing(shuffleAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start(() => { setIsShuffling(false); setShuffledGameId(activeGameId); });
    }
  }, [gameState, gameId, shuffledGameId]);

  // â”€â”€â”€ BOT AI TURNS â”€â”€â”€
  useEffect(() => {
    if (!gameState || isGameOver(gameState) || !botProfiles.length || isShuffling) return;
    const currentPlayer = getCurrentPlayer(gameState);
    
    // In online mode, we only run the AI for bots that are managed by this host client
    if (isOnline && !botProfiles.some((b: any) => b._botId === currentPlayer.id)) return;

    const botProfile = botProfiles.find((b: any) => b._botId === currentPlayer.id);
    if (!botProfile) return;

    const botId = currentPlayer.id;
    if (botTimersRef.current[botId]) clearTimeout(botTimersRef.current[botId]!);
    const reactionTime = Math.max(400, (botProfile.reactionTime || 800) * 0.6);
    
    botTimersRef.current[botId] = setTimeout(async () => {
      try {
        let newState = gameState;
        
        // Improve Bot Personalities: "Strategic" bots now utilize the Unbeatable MCTS Engine!
        if (botProfile.personality === 'strategic') {
          const engine = new GhurtMCTSEngine(botId);
          // Run a lightweight search (200 iterations, 15 per batch) to keep bot turns fast and UI completely unblocked
          const insight = await engine.getBestMoveWithInsights(gameState, 200, 15);
          if (insight) {
            if (insight.playAction.type === 'PLAY') {
              const cardIds = insight.playAction.cardIds || [];
              newState = playCards(gameState, botId, cardIds, insight.playAction.chosenSuit);
            } else {
              newState = drawCard(gameState, botId);
            }
          } else {
            newState = drawCard(gameState, botId);
          }
        } else {
          // Standard heuristic bots
          const decision = getBotDecision(gameState, botProfile);
          newState = executeBotDecision(gameState, decision, botId);
        }
        
        setGameState(newState);
        if (isOnline && gameId) {
          const { error } = await supabase.from('games').update({
            game_state: newState,
            status: newState.status,
            updated_at: new Date().toISOString()
          }).eq('id', gameId);
          if (error) console.error('[Bot AI] Online DB sync error:', error);
        }
      } catch (e) { 
        console.warn('Bot AI execution error, applying fallback to prevent crash:', e); 
        // â”€â”€â”€ CRASH PREVENTION â”€â”€â”€
        // If a bot somehow selects an invalid move (e.g., must play an attack card but failed to),
        // we force a safe fallback (drawing a card) to ensure the turn passes and the app never soft-locks.
        try {
          const safeState = drawCard(gameState, botId);
          setGameState(safeState);
          if (isOnline && gameId) {
            await supabase.from('games').update({
              game_state: safeState,
              status: safeState.status,
              updated_at: new Date().toISOString()
            }).eq('id', gameId);
          }
        } catch (fatalError) {
          console.error('Fatal bot lock:', fatalError);
        }
      }
    }, reactionTime);

    return () => { if (botTimersRef.current[botId]) clearTimeout(botTimersRef.current[botId]!); };
  }, [gameState, botProfiles, isShuffling, isOnline, gameId]);

  const getCardDisplay = (card: Card) => {
    const suitSymbols: Record<Suit, string> = { hearts: 'â™¥', diamonds: 'â™¦', clubs: 'â™£', spades: 'â™ ' };
    const suitColors: Record<Suit, string> = { hearts: '#e74c3c', diamonds: '#e74c3c', clubs: '#1a1a2e', spades: '#1a1a2e' };
    return { symbol: suitSymbols[card.suit], color: suitColors[card.suit] };
  };

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // RENDER: SHUFFLING SCREEN
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (gameState && isShuffling) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.bg} />
        <View style={styles.lobbyContent}>
          <Animated.View style={[styles.card, styles.faceDownCard, { transform: [{ scale: shuffleAnim }], width: 120, height: 170 }]}>
            <Text style={{ fontSize: 55, color: '#fff' }}>ðŸ‚ </Text>
          </Animated.View>
          <Text style={[styles.gameTitle, { marginTop: 40, fontSize: 30 }]}>Shuffling Deck...</Text>
          <Text style={styles.lobbySubtext}>Dealing 4 cards to each player</Text>
        </View>
      </View>
    );
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // RENDER: GAME SCREEN
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (gameState && !isShuffling) {
    const currentPlayer = getCurrentPlayer(gameState);
    const topCard = getTopCard(gameState);
    const me = gameState.players.find(p => p.id === myPlayerId);
    const isPlayerTurn = currentPlayer.id === myPlayerId;

    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.bg} />

        <View style={styles.gameHeader}>
          <TouchableOpacity onPress={handleExitGamePress} style={styles.iconButton}>
            <Text style={styles.iconButtonText}>â†</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>CardFlow</Text>
          
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {isOnline && (
              <>
                <TouchableOpacity onPress={() => {
                  const newState = !isMicMuted;
                  setIsMicMuted(newState);
                  if (voiceRoomRef.current) voiceRoomRef.current.setMicMuted(newState);
                }} style={styles.iconButton}>
                  <Text style={styles.iconButtonText}>{isMicMuted ? 'ðŸ”‡' : 'ðŸŽ™ï¸'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => {
                  const newState = !isDeafened;
                  setIsDeafened(newState);
                  if (voiceRoomRef.current) voiceRoomRef.current.setDeafened(newState);
                }} style={styles.iconButton}>
                  <Text style={styles.iconButtonText}>{isDeafened ? 'ðŸ”•' : 'ðŸŽ§'}</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity onPress={() => setShowHistoryModal(true)} style={styles.iconButton}>
              <Text style={styles.iconButtonText}>ðŸ‘ï¸</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Hidden RTCViews to physically play the audio tracks */}
        {Object.entries(remoteStreams).map(([peerId, stream]) => (
          <RTCView key={`rtc-${peerId}`} streamURL={stream.toURL()} style={{ width: 0, height: 0, position: 'absolute' }} />
        ))}

        {/* Floating Play Button - visible when cards are selected */}
        {selectedCardIds.length > 0 && isPlayerTurn && (
          <View style={styles.floatingPlayButtonContainer}>
            <TouchableOpacity style={styles.floatingPlayButton} onPress={handlePlaySelected}>
              <Text style={styles.floatingPlayButtonText}>
                â–¶ PLAY ({selectedCardIds.length})
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <ScrollView contentContainerStyle={styles.scrollContent}>

          {/* All Opponents at top */}
          <View style={styles.opponentsArea}>
            {gameState.players.filter(p => p.id !== myPlayerId).map(p => {
              const isTheirTurn = currentPlayer.id === p.id;
              return (
                <View key={p.id} style={[styles.opponentCard, isTheirTurn && styles.activeOpponentBorder]}>
                  <View style={styles.opponentAvatarFrame}>
                    <Text style={styles.opponentAvatarText}>{p.name.slice(0, 1).toUpperCase()}</Text>
                  </View>
                  {isTheirTurn && <Text style={styles.turnDot}>â–¶</Text>}
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={styles.playerName}>{p.name}</Text>
                    {renderOnlineDot(p.id)}
                  </View>
                  <View style={styles.cardCountBadge}>
                    <Text style={styles.cardCountText}>ðŸƒ {p.hand.length}</Text>
                  </View>
                </View>
              );
            })}
          </View>

          {/* Status Bar */}
          <View style={styles.gameStatus}>
            {gameState.penaltyCounter > 0 && (
              <View style={styles.attackWarning}>
                <Text style={styles.attackWarningText}>âš ï¸ ATTACK: Draw {gameState.penaltyCounter} or defend with 2/3/Ace</Text>
              </View>
            )}
            {gameState.isReshuffling && (
              <View style={styles.reshuffleNotice}>
                <Text style={styles.reshuffleText}>ðŸ”„ Deck reshuffled!</Text>
              </View>
            )}
            {gameState.activeSuit && (
              <View style={styles.activeSuitNotice}>
                <Text style={styles.activeSuitText}>
                  Active Suit: {gameState.activeSuit === 'hearts' ? 'â™¥' : gameState.activeSuit === 'diamonds' ? 'â™¦' : gameState.activeSuit === 'clubs' ? 'â™£' : 'â™ '} {gameState.activeSuit.toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={[styles.turnIndicator, isPlayerTurn && styles.myTurnIndicator]}>
              {isPlayerTurn ? 'âœ… YOUR TURN' : `â³ ${currentPlayer.name.toUpperCase()}'S TURN`}
            </Text>
            {gameState.playDirection === -1 && (
              <Text style={styles.directionBadge}>ðŸ”„ Reversed Direction</Text>
            )}
          </View>

          {/* Piles */}
          <View style={styles.playArea}>
            <View style={styles.discardPile}>
              <Text style={styles.pileLabel}>DISCARD</Text>
              {topCard && (
                <View style={[styles.card, styles.topCard]}>
                  <Text style={[styles.cardTopRank, { color: getCardDisplay(topCard).color }]}>{topCard.rank}</Text>
                  <Text style={[styles.cardTopSuit, { color: getCardDisplay(topCard).color }]}>{getCardDisplay(topCard).symbol}</Text>
                  <Text style={[styles.cardBottomRank, { color: getCardDisplay(topCard).color }]}>{topCard.rank}</Text>
                </View>
              )}
            </View>
            <View style={styles.drawPile}>
              <Text style={styles.pileLabel}>DRAW</Text>
              <TouchableOpacity onPress={handleDrawCard} disabled={!isPlayerTurn} activeOpacity={0.7}>
                <View style={[styles.card, styles.faceDownCard, !isPlayerTurn && styles.disabledDraw]}>
                  <Text style={{ fontSize: 50, color: 'rgba(255,255,255,0.9)' }}>ðŸ‚ </Text>
                </View>
              </TouchableOpacity>
              <Text style={styles.drawCount}>{gameState.drawPile.length} left</Text>
            </View>
          </View>

          {/* My Hand */}
          {me && (
            <View style={styles.playerHandSection}>
              <View style={styles.myPlayerHeader}>
                <Text style={styles.myPlayerName}>{me.name} (You)</Text>
                <View style={styles.cardCountBadge}>
                  <Text style={styles.cardCountText}>ðŸƒ {me.hand.length}</Text>
                </View>
              </View>
              
              {isPlayerTurn && (
                <View style={{ marginHorizontal: 20, marginBottom: 10 }}>
                  <TouchableOpacity 
                    style={[styles.glassButton, { padding: 10, backgroundColor: isCoachThinking ? 'rgba(155, 89, 182, 0.5)' : 'rgba(155, 89, 182, 0.8)' }]} 
                    onPress={handleGetHint}
                    disabled={isCoachThinking}
                  >
                    {isCoachThinking ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                        <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                        <Text style={[styles.buttonText, { fontSize: 14 }]}>Coach is thinking...</Text>
                      </View>
                    ) : (
                      <Text style={[styles.buttonText, { fontSize: 14 }]}>ðŸ¤– Get Coach Hint</Text>
                    )}
                  </TouchableOpacity>
                  
                  {coachHint && !isCoachThinking && (
                    <View style={{ marginTop: 10, padding: 12, backgroundColor: 'rgba(46, 204, 113, 0.2)', borderRadius: 8, borderWidth: 1, borderColor: 'rgba(46, 204, 113, 0.5)' }}>
                      <Text style={{ color: '#2ecc71', fontWeight: 'bold', fontSize: 14 }}>ðŸ’¡ Coach says:</Text>
                      <Text style={{ color: '#fff', fontSize: 14, marginTop: 4 }}>{coachHint.tipText}</Text>
                    </View>
                  )}
                </View>
              )}
              <ScrollView style={styles.handScrollContainer} nestedScrollEnabled>
                <View style={styles.handGrid}>
                  {me.hand.map(card => {
                    const display = getCardDisplay(card);
                    return (
                      <TouchableOpacity
                        key={card.id}
                        style={[
                          styles.card, 
                          styles.handCard, 
                          !isPlayerTurn && styles.disabledCard,
                          selectedCardIds.includes(card.id) && styles.selectedCard
                        ]}
                        onPress={() => handleCardPress(card)}
                        activeOpacity={0.75}
                      >
                        <Text style={[styles.cardTopRank, { color: display.color }]}>{card.rank}</Text>
                        <Text style={[styles.cardTopSuit, { color: display.color }]}>{display.symbol}</Text>
                        <Text style={[styles.cardBottomRank, { color: display.color }]}>{card.rank}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
            </View>
          )}

          {/* Game Over */}
          {isGameOver(gameState) && (
            <View style={styles.modalOverlay}>
              <View style={styles.gameOverCard}>
                <Text style={styles.gameOverTitle}>ðŸ† Game Over!</Text>
                {(() => {
                  const winner = gameState.players.find(player => player.id === gameState.winner);
                  const reward = getMatchReward(gameState.initialPlayerCount || gameState.players.length);
                  return <>
                    <View style={styles.winnerCard}>
                      <View style={styles.winnerAvatar}><Text style={styles.winnerAvatarText}>{winner?.name?.slice(0, 1).toUpperCase() || 'W'}</Text></View>
                      <Text style={styles.winnerName}>{winner?.name || 'Winner'}</Text>
                      <Text style={styles.winnerLabel}>wins this match</Text>
                    </View>
                    <Text style={styles.gameReward}>+{reward} Coins</Text>
                    <Text style={styles.gameOverWinner}>{gameState.players.length}-player match reward</Text>
                  </>;
                })()}
                <TouchableOpacity style={styles.playAgainButton} onPress={handleBackToMenu}>
                  <Text style={styles.playAgainButtonText}>Back to Menu</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Suit Picker */}
          {showSuitPicker && (
            <View style={styles.modalOverlay}>
              <View style={styles.suitPickerCard}>
                <Text style={styles.suitPickerTitle}>Choose a Suit (Ace)</Text>
                <View style={styles.suitOptions}>
                  {(['hearts', 'diamonds', 'clubs', 'spades'] as Suit[]).map(suit => (
                    <TouchableOpacity key={suit} style={[styles.suitOption, styles[suit]]} onPress={() => handleSuitSelect(suit)}>
                      <Text style={styles.suitOptionText}>
                        {suit === 'hearts' && 'â™¥'}{suit === 'diamonds' && 'â™¦'}{suit === 'clubs' && 'â™£'}{suit === 'spades' && 'â™ '}
                      </Text>
                      <Text style={{ color: '#fff', fontSize: 10, marginTop: 4 }}>{suit}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          )}

          {/* History Modal */}
          {showHistoryModal && (
            <View style={styles.modalOverlay}>
              <View style={styles.historyCard}>
                <View style={styles.historyHeader}>
                  <Text style={styles.modalTitle}>ðŸ‘ï¸ Card History</Text>
                  <TouchableOpacity onPress={() => setShowHistoryModal(false)}>
                    <Text style={styles.closeIcon}>âœ•</Text>
                  </TouchableOpacity>
                </View>
                {(() => {
                  const historyEntries = gameState.moveHistory?.length ? gameState.moveHistory : matchHistory;
                  return <>
                <Text style={styles.lobbySubtext}>{historyEntries.length} recorded moves in this match</Text>
                <ScrollView style={styles.historyList} contentContainerStyle={{ paddingBottom: 12 }} showsVerticalScrollIndicator>
                  {[...historyEntries].reverse().map((entry, idx) => (
                    <View style={styles.historyRow} key={entry.id}>
                      <Text style={styles.historyIndex}>{historyEntries.length - idx}.</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.historyPlayer}>{entry.playerName} {entry.action}</Text>
                        <Text style={styles.historyCards}>{entry.cards.length ? entry.cards.map(card => `${card.rank}${getCardDisplay(card).symbol}`).join(', ') : 'cards'}</Text>
                      </View>
                    </View>
                  ))}
                  {historyEntries.length === 0 && <Text style={styles.lobbySubtext}>Moves will appear here as cards are played or drawn.</Text>}
                </ScrollView>
                  </>;
                })()}
              </View>
            </View>
          )}
        </ScrollView>

        <AlertModal visible={alertState.visible} title={alertState.title} message={alertState.message} type={alertState.type} onClose={hideAlert} />
      </View>
    );
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // RENDER: AUTH LOADING SPLASH
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (authLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.bg} />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={styles.gameTitle}>CardFlow</Text>
          <ActivityIndicator size="large" color="#a855f7" style={{ marginTop: 30 }} />
        </View>
      </View>
    );
  }

  // â”€â”€ App Open Ad Splash Gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // While the cold-start App Open ad is loading/showing (appReady=false),
  // render a branded splash that fully blocks the lobby so users cannot
  // accidentally tap any game buttons. Once the ad closes (or 5s timeout fires)
  // appReady becomes true and the real UI is shown.
  if (!appReady) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <View style={styles.bg} />
        <Text style={styles.gameTitle}>CardFlow</Text>
        <Text style={[styles.gameSubtitle, { marginTop: 8, opacity: 0.7 }]}>Loadingâ€¦</Text>
        <ActivityIndicator size="large" color="#a855f7" style={{ marginTop: 30 }} />
      </View>
    );
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // RENDER: AUTH SCREEN (Login / Signup)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!authUser) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.bg} />
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 40 : 20} style={{ flex: 1 }}>
            <View style={styles.authContainer}>
              {/* Logo */}
              <View style={styles.authLogoArea}>
                <View style={styles.authLogoCircle}>
                  <Text style={styles.authLogoText}>ðŸƒ</Text>
                </View>
                <Text style={styles.gameTitle}>CardFlow</Text>
                <Text style={styles.gameSubtitle}>The Ultimate Card Battle</Text>
              </View>

              {/* Auth Card */}
              <View style={styles.authCard}>
                {/* Tab Switcher */}
                <View style={styles.authTabs}>
                  <TouchableOpacity style={[styles.authTab, authScreen === 'login' && styles.authTabActive]} onPress={() => setAuthScreen('login')}>
                    <Text style={[styles.authTabText, authScreen === 'login' && styles.authTabTextActive]}>Sign In</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.authTab, authScreen === 'signup' && styles.authTabActive]} onPress={() => setAuthScreen('signup')}>
                    <Text style={[styles.authTabText, authScreen === 'signup' && styles.authTabTextActive]}>Sign Up</Text>
                  </TouchableOpacity>
                </View>

                {/* Username (signup only) */}
                {authScreen === 'signup' && (
                  <View style={styles.authFieldGroup}>
                    <Text style={styles.authFieldLabel}>ðŸ‘¤ Username</Text>
                    <TextInput style={styles.authInput} placeholder="e.g. janesmith" placeholderTextColor="rgba(255,255,255,0.35)" value={authUsername} onChangeText={setAuthUsername} autoCapitalize="none" autoCorrect={false} />
                  </View>
                )}

                {/* Email */}
                <View style={styles.authFieldGroup}>
                  <Text style={styles.authFieldLabel}>âœ‰ï¸ Email Address</Text>
                  <TextInput style={styles.authInput} placeholder="e.g. you@example.com" placeholderTextColor="rgba(255,255,255,0.35)" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none" />
                </View>

                {/* Password */}
                <View style={styles.authFieldGroup}>
                  <Text style={styles.authFieldLabel}>ðŸ”’ Password</Text>
                  <View style={styles.passwordInputContainer}>
                    <TextInput style={[styles.authInput, { flex: 1, borderWidth: 0 }]} placeholder="Min 6 characters" placeholderTextColor="rgba(255,255,255,0.35)" value={authPassword} onChangeText={setAuthPassword} secureTextEntry={!showPassword} />
                    <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={{ padding: 10 }}>
                      <Ionicons name={showPassword ? "eye-off" : "eye"} size={20} color="rgba(255,255,255,0.5)" />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Confirm Password (signup only) */}
                {authScreen === 'signup' && (
                  <View style={styles.authFieldGroup}>
                    <Text style={styles.authFieldLabel}>ðŸ”’ Confirm Password</Text>
                    <View style={styles.passwordInputContainer}>
                      <TextInput style={[styles.authInput, { flex: 1, borderWidth: 0 }]} placeholder="Re-enter password" placeholderTextColor="rgba(255,255,255,0.35)" value={authConfirmPassword} onChangeText={setAuthConfirmPassword} secureTextEntry={!showPassword} />
                      <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={{ padding: 10 }}>
                        <Ionicons name={showPassword ? "eye-off" : "eye"} size={20} color="rgba(255,255,255,0.5)" />
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                <TouchableOpacity style={styles.authActionButton} onPress={authScreen === 'login' ? handleLogin : handleSignup}>
                  <Text style={styles.authActionButtonText}>{authScreen === 'login' ? 'Sign In â†’' : 'Create Account â†’'}</Text>
                </TouchableOpacity>

                <Text style={styles.authNote}>
                  {authScreen === 'login' ? 'New here? ' : 'Already have an account? '}
                  <Text style={styles.authNoteLink} onPress={() => setAuthScreen(authScreen === 'login' ? 'signup' : 'login')}>
                    {authScreen === 'login' ? 'Create account' : 'Sign in instead'}
                  </Text>
                </Text>
              </View>
            </View>
          </KeyboardAvoidingView>
        </ScrollView>
        <AlertModal visible={alertState.visible} title={alertState.title} message={alertState.message} type={alertState.type} onClose={hideAlert} />
      </View>
    );
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // RENDER: LOBBY / WAITING SCREEN
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (isWaitingForOpponent) {
    const maxLobbyPlayers = 4;
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.bg} />
        <ScrollView
          style={styles.lobbyScroll}
          contentContainerStyle={styles.lobbyContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled={true}
        >
          <View style={styles.glassCard}>
            {isMatchmaking ? (
              <>
                <Text style={styles.lobbyTitle}>ðŸ” Finding a Match...</Text>
                <ActivityIndicator size="large" color="#8a2bbe" style={{ marginVertical: 30 }} />
                <Text style={styles.waitingText}>Connecting you to the best available opponent...</Text>
                <Text style={[styles.waitingText, { marginTop: 10, opacity: 0.6, fontSize: 12 }]}>If no one is found, you'll be matched with a player shortly.</Text>
              </>
            ) : (
              <>
                <Text style={styles.lobbyTitle}>ðŸŽ® Room Created!</Text>
                <Text style={styles.lobbySubtext}>Share this code with your friends:</Text>
                <View style={styles.roomCodeContainer}>
                  <Text style={styles.roomCodeText}>{roomCode}</Text>
                </View>
                <ActivityIndicator size="large" color="#8a2bbe" style={{ marginVertical: 20 }} />
                <Text style={styles.waitingText}>Waiting for players to join...</Text>
                <View style={styles.joinedPlayersCard}>
                  <Text style={styles.joinedPlayersTitle}>Players joined ({lobbyPlayers.length}/{maxLobbyPlayers})</Text>
                  {lobbyPlayers.length > 0 ? (
                    lobbyPlayers.map((player, index) => (
                      <View key={`${player.id}-${index}`} style={styles.joinedPlayerRow}>
                        <Text style={styles.joinedPlayerIndex}>{index + 1}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                          <Text style={styles.joinedPlayerName} numberOfLines={1} adjustsFontSizeToFit>
                            {player.name || `Player ${index + 1}`}
                          </Text>
                          {renderOnlineDot(player.id)}
                        </View>
                        {player.id === myPlayerId && <Text style={styles.joinedPlayerTag}>You</Text>}
                      </View>
                    ))
                  ) : (
                    <Text style={styles.waitingText}>No players joined yet.</Text>
                  )}
                </View>
                <TouchableOpacity style={[styles.glassButton, styles.createButton, { marginTop: 20 }]} onPress={handleHostStartGame}>
                  <Text style={styles.buttonText}>â–¶ Start Game</Text>
                  <Text style={styles.buttonSubtext}>Start with whoever has joined (min 2)</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
          <TouchableOpacity style={[styles.glassButton, { backgroundColor: 'rgba(200,0,0,0.3)', borderColor: 'rgba(255,0,0,0.4)', marginTop: 16, paddingHorizontal: 40 }]} onPress={handleLeaveLobby}>
            <Text style={styles.buttonText}>âŒ Leave</Text>
          </TouchableOpacity>

          <Text style={styles.poweredByText}>Powered by ESIR</Text>

          {/* â”€â”€ Banner Ad â€” below Powered by ESIR (AdMob policy compliant) â”€â”€ */}
          {adsSupportedNative && BannerAd ? (
            <View style={{ alignItems: 'center', marginTop: 30, marginBottom: 12 }}>
              <Text style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, letterSpacing: 1, marginBottom: 6 }}>ADVERTISEMENT</Text>
              <BannerAd
                unitId={AD_UNIT_IDS.banner}
                size={BannerAdSize.MEDIUM_RECTANGLE ?? 'MEDIUM_RECTANGLE'}
                requestOptions={{ requestNonPersonalizedAdsOnly: false }}
                onAdFailedToLoad={(err: any) => console.warn('[Banner] Load error:', err)}
              />
            </View>
          ) : null}
        </ScrollView>
        <AlertModal visible={alertState.visible} title={alertState.title} message={alertState.message} type={alertState.type} onClose={hideAlert} />
        {loading && <View style={styles.loadingOverlay}><ActivityIndicator size="large" color="#8a2bbe" /><Text style={styles.loadingText}>Please wait...</Text></View>}
      </View>
    );
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // RENDER: MAIN MENU
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.bg} />

      {/* TOP HEADER */}
      <View style={styles.topHeader}>
        <View style={styles.balanceBadge}>
          <Text style={styles.balanceIcon}>ðŸ’°</Text>
          <Text style={styles.balanceText}>{Number(userProfile.balance).toFixed(2)}</Text>
        </View>
        <Text style={styles.headerTitle}>CardFlow</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardView}>
          <View style={[styles.titleContainer, { marginTop: 10 }]}>
            <Text style={[styles.gameSubtitle, { marginTop: 0 }]}>Fluid Multiplayer Card Game</Text>
          </View>

          <View style={styles.glassCard}>
            <Text style={styles.label}>Your Name</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your name to play"
              placeholderTextColor="rgba(255,255,255,0.4)"
              value={playerName}
              onChangeText={(text) => {
                setPlayerName(text);
                saveProfile({ ...userProfile, displayName: text });
              }}
            />
          </View>

          {/* â”€â”€ Tournament Hero Cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          <TouchableOpacity
            onPress={openTournament}
            style={{
              marginBottom: 20,
              borderRadius: 18,
              overflow: 'hidden',
              borderWidth: 1.5,
              borderColor: 'rgba(241,196,15,0.55)',
              backgroundColor: 'rgba(241,196,15,0.07)',
            }}
            activeOpacity={0.82}
          >
            {/* Header row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(241,196,15,0.15)' }}>
              <Text style={{ fontSize: 22 }}>ðŸ†</Text>
              <Text style={{ flex: 1, color: '#f1c40f', fontSize: 18, fontWeight: '900', letterSpacing: 1.5, marginLeft: 10 }}>TOURNAMENTS</Text>
              <Text style={{ color: 'rgba(241,196,15,0.7)', fontSize: 12, fontWeight: '600' }}>TAP TO VIEW</Text>
            </View>

            {/* Weekly card */}
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(241,196,15,0.15)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Text style={{ fontSize: 20 }}>{tournamentDashboard.is_open ? 'ðŸ”“' : 'ðŸ”’'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Weekly Tournament</Text>
                <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 2 }}>Every Sunday Â· Top players win</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: '#f1c40f', fontWeight: '900', fontSize: 17 }}>10,000</Text>
                <Text style={{ color: 'rgba(241,196,15,0.7)', fontSize: 11, fontWeight: '600' }}>KES Prize</Text>
              </View>
            </View>

            {/* Monthly card */}
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(138,43,226,0.2)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Text style={{ fontSize: 20 }}>ðŸ”’</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Monthly Grand Prix</Text>
                <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 2 }}>Last day of month Â· Champions only</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: '#c084fc', fontWeight: '900', fontSize: 17 }}>35,000</Text>
                <Text style={{ color: 'rgba(192,132,252,0.7)', fontSize: 11, fontWeight: '600' }}>KES Prize</Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.glassButton, { backgroundColor: 'rgba(156, 39, 176, 0.15)', borderColor: '#9c27b0', borderWidth: 2, marginBottom: 20 }]} 
            onPress={() => setShowChallengeModal(true)}
          >
            <Text style={[styles.buttonText, { color: '#e040fb', fontSize: 18, textAlign: 'center' }]}>âš”ï¸ CHALLENGE PLAYERS</Text>
            <Text style={[styles.buttonSubtext, { textAlign: 'center', color: '#fff' }]}>
              {incomingRequests.length > 0 ? `ðŸ”¥ You have ${incomingRequests.length} pending challenge(s)` : 'Search & invite online players'}
            </Text>
          </TouchableOpacity>

          <View style={styles.gridContainer}>
            <TouchableOpacity style={[styles.gridButton, styles.randomButton]} onPress={handleFindRandom}>
              <Text style={styles.buttonText}>ðŸŽ² Random</Text>
              <Text style={styles.gridSubtext}>Global Match</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.gridButton, styles.createButton]} onPress={handleCreateRoom}>
              <Text style={styles.buttonText}>ðŸŽ® Create</Text>
              <Text style={styles.gridSubtext}>Host Private</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.gridButton, styles.joinButton]} onPress={() => setShowJoinModal(true)}>
              <Text style={styles.buttonText}>ðŸ”— Join</Text>
              <Text style={styles.gridSubtext}>Use Code</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.gridButton, styles.botButton]} onPress={handlePlayVsBot}>
              <Text style={styles.buttonText}>ðŸ¤– Bots</Text>
              <Text style={styles.gridSubtext}>Offline Play</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.gridButton, styles.rulesButton]} onPress={() => setShowRulesModal(true)}>
              <Text style={styles.buttonText}>ðŸ“– Rules</Text>
              <Text style={styles.gridSubtext}>How to play</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.gridButton, { backgroundColor: 'rgba(241,196,15,0.14)', borderColor: 'rgba(241,196,15,0.5)' }]}
              onPress={openTournament}
            >
              <Text style={styles.buttonText}>{tournamentDashboard.is_open ? 'ðŸ”“' : 'ðŸ”’'}</Text>
              <Text style={[styles.gridSubtext, { color: '#f1c40f', fontWeight: '700' }]}>Tournament</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.gridButton, { backgroundColor: 'rgba(233, 30, 99, 0.25)', borderColor: 'rgba(233, 30, 99, 0.5)' }]} onPress={() => setShowProfileModal(true)}>
              <Text style={styles.buttonText}>ðŸ‘¤ Profile</Text>
              <Text style={styles.gridSubtext}>Stats & Cash</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={[styles.glassButton, { backgroundColor: 'rgba(255, 193, 7, 0.25)', borderColor: 'rgba(255, 193, 7, 0.5)', marginTop: 16 }]} onPress={() => Linking.openURL('mailto:texasrush547@gmail.com?subject=CardFlow%20Support')}>
            <Text style={styles.buttonText}>âœ‰ï¸ Contact Support</Text>
            <Text style={styles.buttonSubtext}>Email us at texasrush547@gmail.com</Text>
          </TouchableOpacity>

          {/* â”€â”€ Tournament Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          {showTournamentModal && (
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, { maxHeight: '90%' }]}>
                <Text style={styles.modalTitle}>ðŸ† Tournaments</Text>

                <ScrollView style={{ flexGrow: 0, maxHeight: 480 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>

                  {/* Status pill */}
                  <View style={{ alignItems: 'center', marginBottom: 16 }}>
                    <View style={{
                      paddingHorizontal: 20, paddingVertical: 6, borderRadius: 20,
                      backgroundColor: tournamentDashboard.is_open ? 'rgba(74,222,128,0.15)' : 'rgba(255,100,100,0.12)',
                      borderWidth: 1,
                      borderColor: tournamentDashboard.is_open ? '#4ade80' : 'rgba(255,100,100,0.4)',
                    }}>
                      <Text style={{ color: tournamentDashboard.is_open ? '#4ade80' : '#ff7777', fontWeight: '800', fontSize: 13, letterSpacing: 1 }}>
                        {tournamentDashboard.is_open ? 'ðŸ”“ REGISTRATION OPEN' : 'ðŸ”’ REGISTRATION CLOSED'}
                      </Text>
                    </View>
                  </View>

                  {/* Weekly Prize Card */}
                  <View style={{
                    borderRadius: 16, marginBottom: 12, overflow: 'hidden',
                    borderWidth: 1.5, borderColor: 'rgba(241,196,15,0.4)',
                    backgroundColor: 'rgba(241,196,15,0.06)',
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(241,196,15,0.12)' }}>
                      <Text style={{ fontSize: 28, marginRight: 12 }}>{tournamentDashboard.is_open ? 'ðŸ”“' : 'ðŸ”’'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#f1c40f', fontWeight: '900', fontSize: 16, letterSpacing: 0.5 }}>Weekly Tournament</Text>
                        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 }}>Resets every Sunday midnight</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', padding: 14, alignItems: 'center' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>Prize Pool</Text>
                        <Text style={{ color: '#f1c40f', fontWeight: '900', fontSize: 28, lineHeight: 32 }}>KES 10,000</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Your Keys</Text>
                        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 22 }}>{tournamentDashboard.key_count || 0}</Text>
                      </View>
                    </View>
                  </View>

                  {/* Monthly Prize Card */}
                  <View style={{
                    borderRadius: 16, marginBottom: 16, overflow: 'hidden',
                    borderWidth: 1.5, borderColor: 'rgba(192,132,252,0.4)',
                    backgroundColor: 'rgba(138,43,226,0.06)',
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(192,132,252,0.12)' }}>
                      <Text style={{ fontSize: 28, marginRight: 12 }}>ðŸ”’</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#c084fc', fontWeight: '900', fontSize: 16, letterSpacing: 0.5 }}>Monthly Grand Prix</Text>
                        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 }}>Last Sunday of every month</Text>
                      </View>
                    </View>
                    <View style={{ padding: 14 }}>
                      <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>Prize Pool</Text>
                      <Text style={{ color: '#c084fc', fontWeight: '900', fontSize: 28, lineHeight: 32 }}>KES 35,000</Text>
                      <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 4 }}>Win 5+ weekly tournaments to qualify</Text>
                    </View>
                  </View>

                  {/* Player stats row */}
                  <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                    <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 12, alignItems: 'center' }}>
                      <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Your Points</Text>
                      <Text style={{ color: '#fff', fontWeight: '800', fontSize: 20 }}>{tournamentDashboard.points || 0}</Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 12, alignItems: 'center' }}>
                      <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Keys Held</Text>
                      <Text style={{ color: '#f1c40f', fontWeight: '800', fontSize: 20 }}>{tournamentDashboard.key_count || 0}</Text>
                    </View>
                  </View>

                  {/* Leaderboard */}
                  {tournamentDashboard.leaderboard?.length > 0 && (
                    <View style={{ marginBottom: 16 }}>
                      <Text style={[styles.label, { marginBottom: 8 }]}>ðŸ¥‡ Leaderboard</Text>
                      {tournamentDashboard.leaderboard.slice(0, 5).map((entry: any, idx: number) => (
                        <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' }}>
                          <Text style={{ width: 28, color: idx === 0 ? '#f1c40f' : idx === 1 ? '#c0c0c0' : idx === 2 ? '#cd7f32' : 'rgba(255,255,255,0.5)', fontWeight: '800', fontSize: 15 }}>
                            {idx === 0 ? 'ðŸ¥‡' : idx === 1 ? 'ðŸ¥ˆ' : idx === 2 ? 'ðŸ¥‰' : `#${idx + 1}`}
                          </Text>
                          <Text style={{ flex: 1, color: '#fff', fontWeight: '600' }}>{entry.display_name || entry.username || 'Player'}</Text>
                          <Text style={{ color: '#f1c40f', fontWeight: '800' }}>{entry.points} pts</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* Action buttons */}
                  <TouchableOpacity
                    style={[styles.modalButton, {
                      backgroundColor: 'rgba(241,196,15,0.2)', borderColor: '#f1c40f',
                      borderWidth: 1, marginBottom: 10,
                      opacity: tournamentDashboard.key_count > 0 ? 0.5 : 1,
                    }]}
                    onPress={buyTournamentKey}
                    disabled={tournamentDashboard.key_count > 0}
                  >
                    <Text style={[styles.modalButtonText, { color: '#f1c40f' }]}>
                      {tournamentDashboard.key_count > 0 ? 'âœ… Key Purchased' : 'ðŸ—ï¸ Buy Tournament Key'}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.modalButton, {
                      backgroundColor: tournamentDashboard.is_open && tournamentDashboard.key_count > 0 ? 'rgba(74,222,128,0.2)' : 'rgba(255,255,255,0.05)',
                      borderColor: tournamentDashboard.is_open && tournamentDashboard.key_count > 0 ? '#4ade80' : 'rgba(255,255,255,0.15)',
                      borderWidth: 1, marginBottom: 10,
                    }]}
                    onPress={enterTournament}
                    disabled={!tournamentDashboard.is_open || tournamentDashboard.key_count === 0}
                  >
                    <Text style={[styles.modalButtonText, {
                      color: tournamentDashboard.is_open && tournamentDashboard.key_count > 0 ? '#4ade80' : 'rgba(255,255,255,0.4)',
                    }]}>
                      {!tournamentDashboard.is_open ? 'ðŸ”’ Tournament Not Open' : tournamentDashboard.key_count === 0 ? 'ðŸ—ï¸ Need a Key to Enter' : 'â–¶ Enter Tournament'}
                    </Text>
                  </TouchableOpacity>

                  {/* Admin controls */}
                  {tournamentDashboard.is_admin && (
                    <View style={{ marginTop: 8, padding: 12, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }}>
                      <Text style={[styles.label, { color: '#ff9800', marginBottom: 10 }]}>âš™ï¸ Admin Controls</Text>
                      <TouchableOpacity style={[styles.modalButton, { backgroundColor: tournamentDashboard.is_open ? 'rgba(255,100,100,0.2)' : 'rgba(74,222,128,0.2)', marginBottom: 0 }]} onPress={() => setTournamentOpen(!tournamentDashboard.is_open)}>
                        <Text style={[styles.modalButtonText, { color: tournamentDashboard.is_open ? '#ff7777' : '#4ade80' }]}>
                          {tournamentDashboard.is_open ? 'ðŸ”’ Close Registration' : 'ðŸ”“ Open Registration'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </ScrollView>

                <TouchableOpacity style={[styles.modalButton, styles.cancelButton, { marginTop: 30 }]} onPress={() => setShowTournamentModal(false)}>
                  <Text style={styles.modalButtonText}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Profile / About Me Modal */}
          {showProfileModal && (
            <View style={styles.modalOverlay}>
                <View style={[styles.modalCard, styles.profileModalCard]}>
                <Text style={styles.modalTitle}>ðŸ‘¤ My Profile</Text>

                <ScrollView style={styles.profileScroll} contentContainerStyle={styles.profileScrollContent} nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
                  {/* Rich Profile Card */}
                  <ProfileCard user={userProfile} />

                  <Text style={[styles.label, { marginTop: 12, marginBottom: 8 }]}>Choose Avatar Style</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                    {DICEBEAR_STYLES.map(style => {
                      const currentStyle = (userProfile.avatarId || '').split(':')[0] || 'bottts';
                      const isSelected = currentStyle === style.id;
                      return (
                        <TouchableOpacity
                          key={style.id}
                          style={{
                            backgroundColor: isSelected ? 'rgba(156, 39, 176, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                            borderColor: isSelected ? '#e040fb' : 'rgba(255, 255, 255, 0.2)',
                            borderWidth: 1,
                            borderRadius: 10,
                            paddingVertical: 8,
                            paddingHorizontal: 12
                          }}
                          onPress={() => {
                            const seed = (userProfile.avatarId || '').split(':')[1] || userProfile.username || playerName || 'player';
                            saveProfile({ ...userProfile, avatarId: `${style.id}:${seed}` });
                          }}
                        >
                          <Text style={{ color: isSelected ? '#fff' : 'rgba(255, 255, 255, 0.8)', fontSize: 13, fontWeight: isSelected ? 'bold' : 'normal' }}>
                            {style.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <Text style={[styles.label, { marginBottom: 0 }]}>Want a different look?</Text>
                    <TouchableOpacity
                      accessibilityLabel="Randomize avatar"
                      style={{ backgroundColor: 'rgba(255,255,255,0.15)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10, justifyContent: 'center' }}
                      onPress={() => {
                        const style = (userProfile.avatarId || '').split(':')[0] || 'bottts';
                        const randomSeed = Math.random().toString(36).substring(2, 8);
                        saveProfile({ ...userProfile, avatarId: `${style}:${randomSeed}` });
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16 }}>ðŸŽ² Randomize</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Display Name */}
                  <Text style={[styles.label, { marginTop: 30 }]}>Display Name</Text>
                  <TextInput
                    style={[styles.input, { marginBottom: 14, fontSize: 16, letterSpacing: 1 }]}
                    value={playerName}
                    onChangeText={(text) => { setPlayerName(text); saveProfile({ ...userProfile, displayName: text }); }}
                    placeholder="Enter your display name"
                    placeholderTextColor="rgba(255,255,255,0.4)"
                  />

                  {/* Stats Card */}
                  <View style={styles.profileStatsCard}>
                    {(() => { const rank = getRank(userProfile.elo); return (
                      <>
                        <View style={styles.profileRankRow}>
                          <Text style={styles.profileRankIcon}>{getRankStars(userProfile.elo)}</Text>
                          <Text style={styles.profileRankText}>{rank}</Text>
                        </View>
                        <View style={styles.profileStatRow}>
                          <Text style={styles.profileStatLabel}>ELO Rating</Text>
                          <Text style={styles.profileStatValue}>{userProfile.elo}</Text>
                        </View>
                        <View style={styles.profileStatRow}>
                          <Text style={styles.profileStatLabel}>Wins / Losses</Text>
                          <Text style={[styles.profileStatValue, { color: '#4ade80' }]}>{userProfile.wins}W</Text>
                          <Text style={[styles.profileStatValue, { color: '#f87171' }]}>  {userProfile.losses}L</Text>
                        </View>
                        <View style={styles.profileStatRow}>
                          <Text style={styles.profileStatLabel}>Win Rate</Text>
                          <Text style={styles.profileStatValue}>
                            {userProfile.wins + userProfile.losses === 0 ? 'â€”' : `${Math.round((userProfile.wins / (userProfile.wins + userProfile.losses)) * 100)}%`}
                          </Text>
                        </View>
                        {/* ELO Progress Bar */}
                        <View style={styles.eloBarBg}>
                          <View style={[styles.eloBarFill, { 
                            width: `${typeof userProfile.elo === 'number' && !isNaN(userProfile.elo) 
                              ? Math.min(100, Math.max(0, (userProfile.elo % 700) / 7)) 
                              : 0}%` as any 
                          }]} />
                        </View>
                        <Text style={styles.eloBarLabel}>Progress to next rank</Text>
                      </>
                    ); })()}
                  </View>

                  {false && <View style={{ marginTop: 24, padding: 16, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 16 }}>
                    {/* Wallet header */}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <Text style={[styles.label, { color: '#f1c40f' }]}>ðŸ’° Wallet</Text>
                      <Text style={{ color: '#f1c40f', fontWeight: 'bold', fontSize: 16 }}>KES {userProfile.balance.toFixed(2)}</Text>
                    </View>

                    <Text style={[styles.label, { marginBottom: 4, color: '#f1c40f' }]}>Withdraw Funds</Text>
                    <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, marginBottom: 14 }}>
                      Available Balance: <Text style={{ color: '#f1c40f', fontWeight: 'bold' }}>KES {userProfile.balance.toFixed(2)}</Text>
                    </Text>

                    {/* Amount input */}
                    <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 4 }}>Amount to Withdraw (KES)</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="e.g. 500"
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={withdrawAmount}
                      onChangeText={setWithdrawAmount}
                      keyboardType="numeric"
                    />

                    {/* Phone / M-Pesa number */}
                    <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 4, marginTop: 10 }}>M-Pesa / Phone Number</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="e.g. 0712345678"
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={withdrawNumber}
                      onChangeText={setWithdrawNumber}
                      keyboardType="phone-pad"
                    />

                    {/* Password verification */}
                    <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 4, marginTop: 10 }}>Account Password (Security Verification)</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Enter your login password"
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={withdrawPassword}
                      onChangeText={setWithdrawPassword}
                      secureTextEntry={true}
                    />

                    <TouchableOpacity
                      style={[styles.modalButton, { backgroundColor: '#f1c40f', marginTop: 30 }]}
                      onPress={async () => {
                        const amt = parseFloat(withdrawAmount);
                        const phone = withdrawNumber.trim();
                        const pwd = withdrawPassword.trim();
                        if (!amt || isNaN(amt) || amt < 10) {
                          showAlert('Invalid Amount', 'Minimum withdrawal is KES 10.', 'error');
                          return;
                        }
                        if (amt > Number(userProfile.balance)) {
                          showAlert('Insufficient Balance', `You only have KES ${Number(userProfile.balance).toFixed(2)}.`, 'error');
                          return;
                        }
                        if (!phone || phone.length < 9) {
                          showAlert('Phone Required', 'Please enter a valid M-Pesa / phone number.', 'warning');
                          return;
                        }
                        if (!pwd) {
                          showAlert('Password Required', 'Please enter your account password to verify this withdrawal.', 'warning');
                          return;
                        }
                        
                        setLoading(true);
                        try {
                          const { data, error } = await supabase.functions.invoke('mpesa-withdraw', {
                            body: { amount: amt, phone: phone, password: pwd }
                          });
                          
                          if (error) throw error;
                          if (data?.error) throw new Error(data.error);

                          showAlert('Withdrawal Processing', `KES ${amt.toFixed(2)} is being processed to ${phone}.`, 'info');
                          setWithdrawAmount('');
                          setWithdrawNumber('');
                          setWithdrawPassword('');
                          
                          // Refresh balance from DB
                          if (authUser?.id) {
                            const { data: fresh } = await supabase.from('users').select('balance').eq('id', authUser.id).single();
                            if (fresh) {
                              const b = Number(fresh.balance);
                              setUserProfile(prev => ({ ...prev, balance: isNaN(b) ? prev.balance : b }));
                            }
                          }
                        } catch (e: any) {
                          let msg = e.message || 'Could not process withdrawal.';
                          // Clean up error message if it's a JSON response from Edge Function
                          try {
                            const parsed = JSON.parse(e.message);
                            if (parsed.error) msg = parsed.error;
                          } catch (_) {}
                          showAlert('Withdrawal Error', msg, 'error');
                        } finally { setLoading(false); }
                      }}
                    >
                      <Text style={[styles.modalButtonText, { color: '#000' }]}>Withdraw KES {withdrawAmount || '0'}</Text>
                    </TouchableOpacity>
                  </View>}

                  {/* Rewarded Ad Top-Up Button */}
                  <TouchableOpacity
                    style={[
                      styles.glassButton,
                      {
                        backgroundColor: 'rgba(74, 222, 128, 0.15)',
                        borderColor: '#4ade80',
                        borderWidth: 1,
                        borderRadius: 12,
                        paddingVertical: 12,
                        marginTop: 18,
                        marginBottom: 10,
                      }
                    ]}
                    onPress={() => {
                      admobService.showRewardedAd(
                        async (rewardAmount) => {
                          try {
                            // Each rewarded ad grants 100 coins
                            // User can watch 2 ads to get 200 coins total.
                            const coinsEarned = 100;
                            const newWatchCount = adsWatchedForReward + 1;
                            setAdsWatchedForReward(newWatchCount);

                            const newBalance = Number(userProfile.balance) + coinsEarned;
                            const updated = { ...userProfile, balance: newBalance };

                            setUserProfile(updated);
                            await AsyncStorage.setItem('@ghurt_profile', JSON.stringify(updated));

                            if (authUser?.id) {
                              await supabase
                                .from('users')
                                .update({ balance: newBalance })
                                .eq('id', authUser.id);
                            }

                            if (newWatchCount >= 2) {
                              setAdsWatchedForReward(0);
                              showAlert('ðŸŽ‰ Reward Complete!', `You watched 2 ads and earned 200 coins!`, 'info');
                            } else {
                              showAlert('Ad Complete!', `+${coinsEarned} coins! Watch 1 more ad to complete your 200-coin reward.`, 'info');
                            }
                          } catch (e: any) {
                            console.error('Failed to reward user:', e);
                            showAlert('Reward Error', 'Could not update your balance.', 'error');
                          }
                        },
                        () => { console.log('Rewarded ad closed.'); },
                        () => {
                          showAlert(
                            'Ad Not Ready',
                            'No ad is available right now. Please try again in a moment.',
                            'info'
                          );
                        }
                      );
                    }}
                  >
                    <Text style={[styles.buttonText, { color: '#4ade80', fontSize: 16, textAlign: 'center' }]}>
                      ðŸ“º Watch Ad for Coins ({adsWatchedForReward}/2 â†’ = +100 each)
                    </Text>
                  </TouchableOpacity>
                </ScrollView>

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 }}>
                  <TouchableOpacity style={[styles.modalButton, { backgroundColor: 'rgba(255,0,0,0.2)', borderColor: 'rgba(255,0,0,0.5)', borderWidth: 1, flex: 1, marginRight: 8 }]} onPress={handleLogout}>
                    <Text style={[styles.modalButtonText, { color: '#ff4444' }]}>Log Out</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.modalButton, styles.cancelButton, { flex: 1, marginLeft: 8 }]} onPress={() => setShowProfileModal(false)}>
                    <Text style={styles.modalButtonText}>Close</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          {/* M-Pesa Deposit Modal */}
          {false && showDepositWebView && (
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, { maxHeight: '92%' }]}>
                {/* Header */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <Text style={[styles.modalTitle, { marginBottom: 0 }]}>ðŸ’³ Deposit via M-Pesa</Text>
                  <TouchableOpacity onPress={() => {
                    setShowDepositWebView(false);
                    setDepositStatus('idle');
                    setDepositError('');
                    setDepositSuccessMessage('');
                  }}>
                    <Ionicons name="close-circle" size={28} color="rgba(255,255,255,0.5)" />
                  </TouchableOpacity>
                </View>

                {depositStatus === 'sent' ? (
                  // â”€â”€ Success View â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                  <View style={{ alignItems: 'center', paddingVertical: 24 }}>
                    <Text style={{ fontSize: 48, marginBottom: 12 }}>ðŸ“²</Text>
                    <Text style={{ color: '#4ade80', fontSize: 18, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' }}>STK Push Sent!</Text>
                    <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                      {depositSuccessMessage || 'Check your phone for the M-Pesa prompt and enter your PIN to complete the deposit. Your balance will update automatically once payment is confirmed.'}
                    </Text>
                    <TouchableOpacity
                      style={[styles.modalButton, { backgroundColor: 'rgba(74,222,128,0.2)', borderColor: 'rgba(74,222,128,0.5)', borderWidth: 1, marginTop: 20 }]}
                      onPress={() => {
                        setShowDepositWebView(false);
                        setDepositStatus('idle');
                        setDepositAmount('');
                        setDepositPhone('');
                        setDepositTermsAgreed(false);
                        setDepositError('');
                        setDepositSuccessMessage('');
                      }}
                    >
                      <Text style={[styles.modalButtonText, { color: '#4ade80' }]}>Done</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  // â”€â”€ Input Form â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                  <ScrollView showsVerticalScrollIndicator={false}>
                    {/* Amount */}
                    <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 6 }}>Amount (KES) â€” min 35, max 1500</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="e.g. 100"
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={depositAmount}
                      onChangeText={setDepositAmount}
                      keyboardType="numeric"
                    />

                    {/* Phone */}
                    <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 6, marginTop: 12 }}>M-Pesa Phone Number</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="e.g. 0712345678"
                      placeholderTextColor="rgba(255,255,255,0.3)"
                      value={depositPhone}
                      onChangeText={setDepositPhone}
                      keyboardType="phone-pad"
                    />

                    {/* Error */}
                    {depositError !== '' && (
                      <Text style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{depositError}</Text>
                    )}

                    {/* Fair Play & Community Guidelines */}
                    <View style={{ backgroundColor: 'rgba(255,193,7,0.08)', borderRadius: 12, padding: 14, marginTop: 16, borderWidth: 1, borderColor: 'rgba(255,193,7,0.25)' }}>
                      <Text style={{ color: '#f1c40f', fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>âš–ï¸ Fair Play & Community Guidelines</Text>
                      <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, lineHeight: 18 }}>
                        CardFlow is a skill-based entertainment game. Virtual game coins are used for match entry pools
                        and leaderboard ranking only. Game coins have no real-world monetary value. Deposits are
                        processed to purchase game coins. Coins cannot be forfeited by abandoning an ongoing match.
                        By depositing you confirm you are 18+ and agree to CardFlow's{' '}
                        <Text style={{ color: '#f1c40f', textDecorationLine: 'underline' }}>Terms & Conditions</Text>.
                      </Text>
                      <TouchableOpacity
                        style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}
                        onPress={() => setDepositTermsAgreed(v => !v)}
                        activeOpacity={0.7}
                      >
                        <View style={{
                          width: 22, height: 22, borderRadius: 6, borderWidth: 2,
                          borderColor: depositTermsAgreed ? '#4ade80' : 'rgba(255,255,255,0.4)',
                          backgroundColor: depositTermsAgreed ? 'rgba(74,222,128,0.2)' : 'transparent',
                          alignItems: 'center', justifyContent: 'center', marginRight: 10,
                        }}>
                          {depositTermsAgreed && <Text style={{ color: '#4ade80', fontSize: 14, fontWeight: 'bold' }}>âœ“</Text>}
                        </View>
                        <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, flex: 1 }}>
                          I am 18+ and I agree to the Terms & Conditions and Community Guidelines.
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* Submit */}
                    <TouchableOpacity
                      style={[
                        styles.modalButton,
                        {
                          backgroundColor: depositTermsAgreed ? 'rgba(22,163,74,0.8)' : 'rgba(255,255,255,0.1)',
                          marginTop: 18,
                          opacity: depositStatus === 'loading' ? 0.7 : 1,
                        }
                      ]}
                      disabled={depositStatus === 'loading' || !depositTermsAgreed}
                      onPress={async () => {
                        setDepositError('');
                        const amt = parseFloat(depositAmount);
                        if (isNaN(amt) || amt < 35 || amt > 1500) {
                          setDepositError('Amount must be between KES 35 and KES 1500.');
                          return;
                        }
                        if (!depositPhone.trim()) {
                          setDepositError('Please enter your M-Pesa phone number.');
                          return;
                        }
                        if (!authUser?.id) {
                          setDepositError('You must be logged in to deposit.');
                          return;
                        }
                        setDepositStatus('loading');
                        try {
                          const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
                          const anonKey    = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
                          const { data: { session } } = await supabase.auth.getSession();
                          if (!session?.access_token) {
                            throw new Error('Session expired. Please sign in again.');
                          }
                          const res = await fetch(
                            `${supabaseUrl}/functions/v1/mpesa-pay`,
                            {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${session.access_token}`,
                                'apikey': anonKey,
                              },
                              body: JSON.stringify({
                                phone: depositPhone.trim(),
                                amount: amt,
                              }),
                            },
                          );
                          let data: { error?: string; message?: string; sandbox?: boolean; sandbox_test_phone_used?: boolean; stk_phone?: string; requested_phone?: string } = {};
                          let responseText = '';
                          try {
                            responseText = await res.text();
                            data = responseText ? JSON.parse(responseText) : {};
                          } catch {
                            throw new Error(`Payment service returned HTTP ${res.status}. Please try again.`);
                          }
                          if (!res.ok) {
                            const providerMessage = data?.error ?? data?.message ?? responseText;
                            throw new Error(providerMessage || `Failed to initiate STK push. HTTP ${res.status}`);
                          }
                          if (data?.sandbox && data?.sandbox_test_phone_used) {
                            setDepositSuccessMessage(
                              `Sandbox request accepted by Daraja using test number ${data.stk_phone}. No prompt will arrive on ${data.requested_phone ?? depositPhone.trim()}. Disable the sandbox test phone override to send the request to your entered phone.`
                            );
                          } else if (data?.sandbox) {
                            setDepositSuccessMessage(
                              'Sandbox STK request accepted by Daraja. Check the M-Pesa prompt on the phone number you entered and enter your PIN to complete the test.'
                            );
                          } else {
                            setDepositSuccessMessage(
                              'Check your phone for the M-Pesa prompt and enter your PIN to complete the deposit. Your balance will update automatically once payment is confirmed.'
                            );
                          }
                          setDepositStatus('sent');
                        } catch (e: any) {
                          setDepositStatus('error');
                          setDepositError(e.message ?? 'Could not initiate deposit. Try again.');
                        }
                      }}
                    >
                      {depositStatus === 'loading' ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.modalButtonText}>
                          Deposit KES {depositAmount || '0'} via M-Pesa
                        </Text>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity style={[styles.modalButton, styles.cancelButton, { marginTop: 8 }]}
                      onPress={() => { setShowDepositWebView(false); setDepositStatus('idle'); setDepositError(''); }}>
                      <Text style={styles.modalButtonText}>Cancel</Text>
                    </TouchableOpacity>
                  </ScrollView>
                )}
              </View>
            </View>
          )}

          {/* Join Modal */}
          {showJoinModal && (
            <View style={styles.modalOverlay}>
              <View style={styles.modalCard}>
                <Text style={styles.modalTitle}>Join Private Room</Text>
                <TextInput
                  style={styles.modalInput}
                  placeholder="6-letter code"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  value={roomCode}
                  onChangeText={setRoomCode}
                  autoCapitalize="characters"
                  maxLength={6}
                />
                <View style={styles.modalButtons}>
                  <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={() => setShowJoinModal(false)}>
                    <Text style={styles.modalButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.modalButton, styles.confirmButton]} onPress={handleJoinRoom}>
                    <Text style={styles.modalButtonText}>Join</Text>
                  </TouchableOpacity>
                </View>

                {/* Banner ad inside Join modal â€” non-intrusive, below action buttons */}
                {adsSupportedNative && BannerAd ? (
                  <View style={{ alignItems: 'center', marginTop: 30 }}>
                    <Text style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>ADVERTISEMENT</Text>
                    <BannerAd
                      unitId={AD_UNIT_IDS.banner}
                      size={BannerAdSize.MEDIUM_RECTANGLE ?? 'MEDIUM_RECTANGLE'}
                      requestOptions={{ requestNonPersonalizedAdsOnly: false }}
                      onAdFailedToLoad={(err: any) => console.warn('[Banner/Join] Load error:', err)}
                    />
                  </View>
                ) : null}
              </View>
            </View>
          )}

          {/* Rules Modal */}
          {showRulesModal && (
            <View style={styles.modalOverlay}>
              <View style={styles.modalCard}>
                <Text style={styles.modalTitle}>ðŸ“– CardFlow Rules</Text>
                <ScrollView style={styles.rulesScroll} contentContainerStyle={{ paddingBottom: 18 }} showsVerticalScrollIndicator>

                  <Text style={styles.rulesHeader}>Quick guide</Text>
                  <Text style={styles.rulesText}>When the turn banner shows your name, tap the card or cards you want to use, then tap Play. Selected cards have a purple outline. You normally match either the suit or the number/rank of the top discard. If you have no valid move, tap the Draw Pile.</Text>
                  <Text style={styles.rulesText}>Example: on a 7 of Hearts, you may play any Heart or any 7. You may play several cards together only when they share the same rank, such as two 7s. A 7 and a 9 cannot be played together.</Text>

                  <Text style={styles.rulesHeader}>ðŸŽ¯ Objective</Text>
                  <Text style={styles.rulesText}>Be the first player to empty your hand. The last card you play CANNOT be a Power Card â€” this is the Forbidden Finish rule.</Text>

                  <Text style={styles.rulesHeader}>ðŸƒ Setup</Text>
                  <Text style={styles.rulesText}>Each player is dealt 4 cards from a standard 52-card deck. One card is placed face-up to start the discard pile. The remaining cards form the draw pile.</Text>

                  <Text style={styles.rulesHeader}>ðŸ”„ Taking a Turn</Text>
                  <Text style={styles.rulesText}>On your turn, you must play a card that matches the SUIT or RANK of the top card. You can play MULTIPLE cards of the same rank (e.g., three 7s) together by selecting them all and pressing Play.</Text>
                  <Text style={styles.rulesText}>If you cannot play, tap the Draw Pile. If the drawn card matches, you can play it immediately. Otherwise, your turn ends.</Text>

                  <Text style={styles.rulesHeader}>âš”ï¸ Attack Cards (2 & 3)</Text>
                  <Text style={styles.rulesText}>Playing a 2 forces the next player to draw 2 cards. Playing a 3 forces them to draw 3 cards. The victim can defend by playing their own 2, 3, or Ace, passing the accumulated penalty to the next player!</Text>

                  <Text style={styles.rulesHeader}>ðŸ›¡ï¸ The Ace (Wild)</Text>
                  <Text style={styles.rulesText}>An Ace can be played on ANY card at ANY time, even to defend against an attack. When played, the player chooses the new active suit.</Text>

                  <Text style={styles.rulesHeader}>âš¡ Power Cards (8, J, Q, K)</Text>
                  <Text style={styles.rulesText}>â€¢ 8 & Queen: Grants you an immediate extra turn (Double-Tap).</Text>
                  <Text style={styles.rulesText}>â€¢ Jack: Skips the next player's turn entirely.</Text>
                  <Text style={styles.rulesText}>â€¢ King: Reverses the direction of play. (Acts as a Skip in 2-player games).</Text>

                  <Text style={styles.rulesHeader}>ðŸš« Forbidden Finish</Text>
                  <Text style={styles.rulesText}>You cannot win by playing a Power Card (Ace, 2, 3, 8, J, Q, K) as your final card. If you do, you must draw a penalty card and keep playing. Only standard cards (4, 5, 6, 7, 9, 10) can win the game.</Text>

                  <Text style={styles.rulesHeader}>Helpful tips</Text>
                  <Text style={styles.rulesText}>Keep a normal card (4, 5, 6, 7, 9, or 10) for your final move. An Ace is your best escape card: play it at any time and select a suit you hold. If a 2 or 3 attacks you, play a 2, 3, or Ace to pass on the running penalty; otherwise draw the full amount.</Text>
                  <Text style={styles.rulesText}>After a King, follow the direction banner. In a two-player match a King effectively skips your opponent. If the draw pile runs out, the game reshuffles played cards automatically and continues.</Text>
                </ScrollView>
                <TouchableOpacity style={[styles.modalButton, styles.confirmButton, { marginTop: 16 }]} onPress={() => setShowRulesModal(false)}>
                  <Text style={styles.modalButtonText}>Got it! Let's Play ðŸŽ®</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Challenge Modal */}
          {showChallengeModal && (
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, { maxHeight: '90%', width: '90%' }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <Text style={styles.modalTitle}>âš”ï¸ Challenge Players</Text>
                  <TouchableOpacity onPress={() => setShowChallengeModal(false)}>
                    <Ionicons name="close" size={28} color="#fff" />
                  </TouchableOpacity>
                </View>

                {/* Tab Switcher */}
                <View style={[styles.authTabs, { marginBottom: 16 }]}>
                  <TouchableOpacity 
                    style={[styles.authTab, challengeTab === 'search' && styles.authTabActive]} 
                    onPress={() => setChallengeTab('search')}
                  >
                    <Text style={[styles.authTabText, challengeTab === 'search' && styles.authTabTextActive]}>Search</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={[styles.authTab, challengeTab === 'incoming' && styles.authTabActive]} 
                    onPress={() => setChallengeTab('incoming')}
                  >
                    <Text style={[styles.authTabText, challengeTab === 'incoming' && styles.authTabTextActive]}>
                      Incoming ({incomingRequests.length})
                    </Text>
                  </TouchableOpacity>
                </View>

                {challengeTab === 'search' ? (
                  <View style={{ flex: 1, minHeight: 250 }}>
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                      <TextInput
                        style={[styles.input, { flex: 1, marginBottom: 0 }]}
                        placeholder="Enter username (e.g. janesmith)"
                        placeholderTextColor="rgba(255,255,255,0.4)"
                        value={searchUsername}
                        onChangeText={(text) => {
                          setSearchUsername(text);
                          if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                          if (text.trim()) {
                            searchDebounceRef.current = setTimeout(() => {
                              handleSearchPlayers(text);
                            }, 300);
                          } else {
                            setSearchResults([]);
                          }
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <TouchableOpacity 
                        style={[styles.confirmButton, { paddingHorizontal: 20, justifyContent: 'center', borderRadius: 12 }]} 
                        onPress={() => handleSearchPlayers()}
                        disabled={searchLoading}
                      >
                        {searchLoading ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Text style={{ color: '#fff', fontWeight: 'bold' }}>Search</Text>
                        )}
                      </TouchableOpacity>
                    </View>

                    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                      {searchResults.length === 0 ? (
                        <Text style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: 20, fontStyle: 'italic' }}>
                          Search by username to challenge online players.
                        </Text>
                      ) : (
                        searchResults.map(player => (
                          <View key={player.id} style={{ backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, padding: 8, marginBottom: 10, flexDirection: 'row', alignItems: 'center' }}>
                            <View style={{ flex: 1 }}>
                              <ProfileCard user={player} style={{ marginVertical: 0, borderWidth: 0, backgroundColor: 'transparent', padding: 4 }} />
                              <View style={{ position: 'absolute', top: 6, right: 2 }}>
                                {renderOnlineDot(player.id)}
                              </View>
                            </View>
                            <TouchableOpacity 
                              style={{ backgroundColor: 'rgba(156, 39, 176, 0.3)', borderColor: 'rgba(156, 39, 176, 0.6)', borderWidth: 1, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8 }}
                              onPress={() => handleSendChallenge(player)}
                            >
                              <Text style={{ color: '#e040fb', fontWeight: 'bold', fontSize: 14 }}>Challenge</Text>
                            </TouchableOpacity>
                          </View>
                        ))
                      )}
                    </ScrollView>
                  </View>
                ) : (
                  <ScrollView style={{ flex: 1, minHeight: 250 }} showsVerticalScrollIndicator={false}>
                    {incomingRequests.length === 0 ? (
                      <Text style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: 40, fontStyle: 'italic' }}>
                        No pending incoming challenges.
                      </Text>
                    ) : (
                      incomingRequests.map(req => (
                        <View key={req.id} style={{ backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, padding: 14, marginBottom: 12 }}>
                          <Text style={{ color: '#fff', fontSize: 15, fontWeight: 'bold', marginBottom: 12 }}>
                            âš”ï¸ {req.sender_name} has challenged you!
                          </Text>
                          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
                            <TouchableOpacity 
                              style={{ backgroundColor: 'rgba(244, 67, 54, 0.2)', borderColor: 'rgba(244, 67, 54, 0.4)', borderWidth: 1, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8 }}
                              onPress={() => handleDeclineChallenge(req)}
                            >
                              <Text style={{ color: '#ff5252', fontWeight: 'bold' }}>Decline</Text>
                            </TouchableOpacity>
                            <TouchableOpacity 
                              style={{ backgroundColor: 'rgba(76, 175, 80, 0.2)', borderColor: 'rgba(76, 175, 80, 0.4)', borderWidth: 1, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8 }}
                              onPress={() => handleAcceptChallenge(req)}
                            >
                              <Text style={{ color: '#69f0ae', fontWeight: 'bold' }}>Accept</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      ))
                    )}
                  </ScrollView>
                )}

                <TouchableOpacity 
                  style={[styles.modalButton, styles.cancelButton, { marginTop: 16 }]} 
                  onPress={() => setShowChallengeModal(false)}
                >
                  <Text style={styles.modalButtonText}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Staking removed â€” users play freely */}

          {/* Bot Count Modal */}
          <BotCountModal visible={showBotCountModal} onSelect={startBotGame} onClose={() => setShowBotCountModal(false)} />

        </KeyboardAvoidingView>
      </ScrollView>

      {/* SUSPENDED / APPEAL MODAL */}
      {showSuspendedModal && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={[styles.modalTitle, { color: '#ef4444' }]}>âš ï¸ Account Suspended</Text>
            {appealStatus === 'success' ? (
              <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                <Text style={{ fontSize: 40, marginBottom: 12 }}>âœ‰ï¸</Text>
                <Text style={{ color: '#4ade80', fontSize: 16, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' }}>Appeal Submitted!</Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
                  Your appeal has been received. The admin will review it and restore your account if approved.
                </Text>
                <TouchableOpacity
                  style={[styles.modalButton, styles.cancelButton, { marginTop: 20, width: '100%' }]}
                  onPress={() => {
                    setShowSuspendedModal(false);
                    setAppealStatus('idle');
                  }}
                >
                  <Text style={styles.modalButtonText}>Close</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={[styles.rulesText, { color: 'rgba(255,255,255,0.75)', marginBottom: 16 }]}>
                  Your account has been suspended for violating platform rules. If you believe this is an error or wish to appeal, please write your reason below.
                </Text>

                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 6 }}>Email Address</Text>
                <TextInput
                  style={[styles.input, { marginBottom: 14, backgroundColor: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)' }]}
                  value={authEmail}
                  editable={false}
                />

                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 6 }}>Reason for Appeal</Text>
                <TextInput
                  style={[styles.input, { minHeight: 100, textAlignVertical: 'top', marginBottom: 16 }]}
                  placeholder="Explain why your account should be reactivated..."
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  value={appealReason}
                  onChangeText={setAppealReason}
                  multiline={true}
                />

                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={[styles.modalButton, styles.cancelButton]}
                    onPress={() => {
                      setShowSuspendedModal(false);
                      setAppealReason('');
                    }}
                  >
                    <Text style={styles.modalButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalButton, { backgroundColor: '#ef4444' }]}
                    disabled={appealStatus === 'loading'}
                    onPress={handleSubmitAppeal}
                  >
                    {appealStatus === 'loading' ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.modalButtonText}>Submit Appeal</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      )}

      <AlertModal visible={alertState.visible} title={alertState.title} message={alertState.message} type={alertState.type} onClose={hideAlert} />
      {loading && <View style={styles.loadingOverlay}><ActivityIndicator size="large" color="#8a2bbe" /><Text style={styles.loadingText}>Connecting...</Text></View>}
    </View>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// STYLES
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0c29' },
  bg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#1a1035' },

  scrollContent: { flexGrow: 1, padding: 20, paddingTop: 10, paddingBottom: 36 },
  keyboardView: { flexGrow: 1 },

  titleContainer: { alignItems: 'center', marginBottom: 36, marginTop: 40 },
  gameTitle: { fontSize: 50, fontWeight: 'bold', color: '#fff', textShadowColor: 'rgba(138,43,226,0.9)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 22, marginBottom: 8 },
  gameSubtitle: { fontSize: 15, color: 'rgba(255,255,255,0.6)', letterSpacing: 2 },

  glassCard: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 8, padding: 18, marginBottom: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', width: '100%', maxWidth: 460 },
  label: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginBottom: 8, fontWeight: '600', letterSpacing: 1 },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, padding: 15, fontSize: 16, color: '#fff', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },

  glassButton: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 8, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', minWidth: 0 },
  createButton: { backgroundColor: 'rgba(76,175,80,0.25)', borderColor: 'rgba(76,175,80,0.5)' },
  joinButton: { backgroundColor: 'rgba(33,150,243,0.25)', borderColor: 'rgba(33,150,243,0.5)' },
  randomButton: { backgroundColor: 'rgba(156,39,176,0.3)', borderColor: 'rgba(156,39,176,0.6)' },
  botButton: { backgroundColor: 'rgba(255,152,0,0.25)', borderColor: 'rgba(255,152,0,0.5)' },
  rulesButton: { backgroundColor: 'rgba(96,96,96,0.35)', borderColor: 'rgba(150,150,150,0.4)' },
  buttonText: { fontSize: 17, fontWeight: 'bold', color: '#fff', marginBottom: 3, textAlign: 'center', flexShrink: 1 },
  buttonSubtext: { fontSize: 12, color: 'rgba(255,255,255,0.65)', textAlign: 'center', flexShrink: 1 },

  // Top Header Bar
  topHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, paddingTop: Platform.OS === 'ios' ? 50 : 30, backgroundColor: 'rgba(0,0,0,0.5)', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)', zIndex: 10 },
  balanceBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(241,196,15,0.15)', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: 'rgba(241,196,15,0.4)' },
  balanceIcon: { fontSize: 16, marginRight: 4 },
  balanceText: { color: '#f1c40f', fontWeight: 'bold', fontSize: 15, letterSpacing: 0.5 },
  headerSpacer: { width: 76 },

  // 2-column Game Grid
  gridContainer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 4 },
  gridButton: { width: '48%', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 16, marginBottom: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center', minHeight: 90, minWidth: 0 },
  gridSubtext: { fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 4, textAlign: 'center', flexShrink: 1 },

  // Password input row
  passwordInputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' },

  modalOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.88)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
  modalCard: { backgroundColor: 'rgba(20,18,50,0.98)', borderRadius: 24, padding: 28, width: '92%', maxWidth: 460, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', maxHeight: '90%' },
  // A fixed-height modal gives the nested ScrollView a real viewport on Android.
  // This prevents the main menu ScrollView from swallowing profile gestures.
  profileModalCard: { height: '90%', paddingBottom: 16, overflow: 'hidden' },
  profileScroll: { flex: 1 },
  profileScrollContent: { flexGrow: 1, paddingBottom: 24 },
  modalTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff', marginBottom: 18, textAlign: 'center' },
  modalInput: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12, padding: 15, fontSize: 22, color: '#fff', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', marginBottom: 18, textAlign: 'center', letterSpacing: 6 },
  modalButtons: { flexDirection: 'row', gap: 10 },
  modalButton: { flex: 1, padding: 14, borderRadius: 12, alignItems: 'center' },
  cancelButton: { backgroundColor: 'rgba(255,255,255,0.15)' },
  confirmButton: { backgroundColor: 'rgba(33,150,243,0.65)' },
  modalButtonText: { fontSize: 16, fontWeight: 'bold', color: '#fff' },

  alertCard: { backgroundColor: 'rgba(20,18,50,0.98)', borderRadius: 20, padding: 28, width: '85%', maxWidth: 380, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderTopWidth: 4, alignItems: 'center' },
  alertTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 12, textAlign: 'center' },
  alertMessage: { color: 'rgba(255,255,255,0.85)', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 20 },
  alertButton: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 40 },
  alertButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  rulesScroll: { maxHeight: 420 },
  rulesHeader: { color: '#a855f7', fontSize: 16, fontWeight: 'bold', marginTop: 16, marginBottom: 6 },
  rulesText: { color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 21, marginBottom: 4 },

  // Game Header
  gameHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 36, paddingBottom: 10, paddingHorizontal: 12 },
  iconButton: { padding: 10, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20, minWidth: 44, alignItems: 'center' },
  iconButtonText: { fontSize: 20, color: '#fff', fontWeight: 'bold' },
  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff', letterSpacing: 1 },

  opponentsArea: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', marginBottom: 16, gap: 10, paddingHorizontal: 10 },
  opponentCard: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 14, padding: 10, minWidth: 118, alignItems: 'center', borderWidth: 2, borderColor: 'transparent', overflow: 'visible' },
  activeOpponentBorder: { borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,0.15)' },
  opponentAvatarFrame: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(168,85,247,0.32)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center', marginBottom: 7, overflow: 'visible' },
  opponentAvatarText: { color: '#fff', fontWeight: '900', fontSize: 22 },
  turnDot: { color: '#a855f7', fontSize: 10, marginBottom: 2 },
  playerName: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  cardCountBadge: { backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 10, paddingVertical: 3, paddingHorizontal: 8, marginTop: 6 },
  cardCountText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },

  gameStatus: { alignItems: 'center', marginBottom: 18 },
  turnIndicator: { color: 'rgba(255,255,255,0.65)', fontSize: 15, fontWeight: 'bold', letterSpacing: 1 },
  myTurnIndicator: { color: '#4ade80', fontSize: 18 },
  directionBadge: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 4 },
  attackWarning: { backgroundColor: 'rgba(231,76,60,0.25)', borderRadius: 10, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: '#e74c3c', width: '100%', alignItems: 'center' },
  attackWarningText: { color: '#ff7675', fontSize: 13, fontWeight: 'bold' },
  reshuffleNotice: { backgroundColor: 'rgba(241,196,15,0.2)', borderRadius: 10, padding: 8, marginBottom: 8, borderWidth: 1, borderColor: '#f1c40f' },
  reshuffleText: { color: '#f9ca24', fontSize: 13, fontWeight: 'bold' },
  activeSuitNotice: { backgroundColor: 'rgba(52,152,219,0.2)', borderRadius: 10, padding: 8, marginBottom: 8, borderWidth: 1, borderColor: '#3498db' },
  activeSuitText: { color: '#74b9ff', fontSize: 13, fontWeight: 'bold', letterSpacing: 1 },

  playArea: { flexDirection: 'row', justifyContent: 'center', gap: 36, marginBottom: 28 },
  discardPile: { alignItems: 'center' },
  drawPile: { alignItems: 'center' },
  pileLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 8, fontWeight: 'bold', letterSpacing: 2 },
  drawCount: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 6, fontWeight: 'bold' },

  card: { width: 95, height: 135, borderRadius: 14, backgroundColor: '#f0f0f0', justifyContent: 'space-between', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.45, shadowRadius: 8, elevation: 8, paddingVertical: 8, paddingHorizontal: 6 },
  topCard: { borderWidth: 3, borderColor: '#a855f7' },
  faceDownCard: { backgroundColor: '#2d2470', borderWidth: 2, borderColor: 'rgba(168,85,247,0.4)', justifyContent: 'center', alignItems: 'center' },
  cardTopRank: { fontSize: 22, fontWeight: 'bold', alignSelf: 'flex-start' },
  cardTopSuit: { fontSize: 40, alignSelf: 'center' },
  cardBottomRank: { fontSize: 22, fontWeight: 'bold', alignSelf: 'flex-end', transform: [{ rotate: '180deg' }] },
  disabledDraw: { opacity: 0.55 },

  playerHandSection: { flex: 1, marginTop: 6 },
  myPlayerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingHorizontal: 10 },
  myPlayerName: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  handScrollContainer: { maxHeight: 380 },
  handGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, paddingBottom: 24 },
  handCard: { marginHorizontal: 4, marginVertical: 4 },
  disabledCard: { opacity: 0.65 },
  selectedCard: { transform: [{ translateY: -15 }], borderColor: '#a855f7', borderWidth: 3 },
  actionRow: { alignItems: 'center', paddingVertical: 10, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 16, marginTop: 10 },
  playCardsButton: { backgroundColor: '#a855f7', paddingVertical: 12, paddingHorizontal: 30, borderRadius: 20 },
  playCardsButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  
  // Floating play button styles
  floatingPlayButtonContainer: { position: 'absolute', top: 80, right: 20, zIndex: 1000, elevation: 10 },
  floatingPlayButton: { backgroundColor: '#a855f7', paddingVertical: 14, paddingHorizontal: 24, borderRadius: 30, borderWidth: 2, borderColor: '#c084fc', shadowColor: '#a855f7', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 8, elevation: 8 },
  floatingPlayButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold', letterSpacing: 1 },

  gameOverCard: { backgroundColor: 'rgba(18,15,45,0.98)', borderRadius: 26, padding: 34, width: '88%', maxWidth: 420, alignItems: 'center', borderWidth: 2, borderColor: '#a855f7' },
  gameOverTitle: { fontSize: 34, fontWeight: 'bold', color: '#fff', marginBottom: 14 },
  gameOverWinner: { fontSize: 20, color: '#4ade80', marginBottom: 28, textAlign: 'center', fontWeight: 'bold' },
  winnerCard: { width: '100%', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 18, padding: 16, marginBottom: 14 },
  winnerAvatar: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#a855f7', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  winnerAvatarText: { color: '#fff', fontSize: 28, fontWeight: '900' },
  winnerName: { color: '#fff', fontSize: 21, fontWeight: 'bold' },
  winnerLabel: { color: 'rgba(255,255,255,0.65)', marginTop: 3 },
  gameReward: { color: '#f1c40f', fontSize: 28, fontWeight: '900', marginBottom: 4 },
  playAgainButton: { backgroundColor: '#a855f7', borderRadius: 14, padding: 16, width: '100%', alignItems: 'center' },
  playAgainButtonText: { color: '#fff', fontSize: 17, fontWeight: 'bold' },

  suitPickerCard: { backgroundColor: 'rgba(18,15,45,0.98)', borderRadius: 24, padding: 28, width: '88%', maxWidth: 400, alignItems: 'center' },
  suitPickerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff', marginBottom: 22 },
  suitOptions: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', gap: 8 },
  suitOption: { flex: 1, aspectRatio: 0.9, borderRadius: 14, justifyContent: 'center', alignItems: 'center', borderWidth: 2 },
  suitOptionText: { fontSize: 28, color: '#fff' },
  hearts: { backgroundColor: 'rgba(231,76,60,0.3)', borderColor: '#e74c3c' },
  diamonds: { backgroundColor: 'rgba(231,76,60,0.3)', borderColor: '#e74c3c' },
  clubs: { backgroundColor: 'rgba(30,30,60,0.5)', borderColor: '#74b9ff' },
  spades: { backgroundColor: 'rgba(30,30,60,0.5)', borderColor: '#74b9ff' },

  historyCard: { backgroundColor: 'rgba(18,15,45,0.98)', borderRadius: 24, padding: 22, width: '90%', maxWidth: 420, maxHeight: '82%' },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  closeIcon: { fontSize: 22, color: 'rgba(255,255,255,0.7)', fontWeight: 'bold', paddingHorizontal: 8 },
  historyList: { paddingRight: 8, marginTop: 8 },
  historyRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 12 },
  historyIndex: { color: 'rgba(255,255,255,0.4)', fontSize: 14, width: 34, fontWeight: 'bold' },
  historyCardItem: { flex: 1, alignItems: 'center' },
  historyCardText: { fontSize: 17, fontWeight: 'bold', letterSpacing: 1 },
  historyPlayer: { color: '#fff', fontSize: 14, fontWeight: 'bold', textTransform: 'capitalize' },
  historyCards: { color: 'rgba(255,255,255,0.72)', fontSize: 13, marginTop: 3 },

  lobbyScroll: { flex: 1 },
  lobbyContent: { flexGrow: 1, alignItems: 'center', padding: 20, paddingTop: 48, paddingBottom: 48 },
  lobbyTitle: { fontSize: 24, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 10, flexShrink: 1 },
  lobbySubtext: { fontSize: 14, color: 'rgba(255,255,255,0.65)', textAlign: 'center', marginBottom: 16, flexShrink: 1 },
  roomCodeContainer: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 8, paddingVertical: 14, paddingHorizontal: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', alignItems: 'center', marginBottom: 10, width: '100%' },
  roomCodeText: { fontSize: 30, fontWeight: 'bold', color: '#fff', letterSpacing: 5, textShadowColor: 'rgba(168,85,247,0.8)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 14, textAlign: 'center' },
  waitingText: { fontSize: 14, color: 'rgba(255,255,255,0.75)', textAlign: 'center', fontStyle: 'italic' },
  joinedPlayersCard: { width: '100%', backgroundColor: 'rgba(0,0,0,0.22)', borderRadius: 8, padding: 12, marginTop: 30, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  joinedPlayersTitle: { color: '#fff', fontSize: 14, fontWeight: 'bold', marginBottom: 10, textAlign: 'center' },
  joinedPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.07)', marginBottom: 8, minWidth: 0 },
  joinedPlayerIndex: { color: '#c084fc', fontSize: 13, fontWeight: 'bold', width: 18, textAlign: 'center' },
  joinedPlayerName: { color: '#fff', fontSize: 15, fontWeight: '600', flex: 1, minWidth: 0 },
  joinedPlayerTag: { color: '#4ade80', fontSize: 11, fontWeight: 'bold', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: 'rgba(74,222,128,0.14)', overflow: 'hidden' },
  poweredByText: { color: 'rgba(255,255,255,0.45)', fontSize: 12, fontWeight: '700', letterSpacing: 1, marginTop: 2, textAlign: 'center' },

  loadingOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', zIndex: 999 },
  loadingText: { color: '#fff', fontSize: 17, fontWeight: 'bold', marginTop: 30 },

  // Auth styles
  authContainer: { flex: 1, justifyContent: 'center', padding: 24, paddingTop: 60 },
  authLogoArea: { alignItems: 'center', marginBottom: 30 },
  authLogoCircle: { width: 90, height: 90, borderRadius: 45, backgroundColor: 'rgba(168,85,247,0.25)', borderWidth: 2, borderColor: '#a855f7', justifyContent: 'center', alignItems: 'center', marginBottom: 14 },
  authLogoText: { fontSize: 44 },
  authCard: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 24, padding: 26, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  authTabs: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 14, padding: 4, marginBottom: 24 },
  authTab: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  authTabActive: { backgroundColor: '#a855f7' },
  authTabText: { color: 'rgba(255,255,255,0.5)', fontSize: 15, fontWeight: '600' },
  authTabTextActive: { color: '#fff' },
  authFieldGroup: { marginBottom: 16 },
  authFieldLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  authInput: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 14, padding: 16, fontSize: 16, color: '#fff', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  authActionButton: { backgroundColor: '#a855f7', borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 8, shadowColor: '#a855f7', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 10, elevation: 8 },
  authActionButtonText: { color: '#fff', fontSize: 17, fontWeight: 'bold', letterSpacing: 0.5 },
  authNote: { color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center', marginTop: 16 },
  authNoteLink: { color: '#c084fc', fontWeight: 'bold' },

  // Avatar picker
  avatarDisplay: { alignItems: 'center', marginBottom: 16 },
  avatarBigCircle: { width: 90, height: 90, borderRadius: 45, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)' },
  avatarBigIcon: { fontSize: 38 },
  avatarBigLabel: { color: '#fff', fontSize: 11, fontWeight: 'bold', marginTop: 4 },
  avatarGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 8 },
  avatarGridItem: { width: 68, height: 68, borderRadius: 14, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'transparent' },
  avatarGridSelected: { borderColor: '#fff', borderWidth: 3, transform: [{ scale: 1.08 }] },
  avatarGridIcon: { fontSize: 26 },
  avatarGridLabel: { color: '#fff', fontSize: 9, fontWeight: 'bold', marginTop: 2 },

  // Profile stats
  profileStatsCard: { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  profileRankRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  profileRankIcon: { fontSize: 26, marginRight: 10 },
  profileRankText: { color: '#c084fc', fontSize: 20, fontWeight: 'bold', letterSpacing: 1 },
  profileStatRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  profileStatLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 14 },
  profileStatValue: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  eloBarBg: { height: 8, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 4, marginTop: 10, overflow: 'hidden' },
  eloBarFill: { height: 8, backgroundColor: '#a855f7', borderRadius: 4 },
  eloBarLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 11, textAlign: 'center', marginTop: 4 },

  // Error boundary styles
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a1a', padding: 20 },
  errorTitle: { fontSize: 24, fontWeight: 'bold', color: '#e74c3c', marginBottom: 10 },
  errorMessage: { fontSize: 16, color: 'rgba(255,255,255,0.8)', textAlign: 'center', marginBottom: 20 },
  errorButton: { backgroundColor: '#a855f7', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28 },
  errorButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});
