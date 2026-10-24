# Opus 5.5 truncation: investigation findings

Prepared 2026-10-25 on branch `syedukkashah/opus-config` (cut from `81dd524`).
Offline only: no OpenRouter or model call was made, `MOCK_MODELS` was never set to
false, and no `.env` or key was read. Evidence came from the read-only run snapshots
and ledger of the original `backend-api` worktree, offline `httpx.MockTransport`
replays, and public documentation. Treat this as a technical assessment for a human
decision. **It does not show that Opus works, and the benchmark is still incomplete.**

## Bottom line

- **Not an API-compatibility problem (verified).** Every Opus request since the
  temperature/regex fixes was accepted (HTTP 200), routed, and billed at list price.
  The failure is that adaptive thinking used the whole `max_tokens` before any answer
  text: `finish_reason: length`, `native_finish_reason: max_tokens`, `content: null`,
  `reasoning_tokens == completion_tokens` (zero visible tokens).
- **No request parameter left to turn (documented).** Effort `low` is already the
  floor on Opus 5.5. OpenRouter ignores `reasoning.max_tokens` on adaptive-only Claude
  models. `verbosity` sets the same `output_config.effort`. Thinking cannot be disabled,
  and omitting effort means `medium`. The two documented remedies for `max_tokens`
  stops are a larger `max_tokens` or lower effort. Effort is at its floor, and a
  larger cap does not fit the budget.
- **No credible configuration fits the current rules (assessment).** Only caps of
  128 or less pass the required six-puzzle worst-case pre-check against the remaining
  $1.051976352. Opus has truncated on 3 of 3 scrambled states (128, 128, 512). A
  human must decide which requirement gives (section 6). I did not implement any of
  those options.

## 1. Evidence

All four Opus responses that reached the model, from the authoritative ledger and
run snapshots in `backend-api/backend/.spend` and `.runs` (read-only):

| Probe | State | Cap | Prompt | Completion | Reasoning | Finish | Move | Cost |
|---|---|---:|---:|---:|---:|---|---|---:|
| Smoke diagnosis | solved after `R` (trivial) | 160 | 480 | 11 | 0 | stop | `R'` | $0.00214 |
| Calibration | seed 100 (`D' R' L'`) | 512 | 478 | 512 | 512 | length | none | $0.012152 |
| Warm-up attempt 1 | seed 101 (`B2 F2 D2`) | 128 | 491 | 128 | 128 | length | none | $0.004524 |
| Warm-up attempt 2 | same state | 128 | 491 | 128 | 128 | length | none | $0.004524 |

- All three truncations were served by Claude Platform on AWS with `reasoning.effort:
  "low"`. Each cost equals `prompt*$4/M + completion*$20/M` exactly (for example
  491*4 + 128*20 = 4,524 micro-dollars), so the full cap was billed as output.
- The recorded warm-up bodies contain `native_finish_reason: "max_tokens"`,
  `content: null`, and a `reasoning_details` summary: *"I'm mapping out the current
  face states of the cube..."* and *"I'm trying to decode the scrambled cube state
  face by face, but the pattern across U, F, and R isn't resolving into something
  recognizable yet..."*. The model was still decoding the 54-character facelet
  string when the cap hit.
- Calibration seed 101 (`L B2 L2`) is **not** the warm-up puzzle (the warm-up path
  draws its length first). These are three distinct scrambled states.
- On the trivial state the model skipped thinking (0 reasoning tokens). This matches
  the documented `low` behaviour: "Skips thinking for simple tasks".

### Offline reproduction (verified)

A scratch replay fed the two recorded warm-up response bodies byte for byte through
the real `ChatAdapter` using `httpx.MockTransport`. Result: `move=None`,
`finish_reason=length`, `empty_content=True`, usage 491/128/128/$0.004524, provider
preserved, zero visible tokens. The bodies sent matched `build_request` exactly.
Request construction at cap 128 contains `max_tokens: 128`,
`reasoning: {"effort":"low","exclude":true}`, the strict schema with the supported
pattern, and `provider.require_parameters` plus `max_price` 4/20. It has no
`temperature`, `thinking`, `verbosity`, `reasoning_effort` or `reasoning.max_tokens`.
Size is 1,058 characters with empty history and 1,099 with six two-character moves.
Committed tests now pin this shape (section 5).

