// Card Game Logic for CardFlow
// Supports 2-4 players, multi-card plays, cardless state, rank-specific attack defense

export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'Jack' | 'Queen' | 'King' | 'Ace';

export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  isFaceUp: boolean;
}

export interface Player {
  id: string;
  name: string;
  hand: Card[];
  isSkipped: boolean;
  isCardless: boolean; // Has empty hand but hasn't drawn replacement yet
}

export type GameStatus = 'waiting' | 'playing' | 'finished';

export interface GameState {
  id: string;
  status: GameStatus;
  players: Player[];
  currentPlayerIndex: number;
  playDirection: 1 | -1;
  drawPile: Card[];
  discardPile: Card[];
  penaltyCounter: number;
  attackRank: '2' | '3' | null; // Which specific rank started the attack chain
  activeSuit?: Suit;
  winner?: string;
  turnStartTime: number;
  extraTurns: number; // Extra turns granted by 8/Queen multi-plays
  isReshuffling: boolean;
  cardlessPlayerIds: string[]; // Players who have 0 cards but haven't drawn yet (block win)
  moveHistory: { id: string; playerId: string; playerName: string; cards: Card[]; action: 'played' | 'drew'; createdAt: number }[];
  initialPlayerCount: number;
  turnsTaken: Record<string, number>;
}

// Power Cards: Ace, King, Queen, Jack, 8, 3, 2
const POWER_RANKS: Rank[] = ['Ace', 'King', 'Queen', 'Jack', '8', '3', '2'];
const ATTACK_RANKS: Rank[] = ['2', '3'];
const STANDARD_RANKS: Rank[] = ['4', '5', '6', '7', '9', '10'];
const TURN_KEEPER_RANKS: Rank[] = ['8', 'Queen'];

// ============================================================================
// CARD UTILITIES
// ============================================================================

export function createCard(suit: Suit, rank: Rank): Card {
  return {
    id: `${rank}-${suit}-${Math.random().toString(36).substr(2, 9)}`,
    suit,
    rank,
    isFaceUp: false,
  };
}

export function createDeck(): Card[] {
  const suits: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
  const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
  const deck: Card[] = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(createCard(suit, rank));
    }
  }
  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function isPowerCard(card: Card): boolean {
  return POWER_RANKS.includes(card.rank);
}

export function isAttackCard(card: Card): boolean {
  return ATTACK_RANKS.includes(card.rank);
}

export function isStandardCard(card: Card): boolean {
  return STANDARD_RANKS.includes(card.rank);
}

export function canWinWithCard(card: Card): boolean {
  return isStandardCard(card);
}

function hasTurnKeeperAnswer(cards: Card[]): boolean {
  if (cards.length < 2) return false;
  const lastCard = cards[cards.length - 1];
  return !TURN_KEEPER_RANKS.includes(lastCard.rank) &&
    cards.slice(0, -1).some(card => TURN_KEEPER_RANKS.includes(card.rank));
}

export function getCardValue(card: Card): number {
  if (card.rank === 'Ace') return 14;
  if (card.rank === 'King') return 13;
  if (card.rank === 'Queen') return 12;
  if (card.rank === 'Jack') return 11;
  return parseInt(card.rank) || 10;
}

/**
 * Calculates new ELO ratings using standard formula (K-factor = 32).
 */
export function calculateElo(playerElo: number, opponentElo: number, playerWon: boolean): number {
  const K = 32;
  const expectedScore = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
  const actualScore = playerWon ? 1 : 0;
  return Math.max(0, Math.round(playerElo + K * (actualScore - expectedScore)));
}

// ============================================================================
// GAME VALIDATION
// ============================================================================

/**
 * Checks if a card can be played given the current game state.
 * Attack defense is now rank-specific:
 *   - 2-chain: can only defend with 2 or Ace
 *   - 3-chain: can only defend with 3 or Ace
 */
export function canPlayCard(
  card: Card,
  topCard: Card,
  penaltyCounter: number,
  activeSuit?: Suit,
  attackRank?: '2' | '3' | null
): boolean {
  if (penaltyCounter > 0) {
    // Under attack: rank-specific defense
    if (attackRank === '2') return card.rank === '2' || card.rank === 'Ace';
    if (attackRank === '3') return card.rank === '3' || card.rank === 'Ace';
    // Generic fallback
    return isAttackCard(card) || card.rank === 'Ace';
  }

  // Ace is always wild
  if (card.rank === 'Ace') return true;

  // Match by suit (active suit overrides top card's suit)
  const targetSuit = activeSuit || topCard.suit;
  if (card.suit === targetSuit) return true;

  // Match by rank
  if (card.rank === topCard.rank) return true;

  return false;
}

