# Rubik's Cube Race backend

FastAPI / Python 3.11+, contract **1.3.0**, implementing AGENTS.md at `7e66e53`.
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
Advanced mock runs deterministically reverse the scramble with null confidence
and synthetic 1 ms latency. One-click simulated sessions use the personas below.
Both are for preview/testing only, never evidence about the real models.

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
| `RECORDING_PATH` | `recordings/benchmark.json` | Atomic live recording; relative to `backend`, not git-ignored |
| `EXPECTED_COST_WARMUP` | `0.03` | Warm-up gate baseline in USD |
| `EXPECTED_COST_PRIMARY` | `0.33` | Primary gate baseline in USD |
| `EXPECTED_COST_EXTENSION` | `0.20` | Extension gate baseline in USD |

Non-numeric, negative and non-finite numeric settings fail at startup. Boolean
settings accept only `true`/`false`. Fractional call/retry/token limits are rejected.
The default API run configuration is timeout 15 seconds, one retry per move,
history window six, concurrency one, and at most 30 valid moves.

The usage ceiling is $1.10, approximately $1.16 including a 5.5% purchase fee,
within the assignment's $1.20 ceiling. Set a dedicated OpenRouter key's credit
limit to $1.10 as the independent account-side backstop. Never raise the code cap.

## Opus request and prompt

The chosen provisional G2 variant is **effort `low`**, with `exclude: true`,
`max_tokens: 160`, strict JSON output and provider limits
`max_price: {prompt: 4, completion: 20}` (USD per million tokens).
Opus always thinks; excluding thinking only hides its text and does not remove its
cost. No `none`, manual thinking budget, alternative model or invented confidence
is sent. The shared prompt and criteria are identical across interfaces. Chat adds:

> Reply immediately with only {"move":"<one allowed move>"}. No explanation.

Shared criteria use `CW`, `CCW`, and `180`; the shared instructions define viewing
direction and quarter turns. The strict move schema uses the supported anchored
pattern `^[UDLRFB]['2]?$`, retaining a required string `move` and rejecting
additional properties. The adapter then checks exact membership in the 18-move
set, including trailing-newline rejection regardless of regex dialect. Tests
cover both constraints. This avoids duplicating the option list and keeps the
**entire request at 1,100 characters** under `json.dumps` with the default six-move
history (including six two-character moves). JSON is transmitted compactly.
Longer explicitly configured histories increase prompt size and estimated-token
uncertainty; use the assignment's history window six for live runs.

`finish_reason: length`, empty content, and malformed JSON are counted failures;
they are never repaired. Illegal strings are rejected by the runner. The cap can
limit Opus quality: report this configuration, measured output/reasoning averages,
and truncation counts in the written analysis.

**Live verification is partial and Opus is unresolved:** one authorized Opus probe
on the trivial solved-after-R state succeeded after the temperature and regex fixes.
On every scrambled state tried since (3 of 3 calls), Opus spent the whole output cap
on reasoning and returned no move (see reviews below and `OPUS_FINDINGS.md`). The
benchmark is paused; no further paid call is approved. Observations, not averages:

| Measurement | Current value |
|---|---|
| Opus prompt tokens (must be ≤600) | 480 (trivial probe), 478 (calibration), 491 (warm-up) |
| Opus completion / reasoning tokens per call | 11 / 0 on solved-after-R; 512 / 512 and 128 / 128 (twice) on scrambled states, all `length` |
| Opus actual cost per call | $0.00214 trivial; $0.012152 at 512; $0.004524 at 128 |
| Calibrated `CHAT_MAX_TOKENS` | None. Calibration failed; the human-approved uncalibrated 128 failed the warm-up |
| Successful provider and `low`/`omit` variant | Claude Platform on AWS; low (all three truncations also used it) |
| Temperature compatibility | Omitted under G2; endpoint metadata excludes temperature (2026-10-24) |

`exclude: true` omits the `reasoning` text field, but the observed OpenRouter responses
still carried a short `reasoning_details` summary plus signature (about 2.3 KB raw).
That text is model output, not a secret; it does not change billing or the cap.

G2 allows one **smoke-only** compatibility retry after a reasoning-related 400:
omit `reasoning`, retaining the same token cap, short-answer line and price limit.
The script prints the outcome and instructs you to set `CHAT_REASONING_EFFORT=omit`
if that probe succeeds; it never edits `.env`. Normal benchmark requests never
retry a 400. If both variants fail, stop and ask.