## 2. Root-cause assessment

| Claim | Status | Basis |
|---|---|---|
| Request schema, routing, parameters are compatible | **Verified** | HTTP 200, billed, provider named; no 4xx since the fixes |
| Output cap consumed entirely by reasoning, no answer room | **Verified** | `reasoning == completion == cap`, `native_finish_reason: max_tokens`, `content: null` |
| Adapter classifies it correctly and the ledger settles actual cost | **Verified offline** | MockTransport replay; new regression test |
| `effort: low` actually reached Anthropic | **Documented, not directly observable** | OpenRouter: "As of June 22, 2026 … maps `reasoning.effort` to Anthropic's `output_config.effort` on Claude 4.6 and newer models". Responses do not echo effort. The 0-reasoning trivial probe is consistent with `low`, but it is not proof |
| Why Opus thinks this much | **Hypothesis, supported by docs and summaries** | Effort is "a behavioral signal, not a strict token budget. At lower effort levels, Claude still thinks on sufficiently difficult problems". `max_tokens` is a hard cap the model does not see. Decoding a raw facelet string and choosing a move is such a problem, and the reasoning summaries show decoding in progress |
| Thinking needed on scrambled states exceeds 128, sometimes 512 | **Observed, n = 3** | 2/2 at 128 (same state), 1/1 at 512 (different state) |

Under a uniform prior, 2 truncations out of 2 at cap 128 leave a posterior
probability of `0.2^3 = 0.8%` that the success rate at 128 is at least 80%, the warm-up
gate's threshold. The two samples share one state, so this is indicative, not rigorous.
Repeating the 128-token warm-up unchanged is not a reasonable bet.

## 3. Documentation reviewed (2026-10-25)

- Anthropic, [Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost):
  `max_tokens` "is a hard cap on total output … thinking and response text combined";
  `effort` "is soft guidance … doesn't guarantee a token count". For a `max_tokens`
  stop, "Raise `max_tokens` … [or] Lower the effort level". "Lowering the effort level
  is usually the better first lever" than prompt steering, which "can be sensitive to
  exact wording" and "might reduce quality".
