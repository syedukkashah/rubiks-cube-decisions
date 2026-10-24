"""Opt-in rolling live admission (LIVE_ADMISSION=rolling) and the plan timeout override.

Human-approved (2026-10-25) for the second $2 session attempt at CHAT_MAX_TOKENS=512.
Everything is offline: mock transports only, no real HTTP.
"""

import json
from dataclasses import replace
from decimal import Decimal

import httpx
import pytest
from test_guardrails import puzzle, response
from test_sessions import LiveTransport, complete, deny_network, manager

from app.adapters.factory import real_adapter
from app.budget import SpendLedger
from app.config import CHAT_MODEL, Settings
from app.engine import apply_move, inverse
from app.recording import RecordingFile
from app.runner.service import BenchmarkService, RunConflict
from app.schemas import BenchmarkSessionRequest, BenchmarkSessionRun, RunConfig
from app.sessions import SessionError

# Floors at cap 512 (no measured input above them in these tests), micro-USD per attempt:
# Jev 300*0.042 + Luna 300*0.10 + Clef 300*0.24 + Opus (600*4 + 512*20) = 12,754.6.
PUZZLE_WORST = Decimal("0.4209018")  # 33 attempts * $0.0127546
ROLLING_NEED = PUZZLE_WORST + Decimal("0.05")


@pytest.fixture
def settings(tmp_path):
    return Settings(
        mock_models=False,
        api_key="private-test-key",
        chat_max_tokens=512,
        max_spend_usd=2.0,
        runs_dir=tmp_path / "runs",
        spend_ledger_path=tmp_path / "ledger.jsonl",
        recording_path=tmp_path / "recordings" / "benchmark.json",
    )


def spend(settings, usd):
    """A prior settled ledger row: only the spent total matters to admission."""
    settings.spend_ledger_path.write_text(
        json.dumps({"run_id": "run_prior", "model_id": CHAT_MODEL, "cost_usd": usd}) + "\n"
    )


def test_settings_defaults_env_and_validation(monkeypatch):
    assert (Settings().live_admission, Settings().benchmark_timeout_s) == ("full", 15)
    monkeypatch.setattr("app.config.load_dotenv", lambda *a, **kw: None)
    monkeypatch.delenv("LIVE_ADMISSION", raising=False)
    monkeypatch.delenv("BENCHMARK_TIMEOUT_S", raising=False)
    parsed = Settings.from_env()
    assert (parsed.live_admission, parsed.benchmark_timeout_s) == ("full", 15)
    monkeypatch.setenv("LIVE_ADMISSION", " Rolling ")
    monkeypatch.setenv("BENCHMARK_TIMEOUT_S", "20")
    parsed = Settings.from_env()
    assert (parsed.live_admission, parsed.benchmark_timeout_s) == ("rolling", 20)
    for value in ("partial", "", "none"):
        with pytest.raises(ValueError, match="LIVE_ADMISSION"):
            Settings(live_admission=value)
    for value in (0, 0.5, 20.5, 21, -1, float("nan"), True, "20"):
        with pytest.raises(ValueError, match="BENCHMARK_TIMEOUT_S"):
            Settings(benchmark_timeout_s=value)


def test_puzzle_estimate_and_admission_rule(settings):
    ledger = SpendLedger(settings)
    five = RunConfig(puzzle_ids=[f"pz_{i}" for i in range(5)])
    assert ledger.estimate_puzzle(five) == PUZZLE_WORST
    assert ledger.estimate_run(five) == 5 * PUZZLE_WORST
    # Default "full" keeps the whole-run worst case.
    assert ledger.admission_estimate(five) == 5 * PUZZLE_WORST
    rolling = SpendLedger(replace(settings, live_admission="rolling"))
    assert rolling.admission_estimate(five) == ROLLING_NEED
    # Concurrent runs cannot be re-checked per puzzle, so they keep full admission.
    concurrent = five.model_copy(update={"concurrency": 2})
    assert rolling.admission_estimate(concurrent) == 5 * PUZZLE_WORST


def solving_transport(calls, costs=()):
    """Answers R' (solves the one-move test puzzle); the n-th POST costs costs[n]."""

    def handle(request):
        if request.method == "GET":
            return httpx.Response(200, json={"data": {"endpoints": [{}]}})
        model = json.loads(request.content)["model"]
        cost = costs[len(calls)] if len(calls) < len(costs) else 0.001
        calls.append(model)
        return response(model, cost=cost)

    return httpx.MockTransport(handle)


