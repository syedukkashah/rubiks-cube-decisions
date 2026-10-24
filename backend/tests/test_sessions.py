import asyncio
import json
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import httpx
import jsonschema
import pytest
import yaml
from fastapi.testclient import TestClient
from test_guardrails import puzzle as simple_puzzle

from app.adapters.factory import real_adapter
from app.adapters.registry import ModelRegistry
from app.budget import SpendLedger
from app.config import CHAT_MODEL, Settings
from app.engine import apply_move, inverse
from app.main import create_app
from app.recording import RecordingFile
from app.runner.service import BenchmarkService
from app.schemas import (
    BenchmarkInfo,
    BenchmarkSession,
    BenchmarkSessionRequest,
    BenchmarkSessionRun,
    RunConfig,
)
from app.sessions import SessionError, SessionManager
from app.stats import compute_stats
from app.storage import RunStore


@pytest.fixture
def settings(tmp_path):
    return Settings(
        chat_max_tokens=128,  # An affordable calibrated configuration for live mock transports.
        runs_dir=tmp_path / "runs",
        spend_ledger_path=tmp_path / "ledger.jsonl",
        recording_path=tmp_path / "recordings" / "benchmark.json",
    )


async def instant_sleep(seconds):
    await asyncio.sleep(0)


def deny_network(request):
    raise AssertionError("Simulation/replay must not make any HTTP request")


def manager(settings, client, sleep=instant_sleep):
    service = BenchmarkService(
        lambda model, puzzle: real_adapter(model, client, settings),
        settings.api_key,
        settings,
        None if settings.mock_models else SpendLedger(settings),
        RunStore(settings.runs_dir),
    )
    return SessionManager(service, ModelRegistry(client, settings.mock_models), sleep=sleep)


def metrics(state, service):
    return [
        compute_stats(service.runs[r.run_id].snapshot).model_dump(exclude={"run_id"})
        for r in state.snapshot.runs
        if r.status != "skipped"
    ]


async def complete(mgr, **request):
    state = await mgr.submit(BenchmarkSessionRequest(**request))
    await state.task
    return state


@pytest.mark.asyncio
async def test_auto_simulates_deterministic_personas_and_sequential_runs(settings):
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client)
        assert mgr.info().auto_source == "simulated"
        first = await complete(mgr, speed=20)
        second = await complete(mgr, source="simulated", speed=2)
    assert first.snapshot.source == "simulated" and first.snapshot.status == "completed"
    assert len(first.snapshot.runs) == 3
    assert metrics(first, mgr.service) == metrics(second, mgr.service)
    trials = [t for r in first.snapshot.runs for t in mgr.service.runs[r.run_id].snapshot.trials]
    assert {t.status for t in trials} >= {"solved", "move_limit"}
    assert any(t.invalid_move_count and t.retry_count for t in trials)
    assert any(m.confidence is not None for t in trials for m in t.moves)
    assert any(t.optimality_gap and t.optimality_gap > 0 for t in trials)
    assert all(r.gate is None for r in first.snapshot.runs)
    assert first.snapshot.stop_reason is None and first.snapshot.total_cost_usd is None
    for before, after in zip(first.snapshot.runs, first.snapshot.runs[1:]):
        assert (
            mgr.service.runs[before.run_id].snapshot.finished_at
            <= mgr.service.runs[after.run_id].snapshot.started_at
        )
    assert not settings.spend_ledger_path.exists() and not settings.recording_path.exists()


async def test_simulated_speed_changes_sleep_not_reported_metrics(settings):
    delays = []

    async def clock(seconds):
        delays.append(seconds)
        await asyncio.sleep(0)

    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client, clock)
        first = await complete(mgr, source="simulated", speed=1, include_extension=False)
        at_one = delays[:]
        delays.clear()
        second = await complete(mgr, source="simulated", speed=4, include_extension=False)
    assert len(first.snapshot.runs) == 2
    assert delays == [value / 4 for value in at_one]
    assert metrics(first, mgr.service) == metrics(second, mgr.service)


