# AGENTS.md — Rubik's Cube Race (Assignment 02)

This file is the single source of truth for every AI coding agent working in this repository.
Read it fully before touching any file. If anything here conflicts with a chat instruction, stop and ask the human.

Source requirements: `assignment-02.pdf` (AI Engineering, Assignment 02, "Rubik's Cube Race").

---

## 1. Project summary

Build an AI-powered Rubik's Cube benchmark that answers one question: **is a model that decides in milliseconds more useful than a frontier LLM that plans longer but may need fewer moves?**

Four models play the same scrambled 3×3 cube through OpenRouter. Each picks one move per turn until the cube is solved or **30 moves** have been used.

| Model | Category | OpenRouter model ID | Interface |
|---|---|---|---|
| Jev 1.13 | System-1 decision model | `typesafe/jev-1.13` | Decisions API (`POST https://openrouter.ai/api/alpha/decisions`) |
| GPT-6 Luna Decisions | System-1 decision model | `openai/gpt-6-luna-decisions` | Decisions API |
| Cloudflare Clef | System-1 decision model | `cloudflare/clef` | Decisions API |
| Claude Opus 5.5 | Frontier LLM | `anthropic/claude-opus-5.5` | Chat completions (`POST https://openrouter.ai/api/v1/chat/completions`) |

Model IDs, availability, routing and the Decisions API schema can change. **Verify them against current OpenRouter docs before implementing the adapters** (backend agent). Report any divergence through the contract-change protocol (section 7).

The app must show: a scrambled cube, a "run benchmark" button, each model's current move, a move history, and a final result that clearly says *solved* or *move limit reached*. It must also show a benchmark dashboard with, per model: per-move average latency, total solve time, total number of moves, success rate (%), and optimality gap.

---

## 2. Dual-agent architecture (strict)

| Agent | Owns | May create/edit | Must never touch |
|---|---|---|---|
| **Codex** | Backend | `/backend/**` | `/frontend/**` |
| **Claude Code** | Frontend | `/frontend/**` | `/backend/**` |
| **Shared** | API contract | `/contract/**` (only via section 7) | — |

Repository layout (created progressively, not all at once):

```
/
├── AGENTS.md              # this file (human-approved changes only)
├── assignment-02.pdf      # requirements
├── README.md              # setup + run instructions (human or whichever agent finishes last; see section 11)
├── contract/              # shared, versioned API contract
│   ├── openapi.yaml       # machine-readable contract (mirrors section 5)
│   └── fixtures/          # canonical example JSON payloads, used by backend tests and frontend mock mode
├── backend/               # Codex only — Python 3.11+, FastAPI
├── frontend/              # Claude Code only — React + Vite + TypeScript
└── docs/HANDOFF.md        # append-only notes between agents
```

### Role rules

1. **Codex = backend only.** Cube engine, scramble generator, BFS shortest-path solver, OpenRouter adapters, benchmark runner, statistics, FastAPI routes, backend tests, `backend/.env.example`.
2. **Claude Code = frontend only.** Cube rendering, benchmark controls, live move display, history, result banner, statistics dashboard, final benchmark slide, student identity overlay, frontend tests.
3. Neither agent edits the other's directory, not even for a "tiny fix". Put the request in `docs/HANDOFF.md` instead.
4. Neither agent changes `/contract/**` unilaterally. The contract is the only coupling between the two halves.
5. The frontend talks **only** to the backend (`/api/v1/*`). It never calls OpenRouter and never holds an API key.
6. The backend owns all game logic. The frontend never validates, applies or computes moves, never computes statistics, and never derives "solved" itself. It renders what the backend reports.
7. If your task needs something from the other side that the contract does not provide, stop, write the need into `docs/HANDOFF.md` and propose a contract change. Do not work around it.

---

## 3. Non-negotiable rules from the assignment

1. **Fairness.** Every model starts from the same scramble per puzzle, uses the same engine, the same move definitions, the same question wording and option definitions (only the model ID changes), the same recent-move history policy, and the same timeout and retry policy.
2. **Move limit.** Maximum 30 moves per trial. Reaching the limit without a solved cube is an **unsuccessful** attempt, never a solved one.
3. **Validation.** Every model output is validated before it reaches the engine. A malformed or illegal move is logged and counted (`invalid_move_count`), never silently coerced into a real move.
4. **Determinism.** The engine is deterministic. A scramble is reproducible from `seed` + `scramble_length`.
5. **Optimality gap.** `optimality_gap = model_moves − exact_shortest_moves`. The exact shortest distance comes from a complete shortest-path search (BFS) on the primary suite. Gap `0` means optimal.
6. **Key security.** `OPENROUTER_API_KEY` lives only in a backend environment variable. It is never in frontend code, never in a response body, never logged, never committed. Only `backend/.env.example` (placeholder values) is committed. `.env` must be in `.gitignore`.
7. **Transparency.** Log retries, timeouts and invalid outputs explicitly; they appear in the data the frontend receives.
8. **No model substitution.** A trial is played only by the model it names. Never fall back to another model (e.g. a cheaper or older one) on an error, and never invent a confidence value. A failed call is a counted failure (section 6.1).
9. **Cost guardrails.** Live OpenRouter spend is capped and pre-checked as specified in section 6.1. Mock mode is the default.
10. **Identity overlay.** The submission demo requires the student's name and roll number visible on screen the entire time (frontend responsibility, section 9).

---

## 4. Domain definitions (normative for both agents)

### 4.1 Move set (HTM face-turn metric, 18 moves)

```
U U' U2   D D' D2   L L' L2   R R' R2   F F' F2   B B' B2
```

- `X` = 90° clockwise looking at face X, `X'` = 90° counter-clockwise, `X2` = 180°.
- A move is exactly one of those 18 strings (case-sensitive, ASCII apostrophe `'`). Anything else is invalid.
- Move count and optimal distance are both measured in this metric. Do not mix metrics.

### 4.2 Cube state: 54-character facelet string

- Kociemba order: faces `U R F D L B`, each 9 facelets, row-major as seen from outside the face.
- Alphabet: `U R F D L B` (each letter = the face whose centre that colour belongs to).
- Solved state: `UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB`
- Example (solved cube after one `R` move): `UUFUUFUUFRRRRRRRRRFFDFFDFFDDDBDDBDDBLLLLLLLLLUBBUBBUBB`
- "Solved" means all six faces are uniform, which for a valid cube equals the solved string above.

### 4.3 Test suites

| `suite` | Scramble length | Purpose | `optimal_distance` |
|---|---|---|---|
| `warmup` | 3–4 random turns | Verify adapters, validation, engine | computed (BFS) |
| `primary` | 4–5 random turns | Main comparison; exact optimum computable | computed (BFS), integer |
| `extension` | 15–20 random turns | Behaviour on harder states, failure rates | `null` (not computed) |

Minimum sample: 5 primary puzzles × 4 models = 20 trials (10+ puzzles recommended). A scramble must not contain two consecutive moves on the same face, and the scrambled state must not be solved.

### 4.4 Metric definitions

