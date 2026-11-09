# Rubik's Cube Race

**Assignment 02 · Syed Ukkashah · 23K-0055**

Can a fast decision model beat a frontier LLM at solving a Rubik's Cube? This app benchmarks four models
through OpenRouter on the same scrambled cubes and measures speed (per-move latency, total time) and
thinking quality (solved or not, moves used against the exact shortest solution).

## Demo

https://github.com/user-attachments/assets/c4cb2cb6-50bc-40b7-a8f5-df6b847e7e15

The demo plays back a recorded live run (see [Replay vs live](#replay-vs-live)).

## How it works

- **State and action space.** The backend holds a deterministic 3x3 cube engine. Each model gets the
  54-character facelet state, the last six moves and the 18 allowed moves, and returns exactly one move.
- **Models.** Jev 1.13, GPT-6 Luna Decisions and Cloudflare Clef through the OpenRouter Decisions API
  (`/api/alpha/decisions`); Claude Opus 5.5 through chat completions with a strict JSON schema. The same
  question wording, options, history, timeout and retry policy apply to all four.
- **Reference.** For the warm-up and primary puzzles a breadth-first search gives the exact shortest
  distance, and the optimality gap is `model moves - shortest moves`.
- **Rules.** Same scramble per puzzle, at most 30 moves, reaching the limit counts as unsolved. Invalid
  outputs and retries are logged, never silently repaired.
- **Stack.** Python + FastAPI backend (`backend/`), React + Vite + TypeScript frontend (`frontend/`), shared
  API contract in `contract/`. The API key lives only in the backend environment; the browser never sees it.

## Run it (no API key needed)

The repository includes the recording of the live run, so the full UI works offline at no cost.

**1. Backend** (Python 3.11+), from `backend/`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

macOS / Linux: `source .venv/bin/activate`, `pip install -r requirements.txt`, `cp .env.example .env`,
`uvicorn app.main:app --port 8000`.

The template defaults to `MOCK_MODELS=true`, which makes no network calls and needs no key.

**2. Frontend** (a recent Node; developed on Node 22), from `frontend/`:

```bash
npm install
cp .env.example .env     # then set VITE_STUDENT_NAME and VITE_STUDENT_ROLL
npm run dev              # http://localhost:5173
```

`VITE_STUDENT_NAME` and `VITE_STUDENT_ROLL` fill the identity badge shown on every screen; if either is
empty the badge shows a red warning. Restart `npm run dev` after editing `.env`.

**3. Click "Run full benchmark".** With the recording present, the backend replays it, with the same moves,
latencies and results. The race, results and statistics slide views follow the run.

## Environment variables

Templates: [`backend/.env.example`](backend/.env.example) and [`frontend/.env.example`](frontend/.env.example).
Never commit a real key; `backend/.env` is git-ignored.

| Variable | Where | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | backend | Needed only for live runs |
| `MOCK_MODELS` | backend | `true` (default) = no live requests; `false` enables live runs |
| `MAX_SPEND_USD` | backend | Persistent spend cap (default 1.10; settings reject above 2.00) |
| `CHAT_MAX_TOKENS` | backend | Opus output cap including reasoning (64-512) |
| `RECORDING_PATH` | backend | Where the live recording is written and replayed from |
| `VITE_STUDENT_NAME`, `VITE_STUDENT_ROLL` | frontend | Identity badge |
| `VITE_USE_MOCKS` | frontend | `true` = UI runs on fixtures with no backend |

The full list with defaults is in [`backend/README.md`](backend/README.md) and
[`frontend/README.md`](frontend/README.md).

## Replay vs live

| Source | What it does | Cost |
|---|---|---|
| `simulated` | Deterministic personas, for previewing the UI | none |
| `live` | Real OpenRouter calls. Needs `MOCK_MODELS=false`, a key and explicit cost confirmation | spends money |
| `replay` | Re-emits the saved live recording (`backend/recordings/benchmark.json`) | none |

`auto` (the default) replays the recording if one exists, else simulates; it never starts a paid run. A live
run is refused while a recording exists unless `ALLOW_LIVE_RERUN=true`. The demo video shows a replay of the
recorded run, not a new run.

## Results of the recorded live run

Warm-up (1 puzzle, shortest solution 3) and primary (5 puzzles, shortest solutions 5, 5, 4, 5, 5; 20 trials).
Session cost $0.42.

| Model | Primary solved | Avg latency per move | Avg time per trial | Total moves | Optimality gap |
|---|---|---|---|---|---|
| Jev 1.13 | 0 / 5 | 571 ms | 19.0 s | 150 | n/a |
| GPT-6 Luna Decisions | 0 / 5 | 533 ms | 15.7 s | 127 | n/a |
| Cloudflare Clef | 0 / 5 | 926 ms | 30.0 s | 150 | n/a |
| Claude Opus 5.5 | 0 / 5 | 2,100 ms | 67.2 s | 150 | n/a |

- Every primary trial ended at the 30-move limit, except one Luna trial that failed after 7 moves with an
  upstream provider error (counted as an error, not a solve).
- In the warm-up Opus solved the puzzle in 3 moves (the optimum, gap 0); the other three models hit the limit.
- Luna had the lowest average latency per move; nobody solved a primary puzzle, so there is no solve-rate
  winner and no optimality gap to compare.
- The sample is small (5 primary puzzles, one repetition) and the extension suite (15-20 turn scrambles)
  was not run.

## Deviations and limits

- **Budget.** The assignment budget was $1.20. A $2.00 ceiling was approved for this run, using a
  rolling per-puzzle admission check instead of pricing the whole session up front. Total spend across all
  attempts, including failed ones, was about $0.55.
- **Opus configuration.** Opus runs at the lowest reasoning effort (`low`) with a 512-token output cap. At
  lower caps (128, 336) its reasoning used the whole allowance and it returned no move. The cap is a cost
  control, not a measure of model ability.
- **Prompt.** All four models share a short instruction that asks for an immediate move without
  deliberation; it was tightened during development after early Opus truncations.
- **Timeout.** The per-call timeout is 20 s for every model.
- **Earlier attempts.** Four earlier live sessions failed before the recorded one: a warm-up stopped by the
  Opus truncation gate at a 128-token cap, a run that hit an account with no credit, and two that were rejected
  for an invalid API key. Their cost is included in the total above.

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | FastAPI app, cube engine, BFS solver, model adapters, spend ledger, tests, [`recordings/`](backend/recordings) |
| `frontend/` | React UI (setup, race, results, statistics slide) and tests |
| `contract/` | OpenAPI spec and fixtures shared by both sides |
| `AGENTS.md`, `docs/` | Architecture plan, API contract notes, UI design specs, handoff log |

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest -q     # 316 tests, offline
cd frontend && npm test                             # 79 tests
```

Backend tests never make network requests. Details for each side are in `backend/README.md` and
`frontend/README.md`.
