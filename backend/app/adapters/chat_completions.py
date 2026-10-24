import json
from time import perf_counter

from app.adapters.base import HTTPAdapter, MoveChoice, Usage
from app.adapters.prompts import CRITERIA, INSTRUCTIONS, MOVE_PATTERN, SHORT_ANSWER, state_payload
from app.config import PRICES


class ChatAdapter(HTTPAdapter):
    path = "/api/v1/chat/completions"

    def build_request(self, state, recent_moves, allowed_moves):
        payload = {
            "model": self.model_id,
            "messages": [
                {
                    "role": "system",
                    "content": INSTRUCTIONS
                    + "\n"
                    + SHORT_ANSWER
                    + "\n"
                    + json.dumps(
                        {move: CRITERIA[move] for move in allowed_moves}, separators=(",", ":")
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        state_payload(state, recent_moves), separators=(",", ":")
                    ),
                },
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "m",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "move": {"type": "string", "pattern": MOVE_PATTERN},
                        },
                        "required": ["move"],
                        "additionalProperties": False,
                    },
                },
            },
            "provider": {
                "require_parameters": True,
                "max_price": {
                    "prompt": PRICES[self.model_id][0],
                    "completion": PRICES[self.model_id][1],
                },
            },
            "max_tokens": self.settings.chat_max_tokens,
            "temperature": 0,
        }
        if self.settings.chat_reasoning_effort != "omit":
            payload["reasoning"] = {"effort": "low", "exclude": True}
        return payload

    async def choose_move(self, state, recent_moves, allowed_moves, timeout_s):
        body, raw, started = await self.request(
            self.build_request(state, recent_moves, allowed_moves),
            timeout_s,
        )
        move = None
        finish_reason = None
        try:
            finish_reason = body["choices"][0].get("finish_reason")
            content = json.loads(body["choices"][0]["message"]["content"])
            if finish_reason != "length" and isinstance(content, dict) and set(content) == {"move"}:
                candidate = content["move"]
                if isinstance(candidate, str) and candidate in allowed_moves:
                    move = candidate
        except (TypeError, KeyError, IndexError, ValueError, AttributeError):
            pass
        return MoveChoice(
            move,
            None,
            (perf_counter() - started) * 1000,
            raw,
            Usage.parse(body),
            finish_reason,
            body.get("provider") if isinstance(body, dict) else None,
        )
