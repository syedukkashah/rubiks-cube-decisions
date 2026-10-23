import json
from time import perf_counter

from app.adapters.base import HTTPAdapter, MoveChoice
from app.adapters.prompts import CRITERIA, INSTRUCTIONS, state_payload


class ChatAdapter(HTTPAdapter):
    path = "/api/v1/chat/completions"

    async def choose_move(self, state, recent_moves, allowed_moves, timeout_s):
        body, raw, started = await self.request(
            {
                "model": self.model_id,
                "messages": [
                    {
                        "role": "system",
                        "content": INSTRUCTIONS
                        + '\nReturn exactly a JSON object with one string field "move".\n'
                        + json.dumps({move: CRITERIA[move] for move in allowed_moves}),
                    },
                    {"role": "user", "content": json.dumps(state_payload(state, recent_moves))},
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "next_move",
                        "strict": True,
                        "schema": {
                            "type": "object",
                            "properties": {
                                "move": {"type": "string", "enum": allowed_moves},
                            },
                            "required": ["move"],
                            "additionalProperties": False,
                        },
                    },
                },
                "provider": {"require_parameters": True},
                "stream": False,
            },
            timeout_s,
        )
        move = None
        try:
            content = json.loads(body["choices"][0]["message"]["content"])
            if isinstance(content, dict) and set(content) == {"move"}:
                move = content["move"] if isinstance(content["move"], str) else None
        except (TypeError, KeyError, IndexError, ValueError):
            pass
        return MoveChoice(move, None, (perf_counter() - started) * 1000, raw)
