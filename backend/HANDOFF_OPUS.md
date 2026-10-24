# Handoff: resolve Opus truncation without repeating paid experiments

Prepared 2026-10-25 (Asia/Karachi). This is a technical handoff for another agent,
not authorization to make paid calls or restart a benchmark.

## Objective and current blocker

Find a defensible configuration for `anthropic/claude-opus-5.5` that returns one
valid Rubik's Cube move per request, within the project's budget and fairness
constraints. Then propose the smallest useful live validation to the human.
The eventual goal is one completed live benchmark session, saved for zero-cost
replay in the UI, after which the human intends to revoke the OpenRouter key.

**The problem is not resolved.** The request is accepted, but on scrambled states
Opus has spent its entire output allowance on reasoning and returned no move:
once at 512 tokens during calibration, then twice at 128 during the live warm-up.
A stronger shared prompt did not fix the warm-up. Do not describe mock-test
success, HTTP 200, or a request-schema fix as proof of valid model behavior.

The human explicitly declined more calibration and approved an uncalibrated
128-token benchmark. That one approved attempt has finished and stopped at its
warm-up gate. **That approval is exhausted; no subsequent paid calls are approved.**

## Workspace and ownership

- Windows / PowerShell workspace:
  `C:\Users\Hp\orca\workspaces\rubiks-cube-decisions\backend-api`
- Branch: `syedukkashah/backend-api`.
- Latest implementation commit: `d419783` (this handoff may have a later docs commit).
- Python: `backend\.venv\Scripts\python.exe` (Python 3.12).
- API contract: **1.3.0**.
- Work only in `/backend`. Do not edit `/frontend`, `/contract`, root `AGENTS.md`,
  or root `docs/HANDOFF.md` without new explicit authorization.
- Read `AGENTS.md` fully, especially 3, 5.6, 5.9, 5.10, 6.1 G1–G13, and 6.2.
  Also read `docs/HANDOFF.md` and `assignment-02.pdf`.
- Short `backend:` commits, no Co-Authored-By trailer. Do not stage unrelated files.
- This is a backend worktree, not main. Ensure these implementation commits are
  available before diagnosing from a different checkout. Do not replace local
  work or accounting artifacts with an older main checkout.

### Authority and safety constraints

1. The user requires permission for each new paid step. Offline investigation,
   mock-transport tests, and public documentation/metadata reads are allowed.
   Present a concrete request count, estimated cost, purpose, and stop conditions
   before seeking paid approval. Do not run smoke/calibration "to see what happens."
2. `MAX_SPEND_USD=1.10` is the enforced cumulative usage ceiling; settings reject
   larger values. The project ceiling is $1.20 including purchase fees. The user
   considered $1.20 usage but did **not** approve raising the cap.
3. Do not reset/delete the ledger, run store, completed runs, or duplicate guards
   to make a run fit. Conservative reservations are not confirmed actual charges.
4. Do not add fallback models, invent confidence, silently repair invalid moves,
   retry arbitrary 4xx errors, or change model routing using substring matching.
5. No `reasoning.effort="none"`, manual `thinking` object, or unsupported effort.
   No output cap above 512, higher effort, price-cap removal, or gate bypass.
   An experiment outside existing requirements needs a human decision first.
6. Keep keys in the ignored backend `.env`/process environment. Never print,
   copy into this handoff, commit, send to the UI, or include them in prompts/logs.
7. Run only one ledger-writing process. Stop the backend before an approved paid
   CLI probe. Do not run the CLI and live server concurrently.
8. The final user condition was to proceed only if the experiment matches the
   assignment requirements. Model substitutions or materially different rules
   must not be presented as satisfying the original assignment.

## Human-approved deviations and configuration

- Original AGENTS G3/G7 input-token target was 250. A valid Opus smoke response
  used 480 input tokens. The human explicitly approved a **600-token smoke guard**
  and **at least 600 input tokens in Opus budget estimates**. These override that
  earlier target. The full serialized chat request limit remains **1,100 chars**.
