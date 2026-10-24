import math
from dataclasses import dataclass, field
from os import environ
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
CHAT_MODEL = "anthropic/claude-opus-5.5"
INPUT_TOKEN_ESTIMATE = 300
# USD per million tokens; G1 reference prices, 2026-10-24.
PRICES = {
    "typesafe/jev-1.13": (0.042, 0),
    "openai/gpt-6-luna-decisions": (0.10, 0),
    "cloudflare/clef": (0.24, 0),
    CHAT_MODEL: (4, 20),
}


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default="", repr=False)
    cors_origins: tuple[str, ...] = ("http://localhost:5173",)
    mock_models: bool = True
    max_spend_usd: float = 1.10
    max_trial_retries: int = 3
    max_live_calls: int = 2000
    chat_max_tokens: int = 160
    chat_reasoning_effort: str = "low"
    max_timeout_s: float = 20
    max_retries_cap: int = 1
    spend_ledger_path: Path = BACKEND_DIR / ".spend" / "ledger.jsonl"
    runs_dir: Path = BACKEND_DIR / ".runs"
    allow_live_rerun: bool = False
    recording_path: Path = BACKEND_DIR / "recordings" / "benchmark.json"
    expected_cost_warmup: float = 0.03
    expected_cost_primary: float = 0.33
    expected_cost_extension: float = 0.20

    def __post_init__(self):
        for name in (
            "max_spend_usd",
            "max_timeout_s",
            "max_trial_retries",
            "max_live_calls",
            "chat_max_tokens",
            "max_retries_cap",
            "expected_cost_warmup",
            "expected_cost_primary",
            "expected_cost_extension",
        ):
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or not isinstance(value, int | float)
                or not math.isfinite(value)
                or value < 0
            ):
                raise ValueError(f"{name.upper()} must be a finite non-negative number")
        for name in ("max_trial_retries", "max_live_calls", "chat_max_tokens", "max_retries_cap"):
            if isinstance(getattr(self, name), bool) or not isinstance(getattr(self, name), int):
                raise ValueError(f"{name.upper()} must be an integer")
        if self.max_spend_usd > 1.10:
            raise ValueError("MAX_SPEND_USD must not exceed 1.10")
        if not 64 <= self.chat_max_tokens <= 512:
            raise ValueError("CHAT_MAX_TOKENS must be between 64 and 512")
        if self.chat_reasoning_effort not in {"low", "omit"}:
            raise ValueError("CHAT_REASONING_EFFORT must be low or omit")
        for name in ("mock_models", "allow_live_rerun"):
            if not isinstance(getattr(self, name), bool):
                raise ValueError(f"{name.upper()} must be true or false")

    @classmethod
    def from_env(cls):
        load_dotenv(BACKEND_DIR / ".env", override=False)

        def number(name, default, convert=float):
            try:
                return convert(environ.get(name, str(default)))
            except ValueError:
                raise ValueError(f"{name} must be numeric") from None

        def boolean(name, default):
            value = environ.get(name, default).strip().lower()
            if value not in {"true", "false"}:
                raise ValueError(f"{name} must be true or false")
            return value == "true"

        def path(name, default):
            value = Path(environ.get(name, str(default))).expanduser()
            return value if value.is_absolute() else BACKEND_DIR / value

        return cls(
            api_key=environ.get("OPENROUTER_API_KEY", "").strip(),
            cors_origins=tuple(
                o.strip()
                for o in environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")
                if o.strip()
            ),
            mock_models=boolean("MOCK_MODELS", "true"),
            max_spend_usd=number("MAX_SPEND_USD", 1.10),
            max_trial_retries=number("MAX_TRIAL_RETRIES", 3, int),
            max_live_calls=number("MAX_LIVE_CALLS", 2000, int),
            chat_max_tokens=number("CHAT_MAX_TOKENS", 160, int),
            chat_reasoning_effort=environ.get("CHAT_REASONING_EFFORT", "low"),
            max_timeout_s=number("MAX_TIMEOUT_S", 20),
            max_retries_cap=number("MAX_RETRIES_CAP", 1, int),
            spend_ledger_path=path("SPEND_LEDGER_PATH", ".spend/ledger.jsonl"),
            runs_dir=path("RUNS_DIR", ".runs"),
            allow_live_rerun=boolean("ALLOW_LIVE_RERUN", "false"),
            recording_path=path("RECORDING_PATH", "recordings/benchmark.json"),
            expected_cost_warmup=number("EXPECTED_COST_WARMUP", 0.03),
            expected_cost_primary=number("EXPECTED_COST_PRIMARY", 0.33),
            expected_cost_extension=number("EXPECTED_COST_EXTENSION", 0.20),
        )
