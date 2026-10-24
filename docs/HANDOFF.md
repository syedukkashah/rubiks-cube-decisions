# Handoff notes (append-only)

## 2026-10-24 orchestrator -> backend (Codex)

Contract is now v1.1.0 (`/contract` updated on main: version, `RunConfig` defaults `timeout_s 15` / `max_retries 1`, documented 409 reasons, `health.json`).

Task: implement AGENTS.md section 6.1, **G1-G13**, in `/backend` only.

- G1 settings/env (`MOCK_MODELS` default true, `MAX_SPEND_USD 5.00`, `MAX_LIVE_CALLS`, `CHAT_MAX_TOKENS`, `CHAT_REASONING_EFFORT`, caps, `RUNS_DIR`, `ALLOW_LIVE_RERUN`) and `.env.example`
- G2-G3 Opus request body (low effort, `max_tokens` cap, `max_price`) and compact shared prompt
- G4 retry matrix, G5 spend ledger + `POST /runs` worst-case pre-check (409) + mid-run backstops
- G7 `scripts/live_smoke.py` (+ `--calibrate`), G8 offline tests, G11 persistence, G12 one-live-run / no-rerun guard, G13 `scripts/export_results.py`
- Return `contract_version` 1.1.0 from `/health`; keep responses valid against `/contract/fixtures`.

**Budget (updated):** the whole assignment is capped at **$1.20 including the credit fee**. Implement `MAX_SPEND_USD=1.10` and make settings parsing reject anything higher; also `MAX_TRIAL_RETRIES=3`, provisional `CHAT_MAX_TOKENS=160`, and the pre-check formula in G5 (`max_moves + MAX_TRIAL_RETRIES` attempts per trial). The run plan in section 6.2 is 1 warm-up, 5 primary, optional 2 extension puzzles.

Rules: no live OpenRouter calls while building (mock mode and httpx mock transport only); the human runs live steps per section 6.2. Do not touch `/frontend` or `/contract`; log anything the contract needs in this file.

## 2026-10-24 orchestrator -> frontend (Claude Code)

Not urgent, after the backend work: AGENTS.md G9 follow-ups (`RUN_DEFAULTS` to `timeout_s 15`, `max_retries 1`; show 409 details incl. `duplicate_of_run_id` with an "Open that run" action; open any finished run from `GET /runs`; run controls accept fixed `seed` and `count`).

## 2026-10-24 orchestrator -> frontend (Claude Code): UI redesign

The human approved a new interface design. Rebuild `/frontend` to match it. Commit your in-progress worktree changes first so the redesign lands on a clean base.

**Design:** https://claude.ai/artifact/6fRBcPJCFhstiSob4Gsguq (canvas, 4 artboards). Same source, readable in the repo: `docs/design/{Setup,Main,Results,Slide}.dc.html`. Those files are design specs, not app code; they render only on the canvas (`./support.js`). Data in them is mock data (contract fixtures plus a replay of pz_03); the app keeps using `/contract/fixtures` and the live API.

### Design tokens (replace the current `:root` palette in `styles.css`)

- Ground `#0E0F11`, panel `#16181B`, raised `#1D2024`, hairline `#24272B` / control border `#2A2E33`.
- Text `#EDEEF0`, secondary `#C9CDD2`, muted `#A0A6AD`, labels `#8A9198` (all ≥ 4.5:1 on the panel).
- Status, always shown with an icon and text label, never colour alone: solved `#3DD68C`, move limit `#F5B13D`, error `#FF6B7A`, running/waiting `#8AB4FF`. Tinted pill backgrounds are the same colour at 12–13% alpha.
- Model identity (update `lib/modelColors.ts`, still assigned in `GET /models` order): Jev `#6EA8FE`, Luna `#C08CFF`, Clef `#3CCBDA`, Opus `#FF9466`. These are deliberately kept apart from the status colours.
- Stickers: U `#F2F3F5`, R `#E0393E`, F `#22A95B`, D `#F5CC2E`, L `#F28A1D`, B `#2D6BDF`.
- Type: Inter Tight (UI, 400–700) and JetBrains Mono (moves, numbers, IDs). Self-host them with `@fontsource/inter-tight` and `@fontsource/jetbrains-mono` so the recording never depends on a CDN.
- Radii: 16–18px cards, 10–14px controls, 7px move chips. 44px minimum touch targets.

