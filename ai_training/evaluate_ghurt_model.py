"""
Evaluate an exported GHURT coach model in Colab.

Upload this file next to train_ghurt_selfplay.py, then run it against
ghurt_coach_model.json. It pits the model against random or simple heuristic
players and rotates the model seat to reduce first-player bias.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Dict, List

import torch

from train_ghurt_selfplay import (
    ACTION_DIM,
    STATE_DIM,
    STANDARD_RANKS,
    TURN_KEEPER_RANKS,
    Action,
    GhurtCoachNet,
    action_features,
    draw_card,
    initialize_game,
    legal_actions,
    play_cards,
    state_features,
)


def load_export(path: Path, device: str) -> GhurtCoachNet:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("state_dim") != STATE_DIM or payload.get("action_dim") != ACTION_DIM:
        raise ValueError("Model dimensions do not match evaluator")

    model = GhurtCoachNet().to(device)
    state_dict = {
        key: torch.tensor(value, dtype=torch.float32, device=device)
        for key, value in payload["state_dict"].items()
    }
    model.load_state_dict(state_dict)
    model.eval()
    return model


def rank_of_action(action: Action) -> str | None:
    if action.kind == "DRAW" or not action.cards:
        return None
    from train_ghurt_selfplay import RANKS
    return RANKS[action.cards[-1] // 4]


def model_action(model: GhurtCoachNet, state, actions: List[Action], device: str) -> Action:
    observer = state.current
    s = state_features(state, observer).to(device)
    a = torch.stack([action_features(x) for x in actions]).to(device)
    with torch.no_grad():
        scores = model.score_actions(s.repeat(len(actions), 1), a)
    return actions[int(torch.argmax(scores).item())]


def heuristic_action(actions: List[Action]) -> Action:
    plays = [a for a in actions if a.kind == "PLAY"]
    if not plays:
        return actions[0]

    # Prefer finishing/clearing standard-card answers, then multi-card dumps,
    # then turn keepers/attacks, then any play. This is intentionally simple.
    standard = [a for a in plays if rank_of_action(a) in STANDARD_RANKS]
    if standard:
        return max(standard, key=lambda a: len(a.cards))

    turn_keepers = [a for a in plays if rank_of_action(a) in TURN_KEEPER_RANKS]
    if turn_keepers:
        return max(turn_keepers, key=lambda a: len(a.cards))

    return max(plays, key=lambda a: len(a.cards))


def random_action(actions: List[Action]) -> Action:
    plays = [a for a in actions if a.kind == "PLAY"]
    if plays and random.random() < 0.82:
        return random.choice(plays)
    return random.choice(actions)


def apply_action(state, action: Action) -> None:
    if action.kind == "DRAW":
        draw_card(state)
    else:
        play_cards(state, action)


def run_game(model: GhurtCoachNet, player_count: int, model_seat: int, opponent: str, device: str, max_turns: int) -> int:
    state = initialize_game(player_count)

    for _ in range(max_turns):
        if state.winner is not None:
            return state.winner
        actions = legal_actions(state)
        if state.current == model_seat:
            action = model_action(model, state, actions, device)
        elif opponent == "heuristic":
            action = heuristic_action(actions)
        else:
            action = random_action(actions)
        apply_action(state, action)

    return min(range(player_count), key=lambda i: len(state.players[i].hand))


def evaluate(model: GhurtCoachNet, games: int, player_count: int, opponent: str, device: str, max_turns: int) -> Dict[str, float]:
    wins = 0
    seat_wins = {seat: 0 for seat in range(player_count)}
    seat_games = {seat: 0 for seat in range(player_count)}

    for i in range(games):
        seat = i % player_count
        winner = run_game(model, player_count, seat, opponent, device, max_turns)
        seat_games[seat] += 1
        if winner == seat:
            wins += 1
            seat_wins[seat] += 1

    result = {
        "games": float(games),
        "player_count": float(player_count),
        "baseline_random_chance": 1.0 / player_count,
        "model_win_rate": wins / games,
    }
    for seat in range(player_count):
        result[f"seat_{seat}_win_rate"] = seat_wins[seat] / max(seat_games[seat], 1)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="/content/drive/MyDrive/ghurt_ai/ghurt_coach_model.json")
    parser.add_argument("--games", type=int, default=2000)
    parser.add_argument("--opponent", choices=["random", "heuristic"], default="heuristic")
    parser.add_argument("--max-turns", type=int, default=240)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_export(Path(args.model), device)
    print(f"Device: {device}")
    print(f"Opponent: {args.opponent}")

    for player_count in (2, 3, 4):
        result = evaluate(model, args.games, player_count, args.opponent, device, args.max_turns)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
