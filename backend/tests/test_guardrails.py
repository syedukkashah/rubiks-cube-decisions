import asyncio
import itertools
import json
import re
from dataclasses import replace
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters.base import Usage
from app.adapters.factory import real_adapter
from app.adapters.prompts import CRITERIA, INSTRUCTIONS, MOVE_PATTERN, SHORT_ANSWER
from app.budget import BudgetExceeded, SpendLedger, estimate_run, per_call_cost
from app.config import CHAT_MODEL, Settings
from app.engine import MOVES, SOLVED, apply_move
from app.main import create_app
from app.runner.service import BenchmarkService
from app.schemas import MODEL_IDS, Puzzle, RunConfig, utc_now


@pytest.fixture
def settings(tmp_path):
    return Settings(
        mock_models=False,
        api_key="private-test-key",
        runs_dir=tmp_path / "runs",
        spend_ledger_path=tmp_path / "ledger.jsonl",
    )


def puzzle(puzzle_id="pz_test"):
    return Puzzle(
        puzzle_id=puzzle_id,
        suite="warmup",
        scramble_moves=["R"],
        facelets=apply_move(SOLVED, "R"),
        optimal_distance=1,
        created_at=utc_now(),
    )


def response(model, move="R'", cost=0.001, finish="stop", tokens=32):
    body = {
        "usage": {
            "prompt_tokens": 200,
            "completion_tokens": tokens,
            "completion_tokens_details": {"reasoning_tokens": 20},
            "cost": cost,
        },
        "provider": "test-provider",
    }
    if model == CHAT_MODEL:
        body["choices"] = [
            {
                "finish_reason": finish,
                "message": {
                    "content": json.dumps({"move": move}) if move is not None else "",
                },
            }
        ]
    else:
        body["answers"] = {"next_move": {"type": "choice", "choice": move}}
    return httpx.Response(200, json=body)


@pytest.mark.parametrize(
    "name,value",
    [
        ("max_spend_usd", 1.1001),
        ("max_spend_usd", -1),
        ("max_spend_usd", float("nan")),
        ("max_spend_usd", float("inf")),
        ("max_live_calls", -1),
        ("max_live_calls", 1.5),
        ("max_trial_retries", -1),
        ("max_retries_cap", -1),
        ("max_timeout_s", -1),
        ("chat_max_tokens", 63),
        ("chat_max_tokens", 513),
        ("chat_max_tokens", True),
        ("chat_reasoning_effort", "none"),
        ("chat_reasoning_effort", "high"),
    ],
)
def test_settings_reject_unsafe_values(name, value):
    with pytest.raises(ValueError, match=name.upper()):
        Settings(**{name: value})


def test_env_defaults_and_validation(monkeypatch):
    monkeypatch.setattr("app.config.load_dotenv", lambda *a, **kw: None)
    for name in (
        "MOCK_MODELS",
        "MAX_SPEND_USD",
        "CHAT_MAX_TOKENS",
        "CHAT_REASONING_EFFORT",
        "MAX_TRIAL_RETRIES",
        "MAX_TIMEOUT_S",
        "MAX_RETRIES_CAP",
        "MAX_LIVE_CALLS",
        "ALLOW_LIVE_RERUN",
    ):
        monkeypatch.delenv(name, raising=False)
    assert Settings.from_env().mock_models is True
    assert Settings.from_env().max_spend_usd == 1.10
    monkeypatch.setenv("MAX_LIVE_CALLS", "oops")
    with pytest.raises(ValueError, match="MAX_LIVE_CALLS"):
        Settings.from_env()
    monkeypatch.delenv("MAX_LIVE_CALLS")
    monkeypatch.setenv("MOCK_MODELS", "typo")
    with pytest.raises(ValueError, match="MOCK_MODELS"):
        Settings.from_env()