- The human rejected changing the 1,100-character bound to apply only to messages.
  Keep the bound on `len(json.dumps(full_request))`, including schema and routing.
- Temperature was removed under the existing G2 compatibility exception because
  Opus routes do not advertise it. Do not restore `temperature: 0` blindly.
- The human explicitly approved `CHAT_MAX_TOKENS=128` in `.env` and one live
  session without further calibration, with extension excluded. The setting is
  uncalibrated, and the resulting warm-up failed. It is not a validated default.
- Code and `.env.example` still default to 160. Actual local `.env` has 128.

Verified local settings at handoff (no key value was printed):

| Setting | Value |
|---|---|
| `.env` `MOCK_MODELS` | `true` |
| Running backend process override | `MOCK_MODELS=false`, `CHAT_MAX_TOKENS=128` |
| `CHAT_REASONING_EFFORT` | `low` |
| `MAX_SPEND_USD` | `1.10` |
| `MAX_TRIAL_RETRIES` | `3` |
| `ALLOW_LIVE_RERUN` | `false` |
| `recordings/benchmark.json` | Does not exist |

Environment overrides `.env`. A fresh CLI sees mock mode unless deliberately
overridden. Restart is needed to load code/settings changes; the backend has no
auto-reload. An existing key may still be configured; do not assume its presence
is permission to use it.

## Evidence: what was attempted, in order

### 1. Initial smoke and routing/schema errors

The three Decisions models returned valid moves. Several Opus probes failed:

- HTTP 404: `No endpoints found that can handle the requested parameters`.
  Cause found: `temperature` plus `provider.require_parameters=true` excluded
  advertised Opus routes. Fixed by omitting temperature, retaining price caps.
- Next request reached Azure but returned HTTP 400:
  `output_config.format.schema: Invalid regex in pattern field: Quantifier '?' without preceding element`.
  The schema used unsupported negative lookahead. Replaced it with
  `^[UDLRFB]['2]?$`; the adapter separately checks exact membership in the 18 moves,
  including rejecting trailing whitespace/newlines. No output coercion.
- Subsequent one-call solved-after-R probe succeeded on Claude Platform on AWS:
  move `R'`, prompt 480, completion 11, reported reasoning 0, cost $0.00214,
  finish `stop`, latency about 3,823 ms. It failed only the then-250 input guard.
  **This trivial successful probe did not validate scrambled-puzzle performance.**

### 2. Approved calibration, before stronger shared steering

Run `run_e436aad8e69d45ad9139cf3bc1e09ad4`:

- Calibration generates three 3-turn states using seeds 100, 101, 102.
- First request only, seed 100; `max_tokens=512`, effort `low`.
- Provider: Claude Platform on AWS.
- Prompt 478; completion 512; reasoning 512; no move; finish `length`.
- Latency about 12,506 ms; reported cost **$0.012152**.
- Script stopped because cost exceeded $0.012/call; no second or third call.
- No calibrated cap established. One truncation out of three planned samples
  would already exceed the 20% truncation gate.

Log: `backend/.spend/calibration-20261024-235417.txt`.

### 3. Offline mitigation, then approved live warm-up

Commit `d419783` changed the shared prompt for all four models to begin:
`Pick a move.Min moves.No deliberation.`

The exact full shared instruction is now:

```text
Pick a move.Min moves.No deliberation.URFDLB:9/face,row-major;letters=centres;CW/CCW=90,outside.
```

Chat still appends the exact required line:

```text
Reply immediately with only {"move":"<one allowed move>"}. No explanation.
```

Full request size: 1,058 chars with empty history, 1,099 with six two-character
moves. Shared move criteria and state format remain identical between interfaces.
This was a documented prompt-steering hypothesis, not a guaranteed fix.

The user declined another calibration and approved one warm-up + five primary
puzzles with cap 128, all four models, no extension. Session:
`sess_6bf8def5a89a401d9fd976a410bd7ae2`.

