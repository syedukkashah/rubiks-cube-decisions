import json
import math
import re
from dataclasses import dataclass
from time import perf_counter
from typing import Protocol

import httpx


def scrub(text: str, api_key: str = "") -> str:
    if api_key:
        text = text.replace(api_key, "[REDACTED]")
    text = re.sub(r"(?i)bearer\s+[^\s\"',}]+", "Bearer [REDACTED]", text)
    return re.sub(r"sk-or-[A-Za-z0-9_-]+", "[REDACTED]", text)


@dataclass(frozen=True)
class MoveChoice:
    move: str | None
    confidence: float | None
    latency_ms: float
    raw_response: str


class Adapter(Protocol):
    async def choose_move(
        self, state: str, recent_moves: list[str], allowed_moves: list[str], timeout_s: float
    ) -> MoveChoice: ...


class UpstreamFailure(Exception):
    def __init__(self, code: str = "upstream_error"):
        self.code = code
        super().__init__(
            "OpenRouter request timed out"
            if code == "upstream_timeout"
            else "OpenRouter request failed"
        )


def confidence_of(answer: dict, move: str | None) -> float | None:
    value = answer.get("confidence")
    if value is None and isinstance(answer.get("probabilities"), dict):
        value = answer["probabilities"].get(move)
    if type(value) not in (float, int) or not math.isfinite(value) or not 0 <= value <= 1:
        return None
    return float(value)


class HTTPAdapter:
    path: str

    def __init__(self, model_id: str, client: httpx.AsyncClient, api_key: str):
        self.model_id = model_id
        self.client = client
        self._api_key = api_key

    async def request(self, payload: dict, timeout_s: float):
        started = perf_counter()
        try:
            response = await self.client.post(
                "https://openrouter.ai" + self.path,
                json=payload,
                headers={"Authorization": "Bearer " + self._api_key},
                timeout=timeout_s,
            )
            response.raise_for_status()
        except httpx.TimeoutException:
            raise UpstreamFailure("upstream_timeout") from None
        except httpx.HTTPError:
            raise UpstreamFailure() from None
        raw = scrub(response.text, self._api_key)
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            body = None
        if isinstance(body, dict) and body.get("error"):
            raise UpstreamFailure()
        return body, raw, started