export function hasPlayableCard(
  hand: Card[],
  topCard: Card,
  penaltyCounter: number,
  activeSuit?: Suit,
  attackRank?: '2' | '3' | null
): boolean {
  return hand.some(c => canPlayCard(c, topCard, penaltyCounter, activeSuit, attackRank));
}

export function getPlayableGroups(
  hand: Card[],
  topCard: Card,
  penaltyCounter: number,
  activeSuit?: Suit,
  attackRank?: '2' | '3' | null
): { rank: Rank; cards: Card[] }[] {
  const validStarters = hand.filter(c => canPlayCard(c, topCard, penaltyCounter, activeSuit, attackRank));
  const chains: { rank: Rank; cards: Card[] }[] = [];

  for (const starter of validStarters) {
    let longestChain: Card[] = [];

    // DFS to find the longest chain starting with 'starter'
    const dfs = (currentChain: Card[], remainingHand: Card[]) => {
      if (currentChain.length > longestChain.length) {
        longestChain = [...currentChain];
      }

      const lastCard = currentChain[currentChain.length - 1];
      for (let i = 0; i < remainingHand.length; i++) {
        const nextCard = remainingHand[i];
        if (nextCard.rank === lastCard.rank || nextCard.suit === lastCard.suit) {
          const nextRemaining = [...remainingHand];
          nextRemaining.splice(i, 1);
          dfs([...currentChain, nextCard], nextRemaining);
        }
      }
    };

    const initialRemaining = hand.filter(c => c.id !== starter.id);
    dfs([starter], initialRemaining);
    
    chains.push({ rank: starter.rank, cards: longestChain });
  }

  // Deduplicate and sort
  const uniqueChains = Array.from(new Map(chains.map(c => [c.cards.map(x => x.id).join(','), c])).values());
  return uniqueChains.sort((a, b) => b.cards.length - a.cards.length);
}

// ============================================================================
// GAME INITIALIZATION
// ============================================================================

export function initializeGame(playersData: { id: string; name: string }[]): GameState {
  if (playersData.length < 2 || playersData.length > 4) {
    throw new Error('Game requires 2 to 4 players');
  }

  const deck = shuffleDeck(createDeck());

  const players: Player[] = playersData.map((p, index) => ({
    id: p.id,
    name: p.name,
    hand: deck.slice(index * 4, (index + 1) * 4),
    isSkipped: false,
    isCardless: false,
  }));

  const cardsDealt = players.length * 4;
  const drawPile = deck.slice(cardsDealt);

  // First discard card must not be a power card
  let discardPile: Card[] = [];
  let validStartCard: Card | null = null;
  while (drawPile.length > 0) {
    const card = { ...drawPile.pop()!, isFaceUp: true };
    if (!isPowerCard(card)) {
      validStartCard = card;
      break;
    }
    const mid = Math.floor(drawPile.length / 2);
    drawPile.splice(mid, 0, card);
  }

  if (!validStartCard) throw new Error('No valid start card found in deck');

  discardPile = [validStartCard];

  return {
    id: `game-${Math.random().toString(36).substr(2, 9)}`,
    status: 'playing',
    players,
    currentPlayerIndex: 0,
    playDirection: 1,
    drawPile,
    discardPile,
    penaltyCounter: 0,
    attackRank: null,
    activeSuit: undefined,
    turnStartTime: Date.now(),
    extraTurns: 0,
    isReshuffling: false,
    cardlessPlayerIds: [],
    moveHistory: [],
    initialPlayerCount: players.length,
    turnsTaken: Object.fromEntries(players.map(player => [player.id, 0])),
  };
}

// ============================================================================
// PILE RECYCLE
// ============================================================================

export function recycleDiscardPile(state: GameState): GameState {
  if (state.drawPile.length > 0) return state;

  const topCard = state.discardPile[state.discardPile.length - 1];
  const cardsToShuffle = state.discardPile.slice(0, -1).map(c => ({ ...c, isFaceUp: false }));
  const newDrawPile = shuffleDeck(cardsToShuffle);

  return {
    ...state,
    drawPile: newDrawPile,
    discardPile: [topCard],
    isReshuffling: true,
  };
}