async def test_capped_bodies_and_shared_prompt(settings):
    async with httpx.AsyncClient() as client:
        chat = real_adapter(CHAT_MODEL, client, settings).build_request(
            SOLVED, ["R"] * 6, list(MOVES)
        )
        decision = real_adapter(MODEL_IDS[0], client, settings).build_request(
            SOLVED, ["R"] * 6, list(MOVES)
        )
        assert chat["max_tokens"] == 160 and chat["temperature"] == 0
        assert chat["reasoning"] == {"effort": "low", "exclude": True}
        assert chat["provider"] == {
            "require_parameters": True,
            "max_price": {"prompt": 4, "completion": 20},
        }
        assert "thinking" not in chat
        assert chat["messages"][0]["content"] == (
            INSTRUCTIONS + "\n" + SHORT_ANSWER + "\n" + json.dumps(CRITERIA, separators=(",", ":"))
        )
        assert decision["questions"]["next_move"]["instructions"] == INSTRUCTIONS
        assert decision["questions"]["next_move"]["criteria"] == CRITERIA
        assert json.loads(chat["messages"][1]["content"]) == decision["state"]
        omitted = real_adapter(CHAT_MODEL, client, replace(settings, chat_reasoning_effort="omit"))
        assert "reasoning" not in omitted.build_request(SOLVED, [], list(MOVES))
        worst = real_adapter(CHAT_MODEL, client, settings).build_request(
            SOLVED, ["R'"] * 6, list(MOVES)
        )
        assert len(json.dumps(worst)) <= 1100


def test_compact_schema_matches_exact_move_enum():
    candidates = (
        "".join(chars)
        for length in range(4)
        for chars in itertools.product("UDLRFBudlrfb'23 \n\r", repeat=length)
    )
    for value in candidates:
        assert bool(re.search(MOVE_PATTERN, value)) == (value in MOVES)


async def execute(settings, handler, config=None):
    ledger = SpendLedger(settings)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        service = BenchmarkService(
            lambda model, _: real_adapter(model, client, settings),
            settings.api_key,
            settings,
            ledger,
        )
        service.add_puzzles([puzzle()])
        state = service.start(config or RunConfig(puzzle_ids=["pz_test"], model_ids=[CHAT_MODEL]))
        await state.task
    return state, ledger


@pytest.mark.parametrize(
    "status,attempts",
    [
        (400, 1),
        (401, 1),
        (402, 1),
        (403, 1),
        (404, 1),
        (422, 1),
        (409, 1),
        (408, 2),
        (429, 2),
        (500, 2),
        (502, 2),
        (503, 2),
        (504, 2),
        (501, 1),
    ],
)
@pytest.mark.parametrize("model", MODEL_IDS)
async def test_retry_matrix(settings, monkeypatch, status, attempts, model):
    delays, calls = [], []

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr("app.runner.service.asyncio.sleep", sleep)

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, json={"error": {"message": "private-test-key"}}, headers={"Retry-After": "2"}
        )

    state, ledger = await execute(
        settings, handler, RunConfig(puzzle_ids=["pz_test"], model_ids=[model])
    )
    trial = state.snapshot.trials[0]
    assert len(calls) == attempts == ledger.live_calls
    assert trial.retry_count == attempts - 1 and trial.status == "error"
    assert trial.timeout_count == (attempts if status == 408 else 0)
    assert delays == ([2 if status == 429 else 0.5] if attempts == 2 else [])
    assert state.snapshot.status == ("failed" if status in {401, 402} else "completed")
    assert "private-test-key" not in state.snapshot.model_dump_json()
    assert "private-test-key" not in settings.spend_ledger_path.read_text()


@pytest.mark.parametrize("status", [401, 402])
async def test_fatal_stops_remaining_trials(settings, status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status)

    state, _ = await execute(settings, handler, RunConfig(puzzle_ids=["pz_test"], concurrency=1))
    assert len(calls) == 1
    assert all(t.status == "error" for t in state.snapshot.trials)
    error = next(e for e in state.log.events if e.type == "error")
    assert error.data["message"] == ("invalid key" if status == 401 else "insufficient credits")


@pytest.mark.parametrize("finish,move", [("length", "R'"), ("stop", None), ("stop", "R3")])
async def test_invalid_outputs_retry_and_cost(settings, finish, move):
    state, ledger = await execute(
        settings, lambda request: response(CHAT_MODEL, move, finish=finish)
    )
    trial = state.snapshot.trials[0]
    assert trial.invalid_move_count == 2 and trial.retry_count == 1
    assert trial.moves_used == 0 and trial.status == "error"
    assert ledger.spent_usd == Decimal("0.002")
    invalid = [e for e in state.log.events if e.type == "move_invalid"]
    assert invalid[0].data["reason"] == "malformed_response"


