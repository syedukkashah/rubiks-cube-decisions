import type { ApiClient, EventStreamHandlers } from './client';
import { ApiError } from './errors';
import {
  normalizeErrorBody,
  normalizeEvent,
  normalizeHealth,
  normalizeModels,
  normalizePuzzle,
  normalizePuzzles,
  normalizeRunSnapshot,
  normalizeRunStats,
  normalizeRunStatusResponse,
  normalizeRuns,
} from './normalize';
import { KNOWN_EVENT_TYPES, type CreatePuzzlesRequest, type CreateRunRequest, type Suite } from './types';

/** Drops undefined/null optional fields: the contract lets the client omit them (5.1). */
function compact<T extends object>(body: T): Partial<T> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

export function createHttpClient(baseUrl: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): ApiClient {
  async function request<T>(path: string, normalize: (raw: unknown) => T, init?: { method: string; body?: unknown }): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: init?.body !== undefined ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      throw ApiError.client('network_error', `Could not reach ${baseUrl}${path} (${err instanceof Error ? err.message : String(err)})`);
    }
    let json: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw ApiError.client('invalid_response', `Non-JSON response from ${path}`);
      }
    }
    if (!res.ok) {
      const body = normalizeErrorBody(json);
      throw new ApiError(
        res.status,
        body ?? { code: res.status >= 500 ? 'internal_error' : 'invalid_response', message: `HTTP ${res.status} from ${path}`, details: null },
      );
    }
    return normalize(json);
  }

  const enc = encodeURIComponent;

  return {
    mode: 'http',
    getHealth: () => request('/health', normalizeHealth),
    listModels: () => request('/models', normalizeModels),
    createPuzzles: (req: CreatePuzzlesRequest) => request('/puzzles', normalizePuzzles, { method: 'POST', body: compact(req) }),
    listPuzzles: (suite?: Suite) => request(suite ? `/puzzles?suite=${enc(suite)}` : '/puzzles', normalizePuzzles),
    getPuzzle: (id: string) => request(`/puzzles/${enc(id)}`, normalizePuzzle),
    createRun: (req: CreateRunRequest) => request('/runs', normalizeRunStatusResponse, { method: 'POST', body: compact(req) }),
    listRuns: () => request('/runs', normalizeRuns),
    getRun: (id: string) => request(`/runs/${enc(id)}`, normalizeRunSnapshot),
    cancelRun: (id: string) => request(`/runs/${enc(id)}/cancel`, normalizeRunStatusResponse, { method: 'POST' }),
    getStats: (id: string) => request(`/runs/${enc(id)}/stats`, normalizeRunStats),
    subscribeEvents: (runId: string, afterSeq: number, handlers: EventStreamHandlers) =>
      openEventSource(`${baseUrl}/runs/${enc(runId)}/events?after_seq=${afterSeq}`, handlers),
  };
}

/**
 * One EventSource connection (AGENTS.md 5.7). Native auto-reconnect is disabled on purpose:
 * on any error the source is closed and the caller resubscribes with ?after_seq=<last applied seq>,
 * so resume never depends on how the browser fills Last-Event-ID.
 */
export function openEventSource(url: string, handlers: EventStreamHandlers): () => void {
  const source = new EventSource(url);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };
  const onMessage = (msg: MessageEvent) => {
    if (closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(String(msg.data));
    } catch {
      return; // not a contract envelope; heartbeats are comments and never arrive here
    }
    const event = normalizeEvent(raw);
    if (event) handlers.onEvent(event);
  };
  source.onopen = () => {
    if (!closed) handlers.onOpen?.();
  };
  source.onerror = () => {
    if (closed) return;
    close();
    handlers.onError?.();
  };
  source.onmessage = onMessage;
  for (const type of KNOWN_EVENT_TYPES) source.addEventListener(type, onMessage as EventListener);
  return close;
}
