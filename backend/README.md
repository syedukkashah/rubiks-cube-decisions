# Rubik's Cube Race backend

FastAPI / Python 3.11+, contract **1.1.0**, implementing AGENTS.md at `0a55c1a`.
All development and automated tests run offline. Mock mode is the default.

## Install and start

From `backend` in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

API: `http://localhost:8000/api/v1`; interactive docs: `http://localhost:8000/docs`.
Use one backend process/worker. `.env` is ignored. Environment variables override
`.env`, and settings are read at startup; restart after changes. The startup banner
says **MOCK MODE** or **LIVE MODE**. Mock runs use no key, network or spend ledger.
They deterministically reverse the scramble, return null confidence, and use
synthetic 1 ms move latency. Their results are for pipeline testing only.

## Settings

| Variable | Default | Behavior |
|---|---|---|
| `OPENROUTER_API_KEY` | empty | Backend only; real runs return 503 without it |
| `MOCK_MODELS` | `true` | Only explicit `false` enables live requests |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated exact origins |
| `MAX_SPEND_USD` | `1.10` | Persistent usage cap; values above 1.10 are rejected |
| `MAX_LIVE_CALLS` | `2000` | Persistent inference-attempt cap |
| `MAX_TRIAL_RETRIES` | `3` | Total retries across all moves in each trial |
| `CHAT_MAX_TOKENS` | `160` | Provisional thinking + answer cap; valid range 64–512 |
| `CHAT_REASONING_EFFORT` | `low` | `low` or G2 compatibility setting `omit` only |
| `MAX_TIMEOUT_S` | `20` | API rejects larger per-call timeouts with 422 |
| `MAX_RETRIES_CAP` | `1` | API rejects larger per-move retry counts with 422 |
| `SPEND_LEDGER_PATH` | `.spend/ledger.jsonl` | Relative to `backend`, or an absolute path |
| `RUNS_DIR` | `.runs` | Relative to `backend`, or an absolute path |
| `ALLOW_LIVE_RERUN` | `false` | Explicit override for duplicate live configurations |

Non-numeric, negative and non-finite numeric settings fail at startup. Boolean
settings accept only `true`/`false`. Fractional call/retry/token limits are rejected.
The default API run configuration is timeout 15 seconds, one retry per move,
history window six, concurrency one, and at most 30 valid moves.

The usage ceiling is $1.10, approximately $1.16 including a 5.5% purchase fee,
within the assignment's $1.20 ceiling. Set a dedicated OpenRouter key's credit
limit to $1.10 as the independent account-side backstop. Never raise the code cap.

## Opus request and prompt

The chosen provisional G2 variant is **effort `low`**, with `exclude: true`,
`max_tokens: 160`, `temperature: 0`, strict JSON output and provider limits
`max_price: {prompt: 4, completion: 20}` (USD per million tokens).
Opus always thinks; excluding thinking only hides its text and does not remove its
cost. No `none`, manual thinking budget, alternative model or invented confidence
is sent. The shared prompt and criteria are identical across interfaces. Chat adds:

> Reply immediately with only {"move":"<one allowed move>"}. No explanation.

Shared criteria use `CW`, `CCW`, and `180`; the shared instructions define viewing
direction and quarter turns. The strict move schema uses an anchored pattern
equivalent to the 18-value enum, retaining a required string `move` and rejecting
additional properties. Tests check the exact accepted move language, including
trailing-newline rejection. This avoids duplicating the option list and keeps the
**entire request at 1,100 characters** under `json.dumps` with the default six-move
history (including six two-character moves). JSON is transmitted compactly.
Longer explicitly configured histories increase prompt size and estimated-token
uncertainty; use the assignment's history window six for live runs.

`finish_reason: length`, empty content, and malformed JSON are counted failures;
they are never repaired. Illegal strings are rejected by the runner. The cap can
limit Opus quality: report this configuration, measured output/reasoning averages,
and truncation counts in the written analysis.

**Live verification is pending:** no paid inference was run during implementation.
Record these after the human-run smoke/calibration steps:

| Measurement | Current value |
|---|---|
| Opus prompt tokens (must be ≤250) | Pending live smoke |
| Opus completion / reasoning tokens per call | Pending calibration |
| Opus actual cost per call | Pending calibration |
| Calibrated `CHAT_MAX_TOKENS` | Pending; provisional 160 |
| Successful provider and `low`/`omit` variant | Pending; configured low |
| Temperature compatibility | Pending; temperature 0 retained |

G2 allows one **smoke-only** compatibility retry after a reasoning-related 400:
omit `reasoning`, retaining the same token cap, short-answer line and price limit.
The script prints the outcome and instructs you to set `CHAT_REASONING_EFFORT=omit`
if that probe succeeds; it never edits `.env`. Normal benchmark requests never
retry a 400. If both variants fail, stop and ask. A temperature-related 400 is
reported for review; no live evidence justifies dropping temperature yet.

Documentation used for the request shape and usage accounting:

- [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Opus 5.5 migration](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
- [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions)

## Retries, budget and persistence

All four models use the same runner. Client timeouts and HTTP 408, 429, 500, 502,
503, 504 retry with 0.5, 1, 2… second delays, within both retry limits. A numeric
429 `Retry-After` from 0–10 seconds takes precedence. Invalid outputs retry without
consuming a move. Other 4xx responses are not retried. HTTP 401/402 fail the whole
run with `invalid key` / `insufficient credits`; pending work is stopped. Calls
already in flight may have been billed and retain their ledger reservations.
Exhausting the trial retry budget ends that trial with an explicit error.

Run admission estimates each model's worst case as:

```text
attempts_per_trial = min(max_moves + MAX_TRIAL_RETRIES,
                         max_moves * (max_retries + 1))
per_call_usd = (300 * input_price + output_cap * output_price) / 1_000_000
run_estimate = puzzle_count * attempts_per_trial * sum(per_model_call_cost)
```

Prices are centralized in `app/config.py`. Decisions use output cap zero; chat
uses the current `CHAT_MAX_TOKENS`. At 160, the five-puzzle primary estimate is
$0.744909. Before first live use, verify the reference prices against OpenRouter.
HTTP 409 reports `estimated_max_cost_usd` and `remaining_budget_usd` if over budget.

One live run may be active at a time (409 includes `active_run_id`). A completed
live run with matching models, facelet set and move/timeout/retry/history settings
cannot be submitted again (409 includes `duplicate_of_run_id`), even with new
puzzle IDs or after restart. Mock runs are exempt. An explicit rerun override
does not bypass the spend or call limits.

Each live HTTP attempt reserves a conservative estimated JSONL row **before**
network I/O, under one shared `asyncio.Lock`. A response atomically replaces its
reservation with `usage.cost`, token counts, and the estimated flag. Missing cost,
timeouts, cancellation and interrupted processes keep conservative accounting.
This makes retries and abandoned calls survive restart without duplicate rows.
Before each call, the ledger checks both caps and reserves its estimated cost;
availability checks are free and are not counted. A malformed ledger fails closed.
The run-finished INFO line includes calls, usage spend and remaining budget.
The 300-input-token allowance is an estimate, not a provider billing guarantee;
inspect measured prompt size before proceeding with the paid plan.

`.runs/` stores puzzles, snapshots, full SSE logs, live/mock provenance and internal
token/finish metadata. Each event flushes through a temporary file and atomic
rename. Completed runs keep the same snapshot, statistics and replay after restart.
Interrupted runs load as failed with unfinished trials marked `internal_error`,
`interrupted by restart`; nothing is automatically resumed. Startup reads existing
artifacts without rewriting them. No keys, request headers or prompt bodies are
stored. Internal usage records do not change the public API shapes.

**Ledger reset:** stop the backend and smoke scripts, then manually delete the
file configured by `SPEND_LEDGER_PATH` (normally `backend/.spend/ledger.jsonl`).
This resets local accounting, not actual provider charges. Do not use a reset to
bypass the assignment's cumulative cap; preserve charged assignment evidence.
Deleting `.runs` also removes replay and duplicate protection. Neither happens
automatically. Run only one process against these files; stop the server while
running the paid smoke/calibration CLI.

## Offline tests

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check .
```

The suite blocks real httpx transports globally. It uses deterministic adapters,
mock transports and temporary storage. It validates the shared contract fixtures,
retry policies, accounting, cancellation, persistence, duplicate guards, scripts,
and payload limits. Do these checks before any live step.

## Human-run smoke, calibration and benchmark order

First rehearse all UI and recording actions in mock mode. Later, set a real key
and `MOCK_MODELS=false`. Run from `backend`:

```powershell
.\.venv\Scripts\python.exe scripts/live_smoke.py
.\.venv\Scripts\python.exe scripts/live_smoke.py --calibrate
```

Smoke normally sends exactly four calls, one per model, on solved-after-R. Only
the explicit G2 compatibility probe may add a fifth. Fatal credentials/caps stop
early. It prints the move, latency, prompt/completion/reasoning tokens, actual cost,
finish reason and provider. Invalid moves, excessive/missing Opus prompt counts,
or rejected requests cause a nonzero exit. Calibration sends three seeded Opus
calls at cap 512 and recommends `clamp(ceil(1.5 * max_tokens_used / 32) * 32, 64, 512)`.
It does not change configuration. All attempts, including probes, use the ledger.

Stop and ask if cost exceeds $0.012/call, truncations exceed 20% at 512, or the
recommended cap exceeds 192. Configure the approved calibrated cap and restart.
Follow section 6.2 exactly; defaults are all four models, 30 moves, timeout 15,
one retry per move, history six, concurrency one:

| Order | Action | Suite/count/seed | Moves |
|---|---|---|---:|
| 0 | Mock dry run and recording rehearsal | Steps below, offline | As below |
| 1 | pytest → smoke | Four probes | One call/model |
| 2 | Calibration; update `.env` | Seeds 100, 101, 102 | One call/state |
| 3 | Live rehearsal | warmup / 1 / 100 | 5 |
| 4 | Live warm-up | warmup / 1 / 101 | 30 |
| 5 | Primary, record this run | primary / 5 / 202 | 30 |
| 6 | Optional, only if budget permits | extension / 2 / 303 | 30 |
| 7 | Export and replay final slide | Persisted primary run | No calls |

After each live step, stop if spend exceeds 1.5× the section 6.2 expectation,
Opus truncations exceed 20%, a run aborted, or the next estimate exceeds remaining
budget. Skip the optional extension if refused; never raise the cap or rerun a
paid step casually. Demo retakes should reopen saved results.

Example API creation in PowerShell (mock first):

```powershell
$api = 'http://localhost:8000/api/v1'
$puzzles = Invoke-RestMethod "$api/puzzles" -Method Post -ContentType 'application/json' -Body '{"suite":"warmup","count":1,"seed":100}'
$body = @{ puzzle_ids = @($puzzles.puzzles.puzzle_id); max_moves = 5 } | ConvertTo-Json
$run = Invoke-RestMethod "$api/runs" -Method Post -ContentType 'application/json' -Body $body
curl.exe -N "$api/runs/$($run.run_id)/events"
Invoke-RestMethod "$api/runs/$($run.run_id)/stats" | ConvertTo-Json -Depth 8
```

## Offline export

```powershell
.\.venv\Scripts\python.exe scripts/export_results.py
```

Writes `backend/results/benchmark_summary.md` and a CSV per saved run. Use
`--output-dir <path>` for another destination. Export reads local artifacts only;
it never invokes a model. Output includes all public model statistics, Opus
accepted-move token averages, the saved token cap and reasoning setting,
truncation counts across all attempts, and ledger
spend per run/model and total (including smoke and calibration). The human can
commit the resulting files for submission. No key or prompts are exported.

Frontend and contract follow-ups remain owned by their maintainers, as recorded
in `docs/HANDOFF.md`; this implementation changes `/backend` only.