async def test_trial_retry_budget(settings):
    moves = iter(["bad", "U", "bad", "U'", "bad", "U", "bad", "R'"])
    state, ledger = await execute(settings, lambda request: response(CHAT_MODEL, next(moves)))
    trial = state.snapshot.trials[0]
    assert trial.retry_count == 3 and ledger.live_calls == 7
    assert trial.error.message == "trial retry budget exhausted"


async def test_timeout_is_persisted_estimate(settings, monkeypatch):
    async def sleep(delay):
        pass

    monkeypatch.setattr("app.runner.service.asyncio.sleep", sleep)

    def handler(request):
        raise httpx.ReadTimeout("secret")

    state, ledger = await execute(settings, handler)
    assert state.snapshot.trials[0].timeout_count == 2
    assert ledger.live_calls == 2
    assert all(r["estimated"] for r in ledger.rows)
    assert ledger.spent_usd == 2 * per_call_cost(settings, CHAT_MODEL)


async def test_ledger_restore_reservations_and_actual_cost(settings):
    ledger = SpendLedger(settings)
    ticket = await ledger.reserve("run_test", "tr_test", CHAT_MODEL)
    assert SpendLedger(settings).live_calls == 1
    await ledger.settle(ticket, Usage(200, 40, 32, 0.0016))
    restored = SpendLedger(settings)
    assert restored.spent_usd == Decimal("0.0016") and restored.live_calls == 1
    assert restored.rows[0]["estimated"] is False
    ticket = await restored.reserve("run_test", "tr_test", CHAT_MODEL)
    await restored.settle(ticket, Usage())
    assert SpendLedger(settings).rows[1]["estimated"] is True


async def test_concurrent_reservations_cannot_bypass_caps(settings):
    ledger = SpendLedger(replace(settings, max_live_calls=1))
    results = await asyncio.gather(
        *(ledger.reserve("run_test", "tr_test", CHAT_MODEL) for _ in range(4)),
        return_exceptions=True,
    )
    assert ledger.live_calls == 1
    assert sum(isinstance(result, BudgetExceeded) for result in results) == 3


@pytest.mark.parametrize("cap", ["spend", "calls"])
async def test_midrun_backstops(settings, cap):
    settings = replace(settings, max_live_calls=1) if cap == "calls" else settings
    state, ledger = await execute(
        settings,
        lambda request: response(
            CHAT_MODEL,
            "U",
            cost=1.10 if cap == "spend" else 0.001,
        ),
    )
    assert ledger.live_calls == 1
    assert state.snapshot.status == "failed"
    assert state.snapshot.trials[0].error.code == "conflict"
    assert "cap reached" in state.snapshot.trials[0].error.message


def test_precheck_formula(settings):
    config = RunConfig(puzzle_ids=[f"pz_{i}" for i in range(5)])
    assert estimate_run(settings, config) == Decimal("0.744909")
    assert estimate_run(settings, config.model_copy(update={"max_retries": 0})) == (
        estimate_run(settings, config) * 30 / 33
    )


@pytest.mark.parametrize("budget,status", [(0.001, 409), (1.10, 202)])
def test_post_precheck(settings, budget, status):
    settings = replace(settings, max_spend_usd=budget)

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"data": {"endpoints": [{}]}})
        return response(json.loads(request.content)["model"])

    with TestClient(create_app(settings, transport=httpx.MockTransport(handler))) as client:
        client.app.state.service.add_puzzles([puzzle()])
        result = client.post("/api/v1/runs", json={"puzzle_ids": ["pz_test"]})
        assert result.status_code == status
        if status == 409:
            assert result.json()["error"]["details"] == {
                "estimated_max_cost_usd": float(
                    estimate_run(settings, RunConfig(puzzle_ids=["pz_test"]))
                ),
                "remaining_budget_usd": budget,
            }
            assert not settings.spend_ledger_path.exists()


@pytest.mark.parametrize("field,value", [("timeout_s", 21), ("max_retries", 2)])
def test_request_caps(settings, field, value):
    with TestClient(create_app(settings)) as client:
        result = client.post("/api/v1/runs", json={"puzzle_ids": ["pz_test"], field: value})
    assert result.status_code == 422
    assert result.json()["error"]["code"] == "validation_error"
