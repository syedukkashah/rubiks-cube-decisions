import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import ErrorEnvelope, Event, RunSnapshot, StatsResponse


@pytest.fixture
def client():
    def no_network(request):
        raise AssertionError("Mock mode must not make network requests")

    with TestClient(
        create_app(
            Settings(mock_models=True),
            transport=httpx.MockTransport(no_network),
        )
    ) as client:
        yield client


def test_mock_pipeline_and_resume(client):
    health = client.get("/api/v1/health")
    assert health.json() == {
        "status": "ok",
        "contract_version": "1.0.0",
        "api_key_configured": False,
    }
    assert health.headers["content-type"] == "application/json; charset=utf-8"
    assert all(model["available"] for model in client.get("/api/v1/models").json()["models"])
    response = client.post("/api/v1/puzzles", json={"suite": "primary", "count": 5, "seed": 42})
    assert response.status_code == 201
    puzzles = response.json()["puzzles"]
    puzzle_ids = [puzzle["puzzle_id"] for puzzle in puzzles]
    assert client.get(f"/api/v1/puzzles/{puzzle_ids[0]}").json() == puzzles[0]
    assert client.get("/api/v1/puzzles?suite=primary").json() == response.json()
    response = client.post("/api/v1/runs", json={"puzzle_ids": puzzle_ids, "concurrency": 4})
    assert response.status_code == 202 and response.json()["status"] == "queued"
    run_id = response.json()["run_id"]
    deadline = time.monotonic() + 10
    while True:
        snapshot = client.get(f"/api/v1/runs/{run_id}").json()
        if snapshot["status"] == "completed":
            break
        assert time.monotonic() < deadline
        time.sleep(0.01)
    RunSnapshot.model_validate(snapshot)
    assert len(snapshot["trials"]) == 20
    assert all(trial["solved"] for trial in snapshot["trials"])
    stats = StatsResponse.model_validate(client.get(f"/api/v1/runs/{run_id}/stats").json())
    assert all(model.success_rate_pct == 100 for model in stats.models)
    stream = client.get(f"/api/v1/runs/{run_id}/events").text
    events = [
        Event.model_validate_json(line[6:])
        for line in stream.splitlines()
        if line.startswith("data: ")
    ]
    assert len(events) == snapshot["last_seq"]
    replay = client.get(f"/api/v1/runs/{run_id}/events", headers={"Last-Event-ID": "3"})
    assert replay.text.startswith("id: 4\n")
    assert client.get(f"/api/v1/runs/{run_id}/events?after_seq=3").text == replay.text
    assert client.post(f"/api/v1/runs/{run_id}/cancel").status_code == 409
    assert client.get("/api/v1/runs").json()["runs"][0]["run_id"] == run_id


@pytest.mark.parametrize(
    "payload",
    [
        {"suite": "primary", "count": 1, "unknown": True},
        {"suite": "primary", "count": 0},
        {"suite": "primary", "count": True},
        {"suite": "primary", "count": 1, "scramble_length": 3},
        {"suite": "other", "count": 1},
    ],
)
def test_reject_invalid_puzzles(client, payload):
    response = client.post("/api/v1/puzzles", json=payload)
    assert response.status_code == 422
    ErrorEnvelope.model_validate(response.json())


@pytest.mark.parametrize(
    "field,value",
    [
        ("max_moves", 31),
        ("max_moves", True),
        ("timeout_s", 0),
        ("max_retries", -1),
        ("history_window", -1),
        ("concurrency", 5),
        ("model_ids", ["unknown"]),
        ("extra", "value"),
    ],
)
def test_reject_invalid_runs(client, field, value):
    response = client.post("/api/v1/runs", json={"puzzle_ids": ["pz_missing"], field: value})
    assert response.status_code == 422
    ErrorEnvelope.model_validate(response.json())


def test_real_mode_requires_key():
    with TestClient(create_app(Settings())) as client:
        response = client.post("/api/v1/runs", json={"puzzle_ids": ["pz_missing"]})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "missing_api_key"


def test_not_found_unknown_query_and_cors(client):
    for path in ("puzzles/pz_missing", "runs/run_missing", "runs/run_missing/events"):
        response = client.get("/api/v1/" + path)
        assert response.status_code == 404
        ErrorEnvelope.model_validate(response.json())
    assert client.get("/api/v1/puzzles?unknown=value").status_code == 422
    assert client.get("/api/v1/puzzles?suite=invalid").status_code == 422
    allowed = client.get("/api/v1/health", headers={"Origin": "http://localhost:5173"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    denied = client.get("/api/v1/health", headers={"Origin": "https://other.example"})
    assert "access-control-allow-origin" not in denied.headers


def test_seed_reproduces_batch_and_extension_optimum_is_null(client):
    body = {"suite": "extension", "count": 2, "seed": 7}
    first = client.post("/api/v1/puzzles", json=body).json()["puzzles"]
    second = client.post("/api/v1/puzzles", json=body).json()["puzzles"]
    assert [p["scramble_moves"] for p in first] == [p["scramble_moves"] for p in second]
    assert all(p["optimal_distance"] is None for p in first)
