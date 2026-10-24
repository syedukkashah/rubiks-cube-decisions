"""Consume the shared fixtures when M0 files are supplied by their owner.

Missing shared fixtures are an explicit skip, never a claim of conformance.
Backend-local examples/tests are not substitutes for the shared contract.
"""

import json
from pathlib import Path

import pytest

from app import schemas

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "contract" / "fixtures"
FIXTURES = sorted(FIXTURE_DIR.glob("*.json"))


def fixture_schema(value):
    if "session_id" in value:
        return schemas.BenchmarkSession
    if "auto_source" in value:
        return schemas.BenchmarkInfo
    if "seq" in value:
        return schemas.Event
    if "contract_version" in value:
        return schemas.Health
    if "error" in value and "trial_id" not in value:
        return schemas.ErrorEnvelope
    if "questions_answered" in value:
        return schemas.StatsResponse
    if "trials" in value and "config" in value:
        return schemas.RunSnapshot
    if "trial_id" in value:
        return schemas.Trial
    if "models" in value:
        return schemas.ModelsResponse
    if "puzzles" in value:
        return schemas.PuzzlesResponse
    if "runs" in value:
        return schemas.RunsResponse
    if "puzzle_id" in value:
        return schemas.Puzzle
    if "puzzle_ids" in value:
        return schemas.RunConfig
    if "suite" in value and "count" in value:
        return schemas.PuzzleRequest
    if "run_id" in value and value.get("status") == "queued":
        return schemas.RunAccepted
    if "run_id" in value and value.get("status") == "cancelled":
        return schemas.RunCancelled
    raise AssertionError("Unrecognized fixture shape; add an explicit schema mapping")


@pytest.mark.parametrize("path", FIXTURES or [None], ids=lambda p: p.name if p else "missing")
def test_shared_contract_fixture(path):
    if path is None:
        pytest.skip("Shared /contract/fixtures are not committed yet")
    payload = json.loads(path.read_text(encoding="utf-8"))
    for value in payload if isinstance(payload, list) else [payload]:
        fixture_schema(value).model_validate(value)
