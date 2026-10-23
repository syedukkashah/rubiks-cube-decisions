import asyncio
import logging
from time import monotonic

import httpx

from app.schemas import MODEL_SPECS, ModelInfo

logger = logging.getLogger(__name__)


class ModelRegistry:
    def __init__(self, client: httpx.AsyncClient, mock: bool):
        self.client = client
        self.mock = mock
        self.models = [
            ModelInfo(
                id=model_id, label=label, category=category, interface=interface, available=mock
            )
            for model_id, label, category, interface in MODEL_SPECS
        ]
        self.checked_at = float("-inf")
        self.lock = asyncio.Lock()

    async def refresh(self):
        if self.mock or monotonic() - self.checked_at < 60:
            return
        async with self.lock:
            if monotonic() - self.checked_at < 60:
                return

            async def check(model):
                try:
                    response = await self.client.get(
                        f"https://openrouter.ai/api/v1/models/{model.id}/endpoints", timeout=10
                    )
                    if response.status_code == 404:
                        model.available = False
                        return
                    response.raise_for_status()
                    endpoints = response.json()["data"]["endpoints"]
                    if not isinstance(endpoints, list):
                        raise ValueError("invalid catalog response")
                    model.available = bool(endpoints)
                except (httpx.HTTPError, ValueError, KeyError, TypeError):
                    # Preserve the previous result; never assume availability on failure.
                    logger.warning("Model availability check failed for %s", model.id)

            await asyncio.gather(*(check(model) for model in self.models))
            self.checked_at = monotonic()
