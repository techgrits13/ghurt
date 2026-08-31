import {
  GameState,
  Card,
  Suit,
  playCards,
  drawCard,
  getPlayableGroups,
  getTopCard,
  shuffleDeck,
  isGameOver,
  Player
} from './gameLogic';

export interface MCTSAction {
  type: 'PLAY' | 'DRAW';
  cardIds?: string[];
  chosenSuit?: Suit;
}

export interface MCTSNode {
  action: MCTSAction | null;
  playerId: string;
  visits: number;
  wins: number;
  children: MCTSNode[];
  parent: MCTSNode | null;
  untriedActions: MCTSAction[];
}

const TACTICAL_HEURISTICS: Record<string, string> = {
  Rank_Ace: 'Clears the active attack modifier and resets pacing.',
  Rank_2: 'Forces the next player to draw cards, applying heavy pressure.',
  Rank_3: 'Forces the next player to draw cards, applying heavy pressure.',
  Rank_8: 'Grants you an extra turn to keep control of the board.',
  Rank_Queen: 'Grants you an extra turn to keep control of the board.',
  Rank_Jack: 'Skips the next player, reducing opponent opportunities.',
  Rank_King: 'Reverses the play direction, changing the turn order.',
  Group_Play: 'Dumps multiple cards at once to accelerate hand clearance.',
  Standard_Play: 'Clears standard cards efficiently.',
  Draw_Penalty: 'Draws mandatory penalty cards. No valid defense available.',
  Draw_Standard: 'Draws a card as the safest move when no valid plays exist.',
};

export class GhurtMCTSEngine {
  private observerId: string;

  constructor(observerId: string) {
    this.observerId = observerId;
  }

  /**
   * GUARD: Safely verify the state is valid before touching it.
   * Returns true if the state is structurally sound.
   */
  private isStateValid(state: GameState): boolean {
    return (
      !!state &&
      Array.isArray(state.players) &&
      state.players.length >= 2 &&
      state.currentPlayerIndex >= 0 &&
      state.currentPlayerIndex < state.players.length &&
      Array.isArray(state.discardPile) &&
      state.discardPile.length > 0
    );
  }

