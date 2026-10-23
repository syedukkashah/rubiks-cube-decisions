import asyncio
import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter
from uuid import uuid4

from app.adapters.base import Adapter, UpstreamFailure, scrub
from app.engine import MOVES, apply_move, is_solved
from app.runner.events import EventLog
from app.schemas import ErrorInfo, MoveRecord, Puzzle, RunConfig, RunSnapshot, Trial, utc_now

logger = logging.getLogger(__name__)
TERMINAL_TRIALS = {"solved", "move_limit", "error"}
TERMINAL_RUNS = {"completed", "cancelled", "failed"}


def new_id(prefix: str) -> str:
    return prefix + "_" + uuid4().hex


@dataclass
class RunState:
    snapshot: RunSnapshot
    log: EventLog
    task: asyncio.Task | None = None


class BenchmarkService:
    def __init__(self, adapter_factory: Callable[[str, Puzzle], Adapter], api_key: str = ""):
        self.puzzles: dict[str, Puzzle] = {}
        self.runs: dict[str, RunState] = {}
        self.adapter_factory = adapter_factory
        self._api_key = api_key
        self._trial_clocks: dict[str, float] = {}

    def start(self, config: RunConfig) -> RunState:
        run_id = new_id("run")
        trials = [
            Trial(
                trial_id=new_id("tr"),
                run_id=run_id,
                puzzle_id=puzzle_id,
                model_id=model_id,
                initial_facelets=self.puzzles[puzzle_id].facelets,
                current_facelets=self.puzzles[puzzle_id].facelets,
                optimal_distance=self.puzzles[puzzle_id].optimal_distance,
            )
            for puzzle_id in config.puzzle_ids
            for model_id in config.model_ids
        ]
        snapshot = RunSnapshot(
            run_id=run_id,
            status="queued",
            config=config.model_copy(deep=True),
            created_at=utc_now(),
            finished_at=None,
            trials=trials,
        )
        state = RunState(snapshot, EventLog(snapshot))
        self.runs[run_id] = state
        state.task = asyncio.create_task(self._execute(state), name=run_id)
        return state

    def _finish_trial(self, state: RunState, trial: Trial):
        trial.finished_at = utc_now()
        started = self._trial_clocks.pop(trial.trial_id, None)
        trial.total_time_s = perf_counter() - started if started is not None else None
        if trial.solved and trial.optimal_distance is not None:
            trial.optimality_gap = trial.moves_used - trial.optimal_distance
        state.log.emit("trial_finished", trial.model_dump(), trial.trial_id)

    def _abort_trials(self, state: RunState, code: str, message: str):
        for trial in state.snapshot.trials:
            if trial.status not in TERMINAL_TRIALS:
                trial.status = "error"
                trial.error = ErrorInfo(code=code, message=message)
                self._finish_trial(state, trial)

    def _finish_run(self, state: RunState, status: str):
        state.snapshot.status = status
        state.snapshot.finished_at = utc_now()
        state.log.emit(
            "run_finished",
            {
                "status": status,
                "finished_at": state.snapshot.finished_at,
            },
        )

    async def _execute(self, state: RunState):
        snapshot = state.snapshot
        snapshot.status = "running"
        snapshot.started_at = utc_now()
        state.log.emit("run_started", {"trial_count": len(snapshot.trials)})
        semaphore = asyncio.Semaphore(snapshot.config.concurrency)

        async def worker(trial):
            async with semaphore:
                await self._trial(state, trial)

        workers = [asyncio.create_task(worker(trial)) for trial in snapshot.trials]
        try:
            await asyncio.gather(*workers)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Do not log exception bodies: third-party exceptions may contain credentials.
            for task in workers:
                task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            self._abort_trials(state, "internal_error", "Benchmark execution failed")
            state.log.emit(
                "error",
                {
                    "code": "internal_error",
                    "message": "Benchmark execution failed",
                },
            )
            self._finish_run(state, "failed")
        else:
            self._finish_run(state, "completed")
        finally:
            for task in workers:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

    async def _trial(self, state: RunState, trial: Trial):
        config = state.snapshot.config
        self._trial_clocks[trial.trial_id] = perf_counter()
        trial.started_at = utc_now()
        trial.status = "running"
        state.log.emit(
            "trial_started",
            {
                "puzzle_id": trial.puzzle_id,
                "model_id": trial.model_id,
                "initial_facelets": trial.initial_facelets,
            },
            trial.trial_id,
        )
        adapter = self.adapter_factory(trial.model_id, self.puzzles[trial.puzzle_id])
        for _ in range(config.max_moves):
            for retry in range(config.max_retries + 1):
                if retry:
                    trial.retry_count += 1
                move_index = trial.moves_used + 1
                attempt = retry + 1
                state.log.emit(
                    "move_requested",
                    {
                        "move_index": move_index,
                        "attempt": attempt,
                    },
                    trial.trial_id,
                )
                history = (
                    [m.move for m in trial.moves[-config.history_window :]]
                    if config.history_window
                    else []
                )
                raw, reason, failure_code = "", None, "upstream_error"
                choice = None
                try:
                    choice = await asyncio.wait_for(
                        adapter.choose_move(
                            trial.current_facelets,
                            history,
                            list(MOVES),
                            config.timeout_s,
                        ),
                        timeout=config.timeout_s,
                    )
                    raw = scrub(choice.raw_response, self._api_key)
                    if choice.move is None:
                        reason = "malformed_response"
                    elif not isinstance(choice.move, str) or choice.move not in MOVES:
                        reason = "illegal_move"
                    elif (
                        not math.isfinite(choice.latency_ms)
                        or choice.latency_ms < 0
                        or (
                            choice.confidence is not None
                            and (
                                not math.isfinite(choice.confidence)
                                or not 0 <= choice.confidence <= 1
                            )
                        )
                    ):
                        reason = "malformed_response"
                except TimeoutError:
                    reason, failure_code = "timeout", "upstream_timeout"
                except UpstreamFailure as error:
                    failure_code = error.code
                    reason = "timeout" if error.code == "upstream_timeout" else "upstream_error"
                if reason is not None:
                    if reason == "timeout":
                        trial.timeout_count += 1
                    elif reason in {"malformed_response", "illegal_move"}:
                        trial.invalid_move_count += 1
                    logger.warning(
                        "Trial %s move %s attempt %s: %s",
                        trial.trial_id,
                        move_index,
                        attempt,
                        reason,
                    )
                    state.log.emit(
                        "move_invalid",
                        {
                            "move_index": move_index,
                            "attempt": attempt,
                            "reason": reason,
                            "raw_response": raw,
                        },
                        trial.trial_id,
                    )
                    if retry == config.max_retries:
                        trial.status = "error"
                        trial.error = ErrorInfo(
                            code=failure_code,
                            message=f"Move failed after {attempt} attempts: {reason}",
                        )
                        self._finish_trial(state, trial)
                        return
                    continue
                before = trial.current_facelets
                after = apply_move(before, choice.move)
                record = MoveRecord(
                    index=move_index,
                    move=choice.move,
                    facelets_before=before,
                    facelets_after=after,
                    latency_ms=choice.latency_ms,
                    confidence=choice.confidence,
                    retries=retry,
                )
                trial.moves.append(record)
                trial.moves_used += 1
                trial.current_facelets = after
                trial.solved = is_solved(after)
                state.log.emit(
                    "move_applied",
                    {
                        **record.model_dump(),
                        "moves_used": trial.moves_used,
                        "solved": trial.solved,
                    },
                    trial.trial_id,
                )
                break
            if trial.solved:
                trial.status = "solved"
                self._finish_trial(state, trial)
                return
        trial.status = "move_limit"
        self._finish_trial(state, trial)

    async def cancel(self, state: RunState):
        # Mark before the first await, preventing concurrent cancel requests or new work.
        if state.snapshot.status in TERMINAL_RUNS:
            raise ValueError("Run is already terminal")
        state.snapshot.status = "cancelled"
        if state.task is not None:
            state.task.cancel()
            await asyncio.gather(state.task, return_exceptions=True)
        self._abort_trials(state, "conflict", "Run cancelled")
        self._finish_run(state, "cancelled")

    async def close(self):
        for state in self.runs.values():
            if state.snapshot.status not in TERMINAL_RUNS:
                await self.cancel(state)