- Anthropic, [Effort](https://platform.claude.com/docs/en/build-with-claude/effort):
  five levels on Opus 5.5 (`low` to `max`), default `medium`. `low` is the lowest.
- Anthropic, [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
  and the [migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide):
  thinking cannot be disabled. "At `low` the model keeps its thinking short. How often
  it skips thinking altogether depends on your prompts". "Answer directly without
  deliberating." can reduce thinking further, but measure quality. "Lowering effort
  reduces thinking … more reliably than prompt instructions do."
- Anthropic, [Thinking troubleshooting](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting):
  Opus 5.5 is "Always on". It rejects `enabled` and `disabled`. A `max_tokens` stop has
  the same two remedies.
- Anthropic, [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs):
  the schema governs the text block. A `max_tokens` stop "might be incomplete". The
  injected schema prompt adds input tokens, not output.
- OpenRouter, [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens):
  a small `max_tokens` consumed by reasoning gives `finish_reason: "length"` with empty
  content, "still billed". `exclude` hides reasoning but it still counts against
  `max_tokens`. The `max_tokens * ratio` budget formula (minimum 1,024) is for
  budget-based models; Opus 5.5 rejects budgets, and the 200 responses at 128 show none
  was applied.
- OpenRouter, [Claude 4.7 migration](https://openrouter.ai/docs/guides/evaluate-and-optimize/model-migrations/claude-4-7),
  [Claude 4.6 migration](https://openrouter.ai/docs/guides/guides/model-migrations/claude-4-6),
  [Opus 5 migration](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/opus-5):
  `reasoning.max_tokens` "is accepted but ignored" (adaptive only). `reasoning.effort`
  and `verbosity` both set `output_config.effort`; "If both are passed, `verbosity`
  wins". `minimal` maps to `low`. Requests "that don't configure reasoning run with
  adaptive thinking enabled". No OpenRouter page covers Opus 5.5 specifically.
- OpenRouter, [Parameters](https://openrouter.ai/docs/api/reference/parameters):
  `verbosity` enum `low…max`; "For Anthropic models, this parameter maps to
  `output_config.effort`". `max_tokens` "covers reasoning tokens and visible output
  together".
- OpenRouter, [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection):
  pinning (`order`/`only`/`allow_fallbacks`) controls routing only. Nothing documents
  provider-specific thinking behaviour.
- OpenRouter, [Opus 5.5 endpoints](https://openrouter.ai/api/v1/models/anthropic/claude-opus-5.5/endpoints):
  11 endpoints. Amazon Bedrock, Azure, Google, Claude Platform on AWS and Anthropic are
  at $4/$20 (the regional variants cost $4.40/$22; Anthropic Fast costs $8/$40). The
  current `max_price` still excludes those. All endpoints advertise `reasoning`,
  `reasoning_effort`, `verbosity`, `max_tokens` and `response_format`; none advertises
  `temperature`. There is no `internal_reasoning` price. The reference prices in
  `config.py` are still correct.

## 4. Options considered

| Option | Permitted? | Evidence it helps | Cost / budget fit | Verdict |
|---|---|---|---|---|
| Raise cap toward 512 | Range allowed (64–512) | Docs: remedy #1. But 512 truncated once | Required session admits only caps ≤128 (table below) | Does not fit the budget |
| Lower effort below `low` | No level exists; `none` forbidden | n/a | n/a | Impossible |
| `reasoning.max_tokens` budget | Not forbidden as written | OpenRouter: ignored on adaptive-only Claude; budgets 400 on Opus 5.5 | Free | No effect; not a fix |
| `verbosity: "low"` | Gray area (same knob) | Maps to the same `output_config.effort`; floor is still `low` | Free | Duplicate of current setting. Test now forbids sending it, since it would override `reasoning.effort` |
| Omit `reasoning` (`CHAT_REASONING_EFFORT=omit`) | Allowed only after a reasoning 400 | Default effort becomes `medium` (more thinking) | Free | Counterproductive |
| Provider pinning (for example `anthropic`) | Would need a decision | None documented | Free | Unevidenced; not implemented |
| Task budget (`output_config.task_budget`) | New experiment | Beta, minimum 20,000 tokens, advisory, Anthropic Messages API; not documented for OpenRouter chat | n/a | Not applicable |
| Prompt steering (documented "Answer directly without deliberating.") | Shared-prompt change for all four models | Soft, wording-sensitive. The current "No deliberation." has the same intent and failed 2/2 | Request is 1,099/1,100 chars, so it would require deleting shared task text | Low expected value; not implemented |
| Richer shared state encoding | Changes all models and the 1,100-char bound | Unevidenced | Exceeds the bound | Needs a human decision; not recommended |
| Drop structured output | Weakens validation | Schema does not consume thinking tokens | Free | No effect on the cause |
| Fallback/substitute model | **Forbidden** (rule 3.8, G6) | n/a | n/a | Rejected |

### Budget fit

Worst-case admission estimates (33 attempts per model per puzzle; planning inputs Jev
627, Luna 302, Clef 504, Opus 600; reproduced offline with `app.budget.estimate_run`)
against **$1.051976352** remaining:

| Opus cap | Opus per call (max) | Warm-up + 5 primary | Fits | Primary only | Fits |
|---:|---:|---:|---|---:|---|
| 64 | $0.00368 | $0.763783812 | yes | $0.636486510 | yes |
| 96 | $0.00432 | $0.890503812 | yes | $0.742086510 | yes |
| 128 | $0.00496 | $1.017223812 | yes ($0.035 headroom) | $0.847686510 | yes |
| 160 | $0.00560 | $1.143943812 | **no** | $0.953286510 | yes |
| 192 | $0.00624 | $1.270663812 | **no** | $1.058886510 | **no** |
| 256 | $0.00752 | $1.524103812 | **no** | $1.270086510 | **no** |
| 512 | $0.01264 | $2.537863812 | **no** | $2.114886510 | **no** |

Even the expected (not worst-case) cost of a working higher cap does not fit. If Opus
answered every move using about 400 tokens, it would cost about $0.0099 per call, so
up to 198 Opus calls in six puzzles would cost about $1.96. Lowering the cap below 128
only to pass admission is ruled out by the handoff ("Do not lower a cap solely to pass
the pre-check"). It would also give Opus less room than the setting that already failed.

## 5. What I changed and why

All changes are offline-tested. No cap, gate, price, prompt or `.env` was changed.

- `backend/scripts/live_smoke.py`: added `--diagnose-opus-warmup`. It makes **one**
  Opus-only request on the exact failed warm-up puzzle (seed 101 via the same
  `generate_scrambles` path, asserted equal to the recorded facelets) at the configured
  `CHAT_MAX_TOKENS`. It keeps the existing diagnosis guards: mock/key/budget refusal,
  ledger reservation, 600-input and $0.012 stops, no retry or compatibility fallback,
  and it never recommends a cap. Reason: the only existing one-request probe used the
  trivial solved-after-R state, which the handoff says must not stand in for scrambled
  play. Calibration would re-run seed 100 at 512 first, repeating an already-failed
  experiment. This makes the optional probe below executable without ad-hoc code.
  **It has not been run.**
- `backend/tests/test_smoke_diagnostics.py`: added a regression replay of the recorded
  failure shape (`content: null`, `native_finish_reason`, `reasoning_details`, real
  usage). It asserts the adapter classifies the response as a truncation, records zero
  visible tokens, and that the ledger settles the actual $0.004524 with
  `estimated: false`. Also added tests for the warm-up diagnosis (one call, exact state,
  configured cap 128/512) and its refusals (non-diagnosis smoke, calibration, unknown
  state, mock mode), and a check that the seed-101 state matches the recorded puzzle.
- `backend/tests/test_guardrails.py`: the chat body must never contain `verbosity` or
  `reasoning_effort`. Per OpenRouter, `verbosity` overrides `reasoning.effort`.
- `backend/README.md`: replaced the stale claims (revised prompt "not measured", old
  $1.063634466 snapshot) with the warm-up result, the current $1.051976352 budget and
  estimate table, observed token counts, the `reasoning_details`-despite-`exclude`
  observation, and the new probe flag. The 2026-10-24 review is marked superseded.

Validation: `pytest -q` → 282 passed (baseline 274 + 8 new cases); `ruff check .` → clean.

## 6. Decision needed from the human

No defensible configuration within the current requirements both lets Opus 5.5 return
moves on scrambled states and passes the $1.10 worst-case admission. Pick one:

**D1. Run the required session with Opus failures reported, not gated.**
This is my recommendation if completing the five-puzzle comparison is the priority.
- What it means: keep effort `low`, cap 128 (already approved), and the same shared
  prompt. Make the session's `opus_truncation` gate report instead of stopping, for
  this one documented session. Set `ALLOW_LIVE_RERUN=true` because the warm-up repeats
  a completed run. Opus truncations stay counted `malformed_response` failures, as G2
  says: "Truncations caused by thinking hitting the cap are real Opus failures under
  this configuration and are reported as such."
- Cost: worst-case admission is $1.017223812 (fits). If Opus keeps truncating, each
  Opus trial ends after 2 attempts (about $0.009 per puzzle). Decisions models cost
  about $0.0026 per puzzle on the warm-up. Expected total is about $0.07 for six
  puzzles. The ledger's hard cap still applies.
- Pros: completes the required 20 primary trials under identical rules, with honest
  failure reporting, no substitution, and no invented moves. Cheap.
- Cons: Opus will likely record 0 moves per trial, so the result measures this
  cost-capped configuration, not Opus's cube-solving ability. The write-up must say so
  (G10). It needs a reviewed backend change to the gate (not implemented here) and an
  explicit rerun decision.

**D2. Keep the gate and stop.** Report the warm-up evidence and leave the primary
comparison incomplete. Costs nothing more, but fails the assignment's five-puzzle
requirement.

**D3. Higher cap via a budget or admission change.** Not recommended. Raising
`MAX_SPEND_USD` is forbidden in the repo and exceeds the $1.20 ceiling at caps that
might work (512 needs about $2.54 worst case). Switching to expected-cost admission
risks a mid-primary abort with an incomplete run, and 512 still truncated once.

## 7. Optional paid probe (needs explicit approval; low decision value)

I do **not** recommend any paid probe as a prerequisite for D1 or D2. No outcome makes
a cap above 128 affordable for the required session, and repeating 128 unchanged is
not a reasonable bet. The probe below only provides a descriptive number for the
written analysis: how much thinking Opus at `low` needs on the failed warm-up state.

- **Request count:** exactly 1, Opus only.
- **Command** (after the orchestrator merges this branch into the checkout that holds
  the authoritative ledger, with the backend server stopped and no other ledger
  writer):
  `CHAT_MAX_TOKENS=512`, `MOCK_MODELS=false` for this process only, then
  `.\.venv\Scripts\python.exe scripts/live_smoke.py --diagnose-opus-warmup`.
  Do not run it from a checkout with an empty ledger.
- **Cost:** the reservation is $0.01264 (600 × $4/M + 512 × $20/M). If it truncates at
  512 with 491 input tokens, the actual cost is about $0.012204, and less if it answers.
  Remaining budget after a worst case is about $1.039337, which still admits the D1
  session at cap 128 ($1.017223812).
- **Purpose:** record completion/reasoning tokens at 512 on the exact state that failed
  at 128. If it answers, the visible move is a genuine model choice. It is still a
  single sample, not calibration.
- **Stop conditions:** one request regardless of outcome (the mode never retries).
  Stop and report on any HTTP error, prompt tokens above 600, or missing usage. A
  truncation at 512 prints the existing "$0.012 per call" STOP line, which is
  expected. Do not follow up with calibration, a cap change, or another probe without
  new approval.
- **Interpretation:** a truncation at 512 means no permitted cap is likely to work. An
  answer with N tokens means the needed cap is about 1.5 × N, still above 128 unless
  N ≤ 85, which would contradict the two 128-token failures.

## 8. Uncertainties

- Whether OpenRouter forwarded `output_config.effort: low` cannot be confirmed from the
  responses. The docs say it has since 2026-06-22, and the trivial probe's 0 reasoning
  tokens is consistent with that.
- The sample is three scrambled calls, two on the same state. Variance across states
  and providers is unmeasured.
- Different steering wording might reduce thinking somewhat. No evidence shows it
  would bring scrambled states under 128, and it would change the shared prompt for all
  four models.
- No document reviewed describes per-provider differences in Opus thinking length.
- None of the offline tests show the real model works; they only pin request shape,
  classification and accounting.

## Addendum (2026-10-25): 512-token probe result and the human's decision

- **Probe.** The optional section 7 probe was approved and run once
  (`--diagnose-opus-warmup`, `CHAT_MAX_TOKENS=512`, seed-101 warm-up state). Opus
  answered `D2` with prompt 491, completion 266, reasoning 255, `finish_reason: stop`,
  cost $0.007284. So at effort `low` this state needed about 255 reasoning tokens,
  which explains both 128-token truncations. It is one sample on one state; seed 100
  still truncated at 512. Ledger after the probe: 103 attempts, $0.055307648.
- **Decision.** The human then decided: "yes, spend $2 for a real session, record
  everything on the backend so that every re-run is a [replay]". This replaces D1–D3
  above with a variant of D1 plus D3: the spend ceiling may be raised to $2.00 via the
  environment (code default still $1.10, hard maximum $2.00), and the
  `opus_truncation` gate may be set to `report` (`OPUS_TRUNCATION_GATE`, default `stop`).
  Truncations remain counted Opus failures.
- **Session configuration (prepared, not run).** `CHAT_MAX_TOKENS=336`: the largest
  multiple of 16 for which warm-up + 5 primary passes the worst-case pre-check with at
  least $0.05 left ($1.840903812 against $1.944692352). Gate baselines
  `EXPECTED_COST_WARMUP=0.22` and `EXPECTED_COST_PRIMARY=1.10` so the cost gate does
  not misfire on a session where Opus answers. `ALLOW_LIVE_RERUN=true` because the
  saved warm-up is a G12 duplicate (the cap and ceiling are not part of the duplicate
  signature). Details and arithmetic: `README.md`, "Approved $2 live session";
  launcher: `scripts/run_live_session.ps1`.
- **Still open.** 336 is budget-derived, not calibrated (the 1.5× rule would ask for
  400). The $2 ceiling exceeds the assignment's $1.20 and must be disclosed. Whether
  Opus answers reliably on the primary states is unknown until the session runs. The
  benchmark and the submission are **not** complete.

## Addendum 2 (2026-10-25): failed cap-336 session, new evidence, cap-512 second attempt

- **First session failed for an account reason.** `sess_e92516433a334c6db0adbacfec3fc4e2`
  (cap 336, `OPUS_TRUNCATION_GATE=report`) ended `failed` after $0.066881598: the
  OpenRouter account had zero credit ("insufficient credits") on the 17th Opus request
  of primary puzzle 1. Its warm-up `run_edcb6b0319f544e8a26fc83990d2f729` completed;
  the primary `run_acb06ad4715544768df3040c735042a2` failed (`run_aborted`). Nothing was
  recorded. Ledger now 302 attempts, $0.122189246 (including $0.03112 of conservative
  reservations); $1.877810754 remains under $2.00.
- **New evidence.** The seed-101 warm-up state answered in 266 completion tokens at cap
  512 (probe) but truncated at 336 on both attempts (`length`, 336 reasoning tokens,
  empty content); seed 100 truncated even at 512; on primary puzzle 1 Opus answered 16
  moves with `finish_reason: stop`, 10–11 output tokens, no reasoning, ~2.4 s and
  ~$0.0022 per call. Reasoning length varies strongly by state and sample.
- **Decision and configuration.** The human decided to "fix the truncation problem":
  cap **512** (hard maximum), effort `low`, prompt unchanged. Full admission prices
  6 puzzles × $0.422996442 = $2.537978652 and can never admit 512 under $2.00, so the
  human approved, for this session only, `LIVE_ADMISSION=rolling`: one puzzle's worst
  case + $0.05 ($0.472996442) must fit at admission, before every puzzle and for the next
  step; otherwise the run stops cleanly (`run_aborted`, nothing recorded). The per-call
  ledger still guarantees the $2.00 ceiling. Gate baselines `EXPECTED_COST_WARMUP=0.29`
  ($0.435 ≥ one-puzzle worst case) and `EXPECTED_COST_PRIMARY=1.41` ($2.115 ≥ five);
  `BENCHMARK_TIMEOUT_S=20` for all models (one cap-512 call took ~12.5 s). Arithmetic
  and stop conditions: `README.md`, "Second attempt: cap 512 with rolling admission".
- **Still open / risks.** Truncation at 512 remains possible on hard states and counts
  as an Opus failure; the cap is a project cost control, not a measure of model
  ability. $2.00 exceeds the assignment's $1.20 and AGENTS.md G1 and must be
  disclosed; the admission relaxation is a human-approved deviation for this session
  only. The benchmark and the submission are **not** complete.
