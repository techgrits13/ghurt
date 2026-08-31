# GHURT AI Training

This folder starts the paid offline coach pipeline.

## What Exists Now

- `train_ghurt_selfplay.py`: standalone Python self-play trainer.
- `COLAB_START_HERE.md`: exact cells to paste in Google Colab.

The trainer simulates GHURT games, learns from self-play, checkpoints to Google Drive, and exports `ghurt_coach_model.json`.

## Why This Shape

GHURT does not have a neat fixed action list because a move can be a changing card sequence: `Q + answer`, `8 + 8 + answer`, `Q + King`, attack defenses, Ace suit choices, and so on.

So the model scores only legal actions for the current turn:

```text
score = model(current_state, legal_action)
```

The app can later generate legal actions using `gameLogic.ts`, score them with the exported model, and show the best move plus explanation.

## Training Plan

1. Run `50,000` games to prove Colab, checkpoints, and export work.
2. Resume to `500,000` games for the first test coach.
3. Resume to `3,000,000` games for the first monetizable coach candidate.
4. Add a TypeScript inference loader in the app.
5. Gate the coach button using wallet/RPC subscription checks.

## Reality Check

This is not magic after one run. The first export will be rough. The value is that it can train continuously for free/cheap, resume after disconnects, and improve with more self-play.