| Metric | Definition |
|---|---|
| `move_latency_ms` | Wall-clock time of the **accepted** model call for one move (request sent → parsed response), excluding retries of invalid outputs. |
| `avg_move_latency_ms` | Mean of `move_latency_ms` over all accepted moves of a model in the run. |
| `total_time_s` (trial) | Wall-clock seconds from trial start to a terminal state (solved, move limit, or error), **including** retries and engine time. |
| `avg_total_time_s` (model) | Mean `total_time_s` over that model's trials. |
| `moves_used` | Number of valid moves applied to the cube. Invalid outputs do not consume a move. |
| `solved` | Cube is solved at the end of the trial and `moves_used ≤ 30`. |
| `success_rate_pct` | `100 × solved trials / total trials` for the model. |
| `optimality_gap` (trial) | `moves_used − optimal_distance`; only for **solved** trials on puzzles with a non-null optimum; otherwise `null`. |
| `avg_optimality_gap` (model) | Mean over trials with a non-null gap; `null` if there are none. |

---

## 5. JSON API contract (v1.1.0)

The contract below is normative. Both agents implement exactly this. When `/contract/openapi.yaml` is created it must mirror this section field for field; if the two ever disagree, **this file wins until fixed**.

**Changelog.** `1.1.0` (2026-10-24, human-approved, cost guardrails): run defaults `timeout_s` 60 → 15 and `max_retries` 2 → 1; `POST /runs` may return `409 conflict` when the spend pre-check fails (section 6.1). No field, type or enum changes.

### 5.1 Conventions

- Base URL: `http://localhost:8000/api/v1`. Frontend dev server (`http://localhost:5173`) uses a Vite proxy for `/api`. CORS allows only the frontend origin(s) from `CORS_ORIGINS`.
- Content type: `application/json; charset=utf-8` (except the SSE stream, section 5.7).
- Field names: `snake_case`. Enum values: lowercase `snake_case` (move strings and facelet strings excepted).
- Timestamps: ISO-8601 UTC with `Z` suffix, e.g. `2026-10-24T09:30:00Z`.
- Durations: `*_ms` = milliseconds (number), `*_s` = seconds (number). No other units.
- IDs: opaque strings. Frontend must not parse them. Format used by backend: `pz_*`, `run_*`, `tr_*`.
- Unknown fields: the frontend **ignores** unknown response fields; the backend **rejects** unknown request fields with `422`.
- Nullable fields are always present with explicit `null`, never omitted. Optional request fields may be omitted.
- No authentication in v1 (local benchmark tool). The API never returns the OpenRouter key or any header carrying it.

### 5.2 Error envelope