// ============================================================================
// TURN ADVANCEMENT
// ============================================================================

/**
 * Advance the turn by `steps` positions in the current play direction.
 * If `consumeExtraTurn` is true and extraTurns > 0, the current player keeps their turn.
 * Jacks always pass `consumeExtraTurn = false` to skip regardless of extra turns.
 */
function advanceTurnBy(
  state: GameState,
  steps: number,
  consumeExtraTurn: boolean = true
): GameState {
  // Extra turns take priority (current player keeps going)
  if (consumeExtraTurn && state.extraTurns > 0) {
    return {
      ...state,
      extraTurns: state.extraTurns - 1,
      turnStartTime: Date.now(),
    };
  }

  const n = state.players.length;
  let nextIndex = state.currentPlayerIndex;
  for (let i = 0; i < steps; i++) {
    nextIndex = (nextIndex + state.playDirection + n) % n;
  }

  return {
    ...state,
    currentPlayerIndex: nextIndex,
    extraTurns: 0,
    turnStartTime: Date.now(),
    isReshuffling: false,
  };
}

// ============================================================================
// MULTI-CARD PLAY (MAIN ENTRY POINT)
// ============================================================================

/**
 * Play one or more cards of the SAME rank.
 * Multi-play rules:
 *   - All cards must share the same rank
 *   - The first card must be legally playable
 *   - Under attack: only matching attack rank OR Ace allowed
 *   - Playing last card(s):
 *     - Standard card, no cardless players → WIN
 *     - Power card, OR standard card with cardless players → go cardless
 *   - Any Ace lets the player choose the next active suit, including when
 *     defending against an attack.
 */