**Temperature compatibility fix (2026-10-24):** the human-run Opus diagnostic
returned HTTP 404, `No endpoints found that can handle the requested parameters`.
The public [Opus endpoint metadata](https://openrouter.ai/api/v1/models/anthropic/claude-opus-5.5/endpoints)
lists no endpoint supporting `temperature`. Under OpenRouter's
[required-parameter routing](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters),
our `temperature: 0` therefore excludes every listed endpoint. Following the G2
exception, the adapter now omits temperature. It retains `require_parameters: true`,
the same strict schema, low reasoning effort, token cap and price limits.
Offline tests cover routing against the advertised parameter set. The next live
probe reached Azure and exposed the schema issue described below.

**Schema compatibility fix (2026-10-24):** one authorized Opus-only probe after
the temperature fix reached Azure but returned HTTP 400:
`output_config.format.schema: Invalid regex in pattern field: Quantifier '?' without preceding element`.
The original pattern used negative lookahead. Anthropic's
[structured-output regex restrictions](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
exclude lookahead/lookbehind, so the request now uses only supported anchors,
character classes and an optional suffix. Strict object fields and exact backend
move validation remain in force; no invalid output is trimmed or coerced. The
full request remains under 1,100 characters. A subsequent authorized single probe
returned `R'` with `finish_reason: stop`; it failed only the former 250-input-token guard.
Failed probes remain conservatively accounted for in the existing ledger; no
further inference is automatically attempted.

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
input_floor[model] = 600 for Opus, 300 for Decisions
input_estimate[model] = max(input_floor[model], largest saved input-token count for that model)
per_call_usd = (input_estimate[model] * input_price + output_cap * output_price) / 1_000_000
run_estimate = puzzle_count * attempts_per_trial * sum(per_model_call_cost)
```

Prices are centralized in `app/config.py`. Decisions use output cap zero; chat
uses the current `CHAT_MAX_TOKENS`. With no observations, the five-puzzle primary
estimate at 160 is $0.942909. Existing ledger measurements increase it immediately;
the baseline is not used when a larger count is already known. Run admission,
required-session admission, next-step gates and individual call reservations all
use the same model-specific estimates. They are restored from the ledger after
restart and never lowered by a smaller later response. Before live use, verify
the reference prices against OpenRouter.
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
Both the initial 600/300-token allowances and the later observed maxima are estimates,
not guarantees about future prompts. Cube states, longer history and provider
schema overhead can change input-token counts. Missing-cost settlement retains
at least the reservation's input allowance; missing cost never resets an estimate
below its model's floor. Reported actual charges remain unchanged. Malformed saved token counts
fail closed instead of silently lowering the estimate.

### Current prompt and budget review (2026-10-24, superseded)

Historical. The request sizes and budget figures in this subsection predate the
2026-10-25 prompt revision and warm-up; the current values are in the next subsection.

The corrected request measures 1,030 characters with empty history and 1,071 with
six two-character moves, under the 1,100-character limit. Its message text alone
is 423 / 452 characters. Character length does not establish billed token count:
the successful probe reported 480 input tokens. Anthropic documents additional
schema instructions for structured output; the precise overhead split was not
returned. The compact shared wording, state fields, all 18 move definitions,
strict schema and required short-answer line remain unchanged. On 2026-10-24 the
human approved replacing the 250-token smoke guard with 600 and using at least
600 input tokens for Opus budgeting. This backend override applies to the G3/G7
input-token requirement; the full-request character limit, provisional output
cap 160 and maximum usage spend $1.10 remain in force. Missing or excessive input
counts stop smoke/calibration before another call.

With observed input counts Jev 594, Luna 283, Clef 483 and Opus 480, planning uses
594 / 300 / 483 / 600. At this review the remaining ledger budget is $1.075786466.
Three calibration calls at cap 512 have a planning allowance of $0.03792. Session
estimates below allow 33 attempts per model per puzzle (30 moves plus three retries).

| Calibrated output cap (illustrative) | Required 1 warm-up + 5 primary | With 2 extension puzzles | Calibration + all 8 puzzles |
|---|---:|---:|---:|
| 64 | $0.762472 | $1.016629 | $1.054549 |
| 96 | $0.889192 | $1.185589 | $1.223509 |
| 128 | $1.015912 | $1.354549 | $1.392469 |
| 160 (provisional) | $1.142632 | $1.523509 | $1.561429 |

These are conservative planning estimates at the stated input counts, not price
quotes or expected bills; fewer calls/output tokens can cost less, while larger
input observations can raise estimates. Usage figures exclude credit-purchase
fees/taxes. Cap 160 currently fails required-session admission. Only cap 64 fits
all eight puzzles plus calibration under the current remaining budget using these
estimates; caps 96/128 fit the six required puzzles plus calibration. The optional
extension still needs its own gate checks. Calibration must determine an adequate
output cap; do not select a smaller cap solely to fit the budget. No calibrated
cap is recommended yet, and no additional live call was made for this review.

### Opus reasoning review (2026-10-25)

The approved calibration on seed 100 stopped after one call: prompt 478,
completion 512, reasoning 512, empty answer, `finish_reason: length`, provider
Claude Platform on AWS, actual cost $0.012152. No remaining calibration calls ran.
It exceeded the $0.012 per-call gate; one truncation would also exceed 20% of the
planned three samples even if the other two succeeded. No usable cap was established.

The adapter sends `reasoning.effort: low` correctly. OpenRouter documents this
[empty-answer failure when reasoning consumes max_tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-tokens-and-max_tokens).
`exclude` only hides reasoning text. The
[Opus migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
rules out disabling thinking or assigning a separate manual thinking budget;
omitting effort selects the higher default `medium` and is not a truncation fix.
The G2 omit fallback applies to a reasoning-related HTTP 400, not this successful
HTTP response whose output was truncated.

Prepared offline mitigation: shared instructions now begin
`Pick a move.Min moves.No deliberation.` for **all four models**. This makes the
single-move task explicit and discourages deliberation, following Anthropic's
[prompt steering guidance](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost#system-prompt-guidance).
All move definitions, facelet conventions, strict schema, and the exact chat-only
short-answer line remain present. Full chat requests measure 1,058 characters with
empty history and 1,099 with six two-character moves, within the 1,100 limit.
This was a candidate prompt change, not a verified solution: prompt steering is
soft, may affect move quality, and cannot guarantee Opus will answer within a cap.

**It did not fix the warm-up.** The human then approved one uncalibrated session at
cap 128 (warm-up + five primary puzzles, no extension), session
`sess_6bf8def5a89a401d9fd976a410bd7ae2`. On the warm-up (seed 101, `B2 F2 D2`,
optimum 3) both Opus attempts used prompt 491, completion 128, reasoning 128,
`native_finish_reason: max_tokens`, empty content, $0.004524 each. The Opus trial
ended `error` with 0 moves; the three Decisions models each hit the 30-move limit
unsolved. The warm-up gate failed only on `opus_truncation=100%`, and the primary run
was cancelled before any inference. That approval is exhausted.

The follow-up offline investigation (`OPUS_FINDINGS.md`) replays the recorded
responses with `httpx.MockTransport` and re-checks the primary documentation. It
finds no API-compatibility defect: the body is accepted and billed, effort `low`
already is the floor, and OpenRouter ignores `reasoning.max_tokens` on adaptive-only
Claude models. The failure is insufficient output room for the model's adaptive
reasoning on scrambled states. No configuration within the current rules is
evidenced to fix it, so the next step needs a human decision (see that file).

Calibration now stops immediately on a truncated/empty or invalid answer, missing
completion counts, or a sample requiring a recommended cap above 192. It never
prints a recommended cap after failed calibration, including a failure on the
third sample. These stops save the remaining calls; the runner's retry policy is
unchanged. Mock transports reproduce the observed all-reasoning response and
verify accounting and early termination; they cannot validate model behavior.

No output/price/spend cap or `.env` setting was changed.

**Budget snapshot after the warm-up** (local ledger of the original backend worktree,
which remains the authoritative cumulative accounting): $0.048023648 accounted across
102 attempts, including $0.022 of conservative reservations for five early failed
Opus requests with no returned cost; **$1.051976352 remains** under the $1.10 cap.
Planning input tokens are Jev 627, Luna 302, Clef 504, Opus 600 (approved floor).
Worst-case estimates, 33 attempts per model per puzzle:

| Opus output cap | Required 1 warm-up + 5 primary | Primary only |
|---:|---:|---:|
| 64 | $0.763783812 | $0.636486510 |
| 96 | $0.890503812 | $0.742086510 |
| 128 | $1.017223812 | $0.847686510 |
| 160 | $1.143943812 (refused) | $0.953286510 |
| 192 | $1.270663812 (refused) | $1.058886510 (refused) |
| 512 | $2.537863812 (refused) | $2.114886510 (refused) |

A completed live warm-up also triggers duplicate protection: a new session repeating
it needs a documented `ALLOW_LIVE_RERUN=true` decision. A fresh checkout starts with
an empty ledger; reconcile it with the cumulative accounting before any paid step.

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
Deleting `.runs` removes saved run/SSE history and duplicate protection; the
separate `RECORDING_PATH` still supports one-click replay. Neither happens
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
finish reason and provider. Invalid moves, missing or above-600 Opus prompt counts,
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
| 3 | Live warm-up (also the rehearsal) | warmup / 1 / 101 | 30 |
| 4 | Primary, record this run | primary / 5 / 202 | 30 |
| 5 | Optional, only if gates permit | extension / 2 / 303 | 30 |
| 6 | Export and replay final slide | Persisted primary run | No calls |

After each live step, stop if spend exceeds 1.5× the section 6.2 expectation,
Opus truncations exceed 20%, a run aborted, or the next estimate exceeds remaining
budget. Skip the optional extension if refused; never raise the cap or rerun a
paid step casually. Demo retakes should reopen saved results.

Steps 3–5 are one session. There is no separate five-move live rehearsal in v1.3.0.

### Diagnose a failed smoke request

Stop after a failed smoke test; do not repeat all four models. First check the
failed request in OpenRouter Activity, if an entry is available. The original
generic `OpenRouter request failed` output cannot recover a discarded error body.

Smoke errors now print bounded, redacted diagnostic fields: HTTP status, upstream
code/message, provider/error type, nested provider message and request/generation
IDs when supplied. Transport failures print the exception class, not its text.
Full response bodies, request headers and arbitrary provider metadata are excluded.
These details stay in the CLI output; public API errors and retry policy are unchanged.

If the original cause is unavailable, a **separately human-approved paid probe** is:

```powershell
.\.venv\Scripts\python.exe scripts/live_smoke.py --diagnose-opus
```

This makes at most **one Opus request**, at the existing token cap, reasoning,
schema and price limits. It does not call the other three models, retry, run the
compatibility fallback, or calibrate. Mock/key/budget checks still apply and the
attempt goes into the existing ledger. Save the output and review it before
authorizing further calls. A diagnostic success does not guarantee every future
provider call will succeed. This probe is not a benchmark recording.

The solved-after-R state is trivial (Opus answered with 0 reasoning tokens) and does
not validate scrambled play. To diagnose the scrambled-state truncation instead,
a separately approved probe can target the exact failed warm-up puzzle (seed 101):

```powershell
.\.venv\Scripts\python.exe scripts/live_smoke.py --diagnose-opus-warmup
```

It has the same one-request limits and checks, and uses the configured
`CHAT_MAX_TOKENS` (64–512). It never recommends a cap. Run it only with the exact
approved settings and request count; see `OPUS_FINDINGS.md` for the proposal.

Typical clues: HTTP 400/422 points to request validation; 403 to access/policy;
404/503 can indicate no matching route; 429 to rate limits; 5xx to upstream
failure. Use the returned message to decide, rather than changing settings based
on status alone. Do not raise token/price limits or remove constraints just to
make a request pass. A 200 response with `length` or empty content remains an
invalid model response, not proof of an HTTP failure.

## One-click workflow: preview, record once, replay

1. **Preview without a key.** Leave `MOCK_MODELS=true`, start the backend, and
   click Run full benchmark. `source: "auto"` chooses `simulated` when there is no
   recording. The fixed plan is warm-up (1, seed 101), primary (5, seed 202), then
   optional extension (2, seed 303). All four models use the normal runner.
2. **Record once.** Complete the manual smoke and calibration prerequisites above,
   set the key and `MOCK_MODELS=false`, and restart. Choose the separate Run live
   action and confirm cost (`source: "live", confirm_cost: true`). Warm-up plus
   primary must pass their combined pre-check before anything starts. At the
   provisional 160-token cap and initial 600/300-token estimates this requires about
   $1.131491, already above the $1.10 cap; measured ledger counts can raise it.
   Set the human-approved calibrated output cap before attempting a live session
   and check the updated estimate (see review above). Successful
   sessions atomically save `recordings/benchmark.json`, including puzzles, full
   timestamped event logs, run snapshots and the session's ledger cost. A skipped
   extension still permits saving the completed required steps. Failed/cancelled
   sessions never create or replace a recording.
3. **Replay for retakes.** Every later auto click selects `replay`, with or without
   a key. New puzzle/run/trial IDs are created; recorded moves, confidence, invalid
   outputs, retries, latencies, totals and results are copied. Event timestamps
   and sequence numbers are new. Run/trial start and finish timestamps match
   playback events; run creation is the new queue time. These display-clock
   windows follow replay speed, while `total_time_s` and `latency_ms` retain
   their recorded values. Statistics equal the original measurements.
   Replay invokes no adapter, makes no OpenRouter request and writes no ledger
   rows. It never replaces the recording. The recording is intentionally tracked
   by Git when the human chooses to commit it.

`auto` **never selects live**, even when a funded key is configured. Explicit
`simulated` also stays offline in live mode. `GET /benchmark` reports the plan,
available sources, automatic selection and recording metadata without network
requests. A corrupt recording fails startup validation rather than silently
switching sources or spending money. Run only one backend process against the
recording, run store and ledger.

Simulation is a deterministic script keyed by cube state and model ID: Jev and
Luna use hundreds of milliseconds with reversible detours; Clef is fastest and
often reaches the move limit; Opus takes simulated seconds and solves the short
suites optimally. Jev has a scripted malformed attempt followed by a retry.
Confidence values are explicitly synthetic for the simulated decision personas.
The engine still validates and applies every accepted move. `total_time_s` in
simulation is the sum of simulated attempt latencies, including invalid attempts.
These personas do not predict real model performance.

`speed` ranges from 0.25 to 20 (default 1), scaling simulation sleeps and replay
event gaps only; reported move latencies and trial totals stay unchanged. Live
ignores speed. Set `include_extension: false` to create only the two required
runs. If replay includes extension but the recording has none, that session step
is `skipped`; its ordinary run is terminal `cancelled`, so SSE consumers close.

All run IDs exist immediately. Poll `GET /benchmark/sessions/{session_id}` and use
the unchanged `/runs/{run_id}`, `/events` and `/stats` endpoints. Runs execute
strictly in plan order. One session may be active at a time (409 includes
`active_session_id`). Live sessions also obey active-run and duplicate guards;
an existing recording blocks another paid session unless `ALLOW_LIVE_RERUN=true`.
That override never bypasses budget limits. `POST .../{session_id}/cancel` cancels
the active run and all remaining steps. Existing per-run cancellation also stops
the session. Sessions and runs survive restart as history, with no auto-resume.

### Automatic live step gates

After every live step, `runs[].gate` reports `passed`, actual `cost_usd`, its
`expected_cost_usd`, `opus_truncation_pct` and all applicable `reasons`:

| Reason | Failure condition |
|---|---|
| `cost_over_expected` | Step ledger cost > 1.5 × its `EXPECTED_COST_*` setting |
| `opus_truncation` | More than 20% of Opus attempts end with `length` or empty content |
| `run_aborted` | The run failed, including credentials or cost/call cap aborts |
| `budget` | The next step's worst-case estimate exceeds the remaining ledger budget |

Exactly 1.5× cost and exactly 20% truncation pass. With no Opus attempts the rate
is `null`. Passing gates automatically continue. A failed warm-up gate cancels
the remaining runs and fails the session without a recording. A gate after a
completed primary run skips only the extension, completes the session and saves
the required steps. An aborted required or extension run fails the session and
is never recorded. Gate stops set `stop_reason: "gate"`; there is no approval
pause or automatic retry of a paid step. A final step's gate is still reported.
Simulation and replay always have `gate: null` and `stop_reason: null`.

API example in PowerShell (safe auto):

```powershell
$api = 'http://localhost:8000/api/v1'
Invoke-RestMethod "$api/benchmark" | ConvertTo-Json -Depth 8
$session = Invoke-RestMethod "$api/benchmark/sessions" -Method Post -ContentType 'application/json' -Body '{"source":"auto","speed":4}'
Invoke-RestMethod "$api/benchmark/sessions/$($session.session_id)" | ConvertTo-Json -Depth 8
curl.exe -N "$api/runs/$($session.runs[0].run_id)/events"
# Follow primary/extension as they become running; default the final slide to primary.
Invoke-RestMethod "$api/runs/$($session.runs[1].run_id)/stats" | ConvertTo-Json -Depth 8
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
