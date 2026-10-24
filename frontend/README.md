# Rubik's Cube Race — frontend

React 18 + Vite + TypeScript (strict) UI for the benchmark described in `../AGENTS.md`.
It talks only to the backend's `/api/v1` (contract v1.3.0, AGENTS.md section 5). It never calls
OpenRouter, never holds an API key, and never computes moves, solved state or statistics. It
renders what the backend reports.

## Setup

```bash
cd frontend
npm install
cp .env.example .env      # then fill in VITE_STUDENT_NAME and VITE_STUDENT_ROLL
```

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `/api/v1` | API base path. The dev server proxies `/api` to `BACKEND_URL`. |
| `VITE_USE_MOCKS` | `false` | `true` replays the recorded fixture run in `/contract/fixtures`. No backend needed. |
| `VITE_MOCK_SCENARIO` | `default` | Mock only. `default`: a live recording exists, so one click replays it. `no_recording`: no recording and no key, so one click simulates. `live_ready`: key set, no recording; "Run live once" is offered and saves a recording. `gate_stop`: like `live_ready`, but the warm-up gate fails and stops the session. `missing_api_key`: backend has no `OPENROUTER_API_KEY` (503). `spend_cap`: the spend pre-check fails (409 with cost details). `run_abort`: a custom run is aborted mid-run with "Live spend cap reached" and ends `failed`. |
| `VITE_STUDENT_NAME` / `VITE_STUDENT_ROLL` | (empty) | Identity badge shown on every screen. If either is empty, the badge shows a red warning instead. |
| `BACKEND_URL` | `http://localhost:8000` | Dev-server proxy target. It is not exposed to the browser. |

## Run

