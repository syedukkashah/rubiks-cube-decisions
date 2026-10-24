import type { ErrorBody, SpendCapDetails } from './types';

/** Client-side codes for failures that never reached a contract error envelope. */
export type ClientErrorCode = 'network_error' | 'invalid_response';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, body: ErrorBody) {
    super(body.message || body.code);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }

  static client(code: ClientErrorCode, message: string): ApiError {
    return new ApiError(0, { code, message, details: null });
  }
}

export interface ErrorDescription {
  title: string;
  message: string;
  /** Concrete next step for the operator, when there is one. */
  guidance: string | null;
}

const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The spend pre-check figures of a 409 from POST /runs (5.6), or null for any other error. */
export function spendCapDetails(err: unknown): SpendCapDetails | null {
  if (!(err instanceof ApiError) || err.code !== 'conflict') return null;
  const estimated = err.details?.estimated_max_cost_usd;
  const remaining = err.details?.remaining_budget_usd;
  return isAmount(estimated) && isAmount(remaining)
    ? { estimated_max_cost_usd: estimated, remaining_budget_usd: remaining }
    : null;
}

const idOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Something a 409 points at that the user can open instead (5.10, 6.1 G12). */
export type ConflictTarget = { kind: 'run'; id: string } | { kind: 'session'; id: string };

export function conflictTarget(err: unknown): ConflictTarget | null {
  if (!(err instanceof ApiError) || err.code !== 'conflict') return null;
  const d = err.details ?? {};
  const session = idOf(d.active_session_id);
  if (session) return { kind: 'session', id: session };
  const run = idOf(d.duplicate_of_run_id) ?? idOf(d.active_run_id);
  return run ? { kind: 'run', id: run } : null;
}

/** 409 `details.reason` values of POST /benchmark/sessions (5.10). */
const SESSION_CONFLICTS: Record<string, { title: string; guidance: string }> = {
  no_recording: {
    title: 'No live recording to replay yet',
    guidance: 'Run the benchmark once (simulated or live) first; a replay needs a saved live session.',
  },
  mock_mode: {
    title: 'Live run unavailable: backend is in mock mode',
    guidance: 'Set MOCK_MODELS=false and OPENROUTER_API_KEY in backend/.env, then restart the backend.',
  },
  recording_exists: {
    title: 'A live recording already exists',
    guidance: 'Replay it with "Run full benchmark" instead. A second live pass needs ALLOW_LIVE_RERUN=true on the backend.',
  },
  active_run: {
    title: 'Another live run is in progress',
    guidance: 'Wait for it to finish or cancel it, then try again.',
  },
};

/** Display formatting only: amounts are the backend's, never computed here. */
export function formatUsd(v: number): string {
  return `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

/** Maps a contract error (AGENTS.md 5.2) to a specific, human-readable notice. */
export function describeError(err: unknown): ErrorDescription {
  if (!(err instanceof ApiError)) {
    return {
      title: 'Unexpected error',
      message: err instanceof Error ? err.message : String(err),
      guidance: null,
    };
  }
  const field = typeof err.details?.field === 'string' ? err.details.field : null;
  switch (err.code) {
    case 'missing_api_key':
      return {
        title: 'Backend has no OpenRouter API key',
        message: err.message,
        guidance:
          'Set OPENROUTER_API_KEY in backend/.env (copy backend/.env.example) and restart the backend. ' +
          'The key stays on the backend; the browser never sees it.',
      };
    case 'validation_error':
      return {
        title: field ? `Invalid value for "${field}"` : 'Request rejected by validation',
        message: err.message,
        guidance: 'Adjust the benchmark settings and try again.',
      };
    case 'not_found':
      return {
        title: 'Not found',
        message: err.message,
        guidance: 'The backend may have restarted and lost in-memory runs. Start a new benchmark.',
      };
    case 'conflict': {
      const spend = spendCapDetails(err);
      if (spend) {
        return {
          title: 'Run blocked by spend cap',
          message:
            `Worst-case ${formatUsd(spend.estimated_max_cost_usd)}, ` +
            `remaining budget ${formatUsd(spend.remaining_budget_usd)}.`,
          guidance: 'Use fewer puzzles or models, or raise MAX_SPEND_USD on the backend.',
        };
      }
      const reason = typeof err.details?.reason === 'string' ? SESSION_CONFLICTS[err.details.reason] : undefined;
      if (reason) return { title: reason.title, message: err.message, guidance: reason.guidance };
      const target = conflictTarget(err);
      if (target?.kind === 'session') {
        return {
          title: 'A benchmark session is already running',
          message: err.message,
          guidance: `Open session ${target.id} to follow it, or cancel it first.`,
        };
      }
      if (target && err.details?.duplicate_of_run_id) {
        return {
          title: 'This exact live run already exists',
          message: err.message,
          guidance: `Open ${target.id} instead; its results are saved. Re-running live needs ALLOW_LIVE_RERUN=true.`,
        };
      }
      if (target) {
        return { title: 'Another live run is in progress', message: err.message, guidance: `Open ${target.id} to follow it.` };
      }
      return {
        title: 'Not possible right now',
        message: err.message,
        guidance: 'Refresh the model list; a model may be unavailable, or the run already finished.',
      };
    }
    case 'upstream_error':
      return { title: 'OpenRouter returned an error', message: err.message, guidance: 'Retries were exhausted. Try again later.' };
    case 'upstream_timeout':
      return { title: 'OpenRouter timed out', message: err.message, guidance: 'Retries were exhausted. Try again later.' };
    case 'internal_error':
      return { title: 'Backend error', message: err.message, guidance: 'Check the backend logs.' };
    case 'network_error':
      return {
        title: 'Backend unreachable',
        message: err.message,
        guidance:
          'Start the backend (uvicorn app.main:app --reload --port 8000) or set VITE_USE_MOCKS=true in frontend/.env.',
      };
    case 'invalid_response':
      return { title: 'Unexpected response from backend', message: err.message, guidance: null };
    default:
      return { title: `Error: ${err.code}`, message: err.message, guidance: null };
  }
}