async def test_sessions_are_queued_upfront_and_cancel_all(settings):
    entered = asyncio.Event()

    async def block(seconds):
        entered.set()
        await asyncio.Event().wait()

    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client, block)
        state = await mgr.submit(BenchmarkSessionRequest())
        assert all(
            mgr.service.runs[r.run_id].snapshot.status == "queued" for r in state.snapshot.runs
        )
        with pytest.raises(SessionError) as exc:
            await mgr.submit(BenchmarkSessionRequest())
        assert exc.value.details == {"active_session_id": state.snapshot.session_id}
        await entered.wait()
        await mgr.cancel(state)
        assert state.snapshot.status == "cancelled"
        assert all(r.status == "cancelled" for r in state.snapshot.runs)
        assert all(
            mgr.service.runs[r.run_id].log.events[-1].type == "run_finished"
            for r in state.snapshot.runs
        )
        with pytest.raises(SessionError) as exc:
            await mgr.cancel(state)
        assert exc.value.status == 409
    assert not settings.recording_path.exists()


@pytest.mark.parametrize(
    "body,status,reason",
    [
        ({"source": "live"}, 422, None),
        ({"source": "live", "confirm_cost": True}, 409, "mock_mode"),
        ({"source": "replay"}, 409, "no_recording"),
        ({"speed": 0.24}, 422, None),
        ({"speed": 21}, 422, None),
        ({"speed": True}, 422, None),
        ({"confirm_cost": "true"}, 422, None),
        ({"unexpected": True}, 422, None),
    ],
)
def test_session_api_refusals(settings, body, status, reason):
    with TestClient(create_app(settings, transport=httpx.MockTransport(deny_network))) as client:
        result = client.post("/api/v1/benchmark/sessions", json=body)
        assert result.status_code == status
        if reason:
            assert result.json()["error"]["details"]["reason"] == reason
        assert client.get("/api/v1/benchmark/sessions/missing").status_code == 404
        assert client.post("/api/v1/benchmark/sessions/missing/cancel").status_code == 404


def test_info_and_cancel_api_match_contract(settings):
    with TestClient(create_app(settings, transport=httpx.MockTransport(deny_network))) as client:
        info = client.get("/api/v1/benchmark").json()
        BenchmarkInfo.model_validate(info)
        assert info["sources"] == {"simulated": True, "live": False, "replay": False}
        response = client.post("/api/v1/benchmark/sessions", json={"speed": 20})
        assert response.status_code == 202
        session = BenchmarkSession.model_validate(response.json())
        assert len(session.runs) == 3
        for step in session.runs:
            assert client.get(f"/api/v1/runs/{step.run_id}").status_code == 200
        url = f"/api/v1/benchmark/sessions/{session.session_id}"
        assert client.get(url).status_code == 200
        assert client.post(url + "/cancel").json()["status"] == "cancelled"
        assert client.post(url + "/cancel").status_code == 409


def test_live_requires_key_and_budget_before_network(settings):
    for custom, status, reason in [
        (replace(settings, mock_models=False), 503, None),
        (
            replace(settings, mock_models=False, api_key="test-key", max_spend_usd=0.5),
            409,
            "budget",
        ),
        (replace(settings, mock_models=False, api_key="test-key", max_timeout_s=10), 422, None),
    ]:
        with TestClient(create_app(custom, transport=httpx.MockTransport(deny_network))) as client:
            assert not client.get("/api/v1/benchmark").json()["sources"]["live"]
            result = client.post(
                "/api/v1/benchmark/sessions", json={"source": "live", "confirm_cost": True}
            )
            assert result.status_code == status
            if reason:
                assert result.json()["error"]["details"]["reason"] == reason


class LiveTransport:
    """Actual HTTP adapters and ledger, with all provider responses kept offline."""

    def __init__(self, cost=0.00001, failure=None):
        self.mgr = None
        self.calls = []
        self.cost = cost
        self.failure = failure

    def __call__(self, request):
        self.calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"data": {"endpoints": [{}]}})
        body = json.loads(request.content)
        if self.failure:
            failed = self.failure(body)
            if failed is not None:
                return failed
        state = body.get("state") or json.loads(body["messages"][1]["content"])
        # Invert the known fixed scramble; no substitution in the production live adapter.
        moves_by_state = {}
        for puzzle in self.mgr.service.puzzles.values():
            facelets = puzzle.facelets
            for move in [inverse(m) for m in reversed(puzzle.scramble_moves)]:
                moves_by_state[facelets] = move
                facelets = apply_move(facelets, move)
        move = moves_by_state[state["cube_facelets"]]
        payload = {
            "usage": {
                "prompt_tokens": 200,
                "completion_tokens": 32,
                "completion_tokens_details": {"reasoning_tokens": 20},
                "cost": self.cost,
            }
        }
        if body["model"] == CHAT_MODEL:
            payload["choices"] = [
                {"finish_reason": "stop", "message": {"content": json.dumps({"move": move})}}
            ]
        else:
            payload["answers"] = {
                "next_move": {"type": "choice", "choice": move, "confidence": 0.8}
            }
        return httpx.Response(200, json=payload)