```bash
npm run dev        # http://localhost:5173 (the backend must be on :8000 unless VITE_USE_MOCKS=true)
npm run build      # type-check + production build into dist/
npm test           # vitest (reducer ordering/resume, client, components, end-to-end on mocks)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

Switching between mock data and the live backend changes only `VITE_USE_MOCKS`. You must restart
`npm run dev` after editing `.env`.

## Views

The header on every view has the nav (Setup · Race · Results · Slide), the stream state, the
session source chip, the mock/backend chip and the student identity badge.

- **Setup (`/`)**
  - **Run full benchmark**: one click runs the whole plan from `GET /benchmark` (warm-up 1 puzzle,
    primary 5, optional extension 2, all × 4 models) via `POST /benchmark/sessions` with
    `source: "auto"` and a playback speed of 1×, 2× or 4×. `auto` never spends: the backend replays
    the saved live recording if there is one, otherwise it simulates. The panel says which before
    you click.
  - **Run live once…**: only shown when the backend reports `sources.live`. It needs an explicit
    acknowledgement and sends `source: "live", confirm_cost: true`. A completed live session is
    saved as the recording, and every later "Run full benchmark" replays it with no OpenRouter calls.
  - **Advanced · one custom run**: suite, count, seed, scramble length, models and fair-play limits,
    through `POST /puzzles` + `POST /runs`.
  - Previous runs from `GET /runs`, and the last one-click session in this browser.
- **Race (`/?session=<id>` or `/?run=<id>` while running)**: session steps with their gates, trial
  progress, clock and cancel; the shared scramble and mini-matrix; one lane per model (live cube,
  current move, latency, moves-used bar, move chips, timeout gauge or verdict); the event stream.
  A session switches the view from step to step by itself.
- **Results (when the run or session is over)**: final cube per model and puzzle, results matrix,
  reliability, five metric cards, the assignment questions, JSON export and "Present slide".
  A session opens on its primary run; the step list picks any other.
- **Slide (`/slide?session=<id>` or `/slide?run=<id>`)**: the 1920×1080 presentation slide, scaled
  to the window. Without a parameter it uses the newest completed run.

`?view=race|results` forces either stage, e.g. to look at the lanes of a finished run.

The source chip never presents a replay as live: "Replay of live recording · <date>", "Live ·
OpenRouter" or "Simulated · no OpenRouter calls". A replay shows the recorded latencies.

## Recording workflow

1. Without a key, "Run full benchmark" simulates. Use this to check the UI.
2. Add `OPENROUTER_API_KEY` to `backend/.env`, run the backend's smoke and calibration checks, then
   use "Run live once…". The backend checks each step's gate (cost against expected, Opus
   truncations, aborts, budget) and stops before the next step if one fails.
3. From then on, every "Run full benchmark" replays that one live session at the chosen speed, as
   often as you want to record, with no OpenRouter calls.

## Cost guardrails (contract v1.1.0)

- Run defaults are `timeout_s: 15` and `max_retries: 1` (`RUN_DEFAULTS` in `src/api/types.ts`).
- The run controls limit timeout to 1–20 s and retries to 0–1, the backend's `MAX_TIMEOUT_S` and
  `MAX_RETRIES_CAP` defaults (AGENTS.md 6.1 G1). Out-of-range values block the start button
  instead of earning a 422.
- A `409 conflict` from `POST /runs` with `details.estimated_max_cost_usd` and
  `details.remaining_budget_usd` shows "Run blocked by spend cap" with both amounts. Without those
  details it falls back to the generic conflict notice. The frontend only displays these figures; it
  never estimates cost.
- A run-level `error` event followed by `run_finished` with status `failed` (e.g. "Live spend cap
  reached", "insufficient credits") is shown in the run status bar.

## How live state works

`src/state/runReducer.ts` builds the run from the `GET /runs/{id}` snapshot plus SSE events applied
strictly in `seq` order:

- Duplicates (`seq <= last_seq`) are dropped.
- Events after a gap are buffered until the gap fills. If a gap persists for 3 s, the snapshot is
  refetched to repair it.
- On a dropped stream, the client resubscribes with `?after_seq=<last applied seq>`, using
  exponential backoff.

The tests replay the recorded backend event log (also shuffled and duplicated) and check that the
result equals the backend's own snapshots.

## Mock fixtures

Mock mode and the tests read the shared `/contract/fixtures/*.json` (via `src/mocks/fixtures.ts`).
Only `src/mocks/fixtures/run_playback.json` (replay timing) is frontend-specific.

The fixtures are one recorded run: 3 primary puzzles × 4 models = 12 trials and 198
events. It covers solved, move-limit and error outcomes, illegal and malformed outputs, a timeout
retry, a mid-run snapshot checkpoint, and stats after every finished trial. The facelet strings and
BFS optima were generated offline with a cube model that is not part of this frontend.

In mock mode, settings are sent and validated, but playback is always this recording. A one-click
session chains one replay per plan step; live sessions add passing gates (or the failing gate from
`benchmark_session_gate_stop.json`). Mock runs, sessions and the mock recording are kept in
`localStorage`, so a reload or a new tab still finds them.


## Contract notes for the backend (proposed `docs/HANDOFF.md` entries)

The frontend makes these assumptions where AGENTS.md section 5 is silent:

1. `GET /runs/{id}` lists **every** trial of the run, including `pending` ones. Trials that first
   appear in a `trial_started` event are handled, but optimal distance is unknown until they finish.
2. Resume uses `?after_seq=` only. The client does not use native `Last-Event-ID` reconnects, so the
   precedence between the two does not matter to it.
3. `move_applied.data` is the MoveRecord fields plus `moves_used` and `solved`, flattened into one
   object.
4. Stats averages (`success_rate_pct`, `avg_*`) may be `null` while a model has no finished trials.
   The UI shows "—".
5. A trial that ends because invalid outputs exhausted its retries has no dedicated error code in
   section 5.2. The UI displays whatever `code` and `message` arrive.
6. While a trial runs, its `invalid_move_count`, `retry_count` and `timeout_count` are shown only
   after `trial_finished`. Before then, rejected outputs appear live from `move_invalid` events.
7. The section 5.6 example snapshot shows `status: "running"` together with a trial that is
   `solved: true` but `status: "running"`. The UI trusts `Trial.status` for the result.
