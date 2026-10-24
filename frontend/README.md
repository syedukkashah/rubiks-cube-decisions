# Rubik's Cube Race — frontend

React 18 + Vite + TypeScript (strict) UI for the benchmark described in `../AGENTS.md`.
It talks only to the backend's `/api/v1` (contract v1.1.0, AGENTS.md section 5). It never calls
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
| `VITE_MOCK_SCENARIO` | `default` | Mock only. `missing_api_key`: backend has no `OPENROUTER_API_KEY` (503). `spend_cap`: `POST /runs` fails the spend pre-check (409 with cost details). `run_abort`: the replay is aborted mid-run with "Live spend cap reached" and the run ends `failed`. |
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

- **`/` Benchmark**
  - Controls: generate puzzles (`POST /puzzles`) or pick stored ones, choose models and fairness
    settings, then `POST /runs`. The run opens at `/?run=<run_id>`, which survives a reload.
  - Run status bar: progress, stream state, run picker and cancel.
  - Scrambled cube for the current or focused puzzle.
  - One lane per model: live cube, current move, a "waiting" state on `move_requested`, a flag on
    `move_invalid`, move history and a result banner.
  - Results-by-puzzle matrix.
  - Statistics dashboard from `GET /runs/{id}/stats`.
- **`/slide?run=<run_id>`**: a full-screen benchmark slide for the end of the recording. Without
  `?run`, it uses the newest completed run.

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

In mock mode, settings are sent and validated, but playback is always this recording. Mock runs are
kept in `localStorage`, so a reload or a new tab still finds them.


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