export function playCards(
  state: GameState,
  playerId: string,
  cardIds: string[],
  chosenSuit?: Suit
): GameState {
  if (cardIds.length === 0) throw new Error('No cards selected');

  const playerIndex = state.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) throw new Error('Player not found');
  if (playerIndex !== state.currentPlayerIndex) throw new Error('Not your turn');

  const player = state.players[playerIndex];
  if (player.isCardless) throw new Error('You are cardless — tap the draw pile to get a card first');

  // Validate all cards exist
  const cards = cardIds.map(id => {
    const c = player.hand.find(x => x.id === id);
    if (!c) throw new Error('Card not in hand');
    return c;
  });

  // A multi-play is a set of the same rank only. In particular, a player who
  // is under a 2/3 attack cannot slip in a suit-matching King or any other
  // card after a legal defense card.
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].rank !== cards[0].rank) {
      throw new Error('You can only play multiple cards of the same rank together');
    }
  }

  const topCard = state.discardPile[state.discardPile.length - 1];
  const wasUnderAttack = state.penaltyCounter > 0;
  const isAnsweredTurnKeeperSequence = hasTurnKeeperAnswer(cards);

  // Validate the first card is legally playable on the discard pile
  if (!canPlayCard(cards[0], topCard, state.penaltyCounter, state.activeSuit, state.attackRank)) {
    throw new Error('Cannot play this card right now');
  }

  // Under attack: validate defense rank matches
  if (wasUnderAttack && cards[0].rank !== 'Ace') {
    if (cards[0].rank !== state.attackRank) {
      throw new Error(`Under attack by ${state.attackRank}s — you can only defend with ${state.attackRank}s or an Ace`);
    }
  }
  if (wasUnderAttack && cards.some(card => card.rank !== cards[0].rank)) {
    throw new Error(`Under attack by ${state.attackRank}s — only ${state.attackRank}s or one Ace can be played`);
  }

  // Remove played cards from hand
  const cardIdSet = new Set(cardIds);
  const newHand = player.hand.filter(c => !cardIdSet.has(c.id));
  const newDiscardPile = [...state.discardPile, ...cards.map(c => ({ ...c, isFaceUp: true }))];
  const isNowEmpty = newHand.length === 0;

  let newState: GameState = {
    ...state,
    players: state.players.map((p, i) =>
      i === playerIndex ? { ...p, hand: newHand } : p
    ),
    discardPile: newDiscardPile,
    // Drawing ends the Ace's suit choice; the next turn follows the card's suit again.
    activeSuit: undefined,
    isReshuffling: false,
  };

  // ── Handle sequence card effects ──
  // When defending against an attack with a matching card (not Ace),
  // we RESET the counter, then add only the newly played card's penalty.
  // This ensures NO STACKING — the burden is simply PASSED, not added.
  let newPenaltyCounter = 0; // always reset — newly played attack card sets a fresh penalty
  let newAttackRank: '2' | '3' | null = null;
  let newExtraTurns = state.extraTurns;
  let skips = 0;
  let kingReverses = 0;
  let hasAttackCard = false;

  for (const card of cards) {
    if (card.rank === '2') {
      // Non-stacking: REPLACE penalty with 2 (not add)
      newPenaltyCounter = 2;
      newAttackRank = '2';
      hasAttackCard = true;
    } else if (card.rank === '3') {
      // Non-stacking: REPLACE penalty with 3 (not add)
      newPenaltyCounter = 3;
      newAttackRank = '3';
      hasAttackCard = true;
    } else if (TURN_KEEPER_RANKS.includes(card.rank)) {
      newExtraTurns += 1;
    } else if (card.rank === 'Jack') {
      skips += 1;
    } else if (card.rank === 'King') {
      kingReverses += 1;
    } else if (card.rank === 'Ace') {
      newPenaltyCounter = 0;
      newAttackRank = null;
    }
  }

  let newActiveSuit = undefined;
  if (cards[cards.length - 1].rank === 'Ace') {
    newActiveSuit = chosenSuit || cards[cards.length - 1].suit;
  }

  let newPlayDirection = state.playDirection;
  if (kingReverses % 2 === 1) {
    newPlayDirection = (newPlayDirection * -1) as 1 | -1;
  }

  if (isAnsweredTurnKeeperSequence) {
    newExtraTurns = 0;
  }

  newState = {
    ...newState,
    penaltyCounter: newPenaltyCounter,
    attackRank: newAttackRank,
    activeSuit: newActiveSuit,
    playDirection: newPlayDirection,
    extraTurns: newExtraTurns,
    moveHistory: [...(state.moveHistory || []), {
      id: `${Date.now()}-${playerId}`,
      playerId,
      playerName: player.name,
      cards: cards.map(card => ({ ...card, isFaceUp: true })),
      action: 'played',
      createdAt: Date.now(),
    }],
    turnsTaken: { ...(state.turnsTaken || {}), [playerId]: (state.turnsTaken?.[playerId] || 0) + 1 },
  };

  let steps = 1 + skips;
  if (newState.players.length === 2) {
    steps += kingReverses;
  }
  if (isAnsweredTurnKeeperSequence && cards[cards.length - 1].rank === 'King') {
    steps = 1 + skips;
  }

  let consumeExtraTurn = true;
  if (newPenaltyCounter > 0 && newPenaltyCounter > (wasUnderAttack && cards[0].rank !== 'Ace' ? state.penaltyCounter : 0)) {
    consumeExtraTurn = false;
  }
  if (skips > 0) consumeExtraTurn = false;
  if (newState.players.length === 2 && kingReverses > 0) consumeExtraTurn = false;
  if (isAnsweredTurnKeeperSequence) consumeExtraTurn = false;

  newState = advanceTurnBy(newState, steps, consumeExtraTurn);

  // ── Check win / cardless ──
  if (isNowEmpty) {
    const finishCard = isAnsweredTurnKeeperSequence ? cards[cards.length - 1] : cards[0];
    const isWinningPlay = canWinWithCard(finishCard);
    const hasOtherCardlessPlayers = newState.cardlessPlayerIds.length > 0;

    const everyoneHasPlayed = newState.players.every(player => (newState.turnsTaken?.[player.id] || 0) > 0);
    if (isWinningPlay && !hasOtherCardlessPlayers && everyoneHasPlayed) {
      // Clean win!
      newState = { ...newState, status: 'finished', winner: playerId };
    } else {
      // Go cardless (either played power card, OR standard card but blocked by cardless player)
      newState = {
        ...newState,
        cardlessPlayerIds: [...newState.cardlessPlayerIds, playerId],
        players: newState.players.map((p, i) =>
          i === playerIndex ? { ...p, isCardless: true } : p
        ),
      };
    }
  }

  // Recycle discard pile if draw is empty
  newState = recycleDiscardPile(newState);

  // ── Auto-resolve penalty for next player if they cannot defend ──
  // This automatically draws penalty cards for the next player if they
  // have no valid defense. Uses a guard to avoid infinite chain loops.
  if (newState.penaltyCounter > 0 && hasAttackCard) {
    const nextPlayer = newState.players[newState.currentPlayerIndex];
    if (nextPlayer && !nextPlayer.isCardless) {
      const defenseRank = newState.attackRank;
      const hasDefense = nextPlayer.hand.some(card => {
        if (defenseRank === '2') return card.rank === '2' || card.rank === 'Ace';
        if (defenseRank === '3') return card.rank === '3' || card.rank === 'Ace';
        return card.rank === '2' || card.rank === '3' || card.rank === 'Ace';
      });

      // Auto-penalize: draw cards and shift turn immediately
      if (!hasDefense) {
        newState = handlePenaltyDraw(newState, nextPlayer.id);
      }
    }
  }

  return newState;
}