Warm-up run: `run_0f133a82679045d983c50131c4106bac`.
Seed 101, scramble `B2 F2 D2`, BFS optimum 3. Initial facelets:
`DDDUUUDDDLRLLRLRLRFFFFFFBBBUUUDDDUUURLRRLRLRLBBBBBBFFF`.

| Model | Result | Applied moves | Invalid attempts | Trial seconds |
|---|---|---:|---:|---:|
| Jev 1.13 | Move limit, unsolved | 30 | 0 | 16.4985 |
| GPT-6 Luna Decisions | Move limit, unsolved | 30 | 0 | 16.9509 |
| Cloudflare Clef | Move limit, unsolved | 30 | 0 | 21.3852 |
| Claude Opus 5.5 | Error, retries exhausted | 0 | 2 | 10.7279 |

Both Opus attempts used prompt **491**, completion **128**, reasoning **128**,
cost **$0.004524 each**; both truncated with no accepted move. The stronger prompt
did not prevent reasoning exhaustion. Do not retry it unchanged expecting a fix.

Warm-up gate: failed solely on `opus_truncation=100%` (allowed at most 20%).
Session status `failed`, `stop_reason="gate"`. Primary run
`run_9f48d2da390f407292b6b7b031286259` was cancelled **before any inference**.

The warm-up made 92 calls (30 + 30 + 30 + 2) and cost **$0.011658114**.
It has 194 persisted events. The warm-up run itself is `completed`, despite its
trial failures; the containing session is `failed`. No complete-session replay
recording was written. Cancelled primary rows in exports are unexecuted trials,
not measurements of five primary puzzles and not evidence of model failure.

## Current budget: use these values, not stale README estimates

Read from the local ledger after the warm-up:

- Accounted usage: **$0.048023648** across **102** inference attempts.
- Remaining local usage allowance: **$1.051976352**.
- Accounting includes **$0.022** of conservative reservations for five earlier
  failed Opus requests whose actual charges were not returned. Do not claim all
  of the accounted total was confirmed charged by OpenRouter.
- Current planning input tokens: Jev **627**, Luna **302**, Clef **504**, Opus **600**.
  Opus 600 is a human-approved floor; observations above it would increase it.
- Reference USD/million input/output: Jev .042/0, Luna .10/0, Clef .24/0,
  Opus 4/20. Re-check public provider metadata before proposing new live settings.

The six-puzzle required session uses 33 planned attempts per model per puzzle
(30 moves + 3 total trial retries). Current estimates, before future spending:

| Opus output cap | Required six-puzzle estimate |
|---|---:|
| 64 | $0.763783812 |
| 96 | $0.890503812 |
| 128 | $1.017223812 |
| 160 | $1.143943812 |
| 512 | $2.537863812 |

These are conservative planning estimates at current input counts, not guarantees
about future provider token overhead. Actual responses settle using `usage.cost`.
Three calibration calls at 512 have a planning allowance **$0.03792**. Reserving
all of that would leave **$1.014056352**, less than even the current 128-cap
six-puzzle estimate. Plan the cost of diagnosis AND subsequent experiments.
Do not lower a cap solely to pass the pre-check and call it calibrated.

The completed live warm-up also triggers duplicate protection. A new session
repeating that warm-up is not automatically authorized even if its budget fits.
`ALLOW_LIVE_RERUN=true` requires an explicit human decision, must be documented,
and does not bypass budget or gates. Do not delete the saved warm-up to evade it.

## Where to inspect / change code

