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
