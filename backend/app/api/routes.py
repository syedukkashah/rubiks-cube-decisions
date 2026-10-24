import asyncio
from random import Random

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.engine import SUITE_RANGES, scramble
from app.runner.service import RunConflict, new_id
from app.schemas import (
    Health,
    ModelsResponse,
    Puzzle,
    PuzzleRequest,
    PuzzlesResponse,
    RunAccepted,
    RunCancelled,
    RunConfig,
    RunSnapshot,
    RunsResponse,
    RunSummary,
    StatsResponse,
    Suite,
    utc_now,
)
from app.solver import shortest_distance
from app.stats import compute_stats


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        self.status, self.code, self.message, self.details = status, code, message, details


def validate_query(request: Request):
    path = request.url.path.rstrip("/")
    allowed = {"suite"} if path == "/api/v1/puzzles" and request.method == "GET" else set()
    if path.endswith("/events"):
        allowed = {"after_seq"}
    keys = list(request.query_params.keys())
    if any(key not in allowed or len(request.query_params.getlist(key)) > 1 for key in keys):
        raise APIError(422, "validation_error", "Unknown or repeated query parameter")


router = APIRouter(prefix="/api/v1", dependencies=[Depends(validate_query)])


def service(request: Request):
    return request.app.state.service


def get_run(request: Request, run_id: str):
    state = service(request).runs.get(run_id)
    if state is None:
        raise APIError(404, "not_found", "Run not found")
    return state


@router.get("/health", response_model=Health)
async def health(request: Request):
    return Health(api_key_configured=bool(request.app.state.settings.api_key))


@router.get("/models", response_model=ModelsResponse)
async def models(request: Request):
    registry = request.app.state.registry
    await registry.refresh()
    return ModelsResponse(models=registry.models)


def generate_puzzles(body: PuzzleRequest) -> list[Puzzle]:
    rng = Random(body.seed)
    puzzles = []
    for _ in range(body.count):
        length = body.scramble_length
        if length is None:
            length = rng.randint(*SUITE_RANGES[body.suite])
        moves, facelets = scramble(rng, length)
        puzzles.append(
            Puzzle(
                puzzle_id=new_id("pz"),
                suite=body.suite,
                scramble_moves=moves,
                facelets=facelets,
                optimal_distance=shortest_distance(facelets) if body.suite != "extension" else None,
                created_at=utc_now(),
            )
        )
    return puzzles


@router.post("/puzzles", status_code=201, response_model=PuzzlesResponse)
async def create_puzzles(body: PuzzleRequest, request: Request):
    # Exact search must not block the event loop (especially live heartbeats/cancellation).
    puzzles = await asyncio.to_thread(generate_puzzles, body)
    service(request).add_puzzles(puzzles)
    return PuzzlesResponse(puzzles=puzzles)


@router.get("/puzzles", response_model=PuzzlesResponse)
async def list_puzzles(request: Request, suite: Suite | None = None):
    return PuzzlesResponse(
        puzzles=[p for p in service(request).puzzles.values() if suite is None or p.suite == suite]
    )


@router.get("/puzzles/{puzzle_id}", response_model=Puzzle)
async def get_puzzle(puzzle_id: str, request: Request):
    puzzle = service(request).puzzles.get(puzzle_id)
    if puzzle is None:
        raise APIError(404, "not_found", "Puzzle not found")
    return puzzle


@router.post("/runs", status_code=202, response_model=RunAccepted)
async def create_run(body: RunConfig, request: Request):
    settings = request.app.state.settings
    for field, limit in (
        ("timeout_s", settings.max_timeout_s),
        ("max_retries", settings.max_retries_cap),
    ):
        if getattr(body, field) > limit:
            raise APIError(
                422, "validation_error", f"{field} exceeds configured cap", {"field": field}
            )
    if not settings.mock_models and not settings.api_key:
        raise APIError(503, "missing_api_key", "OPENROUTER_API_KEY is not configured")
    if any(puzzle_id not in service(request).puzzles for puzzle_id in body.puzzle_ids):
        raise APIError(404, "not_found", "One or more puzzles do not exist")
    registry = request.app.state.registry
    await registry.refresh()
    available = {model.id for model in registry.models if model.available}
    if any(model_id not in available for model_id in body.model_ids):
        raise APIError(409, "conflict", "One or more requested models are unavailable")
    try:
        state = await service(request).submit(body)
    except RunConflict as error:
        raise APIError(409, "conflict", str(error), error.details) from None
    return RunAccepted(run_id=state.snapshot.run_id)


@router.get("/runs", response_model=RunsResponse)
async def list_runs(request: Request):
    return RunsResponse(
        runs=[
            RunSummary(
                run_id=state.snapshot.run_id,
                status=state.snapshot.status,
                created_at=state.snapshot.created_at,
                finished_at=state.snapshot.finished_at,
            )
            for state in reversed(list(service(request).runs.values()))
        ]
    )


@router.get("/runs/{run_id}", response_model=RunSnapshot)
async def run_snapshot(run_id: str, request: Request):
    return get_run(request, run_id).snapshot


@router.post("/runs/{run_id}/cancel", response_model=RunCancelled)
async def cancel_run(run_id: str, request: Request):
    state = get_run(request, run_id)
    try:
        await service(request).cancel(state)
    except ValueError:
        raise APIError(409, "conflict", "Run is already terminal") from None
    return RunCancelled(run_id=run_id)


@router.get("/runs/{run_id}/events")
async def events(run_id: str, request: Request):
    state = get_run(request, run_id)
    # Explicit query cursor takes precedence over the EventSource reconnect header.
    raw_cursor = request.query_params.get("after_seq", request.headers.get("last-event-id", "0"))
    if not raw_cursor.isascii() or not raw_cursor.isdecimal():
        raise APIError(422, "validation_error", "Event cursor must be a non-negative integer")
    try:
        cursor = int(raw_cursor)
    except ValueError:
        raise APIError(422, "validation_error", "Invalid event cursor") from None
    if cursor > state.snapshot.last_seq:
        raise APIError(422, "validation_error", "Event cursor exceeds the latest sequence")
    return StreamingResponse(
        state.log.stream(cursor),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/runs/{run_id}/stats", response_model=StatsResponse)
async def stats(run_id: str, request: Request):
    return compute_stats(get_run(request, run_id).snapshot)