def live_service(settings, client):
    return BenchmarkService(
        lambda model, p: real_adapter(model, client, settings),
        settings.api_key,
        settings,
        SpendLedger(settings),
    )


async def test_run_admission_full_vs_rolling(settings):
    spend(settings, 1.0)  # Remaining $1.00: one puzzle fits, three do not.
    calls = []
    async with httpx.AsyncClient(transport=solving_transport(calls)) as client:
        full = live_service(settings, client)
        full.add_puzzles([puzzle(f"pz_{i}") for i in range(3)])
        config = RunConfig(puzzle_ids=["pz_0", "pz_1", "pz_2"])
        with pytest.raises(RunConflict) as refused:
            await full.submit(config)
        assert refused.value.details == {
            "estimated_max_cost_usd": float(3 * PUZZLE_WORST),
            "remaining_budget_usd": 1.0,
        }
        rolling = live_service(replace(settings, live_admission="rolling"), client)
        rolling.add_puzzles([puzzle(f"pz_{i}") for i in range(3)])
        with pytest.raises(RunConflict) as concurrent:
            await rolling.submit(config.model_copy(update={"concurrency": 2}))
        assert concurrent.value.details["estimated_max_cost_usd"] == float(3 * PUZZLE_WORST)
        assert calls == []
        state = await rolling.submit(config)
        await state.task
    assert state.snapshot.status == "completed"
    assert all(t.status == "solved" for t in state.snapshot.trials)
    assert len(calls) == 12
    assert state.execution_config["live_admission"] == "rolling"


async def test_rolling_run_stops_before_a_puzzle_it_cannot_cover(settings):
    settings = replace(settings, max_spend_usd=1.0, live_admission="rolling")
    calls = []
    # The first call reports $0.60; after puzzle 1, $0.397 remains < $0.4709018.
    async with httpx.AsyncClient(transport=solving_transport(calls, costs=[0.6])) as client:
        service = live_service(settings, client)
        service.add_puzzles([puzzle(f"pz_{i}") for i in range(3)])
        state = await service.submit(RunConfig(puzzle_ids=["pz_0", "pz_1", "pz_2"]))
        await state.task
    assert state.snapshot.status == "failed"
    trials = state.snapshot.trials
    assert [t.status for t in trials[:4]] == ["solved"] * 4
    for trial in trials[4:]:
        assert trial.status == "error" and trial.moves_used == 0
        assert trial.error.code == "conflict"
        assert trial.error.message == "Remaining live budget does not cover the next puzzle"
    assert len(calls) == 4  # Puzzle 2 made no request and reserved nothing.
    ledger = service.ledger
    assert ledger.live_calls == 4 and ledger.spent_usd == Decimal("0.603")
    assert ledger.remaining < ROLLING_NEED
    assert ledger.spent_usd <= Decimal("1.0")
    errors = [e for e in state.log.events if e.type == "error"]
    assert [e.data["code"] for e in errors] == ["conflict"]


async def test_sequential_runs_start_puzzles_in_order_with_nothing_in_flight(settings):
    settings = replace(settings, live_admission="rolling")
    calls = []
    async with httpx.AsyncClient(transport=solving_transport(calls)) as client:
        service = live_service(settings, client)
        service.add_puzzles([puzzle(f"pz_{i}") for i in range(3)])
        state = await service.submit(RunConfig(puzzle_ids=["pz_0", "pz_1", "pz_2"]))
        await state.task
    order = [(e.type, e.trial_id) for e in state.log.events if e.type.startswith("trial_")]
    expected = []
    for trial in state.snapshot.trials:  # Puzzle-major: every model of puzzle 1 first.
        expected += [("trial_started", trial.trial_id), ("trial_finished", trial.trial_id)]
    assert order == expected
    assert [t.puzzle_id for t in state.snapshot.trials] == [
        f"pz_{i}" for i in range(3) for _ in range(4)
    ]