### Screens to component mapping

1. **Header (every view):** logo, nav (Setup · Race · Results · Slide), stream status dot, mock/live chip, and `IdentityBadge` as a high-contrast light pill (`#F4F5F6` on dark). It stays fixed and topmost. Keep the loud "identity missing" state.
2. **Setup** (`/` with no `?run`): restyle `RunControls` as a 4-step form: suite cards (warm-up / primary / extension, with range and purpose), puzzle count stepper + seed + scramble length, model toggle cards (show `available`), and read-only fair-play chips (max moves 30, timeout 15 s, retries 1, history 6, concurrency 1, 18 moves HTM). Footer: spend pre-check panel (mock / passed / `409` blocked, showing `estimated_max_cost_usd` and `remaining_budget_usd` from the error details) next to the primary "Run benchmark · N trials" button. Right column: trials = puzzles × models summary, a below-20-primary-trials warning, and a previous-runs list from `GET /runs` (covers the G9 "open any finished run" item).
3. **Race** (`/?run=…` while not terminal), the in-progress stage:
   - Title row: suite, run ID, "Puzzle k of n", a 12-segment trial bar (one segment per trial, coloured by `Trial.status`), run clock, Cancel.
   - Left column (`PuzzlePanel`): large net of `Puzzle.facelets`, scramble chips, BFS optimum / move limit / metric tiles, a one-line fairness statement, and a compact puzzles × models mini-matrix.
   - `ModelLane` cards in a 2×2 grid. Each has: header (swatch, label, category · interface, status pill pulsing while running); net of `current_facelets`; a large "current move" glyph (mono 52px) that pops on each `move_applied`; 2×2 metrics (last call `latency_ms`, avg per move from partial `/stats` only, trial time, confidence or "not supplied"); a moves-used bar out of 30 with an "opt N" tick at `optimal_distance`; a single-row move-chip strip showing the last 9 chips plus a "+N" count. Invalid outputs appear as dashed, struck-through chips (`raw_response` or "timeout").
   - Each lane ends in a fixed-height status row (58px, no layout shift). While waiting it shows a per-call timeout gauge, elapsed since the latest `move_requested` against `timeout_s`, turning amber past 2/3, with "attempt k of max_retries+1". At the end it shows a verdict banner from `Trial.status`: "Solved in N moves · optimum · gap" / "Move limit reached · 30/30 · not solved" / "Error · retries exhausted · code".
   - Bottom: an **Event stream** panel showing the last 6 SSE events (seq, type, model, detail), newest first, with older lines fading. `move_invalid` lines in error colour, `trial_finished` in the status colour.
4. **Results** (same route once the run is terminal), the completion stage: header actions (Present slide → `/slide`, Export, New run). "Final state per puzzle": puzzle tabs plus 4 cards (final net, verdict, moves · gap). Results matrix (puzzles × models, BFS optimum column, pills "5 (+1)" / "4 · optimal" / "30 · limit" / "error", clicking a row selects the puzzle tab). Reliability table (invalid / retries / timeouts). Dashboard: 5 metric cards with horizontal bars per model (latency on a log scale; solve time; total moves; success rate; optimality gap, lower is better). Then `QuestionsAnswered` as 5 cards, Q5 being a dashed placeholder for the student's written conclusion.
5. **Slide** (`/slide`): fixed 16:9 at 1920×1080, scaled to fit the viewport. Title, run context line, a large identity badge, and one table (model rows × the five assignment metrics, mono 32px). Winning cells come only from `questions_answered` and get a green tint. Below that, 4 answer tiles and a source footer.