Every non-2xx response has this shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "max_moves must be between 1 and 30",
    "details": { "field": "max_moves" }
  }
}
```

| `code` | HTTP | Meaning |
|---|---|---|
| `validation_error` | 422 | Bad request body or query |
| `not_found` | 404 | Unknown puzzle / run / trial |
| `conflict` | 409 | Action impossible in current state (e.g. cancel a finished run) |
| `missing_api_key` | 503 | `OPENROUTER_API_KEY` not set on the backend |
| `upstream_error` | 502 | OpenRouter returned an error after retries |
| `upstream_timeout` | 504 | OpenRouter call exceeded `timeout_s` after retries |
| `internal_error` | 500 | Unexpected backend failure |

`details` is optional (`null` allowed).

### 5.3 `GET /health`

```json
{
  "status": "ok",
  "contract_version": "1.1.0",
  "api_key_configured": true
}
```

`api_key_configured` is a boolean only; never the key.

### 5.4 `GET /models`

Returns the four benchmarked models in a fixed order.

```json
{
  "models": [
    {
      "id": "typesafe/jev-1.13",
      "label": "Jev 1.13",
      "category": "decision",
      "interface": "decisions_api",
      "available": true
    },
    {
      "id": "openai/gpt-6-luna-decisions",
      "label": "GPT-6 Luna Decisions",
      "category": "decision",
      "interface": "decisions_api",
      "available": true
    },
    {
      "id": "cloudflare/clef",
      "label": "Cloudflare Clef",
      "category": "decision",
      "interface": "decisions_api",
      "available": true
    },
    {
      "id": "anthropic/claude-opus-5.5",
      "label": "Claude Opus 5.5",
      "category": "frontier",
      "interface": "chat_completions",
      "available": true
    }
  ]
}
```

- `category`: `decision` | `frontier`.
- `interface`: `decisions_api` | `chat_completions`.
- `available`: result of the backend's last availability check (may be `false` if OpenRouter no longer lists the model). A run that includes an unavailable model is rejected with `409 conflict`.

### 5.5 Puzzles

**`POST /puzzles`** — generate and store puzzles.

Request:

```json
{
  "suite": "primary",
  "count": 5,
  "scramble_length": null,
  "seed": 42
}
```

- `suite`: `warmup` | `primary` | `extension` (required).
- `count`: 1–50 (required).
- `scramble_length`: optional integer; must lie within the suite's range (4.3). `null`/omitted = random within the range.
- `seed`: optional integer for reproducibility; `null`/omitted = random.

Response `201`:

```json
{
  "puzzles": [
    {
      "puzzle_id": "pz_01",
      "suite": "primary",
      "scramble_moves": ["R", "U", "F'", "D2"],
      "facelets": "<54-character facelet string>",
      "optimal_distance": 4,
      "created_at": "2026-10-24T09:30:00Z"
    }
  ]
}
```

- `scramble_moves`: the exact moves applied to the solved cube to produce `facelets`.
- `optimal_distance`: exact BFS distance (integer) for `warmup` and `primary`; `null` for `extension`. Note it can be smaller than `len(scramble_moves)`.

**`GET /puzzles?suite=primary`** — list stored puzzles (`suite` filter optional). Response: `{ "puzzles": [ ...Puzzle ] }`.

**`GET /puzzles/{puzzle_id}`** — single `Puzzle` object (the item shape above). `404 not_found` if unknown.

### 5.6 Runs

A **run** = a set of puzzles × a set of models. Each (puzzle, model) pair is one **trial**.

**`POST /runs`** — start a benchmark. Returns immediately; execution is asynchronous.

Request:

```json
{
  "puzzle_ids": ["pz_01", "pz_02", "pz_03", "pz_04", "pz_05"],
  "model_ids": [
    "typesafe/jev-1.13",
    "openai/gpt-6-luna-decisions",
    "cloudflare/clef",
    "anthropic/claude-opus-5.5"
  ],
  "max_moves": 30,
  "timeout_s": 15,
  "max_retries": 1,
  "history_window": 6,
  "concurrency": 1
}
```

| Field | Type | Default | Rules |
|---|---|---|---|
| `puzzle_ids` | string[] | required | ≥ 1, all must exist |
| `model_ids` | string[] | all four | ≥ 1, subset of `/models` ids, all `available` |
| `max_moves` | int | `30` | 1–30 |
| `timeout_s` | number | `15` | per OpenRouter call; same for every model; must be ≤ `MAX_TIMEOUT_S` (6.1), else `422` |
| `max_retries` | int | `1` | retries per move for retryable failures (6.1) **and** invalid outputs; same for every model; must be ≤ `MAX_RETRIES_CAP` (6.1), else `422` |
| `history_window` | int | `6` | number of most recent moves sent to every model as `recent_moves` |
| `concurrency` | int | `1` | parallel trials, 1–4. Default `1` so latency numbers are not distorted by contention |

Response `202`:

```json
{
  "run_id": "run_01",
  "status": "queued"
}
```

In real (non-mock) mode, run creation is rejected with `409 conflict` if the worst-case cost estimate exceeds the remaining spend budget (section 6.1). `details`: `{ "estimated_max_cost_usd": 1.67, "remaining_budget_usd": 0.85 }`.

**`GET /runs`** — `{ "runs": [ { "run_id", "status", "created_at", "finished_at" } ] }`, newest first.

**`GET /runs/{run_id}`** — full snapshot (used on page load / reconnect):

```json
{
  "run_id": "run_01",
  "status": "running",
  "config": {
    "puzzle_ids": ["pz_01"],
    "model_ids": ["anthropic/claude-opus-5.5"],
    "max_moves": 30,
    "timeout_s": 15,
    "max_retries": 1,
    "history_window": 6,
    "concurrency": 1
  },
  "created_at": "2026-10-24T09:30:00Z",
  "started_at": "2026-10-24T09:30:01Z",
  "finished_at": null,
  "last_seq": 7,
  "trials": [
    {
      "trial_id": "tr_01",
      "run_id": "run_01",
      "puzzle_id": "pz_01",
      "model_id": "anthropic/claude-opus-5.5",
      "status": "running",
      "initial_facelets": "<54-character facelet string>",
      "current_facelets": "<54-character facelet string>",
      "moves": [
        {
          "index": 1,
          "move": "R'",
          "facelets_before": "UUFUUFUUFRRRRRRRRRFFDFFDFFDDDBDDBDDBLLLLLLLLLUBBUBBUBB",
          "facelets_after": "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB",
          "latency_ms": 5321.4,
          "confidence": null,
          "retries": 0
        }
      ],
      "moves_used": 1,
      "solved": true,
      "invalid_move_count": 0,
      "retry_count": 0,
      "timeout_count": 0,
      "total_time_s": 5.4,
      "optimal_distance": 1,
      "optimality_gap": 0,
      "started_at": "2026-10-24T09:30:01Z",
      "finished_at": "2026-10-24T09:30:07Z",
      "error": null
    }
  ]
}
```

- Run `status`: `queued` | `running` | `completed` | `cancelled` | `failed`.
- Trial `status`: `pending` | `running` | `solved` | `move_limit` | `error`.
  - `solved`: cube solved within the limit.
  - `move_limit`: `max_moves` valid moves applied, cube not solved (an **unsuccessful** attempt).
  - `error`: retries exhausted without a valid move, or an unrecoverable upstream failure. Counted as unsuccessful. `error` is `{ "code": "...", "message": "..." }` (codes from 5.2), otherwise `null`.
- `moves[]` contains **applied (valid)** moves only. Invalid outputs are reported through events (5.7) and aggregated in `invalid_move_count`.
- `confidence`: a number in [0, 1] if the model's response supplies a confidence/probability, else `null`.
- `retries` (on a move): number of retries spent before this move was accepted.
- Any field that does not apply yet is `null` (e.g. `finished_at`, `optimality_gap` while running).
- `last_seq` is the highest SSE `seq` already reflected in this snapshot (used to resume the stream without gaps).

**`POST /runs/{run_id}/cancel`** — stop a queued/running run. Response `200`: `{ "run_id": "...", "status": "cancelled" }`. `409 conflict` if already terminal.

### 5.7 Live events: `GET /runs/{run_id}/events` (Server-Sent Events)

- `Content-Type: text/event-stream`. Each SSE message: `id: <seq>`, `event: <type>`, `data: <JSON envelope>`.
- Heartbeat comment line (`: ping`) at least every 15 s.
- Supports resume: client reconnects with `Last-Event-ID` header (or `?after_seq=<n>`); backend replays all events with `seq` greater than that, then continues live. The stream closes after `run_finished`.
- Envelope (identical for every event type):

```json
{
  "seq": 12,
  "type": "move_applied",
  "run_id": "run_01",
  "trial_id": "tr_01",
  "ts": "2026-10-24T09:30:06Z",
  "data": {}
}
```

`seq` is a per-run strictly increasing integer starting at 1. `trial_id` is `null` for run-level events.

| `type` | `data` payload |
|---|---|
| `run_started` | `{ "trial_count": 20 }` |
| `trial_started` | `{ "puzzle_id": "pz_01", "model_id": "...", "initial_facelets": "..." }` |
| `move_requested` | `{ "move_index": 1, "attempt": 1 }` (attempt is 1 + retries so far) |
| `move_invalid` | `{ "move_index": 1, "attempt": 1, "reason": "illegal_move", "raw_response": "R3" }` — `reason`: `illegal_move` \| `malformed_response` \| `timeout` \| `upstream_error` |
| `move_applied` | the full `MoveRecord` from 5.6 plus `{ "moves_used": 1, "solved": false }` |
| `trial_finished` | the full `Trial` object from 5.6 (terminal status) |
| `run_finished` | `{ "status": "completed", "finished_at": "..." }` (`status` may also be `cancelled` or `failed`) |
| `error` | `{ "code": "upstream_error", "message": "..." }` (run-level fatal error; followed by `run_finished` with `failed`) |

### 5.8 Statistics: `GET /runs/{run_id}/stats`

Available while the run is in progress (partial) and after it ends. Stats are computed by the backend only.

```json
{
  "run_id": "run_01",
  "run_status": "completed",
  "models": [
    {
      "model_id": "typesafe/jev-1.13",
      "label": "Jev 1.13",
      "category": "decision",
      "trials": 5,
      "solved_trials": 4,
      "success_rate_pct": 80.0,
      "avg_move_latency_ms": 212.5,
      "avg_total_time_s": 3.1,
      "total_moves": 21,
      "avg_moves_per_trial": 4.2,
      "avg_optimality_gap": 0.5,
      "invalid_move_count": 1,
      "retry_count": 2,
      "timeout_count": 0
    }
  ],
  "questions_answered": {
    "fastest_model_id": "typesafe/jev-1.13",
    "highest_solve_rate_model_id": "anthropic/claude-opus-5.5",
    "best_optimality_gap_model_id": "anthropic/claude-opus-5.5",
    "fastest_is_also_best_quality": false
  }
}
```

- One `models[]` entry per model in the run, same order as `config.model_ids`.
- `total_moves`: sum of `moves_used` over the model's trials.
- `success_rate_pct`, `avg_move_latency_ms`, `avg_total_time_s`, `avg_moves_per_trial` and `avg_optimality_gap` are `number | null`: `null` while there is nothing to average yet (e.g. no finished trials, or no accepted moves, during a partial run). Counts (`trials`, `solved_trials`, `total_moves`, `invalid_move_count`, `retry_count`, `timeout_count`) are always integers.
- Ties in `questions_answered` resolve to the model listed first; a field is `null` if it cannot be determined yet.
- `fastest_model_id` = lowest `avg_move_latency_ms`. `best_optimality_gap_model_id` = lowest non-null `avg_optimality_gap`. `fastest_is_also_best_quality` is `true` only if the fastest model also has both the highest `success_rate_pct` and the lowest `avg_optimality_gap`.

### 5.9 Backend ↔ OpenRouter adapter contract (internal, backend only)

Both adapters implement the same internal interface and return the same normalized result, so the engine and API cannot tell them apart:

```
choose_move(state: facelets, recent_moves: list[str], allowed_moves: list[str], timeout_s) -> {
  move: str | null,         # null when unparseable
  confidence: float | null,
  latency_ms: float,
  raw_response: str
}
```

- **Decisions API** (`typesafe/jev-1.13`, `openai/gpt-6-luna-decisions`, `cloudflare/clef`): send `state` = `{ "cube_facelets": "<54 chars>", "recent_moves": [...] }` and one `choice` question named `next_move` whose `criteria` maps each of the 18 moves to a human-readable description. Question `instructions` and criteria text are one shared constant; only `model` changes. Capture a confidence/probability field if the response has one.
- **Chat completions** (`anthropic/claude-opus-5.5`): send the same state, the same 18 allowed moves and the same recent-move window, and require exactly `{"move": "R'"}` via structured-output / JSON-schema constraint where the route supports it. Total output (adaptive thinking + answer) is hard-capped with `max_tokens` at the lowest effort level, `temperature: 0`, per section 6.1 G2.
- Validation: the returned move must be in the 18-move set. Otherwise it is an invalid output: log it, count it, retry per policy, never substitute a move. A truncated chat response (`finish_reason: "length"` or empty content) is a `malformed_response`.
- Both adapters also return the response's `usage` (`input/prompt tokens`, `output/completion tokens`, `reasoning_tokens` if present, `cost`) to the runner for the spend ledger (6.1). This is internal only and never appears in API responses.

---

## 6. Backend spec — owned by Codex (`/backend`)

**Stack:** Python 3.11+, FastAPI, Uvicorn, Pydantic v2, httpx (async), pytest. An established cube library (e.g. a Kociemba-compatible one) may be used for state/rotation logic; the move set and facelet format in section 4 are authoritative regardless of library.

**Suggested layout:**

```
backend/
├── app/
│   ├── main.py            # FastAPI app, CORS, router mounting under /api/v1
│   ├── config.py          # env loading (OPENROUTER_API_KEY, CORS_ORIGINS, defaults)
│   ├── schemas.py         # Pydantic models matching section 5 exactly
│   ├── engine/            # facelet state, apply_move, is_solved, scramble generator
│   ├── solver/            # BFS shortest distance (depth ≤ 5 is enough for warmup/primary)
│   ├── adapters/          # decisions_api.py, chat_completions.py, shared prompt/option constants
│   ├── runner/            # trial loop, retry/timeout policy, move-limit logic, event bus
│   ├── stats.py           # aggregates for section 5.8
│   └── api/               # routers: health, models, puzzles, runs, events, stats
├── tests/
├── requirements.txt
└── .env.example           # all variables in 6.1, with MOCK_MODELS=true and placeholder key
```

**Responsibilities and rules**

1. Pydantic schemas must reproduce section 5 field names, types, nullability and enums exactly. Response models forbid extra fields; request models reject unknown fields.
2. Engine: `apply_move` is pure and deterministic; reject any move not in the 18-move set; `is_solved` checks all six faces uniform. Scramble generation follows 4.3 and is reproducible from `seed`.
3. Solver: BFS (or another complete shortest-path method) over the 18-move HTM graph from the scrambled state to solved, giving the exact optimum for `warmup` and `primary` puzzles. Unit-test it against hand-checked scrambles (e.g. scramble `R` ⇒ optimum 1; a 5-move scramble ⇒ optimum ≤ 5).
4. Runner: identical loop for all models — build state → call adapter → validate → apply → emit events → stop on solved / `max_moves` / unrecoverable error. Same `timeout_s`, `max_retries`, `history_window` for every model. Invalid outputs consume retries, not moves.
5. Event bus: every state change emits a section 5.7 event with a per-run increasing `seq`; keep the full log in memory (or SQLite) so `Last-Event-ID` replay works.
6. Persist runs/puzzles in memory or SQLite; results must survive long enough for the dashboard and for `GET /runs/{id}` after completion.
7. The API key is read from `OPENROUTER_API_KEY` at startup. Missing key ⇒ `/health.api_key_configured=false` and run creation returns `503 missing_api_key`. Never log or return the key; scrub `Authorization` headers from any logged request.
8. Provide a deterministic **mock adapter** (selectable via `MOCK_MODELS=true`) so the full pipeline and tests run without network or spend. It must produce the same JSON as real adapters. Mock mode is the **default** (6.1).
9. Tests (pytest) must cover: engine moves and inverses, scramble reproducibility, BFS correctness, move validation (valid / illegal / malformed), retry and timeout policy, move-limit ⇒ unsuccessful, stats arithmetic, SSE ordering/replay, and schema conformance against `/contract/fixtures`.
10. Backend README section: install, `.env` setup, `uvicorn app.main:app --reload --port 8000`, `pytest`.
11. Implement the cost guardrails in section 6.1.

### 6.1 Cost guardrails — backend refactor (Codex)

**Goal:** run the **full benchmark once** (section 6.2: warm-up, 10-puzzle primary, extension) for an expected **~$1.10** of OpenRouter spend including the credit-purchase fee (range ~$0.40–$3.60), under a hard ceiling of **$5.00**. Opus 5.5 cannot run without thinking; see G2. All four models still play under identical rules. Almost all spend comes from Claude Opus 5.5, mostly its output and reasoning tokens if left uncapped. The three Decisions models cost fractions of a cent per run because they return no output tokens. The guardrails therefore focus on (a) keeping Opus's always-on thinking as short as possible and hard-capping its total output, (b) keeping prompts short, (c) bounding call counts, (d) refusing runs that could exceed a hard budget, and (e) never paying twice for the same run (G11–G13).

Reference prices, checked 2026-10-24. Re-verify them on the OpenRouter model pages before the first live run, and keep them in one table in `config.py`:

| Model | Input $/1M | Output $/1M |
|---|---|---|
| `typesafe/jev-1.13` | 0.042 | 0 |
| `openai/gpt-6-luna-decisions` | 0.10 | 0 |
| `cloudflare/clef` | 0.042–0.24 (by provider; estimate with 0.24) | 0 |
| `anthropic/claude-opus-5.5` | 4.00 | 20.00 |

#### G1. Environment variables (all in `backend/.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | empty | Unchanged; never logged or returned |
| `MOCK_MODELS` | `true` (also the code default when unset) | Live calls happen only when explicitly set to `false`. Log a loud `MOCK MODE`/`LIVE MODE` banner at startup. |
| `MAX_SPEND_USD` | `5.00` | Hard spend cap across all live runs (persisted ledger, G5). Sized so every 6.2 step passes the worst-case pre-check; expected real spend is ~25% of it. |
| `MAX_LIVE_CALLS` | `2000` | Hard cap on live inference HTTP attempts (persisted ledger). Runaway-loop backstop. |
| `CHAT_MAX_TOKENS` | `256` (provisional until G7 calibration) | `max_tokens` for the chat adapter. Hard limit on thinking + answer combined. Must be 64–512. |
| `CHAT_REASONING_EFFORT` | `low` | Value sent as `reasoning.effort` to Opus. `low` is the lowest level Opus 5.5 accepts. Allowed: `low`, or `omit` (no `reasoning` field) via the G2 compatibility fallback. Anything else needs human approval (G10). |
| `MAX_TIMEOUT_S` | `20` | Upper bound accepted for `RunConfig.timeout_s` |
| `MAX_RETRIES_CAP` | `1` | Upper bound accepted for `RunConfig.max_retries` |
| `SPEND_LEDGER_PATH` | `backend/.spend/ledger.jsonl` | Spend ledger file; the `.spend/` directory is git-ignored |
| `RUNS_DIR` | `backend/.runs` | Persisted puzzles, run snapshots and event logs (G11); git-ignored |
| `ALLOW_LIVE_RERUN` | `false` | When `false`, a live run identical to an already-completed live run is refused (G12) |