/**
 * Backward-compatible single-card play.
 * Internally calls playCards.
 */
export function playCard(
  state: GameState,
  playerId: string,
  cardId: string,
  chosenSuit?: Suit
): GameState {
  return playCards(state, playerId, [cardId], chosenSuit);
}

// ============================================================================
// CARD EFFECT HANDLER
// ============================================================================

// applyMultiCardEffect removed as logic is now inline in playCards

// ============================================================================
// DRAW CARD
// ============================================================================

export function drawCard(state: GameState, playerId: string): GameState {
  const playerIndex = state.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) throw new Error('Player not found');
  if (playerIndex !== state.currentPlayerIndex) throw new Error('Not your turn');

  const player = state.players[playerIndex];

  // ── Cardless player: must draw to re-enter ──
  if (player.isCardless) {
    let newState = recycleDiscardPile(state);
    if (newState.drawPile.length === 0) throw new Error('No cards to draw');

    const drawnCard = { ...newState.drawPile[newState.drawPile.length - 1], isFaceUp: true };
    newState = {
      ...newState,
      drawPile: newState.drawPile.slice(0, -1),
      players: newState.players.map((p, i) =>
        i === playerIndex ? { ...p, hand: [drawnCard], isCardless: false } : p
      ),
      cardlessPlayerIds: newState.cardlessPlayerIds.filter(id => id !== playerId),
    };

    // Forfeit extra turns when drawing and ALWAYS advance
    if (newState.extraTurns > 0) newState = { ...newState, extraTurns: 0 };
    return advanceTurnBy(newState, 1, false);
  }

  // ── Under attack: must draw penalty (if no defense) ──
  if (state.penaltyCounter > 0) {
    return handlePenaltyDraw(state, playerId);
  }

  // ── Normal draw ──
  let newState = recycleDiscardPile(state);
  if (newState.drawPile.length === 0) throw new Error('No cards to draw');

  const drawnCard = { ...newState.drawPile[newState.drawPile.length - 1], isFaceUp: true };
  newState = {
    ...newState,
    drawPile: newState.drawPile.slice(0, -1),
    players: newState.players.map((p, i) =>
      i === playerIndex ? { ...p, hand: [...p.hand, drawnCard] } : p
    ),
    isReshuffling: false,
    moveHistory: [...(state.moveHistory || []), { id: `${Date.now()}-${playerId}`, playerId, playerName: player.name, cards: [drawnCard], action: 'drew', createdAt: Date.now() }],
    turnsTaken: { ...(state.turnsTaken || {}), [playerId]: (state.turnsTaken?.[playerId] || 0) + 1 },
  };

  // Forfeit extra turns when drawing and ALWAYS advance
  if (newState.extraTurns > 0) newState = { ...newState, extraTurns: 0 };
  return advanceTurnBy(newState, 1, false);
}

// ============================================================================
// PENALTY DRAW
// ============================================================================

export function handlePenaltyDraw(state: GameState, playerId: string): GameState {
  const playerIndex = state.players.findIndex(p => p.id === playerId);
  const player = state.players[playerIndex];
  const { attackRank } = state;

  // Check if player has a valid defense card
  const hasDefense = player.hand.some(card => {
    if (attackRank === '2') return card.rank === '2' || card.rank === 'Ace';
    if (attackRank === '3') return card.rank === '3' || card.rank === 'Ace';
    return isAttackCard(card) || card.rank === 'Ace';
  });

  if (false && hasDefense) {
    const defenseRank = attackRank || 'attack card';
    throw new Error(`You must defend! Play a ${defenseRank} or an Ace — you cannot draw while you have a defense card`);
  }

  let newState = recycleDiscardPile(state);
  const cardsToDraw = Math.min(newState.penaltyCounter, newState.drawPile.length);
  const end = newState.drawPile.length;
  const drawnCards = newState.drawPile.slice(end - cardsToDraw, end).map(c => ({ ...c, isFaceUp: true }));

  newState = {
    ...newState,
    drawPile: newState.drawPile.slice(0, end - cardsToDraw),
    players: newState.players.map((p, i) =>
      i === playerIndex ? { ...p, hand: [...p.hand, ...drawnCards] } : p
    ),
    penaltyCounter: 0,
    attackRank: null,
    isReshuffling: false,
    moveHistory: [...(state.moveHistory || []), { id: `${Date.now()}-${playerId}`, playerId, playerName: player.name, cards: drawnCards, action: 'drew', createdAt: Date.now() }],
    turnsTaken: { ...(state.turnsTaken || {}), [playerId]: (state.turnsTaken?.[playerId] || 0) + 1 },
  };

  return advanceTurnBy(newState, 1, false);
}