async def record_live(settings, *, include_extension=True, failure=None, cost=0.00001):
    settings = replace(settings, mock_models=False, api_key="private-test-key")
    transport = LiveTransport(failure=failure, cost=cost)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        mgr = manager(settings, client)
        transport.mgr = mgr
        assert mgr.info().sources.live
        state = await complete(
            mgr, source="live", confirm_cost=True, include_extension=include_extension
        )
    return mgr, state, transport


async def test_live_records_atomic_evidence_and_replay_is_exact(settings, monkeypatch):
    import app.storage as storage

    replacements = []
    original = storage.os.replace

    def replace_file(source, target):
        if target == settings.recording_path:
            replacements.append(source)
            RecordingFile.model_validate_json(source.read_text())
        return original(source, target)

    monkeypatch.setattr(storage.os, "replace", replace_file)
    live_mgr, live, transport = await record_live(settings)
    assert live.snapshot.status == "completed" and live.snapshot.stop_reason is None
    assert all(
        trial.status == "solved"
        for step in live.snapshot.runs
        for trial in live_mgr.service.runs[step.run_id].snapshot.trials
    )
    assert all(r.gate.passed for r in live.snapshot.runs)
    assert len(replacements) == 1 and not replacements[0].exists()
    recording_before = settings.recording_path.read_bytes()
    assert b"private-test-key" not in recording_before and b"Authorization" not in recording_before
    assert b'"messages"' not in recording_before and b'"headers"' not in recording_before
    assert any(r.method == "POST" for r in transport.calls)
    ledger_before = settings.spend_ledger_path.read_bytes()
    delays = []

    async def clock(seconds):
        delays.append(seconds)
        await asyncio.sleep(0)

    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        replay_mgr = manager(settings, client, clock)
        assert replay_mgr.info().auto_source == "replay"
        assert (
            replay_mgr.get(live.snapshot.session_id).snapshot.total_cost_usd
            == live.snapshot.total_cost_usd
        )
        assert replay_mgr.info().recording.total_cost_usd == live.snapshot.total_cost_usd
        replay = await complete(replay_mgr, speed=20)
        assert replay.snapshot.status == "completed" and replay.snapshot.source == "replay"
        assert replay.snapshot.replay_of_session_id == live.snapshot.session_id
        assert replay.snapshot.recorded_at == replay_mgr.info().recording.recorded_at
        assert replay.snapshot.total_cost_usd is None and replay.snapshot.stop_reason is None
        assert all(r.gate is None for r in replay.snapshot.runs)
        assert metrics(replay, replay_mgr.service) == metrics(live, live_mgr.service)
        expected_delays = []
        previous_end = None
        for recorded in live_mgr.recording.runs:
            stamps = [datetime.fromisoformat(e.ts) for e in recorded.events]
            gap = max(0, (stamps[0] - previous_end).total_seconds()) / 20 if previous_end else 0
            expected_delays.extend(
                [gap, *[max(0, (b - a).total_seconds()) / 20 for a, b in zip(stamps, stamps[1:])]]
            )
            previous_end = stamps[-1]
        assert delays == expected_delays
        for old, new in zip(live.snapshot.runs, replay.snapshot.runs, strict=True):
            a, b = live_mgr.service.runs[old.run_id], replay_mgr.service.runs[new.run_id]
            assert old.run_id != new.run_id
            assert set(a.snapshot.config.puzzle_ids).isdisjoint(b.snapshot.config.puzzle_ids)
            assert [e.type for e in a.log.events] == [e.type for e in b.log.events]
            assert [e.seq for e in b.log.events] == list(range(1, b.snapshot.last_seq + 1))
            assert [m.model_dump() for t in a.snapshot.trials for m in t.moves] == [
                m.model_dump() for t in b.snapshot.trials for m in t.moves
            ]
    assert settings.recording_path.read_bytes() == recording_before
    assert settings.spend_ledger_path.read_bytes() == ledger_before


