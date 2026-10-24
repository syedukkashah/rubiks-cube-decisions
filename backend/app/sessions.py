"""Fixed benchmark plan: explicit live opt-in, safe auto, and offline playback."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from app.adapters.simulated import SimulatedAdapter, simulation_paths
from app.config import CHAT_MODEL
from app.puzzles import generate_puzzles, generate_scrambles
from app.recording import RecordedRun, RecordingFile, load_recording, recording_json, replay_run
from app.runner.service import TERMINAL_RUNS, new_id
from app.schemas import (
    MODEL_IDS,
    BenchmarkInfo,
    BenchmarkSession,
    BenchmarkSessionRun,
    BenchmarkSources,
    PlanStep,
    PuzzleRequest,
    Recording,
    RunConfig,
    StepGate,
    utc_now,
)
from app.storage import atomic_text, write_json

PLAN = (
    PlanStep(step="warmup", suite="warmup", count=1, seed=101),
    PlanStep(step="primary", suite="primary", count=5, seed=202),
    PlanStep(step="extension", suite="extension", count=2, seed=303, optional=True),
)


class SessionError(Exception):
    def __init__(self, status, code, message, details=None):
        self.status, self.code, self.message, self.details = status, code, message, details
        super().__init__(message)


def conflict(reason, message, **details):
    return SessionError(409, "conflict", message, {"reason": reason, **details})


@dataclass
class SessionState:
    snapshot: BenchmarkSession
    task: asyncio.Task | None = None
    replay: dict = field(default_factory=dict)
    interrupted: bool = False


class SessionManager:
    def __init__(self, service, registry, *, sleep=asyncio.sleep):
        self.service, self.registry = service, registry
        self.settings = service.settings
        self.sleep = sleep
        self.sessions = {}
        self.lock = asyncio.Lock()
        self.recording = load_recording(self.settings.recording_path)
        self.plan_signatures = {
            (
                frozenset(MODEL_IDS),
                frozenset(
                    facelets
                    for _, facelets in generate_scrambles(
                        PuzzleRequest(suite=step.suite, count=step.count, seed=step.seed)
                    )
                ),
                30,
                15,
                1,
                6,
            )
            for step in PLAN
        }
        if service.store is not None:
            for payload in service.store.load("sessions"):
                snapshot = BenchmarkSession.model_validate(payload)
                if snapshot.status not in TERMINAL_RUNS:
                    snapshot.status, snapshot.finished_at = "failed", utc_now()
                    for step in snapshot.runs:
                        if step.status not in {*TERMINAL_RUNS, "skipped"}:
                            step.status = "failed"
                self.sessions[snapshot.session_id] = SessionState(snapshot)

    def active(self):
        return next(
            (s for s in self.sessions.values() if s.snapshot.status not in TERMINAL_RUNS), None
        )

    def _save(self, state):
        if self.service.store is not None:
            write_json(
                self.settings.runs_dir / "sessions" / f"{state.snapshot.session_id}.json",
                state.snapshot.model_dump(),
            )

    def _required_estimate(self):
        return sum(
            (
                self.service.ledger.estimate_run(
                    RunConfig(puzzle_ids=[str(i) for i in range(step.count)])
                )
                for step in PLAN[:2]
            ),
            Decimal(0),
        )

    def _live_allowed(self):
        settings, ledger = self.settings, self.service.ledger
        return bool(
            not settings.mock_models
            and settings.api_key
            and ledger is not None
            and not self.active()
            and (self.recording is None or settings.allow_live_rerun)
            and (
                settings.allow_live_rerun
                or not any(
                    run.live
                    and run.snapshot.status == "completed"
                    and self.service._signature(run.snapshot.config) in self.plan_signatures
                    for run in self.service.runs.values()
                )
            )
            and not any(
                s.live and s.snapshot.status not in TERMINAL_RUNS
                for s in self.service.runs.values()
            )
            and self._required_estimate() <= ledger.remaining
            and ledger.live_calls < settings.max_live_calls
            and settings.max_timeout_s >= 15
            and settings.max_retries_cap >= 1
        )

    def info(self):
        return BenchmarkInfo(
            plan=list(PLAN),
            sources=BenchmarkSources(live=self._live_allowed(), replay=self.recording is not None),
            auto_source="replay" if self.recording is not None else "simulated",
            recording=self.recording.recording if self.recording is not None else None,
        )

    def get(self, session_id):
        state = self.sessions.get(session_id)
        if state is None:
            raise SessionError(404, "not_found", "Benchmark session not found")
        if state.snapshot.source == "live" and state.snapshot.status not in TERMINAL_RUNS:
            self._cost(state)
        return state

    def _cost(self, state):
        total = sum(
            (self.service.ledger.summary(step.run_id)[1] for step in state.snapshot.runs),
            Decimal(0),
        )
        state.snapshot.total_cost_usd = float(total)
        return total

    def _live_checks(self):
        settings = self.settings
        if settings.mock_models:
            raise conflict("mock_mode", "Live sessions require MOCK_MODELS=false")
        if not settings.api_key:
            raise SessionError(503, "missing_api_key", "OPENROUTER_API_KEY is not configured")
        if self.recording is not None and not settings.allow_live_rerun:
            raise conflict("recording_exists", "A live benchmark recording already exists")
        for run in self.service.runs.values():
            if run.live and run.snapshot.status not in TERMINAL_RUNS:
                raise conflict(
                    "active_run", "Another live run is active", active_run_id=run.snapshot.run_id
                )
        for name, cap in (
            ("timeout_s", settings.max_timeout_s),
            ("max_retries", settings.max_retries_cap),
        ):
            if (15 if name == "timeout_s" else 1) > cap:
                raise SessionError(
                    422, "validation_error", f"Plan {name} exceeds configured cap", {"field": name}
                )
        estimate = self._required_estimate()
        ledger = self.service.ledger
        if estimate > ledger.remaining or ledger.live_calls >= settings.max_live_calls:
            raise conflict(
                "budget",
                "Required steps exceed remaining live budget",
                estimated_max_cost_usd=float(estimate),
                remaining_budget_usd=float(ledger.remaining),
            )

    async def submit(self, request):
        async with self.lock, self.service.admission_lock:
            active = self.active()
            if active is not None:
                raise SessionError(
                    409,
                    "conflict",
                    "Another session is active",
                    {"active_session_id": active.snapshot.session_id},
                )
            source = self.info().auto_source if request.source == "auto" else request.source
            if source == "replay" and self.recording is None:
                raise conflict("no_recording", "No live benchmark recording exists")
            if source == "live":
                self._live_checks()
            plan = PLAN if request.include_extension else PLAN[:2]
            prepared = []
            for step in plan:
                recorded = (
                    next((r for r in self.recording.runs if r.step == step.step), None)
                    if source == "replay"
                    else None
                )
                ids = {}
                if recorded is not None:
                    puzzles = []
                    for p in self.recording.puzzles:
                        if p.puzzle_id in recorded.snapshot.config.puzzle_ids:
                            ids[p.puzzle_id] = new_id("pz")
                            puzzles.append(
                                p.model_copy(
                                    update={"puzzle_id": ids[p.puzzle_id], "created_at": utc_now()}
                                )
                            )
                    config = recorded.snapshot.config.model_copy(
                        update={"puzzle_ids": [ids[p] for p in recorded.snapshot.config.puzzle_ids]}
                    )
                else:
                    puzzles = await asyncio.to_thread(
                        generate_puzzles,
                        PuzzleRequest(suite=step.suite, count=step.count, seed=step.seed),
                    )
                    config = RunConfig(puzzle_ids=[p.puzzle_id for p in puzzles])
                paths = (
                    await asyncio.to_thread(simulation_paths, puzzles)
                    if source == "simulated"
                    else None
                )
                prepared.append((step, puzzles, config, recorded, ids, paths))
            if source == "live":
                # Compare content before making availability or inference calls.
                for _, puzzles, config, _, _, _ in prepared:
                    signature = (
                        frozenset(config.model_ids),
                        frozenset(p.facelets for p in puzzles),
                        config.max_moves,
                        config.timeout_s,
                        config.max_retries,
                        config.history_window,
                    )
                    for prior in self.service.runs.values():
                        if (
                            prior.live
                            and prior.snapshot.status == "completed"
                            and not self.settings.allow_live_rerun
                            and signature == self.service._signature(prior.snapshot.config)
                        ):
                            raise conflict(
                                "active_run",
                                "This live configuration already completed",
                                duplicate_of_run_id=prior.snapshot.run_id,
                            )
                await self.registry.refresh()
                if not all(model.available for model in self.registry.models):
                    raise conflict("active_run", "One or more requested models are unavailable")
            snapshot = BenchmarkSession(
                session_id=new_id("sess"),
                source=source,
                requested_source=request.source,
                status="queued",
                speed=request.speed,
                created_at=utc_now(),
                replay_of_session_id=self.recording.session.session_id
                if source == "replay"
                else None,
                recorded_at=self.recording.recording.recorded_at if source == "replay" else None,
                total_cost_usd=0 if source == "live" else None,
                runs=[],
            )
            session = SessionState(snapshot)
            for step, puzzles, config, recorded, ids, paths in prepared:
                self.service.add_puzzles(puzzles)
                factory = None
                if paths is not None:

                    def factory(model, puzzle, paths=paths):
                        return SimulatedAdapter(
                            model, puzzle, paths[puzzle.puzzle_id], request.speed, self.sleep
                        )

                run = self.service.create(
                    config,
                    live=source == "live",
                    adapter_factory=factory,
                    simulation_speed=request.speed if source == "simulated" else None,
                )
                snapshot.runs.append(
                    BenchmarkSessionRun(
                        step=step.step,
                        suite=step.suite,
                        run_id=run.snapshot.run_id,
                        status="queued",
                    )
                )
                if source == "replay":
                    if recorded is None:
                        await self.service.cancel(run)
                        snapshot.runs[-1].status = "skipped"
                    else:
                        ids[recorded.snapshot.run_id] = run.snapshot.run_id
                        for old, new in zip(
                            recorded.snapshot.trials, run.snapshot.trials, strict=True
                        ):
                            ids[old.trial_id] = new.trial_id
                        run.execution_config = dict(recorded.execution_config)
                        run.call_metrics = []  # Replay does not claim new model calls.
                        session.replay[run.snapshot.run_id] = (recorded, ids)
            self.sessions[snapshot.session_id] = session
            self._save(session)
            session.task = asyncio.create_task(self._execute(session), name=snapshot.session_id)
            return session

    def gate(self, step, next_step):
        run = self.service.runs[step.run_id]
        cost = self.service.ledger.summary(step.run_id)[1]
        expected = Decimal(str(getattr(self.settings, "expected_cost_" + step.step)))
        calls = [m for m in run.call_metrics if m["model_id"] == CHAT_MODEL]
        truncated = sum(
            m.get("finish_reason") == "length" or m.get("empty_content", False) for m in calls
        )
        pct = 100 * truncated / len(calls) if calls else None
        reasons = []
        if cost > expected * Decimal("1.5"):
            reasons.append("cost_over_expected")
        if pct is not None and pct > 20:
            reasons.append("opus_truncation")
        if run.snapshot.status == "failed":
            reasons.append("run_aborted")
        if (
            next_step is not None
            and self.service.ledger.estimate_run(
                self.service.runs[next_step.run_id].snapshot.config
            )
            > self.service.ledger.remaining
        ):
            reasons.append("budget")
        return StepGate(
            passed=not reasons,
            cost_usd=float(cost),
            expected_cost_usd=float(expected),
            opus_truncation_pct=pct,
            reasons=reasons,
        )

    async def _stop_remaining(self, state, *, skip_extension=False):
        for step in state.snapshot.runs:
            run = self.service.runs[step.run_id]
            if run.snapshot.status not in TERMINAL_RUNS:
                await self.service.cancel(run)
                step.status = (
                    "skipped" if skip_extension and step.step == "extension" else "cancelled"
                )
            elif step.status != "skipped":
                step.status = run.snapshot.status

    def _finish(self, state, status):
        state.snapshot.status, state.snapshot.finished_at = status, utc_now()
        if state.snapshot.source == "live":
            self._cost(state)
        self._save(state)

    def _record(self, state):
        runs = []
        puzzle_ids = set()
        for step in state.snapshot.runs:
            if step.status != "completed":
                continue
            run = self.service.runs[step.run_id]
            puzzle_ids.update(run.snapshot.config.puzzle_ids)
            runs.append(
                RecordedRun(
                    step=step.step,
                    snapshot=run.snapshot,
                    events=run.log.events,
                    execution_config=run.execution_config,
                    call_metrics=run.call_metrics,
                )
            )
        recording = RecordingFile(
            recording=Recording(
                recording_id=new_id("rec"),
                recorded_at=utc_now(),
                session_id=state.snapshot.session_id,
                trial_count=sum(len(r.snapshot.trials) for r in runs),
                total_cost_usd=float(self._cost(state)),
            ),
            session=state.snapshot.model_copy(deep=True),
            puzzles=[p for p in self.service.puzzles.values() if p.puzzle_id in puzzle_ids],
            runs=runs,
        )
        atomic_text(self.settings.recording_path, recording_json(recording, self.settings.api_key))
        self.recording = recording

    async def _execute(self, state):
        snapshot = state.snapshot
        snapshot.status = "running"
        self._save(state)
        try:
            previous_replay_end = None
            for index, step in enumerate(snapshot.runs):
                if step.status == "skipped":
                    continue
                run = self.service.runs[step.run_id]
                if run.snapshot.status == "cancelled":
                    step.status = "cancelled"
                    await self._stop_remaining(state)
                    self._finish(state, "cancelled")
                    return
                step.status = "running"
                self._save(state)
                if snapshot.source == "replay":
                    recorded, ids = state.replay[step.run_id]
                    initial_gap = (
                        max(
                            0,
                            (
                                datetime.fromisoformat(recorded.events[0].ts) - previous_replay_end
                            ).total_seconds(),
                        )
                        if previous_replay_end is not None
                        else 0
                    )
                    run.task = asyncio.create_task(
                        replay_run(run, recorded, ids, snapshot.speed, self.sleep, initial_gap)
                    )
                    previous_replay_end = datetime.fromisoformat(recorded.events[-1].ts)
                else:
                    self.service.launch(run)
                await run.task
                step.status = run.snapshot.status
                if snapshot.source == "live":
                    following = snapshot.runs[index + 1] if index + 1 < len(snapshot.runs) else None
                    step.gate = self.gate(step, following)
                    self._cost(state)
                    if not step.gate.passed:
                        snapshot.stop_reason = "gate"
                        required_complete = all(
                            s.status == "completed" for s in snapshot.runs if s.step != "extension"
                        )
                        success = required_complete and run.snapshot.status == "completed"
                        await self._stop_remaining(state, skip_extension=success)
                        self._finish(state, "completed" if success else "failed")
                        if success:
                            self._record(state)
                        return
                if run.snapshot.status != "completed":
                    await self._stop_remaining(state)
                    self._finish(
                        state, "cancelled" if run.snapshot.status == "cancelled" else "failed"
                    )
                    return
                self._save(state)
            self._finish(state, "completed")
            if snapshot.source == "live":
                self._record(state)
        except asyncio.CancelledError:
            if state.interrupted:
                await self.service.close()
                await self._stop_remaining(state)
                self._finish(state, "failed")
            else:
                await self._stop_remaining(state)
                self._finish(state, "cancelled")
        except Exception:
            await self._stop_remaining(state)
            self._finish(state, "failed")

    async def cancel(self, state):
        if state.snapshot.status in TERMINAL_RUNS:
            raise SessionError(409, "conflict", "Session is already terminal")
        if state.task is not None:
            state.task.cancel()
            await asyncio.gather(state.task, return_exceptions=True)
        await self._stop_remaining(state)
        self._finish(state, "cancelled")

    async def close(self):
        active = self.active()
        if active is not None:
            active.interrupted = True
            if active.task is not None:
                active.task.cancel()
                await asyncio.gather(active.task, return_exceptions=True)
            await self.service.close()
            await self._stop_remaining(active)
            self._finish(active, "failed")
