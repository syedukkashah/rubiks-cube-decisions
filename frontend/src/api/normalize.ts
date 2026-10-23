// Response normalizers (AGENTS.md 5.1 and 9 rule 1):
// - unknown response fields are ignored (only contract fields are copied),
// - missing nullable fields become explicit null,
// - wrong-typed fields fall back to a neutral value instead of crashing the UI.
// No game logic lives here: values are copied, never derived.
import {
  KNOWN_EVENT_TYPES,
  type ErrorBody,
  type Health,
  type ModelInfo,
  type ModelStats,
  type MoveRecord,
  type Puzzle,
  type RunConfig,
  type RunEvent,
  type RunSnapshot,
  type RunStats,
  type RunStatus,
  type RunSummary,
  type Trial,
  type TrialError,
  type TrialStatus,
  type CreateRunResponse,
  type CancelRunResponse,
} from './types';

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean => v === true;
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'completed', 'cancelled', 'failed'];
const TRIAL_STATUSES: readonly TrialStatus[] = ['pending', 'running', 'solved', 'move_limit', 'error'];

export function normalizeErrorBody(raw: unknown): ErrorBody | null {
  const e = obj(obj(raw).error);
  if (typeof e.code !== 'string') return null;
  const details = e.details;
  return {
    code: e.code,
    message: str(e.message),
    details: details !== null && typeof details === 'object' && !Array.isArray(details) ? (details as Obj) : null,
  };
}

export function normalizeHealth(raw: unknown): Health {
  const o = obj(raw);
  return {
    status: str(o.status),
    contract_version: str(o.contract_version),
    api_key_configured: bool(o.api_key_configured),
  };
}

export function normalizeModel(raw: unknown): ModelInfo {
  const o = obj(raw);
  return {
    id: str(o.id),
    label: str(o.label, str(o.id)),
    category: oneOf(o.category, ['decision', 'frontier'], 'decision'),
    interface: oneOf(o.interface, ['decisions_api', 'chat_completions'], 'decisions_api'),
    available: bool(o.available),
  };
}

export const normalizeModels = (raw: unknown): ModelInfo[] => arr(obj(raw).models).map(normalizeModel);

export function normalizePuzzle(raw: unknown): Puzzle {
  const o = obj(raw);
  return {
    puzzle_id: str(o.puzzle_id),
    suite: oneOf(o.suite, ['warmup', 'primary', 'extension'], 'primary'),
    scramble_moves: arr(o.scramble_moves).map((m) => str(m)),
    facelets: str(o.facelets),
    optimal_distance: numOrNull(o.optimal_distance),
    created_at: str(o.created_at),
  };
}

export const normalizePuzzles = (raw: unknown): Puzzle[] => arr(obj(raw).puzzles).map(normalizePuzzle);

export function normalizeMoveRecord(raw: unknown): MoveRecord {
  const o = obj(raw);
  return {
    index: num(o.index),
    move: str(o.move),
    facelets_before: str(o.facelets_before),
    facelets_after: str(o.facelets_after),
    latency_ms: num(o.latency_ms),
    confidence: numOrNull(o.confidence),
    retries: num(o.retries),
  };
}

function normalizeTrialError(raw: unknown): TrialError | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = obj(raw);
  return { code: str(o.code), message: str(o.message) };
}

export function normalizeTrial(raw: unknown): Trial {
  const o = obj(raw);
  return {
    trial_id: str(o.trial_id),
    run_id: str(o.run_id),
    puzzle_id: str(o.puzzle_id),
    model_id: str(o.model_id),
    status: oneOf(o.status, TRIAL_STATUSES, 'pending'),
    initial_facelets: str(o.initial_facelets),
    current_facelets: str(o.current_facelets),
    moves: arr(o.moves).map(normalizeMoveRecord),
    moves_used: num(o.moves_used),
    solved: bool(o.solved),
    invalid_move_count: num(o.invalid_move_count),
    retry_count: num(o.retry_count),
    timeout_count: num(o.timeout_count),
    total_time_s: numOrNull(o.total_time_s),
    optimal_distance: numOrNull(o.optimal_distance),
    optimality_gap: numOrNull(o.optimality_gap),
    started_at: strOrNull(o.started_at),
    finished_at: strOrNull(o.finished_at),
    error: normalizeTrialError(o.error),
  };
}

function normalizeRunConfig(raw: unknown): RunConfig {
  const o = obj(raw);
  return {
    puzzle_ids: arr(o.puzzle_ids).map((v) => str(v)),
    model_ids: arr(o.model_ids).map((v) => str(v)),
    max_moves: num(o.max_moves),
    timeout_s: num(o.timeout_s),
    max_retries: num(o.max_retries),
    history_window: num(o.history_window),
    concurrency: num(o.concurrency),
  };
}

