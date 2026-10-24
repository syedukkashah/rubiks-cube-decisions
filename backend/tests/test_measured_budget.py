import json
from dataclasses import replace
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient
from test_guardrails import puzzle

from app.adapters.base import Usage
from app.budget import BudgetExceeded, SpendLedger, estimate_run, per_call_cost
from app.config import CHAT_MODEL, Settings
from app.main import create_app
from app.schemas import BenchmarkSessionRun, RunConfig


@pytest.fixture
def settings(tmp_path):
    return Settings(
        mock_models=False,
        api_key="test-key",
        max_spend_usd=1,
        runs_dir=tmp_path / "runs",
        spend_ledger_path=tmp_path / "ledger.jsonl",
        recording_path=tmp_path / "recording.json",
    )


def save_observations(settings):
    settings.spend_ledger_path.write_text(
        "".join(
            json.dumps(
                {
                    "run_id": "run_smoke",
                    "trial_id": "tr_smoke",
                    "model_id": model,
                    "input_tokens": tokens,
                    "output_tokens": 11,
                    "cost_usd": 0.0001,
                    "estimated": False,
                }
            )
            + "\n"
            for model, tokens in (
                ("typesafe/jev-1.13", 594),
                ("openai/gpt-6-luna-decisions", 283),
                ("cloudflare/clef", 483),
                (CHAT_MODEL, 480),
            )
        )
    )


async def test_observations_raise_reservations_and_survive_restart(settings):
    ledger = SpendLedger(settings)
    first = await ledger.reserve("run_smoke", "tr_smoke", CHAT_MODEL)
    await ledger.settle(first, Usage(720, 11, 0, 0.00214))
    assert ledger.spent_usd == Decimal("0.00214")
    before = settings.spend_ledger_path.read_bytes()
    ledger = SpendLedger(settings)
    assert settings.spend_ledger_path.read_bytes() == before
    assert ledger.input_token_estimates[CHAT_MODEL] == 720
    second = await ledger.reserve("run_next", "tr_next", CHAT_MODEL)
    assert ledger.rows[second]["cost_usd"] == 0.00608
    await ledger.settle(second, Usage())
    assert ledger.rows[second]["estimated"]
    assert ledger.rows[second]["cost_usd"] == 0.00608
    third = await ledger.reserve("run_lower", "tr_lower", CHAT_MODEL)
    await ledger.settle(third, Usage(200, 11, 0, 0.001))
    assert SpendLedger(settings).input_token_estimates[CHAT_MODEL] == 720
    assert ledger.spent_usd == Decimal("0.00922")


def test_model_specific_estimates_keep_floor_and_retry_formula(settings):
    save_observations(settings)
    ledger = SpendLedger(settings)
    assert ledger.input_token_estimates == {
        "typesafe/jev-1.13": 594,
        "openai/gpt-6-luna-decisions": 300,
        "cloudflare/clef": 483,
        CHAT_MODEL: 600,
    }
    config = RunConfig(puzzle_ids=[f"pz_{i}" for i in range(6)])
    expected = 198 * sum(
        per_call_cost(settings, model, tokens)
        for model, tokens in ledger.input_token_estimates.items()
    )
    assert ledger.estimate_run(config) == expected
    assert expected > estimate_run(settings, config)
    assert ledger.estimate_run(config.model_copy(update={"max_retries": 0})) == expected * 30 / 33


async def test_midrun_reservation_uses_measured_tokens(settings):
    save_observations(settings)
    settings = replace(settings, max_spend_usd=0.0049)
    ledger = SpendLedger(settings)
    before = settings.spend_ledger_path.read_bytes()
    # The old 300-token estimate would fit; the approved Opus allowance does not.
    assert per_call_cost(settings, CHAT_MODEL, input_tokens=300) < ledger.remaining
    with pytest.raises(BudgetExceeded, match="spend cap"):
        await ledger.reserve("run_new", "tr_new", CHAT_MODEL)
    assert settings.spend_ledger_path.read_bytes() == before


def test_run_admission_uses_measurements_without_inference(settings):
    save_observations(settings)
    settings = replace(settings, max_spend_usd=0.8)
    before = settings.spend_ledger_path.read_bytes()

    def only_metadata(request):
        assert request.method == "GET", "Admission must reject before inference"
        return httpx.Response(200, json={"data": {"endpoints": [{}]}})

    with TestClient(create_app(settings, transport=httpx.MockTransport(only_metadata))) as client:
        puzzles = [puzzle(f"pz_{i}") for i in range(5)]
        client.app.state.service.add_puzzles(puzzles)
        result = client.post(
            "/api/v1/runs",
            json={
                "puzzle_ids": [p.puzzle_id for p in puzzles],
                "model_ids": [CHAT_MODEL],
            },
        )
        assert result.status_code == 409
        assert result.json()["error"]["details"] == {
            "estimated_max_cost_usd": 0.924,
            "remaining_budget_usd": 0.7996,
        }
    assert settings.spend_ledger_path.read_bytes() == before


def test_session_info_admission_and_next_gate_use_measurements(settings):
    save_observations(settings)
    before = settings.spend_ledger_path.read_bytes()

    def no_network(request):
        pytest.fail("Measured budget refusal must happen before any provider request")

    with TestClient(create_app(settings, transport=httpx.MockTransport(no_network))) as client:
        assert client.get("/api/v1/benchmark").json()["sources"]["live"] is False
        result = client.post(
            "/api/v1/benchmark/sessions",
            json={
                "source": "live",
                "confirm_cost": True,
                "include_extension": False,
            },
        )
        assert result.status_code == 409
        assert result.json()["error"]["details"]["reason"] == "budget"
        assert result.json()["error"]["details"]["estimated_max_cost_usd"] > 1
        service = client.app.state.service
        service.add_puzzles([puzzle()])
        current = service.create(RunConfig(puzzle_ids=["pz_test"]))
        current.snapshot.status = "completed"
        next_puzzles = [puzzle(f"pz_next_{i}") for i in range(6)]
        service.add_puzzles(next_puzzles)
        next_run = service.create(RunConfig(puzzle_ids=[p.puzzle_id for p in next_puzzles]))
        gate = client.app.state.sessions.gate(
            BenchmarkSessionRun(
                step="warmup", suite="warmup", run_id=current.snapshot.run_id, status="completed"
            ),
            BenchmarkSessionRun(
                step="primary", suite="primary", run_id=next_run.snapshot.run_id, status="queued"
            ),
        )
        assert gate.reasons == ["budget"]
    assert settings.spend_ledger_path.read_bytes() == before


@pytest.mark.parametrize("tokens", [-1, "480", True, 480.5])
def test_invalid_ledger_measurements_fail_closed(settings, tokens):
    settings.spend_ledger_path.write_text(
        json.dumps(
            {
                "model_id": CHAT_MODEL,
                "cost_usd": 0,
                "input_tokens": tokens,
            }
        )
        + "\n"
    )
    with pytest.raises(ValueError, match="input token"):
        SpendLedger(settings)
