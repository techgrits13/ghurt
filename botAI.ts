import { GameState, Card, Suit, canPlayCard, isAttackCard, isStandardCard, isPowerCard, playCards, drawCard, getTopCard, getPlayableGroups } from './gameLogic';

export type BotPersonality = 'aggressive' | 'defensive' | 'strategic' | 'random' | 'balanced' | 'cautious';

export interface BotProfile {
  name: string;
  personality: BotPersonality;
  reactionTime: number; // milliseconds
  attackThreshold: number; // 0-1, likelihood to play attack cards
  powerCardPreference: number; // 0-1, likelihood to save/use power cards
  suitPreference?: Suit; // preferred suit for strategic play
}

export type BotDifficulty = 'easy' | 'medium' | 'hard';

export const BOT_PROFILES: BotProfile[] = [
  // Easy difficulty bots
  { name: 'Alpha', personality: 'cautious', reactionTime: 1200, attackThreshold: 0.2, powerCardPreference: 0.3 },
  { name: 'Beta', personality: 'defensive', reactionTime: 1000, attackThreshold: 0.3, powerCardPreference: 0.4 },
  { name: 'Gamma', personality: 'random', reactionTime: 900, attackThreshold: 0.4, powerCardPreference: 0.45 },
  
  // Medium difficulty bots
  { name: 'Sigma', personality: 'balanced', reactionTime: 700, attackThreshold: 0.55, powerCardPreference: 0.6 },
  { name: 'Omega', personality: 'strategic', reactionTime: 650, attackThreshold: 0.65, powerCardPreference: 0.7, suitPreference: 'hearts' },
  { name: 'Titan', personality: 'aggressive', reactionTime: 600, attackThreshold: 0.7, powerCardPreference: 0.75 },

  // Hard difficulty bots (Ghurt King & Boss tier)
  { name: 'Apex', personality: 'strategic', reactionTime: 450, attackThreshold: 0.8, powerCardPreference: 0.85, suitPreference: 'spades' },
  { name: 'Zenith', personality: 'aggressive', reactionTime: 400, attackThreshold: 0.85, powerCardPreference: 0.9 },
  { name: 'Prime', personality: 'strategic', reactionTime: 350, attackThreshold: 0.9, powerCardPreference: 0.92, suitPreference: 'diamonds' },
  { name: 'Ghurt King', personality: 'aggressive', reactionTime: 300, attackThreshold: 0.95, powerCardPreference: 0.98, suitPreference: 'spades' },
];

export function getRandomBotProfile(difficulty?: BotDifficulty): BotProfile {
  let pool = BOT_PROFILES;
  if (difficulty === 'easy') {
    pool = BOT_PROFILES.filter(b => ['Alpha', 'Beta', 'Gamma'].includes(b.name));
  } else if (difficulty === 'medium') {
    pool = BOT_PROFILES.filter(b => ['Sigma', 'Omega', 'Titan'].includes(b.name));
  } else if (difficulty === 'hard') {
    pool = BOT_PROFILES.filter(b => ['Apex', 'Zenith', 'Prime', 'Ghurt King'].includes(b.name));
  }
  const randomIndex = Math.floor(Math.random() * pool.length);
  return pool[randomIndex] || BOT_PROFILES[0];
}

// Get N distinct random bot profiles (no name repeats)
export function getMultipleBotProfiles(count: number, difficulty?: BotDifficulty): BotProfile[] {
  let pool = BOT_PROFILES;
  if (difficulty === 'easy') {
    pool = BOT_PROFILES.filter(b => ['Alpha', 'Beta', 'Gamma'].includes(b.name));
  } else if (difficulty === 'medium') {
    pool = BOT_PROFILES.filter(b => ['Sigma', 'Omega', 'Titan'].includes(b.name));
  } else if (difficulty === 'hard') {
    pool = BOT_PROFILES.filter(b => ['Apex', 'Zenith', 'Prime', 'Ghurt King'].includes(b.name));
  }
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, pool.length));
}