### Motion ("smooth")

- Sticker `background-color` transitions over 0.32s, so the net morphs between states instead of snapping.
- Move glyph and verdict banner use a 0.28s scale/opacity pop. Status dots and running segments pulse at 1.2s. Bars animate width over 0.25–0.5s.
- All of it is disabled under `prefers-reduced-motion`. Fixed heights on the chip strip, status row and event panel keep layout stable while events stream in.

### Rules that still apply

- Display backend values only (AGENTS.md section 9, rules 1–3). The timeout gauge and trial clock are display timers driven by event `ts`, not metrics.
- The "avg / move" figure on a lane comes from partial `GET /runs/{id}/stats`, never a client-side mean.
- Gaps come from `optimality_gap`. Winners come from `questions_answered`.
- Update the component tests for the new markup and keep the existing coverage (reducer ordering, snapshot+resume, banner states, stats from fixtures, identity badge on every view). `npm test` and `npm run build` must be green.
- Stay inside `/frontend`. Log any contract gap here.

## 2026-10-24 Claude Code → Codex

Frontend adapted to contract v1.1.0 (cost guardrails, AGENTS.md 5.6 and 6.1 G9). `/frontend` only.

- **What changed**
  - `RUN_DEFAULTS` now has `timeout_s: 15` and `max_retries: 1`, and `CONTRACT_VERSION` is `1.1.0`.
  - The run controls cap timeout at 1–20 s and retries at 0–1. These are the `MAX_TIMEOUT_S` /
    `MAX_RETRIES_CAP` defaults from G1. Out-of-range values block the start button instead of
    being sent.
  - A `409 conflict` on `POST /runs` with numeric `details.estimated_max_cost_usd` and
    `details.remaining_budget_usd` shows "Run blocked by spend cap" with both amounts. Without them,
    the generic conflict notice is shown. The frontend never estimates cost.
  - A run-level `error` event followed by `run_finished(failed)` is shown in the run status bar,
    e.g. "Live spend cap reached", "insufficient credits".
- **Endpoints and fields touched:** `POST /runs` request defaults and the 409 `details`;
  `GET /health` `contract_version`; SSE `error` and `run_finished`. Nothing else.
- **Not blocking, but needs a decision or follow-up:**
  1. ~~The G9 `contract:` commit has not landed.~~ Landed in 9838ef3; the mock now reads
     `contract_version` from `/contract/fixtures/health.json` again.
  2. **The recorded run in `/contract/fixtures` uses a config v1.1.0 rejects.** It was recorded with
     `timeout_s: 60` and `max_retries: 2`, which v1.1.0 would now answer with 422. One trial error
     message also says "timeout_s (60 s) on 3 attempts". G9 keeps shape-only fixtures unchanged, so
     this is cosmetic. Consider re-recording with the v1.1.0 defaults in the contract commit.
  3. **No shared fixture for the spend-cap 409.** The frontend keeps a local copy at
     `frontend/src/mocks/fixtures/error_spend_cap.json` (the 5.6 example values). Please add one to
     `/contract/fixtures` so backend tests and frontend mock mode share it.
  4. **Proposal (additive, needs human approval):** expose the effective `MAX_TIMEOUT_S` and
     `MAX_RETRIES_CAP` (e.g. on `GET /health`). The frontend hard-codes the G1 defaults 20 and 1, so
     if the backend env changes them, the UI limits drift. The backend still returns 422 in that
     case, so nothing breaks.
  5. **Proposal (additive, needs human approval):** add an optional `error: {code, message} | null`
     to the run snapshot (`GET /runs/{id}`). The run-level abort reason only arrives as a live SSE
     `error` event. After a page reload of a failed run, the UI can only say "No reason available".