Settings parsing must reject non-numeric or negative values at startup with a clear error.

#### G2. Chat adapter (Opus) — lowest effort + total-output hard cap

**Fact (verified 2026-10-24):** Opus 5.5 always runs with adaptive thinking and it cannot be disabled. Anthropic rejects `thinking: {"type": "disabled"}` and manual budgets with HTTP 400 ([migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)). OpenRouter rejects `reasoning.effort: "none"` for Claude and maps `minimal` to `low` ([reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)). Effort (`low`…`max`, default `medium`) is the only thinking control. `max_tokens` is a hard limit on thinking + answer combined, and thinking is billed as output.

So the guardrail is: **lowest effort, a short-answer instruction, and a hard total-output cap.** Request body additions to the existing chat-completions request:

```json
{
  "max_tokens": 256,
  "temperature": 0,
  "reasoning": { "effort": "low", "exclude": true },
  "response_format": { "type": "json_schema", "json_schema": { "...": "unchanged strict schema" } },
  "provider": {
    "require_parameters": true,
    "max_price": { "prompt": 4, "completion": 20 }
  }
}
```

- `max_tokens` = `CHAT_MAX_TOKENS`, `reasoning.effort` = `CHAT_REASONING_EFFORT`. Never send `"none"` and never send a `thinking` object.
- `exclude: true` only hides the thinking text from the response. It is still billed. Its purpose is to keep `raw_response` small.
- `max_price` keeps routing off the $8/$40 fast endpoint and the $4.40/$22 EU endpoints. If OpenRouter rejects `temperature` alongside thinking for this route, drop `temperature` and note it in the README. Do not drop `max_price`.
- Chat-only output-format line (appended after the shared `INSTRUCTIONS`, see G3): `Reply immediately with only {"move":"<one allowed move>"}. No explanation.` This steers adaptive thinking to stay short. It is part of the chat output-format requirement, not the shared state or options, so fairness rule 3.1 holds. Document it in the README.
- `finish_reason == "length"`, empty `content`, or content that fails the strict schema ⇒ `malformed_response`. It is counted and retried per policy, never repaired. Truncations caused by thinking hitting the cap are real Opus failures under this configuration and are reported as such.
- Record `usage.completion_tokens` and `usage.completion_tokens_details.reasoning_tokens` for every Opus call in the ledger (G5).
- **Compatibility fallback (decided now, no need to ask):**
  - If OpenRouter returns 400 for `reasoning.effort: "low"` together with a small `max_tokens` (e.g. it derives a 1,024-token minimum budget), retry the smoke test once **without** the `reasoning` field, keeping `max_tokens` and the short-answer line.
  - If that works, make "omit `reasoning`" the configured behaviour (`CHAT_REASONING_EFFORT=omit`) and record it in the README.
  - If both fail, stop and ask the human.
