"""
Ghurt self-play reinforcement trainer for Google Colab.

This is intentionally standalone: paste/run it in Colab or upload the file,
then train from Google Drive checkpoints. It mirrors the important app rules:
- 2/3 attacks are non-stacking and can be answered by matching rank or Ace.
- A player may draw the attack penalty even when they have a defense.
- 8/Queen keep turn unless answered by a following non-8/non-Queen card.
- 8/Queen + standard answer can finish the game.
- 8/Queen + King reverses direction and sends turn back.

The model scores (state, action) pairs for only currently legal actions, so it
does not need a giant fixed action space. Exported JSON can be bundled in app.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import torch
from torch import nn
from torch.nn import functional as F


SUITS = ["hearts", "diamonds", "clubs", "spades"]
RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "Jack", "Queen", "King", "Ace"]
STANDARD_RANKS = {"4", "5", "6", "7", "9", "10"}
ATTACK_RANKS = {"2", "3"}
TURN_KEEPER_RANKS = {"8", "Queen"}
POWER_RANKS = {"Ace", "King", "Queen", "Jack", "8", "3", "2"}

RANK_TO_IDX = {rank: i for i, rank in enumerate(RANKS)}
SUIT_TO_IDX = {suit: i for i, suit in enumerate(SUITS)}

STATE_DIM = 148
ACTION_DIM = 64


@dataclass(frozen=True)
class Card:
    suit: str
    rank: str

    @property
    def code(self) -> int:
        return RANK_TO_IDX[self.rank] * 4 + SUIT_TO_IDX[self.suit]


@dataclass
class Player:
    hand: List[Card]
    is_cardless: bool = False


@dataclass
class GameState:
    players: List[Player]
    current: int
    direction: int
    draw_pile: List[Card]
    discard_pile: List[Card]
    penalty: int = 0
    attack_rank: Optional[str] = None
    active_suit: Optional[str] = None
    extra_turns: int = 0
    cardless: set[int] = field(default_factory=set)
    winner: Optional[int] = None


@dataclass(frozen=True)
class Action:
    kind: str  # PLAY or DRAW
    cards: Tuple[int, ...] = ()
    chosen_suit: Optional[str] = None


@dataclass
class Sample:
    state: torch.Tensor
    action: torch.Tensor
    reward: float


def create_deck() -> List[Card]:
    return [Card(suit, rank) for suit in SUITS for rank in RANKS]


def shuffle_deck(deck: List[Card]) -> List[Card]:
    deck = list(deck)
    random.shuffle(deck)
    return deck


def is_power(card: Card) -> bool:
    return card.rank in POWER_RANKS


def is_standard(card: Card) -> bool:
    return card.rank in STANDARD_RANKS


def can_play(card: Card, top: Card, penalty: int, active_suit: Optional[str], attack_rank: Optional[str]) -> bool:
    if penalty > 0:
        if attack_rank == "2":
            return card.rank in {"2", "Ace"}
        if attack_rank == "3":
            return card.rank in {"3", "Ace"}
        return card.rank in {"2", "3", "Ace"}

    if card.rank == "Ace":
        return True
    target_suit = active_suit or top.suit
    return card.suit == target_suit or card.rank == top.rank


def initialize_game(player_count: int) -> GameState:
    if player_count < 2 or player_count > 4:
        raise ValueError("Ghurt supports 2 to 4 players")

    deck = shuffle_deck(create_deck())
    players = [Player(hand=deck[i * 4:(i + 1) * 4]) for i in range(player_count)]
    draw_pile = deck[player_count * 4:]

    discard: List[Card] = []
    while draw_pile:
        card = draw_pile.pop()
        if not is_power(card):
            discard.append(card)
            break
        draw_pile.insert(len(draw_pile) // 2, card)

    if not discard:
        raise RuntimeError("No legal start card")

    return GameState(
        players=players,
        current=0,
        direction=1,
        draw_pile=draw_pile,
        discard_pile=discard,
    )


def recycle(state: GameState) -> None:
    if state.draw_pile or len(state.discard_pile) <= 1:
        return
    top = state.discard_pile[-1]
    rest = state.discard_pile[:-1]
    random.shuffle(rest)
    state.draw_pile = rest
    state.discard_pile = [top]


def advance_turn(state: GameState, steps: int, consume_extra: bool = True) -> None:
    if consume_extra and state.extra_turns > 0:
        state.extra_turns -= 1
        return
    n = len(state.players)
    for _ in range(steps):
        state.current = (state.current + state.direction + n) % n
    state.extra_turns = 0
    state.active_suit = None


def card_indices_for_hand(hand: Sequence[Card], card_codes: Sequence[int]) -> List[int]:
    used = set()
    indices = []
    for code in card_codes:
        found = None
        for i, card in enumerate(hand):
            if i not in used and card.code == code:
                found = i
                break
        if found is None:
            raise ValueError("Card not in hand")
        used.add(found)
        indices.append(found)
    return indices


def has_turn_keeper_answer(cards: Sequence[Card]) -> bool:
    if len(cards) < 2:
        return False
    return cards[-1].rank not in TURN_KEEPER_RANKS and any(c.rank in TURN_KEEPER_RANKS for c in cards[:-1])


def play_cards(state: GameState, action: Action) -> None:
    player = state.players[state.current]
    if action.kind != "PLAY" or not action.cards:
        raise ValueError("Invalid play action")
    if player.is_cardless:
        raise ValueError("Cardless player must draw")

    idxs = card_indices_for_hand(player.hand, action.cards)
    cards = [player.hand[i] for i in idxs]

    for a, b in zip(cards, cards[1:]):
        if a.rank != b.rank and a.suit != b.suit:
            raise ValueError("Sequence must match rank or suit")

    top = state.discard_pile[-1]
    was_under_attack = state.penalty > 0
    if not can_play(cards[0], top, state.penalty, state.active_suit, state.attack_rank):
        raise ValueError("First card is not legal")
    if was_under_attack and cards[0].rank != "Ace" and cards[0].rank != state.attack_rank:
        raise ValueError("Wrong attack defense")

    for i in sorted(idxs, reverse=True):
        del player.hand[i]
    state.discard_pile.extend(cards)

    answered_turn_keeper = has_turn_keeper_answer(cards)
    new_penalty = 0
    new_attack_rank = None
    new_extra = state.extra_turns
    skips = 0
    reverses = 0
    ace_defended = False
    has_attack = False

    for card in cards:
        if card.rank == "2":
            new_penalty = 2
            new_attack_rank = "2"
            has_attack = True
        elif card.rank == "3":
            new_penalty = 3
            new_attack_rank = "3"
            has_attack = True
        elif card.rank in TURN_KEEPER_RANKS:
            new_extra += 1
        elif card.rank == "Jack":
            skips += 1
        elif card.rank == "King":
            reverses += 1
        elif card.rank == "Ace":
            new_penalty = 0
            new_attack_rank = None
            if was_under_attack:
                ace_defended = True

    if answered_turn_keeper:
        new_extra = 0

    if reverses % 2 == 1:
        state.direction *= -1

    state.penalty = new_penalty
    state.attack_rank = new_attack_rank
    state.extra_turns = new_extra
    state.active_suit = action.chosen_suit if cards[-1].rank == "Ace" and not ace_defended else None

    steps = 1 + skips
    if len(state.players) == 2:
        steps += reverses
    if answered_turn_keeper and cards[-1].rank == "King":
        steps = 1 + skips

    consume_extra = True
    if has_attack:
        consume_extra = False
    if skips > 0 or (len(state.players) == 2 and reverses > 0) or answered_turn_keeper:
        consume_extra = False

    old_current = state.current
    advance_turn(state, steps, consume_extra)

    if not player.hand:
        finish_card = cards[-1] if answered_turn_keeper else cards[0]
        if is_standard(finish_card) and not state.cardless:
            state.winner = old_current
        else:
            player.is_cardless = True
            state.cardless.add(old_current)

    recycle(state)

    if state.winner is None and has_attack and state.penalty > 0:
        nxt = state.players[state.current]
        if not nxt.is_cardless:
            can_defend = any(can_play(c, state.discard_pile[-1], state.penalty, state.active_suit, state.attack_rank) for c in nxt.hand)
            if not can_defend:
                draw_card(state)


def draw_card(state: GameState) -> None:
    player = state.players[state.current]
    recycle(state)
    if not state.draw_pile:
        advance_turn(state, 1, False)
        return

    if player.is_cardless:
        player.hand.append(state.draw_pile.pop())
        player.is_cardless = False
        state.cardless.discard(state.current)
        state.extra_turns = 0
        advance_turn(state, 1, False)
        return

    draw_count = state.penalty if state.penalty > 0 else 1
    for _ in range(min(draw_count, len(state.draw_pile))):
        player.hand.append(state.draw_pile.pop())
    state.penalty = 0
    state.attack_rank = None
    state.extra_turns = 0
    advance_turn(state, 1, False)


def legal_sequences_from(hand: Sequence[Card], start_idx: int, max_len: int = 5) -> List[Tuple[int, ...]]:
    results: List[Tuple[int, ...]] = []

    def dfs(path: List[int], remaining: List[int]) -> None:
        results.append(tuple(hand[i].code for i in path))
        if len(path) >= max_len:
            return
        last = hand[path[-1]]
        for idx in remaining:
            card = hand[idx]
            if card.rank == last.rank or card.suit == last.suit:
                nxt_remaining = [x for x in remaining if x != idx]
                dfs(path + [idx], nxt_remaining)

    dfs([start_idx], [i for i in range(len(hand)) if i != start_idx])
    return results


def legal_actions(state: GameState) -> List[Action]:
    player = state.players[state.current]
    if player.is_cardless:
        return [Action("DRAW")]

    top = state.discard_pile[-1]
    actions = [Action("DRAW")]
    seen = set()
    for i, card in enumerate(player.hand):
        if not can_play(card, top, state.penalty, state.active_suit, state.attack_rank):
            continue
        for seq in legal_sequences_from(player.hand, i):
            last_code = seq[-1]
            last_rank = RANKS[last_code // 4]
            if last_rank == "Ace":
                for suit in SUITS:
                    key = ("PLAY", seq, suit)
                    if key not in seen:
                        seen.add(key)
                        actions.append(Action("PLAY", seq, suit))
            else:
                key = ("PLAY", seq, None)
                if key not in seen:
                    seen.add(key)
                    actions.append(Action("PLAY", seq, None))
    return actions


def clone_state(state: GameState) -> GameState:
    return GameState(
        players=[Player(list(p.hand), p.is_cardless) for p in state.players],
        current=state.current,
        direction=state.direction,
        draw_pile=list(state.draw_pile),
        discard_pile=list(state.discard_pile),
        penalty=state.penalty,
        attack_rank=state.attack_rank,
        active_suit=state.active_suit,
        extra_turns=state.extra_turns,
        cardless=set(state.cardless),
        winner=state.winner,
    )


def state_features(state: GameState, observer: int) -> torch.Tensor:
    vec = torch.zeros(STATE_DIM, dtype=torch.float32)
    player = state.players[observer]
    for card in player.hand:
        vec[card.code] += 1.0

    top = state.discard_pile[-1]
    vec[52 + top.code] = 1.0

    # Compact global features in the tail.
    tail = torch.zeros(44)
    tail[0] = len(state.draw_pile) / 52.0
    tail[1] = state.penalty / 3.0
    tail[2] = 1.0 if state.direction == 1 else 0.0
    tail[3] = state.extra_turns / 4.0
    tail[4] = 1.0 if state.current == observer else 0.0
    for i, p in enumerate(state.players):
        base = 5 + i * 3
        tail[base] = len(p.hand) / 20.0
        tail[base + 1] = 1.0 if p.is_cardless else 0.0
        tail[base + 2] = 1.0 if i == state.current else 0.0
    if state.active_suit:
        tail[20 + SUIT_TO_IDX[state.active_suit]] = 1.0
    if state.attack_rank:
        tail[24 + (0 if state.attack_rank == "2" else 1)] = 1.0

    vec[104:148] = tail
    return vec


def action_features(action: Action) -> torch.Tensor:
    vec = torch.zeros(ACTION_DIM, dtype=torch.float32)
    if action.kind == "DRAW":
        vec[0] = 1.0
        return vec
    vec[1] = 1.0
    vec[2] = len(action.cards) / 5.0
    for code in action.cards:
        vec[3 + code] += 1.0
    if action.chosen_suit:
        vec[56 + SUIT_TO_IDX[action.chosen_suit]] = 1.0
    last_rank = RANKS[action.cards[-1] // 4]
    vec[60] = 1.0 if last_rank in STANDARD_RANKS else 0.0
    vec[61] = 1.0 if last_rank in TURN_KEEPER_RANKS else 0.0
    vec[62] = 1.0 if last_rank in ATTACK_RANKS else 0.0
    vec[63] = 1.0 if last_rank == "King" else 0.0
    return vec


class GhurtCoachNet(nn.Module):
    def __init__(self, hidden: int = 192):
        super().__init__()
        self.state = nn.Sequential(nn.Linear(STATE_DIM, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU())
        self.action = nn.Sequential(nn.Linear(ACTION_DIM, hidden), nn.ReLU())
        self.policy = nn.Sequential(nn.Linear(hidden * 2, hidden), nn.ReLU(), nn.Linear(hidden, 1))
        self.value = nn.Sequential(nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, 1), nn.Tanh())

    def score_actions(self, state_batch: torch.Tensor, action_batch: torch.Tensor) -> torch.Tensor:
        s = self.state(state_batch)
        a = self.action(action_batch)
        return self.policy(torch.cat([s, a], dim=-1)).squeeze(-1)

    def value_for_state(self, state_batch: torch.Tensor) -> torch.Tensor:
        return self.value(self.state(state_batch)).squeeze(-1)


def choose_action(model: GhurtCoachNet, state: GameState, actions: List[Action], temperature: float, device: str) -> Tuple[Action, torch.Tensor, torch.Tensor]:
    obs = state.current
    s = state_features(state, obs).to(device)
    a = torch.stack([action_features(x) for x in actions]).to(device)
    with torch.no_grad():
        logits = model.score_actions(s.repeat(len(actions), 1), a)
    probs = torch.softmax(logits / max(temperature, 0.05), dim=0)
    idx = torch.multinomial(probs, 1).item()
    return actions[idx], s.cpu(), a[idx].cpu()


def random_action(actions: List[Action]) -> Action:
    plays = [a for a in actions if a.kind == "PLAY"]
    if plays and random.random() < 0.82:
        return random.choice(plays)
    return random.choice(actions)


def play_episode(model: GhurtCoachNet, player_count: int, temperature: float, device: str, max_turns: int = 240) -> List[Tuple[int, torch.Tensor, torch.Tensor]]:
    state = initialize_game(player_count)
    trajectory: List[Tuple[int, torch.Tensor, torch.Tensor]] = []

    for _ in range(max_turns):
        if state.winner is not None:
            break
        current = state.current
        actions = legal_actions(state)
        if random.random() < 0.15:
            action = random_action(actions)
            s = state_features(state, current)
            a = action_features(action)
        else:
            action, s, a = choose_action(model, state, actions, temperature, device)
        trajectory.append((current, s, a))
        if action.kind == "DRAW":
            draw_card(state)
        else:
            play_cards(state, action)

    if state.winner is None:
        state.winner = min(range(player_count), key=lambda i: len(state.players[i].hand))
    return trajectory + [(-state.winner - 1, torch.empty(0), torch.empty(0))]


def train_batch(model: GhurtCoachNet, optimizer: torch.optim.Optimizer, samples: List[Sample], device: str) -> Dict[str, float]:
    if not samples:
        return {"loss": 0.0}
    states = torch.stack([s.state for s in samples]).to(device)
    actions = torch.stack([s.action for s in samples]).to(device)
    rewards = torch.tensor([s.reward for s in samples], dtype=torch.float32, device=device)

    logits = model.score_actions(states, actions)
    values = model.value_for_state(states)
    policy_targets = (rewards + 1.0) / 2.0
    policy_loss = F.binary_cross_entropy_with_logits(logits, policy_targets)
    value_loss = F.mse_loss(values, rewards)
    entropy_guard = 0.001 * (logits ** 2).mean()
    loss = policy_loss + value_loss + entropy_guard

    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()

    return {
        "loss": float(loss.detach().cpu()),
        "policy_loss": float(policy_loss.detach().cpu()),
        "value_loss": float(value_loss.detach().cpu()),
    }


def export_json(model: GhurtCoachNet, path: Path, metadata: Dict[str, object]) -> None:
    payload = {
        "format": "ghurt_action_scorer_v1",
        "state_dim": STATE_DIM,
        "action_dim": ACTION_DIM,
        "ranks": RANKS,
        "suits": SUITS,
        "metadata": metadata,
        "state_dict": {k: v.detach().cpu().tolist() for k, v in model.state_dict().items()},
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def save_checkpoint(path: Path, model: GhurtCoachNet, optimizer: torch.optim.Optimizer, games: int, best_rate: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "model": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "games": games,
        "best_rate": best_rate,
        "time": time.time(),
    }, path)


def load_checkpoint(path: Path, model: GhurtCoachNet, optimizer: torch.optim.Optimizer, device: str) -> Tuple[int, float]:
    if not path.exists():
        return 0, 0.0
    data = torch.load(path, map_location=device)
    model.load_state_dict(data["model"])
    optimizer.load_state_dict(data["optimizer"])
    return int(data.get("games", 0)), float(data.get("best_rate", 0.0))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/content/drive/MyDrive/ghurt_ai")
    parser.add_argument("--target-games", type=int, default=1_000_000)
    parser.add_argument("--batch-games", type=int, default=128)
    parser.add_argument("--player-counts", default="2,3,4")
    parser.add_argument("--checkpoint-every", type=int, default=2000)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--hidden", type=int, default=192)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    out = Path(args.out)
    ckpt = out / "ghurt_coach_checkpoint.pt"
    export_path = out / "ghurt_coach_model.json"
    player_counts = [int(x.strip()) for x in args.player_counts.split(",") if x.strip()]

    model = GhurtCoachNet(args.hidden).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    games_done, best_rate = load_checkpoint(ckpt, model, optimizer, device)

    print(f"Device: {device}")
    print(f"Resuming at game {games_done:,}; target {args.target_games:,}")
    start = time.time()
    last_save = games_done

    while games_done < args.target_games:
        batch: List[Sample] = []
        wins = 0
        total_turns = 0
        temp = max(0.25, 1.25 - games_done / max(args.target_games, 1))

        for _ in range(args.batch_games):
            pc = random.choice(player_counts)
            episode = play_episode(model, pc, temp, device)
            winner_marker = episode[-1][0]
            winner = -winner_marker - 1
            wins += 1 if winner == 0 else 0
            total_turns += len(episode) - 1
            for player_id, s, a in episode[:-1]:
                reward = 1.0 if player_id == winner else -1.0
                batch.append(Sample(s, a, reward))

        metrics = train_batch(model, optimizer, batch, device)
        games_done += args.batch_games
        win_rate = wins / max(args.batch_games, 1)
        best_rate = max(best_rate, win_rate)

        if games_done % max(args.batch_games, 1) == 0:
            elapsed = max(time.time() - start, 1)
            print(
                f"games={games_done:,} loss={metrics['loss']:.4f} "
                f"p0_win={win_rate:.3f} avg_turns={total_turns / args.batch_games:.1f} "
                f"speed={(games_done / elapsed):.1f} games/sec"
            )

        if games_done - last_save >= args.checkpoint_every:
            save_checkpoint(ckpt, model, optimizer, games_done, best_rate)
            export_json(model, export_path, {
                "games": games_done,
                "best_batch_player0_win_rate": best_rate,
                "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            })
            print(f"Saved checkpoint and export to {out}")
            last_save = games_done

    save_checkpoint(ckpt, model, optimizer, games_done, best_rate)
    export_json(model, export_path, {
        "games": games_done,
        "best_batch_player0_win_rate": best_rate,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    print(f"Done. Exported {export_path}")


if __name__ == "__main__":
    main()
