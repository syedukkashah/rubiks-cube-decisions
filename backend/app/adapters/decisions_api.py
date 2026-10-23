from time import perf_counter

from app.adapters.base import HTTPAdapter, MoveChoice, confidence_of
from app.adapters.prompts import CRITERIA, INSTRUCTIONS, state_payload


class DecisionsAdapter(HTTPAdapter):
    path = "/api/alpha/decisions"

    async def choose_move(self, state, recent_moves, allowed_moves, timeout_s):
        body, raw, started = await self.request(
            {
                "model": self.model_id,
                "state": state_payload(state, recent_moves),
                "questions": {
                    "next_move": {
                        "type": "choice",
                        "instructions": INSTRUCTIONS,
                        "criteria": {move: CRITERIA[move] for move in allowed_moves},
                    }
                },
            },
            timeout_s,
        )
        answer = None
        if isinstance(body, dict) and isinstance(body.get("answers"), dict):
            answer = body["answers"].get("next_move")
        move, confidence = None, None
        if isinstance(answer, dict) and answer.get("type") == "choice":
            move = answer.get("choice")
            move = move if isinstance(move, str) else None
            confidence = confidence_of(answer, move)
        return MoveChoice(move, confidence, (perf_counter() - started) * 1000, raw)