- **Stop and ask the human** if calibration (G7) shows a truncation rate above 20% at `CHAT_MAX_TOKENS=512`, or the measured Opus cost per call exceeds $0.012. Never raise `CHAT_MAX_TOKENS` above 512 or effort above `low` on your own.

#### G3. Compact shared prompt (both interfaces)

- Rewrite `app/adapters/prompts.py` so the shared `INSTRUCTIONS` is at most ~60 tokens and each of the 18 `CRITERIA` values is a short phrase, e.g. `"U": "Up face 90° clockwise"`, `"U'": "Up face 90° counter-clockwise"`, `"U2": "Up face 180°"`. Keep the facelet-format explanation to one sentence (URFDLB order, 9 row-major stickers per face, letter = home-centre face).
- Both adapters keep using the **same** constants (fairness rule 3.1). Chat system prompt = `INSTRUCTIONS` + the G2 short-answer line + the criteria JSON. User message = the state JSON only. No examples, no chain-of-thought request, no extra prose.
- Serialize JSON compactly (`separators=(",", ":")`).
- `recent_moves` stays capped by `history_window` (default 6), which is already enforced in the runner.
- Budget: Opus `usage.prompt_tokens` should be **≤ 250** per call. Enforce it in a unit test that builds both request bodies and asserts `len(json.dumps(body))` ≤ 1,100 characters for the chat payload. Record the real `prompt_tokens` from the G7 smoke test in the backend README.

#### G4. Retry and error policy (identical for every model)

| Condition | Retry? | Effect |
|---|---|---|
| Client timeout, HTTP 408, 429, 500, 502, 503, 504 | Yes, up to `max_retries`, with backoff 0.5 s × 2^attempt (429: honour `Retry-After` if ≤ 10 s) | `timeout`/`upstream_error` event as today |
| Invalid output (`malformed_response`, `illegal_move`) | Yes, up to `max_retries` | Unchanged (consumes retries, not moves) |
| HTTP 400, 403, 404, 422 | **No** | Trial ends `error` (`upstream_error`). Same request would fail again. |
| HTTP 401 (bad key) or 402 (out of credits) | **No** | **Abort the whole run:** run-level `error` event (`upstream_error`, message says "invalid key" / "insufficient credits"), remaining trials `error`, run `failed`. |
| Spend or call cap reached mid-run (G5) | **No** | Abort the whole run the same way; code `conflict`, message `"Live spend cap reached"` / `"Live call cap reached"`. |

- Every HTTP attempt to an inference endpoint counts toward `MAX_LIVE_CALLS`, including retries. Availability checks (`GET /models/{id}/endpoints`) are free and do not count.
- Timeouts count too: OpenRouter may still bill a request the client abandoned.

#### G5. Spend ledger and budget enforcement