export function getBotDecision(
  gameState: GameState,
  botProfile: BotProfile
): { action: 'play' | 'draw'; cards?: Card[]; chosenSuit?: Suit } {
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const topCard = getTopCard(gameState);
  
  // Get all playable groups (cards grouped by rank)
  const playableGroups = getPlayableGroups(
    currentPlayer.hand,
    topCard,
    gameState.penaltyCounter,
    gameState.activeSuit,
    gameState.attackRank
  );

  // If under attack, prioritize defense
  if (gameState.penaltyCounter > 0) {
    const attackGroups = playableGroups.filter(g => isAttackCard(g.cards[0]));
    const aceGroups = playableGroups.filter(g => g.rank === 'Ace');
    
    // Always play Ace to cancel attack if available
    if (aceGroups.length > 0) {
      // Aces usually best played one at a time to cancel attack, but can play multiple if we have them
      return {
        action: 'play',
        cards: aceGroups[0].cards,
        chosenSuit: botProfile.suitPreference,
      };
    }
    
    // Chain attack cards if available
    if (attackGroups.length > 0) {
      const attackGroup = attackGroups[Math.floor(Math.random() * attackGroups.length)];
      return { action: 'play', cards: attackGroup.cards };
    }
    
    // Must draw penalty cards
    return { action: 'draw' };
  }

  // No playable cards - must draw
  if (playableGroups.length === 0) {
    return { action: 'draw' };
  }

  // Decision making based on personality
  switch (botProfile.personality) {
    case 'aggressive':
      return aggressiveDecision(playableGroups, gameState, botProfile);
    case 'defensive':
      return defensiveDecision(playableGroups, gameState, botProfile);
    case 'strategic':
      return strategicDecision(playableGroups, gameState, botProfile);
    case 'random':
      return randomDecision(playableGroups, gameState, botProfile);
    case 'balanced':
      return balancedDecision(playableGroups, gameState, botProfile);
    case 'cautious':
      return cautiousDecision(playableGroups, gameState, botProfile);
    default:
      return balancedDecision(playableGroups, gameState, botProfile);
  }
}

function aggressiveDecision(
  playableGroups: { rank: string, cards: Card[] }[],
  gameState: GameState,
  botProfile: BotProfile
): { action: 'play'; cards: Card[]; chosenSuit?: Suit } {
  const attackGroups = playableGroups.filter(g => isAttackCard(g.cards[0]));
  if (attackGroups.length > 0 && Math.random() < botProfile.attackThreshold) {
    const group = attackGroups[Math.floor(Math.random() * attackGroups.length)];
    return { action: 'play', cards: group.cards };
  }

  const powerGroups = playableGroups.filter(g => isPowerCard(g.cards[0]));
  if (powerGroups.length > 0 && Math.random() < botProfile.powerCardPreference) {
    const group = powerGroups[Math.floor(Math.random() * powerGroups.length)];
    return {
      action: 'play',
      cards: group.cards,
      chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
    };
  }

  const group = playableGroups[Math.floor(Math.random() * playableGroups.length)];
  return {
    action: 'play',
    cards: group.cards,
    chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
  };
}

function defensiveDecision(
  playableGroups: { rank: string, cards: Card[] }[],
  gameState: GameState,
  botProfile: BotProfile
): { action: 'play'; cards: Card[]; chosenSuit?: Suit } {
  const nonAttackGroups = playableGroups.filter(g => !isAttackCard(g.cards[0]));
  if (nonAttackGroups.length > 0) {
    const group = nonAttackGroups[Math.floor(Math.random() * nonAttackGroups.length)];
    return {
      action: 'play',
      cards: group.cards,
      chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
    };
  }

  const standardGroups = playableGroups.filter(g => isStandardCard(g.cards[0]));
  if (standardGroups.length > 0) {
    const group = standardGroups[Math.floor(Math.random() * standardGroups.length)];
    return { action: 'play', cards: group.cards };
  }

  const group = playableGroups[Math.floor(Math.random() * playableGroups.length)];
  return {
    action: 'play',
    cards: group.cards,
    chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
  };
}

