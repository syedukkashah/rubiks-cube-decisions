"""Scripted UI personas, never evidence about the real models."""

import asyncio
import hashlib

from app.adapters.base import MoveChoice
from app.engine import inverse
from app.schemas import MODEL_IDS
from app.solver import shortest_solution


def simulation_paths(puzzles):
    return {
        p.puzzle_id: (
            shortest_solution(p.facelets)
            if p.suite != "extension"
            else [inverse(move) for move in reversed(p.scramble_moves)]
        )
        for p in puzzles
    }


class SimulatedAdapter:
    def __init__(self, model_id, puzzle, solution, speed, sleep=asyncio.sleep):
        self.model = MODEL_IDS.index(model_id)
        self.variant = hashlib.sha256(puzzle.facelets.encode()).digest()[0]
        self.speed, self.sleep = speed, sleep
        # Fixed reversible detours give decision players visible optimality gaps.
        detours = ["U", "U'"] * (1 + self.variant % 2)
        fails = self.model == 2 or (self.model == 0 and self.variant % 3 == 0)
        self.moves = ["R", "U"] * 15 if fails else ([] if self.model == 3 else detours) + solution
        self.calls = self.index = 0

    async def choose_move(self, state, recent_moves, allowed_moves, timeout_s):
        self.calls += 1
        base = (180, 280, 90, 3500)[self.model]
        spread = (100, 100, 60, 4000)[self.model]
        latency = base + (self.variant + 37 * self.calls) % spread
        await self.sleep(latency / 1000 / self.speed)
        # One explicit, reproducible malformed attempt per Jev trial, followed by retry.
        if self.model == 0 and self.calls == 1:
            return MoveChoice(None, None, latency, "simulated malformed output")
        move = self.moves[self.index % len(self.moves)]
        self.index += 1
        confidence = None if self.model == 3 else 0.70 + (self.variant % 20) / 100
        return MoveChoice(move, confidence, latency, "")