  /**
   * Main async entry. Call from your Expo UI or AI controller.
   * NEVER throws — returns null on any failure to prevent crashes.
   */
  public async getBestMoveWithInsights(
    gameState: GameState,
    totalIterations = 1000,
    batchSize = 100
  ): Promise<{
    playAction: MCTSAction;
    tipText: string;
    alternatives: Array<{ action: MCTSAction; confidence: number; tipText: string }>;
  } | null> {
    try {
      // ── GUARD 1: State must be valid ──
      if (!this.isStateValid(gameState)) return null;

      // ── GUARD 2: It must actually be the observer's turn ──
      const rootPlayer = gameState.players[gameState.currentPlayerIndex];
      if (!rootPlayer || rootPlayer.id !== this.observerId) return null;

      // ── GUARD 3: Game must not already be over ──
      if (isGameOver(gameState)) return null;

      const rootActions = this.getLegalActions(gameState, this.observerId);

      // ── GUARD 4: If there's only one action, return immediately (no search needed) ──
      if (rootActions.length === 0) return null;
      if (rootActions.length === 1) {
        const onlyAction = rootActions[0];
        return {
          playAction: onlyAction,
          tipText: `Only available move: ${this.generateTipText(onlyAction, gameState, rootPlayer).toLowerCase()}`,
          alternatives: [],
        };
      }

      const root: MCTSNode = {
        action: null,
        playerId: this.observerId,
        visits: 0,
        wins: 0,
        children: [],
        parent: null,
        untriedActions: rootActions,
      };

      // Async batch loop — yields JS thread every batch to avoid UI freezes
      let iterationsCompleted = 0;
      while (iterationsCompleted < totalIterations) {
        this.executeSearchBatch(root, gameState, batchSize);
        iterationsCompleted += batchSize;
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      if (root.children.length === 0) return null;

      const sortedChildren = [...root.children].sort((a, b) => b.visits - a.visits);
      const bestChild = sortedChildren[0];

      // ── GUARD 5: bestChild must have a valid action ──
      if (!bestChild.action) return null;

      const winPercentage =
        bestChild.visits > 0
          ? ((bestChild.wins / bestChild.visits) * 100).toFixed(1)
          : '0.0';

      const alternatives = sortedChildren.slice(1, 3).map(child => {
        const conf = child.visits > 0 ? (child.wins / child.visits) * 100 : 0;
        return {
          action: child.action!,
          confidence: Math.round(conf),
          tipText: this.generateTipText(child.action!, gameState, rootPlayer),
        };
      });

      const tacticalReason = this.generateTipText(bestChild.action, gameState, rootPlayer);

      return {
        playAction: bestChild.action,
        tipText: `Recommended play has a ${winPercentage}% victory confidence because it ${tacticalReason.toLowerCase()}`,
        alternatives,
      };
    } catch (err) {
      // ── GUARD 6: Never throw from the engine ──
      console.warn('[MCTS] getBestMoveWithInsights error (returning null):', err);
      return null;
    }
  }

  private executeSearchBatch(root: MCTSNode, state: GameState, iterations: number): void {
    for (let i = 0; i < iterations; i++) {
      try {
        let node = root;
        let currentState = this.determinizeState(state);

        // Selection
        while (node.untriedActions.length === 0 && node.children.length > 0) {
          const best = this.getBestChildUCB1(node, Math.SQRT2);
          if (!best) break; // ── GUARD: empty bestChildren ──
          node = best;
          if (node.action) {
            currentState = this.applyAction(currentState, node.action, node.playerId);
          }
        }

        // Expansion
        if (node.untriedActions.length > 0 && !isGameOver(currentState)) {
          const actionIndex = Math.floor(Math.random() * node.untriedActions.length);
          const action = node.untriedActions[actionIndex];
          node.untriedActions.splice(actionIndex, 1);

          // ── GUARD: currentPlayerIndex within bounds ──
          if (currentState.currentPlayerIndex >= currentState.players.length) continue;

          const nextPlayerId = currentState.players[currentState.currentPlayerIndex].id;
          currentState = this.applyAction(currentState, action, nextPlayerId);

          if (currentState.currentPlayerIndex >= currentState.players.length) continue;

          const newNextPlayerId = currentState.players[currentState.currentPlayerIndex].id;
          const newLegalActions = isGameOver(currentState)
            ? []
            : this.getLegalActions(currentState, newNextPlayerId);

          const childNode: MCTSNode = {
            parent: node,
            action,
            playerId: nextPlayerId,
            untriedActions: newLegalActions,
            children: [],
            visits: 0,
            wins: 0,
          };
          node.children.push(childNode);
          node = childNode;
        }

        // Simulation
        const winnerId = this.simulateRandomPlayout(currentState);

        // Backpropagation
        let current: MCTSNode | null = node;
        while (current !== null) {
          current.visits += 1;
          if (winnerId === this.observerId) {
            current.wins += 1;
          }
          current = current.parent;
        }
      } catch (_err) {
        // ── GUARD: Individual iteration failure is silently skipped ──
        continue;
      }
    }
  }

  private determinizeState(originalState: GameState): GameState {
    try {
      const allUnknownCards: Card[] = [];
      originalState.drawPile.forEach(c => allUnknownCards.push({ ...c }));
      originalState.players.forEach(p => {
        if (p.id !== this.observerId) {
          p.hand.forEach(c => allUnknownCards.push({ ...c }));
        }
      });

      const unknownCards = shuffleDeck(allUnknownCards);
      let unknownIndex = 0;

      const newPlayers = originalState.players.map(p => {
        if (p.id === this.observerId) {
          return { ...p, hand: p.hand.map(c => ({ ...c })) };
        } else {
          const handSize = p.hand.length;
          const newHand = unknownCards.slice(unknownIndex, unknownIndex + handSize);
          unknownIndex += handSize;
          return { ...p, hand: newHand };
        }
      });

      const newDrawPile = unknownCards.slice(unknownIndex);

      return {
        ...originalState,
        drawPile: newDrawPile,
        discardPile: originalState.discardPile.map(c => ({ ...c })),
        players: newPlayers,
        cardlessPlayerIds: [...originalState.cardlessPlayerIds],
      };
    } catch (_err) {
      // If determinization fails for any reason, return original state as a safe fallback
      return originalState;
    }
  }

  private getLegalActions(state: GameState, playerId: string): MCTSAction[] {
    try {
      const actions: MCTSAction[] = [];
      const player = state.players.find(p => p.id === playerId);
      if (!player) return [{ type: 'DRAW' }];

      if (player.isCardless) {
        return [{ type: 'DRAW' }];
      }

      const topCard = getTopCard(state);
      if (!topCard) return [{ type: 'DRAW' }];

      const playableGroups = getPlayableGroups(
        player.hand,
        topCard,
        state.penaltyCounter,
        state.activeSuit,
        state.attackRank
      );

      if (playableGroups.length === 0) {
        return [{ type: 'DRAW' }];
      }

      playableGroups.forEach(group => {
        if (group.rank === 'Ace') {
          const suits: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
          suits.forEach(suit => {
            actions.push({ type: 'PLAY', cardIds: group.cards.map(c => c.id), chosenSuit: suit });
          });
        } else {
          actions.push({ type: 'PLAY', cardIds: group.cards.map(c => c.id) });
        }
      });

      return actions.length > 0 ? actions : [{ type: 'DRAW' }];
    } catch (_err) {
      return [{ type: 'DRAW' }];
    }
  }

  private applyAction(state: GameState, action: MCTSAction, playerId: string): GameState {
    try {
      if (action.type === 'DRAW') {
        return drawCard(state, playerId);
      } else if (action.type === 'PLAY' && action.cardIds && action.cardIds.length > 0) {
        return playCards(state, playerId, action.cardIds, action.chosenSuit);
      }
    } catch (_e) {
      // Invalid move in simulation — silently fallback to current state
    }
    return state;
  }

  private getBestChildUCB1(node: MCTSNode, explorationConstant: number): MCTSNode | null {
    if (node.children.length === 0) return null;

    let bestValue = -Infinity;
    let bestChildren: MCTSNode[] = [];

    for (const child of node.children) {
      // ── GUARD: Avoid division by zero ──
      if (child.visits === 0 || node.visits === 0) {
        bestChildren.push(child);
        continue;
      }
      const exploit = child.wins / child.visits;
      const explore = Math.sqrt(Math.log(node.visits) / child.visits);
      const ucb1 = exploit + explorationConstant * explore;

      if (ucb1 > bestValue) {
        bestValue = ucb1;
        bestChildren = [child];
      } else if (ucb1 === bestValue) {
        bestChildren.push(child);
      }
    }

    if (bestChildren.length === 0) return node.children[0];
    return bestChildren[Math.floor(Math.random() * bestChildren.length)];
  }

  private simulateRandomPlayout(state: GameState, maxDepth = 60): string | null {
    try {
      let currentState = state;
      let depth = 0;

      while (!isGameOver(currentState) && depth < maxDepth) {
        // ── GUARD: currentPlayerIndex within bounds ──
        if (currentState.currentPlayerIndex >= currentState.players.length) break;

        const currentPlayer = currentState.players[currentState.currentPlayerIndex];
        if (!currentPlayer) break;

        const actions = this.getLegalActions(currentState, currentPlayer.id);
        if (actions.length === 0) break;

        const randomAction = actions[Math.floor(Math.random() * actions.length)];
        const nextState = this.applyAction(currentState, randomAction, currentPlayer.id);

        // ── GUARD: Detect infinite loop (state didn't change) ──
        if (nextState === currentState) break;

        currentState = nextState;
        depth++;
      }

      if (currentState.status === 'finished' && currentState.winner) {
        return currentState.winner;
      }

      // Heuristic: player with fewest cards is leading
      let minCards = Infinity;
      let leaderId: string | null = null;
      for (const p of currentState.players) {
        if (p.hand.length < minCards) {
          minCards = p.hand.length;
          leaderId = p.id;
        }
      }
      return leaderId;
    } catch (_err) {
      return null;
    }
  }

  private generateTipText(action: MCTSAction, state: GameState, player: Player): string {
    try {
      if (action.type === 'DRAW') {
        return state.penaltyCounter > 0
          ? TACTICAL_HEURISTICS.Draw_Penalty
          : TACTICAL_HEURISTICS.Draw_Standard;
      }

      if (action.cardIds && action.cardIds.length > 0) {
        const firstCard = player.hand.find(c => c.id === action.cardIds![0]);
        if (!firstCard) return 'Plays an unknown valid combination.';

        if (action.cardIds.length > 1) return TACTICAL_HEURISTICS.Group_Play;

        const key = `Rank_${firstCard.rank}`;
        return TACTICAL_HEURISTICS[key] ?? TACTICAL_HEURISTICS.Standard_Play;
      }

      return 'Takes a generic tactical action.';
    } catch (_err) {
      return 'Makes a calculated move.';
    }
  }
}
