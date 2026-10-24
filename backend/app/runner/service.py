import asyncio
import logging
import math
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from time import perf_counter
from uuid import uuid4

from app.adapters.base import Adapter, UpstreamFailure, scrub
from app.budget import BudgetExceeded, estimate_run
from app.config import Settings
from app.engine import MOVES, apply_move, is_solved
from app.runner.calls import call_model
from app.runner.events import EventLog
from app.schemas import ErrorInfo, Event, MoveRecord, Puzzle, RunConfig, RunSnapshot, Trial, utc_now
from app.storage import RunStore

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
    live: bool = False
    call_metrics: list[dict] = field(default_factory=list)
    execution_config: dict = field(default_factory=dict)
    failure: Exception | None = None
    adapter_factory: Callable | None = None
    simulation_speed: float | None = None
    simulated_time: dict[str, float] = field(default_factory=dict)


class RunConflict(Exception):
    def __init__(self, message, details):
        super().__init__(message)
        self.details = details


class BenchmarkService:
    def __init__(
        self,
        adapter_factory: Callable[[str, Puzzle], Adapter],
        api_key: str = "",
        settings: Settings | None = None,
        ledger=None,
        store: RunStore | None = None,
    ):
        self.puzzles: dict[str, Puzzle] = {}
        self.runs: dict[str, RunState] = {}
        self.adapter_factory = adapter_factory
        self._api_key = api_key
        self._trial_clocks: dict[str, float] = {}
        self.settings = settings or Settings()
        self.ledger = ledger
        self.store = store
        self.admission_lock = asyncio.Lock()
        if store is not None:
            self._load()

    def _watch(self, state):
        if self.store is not None:
            state.log.on_event = lambda: self.store.save_run(state)

    def _load(self):
        for payload in self.store.load("puzzles"):
            puzzle = Puzzle.model_validate(payload)
            self.puzzles[puzzle.puzzle_id] = puzzle
        stored = sorted(self.store.load("runs"), key=lambda r: r["snapshot"]["created_at"])
        for payload in stored:
            snapshot = RunSnapshot.model_validate(payload["snapshot"])
            state = RunState(
                snapshot,
                EventLog(snapshot),
                live=payload["live"],
                call_metrics=payload.get("call_metrics", []),
                execution_config=payload.get("execution_config", {}),
            )
            state.log.events = [Event.model_validate(e) for e in payload["events"]]
            if [e.seq for e in state.log.events] != list(range(1, snapshot.last_seq + 1)):
                raise ValueError("Stored run has an inconsistent event log")
            self.runs[snapshot.run_id] = state
            if snapshot.status in {"queued", "running"}:
                self._abort_trials(state, "internal_error", "interrupted by restart")
                state.log.emit(
                    "error",
                    {
                        "code": "internal_error",
                        "message": "interrupted by restart",
                    },
                )
                self._finish_run(state, "failed")
            self._watch(state)

    def add_puzzles(self, puzzles):
        for puzzle in puzzles:
            if self.store is not None:
                self.store.save_puzzle(puzzle)
            self.puzzles[puzzle.puzzle_id] = puzzle

    def _signature(self, config):
        return (
            frozenset(config.model_ids),
            frozenset(self.puzzles[p].facelets for p in config.puzzle_ids),
            config.max_moves,
            config.timeout_s,
            config.max_retries,
            config.history_window,
        )

    async def submit(self, config):
        async with self.admission_lock:
            if not self.settings.mock_models:
                for state in self.runs.values():
                    if state.live and state.snapshot.status in {"queued", "running"}:
                        raise RunConflict(
                            "Another live run is active",
                            {
                                "active_run_id": state.snapshot.run_id,
                            },
                        )
                    if (
                        state.live
                        and state.snapshot.status == "completed"
                        and not self.settings.allow_live_rerun
                        and self._signature(config) == self._signature(state.snapshot.config)
                    ):
                        raise RunConflict(
                            "This live configuration already completed",
                            {
                                "duplicate_of_run_id": state.snapshot.run_id,
                            },
                        )
                async with self.ledger.lock:
                    cost = estimate_run(self.settings, config)
                    if cost > self.ledger.remaining:
                        raise RunConflict(
                            "Run exceeds remaining live budget",
                            {
                                "estimated_max_cost_usd": float(cost),
                                "remaining_budget_usd": float(self.ledger.remaining),
                            },
                        )
                    return self.start(config)
            return self.start(config)

    def start(self, config: RunConfig) -> RunState:
        state = self.create(config)
        self.launch(state)
        return state

    def create(self, config: RunConfig, *, live=None, adapter_factory=None, simulation_speed=None):
        """Create a durable queued run without starting any inference."""
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
        state = RunState(
            snapshot,
            EventLog(snapshot),
            live=not self.settings.mock_models if live is None else live,
            adapter_factory=adapter_factory,
            simulation_speed=simulation_speed,
        )
        state.execution_config = {
            "chat_max_tokens": self.settings.chat_max_tokens,
            "chat_reasoning_effort": self.settings.chat_reasoning_effort,
            "max_trial_retries": self.settings.max_trial_retries,
        }
        self._watch(state)
        if self.store is not None:
            self.store.save_run(state)
        self.runs[run_id] = state
        return state

    def launch(self, state):
        if state.snapshot.status != "queued" or state.task is not None:
            raise ValueError("Only a fresh queued run can start")
        state.task = asyncio.create_task(self._execute(state), name=state.snapshot.run_id)

    def _finish_trial(self, state: RunState, trial: Trial):
        trial.finished_at = utc_now()
        started = self._trial_clocks.pop(trial.trial_id, None)
        trial.total_time_s = perf_counter() - started if started is not None else None
        if state.simulation_speed is not None:
            trial.total_time_s = state.simulated_time.get(trial.trial_id, 0)
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
        if state.live and self.ledger is not None:
            calls, spent = self.ledger.summary(state.snapshot.run_id)
            logger.info(
                "Run %s: calls=%s spent_usd=%s remaining_budget_usd=%s",
                state.snapshot.run_id,
                calls,
                spent,
                self.ledger.remaining,
            )

    async def _execute(self, state: RunState):
        snapshot = state.snapshot
        snapshot.status = "running"
        snapshot.started_at = utc_now()
        state.log.emit("run_started", {"trial_count": len(snapshot.trials)})
        semaphore = asyncio.Semaphore(snapshot.config.concurrency)

        async def worker(trial):
            async with semaphore:
                if state.failure is not None:
                    return
                await self._trial(state, trial)

        workers = [asyncio.create_task(worker(trial)) for trial in snapshot.trials]
        try:
            await asyncio.gather(*workers)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Do not log exception bodies: third-party exceptions may contain credentials.
            for task in workers:
                task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            code = (
                error.code
                if isinstance(error, BudgetExceeded | UpstreamFailure)
                else "internal_error"
            )
            message = str(error) if code != "internal_error" else "Benchmark execution failed"
            self._abort_trials(state, code, message)
            state.log.emit(
                "error",
                {
                    "code": code,
                    "message": message,
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
        factory = state.adapter_factory or self.adapter_factory
        adapter = factory(trial.model_id, self.puzzles[trial.puzzle_id])

        def record_call(result, failure):
            if state.simulation_speed is not None and result is not None:
                state.simulated_time[trial.trial_id] = (
                    state.simulated_time.get(trial.trial_id, 0) + result.latency_ms / 1000
                )
            if not state.live:
                return
            usage = result.usage if result is not None else failure.usage
            state.call_metrics.append(
                {
                    "trial_id": trial.trial_id,
                    "model_id": trial.model_id,
                    "move_index": trial.moves_used + 1,
                    "usage": asdict(usage),
                    "finish_reason": result.finish_reason if result is not None else None,
                    "empty_content": result.empty_content if result is not None else False,
                    "accepted": result is not None and result.move in MOVES,
                }
            )
            if self.store is not None:
                self.store.save_run(state)

        for _ in range(config.max_moves):
            for retry in range(config.max_retries + 1):
                if state.failure is not None:
                    return
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
                retryable, delay, fatal = True, 0, None
                try:
                    choice = await call_model(
                        adapter,
                        trial.current_facelets,
                        history,
                        config.timeout_s / (state.simulation_speed or 1),
                        self.ledger if state.live else None,
                        trial.run_id,
                        trial.trial_id,
                        trial.model_id,
                        record_call,
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
                except UpstreamFailure as error:
                    failure_code = error.code
                    reason = "timeout" if error.code == "upstream_timeout" else "upstream_error"
                    retryable = error.retryable
                    delay = error.retry_after if error.retry_after is not None else 0.5 * 2**retry
                    if error.fatal:
                        state.failure = fatal = error
                except BudgetExceeded as error:
                    state.failure = error
                    raise
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
                    if fatal is not None:
                        raise fatal
                    exhausted = trial.retry_count >= self.settings.max_trial_retries
                    if retry == config.max_retries or not retryable or exhausted:
                        trial.status = "error"
                        trial.error = ErrorInfo(
                            code=failure_code,
                            message="trial retry budget exhausted"
                            if exhausted
                            else f"Move failed after {attempt} attempts: {reason}",
                        )
                        self._finish_trial(state, trial)
                        return
                    if delay:
                        await asyncio.sleep(delay)
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
                if state.task is not None:
                    state.task.cancel()
                    await asyncio.gather(state.task, return_exceptions=True)
                self._abort_trials(state, "internal_error", "interrupted by restart")
                state.log.emit(
                    "error",
                    {
                        "code": "internal_error",
                        "message": "interrupted by restart",
                    },
                )
                self._finish_run(state, "failed")
