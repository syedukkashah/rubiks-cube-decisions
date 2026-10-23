# Rubik's Cube Race backend

Python 3.11+, FastAPI, Pydantic v2, async httpx. The public API follows section 5
of `AGENTS.md` on `main` (contract v1.0.0, commit `35f76a4`). All backend files
live here; no frontend or shared-contract edits are required to run it.

## Setup (PowerShell)

Run from this `backend` directory:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `backend/.env`. For offline development, set `MOCK_MODELS=true` and leave
`OPENROUTER_API_KEY` empty. Start the app:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Interactive API docs: <http://localhost:8000/docs>. Health:
<http://localhost:8000/api/v1/health>. CORS defaults to `http://localhost:5173`;
set `CORS_ORIGINS` to a comma-separated list of exact frontend origins.

## Connect OpenRouter later

Set `OPENROUTER_API_KEY` to your key and `MOCK_MODELS=false` in `.env`, then restart
the server. Environment variables take precedence over `.env`. The key is read
at startup, never included in API responses, and `.env` is ignored by Git.
Do not place the key in frontend configuration. No model inference occurs until
you explicitly create a run. Real mode rejects run creation with HTTP 503 when
the key is empty. `/health` reports only whether a key is configured, not whether
it is valid or has credits.

The four model IDs, order, and interfaces match the contract. Availability is
checked through each model's OpenRouter endpoints listing when `/models` or real
run creation is requested, with a 60-second cache. A failed initial check leaves
availability false; later check failures retain the previous result. Unavailable
models cause HTTP 409. You need internet access and OpenRouter credits for real runs.

Official documentation checked on 2026-10-24:

- [Decisions request and response format](https://openrouter.ai/docs/guides/community/multimodal-decisions)
- [Structured chat outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Model endpoints and availability](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model)

The Decisions adapter sends `state` and a named `next_move` choice question with
18 criteria; it reads `answers.next_move.choice` and confidence/probabilities.
The chat adapter uses the same state, instructions, and move definitions with a
strict JSON schema and provider parameter support required. Neither adapter
repairs invalid moves. The runner applies the same timeout/retry/history policy
to both interfaces. These adapters have not been exercised with a live key yet.

## Automated tests (offline)

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
```

Tests use scripted adapters and httpx mock transports; no real key or paid calls
are needed. Coverage includes engine inverses and the normative R example,
deterministic scrambling, exact shortest distances, parsing, retry/timeout
accounting, cancellation, move limits, history windows, stats, schema validation,
and SSE replay. The API integration test runs five puzzles against all four mock
models. The fixture test is explicitly skipped until `/contract/fixtures/*.json`
is supplied. Neither `/contract/openapi.yaml` nor shared fixtures existed on
`main` at implementation time; shared-fixture conformance remains pending.

## Manual smoke test

Start with `MOCK_MODELS=true`. In another PowerShell terminal:

```powershell
$api = 'http://localhost:8000/api/v1'
Invoke-RestMethod "$api/health"
Invoke-RestMethod "$api/models"
$puzzles = Invoke-RestMethod "$api/puzzles" -Method Post -ContentType 'application/json' -Body '{"suite":"primary","count":5,"seed":42}'
$body = @{ puzzle_ids = @($puzzles.puzzles.puzzle_id); concurrency = 1 } | ConvertTo-Json
$run = Invoke-RestMethod "$api/runs" -Method Post -ContentType 'application/json' -Body $body
curl.exe -N "$api/runs/$($run.run_id)/events"
Invoke-RestMethod "$api/runs/$($run.run_id)" | ConvertTo-Json -Depth 12
Invoke-RestMethod "$api/runs/$($run.run_id)/stats" | ConvertTo-Json -Depth 8
```

Expect 20 solved mock trials, ordered events ending with `run_finished`, and a
100% mock success rate. Replay with `?after_seq=3` or header `Last-Event-ID: 3`.
Run with `max_moves=1` to inspect unsuccessful `move_limit` trials. To cancel an
active run, POST `/runs/{run_id}/cancel`; cancelling a finished run returns 409.

For a first **paid** manual test later, switch to real mode, generate one `warmup`
puzzle, and create a run with one model and a small `max_moves` value. Then expand
to the full primary suite after checking events, latency, and error handling.

## Architecture and operational behavior

- `app/engine`: pure 54-facelet permutations in URFDLB order; all 18 HTM moves.
- `app/solver`: complete bidirectional BFS, exact through depth five. Extension
  puzzles have `optimal_distance: null`. Search runs outside the event loop.
- `app/adapters`: shared prompts, real HTTP adapters, catalog checks, mock adapter.
- `app/runner`: one trial loop for every model, concurrency limit, cancellation,
  retry counters, immutable per-run event log, ten-second SSE heartbeats.
- `app/schemas.py`: strict request/response fields; `app/stats.py`: server metrics.
- `app/api`: health, models, puzzles, run snapshots/cancellation, SSE, statistics.

Storage is in memory: use **one Uvicorn worker**. Restarting or reloading clears
puzzles, runs, and event history. Shutdown cancels outstanding work. The API is
intended for local use without authentication. IDs are opaque prefixed UUIDs.

Mock adapters deterministically reverse each scramble and report a fixed 1 ms
accepted-call latency. They know the scramble and are for pipeline testing only;
mock metrics are not evidence of model performance. Trial wall-clock time is
still measured normally.

Clarifications approved during implementation: mock mode bypasses the API-key
requirement; cancellation marks unfinished trials `error` with code `conflict`.
Cancelled trials that never started keep `started_at` and `total_time_s` null.
Completed trials retain their results. Invalid outputs consume retries, not
moves. Exhausted invalid-output retries result in a trial `upstream_error`.

Partial success rates use all configured trials as their denominator; move
latencies include accepted moves so far. Average total time uses trials with
measured elapsed time, and gaps use solved trials with a known optimum. Empty
averages are null. Winner IDs use configuration order to break ties.

Live OpenRouter inference, frontend integration, and shared-fixture validation
are intentionally left for the later testing stage. Setup and implementation
notes are kept here because this work is restricted to `/backend`.
