// Types for the JSON API contract v1.3.0 (AGENTS.md section 5).
// Field names, nullability and enums mirror the contract exactly; nothing here is invented.
// Every response passes through ./normalize.ts, which drops unknown fields and turns
// missing nullable fields into explicit nulls.

export const CONTRACT_VERSION = '1.3.0';

/** HTM face-turn metric, AGENTS.md 4.1. Display-only here: the backend validates moves. */
export type Move = string;
/** 54-character facelet string in Kociemba order U R F D L B (AGENTS.md 4.2). */
export type Facelets = string;
/** ISO-8601 UTC timestamp with Z suffix. */
export type Timestamp = string;

// ---------- 5.2 error envelope ----------

export type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'missing_api_key'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'internal_error';

export interface ErrorBody {
  code: ErrorCode | string;
  message: string;
  details: Record<string, unknown> | null;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

/** `details` of the 409 conflict POST /runs returns when the spend pre-check fails (5.6, 6.1 G5). */
export interface SpendCapDetails {
  estimated_max_cost_usd: number;
  remaining_budget_usd: number;
}

// ---------- 5.3 health ----------

export interface Health {
  status: string;
  contract_version: string;
  api_key_configured: boolean;
}

// ---------- 5.4 models ----------

export type ModelCategory = 'decision' | 'frontier';
export type ModelInterface = 'decisions_api' | 'chat_completions';

export interface ModelInfo {
  id: string;
  label: string;
  category: ModelCategory;
  interface: ModelInterface;
  available: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
}

// ---------- 5.5 puzzles ----------

export type Suite = 'warmup' | 'primary' | 'extension';

export interface CreatePuzzlesRequest {
  suite: Suite;
  count: number;
  scramble_length?: number | null;
  seed?: number | null;
}

export interface Puzzle {
  puzzle_id: string;
  suite: Suite;
  scramble_moves: Move[];
  facelets: Facelets;
  optimal_distance: number | null;
  created_at: Timestamp;
}

export interface PuzzlesResponse {
  puzzles: Puzzle[];
}

// ---------- 5.6 runs ----------

export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type TrialStatus = 'pending' | 'running' | 'solved' | 'move_limit' | 'error';

export interface RunConfig {
  puzzle_ids: string[];
  model_ids: string[];
  max_moves: number;
  timeout_s: number;
  max_retries: number;
  history_window: number;
  concurrency: number;
}

export interface CreateRunRequest {
  puzzle_ids: string[];
  model_ids?: string[];
  max_moves?: number;
  timeout_s?: number;
  max_retries?: number;
  history_window?: number;
  concurrency?: number;
}

/** Contract defaults for POST /runs (AGENTS.md 5.6 table, v1.1.0 cost guardrails). */
export const RUN_DEFAULTS = {
  max_moves: 30,
  timeout_s: 15,
  max_retries: 1,
  history_window: 6,
  concurrency: 1,
} as const;

/**
 * Bounds the backend accepts for POST /runs; anything outside is a 422 (5.6).
 * timeout_s and max_retries are capped by the backend's MAX_TIMEOUT_S / MAX_RETRIES_CAP
 * (6.1 G1 defaults) to limit API cost. Used for input limits only; the backend validates.
 */
export const RUN_LIMITS = {
  max_moves: { min: 1, max: 30 },
  timeout_s: { min: 1, max: 20 },
  max_retries: { min: 0, max: 1 },
  concurrency: { min: 1, max: 4 },
} as const;

export interface CreateRunResponse {
  run_id: string;
  status: RunStatus;
}

export interface RunSummary {
  run_id: string;
  status: RunStatus;
  created_at: Timestamp;
  finished_at: Timestamp | null;
}

export interface RunsResponse {
  runs: RunSummary[];
}

export interface MoveRecord {
  index: number;
  move: Move;
  facelets_before: Facelets;
  facelets_after: Facelets;
  latency_ms: number;
  confidence: number | null;
  retries: number;
}

export interface TrialError {
  code: string;
  message: string;
}

export interface Trial {
  trial_id: string;
  run_id: string;
  puzzle_id: string;
  model_id: string;
  status: TrialStatus;
  initial_facelets: Facelets;
  current_facelets: Facelets;
  moves: MoveRecord[];
  moves_used: number;
  solved: boolean;
  invalid_move_count: number;
  retry_count: number;
  timeout_count: number;
  total_time_s: number | null;
  optimal_distance: number | null;
  optimality_gap: number | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  error: TrialError | null;
}

export interface RunSnapshot {
  run_id: string;
  status: RunStatus;
  config: RunConfig;
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  last_seq: number;
  trials: Trial[];
}

export interface CancelRunResponse {
  run_id: string;
  status: RunStatus;
}

// ---------- 5.7 events ----------

export type InvalidReason = 'illegal_move' | 'malformed_response' | 'timeout' | 'upstream_error';

export interface RunStartedData {
  trial_count: number;
}
export interface TrialStartedData {
  puzzle_id: string;
  model_id: string;
  initial_facelets: Facelets;
}
export interface MoveRequestedData {
  move_index: number;
  attempt: number;
}
export interface MoveInvalidData {
  move_index: number;
  attempt: number;
  reason: InvalidReason | string;
  raw_response: string;
}
export interface MoveAppliedData extends MoveRecord {
  moves_used: number;
  solved: boolean;
}
export interface RunFinishedData {
  status: RunStatus;
  finished_at: Timestamp | null;
}
export interface RunErrorData {
  code: string;
  message: string;
}

interface EnvelopeBase<T extends string, D> {
  seq: number;
  type: T;
  run_id: string;
  trial_id: string | null;
  ts: Timestamp;
  data: D;
}

export type RunEvent =
  | EnvelopeBase<'run_started', RunStartedData>
  | EnvelopeBase<'trial_started', TrialStartedData>
  | EnvelopeBase<'move_requested', MoveRequestedData>
  | EnvelopeBase<'move_invalid', MoveInvalidData>
  | EnvelopeBase<'move_applied', MoveAppliedData>
  | EnvelopeBase<'trial_finished', Trial>
  | EnvelopeBase<'run_finished', RunFinishedData>
  | EnvelopeBase<'error', RunErrorData>
  /** An event type this client does not know. Its seq still counts for ordering. */
  | EnvelopeBase<'unknown', Record<string, never>>;

export type RunEventType = RunEvent['type'];

export const KNOWN_EVENT_TYPES = [
  'run_started',
  'trial_started',
  'move_requested',
  'move_invalid',
  'move_applied',
  'trial_finished',
  'run_finished',
  'error',
] as const satisfies readonly RunEventType[];

// ---------- 5.8 stats ----------

export interface ModelStats {
  model_id: string;
  label: string;
  category: ModelCategory;
  trials: number;
  solved_trials: number;
  // Averages are null while a model has no finished trials (partial stats, 5.8).
  success_rate_pct: number | null;
  avg_move_latency_ms: number | null;
  avg_total_time_s: number | null;
  total_moves: number;
  avg_moves_per_trial: number | null;
  avg_optimality_gap: number | null;
  invalid_move_count: number;
  retry_count: number;
  timeout_count: number;
}

export interface QuestionsAnswered {
  fastest_model_id: string | null;
  highest_solve_rate_model_id: string | null;
  best_optimality_gap_model_id: string | null;
  fastest_is_also_best_quality: boolean | null;
}

export interface RunStats {
  run_id: string;
  run_status: RunStatus;
  models: ModelStats[];
  questions_answered: QuestionsAnswered;
}

// ---------- 5.10 one-click benchmark, record and replay ----------

export type BenchmarkSource = 'simulated' | 'live' | 'replay';
export type BenchmarkRequestedSource = 'auto' | BenchmarkSource;
export type BenchmarkStep = 'warmup' | 'primary' | 'extension';

export interface PlanStep {
  step: BenchmarkStep;
  suite: Suite;
  count: number;
  seed: number;
  max_moves: number;
  optional: boolean;
}

export interface Recording {
  recording_id: string;
  recorded_at: Timestamp;
  session_id: string;
  trial_count: number;
  total_cost_usd: number | null;
}

export interface BenchmarkInfo {
  plan: PlanStep[];
  sources: Record<BenchmarkSource, boolean>;
  auto_source: 'simulated' | 'replay';
  recording: Recording | null;
}

export interface CreateSessionRequest {
  source?: BenchmarkRequestedSource;
  speed?: number;
  include_extension?: boolean;
  confirm_cost?: boolean;
}

/** Speed bounds for POST /benchmark/sessions (5.10); only paces simulated and replay sessions. */
export const SESSION_SPEED = { min: 0.25, max: 20, default: 1 } as const;

export type SessionRunStatus = RunStatus | 'skipped';

/** 6.2 gate a live step can fail (5.10 "Step gates", v1.3.0). Thresholds live in the backend. */
export type GateReason = 'cost_over_expected' | 'opus_truncation' | 'run_aborted' | 'budget';

export interface StepGate {
  passed: boolean;
  cost_usd: number;
  expected_cost_usd: number;
  opus_truncation_pct: number | null;
  reasons: (GateReason | string)[];
}

export interface BenchmarkSessionRun {
  step: BenchmarkStep;
  suite: Suite;
  run_id: string;
  status: SessionRunStatus;
  /** null until a live step is evaluated; always null for simulated and replay. */
  gate: StepGate | null;
}

export interface BenchmarkSession {
  session_id: string;
  source: BenchmarkSource;
  requested_source: BenchmarkRequestedSource;
  status: RunStatus;
  speed: number;
  created_at: Timestamp;
  finished_at: Timestamp | null;
  replay_of_session_id: string | null;
  recorded_at: Timestamp | null;
  total_cost_usd: number | null;
  /** "gate" when a failed step gate stopped a live session before its next step. */
  stop_reason: 'gate' | null;
  runs: BenchmarkSessionRun[];
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'cancelled', 'failed'];
export const TERMINAL_TRIAL_STATUSES: readonly TrialStatus[] = ['solved', 'move_limit', 'error'];

export const isTerminalRun = (s: RunStatus): boolean => TERMINAL_RUN_STATUSES.includes(s);
export const isTerminalTrial = (s: TrialStatus): boolean => TERMINAL_TRIAL_STATUSES.includes(s);
