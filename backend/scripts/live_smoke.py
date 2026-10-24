"""Paid only when explicitly run in live mode. No retries except G2 smoke compatibility."""

import argparse
import asyncio
import json
import math
import sys
from dataclasses import replace
from pathlib import Path
from random import Random
from uuid import uuid4

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.adapters.base import UpstreamFailure
from app.adapters.factory import real_adapter
from app.budget import BudgetExceeded, SpendLedger
from app.config import CHAT_MODEL, CHAT_PROMPT_TOKEN_LIMIT, Settings
from app.engine import MOVES, SOLVED, apply_move, scramble
from app.runner.calls import call_model
from app.schemas import MODEL_IDS


def recommended_cap(tokens):
    return min(512, max(64, math.ceil(1.5 * max(tokens) / 32) * 32))


def report_failure(model, error, emit):
    emit(f"STOP: {model}: {error}")
    if isinstance(error, UpstreamFailure):
        emit(json.dumps({"model_id": model, "error_code": error.code, **error.diagnostics}))


async def run_smoke(settings, calibrate=False, transport=None, emit=print, *, diagnose_opus=False):
    if calibrate and diagnose_opus:
        emit("Refusing: calibration and single-request diagnosis are separate paid steps.")
        return 2
    if settings.mock_models or not settings.api_key:
        emit("Refusing: set MOCK_MODELS=false and configure OPENROUTER_API_KEY.")
        return 2
    if calibrate:
        settings = replace(settings, chat_max_tokens=512)
    ledger = SpendLedger(settings)
    run_id = "run_" + uuid4().hex
    jobs = (
        [(CHAT_MODEL, scramble(Random(seed), 3)[1]) for seed in (100, 101, 102)]
        if calibrate
        else [
            (model, apply_move(SOLVED, "R"))
            for model in ([CHAT_MODEL] if diagnose_opus else MODEL_IDS)
        ]
    )
    results = []
    failed = False
    async with httpx.AsyncClient(transport=transport) as client:
        for model, state in jobs:
            trial_id = "tr_" + uuid4().hex
            adapter = real_adapter(model, client, settings)
            try:
                try:
                    result = await call_model(
                        adapter,
                        state,
                        [],
                        min(15, settings.max_timeout_s),
                        ledger,
                        run_id,
                        trial_id,
                        model,
                    )
                except UpstreamFailure as error:
                    if (
                        not calibrate
                        and not diagnose_opus
                        and model == CHAT_MODEL
                        and error.status == 400
                        and error.compatibility == "reasoning"
                        and settings.chat_reasoning_effort == "low"
                    ):
                        report_failure(model, error, emit)
                        emit("G2 compatibility probe: one extra call omitting reasoning, same cap.")
                        alternate = replace(settings, chat_reasoning_effort="omit")
                        result = await call_model(
                            real_adapter(model, client, alternate),
                            state,
                            [],
                            min(15, settings.max_timeout_s),
                            ledger,
                            run_id,
                            trial_id,
                            model,
                        )
                        emit(
                            "Set CHAT_REASONING_EFFORT=omit before the next live step; "
                            "no settings file was changed."
                        )
                    else:
                        raise
            except (UpstreamFailure, BudgetExceeded) as error:
                report_failure(model, error, emit)
                if isinstance(error, UpstreamFailure) and error.compatibility == "temperature":
                    emit("Route rejected temperature; review G2 compatibility before proceeding.")
                # Credentials/caps are fatal. Other errors still count as the model's one probe.
                if isinstance(error, BudgetExceeded) or error.fatal or model == CHAT_MODEL:
                    failed = True
                    break
                failed = True
                continue
            results.append(result)
            emit(
                json.dumps(
                    {
                        "model_id": model,
                        "move": result.move if result.move in MOVES else None,
                        "latency_ms": result.latency_ms,
                        "prompt_tokens": result.usage.input_tokens,
                        "completion_tokens": result.usage.output_tokens,
                        "reasoning_tokens": result.usage.reasoning_tokens,
                        "usage.cost": result.usage.cost,
                        "finish_reason": result.finish_reason,
                        "provider": result.provider,
                    }
                )
            )
            if result.move not in MOVES:
                failed = True
            if model == CHAT_MODEL:
                if (
                    result.usage.input_tokens is None
                    or result.usage.input_tokens > CHAT_PROMPT_TOKEN_LIMIT
                ):
                    emit(f"STOP: Opus prompt_tokens missing or above {CHAT_PROMPT_TOKEN_LIMIT}.")
                    failed = True
                    break
                if result.usage.cost is not None and result.usage.cost > 0.012:
                    emit("STOP AND ASK: Opus cost exceeds $0.012 per call.")
                    failed = True
                    break
    calls, spent = ledger.summary(run_id)
    emit(f"Run {run_id}: calls={calls} spent_usd={spent} remaining_budget_usd={ledger.remaining}")
    if calibrate:
        if len(results) != 3 or any(r.usage.output_tokens is None for r in results):
            emit("STOP AND ASK: calibration did not return three measured completions.")
            return 1
        truncation_rate = sum(r.finish_reason == "length" for r in results) / 3
        recommendation = recommended_cap([r.usage.output_tokens for r in results])
        emit(f"Recommended CHAT_MAX_TOKENS={recommendation}; truncation_rate={truncation_rate:.1%}")
        if truncation_rate > 0.20 or recommendation > 192:
            emit("STOP AND ASK: truncation above 20% at 512 or recommendation above 192.")
            failed = True
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--calibrate", action="store_true")
    mode.add_argument(
        "--diagnose-opus",
        action="store_true",
        help="One paid Opus request at current settings; no retries or compatibility probe.",
    )
    args = parser.parse_args()
    try:
        return asyncio.run(
            run_smoke(Settings.from_env(), args.calibrate, diagnose_opus=args.diagnose_opus)
        )
    except (ValueError, OSError):
        print("Refusing: invalid settings or unreadable local accounting files.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