async def test_session_admission_full_refuses_512_and_rolling_admits(settings):
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        full = manager(settings, client)
        assert full._required_estimate() == 6 * PUZZLE_WORST
        assert not full.info().sources.live
        with pytest.raises(SessionError) as refused:
            await full.submit(BenchmarkSessionRequest(source="live", confirm_cost=True))
        assert refused.value.details["reason"] == "budget"
        assert refused.value.details["estimated_max_cost_usd"] == float(6 * PUZZLE_WORST)
        rolling = manager(replace(settings, live_admission="rolling"), client)
        assert rolling._required_estimate() == ROLLING_NEED
        assert rolling.info().sources.live
        rolling._live_checks()  # Raises on any refusal; no network involved.


async def test_rolling_session_admission_still_refuses_below_one_puzzle(settings):
    spend(settings, 1.55)  # Remaining $0.45 < $0.4709018.
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(replace(settings, live_admission="rolling"), client)
        assert not mgr.info().sources.live
        with pytest.raises(SessionError) as refused:
            await mgr.submit(BenchmarkSessionRequest(source="live", confirm_cost=True))
    assert refused.value.details["reason"] == "budget"
    assert refused.value.details["estimated_max_cost_usd"] == float(ROLLING_NEED)


@pytest.mark.parametrize(
    "mode,spent,reasons",
    [
        ("full", 1.0, ["budget"]),  # 5 puzzles ($2.105) > $1.00 remaining.
        ("rolling", 1.0, []),  # One puzzle + margin ($0.471) <= $1.00.
        ("rolling", 1.55, ["budget"]),  # $0.45 remaining < $0.471.
    ],
)
async def test_next_step_budget_gate_uses_the_admission_rule(settings, mode, spent, reasons):
    settings = replace(settings, live_admission=mode)
    spend(settings, spent)
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client)
        puzzles = [puzzle(f"pz_{i}") for i in range(6)]
        mgr.service.add_puzzles(puzzles)
        warmup = mgr.service.create(RunConfig(puzzle_ids=["pz_0"]))
        warmup.snapshot.status = "completed"
        primary = mgr.service.create(RunConfig(puzzle_ids=[p.puzzle_id for p in puzzles[1:]]))
        gate = mgr.gate(
            BenchmarkSessionRun(
                step="warmup", suite="warmup", run_id=warmup.snapshot.run_id, status="completed"
            ),
            BenchmarkSessionRun(
                step="primary", suite="primary", run_id=primary.snapshot.run_id, status="queued"
            ),
        )
    assert gate.reasons == reasons and gate.passed == (not reasons)


async def test_rolling_session_at_cap_512_records_with_timeout_override(settings):
    custom = replace(settings, live_admission="rolling", benchmark_timeout_s=20)
    transport = LiveTransport()
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        mgr = manager(custom, client)
        transport.mgr = mgr
        assert mgr.info().sources.live
        state = await complete(mgr, source="live", confirm_cost=True, include_extension=False)
    assert state.snapshot.status == "completed" and state.snapshot.stop_reason is None
    assert all(step.gate.passed and step.gate.reasons == [] for step in state.snapshot.runs)
    recording = RecordingFile.model_validate_json(settings.recording_path.read_text())
    for run in recording.runs:
        assert run.snapshot.config.timeout_s == 20
        assert run.execution_config["timeout_s"] == 20
        assert run.execution_config["live_admission"] == "rolling"
        assert run.execution_config["chat_max_tokens"] == 512
    assert SpendLedger(custom).spent_usd <= Decimal("2.0")


class ChargePrimaryPuzzleOne(LiveTransport):
    """One expensive answer inside the first primary puzzle, everything else cheap."""

    def __init__(self, charge):
        super().__init__()
        self.charge = charge
        self.charged = False
        self.states = []

    def __call__(self, request):
        self.cost = 0.00001
        if request.method == "POST":
            body = json.loads(request.content)
            state = (body.get("state") or json.loads(body["messages"][1]["content"]))[
                "cube_facelets"
            ]
            self.states.append(state)
            session = self.mgr.active()
            primary = self.mgr.service.runs[session.snapshot.runs[1].run_id]
            first = self.mgr.service.puzzles[primary.snapshot.config.puzzle_ids[0]]
            path, facelets = set(), first.facelets
            for move in [inverse(m) for m in reversed(first.scramble_moves)]:
                path.add(facelets)
                facelets = apply_move(facelets, move)
            if state in path and not self.charged:
                self.charged, self.cost = True, self.charge
        return super().__call__(request)


