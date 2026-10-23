import type { ErrorBody } from './types';

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
    case 'conflict':
      return {
        title: 'Not possible right now',
        message: err.message,
        guidance: 'Refresh the model list; a model may be unavailable, or the run already finished.',
      };
    case 'upstream_error':
      return { title: 'OpenRouter returned an error', message: err.message, guidance: 'Retries were exhausted. Try again later.' };
    case 'upstream_timeout':
      return { title: 'OpenRouter timed out', message: err.message, guidance: 'Retries were exhausted. Consider a larger timeout_s.' };
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
