"""Atomic local JSON storage. Use one backend process with these directories."""

import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile


def atomic_text(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=path.name,
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_json(path: Path, payload):
    atomic_text(path, json.dumps(payload, separators=(",", ":"), allow_nan=False))


class RunStore:
    def __init__(self, directory: Path):
        self.directory = Path(directory)

    def save_puzzle(self, puzzle):
        write_json(self.directory / "puzzles" / f"{puzzle.puzzle_id}.json", puzzle.model_dump())

    def save_run(self, state):
        write_json(
            self.directory / "runs" / f"{state.snapshot.run_id}.json",
            {
                "snapshot": state.snapshot.model_dump(),
                "events": [event.model_dump() for event in state.log.events],
                "live": state.live,
                "call_metrics": state.call_metrics,
                "execution_config": state.execution_config,
            },
        )

    def load(self, kind):
        return [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted((self.directory / kind).glob("*.json"))
        ]