function strategicDecision(
  playableGroups: { rank: string, cards: Card[] }[],
  gameState: GameState,
  botProfile: BotProfile
): { action: 'play'; cards: Card[]; chosenSuit?: Suit } {
  const suitCounts: Record<Suit, number> = { hearts: 0, diamonds: 0, clubs: 0, spades: 0 };
  gameState.players[gameState.currentPlayerIndex].hand.forEach(card => {
    suitCounts[card.suit]++;
  });

  const mostCommonSuit = Object.entries(suitCounts).reduce((a, b) => a[1] > b[1] ? a : b)[0] as Suit;

  const suitGroups = playableGroups.filter(g => g.cards.some(c => c.suit === mostCommonSuit));
  if (suitGroups.length > 0) {
    const group = suitGroups[Math.floor(Math.random() * suitGroups.length)];
    return {
      action: 'play',
      cards: group.cards,
      chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? mostCommonSuit : undefined,
    };
  }

  if (botProfile.suitPreference) {
    const prefGroups = playableGroups.filter(g => g.cards.some(c => c.suit === botProfile.suitPreference));
    if (prefGroups.length > 0) {
      const group = prefGroups[Math.floor(Math.random() * prefGroups.length)];
      return {
        action: 'play',
        cards: group.cards,
        chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
      };
    }
  }

  const group = playableGroups[Math.floor(Math.random() * playableGroups.length)];
  return {
    action: 'play',
    cards: group.cards,
    chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
  };
}

function randomDecision(
  playableGroups: { rank: string, cards: Card[] }[],
  gameState: GameState,
  botProfile: BotProfile
): { action: 'play'; cards: Card[]; chosenSuit?: Suit } {
  const group = playableGroups[Math.floor(Math.random() * playableGroups.length)];
  return {
    action: 'play',
    cards: group.cards,
    chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
  };
}

function balancedDecision(
  playableGroups: { rank: string, cards: Card[] }[],
  gameState: GameState,
  botProfile: BotProfile
): { action: 'play'; cards: Card[]; chosenSuit?: Suit } {
  const rand = Math.random();
  if (rand < 0.3) {
    const attackGroups = playableGroups.filter(g => isAttackCard(g.cards[0]));
    if (attackGroups.length > 0) {
      const group = attackGroups[Math.floor(Math.random() * attackGroups.length)];
      return { action: 'play', cards: group.cards };
    }
  }
  
  if (rand < 0.6) {
    const standardGroups = playableGroups.filter(g => isStandardCard(g.cards[0]));
    if (standardGroups.length > 0) {
      const group = standardGroups[Math.floor(Math.random() * standardGroups.length)];
      return { action: 'play', cards: group.cards };
    }
  }
  
  const group = playableGroups[Math.floor(Math.random() * playableGroups.length)];
  return {
    action: 'play',
    cards: group.cards,
    chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
  };
}

function cautiousDecision(
  playableGroups: { rank: string, cards: Card[] }[],
  gameState: GameState,
  botProfile: BotProfile
): { action: 'play'; cards: Card[]; chosenSuit?: Suit } {
  const standardGroups = playableGroups.filter(g => isStandardCard(g.cards[0]));
  if (standardGroups.length > 0) {
    const group = standardGroups[Math.floor(Math.random() * standardGroups.length)];
    return { action: 'play', cards: group.cards };
  }

  const nonAttackPowerGroups = playableGroups.filter(g => isPowerCard(g.cards[0]) && !isAttackCard(g.cards[0]));
  if (nonAttackPowerGroups.length > 0) {
    const group = nonAttackPowerGroups[Math.floor(Math.random() * nonAttackPowerGroups.length)];
    return {
      action: 'play',
      cards: group.cards,
      chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
    };
  }

  const group = playableGroups[Math.floor(Math.random() * playableGroups.length)];
  return {
    action: 'play',
    cards: group.cards,
    chosenSuit: group.cards[group.cards.length - 1].rank === 'Ace' ? botProfile.suitPreference : undefined,
  };
}

export function executeBotDecision(
  gameState: GameState,
  decision: { action: 'play' | 'draw'; cards?: Card[]; chosenSuit?: Suit },
  playerId: string
): GameState {
  if (decision.action === 'draw') {
    return drawCard(gameState, playerId);
  }
  
  if (decision.cards && decision.cards.length > 0) {
    return playCards(gameState, playerId, decision.cards.map(c => c.id), decision.chosenSuit);
  }
  
  return drawCard(gameState, playerId);
}