async def test_rolling_session_stops_mid_primary_without_recording(settings):
    custom = replace(settings, live_admission="rolling", max_spend_usd=0.6)
    transport = ChargePrimaryPuzzleOne(charge=0.2)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        mgr = manager(custom, client)
        transport.mgr = mgr
        state = await complete(mgr, source="live", confirm_cost=True, include_extension=False)
    warmup, primary = state.snapshot.runs
    assert warmup.status == "completed" and warmup.gate.passed  # $0.6 covered one puzzle.
    assert primary.status == "failed" and primary.gate.reasons == ["run_aborted"]
    assert state.snapshot.status == "failed" and state.snapshot.stop_reason == "gate"
    assert not settings.recording_path.exists()
    run = mgr.service.runs[primary.run_id]
    first = run.snapshot.config.puzzle_ids[0]
    for trial in run.snapshot.trials:
        if trial.puzzle_id == first:
            assert trial.status == "solved"
        else:
            assert trial.error.message == "Remaining live budget does not cover the next puzzle"
            assert trial.moves_used == 0
    later = {
        p.facelets
        for pid, p in mgr.service.puzzles.items()
        if pid in run.snapshot.config.puzzle_ids[1:]
    }
    assert not later & set(transport.states)  # No request for any later puzzle.
    ledger = SpendLedger(custom)
    assert ledger.spent_usd <= Decimal("0.6") and ledger.remaining < ROLLING_NEED


async def test_plan_timeout_above_cap_is_refused_before_network(settings):
    custom = replace(settings, live_admission="rolling", benchmark_timeout_s=20, max_timeout_s=18)
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(custom, client)
        assert not mgr.info().sources.live
        with pytest.raises(SessionError) as refused:
            await mgr.submit(BenchmarkSessionRequest(source="live", confirm_cost=True))
    assert refused.value.status == 422 and refused.value.details == {"field": "timeout_s"}


async def test_simulated_plan_uses_the_configured_timeout(settings):
    custom = replace(settings, mock_models=True, benchmark_timeout_s=20)
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(custom, client)
        state = await complete(mgr, source="simulated", speed=20, include_extension=False)
    assert state.snapshot.status == "completed"
    assert {mgr.service.runs[r.run_id].snapshot.config.timeout_s for r in state.snapshot.runs} == {
        20
    }


def test_launcher_values_are_valid_settings_and_hold_no_key(monkeypatch):
    import re
    from pathlib import Path

    script = (Path(__file__).parents[1] / "scripts" / "run_live_session.ps1").read_text()
    table = script.split("$overrides = [ordered]@{", 1)[1].split("}", 1)[0]
    values = dict(re.findall(r"^\s*(\w+)\s*=\s*'([^']*)'", table, re.MULTILINE))
    assert values == {
        "MOCK_MODELS": "false",
        "MAX_SPEND_USD": "2.00",
        "CHAT_MAX_TOKENS": "512",
        "ALLOW_LIVE_RERUN": "true",
        "LIVE_ADMISSION": "rolling",
        "EXPECTED_COST_WARMUP": "0.29",
        "EXPECTED_COST_PRIMARY": "1.41",
        "BENCHMARK_TIMEOUT_S": "20",
    }
    assert "OPUS_TRUNCATION_GATE  = $OpusTruncationGate" in table
    assert "[string]$OpusTruncationGate = 'report'" in script
    assert "OPENROUTER_API_KEY" not in table and "sk-or" not in script
    assert "-LocalPort 8000" in script and "throw 'Port 8000 is already in use" in script
    monkeypatch.setattr("app.config.load_dotenv", lambda *a, **kw: None)
    for name, value in {**values, "OPUS_TRUNCATION_GATE": "report"}.items():
        monkeypatch.setenv(name, value)
    parsed = Settings.from_env()
    assert (parsed.chat_max_tokens, parsed.max_spend_usd, parsed.chat_reasoning_effort) == (
        512,
        2.0,
        "low",
    )
    assert (parsed.live_admission, parsed.benchmark_timeout_s) == ("rolling", 20)
    assert parsed.benchmark_timeout_s <= parsed.max_timeout_s
    # The launch arithmetic: each gate threshold covers that step's modeled worst case.
    ledger_floor = Decimal("0.422996442")  # Per puzzle at the live ledger's high-water inputs.
    assert Decimal("1.5") * Decimal(values["EXPECTED_COST_WARMUP"]) >= ledger_floor
    assert Decimal("1.5") * Decimal(values["EXPECTED_COST_PRIMARY"]) >= 5 * ledger_floor
