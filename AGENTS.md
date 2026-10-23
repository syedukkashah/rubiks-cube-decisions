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
8. **Identity overlay.** The submission demo requires the student's name and roll number visible on screen the entire time (frontend responsibility, section 9).

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

## 5. JSON API contract (v1.0.0)

The contract below is normative. Both agents implement exactly this. When `/contract/openapi.yaml` is created it must mirror this section field for field; if the two ever disagree, **this file wins until fixed**.

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
  "contract_version": "1.0.0",
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
  "timeout_s": 60,
  "max_retries": 2,
  "history_window": 6,
  "concurrency": 1
}
```

| Field | Type | Default | Rules |
|---|---|---|---|
| `puzzle_ids` | string[] | required | ≥ 1, all must exist |
| `model_ids` | string[] | all four | ≥ 1, subset of `/models` ids, all `available` |
| `max_moves` | int | `30` | 1–30 |
| `timeout_s` | number | `60` | per OpenRouter call; same for every model |
| `max_retries` | int | `2` | retries per move for timeouts, upstream errors **and** invalid outputs; same for every model |
| `history_window` | int | `6` | number of most recent moves sent to every model as `recent_moves` |
| `concurrency` | int | `1` | parallel trials, 1–4. Default `1` so latency numbers are not distorted by contention |

Response `202`:

```json
{
  "run_id": "run_01",
  "status": "queued"
}
```

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
    "timeout_s": 60,
    "max_retries": 2,
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
- **Chat completions** (`anthropic/claude-opus-5.5`): send the same state, the same 18 allowed moves and the same recent-move window, and require exactly `{"move": "R'"}` via structured-output / JSON-schema constraint where the route supports it.
- Validation: the returned move must be in the 18-move set. Otherwise it is an invalid output: log it, count it, retry per policy, never substitute a move.

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
└── .env.example           # OPENROUTER_API_KEY=your-key-here, CORS_ORIGINS=http://localhost:5173
```

**Responsibilities and rules**

1. Pydantic schemas must reproduce section 5 field names, types, nullability and enums exactly. Response models forbid extra fields; request models reject unknown fields.
2. Engine: `apply_move` is pure and deterministic; reject any move not in the 18-move set; `is_solved` checks all six faces uniform. Scramble generation follows 4.3 and is reproducible from `seed`.
3. Solver: BFS (or another complete shortest-path method) over the 18-move HTM graph from the scrambled state to solved, giving the exact optimum for `warmup` and `primary` puzzles. Unit-test it against hand-checked scrambles (e.g. scramble `R` ⇒ optimum 1; a 5-move scramble ⇒ optimum ≤ 5).
4. Runner: identical loop for all models — build state → call adapter → validate → apply → emit events → stop on solved / `max_moves` / unrecoverable error. Same `timeout_s`, `max_retries`, `history_window` for every model. Invalid outputs consume retries, not moves.
5. Event bus: every state change emits a section 5.7 event with a per-run increasing `seq`; keep the full log in memory (or SQLite) so `Last-Event-ID` replay works.
6. Persist runs/puzzles in memory or SQLite; results must survive long enough for the dashboard and for `GET /runs/{id}` after completion.
7. The API key is read from `OPENROUTER_API_KEY` at startup. Missing key ⇒ `/health.api_key_configured=false` and run creation returns `503 missing_api_key`. Never log or return the key; scrub `Authorization` headers from any logged request.
8. Provide a deterministic **mock adapter** (selectable via `MOCK_MODELS=true`) so the full pipeline and tests run without network or spend. It must produce the same JSON as real adapters.
9. Tests (pytest) must cover: engine moves and inverses, scramble reproducibility, BFS correctness, move validation (valid / illegal / malformed), retry and timeout policy, move-limit ⇒ unsuccessful, stats arithmetic, SSE ordering/replay, and schema conformance against `/contract/fixtures`.
10. Backend README section: install, `.env` setup, `uvicorn app.main:app --reload --port 8000`, `pytest`.

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
| M4 | Integration | Both (own side each) | Frontend with `VITE_USE_MOCKS=false` runs a warm-up end to end against the backend |
| M5 | Experiments | Backend run + frontend display | ≥ 5 primary puzzles × 4 models (20 trials) completed; optional extension suite |
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

**Backend (Codex):** `pytest` green; `ruff check` clean; every endpoint's response validates against `/contract/fixtures`; mock mode and real mode produce the same shapes; no secrets in the repo.

**Frontend (Claude Code):** `npm run build` and `npm test` green; `tsc --noEmit` clean; ESLint clean; runs fully on fixtures with `VITE_USE_MOCKS=true`; identity badge visible on every view.

**Both:** commit small and often with the scope prefix from section 8; if you cannot meet an acceptance criterion, say so plainly in `docs/HANDOFF.md` instead of working around it; never claim something works without having run it.

**Stop-and-ask triggers:** contract ambiguity or conflict, a needed change in the other agent's directory, a model/endpoint that no longer matches the PDF, any step that would expose or commit a secret, or any instruction that seems to contradict this file.