- `app/budget.py`: one `SpendLedger` per process, shared by all runs, guarded by an `asyncio.Lock`.
- After every live inference response (success or invalid output), append one JSON line to `SPEND_LEDGER_PATH`: `{ "ts", "run_id", "trial_id", "model_id", "input_tokens", "output_tokens", "reasoning_tokens", "cost_usd", "estimated": bool }`. Never write the key, headers or prompts.
  - Take `cost_usd` from the response's `usage.cost`, which OpenRouter includes in every response.
  - If `usage.cost` is missing (e.g. after a timeout), write a conservative estimate from the price table using the request's max possible tokens, with `"estimated": true`.
- On startup, sum the ledger to restore `spent_usd` and `live_calls`, so a restart does not reset the budget. Resetting the budget means deleting the file by hand. Document this in the backend README.
- **Pre-check on `POST /runs`** (real mode only): estimate the worst-case cost of the requested run and return `409 conflict` (details in 5.6) if it exceeds `MAX_SPEND_USD − spent_usd`. Worst case per trial = `max_moves × (max_retries + 1)` calls. Per-call cost = price-table input price × the measured prompt-size constant (default 300 input tokens) + output price × (`CHAT_MAX_TOKENS` for chat, 0 for Decisions).
  - Worst-case pre-check figures with the provisional `CHAT_MAX_TOKENS=256` (Opus ≈ $0.0063 per call, 300 input tokens): warm-up run (2 puzzles) $0.77, primary run (10 puzzles) $3.86, extension run (3 puzzles) $1.16. With `CHAT_MAX_TOKENS=128` they drop to $0.46 / $2.32 / $0.70. Each passes against the $5.00 cap at its point in the 6.2 sequence, even in the pessimistic spend case.
  - The pre-check uses the current `CHAT_MAX_TOKENS`, so the figures shrink automatically after calibration lowers it.
- **Mid-run backstop:** before each live attempt, if `spent_usd ≥ MAX_SPEND_USD` or `live_calls ≥ MAX_LIVE_CALLS`, abort the run per G4. This should never trigger when the pre-check passed. If it does, that indicates a bug or wrong prices.
- Log a one-line summary at `INFO` when each run finishes: calls made, `spent_usd` for the run, remaining budget. Never log the key.

#### G6. Explicitly do NOT copy from the reference repo

The reference implementation (`muhammad1234-max/AI-Engineering-Assignment2`) was the model for these limits. These parts of it are **forbidden** here:

- **Fallback models.** Switching to another model on errors (e.g. `gpt-4o-mini` on a 502, `claude-sonnet-4.5` on a 402) and returning hard-coded confidence values. This attributes another model's moves to the benchmarked model (violates 3.1, 3.3, 3.8).
- **Retrying every 4xx.** That wastes calls on requests that cannot succeed (see G4).
- **Routing by substring.** Routing to an interface by model-ID substring matching. Keep the explicit registry.
- **Random wrong moves in mock mode.** Mock mode stays deterministic (rule 6.8).

#### G7. Live smoke test and Opus calibration script

`backend/scripts/live_smoke.py`. It requires `MOCK_MODELS=false` and a key, and refuses to run otherwise. Every call is written to the spend ledger.

1. **Smoke (default):** exactly one call per model (4 calls) on the solved-after-`R` state from 4.2, using the configured settings. For each model print: move returned, latency, `prompt_tokens`, `completion_tokens`, `reasoning_tokens`, `usage.cost`, `finish_reason`, provider. Exit code ≠ 0 if any model returned an invalid move, Opus `prompt_tokens` > 250, or the G2 request was rejected (then apply the G2 compatibility fallback).
2. **Calibrate (`--calibrate`):** 3 Opus calls with `max_tokens=512` (worst case ≈ $0.035 total) on 3 fixed warm-up states (seeded), same prompt and effort. Print `completion_tokens` and `reasoning_tokens` per call, and recommend `CHAT_MAX_TOKENS = clamp(round_up_to_32(1.5 × max completion_tokens), 64, 512)`. The human then sets that value in `.env`. Stop-and-ask conditions from G2 apply.

Run order: follow section 6.2 exactly.

#### G8. Tests (offline, no network)

Add pytest cases for:

- **Chat request body:** contains `max_tokens = CHAT_MAX_TOKENS`, `temperature = 0`, `reasoning.effort = CHAT_REASONING_EFFORT` (or no `reasoning` field when set to `omit`), never `"none"` and never a `thinking` object, plus `provider.max_price`; payload-size bound from G3; settings reject `CHAT_MAX_TOKENS` outside 64–512 and any effort other than `low`/`omit`.
- **Shared prompt:** Decisions and chat bodies carry the same `INSTRUCTIONS` and `CRITERIA` strings.
- **Truncation:** `finish_reason: "length"` and empty content ⇒ `malformed_response`.
- **Retry matrix:** each G4 row, using an httpx mock transport, asserting retry counts and run/trial terminal states.
- **Fatal errors:** 401/402 abort the run; no further adapter calls happen.
- **Ledger:** append and restore-on-startup; cost taken from `usage.cost`; estimate written when it is missing.
- **Pre-check:** `409` with the correct `details` when over budget; accepted when under.
- **Backstops:** the mid-run spend cap and call cap abort the run.
- **`RunConfig` caps:** `timeout_s > MAX_TIMEOUT_S` or `max_retries > MAX_RETRIES_CAP` ⇒ `422 validation_error`.
- **Mock mode:** mock mode never touches the ledger or the network; `MOCK_MODELS` unset ⇒ mock.
- **Persistence (G11):** a finished run reloads after restart with identical snapshot, stats and SSE replay; a run that was active at shutdown reloads as `failed` and is never re-executed.
- **Duplicate guard (G12):** an identical live config is refused with `409`; `ALLOW_LIVE_RERUN=true` allows it; mock runs are never refused; a second concurrent live run is refused.
- **Export (G13):** the export script produces the expected files from fixture runs and a fixture ledger.

#### G9. Contract and frontend follow-ups (not Codex's directory)

- **`contract:` commit** (approved by the human on 2026-10-24): in `/contract/openapi.yaml`, set `version: 1.1.0`, the `RunConfig` defaults `timeout_s: 15` and `max_retries: 1`, and document the `409` on `POST /runs`. In `/contract/fixtures/health.json`, set `contract_version` to `1.1.0`. Shape-only fixtures stay unchanged.
- **`docs/HANDOFF.md` entry for Claude Code:** update `RUN_DEFAULTS` in `frontend/src/api/types.ts` to `timeout_s: 15`, `max_retries: 1`. Optionally show the `409` details (estimated cost vs remaining budget) in the run-controls error notice. The frontend currently sends explicit values, so the backend default change alone does not reach the UI.
- **Second `docs/HANDOFF.md` entry for Claude Code (needed for 6.2):**
  - Show the `409` duplicate-run details (`duplicate_of_run_id`) with an "Open that run" action.
  - Provide a way to open any finished run from `GET /runs` and show its boards, move histories, results, dashboard and `/slide` view, so demo retakes never need a new live run.
  - Run controls must accept a fixed `seed` and `count` so the 6.2 runs can be entered exactly.

#### G10. Reporting note (for the written analysis)

