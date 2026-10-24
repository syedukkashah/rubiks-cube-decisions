"""Durable pre-call estimates become actual charges on completion.

One row per HTTP attempt, including interrupted calls. One process owns the file.
"""

import asyncio
import json
from decimal import Decimal

from app.config import CHAT_MODEL, INPUT_TOKEN_FLOORS, PRICES, Settings
from app.schemas import utc_now
from app.storage import atomic_text


class BudgetExceeded(Exception):
    code = "conflict"


def per_call_cost(
    settings: Settings, model_id: str, input_tokens=None, output_tokens=None
) -> Decimal:
    if input_tokens is None:
        input_tokens = INPUT_TOKEN_FLOORS[model_id]
    if output_tokens is None:
        output_tokens = settings.chat_max_tokens if model_id == CHAT_MODEL else 0
    price_in, price_out = PRICES[model_id]
    return (
        Decimal(str(price_in)) * input_tokens + Decimal(str(price_out)) * output_tokens
    ) / 1000000


def estimate_run(settings: Settings, config, input_token_estimates=None) -> Decimal:
    input_token_estimates = input_token_estimates or {}
    attempts = min(
        config.max_moves + settings.max_trial_retries, config.max_moves * (config.max_retries + 1)
    )
    return (
        len(config.puzzle_ids)
        * attempts
        * sum(
            (
                per_call_cost(
                    settings,
                    model,
                    max(
                        INPUT_TOKEN_FLOORS[model], input_token_estimates.get(model, 0)
                    ),
                )
                for model in config.model_ids
            ),
            Decimal(0),
        )
    )


class SpendLedger:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.path = settings.spend_ledger_path
        self.lock = asyncio.Lock()
        self.rows = []
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                row = json.loads(line)
                cost = Decimal(str(row["cost_usd"]))
                if not cost.is_finite() or cost < 0 or row["model_id"] not in PRICES:
                    raise ValueError("Invalid spend ledger; refusing to reset budget")
                tokens = row.get("input_tokens")
                if tokens is not None and (type(tokens) is not int or tokens < 0):
                    raise ValueError("Invalid ledger input token count; refusing to underestimate")
                self.rows.append(row)

    @property
    def input_token_estimates(self):
        """Historical high-water marks, not a guarantee about future provider overhead."""
        estimates = dict(INPUT_TOKEN_FLOORS)
        for row in self.rows:
            model = row["model_id"]
            estimates[model] = max(estimates[model], row.get("input_tokens") or 0)
        return estimates

    def estimate_run(self, config):
        return estimate_run(self.settings, config, self.input_token_estimates)

    @property
    def spent_usd(self):
        return sum((Decimal(str(row["cost_usd"])) for row in self.rows), Decimal(0))

    @property
    def live_calls(self):
        return len(self.rows)

    @property
    def remaining(self):
        return max(Decimal(0), Decimal(str(self.settings.max_spend_usd)) - self.spent_usd)

    def _flush(self):
        atomic_text(
            self.path, "".join(json.dumps(row, allow_nan=False) + "\n" for row in self.rows)
        )

    async def reserve(self, run_id: str, trial_id: str, model_id: str):
        async with self.lock:
            input_tokens = self.input_token_estimates[model_id]
            estimate = per_call_cost(self.settings, model_id, input_tokens)
            if (
                self.spent_usd >= Decimal(str(self.settings.max_spend_usd))
                or estimate > self.remaining
            ):
                raise BudgetExceeded("Live spend cap reached")
            if self.live_calls >= self.settings.max_live_calls:
                raise BudgetExceeded("Live call cap reached")
            index = len(self.rows)
            self.rows.append(
                {
                    "ts": utc_now(),
                    "run_id": run_id,
                    "trial_id": trial_id,
                    "model_id": model_id,
                    "input_tokens": input_tokens,
                    "output_tokens": self.settings.chat_max_tokens if model_id == CHAT_MODEL else 0,
                    "reasoning_tokens": None,
                    "cost_usd": float(estimate),
                    "estimated": True,
                }
            )
            try:
                self._flush()
            except BaseException:
                self.rows.pop()
                raise
            return index

    async def settle(self, index, usage):
        async with self.lock:
            old = self.rows[index]
            estimated = usage.cost is None
            cost = (
                per_call_cost(
                    self.settings,
                    old["model_id"],
                    max(
                        self.input_token_estimates[old["model_id"]],
                        old.get("input_tokens") or 0,
                        usage.input_tokens or 0,
                    ),
                    max(old["output_tokens"], usage.output_tokens or 0),
                )
                if estimated
                else Decimal(str(usage.cost))
            )
            self.rows[index] = {
                **old,
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "reasoning_tokens": usage.reasoning_tokens,
                "cost_usd": float(cost),
                "estimated": estimated,
            }
            try:
                self._flush()
            except BaseException:
                self.rows[index] = old
                raise

    def summary(self, run_id):
        rows = [row for row in self.rows if row["run_id"] == run_id]
        return len(rows), sum((Decimal(str(r["cost_usd"])) for r in rows), Decimal(0))
