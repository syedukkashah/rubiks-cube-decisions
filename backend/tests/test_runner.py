import asyncio

import pytest

from app.adapters.base import MoveChoice, UpstreamFailure
from app.engine import SOLVED, apply_move
from app.runner.service import BenchmarkService
from app.schemas import MODEL_IDS, Event, Puzzle, RunConfig, utc_now
from app.stats import compute_stats


class ScriptedAdapter:
    def __init__(self, actions):
        self.actions = iter(actions)
        self.calls = []

    async def choose_move(self, state, recent_moves, allowed_moves, timeout_s):
        self.calls.append((state, recent_moves, allowed_moves, timeout_s))
        action = next(self.actions)
        if isinstance(action, Exception):
            raise action
        return MoveChoice(action, None, 5.0, str(action))


def make_service(adapter):
    service = BenchmarkService(lambda model, puzzle: adapter)
    service.puzzles["pz_test"] = Puzzle(
        puzzle_id="pz_test",
        suite="warmup",
        scramble_moves=["R"],
        facelets=apply_move(SOLVED, "R"),
        optimal_distance=1,
        created_at=utc_now(),
    )
    return service


def config(**kwargs):
    return RunConfig(puzzle_ids=["pz_test"], model_ids=[MODEL_IDS[0]], **kwargs)


async def test_invalid_retry_timeout_and_solved():
    adapter = ScriptedAdapter(["R3", None, UpstreamFailure("upstream_timeout"), "R'"])
    service = make_service(adapter)
    state = service.start(config(max_retries=3))
    await state.task
    trial = state.snapshot.trials[0]
    assert trial.status == "solved" and trial.solved
    assert trial.moves_used == 1
    assert trial.invalid_move_count == 2
    assert trial.retry_count == 3
    assert trial.timeout_count == 1
    assert trial.moves[0].retries == 3
    assert trial.optimality_gap == 0
    assert all(call[1] == [] for call in adapter.calls)
    stats = compute_stats(state.snapshot)
    assert stats.models[0].success_rate_pct == 100
    assert stats.models[0].avg_move_latency_ms == 5
    assert stats.models[0].avg_total_time_s == trial.total_time_s
    assert stats.questions_answered.fastest_is_also_best_quality is True


@pytest.mark.parametrize(
    "actions,retries,status,count",
    [
        (["R3", "R3"], 1, "error", 0),
        (["U", "U"], 0, "move_limit", 2),
        ([UpstreamFailure()], 0, "error", 0),
    ],
)
async def test_unsuccessful_terminal_states(actions, retries, status, count):
    service = make_service(ScriptedAdapter(actions))
    state = service.start(config(max_moves=2, max_retries=retries))
    await state.task
    trial = state.snapshot.trials[0]
    assert trial.status == status
    assert trial.moves_used == count
    assert trial.solved is False and trial.optimality_gap is None
    assert compute_stats(state.snapshot).models[0].success_rate_pct == 0


async def test_events_are_ordered_immutable_and_replayable():
    service = make_service(ScriptedAdapter(["U", "U'", "R'"]))
    state = service.start(config())
    await state.task
    assert [event.seq for event in state.log.events] == list(range(1, state.snapshot.last_seq + 1))
    assert state.log.events[-1].type == "run_finished"
    assert state.log.events[0].trial_id is None
    for event in state.log.events:
        Event.model_validate_json(event.model_dump_json())
    replay = [message async for message in state.log.stream(3)]
    assert replay[0].startswith("id: 4\n")
    assert len(replay) == state.snapshot.last_seq - 3
    assert [message async for message in state.log.stream(state.snapshot.last_seq)] == []
    assert state.log.events[1].data["initial_facelets"] != SOLVED


async def test_history_window():
    adapter = ScriptedAdapter(["U", "U'", "R'"])
    service = make_service(adapter)
    state = service.start(config(history_window=1))
    await state.task
    assert [call[1] for call in adapter.calls] == [[], ["U"], ["U'"]]


async def test_enforced_timeout_and_cancellation():
    entered = asyncio.Event()

    class WaitingAdapter:
        async def choose_move(self, *args):
            entered.set()
            await asyncio.Event().wait()

    service = make_service(WaitingAdapter())
    timed = service.start(config(timeout_s=0.01, max_retries=1))
    await timed.task
    trial = timed.snapshot.trials[0]
    assert trial.timeout_count == 2 and trial.retry_count == 1
    assert trial.error.code == "upstream_timeout"
    entered.clear()
    cancelled = service.start(config())
    await entered.wait()
    await service.cancel(cancelled)
    assert cancelled.snapshot.status == "cancelled"
    assert cancelled.snapshot.trials[0].error.code == "conflict"
    assert cancelled.log.events[-1].type == "run_finished"


async def test_queued_cancellation():
    service = make_service(ScriptedAdapter([]))
    state = service.start(config())
    await service.cancel(state)
    assert state.snapshot.trials[0].status == "error"
    assert state.snapshot.trials[0].started_at is None
    assert state.log.events[-1].data["status"] == "cancelled"