Opus 5.5 runs with always-on adaptive thinking at the **lowest effort (`low`)**, an immediate-answer instruction, and a hard cap of `CHAT_MAX_TOKENS` total output tokens per move. It therefore does some short planning, but far less than its default (`medium`).

The written analysis must:
- state this configuration;
- report the measured average Opus `completion_tokens` and `reasoning_tokens` per move, and the number of truncated (`finish_reason: "length"`) responses;
- discuss how the cap may limit Opus's quality, because it bears on question 5 ("fast decision model vs. frontier LLM").

An optional, separately budgeted extension run may use a higher effort and a larger `CHAT_MAX_TOKENS`, but only with human approval and a raised `MAX_SPEND_USD`. Its results must be labelled as a separate configuration.

#### G11. Persist everything so nothing is paid for twice

- Write each puzzle, each run snapshot and each run's full event log to `RUNS_DIR` as JSON. Flush every terminal trial and run event (write to a temp file, then rename).
- On startup, load them read-only, so `GET /puzzles`, `GET /runs`, `GET /runs/{id}`, `/stats` and SSE replay keep working after a restart.
- A run that was `queued`/`running` at shutdown reloads as `failed`, with its unfinished trials marked `error` (`internal_error`, "interrupted by restart"). It is **never** resumed or re-executed automatically, because automatic resumption risks double spend.
- No key, headers or prompts are written to these files (they already exclude them by construction; keep it that way).

#### G12. One live run at a time, no accidental re-runs

In real mode, `POST /runs` additionally returns `409 conflict` when:
- another live run is `queued`/`running` (`details: { "active_run_id": "..." }`); or
- `ALLOW_LIVE_RERUN=false` and a completed live run already exists with the same models, `max_moves`, `timeout_s`, `max_retries`, `history_window` and the same set of puzzle **facelets** (compare by content, not puzzle ID) (`details: { "duplicate_of_run_id": "..." }`).

Mock runs are never refused by this rule. These are new `details` payloads on the existing `409 conflict` code, so this is not a contract shape change.

#### G13. Results export (zero cost)

`backend/scripts/export_results.py` reads `RUNS_DIR` and the spend ledger and writes `results/benchmark_summary.md` plus one CSV per run. It includes:
- per-model stats as in 5.8;
- Opus average `completion_tokens` and `reasoning_tokens` per move, and the truncation count;
- spend per run, per model and in total, from the ledger.

The human commits `results/` for the submission. It contains no key or prompts.


### 6.2 Full benchmark execution plan (human runs it; one live pass)

Every live step below is run **once**. Seeds are fixed so the puzzles are reproducible and documented. All runs use: all four models, `max_moves 30`, `timeout_s 15`, `max_retries 1`, `history_window 6`, `concurrency 1`.

| Step | Mode | What | Opus calls (expected / worst) | Expected cost |
|---|---|---|---|---|
| 0 | mock | Run steps 3–6 end to end in mock mode, open the dashboard and `/slide`, and do a full dry-run of the screen recording. Fix everything here. | 0 | $0 |
| 1 | live | `live_smoke.py`: 1 call per model | 1 / 1 | < $0.01 |
| 2 | live | `live_smoke.py --calibrate` (3 Opus calls); then set `CHAT_MAX_TOKENS` in `.env` and restart | 3 / 3 | < $0.04 |
| 3 | live | Rehearsal: `warmup`, `count 1`, `seed 100`, `max_moves 5` | ≤ 5 / 10 | < $0.04 |
| 4 | live | Warm-up run: `warmup`, `count 2`, `seed 101` | ~25 / 120 | ~$0.08 |
| 5 | live | **Primary run: `primary`, `count 10`, `seed 202`. One run, so the dashboard and slide cover all 10 puzzles. Screen-record this run** (in-progress + completion stages). | ~190 / 600 | ~$0.62 |
| 6 | live | Extension run: `extension`, `count 3`, `seed 303` | ~95 / 180 | ~$0.30 |
| 7 | offline | `export_results.py`; record the final slide from the persisted primary run | 0 | $0 |

**Gates between live steps.** After each live step, read the run-finished log line (G5) or the ledger and stop to reconsider before going on if any of these hold:
- the step cost more than 1.5× its expected cost;
- Opus truncations exceed 20% of its calls;
- any run aborted (401/402/cap).

Never "just rerun" a live step. A rerun needs a deliberate decision, `ALLOW_LIVE_RERUN=true`, and a note in the written analysis.

**Recording.** Rehearse the recording in step 0. Record step 5 live, with step 4 as a backup in-progress clip. Retakes of the completion stage or slide use the persisted run (G11), never a new live run.

**Total (with ~5.5% credit purchase fee):**
- **expected ≈ $1.10**;
- optimistic ≈ $0.40 (Opus solves most primary puzzles in ~8 moves, ~40 output tokens per move);
- pessimistic ≈ $3.60 (Opus fails everything and hits the token cap every move).

The decision models total ≈ $0.06 in every case. Five extension puzzles instead of three would add ~$0.20 expected.
---

## 7. Contract change protocol

The contract is frozen at **v1.0.0** once `/contract/openapi.yaml` and `/contract/fixtures/` exist (milestone M0).

1. **Additive changes** (new optional response field, new endpoint, new event type): allowed after the proposing agent writes the request in `docs/HANDOFF.md` and the human approves. Bump minor version (`1.1.0`). Frontend ignores unknown fields, so these are safe.
2. **Breaking changes** (rename/remove field, change type/units/enum, change event semantics): require **explicit human approval**. Bump major version (`2.0.0`). Both agents update in lock-step.
3. Procedure: (a) append a `CONTRACT-CHANGE` entry to `docs/HANDOFF.md` describing the need, (b) wait for human approval, (c) update this section, `/contract/openapi.yaml` and fixtures in one commit with prefix `contract:`, (d) each agent then adapts its own directory in a separate commit.
4. `GET /health` returns the current `contract_version`. The frontend warns visibly on a major-version mismatch.
5. An agent that finds the contract ambiguous or wrong must not guess: log it in `docs/HANDOFF.md` and ask.

---

## 8. Conflict-avoidance rules

- Branches: `backend/<topic>` (Codex), `frontend/<topic>` (Claude Code), `contract/<topic>` (approved contract changes). A branch never mixes directories.
- Commit scope prefixes: `backend:`, `frontend:`, `contract:`, `docs:`.
- Never reformat, rename or "tidy" files outside your own directory.
- `docs/HANDOFF.md` is append-only. Entry format: `## YYYY-MM-DD <agent> → <agent>` + bullet list (what changed, what you need, endpoints/fields touched).
- Root files (`README.md`, `.gitignore`): small additive edits only, each in its own commit, never overwriting existing content.
- Before starting work, read `git status`, `docs/HANDOFF.md` and the current contract version. Before finishing, ensure your directory's tests/lint pass.

---

## 9. Frontend spec — owned by Claude Code (`/frontend`)

**Stack:** React 18 + Vite + TypeScript (strict), Vitest + React Testing Library. A charting library is allowed (e.g. Recharts). 3D cube rendering is optional; a clear 2D net rendered from the facelet string is acceptable.