async def test_recording_exists_guard_and_missing_extension_replay(settings):
    live_mgr, live, _ = await record_live(settings, include_extension=False)
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(live_mgr.settings, client)
        assert not mgr.info().sources.live
        with pytest.raises(SessionError) as exc:
            await mgr.submit(BenchmarkSessionRequest(source="live", confirm_cost=True))
        assert exc.value.details["reason"] == "recording_exists"
        replay = await complete(mgr)
        assert replay.snapshot.runs[-1].status == "skipped"
        assert replay.snapshot.status == "completed"
        assert metrics(replay, mgr.service) == metrics(live, live_mgr.service)


@pytest.mark.parametrize("status", [401, 402])
async def test_failed_live_session_never_records(settings, status):
    mgr, state, transport = await record_live(settings, failure=lambda _: httpx.Response(status))
    assert state.snapshot.status == "failed" and state.snapshot.stop_reason == "gate"
    assert state.snapshot.runs[0].gate.reasons == ["run_aborted"]
    assert [r.status for r in state.snapshot.runs] == ["failed", "cancelled", "cancelled"]
    assert len([r for r in transport.calls if r.method == "POST"]) == 1
    assert not settings.recording_path.exists()


async def test_auto_with_funded_key_still_never_calls_provider_or_ledger(settings):
    settings = replace(settings, mock_models=False, api_key="private-test-key")
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client)
        assert mgr.info().sources.live
        state = await complete(mgr, include_extension=False)
        assert state.snapshot.source == "simulated" and state.snapshot.status == "completed"
    assert not settings.spend_ledger_path.exists()
    assert not settings.recording_path.exists()


@pytest.mark.parametrize("finish,content", [("length", '{"move":"R"}'), ("stop", "")])
async def test_live_gate_tracks_truncation_and_empty_content(settings, finish, content):
    def fail_opus(body):
        if body["model"] == CHAT_MODEL:
            return httpx.Response(
                200,
                json={
                    "usage": {"cost": 0.00001},
                    "choices": [{"finish_reason": finish, "message": {"content": content}}],
                },
            )
        return None

    _, state, _ = await record_live(settings, failure=fail_opus)
    gate = state.snapshot.runs[0].gate
    assert gate.reasons == ["opus_truncation"] and gate.opus_truncation_pct == 100
    assert state.snapshot.status == "failed" and not settings.recording_path.exists()


async def test_extension_budget_gate_skips_and_records_required_steps(settings):
    settings = replace(settings, expected_cost_warmup=1, expected_cost_primary=1)
    mgr, state, _ = await record_live(settings, cost=0.009)
    assert state.snapshot.status == "completed" and state.snapshot.stop_reason == "gate"
    assert state.snapshot.runs[1].gate.reasons == ["budget"]
    assert state.snapshot.runs[2].status == "skipped"
    assert len(mgr.recording.runs) == 2


async def test_failed_explicit_rerun_preserves_recording(settings):
    await record_live(settings, include_extension=False)
    before = settings.recording_path.read_bytes()
    _, state, _ = await record_live(
        replace(settings, allow_live_rerun=True), failure=lambda _: httpx.Response(401)
    )
    assert state.snapshot.status == "failed"
    assert settings.recording_path.read_bytes() == before


async def test_cancel_live_keeps_reservation_but_never_records(settings):
    settings = replace(settings, mock_models=False, api_key="private-test-key")
    entered = asyncio.Event()

    async def blocked(request):
        if request.method == "GET":
            return httpx.Response(200, json={"data": {"endpoints": [{}]}})
        entered.set()
        await asyncio.Event().wait()

    async with httpx.AsyncClient(transport=httpx.MockTransport(blocked)) as client:
        mgr = manager(settings, client)
        state = await mgr.submit(BenchmarkSessionRequest(source="live", confirm_cost=True))
        await entered.wait()
        await mgr.cancel(state)
    assert state.snapshot.status == "cancelled"
    assert all(r.status == "cancelled" for r in state.snapshot.runs)
    assert state.snapshot.total_cost_usd > 0
    assert not settings.recording_path.exists()


