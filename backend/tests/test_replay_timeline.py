from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.engine import SOLVED, apply_move
from app.recording import RecordedRun, replay_run
from app.runner.service import BenchmarkService
from app.schemas import Event, MoveRecord, Puzzle, RunConfig, RunSnapshot, Trial
from app.stats import compute_stats
from app.storage import RunStore


def iso(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@pytest.mark.parametrize("speed", [0.25, 1, 4, 20])
async def test_replay_snapshot_and_event_clocks_share_new_timeline(tmp_path, monkeypatch, speed):
    old_origin = datetime(2020, 1, 1, tzinfo=UTC)

    def old(seconds):
        return iso(old_origin + timedelta(seconds=seconds))

    facelets = apply_move(SOLVED, "R")
    move = MoveRecord(
        index=1,
        move="R'",
        facelets_before=facelets,
        facelets_after=SOLVED,
        latency_ms=8000,
        confidence=None,
        retries=0,
    )
    trial = Trial(
        trial_id="tr_old",
        run_id="run_old",
        puzzle_id="pz_old",
        model_id="anthropic/claude-opus-5.5",
        status="solved",
        initial_facelets=facelets,
        current_facelets=SOLVED,
        moves=[move],
        moves_used=1,
        solved=True,
        optimal_distance=1,
        optimality_gap=0,
        started_at=old(3),
        finished_at=old(11),
        total_time_s=8,
    )
    original = RunSnapshot(
        run_id="run_old",
        status="completed",
        config=RunConfig(puzzle_ids=["pz_old"], model_ids=[trial.model_id]),
        created_at=old(0),
        started_at=old(2),
        finished_at=old(12),
        last_seq=6,
        trials=[trial],
    )
    script = [
        (2, "run_started", None, {"trial_count": 1}),
        (
            3,
            "trial_started",
            "tr_old",
            {"puzzle_id": "pz_old", "model_id": trial.model_id, "initial_facelets": facelets},
        ),
        (3, "move_requested", "tr_old", {"move_index": 1, "attempt": 1}),
        (11, "move_applied", "tr_old", {**move.model_dump(), "moves_used": 1, "solved": True}),
        (11, "trial_finished", "tr_old", trial.model_dump()),
        (12, "run_finished", None, {"status": "completed", "finished_at": old(12)}),
    ]
    recorded = RecordedRun(
        step="warmup",
        snapshot=original,
        events=[
            Event(seq=i, type=kind, run_id="run_old", trial_id=trial_id, ts=old(seconds), data=data)
            for i, (seconds, kind, trial_id, data) in enumerate(script, 1)
        ],
    )
    evidence_before = recorded.model_dump()
    replay_origin = datetime(2040, 6, 1, tzinfo=UTC)
    clock = replay_origin

    def now():
        return iso(clock)

    async def sleep(seconds):
        nonlocal clock
        clock += timedelta(seconds=seconds)

    monkeypatch.setattr("app.recording.utc_now", now)
    monkeypatch.setattr("app.runner.service.utc_now", now)
    settings = Settings(runs_dir=tmp_path / "runs")

    def no_adapter(*args):
        raise AssertionError("Replay must never invoke a model")

    store = RunStore(settings.runs_dir)
    service = BenchmarkService(no_adapter, settings=settings, store=store)
    service.add_puzzles(
        [
            Puzzle(
                puzzle_id="pz_new",
                suite="warmup",
                scramble_moves=["R"],
                facelets=facelets,
                optimal_distance=1,
                created_at=now(),
            )
        ]
    )
    state = service.create(RunConfig(puzzle_ids=["pz_new"], model_ids=[trial.model_id]), live=False)
    ids = {
        "run_old": state.snapshot.run_id,
        "tr_old": state.snapshot.trials[0].trial_id,
        "pz_old": "pz_new",
    }
    snapshots = []
    persist = state.log.on_event

    def observe():
        snapshots.append(state.snapshot.model_copy(deep=True))
        persist()

    state.log.on_event = observe
    assert state.snapshot.started_at is None and state.snapshot.finished_at is None
    assert state.snapshot.trials[0].started_at is None
    await replay_run(state, recorded, ids, speed, sleep, initial_gap=6)

    def replay(seconds):
        return iso(replay_origin + timedelta(seconds=seconds / speed))

    run = state.snapshot
    copied = run.trials[0]
    assert run.created_at == iso(replay_origin)
    assert run.started_at == replay(6) == state.log.events[0].ts
    assert run.finished_at == replay(16) == state.log.events[-1].ts
    assert copied.started_at == replay(7) == state.log.events[1].ts
    assert copied.finished_at == replay(15) == state.log.events[4].ts
    assert snapshots[1].trials[0].started_at == copied.started_at
    assert snapshots[1].trials[0].finished_at is None
    assert snapshots[4].finished_at is None
    assert state.log.events[4].data["started_at"] == copied.started_at
    assert state.log.events[4].data["finished_at"] == copied.finished_at
    assert state.log.events[5].data["finished_at"] == run.finished_at
    window = datetime.fromisoformat(copied.finished_at) - datetime.fromisoformat(copied.started_at)
    gauge = datetime.fromisoformat(state.log.events[3].ts) - datetime.fromisoformat(
        state.log.events[2].ts
    )
    assert window.total_seconds() == gauge.total_seconds() == 8 / speed
    assert copied.total_time_s == state.log.events[4].data["total_time_s"] == 8
    assert copied.moves[0].latency_ms == state.log.events[3].data["latency_ms"] == 8000
    assert compute_stats(run).model_dump(exclude={"run_id"}) == compute_stats(original).model_dump(
        exclude={"run_id"}
    )
    assert store.load("runs")[0]["snapshot"] == run.model_dump()
    assert recorded.model_dump() == evidence_before
