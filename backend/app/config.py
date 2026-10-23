from dataclasses import dataclass, field
from os import environ
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default="", repr=False)
    cors_origins: tuple[str, ...] = ("http://localhost:5173",)
    mock_models: bool = False

    @classmethod
    def from_env(cls):
        load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
        return cls(
            api_key=environ.get("OPENROUTER_API_KEY", "").strip(),
            cors_origins=tuple(
                origin.strip()
                for origin in environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")
                if origin.strip()
            ),
            mock_models=environ.get("MOCK_MODELS", "false").lower() == "true",
        )
