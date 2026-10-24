"""Local, validated recordings and zero-inference event replay."""

import asyncio
import json
from datetime import datetime, timedelta

from pydantic import Field, model_validator

from app.schemas import (
    BenchmarkSession,
    Event,
    MoveRecord,
    Puzzle,
    Recording,
    RunSnapshot,
    Schema,
    Suite,
    Trial,
    utc_now,
)


class RecordedRun(Schema):
    step: Suite
    snapshot: RunSnapshot
    events: list[Event]
    execution_config: dict = Field(default_factory=dict)
    call_metrics: list[dict] = Field(default_factory=list)


class RecordingFile(Schema):
    recording: Recording
    session: BenchmarkSession
    puzzles: list[Puzzle]
    runs: list[RecordedRun]

    @model_validator(mode="after")
    def complete_evidence(self):
        if self.session.source != "live" or self.session.status != "completed":
            raise ValueError("Only a successful live session is a recording")
        steps = [run.step for run in self.runs]
        if steps not in (["warmup", "primary"], ["warmup", "primary", "extension"]):
            raise ValueError("Recording must contain the required steps in order")
        puzzles = {p.puzzle_id for p in self.puzzles}
        for run in self.runs:
            snapshot = run.snapshot
            if snapshot.status != "completed" or not set(snapshot.config.puzzle_ids) <= puzzles:
                raise ValueError("Recording has incomplete run data")
            if (
                not run.events
                or run.events[-1].type != "run_finished"
                or [e.seq for e in run.events] != list(range(1, snapshot.last_seq + 1))
                or any(e.run_id != snapshot.run_id for e in run.events)
            ):
                raise ValueError("Recording has an inconsistent event log")
        return self


def load_recording(path):
    return (
        RecordingFile.model_validate_json(path.read_text(encoding="utf-8"))
        if path.exists()
        else None
    )


def remap(value, ids):
    """Change identifier fields only; keep output strings and model measurements intact."""
    if isinstance(value, list):
        return [remap(item, ids) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        key: ids.get(item, item)
        if key in {"run_id", "trial_id", "puzzle_id"} and isinstance(item, str)
        else [ids.get(i, i) for i in item]
        if key == "puzzle_ids"
        else remap(item, ids)
        for key, item in value.items()
    }


async def replay_run(state, recorded, ids, speed, sleep=asyncio.sleep, initial_gap=0):
    """Use recorded events to update ordinary snapshots, then publish ordinary SSE."""
    first = datetime.fromisoformat(recorded.events[0].ts)

    trials = {t.trial_id: t for t in state.snapshot.trials}
    previous = first - timedelta(seconds=initial_gap)
    for event in recorded.events:
        current = datetime.fromisoformat(event.ts)
        await sleep(max(0, (current - previous).total_seconds()) / speed)
        previous = current
        # Capture after the sleep, including any gap between session steps. Snapshot
        # clocks and SSE must describe the same actual playback instant.
        emitted_at = utc_now()
        data = remap(event.data, ids)
        trial_id = ids.get(event.trial_id)
        trial = trials.get(trial_id)
        if event.type == "run_started":
            state.snapshot.status = "running"
            state.snapshot.started_at = emitted_at
        elif event.type == "trial_started":
            trial.status, trial.started_at = "running", emitted_at
        elif event.type == "move_requested":
            if data["attempt"] > 1:
                trial.retry_count += 1
        elif event.type == "move_invalid":
            if data["reason"] == "timeout":
                trial.timeout_count += 1
            elif data["reason"] in {"malformed_response", "illegal_move"}:
                trial.invalid_move_count += 1
        elif event.type == "move_applied":
            trial.moves.append(
                MoveRecord.model_validate(
                    {k: v for k, v in data.items() if k not in {"moves_used", "solved"}}
                )
            )
            trial.moves_used, trial.solved = data["moves_used"], data["solved"]
            trial.current_facelets = data["facelets_after"]
        elif event.type == "trial_finished":
            data["started_at"] = trial.started_at
            data["finished_at"] = emitted_at
            copied = Trial.model_validate(data)
            for field in type(copied).model_fields:
                setattr(trial, field, getattr(copied, field))
        elif event.type == "run_finished":
            # Recorded totals (including wall time and retries) are evidence, not replay timing.
            copied = RunSnapshot.model_validate(remap(recorded.snapshot.model_dump(), ids))
            for copied_trial in copied.trials:
                replayed = trials[copied_trial.trial_id]
                copied_trial.started_at = replayed.started_at
                copied_trial.finished_at = replayed.finished_at
            state.snapshot.trials = copied.trials
            state.snapshot.status = copied.status
            state.snapshot.finished_at = emitted_at
            data["finished_at"] = emitted_at
            # created_at remains the new run's queue time; never copy the old run clock.
        state.log.emit(event.type, data, trial_id, ts=emitted_at)


def recording_json(recording, api_key):
    from app.adapters.base import scrub

    return scrub(
        json.dumps(recording.model_dump(), separators=(",", ":"), allow_nan=False), api_key
    )
