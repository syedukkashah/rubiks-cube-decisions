import asyncio
import csv
import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_guardrails import puzzle, response

from app.adapters.factory import real_adapter
from app.adapters.mock import MockAdapter
from app.budget import SpendLedger
from app.config import CHAT_MODEL, Settings
from app.main import create_app
from app.runner.service import BenchmarkService, RunConflict
from app.schemas import MODEL_IDS, RunConfig
from app.stats import compute_stats
from app.storage import RunStore, write_json
from scripts.export_results import export_results
from scripts.live_smoke import recommended_cap, run_smoke


@pytest.fixture
def settings(tmp_path):
    return Settings(
        mock_models=False,
        api_key="private-test-key",
        runs_dir=tmp_path / "runs",
        spend_ledger_path=tmp_path / "ledger.jsonl",
    )


async def test_finished_run_roundtrip(settings):
    settings = replace(settings, mock_models=True)
    service = BenchmarkService(
        lambda model, p: MockAdapter(p.scramble_moves),
        settings=settings,
        store=RunStore(settings.runs_dir),
    )
    service.add_puzzles([puzzle()])
    state = await service.submit(RunConfig(puzzle_ids=["pz_test"]))
    await state.task
    snapshot = state.snapshot.model_dump()
    stats = compute_stats(state.snapshot).model_dump()
    events = [e async for e in state.log.stream(0)]

    def no_call(*args):
        raise AssertionError("Loading must never run adapters")

    restored = BenchmarkService(
        no_call,
        settings=replace(settings, chat_max_tokens=96, chat_reasoning_effort="omit"),
        store=RunStore(settings.runs_dir),
    )
    saved = restored.runs[state.snapshot.run_id]
    assert restored.puzzles == service.puzzles
    assert saved.snapshot.model_dump() == snapshot
    assert compute_stats(saved.snapshot).model_dump() == stats
    assert [e async for e in saved.log.stream(0)] == events
    assert saved.task is None
    assert saved.execution_config == {
        "chat_max_tokens": 160,
        "chat_reasoning_effort": "low",
        "max_trial_retries": 3,
    }
    assert not settings.spend_ledger_path.exists()


async def test_interrupted_snapshot_loads_failed_without_reexecution(settings):
    store = RunStore(settings.runs_dir)
    service = BenchmarkService(
        lambda *args: None, settings=replace(settings, mock_models=True), store=store
    )
    service.add_puzzles([puzzle()])
    state = service.start(RunConfig(puzzle_ids=["pz_test"]))
    # Simulate termination immediately after the durable queued snapshot.
    state.task.cancel()
    await asyncio.gather(state.task, return_exceptions=True)
    before = next((settings.runs_dir / "runs").glob("*.json")).read_bytes()
    restored = BenchmarkService(lambda *args: None, settings=settings, store=store)
    saved = restored.runs[state.snapshot.run_id]
    assert saved.snapshot.status == "failed" and saved.task is None
    assert all(t.error.message == "interrupted by restart" for t in saved.snapshot.trials)
    assert saved.log.events[-1].type == "run_finished"
    assert next((settings.runs_dir / "runs").glob("*.json")).read_bytes() == before


async def test_shutdown_marks_running_run_failed(settings):
    entered = asyncio.Event()

    class Waiting:
        async def choose_move(self, *args):
            entered.set()
            await asyncio.Event().wait()

    service = BenchmarkService(
        lambda *args: Waiting(),
        settings=replace(settings, mock_models=True),
        store=RunStore(settings.runs_dir),
    )
    service.add_puzzles([puzzle()])
    state = service.start(RunConfig(puzzle_ids=["pz_test"]))
    await entered.wait()
    await service.close()
    assert state.snapshot.status == "failed"
    assert state.snapshot.trials[0].error.message == "interrupted by restart"


async def test_duplicate_guard_content_restart_and_override(settings):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: response(json.loads(request.content)["model"])
        )
    ) as client:

        def factory(model, _):
            return real_adapter(model, client, settings)

        service = BenchmarkService(
            factory,
            settings=settings,
            ledger=SpendLedger(settings),
            store=RunStore(settings.runs_dir),
        )
        service.add_puzzles([puzzle(), puzzle("pz_new")])
        config = RunConfig(puzzle_ids=["pz_test"])
        state = await service.submit(config)
        with pytest.raises(RunConflict) as active:
            await service.submit(config)
        assert active.value.details == {"active_run_id": state.snapshot.run_id}
        await state.task
        restored = BenchmarkService(
            factory,
            settings=settings,
            ledger=SpendLedger(settings),
            store=RunStore(settings.runs_dir),
        )
        with pytest.raises(RunConflict) as duplicate:
            await restored.submit(config.model_copy(update={"puzzle_ids": ["pz_new"]}))
        assert duplicate.value.details == {"duplicate_of_run_id": state.snapshot.run_id}
        restored.settings = replace(settings, allow_live_rerun=True)
        again = await restored.submit(config)
        await again.task
        assert again.snapshot.status == "completed"