export function normalizeRunSnapshot(raw: unknown): RunSnapshot {
  const o = obj(raw);
  return {
    run_id: str(o.run_id),
    status: oneOf(o.status, RUN_STATUSES, 'queued'),
    config: normalizeRunConfig(o.config),
    created_at: str(o.created_at),
    started_at: strOrNull(o.started_at),
    finished_at: strOrNull(o.finished_at),
    last_seq: num(o.last_seq),
    trials: arr(o.trials).map(normalizeTrial),
  };
}

export function normalizeRunSummary(raw: unknown): RunSummary {
  const o = obj(raw);
  return {
    run_id: str(o.run_id),
    status: oneOf(o.status, RUN_STATUSES, 'queued'),
    created_at: str(o.created_at),
    finished_at: strOrNull(o.finished_at),
  };
}

export const normalizeRuns = (raw: unknown): RunSummary[] => arr(obj(raw).runs).map(normalizeRunSummary);

export function normalizeRunStatusResponse(raw: unknown): CreateRunResponse & CancelRunResponse {
  const o = obj(raw);
  return { run_id: str(o.run_id), status: oneOf(o.status, RUN_STATUSES, 'queued') };
}

function normalizeModelStats(raw: unknown): ModelStats {
  const o = obj(raw);
  return {
    model_id: str(o.model_id),
    label: str(o.label, str(o.model_id)),
    category: oneOf(o.category, ['decision', 'frontier'], 'decision'),
    trials: num(o.trials),
    solved_trials: num(o.solved_trials),
    success_rate_pct: numOrNull(o.success_rate_pct),
    avg_move_latency_ms: numOrNull(o.avg_move_latency_ms),
    avg_total_time_s: numOrNull(o.avg_total_time_s),
    total_moves: num(o.total_moves),
    avg_moves_per_trial: numOrNull(o.avg_moves_per_trial),
    avg_optimality_gap: numOrNull(o.avg_optimality_gap),
    invalid_move_count: num(o.invalid_move_count),
    retry_count: num(o.retry_count),
    timeout_count: num(o.timeout_count),
  };
}

export function normalizeRunStats(raw: unknown): RunStats {
  const o = obj(raw);
  const q = obj(o.questions_answered);
  return {
    run_id: str(o.run_id),
    run_status: oneOf(o.run_status, RUN_STATUSES, 'queued'),
    models: arr(o.models).map(normalizeModelStats),
    questions_answered: {
      fastest_model_id: strOrNull(q.fastest_model_id),
      highest_solve_rate_model_id: strOrNull(q.highest_solve_rate_model_id),
      best_optimality_gap_model_id: strOrNull(q.best_optimality_gap_model_id),
      fastest_is_also_best_quality: boolOrNull(q.fastest_is_also_best_quality),
    },
  };
}

/** Returns null for anything without a usable positive integer seq. */
export function normalizeEvent(raw: unknown): RunEvent | null {
  const o = obj(raw);
  const seq = o.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
  const base = {
    seq,
    run_id: str(o.run_id),
    trial_id: strOrNull(o.trial_id),
    ts: str(o.ts),
  };
  const d = obj(o.data);
  const type = typeof o.type === 'string' ? o.type : '';
  if (!(KNOWN_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ...base, type: 'unknown', data: {} };
  }
  switch (type as (typeof KNOWN_EVENT_TYPES)[number]) {
    case 'run_started':
      return { ...base, type: 'run_started', data: { trial_count: num(d.trial_count) } };
    case 'trial_started':
      return {
        ...base,
        type: 'trial_started',
        data: {
          puzzle_id: str(d.puzzle_id),
          model_id: str(d.model_id),
          initial_facelets: str(d.initial_facelets),
        },
      };
    case 'move_requested':
      return {
        ...base,
        type: 'move_requested',
        data: { move_index: num(d.move_index), attempt: num(d.attempt, 1) },
      };
    case 'move_invalid':
      return {
        ...base,
        type: 'move_invalid',
        data: {
          move_index: num(d.move_index),
          attempt: num(d.attempt, 1),
          reason: str(d.reason),
          raw_response: str(d.raw_response),
        },
      };
    case 'move_applied':
      return {
        ...base,
        type: 'move_applied',
        data: { ...normalizeMoveRecord(d), moves_used: num(d.moves_used), solved: bool(d.solved) },
      };
    case 'trial_finished':
      return { ...base, type: 'trial_finished', data: normalizeTrial(d) };
    case 'run_finished':
      return {
        ...base,
        type: 'run_finished',
        data: { status: oneOf(d.status, RUN_STATUSES, 'completed'), finished_at: strOrNull(d.finished_at) },
      };
    case 'error':
      return { ...base, type: 'error', data: { code: str(d.code), message: str(d.message) } };
  }
}