**Suggested layout:**

```
frontend/
├── src/
│   ├── api/          # typed client for section 5 (fetch + SSE), types mirror /contract exactly
│   ├── mocks/        # mock mode driven by /contract/fixtures (VITE_USE_MOCKS=true)
│   ├── components/   # CubeNet, ModelLane, MoveHistory, ResultBanner, StatsTable, IdentityBadge
│   ├── pages/        # BenchmarkPage, StatsSlidePage
│   └── state/        # run state reducer built from snapshot + events (seq-ordered)
├── .env.example      # VITE_API_BASE_URL=/api/v1, VITE_USE_MOCKS=false, VITE_STUDENT_NAME=, VITE_STUDENT_ROLL=
└── package.json
```

**Required UI (from the assignment)**

1. **Scrambled cube** shown from `Puzzle.facelets`; per-model lanes show each model's `current_facelets` as it plays.
2. **Run benchmark button**: generates (or selects) puzzles via `POST /puzzles`, then `POST /runs`, then opens the SSE stream. Disabled while a run is active; offers cancel (`POST /runs/{id}/cancel`).
3. **Current move** per model (latest `move_applied`, plus a visible "waiting…" state on `move_requested` and a visible flag on `move_invalid`).
4. **Move history** per model/trial: index, move, latency, confidence when non-null.
5. **Result indicator** per trial and per puzzle: clearly **"Solved"** vs **"Move limit reached"** vs **"Error"** (from `Trial.status`).
6. **Statistics dashboard** from `GET /runs/{id}/stats`, per model: per-move average latency, total solve time, total number of moves, success rate (%), optimality gap — plus invalid/retry/timeout counts and the `questions_answered` highlights.
7. **Final benchmark slide**: a full-screen, presentation-ready view of the section 3 statistics that can be shown at the end of the screen recording (route e.g. `/slide`).
8. **Identity overlay**: student name and roll number (from `VITE_STUDENT_NAME`, `VITE_STUDENT_ROLL`) rendered as a fixed, high-contrast badge on **every** view, always on top, never hidden or scrolled away. Missing values must show a loud placeholder warning instead of nothing.

**Rules**

1. Types are derived from section 5 and `/contract/openapi.yaml`; no hand-invented fields. Unknown response fields are ignored; missing nullable fields are treated as `null`.
2. Build state from `GET /runs/{id}` (snapshot) + SSE events ordered by `seq`; on reconnect use `Last-Event-ID`; discard events with `seq ≤ last_seq` already applied.
3. Do not compute move validity, solved status, latency averages, success rates or optimality gaps client-side. Display backend values only (format/round for display is fine).
4. Never read, store or request an OpenRouter key. No OpenRouter URLs anywhere in `/frontend`.
5. Develop against `/contract/fixtures` in mock mode until the backend is ready; switching to the live backend must require no code change (only `VITE_USE_MOCKS`).
6. Handle error envelopes (5.2) with visible, specific messages; handle `missing_api_key` with setup guidance.
7. Responsive enough to be legible in a screen recording at 1080p; avoid layout shift while moves stream in.
8. Tests: reducer/event ordering, snapshot+resume merge, result banner states, stats rendering from fixtures, identity badge presence.
9. Frontend README section: install, `.env` setup, `npm run dev` (port 5173), `npm run build`, `npm test`.

---

## 10. Milestones and integration order

| # | Milestone | Owner | Done when |
|---|---|---|---|
| M0 | Contract freeze | Human-approved, either agent drafts `/contract` | `openapi.yaml` + `fixtures/*.json` match section 5; `contract_version` 1.0.0 |
| M1 | Backend core | Codex | Engine, scramble, BFS, mock adapter, `/health`, `/models`, `/puzzles`, tests green |
| M2 | Frontend on mocks | Claude Code | Full UI works from fixtures: board, lanes, history, banners, dashboard, slide, identity badge |
| M3 | Backend real adapters + runs/SSE/stats | Codex | Real OpenRouter calls verified against current docs; run/SSE/stats endpoints match fixtures |
| M3.5 | Cost guardrails | Codex | Section 6.1 (G1–G13) implemented, including persistence, the duplicate-run guard and the export script; G8 tests green; `live_smoke.py` and `--calibrate` pass; Opus `prompt_tokens ≤ 250`; calibrated `CHAT_MAX_TOKENS`, measured Opus tokens/cost per call, and the chosen G2 variant (effort `low` or `omit`) recorded in backend README |
| M4 | Integration | Both (own side each) | Frontend with `VITE_USE_MOCKS=false` runs a warm-up end to end against the backend |
| M5 | Experiments | Human, following 6.2 | Steps 0–7 of 6.2 done once: 2 warm-up, 10 primary (40 trials) and 3 extension puzzles × 4 models; `results/` exported; total spend from the ledger recorded |
| M6 | Demo & submission | Human | Checklist in section 11 complete |

M1 and M2 proceed in parallel after M0. Neither agent starts M4 until both M1/M2 (and M3 on the backend side) are done.

---

## 11. Submission checklist (assignment section 8)

- [ ] GitHub repository with source code, **setup instructions** (root `README.md`), and an **environment-variable template** (`backend/.env.example`, `frontend/.env.example`). No real keys committed.
- [ ] Screen recording of the app, containing all of:
  1. **In-progress stage**: models visibly playing the game.
  2. **Completion stage**: models have completed the game, with solved / move-limit results visible.
  3. A **final slide** showing the statistical benchmarks (per-move average latency, total solve time, total moves, success rate, optimality gap).
  4. **Student name and roll number clearly visible on screen for the entire recording** (otherwise the submission is invalid).
- [ ] A short written analysis answering the five required questions, with evidence from the stats:
  1. Which model is fastest at making decisions?
  2. Which model achieved the highest solve rate?
  3. Which model found the shortest solutions, and how close to the optimum?
  4. Did the fastest model also achieve the best solution quality?
  5. Would you use the fastest decision model, the frontier LLM, or a hybrid agent in a real application, and what evidence supports that choice?

---

## 12. Definition of done and conventions

**Backend (Codex):** `pytest` green; `ruff check` clean; every endpoint's response validates against `/contract/fixtures`; mock mode and real mode produce the same shapes; no secrets in the repo; section 6.1 guardrails in place and the spend ledger directory git-ignored.

**Frontend (Claude Code):** `npm run build` and `npm test` green; `tsc --noEmit` clean; ESLint clean; runs fully on fixtures with `VITE_USE_MOCKS=true`; identity badge visible on every view.

**Both:** commit small and often with the scope prefix from section 8; if you cannot meet an acceptance criterion, say so plainly in `docs/HANDOFF.md` instead of working around it; never claim something works without having run it.

**Stop-and-ask triggers:** any change that would raise `CHAT_MAX_TOKENS` above 512 or Opus effort above `low`, any G2 stop-and-ask condition, any live run whose pre-check fails, contract ambiguity or conflict, a needed change in the other agent's directory, a model/endpoint that no longer matches the PDF, any step that would expose or commit a secret, or any instruction that seems to contradict this file.
