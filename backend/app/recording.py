"""Local, validated recordings and zero-inference event replay."""

import asyncio
import json
from datetime import UTC, datetime, timedelta

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
    start = datetime.now(UTC)

    def stamp(value):
        if value is None:
            return None
        offset = (datetime.fromisoformat(value) - first).total_seconds() / speed
        return (
            (start + timedelta(seconds=offset))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

    def restamp(value):
        if isinstance(value, list):
            return [restamp(item) for item in value]
        if not isinstance(value, dict):
            return value
        return {
            key: stamp(item)
            if key in {"created_at", "started_at", "finished_at"}
            else restamp(item)
            for key, item in value.items()
        }

    trials = {t.trial_id: t for t in state.snapshot.trials}
    previous = first - timedelta(seconds=initial_gap)
    for event in recorded.events:
        current = datetime.fromisoformat(event.ts)
        await sleep(max(0, (current - previous).total_seconds()) / speed)
        previous = current
        data = restamp(remap(event.data, ids))
        trial_id = ids.get(event.trial_id)
        trial = trials.get(trial_id)
        if event.type == "run_started":
            state.snapshot.status = "running"
            state.snapshot.started_at = stamp(event.ts)
        elif event.type == "trial_started":
            trial.status, trial.started_at = "running", stamp(event.ts)
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
            copied = Trial.model_validate(data)
            for field in type(copied).model_fields:
                setattr(trial, field, getattr(copied, field))
        elif event.type == "run_finished":
            # Recorded totals (including wall time and retries) are evidence, not replay timing.
            copied = RunSnapshot.model_validate(restamp(remap(recorded.snapshot.model_dump(), ids)))
            state.snapshot.trials = copied.trials
            state.snapshot.status = copied.status
            state.snapshot.finished_at = data["finished_at"]
        state.log.emit(event.type, data, trial_id)


def recording_json(recording, api_key):
    from app.adapters.base import scrub

    return scrub(
        json.dumps(recording.model_dump(), separators=(",", ":"), allow_nan=False), api_key
    )