| File | Responsibility |
|---|---|
| `app/adapters/chat_completions.py` | Request body, strict move parsing, truncation/empty flags |
| `app/adapters/prompts.py` | Shared instructions, criteria, exact chat short-answer line |
| `app/adapters/base.py` | HTTP calls, safe/redacted errors, usage parsing |
| `app/config.py` | Settings validation, prices, 600/300 input floors |
| `app/budget.py` | Ledger, measured input maxima, reservations, estimates |
| `scripts/live_smoke.py` | Paid smoke, one-call diagnosis, calibration, stop conditions |
| `app/runner/service.py`, `app/runner/calls.py` | Moves, retry policy, accounting |
| `app/sessions.py` | Fixed session plan, admission, gates, duplicate behavior |
| `app/recording.py` | Complete-session recordings and zero-inference replay |
| `scripts/export_results.py` | Offline summary/CSV export |

Current chat body uses `reasoning={"effort":"low","exclude":true}`,
`provider={"require_parameters":true,"max_price":{"prompt":4,"completion":20}}`,
strict JSON schema, and the configured total output cap. Temperature is absent.
`exclude` hides reasoning text; it does not stop billing or reserve answer tokens.

Calibration now stops immediately on missing/excessive input counts, excess cost,
truncation/empty answer, invalid move, missing completion count, or a sample whose
recommended cap exceeds 192. It never recommends a cap after failed calibration,
even if the failure occurs on the third sample. The ordinary runner retry policy
has not changed. The special omit-reasoning smoke fallback is only for a
reasoning-related HTTP 400, not for a 200 response truncated by the output limit.

Relevant commits, newest first:

- `d419783` shared concise-move steering; stop unusable calibration early.
- `74b8450` approved 600-token input guard and Opus budget floor.
- `7331082` budget estimates from measured input-token maxima.
- `58334a3` supported Opus move regex with exact backend validation.
- `1b5fa4c` remove unsupported Opus temperature parameter.
- `523a25e` safe Opus-only diagnostics.

## Saved artifacts and portability

Paths below are relative to `backend` unless stated otherwise:

- `.spend/ledger.jsonl`: authoritative cumulative local accounting.
- `.spend/calibration-20261024-235417.txt`: failed 512-token calibration.
- `.spend/opus-diagnostic-schema-20261024-224222.txt`: trivial successful probe.
- `.spend/opus-diagnostic-fixed-20261024-223536.txt`: earlier schema error.
- `.spend/opus-diagnostic.txt`, `.spend/smoke-output.txt`: earlier failures/smoke.
- `.spend/approved-live-session.json`: launch response only; it still says queued.
  Use the persisted session/API for the final status, not this historical receipt.
- `.runs/sessions/sess_6bf8def5a89a401d9fd976a410bd7ae2.json`: terminal gate outcome.
- `.runs/runs/run_0f133a82679045d983c50131c4106bac.json`: warm-up snapshot,
  events, execution config, call metrics.
- `results/session_review.md`: human-readable final outcome and qualifications.
- `results/benchmark_summary.md` and two run CSVs: offline export, including the
  cancelled primary. Do not use those cancelled rows as completed primary trials.

`.env`, `.spend/`, and `.runs/` are ignored; they will not arrive in a fresh clone.
`results/` is currently untracked and intentionally not committed by this handoff.
Do not copy `.env` to another agent. A recipient with only this document can use
the redacted evidence above and mock transports. Before any later paid work in a
new checkout, reconcile the existing cumulative accounting and duplicate history
with the human; do not silently start with an empty ledger.

README's 2026-10-25 investigation section predates the final warm-up: its claim
that the revised prompt has not been tried, and its budget snapshot, are stale.
This handoff and `results/session_review.md` contain the later result.

## Running UI/backend state (last verified; re-check before acting)

- Backend: `http://127.0.0.1:8000`, live process overrides noted above.
- UI connected to this backend: **http://127.0.0.1:5175**.
- Saved warm-up results:
  `http://127.0.0.1:5175/?run=run_0f133a82679045d983c50131c4106bac&view=results`
- Failed session:
  `http://127.0.0.1:5175/?session=sess_6bf8def5a89a401d9fd976a410bd7ae2`
- Port 5174 is a different frontend instance using MOCK DATA, including a fixture
  claiming a $0.58 recording exists. That is NOT this user's live recording.