async def test_mock_allows_repeats(settings):
    settings = replace(settings, mock_models=True)
    service = BenchmarkService(lambda model, p: MockAdapter(p.scramble_moves), settings=settings)
    service.add_puzzles([puzzle()])
    config = RunConfig(puzzle_ids=["pz_test"])
    first, second = await service.submit(config), await service.submit(config)
    await asyncio.gather(first.task, second.task)
    third = await service.submit(config)
    await third.task
    assert third.snapshot.status == "completed"
    assert not settings.spend_ledger_path.exists()


def test_mock_ignores_unreadable_ledger_and_network(settings):
    settings.spend_ledger_path.write_text("corrupt ledger must not be read")
    settings = replace(settings, mock_models=True)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/models").status_code == 200
        assert client.get("/api/v1/health").json()["contract_version"] == "1.3.0"
    assert settings.spend_ledger_path.read_text() == "corrupt ledger must not be read"


async def test_smoke_four_calls_and_ledger(settings):
    calls, output = [], []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body["model"])
        return response(body["model"])

    result = await run_smoke(settings, transport=httpx.MockTransport(handler), emit=output.append)
    assert result == 0
    assert calls == list(MODEL_IDS)
    assert SpendLedger(settings).live_calls == 4
    assert "private-test-key" not in "\n".join(output)


async def test_smoke_refuses_without_live_optin(settings):
    assert await run_smoke(replace(settings, mock_models=True), emit=lambda _: None) == 2
    assert await run_smoke(replace(settings, api_key=""), emit=lambda _: None) == 2
    assert not settings.spend_ledger_path.exists()


async def test_smoke_compatibility_once(settings):
    bodies, output = [], []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        if body["model"] == CHAT_MODEL and "reasoning" in body:
            return httpx.Response(400, json={"error": {"message": "reasoning budget too small"}})
        return response(body["model"])

    assert (
        await run_smoke(settings, transport=httpx.MockTransport(handler), emit=output.append) == 0
    )
    assert len(bodies) == 5 and "reasoning" not in bodies[-1]
    assert bodies[-1]["max_tokens"] == 160
    assert SpendLedger(settings).live_calls == 5
    assert any("CHAT_REASONING_EFFORT=omit" in line for line in output)


@pytest.mark.parametrize(
    "tokens,finish,cost,expected",
    [
        (64, "stop", 0.004, 0),
        (160, "stop", 0.004, 1),
        (512, "length", 0.011, 1),
        (64, "stop", 0.013, 1),
    ],
)
async def test_calibration_and_stop_gates(settings, tokens, finish, cost, expected):
    calls, output = [], []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert body["model"] == CHAT_MODEL and body["max_tokens"] == 512
        return response(CHAT_MODEL, tokens=tokens, finish=finish, cost=cost)

    assert (
        await run_smoke(
            settings, calibrate=True, transport=httpx.MockTransport(handler), emit=output.append
        )
        == expected
    )
    assert len(calls) == (1 if expected else 3)
    assert any("Recommended CHAT_MAX_TOKENS=" in line for line in output) == (expected == 0)
    assert recommended_cap([64, 64, 64]) == 96
    assert SpendLedger(settings).live_calls == len(calls)


def test_export_from_fixtures(settings, tmp_path):
    fixtures = Path(__file__).resolve().parents[2] / "contract" / "fixtures"
    snapshots = json.loads((fixtures / "run_snapshots.json").read_text())
    snapshot = next(s for s in snapshots if s["status"] == "completed")
    write_json(
        settings.runs_dir / "runs" / "fixture.json",
        {
            "snapshot": snapshot,
            "live": True,
            "events": [],
            "execution_config": {"chat_max_tokens": 160, "chat_reasoning_effort": "low"},
            "call_metrics": [
                {
                    "model_id": CHAT_MODEL,
                    "accepted": True,
                    "finish_reason": "stop",
                    "usage": {"output_tokens": 60, "reasoning_tokens": 50},
                },
                {
                    "model_id": CHAT_MODEL,
                    "accepted": False,
                    "finish_reason": "length",
                    "usage": {"output_tokens": 160, "reasoning_tokens": 160},
                },
            ],
        },
    )
    settings.spend_ledger_path.write_text(
        json.dumps(
            {
                "run_id": snapshot["run_id"],
                "model_id": CHAT_MODEL,
                "cost_usd": 0.02,
            }
        )
        + "\n"
    )
    output = tmp_path / "results"
    export_results(settings.runs_dir, settings.spend_ledger_path, output)
    rows = list(csv.DictReader((output / f"{snapshot['run_id']}.csv").open()))
    opus = next(r for r in rows if r["model_id"] == CHAT_MODEL)
    assert opus["opus_avg_completion_tokens_per_move"] == "60"
    assert opus["opus_avg_reasoning_tokens_per_move"] == "50"
    assert opus["opus_truncation_count"] == "1"
    assert opus["opus_max_tokens"] == "160"
    assert opus["opus_reasoning_effort"] == "low"
    assert opus["spend_usd"] == "0.02"
    summary = (output / "benchmark_summary.md").read_text()
    assert "$0.020000" in summary
    assert "Opus max_tokens: 160; reasoning setting: low" in summary
    assert "private-test-key" not in summary
