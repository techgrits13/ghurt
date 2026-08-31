import { initializeGame, isGameOver } from './gameLogic';
import { getBotDecision, executeBotDecision, getRandomBotProfile, BOT_PROFILES } from './botAI';
import { GhurtMCTSEngine } from './mctsAI';

async function runTest(matches: number) {
  console.log(`Starting ${matches} matches: Legacy Bot vs MCTS Bot...`);
  
  let mctsWins = 0;
  let legacyWins = 0;
  let draws = 0;

  // Let's use two bots
  const legacyProfile = BOT_PROFILES.find(b => b.personality === 'aggressive') || BOT_PROFILES[0];
  
  for (let i = 0; i < matches; i++) {
    let state = initializeGame([
      { id: 'bot_legacy', name: 'Legacy Aggressive' },
      { id: 'bot_mcts', name: 'MCTS Coach' }
    ]);
    
    const mctsEngine = new GhurtMCTSEngine('bot_mcts');
    let turnCount = 0;
    
    while (!isGameOver(state) && turnCount < 1000) {
      const currentPlayerId = state.players[state.currentPlayerIndex].id;
      
      if (currentPlayerId === 'bot_legacy') {
        const decision = getBotDecision(state, legacyProfile);
        state = executeBotDecision(state, decision, 'bot_legacy');
      } else {
        const insight = await mctsEngine.getBestMoveWithInsights(state, 500, 50);
        if (insight) {
          if (insight.playAction.type === 'PLAY') {
            state = executeBotDecision(state, { 
              action: 'play', 
              cards: state.players.find(p => p.id === 'bot_mcts')?.hand.filter(c => insight.playAction.cardIds?.includes(c.id)),
              chosenSuit: insight.playAction.chosenSuit
            }, 'bot_mcts');
          } else {
            state = executeBotDecision(state, { action: 'draw' }, 'bot_mcts');
          }
        } else {
          // Fallback to safe draw
          state = executeBotDecision(state, { action: 'draw' }, 'bot_mcts');
        }
      }
      turnCount++;
    }
    
    if (state.winner === 'bot_mcts') mctsWins++;
    else if (state.winner === 'bot_legacy') legacyWins++;
    else draws++;
    
    console.log(`Match ${i + 1} completed. MCTS: ${mctsWins}, Legacy: ${legacyWins}, Timeout/Draws: ${draws}`);
  }
  
  console.log('\n--- FINAL RESULTS ---');
  console.log(`MCTS Bot Win Rate: ${((mctsWins / matches) * 100).toFixed(1)}%`);
  console.log(`Legacy Bot Win Rate: ${((legacyWins / matches) * 100).toFixed(1)}%`);
}

runTest(10).catch(console.error);