async def test_replay_cancel_via_existing_run_endpoint_semantics(settings):
    await record_live(settings, include_extension=False)
    before = settings.spend_ledger_path.read_bytes()
    entered = asyncio.Event()

    async def block(seconds):
        entered.set()
        await asyncio.Event().wait()

    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client, block)
        state = await mgr.submit(BenchmarkSessionRequest(source="replay"))
        await entered.wait()
        await mgr.service.cancel(mgr.service.runs[state.snapshot.runs[0].run_id])
        await state.task
    assert state.snapshot.status == "cancelled"
    assert [r.status for r in state.snapshot.runs] == ["cancelled", "cancelled", "skipped"]
    assert settings.spend_ledger_path.read_bytes() == before


async def test_interrupted_session_reloads_without_execution_or_writes(settings):
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client)
        state = await mgr.submit(BenchmarkSessionRequest())
        state.task.cancel()
        await asyncio.gather(state.task, return_exceptions=True)
        before = {p: p.read_bytes() for p in settings.runs_dir.rglob("*.json")}
        restored = manager(settings, client)
        loaded = restored.get(state.snapshot.session_id)
    assert loaded.snapshot.status == "failed" and loaded.task is None
    assert all(r.status == "failed" for r in loaded.snapshot.runs)
    assert all(p.read_bytes() == contents for p, contents in before.items())


def test_new_api_responses_validate_against_openapi(settings):
    contract = Path(__file__).resolve().parents[2] / "contract"
    document = yaml.safe_load((contract / "openapi.yaml").read_text(encoding="utf-8"))

    def validate(value, schema):
        jsonschema.Draft202012Validator(
            {"$ref": f"#/components/schemas/{schema}", "components": document["components"]},
            format_checker=jsonschema.FormatChecker(),
        ).validate(value)

    with TestClient(create_app(settings, transport=httpx.MockTransport(deny_network))) as client:
        validate(client.get("/api/v1/benchmark").json(), "BenchmarkInfo")
        session = client.post("/api/v1/benchmark/sessions", json={}).json()
        validate(session, "BenchmarkSession")
        validate(
            client.get(f"/api/v1/benchmark/sessions/{session['session_id']}").json(),
            "BenchmarkSession",
        )
        validate(
            client.post(f"/api/v1/benchmark/sessions/{session['session_id']}/cancel").json(),
            "BenchmarkSession",
        )
    for name in ("benchmark_session.json", "benchmark_session_gate_stop.json"):
        validate(json.loads((contract / "fixtures" / name).read_text()), "BenchmarkSession")


@pytest.mark.parametrize("name,expected", [("warmup", "failed"), ("primary", "completed")])
async def test_gate_stop_rules(settings, name, expected):
    settings = replace(settings, **{"expected_cost_" + name: 0})
    mgr, state, _ = await record_live(settings)
    assert state.snapshot.status == expected and state.snapshot.stop_reason == "gate"
    step = next(r for r in state.snapshot.runs if r.step == name)
    assert step.gate.reasons == ["cost_over_expected"]
    if name == "warmup":
        assert [r.status for r in state.snapshot.runs] == ["completed", "cancelled", "cancelled"]
        assert not settings.recording_path.exists()
    else:
        assert [r.status for r in state.snapshot.runs] == ["completed", "completed", "skipped"]
        assert settings.recording_path.exists()
        assert len(mgr.recording.runs) == 2