- Port 5173 is a main-checkout UI with a missing font dependency. Use 5175.
- Frontend on 5175 runs from the separate `frontend-ui` checkout, started with
  `VITE_USE_MOCKS=false`; no frontend source files were changed by this agent.
- The UI displayed live SSE updates during the attempt and now displays saved
  results. Student badge showed `syed_ukkashah`, roll `23k-0055`.
- There are no active runs. Leave saved results intact. Server process IDs and
  Orca terminal handles are ephemeral; discover them instead of blindly killing.

If using Orca, load its `orca-cli` skill for terminals/browser. Its terminals in
this workspace use **Git Bash**, despite the agent's command shell being PowerShell.
Use quoted element references in PowerShell (`'@e17'`, not `@e17`). The extension
checkbox did not visibly toggle through the browser tool, so the approved session
was launched ONCE with the API body below and then opened by session URL:

```json
{"source":"live","confirm_cost":true,"include_extension":false,"speed":1}
```

This payload is historical evidence, NOT an instruction or approval to submit it.

## Official documentation reviewed

Re-check current primary sources; do not rely on model-name assumptions:

- https://platform.claude.com/docs/en/models/opus-5-5/migration-guide
- https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://openrouter.ai/api/v1/models/anthropic/claude-opus-5.5/endpoints

Findings as checked 2026-10-25: Opus 5.5 adaptive thinking cannot be disabled;
manual thinking budgets are rejected; `low` is its lowest effort. Omitted effort
defaults to `medium`, so omission is not an evidenced truncation fix. Total
`max_tokens` includes reasoning and the final answer. Prompt steering is soft and
wording-sensitive; it can affect quality and needs workload validation. The
provider returns usage/cost on the observed 200 responses. No evidence currently
shows that provider pinning, omitting reasoning, or an alternative parameter would
solve the budget/answer tradeoff. Do not assert such a fix without evidence.

## Suggested next work and acceptance criteria

1. Inspect saved request construction, response metrics, and current documentation
   offline. Distinguish API compatibility from insufficient reasoning/answer room.
   Reproduce the observed responses with `httpx.MockTransport` before editing.
2. Evaluate candidate changes against the full 1,100-char bound, same shared state,
   options and prompt policy, and original assignment intent. Any new direction
   must preserve genuine model-selected actions; no oracle, solver-injected move,
   fabricated success, or substitution hidden as Opus performance.
3. Show whether a candidate plus its validation expense can fit the remaining
   cumulative budget. If no credible configuration fits, say so and propose a
   requirement decision; do not silently weaken gates or promise a full result.
4. Make a concrete minimal probe plan for human approval. Do not repeat the
   solved-after-R probe as if it validates the failed multi-turn scramble. Do not
   rerun all four models just to investigate Opus. The user has already paid for
   their smoke and the failed warm-up.
5. Test changes offline and document limitations. Only after explicit paid
   approval may behavior be validated live; only after that and any necessary
   rerun approval may another session be considered.

Last full validation at `d419783`: **274 passed**, Ruff clean. One non-failing
Starlette/httpx deprecation warning; no dependency upgrade needed for this issue.
Tests globally block real httpx transports in `tests/conftest.py`.

Safe commands from `backend`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe scripts/export_results.py
```

The assignment's core experiment uses the specified four models, five primary
puzzles (20 trials), same scramble per puzzle, at most 30 moves, same timeouts and
retries, exact BFS reference distances, and honest failure reporting. The PDF
does not mandate a token cap or calibration; those are project cost controls.
Disclose the cap, effort, shared prompt, truncations, and limited inference about
model capability. The primary experiment is still incomplete. The PDF also
requires a screen-recorded demo with in-progress play, completion, final stats,
and student identity throughout. Backend replay JSON is not a video; the human
previously accepted replay for their demonstration, but instructor acceptance of
replay was not independently verified. Do not claim the submission is complete.
