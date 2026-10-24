import json
import math
import re
from dataclasses import dataclass, field
from time import perf_counter
from typing import Protocol

import httpx

from app.config import Settings


@dataclass(frozen=True)
class Usage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    cost: float | None = None

    @classmethod
    def parse(cls, body):
        usage = body.get("usage", {}) if isinstance(body, dict) else {}
        if not isinstance(usage, dict):
            return cls()

        def count(value):
            return (
                value
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0
                else None
            )

        details = usage.get("completion_tokens_details", {})
        cost = usage.get("cost")
        if type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0:
            cost = None
        return cls(
            count(usage.get("prompt_tokens", usage.get("input_tokens"))),
            count(usage.get("completion_tokens", usage.get("output_tokens"))),
            count(details.get("reasoning_tokens")) if isinstance(details, dict) else None,
            cost,
        )


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
    usage: Usage = field(default_factory=Usage)
    finish_reason: str | None = None
    provider: str | None = None
    empty_content: bool = False


class Adapter(Protocol):
    async def choose_move(
        self, state: str, recent_moves: list[str], allowed_moves: list[str], timeout_s: float
    ) -> MoveChoice: ...


class UpstreamFailure(Exception):
    def __init__(
        self,
        code: str = "upstream_error",
        *,
        status=None,
        retry_after=None,
        usage=None,
        compatibility=None,
    ):
        self.code = code
        self.status = status
        self.retryable = status in {408, 429, 500, 502, 503, 504} or status is None
        self.fatal = status in {401, 402}
        self.retry_after = retry_after
        self.usage = usage or Usage()
        self.compatibility = compatibility
        super().__init__(
            "invalid key"
            if status == 401
            else "insufficient credits"
            if status == 402
            else "OpenRouter request timed out"
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

    def __init__(
        self,
        model_id: str,
        client: httpx.AsyncClient,
        api_key: str,
        settings: Settings | None = None,
    ):
        self.model_id = model_id
        self.client = client
        self._api_key = api_key
        self.settings = settings or Settings()

    async def request(self, payload: dict, timeout_s: float):
        started = perf_counter()
        try:
            response = await self.client.post(
                "https://openrouter.ai" + self.path,
                content=json.dumps(payload, separators=(",", ":")),
                headers={
                    "Authorization": "Bearer " + self._api_key,
                    "Content-Type": "application/json",
                },
                timeout=timeout_s,
            )
        except httpx.TimeoutException:
            raise UpstreamFailure("upstream_timeout") from None
        except httpx.HTTPError:
            raise UpstreamFailure() from None
        raw = scrub(response.text, self._api_key)
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            body = None
        error = body.get("error") if isinstance(body, dict) else None
        if not error and isinstance(body, dict) and isinstance(body.get("choices"), list):
            first = body["choices"][0] if body["choices"] else {}
            if isinstance(first, dict):
                error = first.get("error") or (
                    {"code": 502} if first.get("finish_reason") == "error" else None
                )
        if response.is_error or error:
            status = response.status_code
            if status < 400:
                status = error.get("code", 502) if isinstance(error, dict) else 502
                if not isinstance(status, int):
                    status = 502
            retry_after = None
            if status == 429:
                try:
                    seconds = float(response.headers.get("Retry-After", ""))
                    if math.isfinite(seconds) and 0 <= seconds <= 10:
                        retry_after = seconds
                except ValueError:
                    pass
            compatibility = None
            if status == 400:
                lower = raw.lower()
                if "reasoning" in lower or "thinking" in lower or "budget_tokens" in lower:
                    compatibility = "reasoning"
                elif "temperature" in lower:
                    compatibility = "temperature"
            raise UpstreamFailure(
                "upstream_timeout" if status == 408 else "upstream_error",
                status=status,
                retry_after=retry_after,
                usage=Usage.parse(body),
                compatibility=compatibility,
            )
        return body, raw, started