@pytest.mark.parametrize(
    "reason", ["cost_over_expected", "opus_truncation", "run_aborted", "budget", None]
)
async def test_each_gate_in_isolation(settings, reason):
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client)
        puzzles = [simple_puzzle(f"pz_{i}") for i in range(6)]
        mgr.service.add_puzzles(puzzles)
        warmup = mgr.service.create(RunConfig(puzzle_ids=[puzzles[0].puzzle_id]))
        primary = mgr.service.create(RunConfig(puzzle_ids=[p.puzzle_id for p in puzzles[1:]]))
        warmup.snapshot.status = "completed"
        mgr.service.ledger = SpendLedger(settings)
        step = BenchmarkSessionRun(
            step="warmup", suite="warmup", run_id=warmup.snapshot.run_id, status="completed"
        )
        following = BenchmarkSessionRun(
            step="primary", suite="primary", run_id=primary.snapshot.run_id, status="queued"
        )
        run = mgr.service.runs[step.run_id]
        run.call_metrics = [
            {"model_id": CHAT_MODEL, "finish_reason": "stop", "empty_content": False}
            for _ in range(5)
        ]
        if reason == "cost_over_expected":
            mgr.service.ledger.rows = [
                {"run_id": step.run_id, "model_id": CHAT_MODEL, "cost_usd": 0.046}
            ]
        elif reason == "opus_truncation":
            run.call_metrics[0]["finish_reason"] = "length"
            run.call_metrics[1]["empty_content"] = True
        elif reason == "run_aborted":
            run.snapshot.status = "failed"
        elif reason == "budget":
            mgr.service.ledger.rows = [
                {"run_id": "previous", "model_id": CHAT_MODEL, "cost_usd": 0.4}
            ]
        else:
            run.call_metrics[0]["finish_reason"] = "length"  # Exactly 20% passes.
            mgr.service.ledger.rows = [
                {"run_id": step.run_id, "model_id": CHAT_MODEL, "cost_usd": 0.045}
            ]  # Exactly 1.5x passes.
        gate = mgr.gate(step, following)
        assert gate.reasons == ([reason] if reason else [])
        assert gate.passed == (reason is None)
        assert gate.opus_truncation_pct == (
            40 if reason == "opus_truncation" else 20 if reason is None else 0
        )


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf"), "bad"])
def test_expected_cost_settings_reject_invalid(value):
    with pytest.raises(ValueError, match="EXPECTED_COST_PRIMARY"):
        Settings(expected_cost_primary=value)


def test_expected_cost_env_and_recording_path(settings, monkeypatch):
    monkeypatch.setattr("app.config.load_dotenv", lambda *a, **kw: None)
    monkeypatch.setenv("EXPECTED_COST_WARMUP", "0.02")
    monkeypatch.setenv("EXPECTED_COST_PRIMARY", "0.3")
    monkeypatch.setenv("EXPECTED_COST_EXTENSION", "0.1")
    monkeypatch.setenv("RECORDING_PATH", str(settings.recording_path))
    parsed = Settings.from_env()
    assert (
        parsed.expected_cost_warmup,
        parsed.expected_cost_primary,
        parsed.expected_cost_extension,
    ) == (0.02, 0.3, 0.1)
    assert parsed.recording_path == settings.recording_path


async def test_shutdown_fails_active_session_without_resuming(settings):
    entered = asyncio.Event()

    async def block(seconds):
        entered.set()
        await asyncio.Event().wait()

    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(settings, client, block)
        state = await mgr.submit(BenchmarkSessionRequest())
        await entered.wait()
        await mgr.close()
        restored = manager(settings, client)
        saved = restored.get(state.snapshot.session_id)
        assert saved.snapshot.status == "failed"
        for step in saved.snapshot.runs:
            assert step.status == "failed"
            run = restored.service.runs[step.run_id]
            assert run.task is None and run.snapshot.status == "failed"
            assert all(
                t.error.code == "internal_error" and t.error.message == "interrupted by restart"
                for t in run.snapshot.trials
            )


async def test_live_session_guards_existing_runs_before_network(settings):
    live_mgr, live, _ = await record_live(settings, include_extension=False)
    settings.recording_path.unlink()  # Only this test's temporary recording.
    async with httpx.AsyncClient(transport=httpx.MockTransport(deny_network)) as client:
        mgr = manager(live_mgr.settings, client)
        with pytest.raises(SessionError) as duplicate:
            await mgr.submit(BenchmarkSessionRequest(source="live", confirm_cost=True))
        assert duplicate.value.details["duplicate_of_run_id"] == live.snapshot.runs[0].run_id
        assert not mgr.info().sources.live
        active = mgr.service.create(mgr.service.runs[live.snapshot.runs[0].run_id].snapshot.config)
        assert not mgr.info().sources.live
        with pytest.raises(SessionError) as blocked:
            await mgr.submit(BenchmarkSessionRequest(source="live", confirm_cost=True))
        assert blocked.value.details["reason"] == "active_run"
        assert blocked.value.details["active_run_id"] == active.snapshot.run_id