// ============================================================================
// AUTO TIMEOUT / BOT HELPER
// ============================================================================

export function handleTurnTimeout(state: GameState): GameState {
  const currentPlayer = state.players[state.currentPlayerIndex];

  // Cardless player → auto-draw
  if (currentPlayer.isCardless) {
    return drawCard(state, currentPlayer.id);
  }

  // Under attack → try to defend, else draw penalty
  if (state.penaltyCounter > 0) {
    const topCard = state.discardPile[state.discardPile.length - 1];
    const defenseable = currentPlayer.hand.filter(c =>
      canPlayCard(c, topCard, state.penaltyCounter, state.activeSuit, state.attackRank)
    );
    if (defenseable.length > 0) {
      return playCards(state, currentPlayer.id, [defenseable[0].id]);
    }
    return handlePenaltyDraw(state, currentPlayer.id);
  }

  // Try to auto-play best card
  const topCard = state.discardPile[state.discardPile.length - 1];
  const groups = getPlayableGroups(currentPlayer.hand, topCard, state.penaltyCounter, state.activeSuit, state.attackRank);

  if (groups.length > 0) {
    const best = groups[0];
    // Prefer standard cards to avoid going cardless at end
    const standardGroup = groups.find(g => isStandardCard(g.cards[0]));
    const playGroup = standardGroup || best;

    // Forbidden finish guard: if only 1 card left and it's a power card, still allow (cardless)
    return playCards(state, currentPlayer.id, playGroup.cards.map(c => c.id));
  }

  // Nothing playable — draw
  return drawCard(state, currentPlayer.id);
}

// ============================================================================
// GAME STATE QUERIES
// ============================================================================

export function getCurrentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex];
}

export function getNextPlayer(state: GameState): Player {
  const n = state.players.length;
  const nextIndex = (state.currentPlayerIndex + state.playDirection + n) % n;
  return state.players[nextIndex];
}

export function getTopCard(state: GameState): Card {
  return state.discardPile[state.discardPile.length - 1];
}

export function isGameOver(state: GameState): boolean {
  return state.status === 'finished';
}

// Removes a disconnected player without ending a multiplayer match. The next
// remaining player takes the turn when the leaver owned the current turn.
export function removePlayerFromGame(state: GameState, playerId: string): GameState {
  const leavingIndex = state.players.findIndex(player => player.id === playerId);
  if (leavingIndex < 0) return state;
  const players = state.players.filter(player => player.id !== playerId);
  if (players.length < 2) {
    const winner = players[0]?.id;
    return { ...state, players, status: 'finished', winner, currentPlayerIndex: 0 };
  }
  let currentPlayerIndex = state.currentPlayerIndex;
  if (leavingIndex < currentPlayerIndex) currentPlayerIndex -= 1;
  if (leavingIndex === currentPlayerIndex) currentPlayerIndex = currentPlayerIndex % players.length;
  const { [playerId]: _removedTurns, ...turnsTaken } = state.turnsTaken || {};
  return { ...state, players, currentPlayerIndex, cardlessPlayerIds: state.cardlessPlayerIds.filter(id => id !== playerId), turnsTaken };
}

export function getGameSummary(state: GameState): string {
  if (!isGameOver(state)) return 'Game in progress';
  const winner = state.players.find(p => p.id === state.winner);
  return `${winner?.name || 'Unknown'} wins!`;
}

export function getRemainingTime(state: GameState, turnDuration = 35000): number {
  return Math.max(0, turnDuration - (Date.now() - state.turnStartTime));
}

export function isTurnExpired(state: GameState, turnDuration = 35000): boolean {
  return getRemainingTime(state, turnDuration) <= 0;
}
