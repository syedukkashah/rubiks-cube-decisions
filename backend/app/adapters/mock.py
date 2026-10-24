import asyncio
import json
from collections import deque

from app.adapters.base import MoveChoice
from app.engine import inverse


class MockAdapter:
    """Deterministic inverse-scramble script; only for exercising the pipeline.

    This deliberately knows the scramble and must never be used as model evidence.
    Create a new instance for every trial, including concurrently running trials.
    """

    def __init__(self, scramble_moves: list[str]):
        self.moves = deque(inverse(move) for move in reversed(scramble_moves))

    async def choose_move(self, state, recent_moves, allowed_moves, timeout_s):
        await asyncio.sleep(0)
        move = self.moves.popleft() if self.moves else allowed_moves[0]
        return MoveChoice(move, None, 1.0, json.dumps({"move": move}))
