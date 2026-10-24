import type {
  BenchmarkInfo,
  BenchmarkSession,
  CreateSessionRequest,
  CancelRunResponse,
  CreatePuzzlesRequest,
  CreateRunRequest,
  CreateRunResponse,
  Health,
  ModelInfo,
  Puzzle,
  RunEvent,
  RunSnapshot,
  RunStats,
  RunSummary,
  Suite,
} from './types';

export interface EventStreamHandlers {
  onOpen?: () => void;
  onEvent: (event: RunEvent) => void;
  /** The stream dropped or the server closed it. The caller decides whether to resubscribe. */
  onError?: () => void;
}

/**
 * Everything the UI may ask of the backend (AGENTS.md 5.3–5.8).
 * Implemented by the HTTP client and by the fixture-driven mock, so switching
 * between them is purely VITE_USE_MOCKS.
 */
export interface ApiClient {
  readonly mode: 'http' | 'mock';
  getHealth(): Promise<Health>;
  listModels(): Promise<ModelInfo[]>;
  createPuzzles(req: CreatePuzzlesRequest): Promise<Puzzle[]>;
  listPuzzles(suite?: Suite): Promise<Puzzle[]>;
  getPuzzle(puzzleId: string): Promise<Puzzle>;
  createRun(req: CreateRunRequest): Promise<CreateRunResponse>;
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunSnapshot>;
  cancelRun(runId: string): Promise<CancelRunResponse>;
  getStats(runId: string): Promise<RunStats>;
  // 5.10 one-click benchmark sessions
  getBenchmark(): Promise<BenchmarkInfo>;
  createSession(req: CreateSessionRequest): Promise<BenchmarkSession>;
  getSession(sessionId: string): Promise<BenchmarkSession>;
  cancelSession(sessionId: string): Promise<BenchmarkSession>;
  /** Opens GET /runs/{id}/events replaying every event with seq > afterSeq. Returns a close function. */
  subscribeEvents(runId: string, afterSeq: number, handlers: EventStreamHandlers): () => void;
}
