// Mock backend for VITE_USE_MOCKS=true. It replays a recorded run from ./fixtures
// through the same ApiClient interface and the same normalizers as the HTTP client,
// so the UI cannot tell the difference. It computes nothing about the game: every
// snapshot, event and stats payload comes from the recording.
import type { ApiClient, EventStreamHandlers } from '../api/client';
import { ApiError } from '../api/errors';
import {
  normalizeErrorBody,
  normalizeEvent,
  normalizeHealth,
  normalizeModels,
  normalizePuzzles,
  normalizeRunSnapshot,
  normalizeRunStats,
} from '../api/normalize';
import type { CreatePuzzlesRequest, CreateRunRequest, RunEvent, RunStatus, RunSummary, Suite } from '../api/types';
import { fixtures, RECORDED_RUN_ID } from './fixtures';

export interface MockOptions {
  /** 'default' | 'missing_api_key' */
  scenario?: string;
  /** Multiplier on playback delays; 0 replays everything at once (tests). */
  speed?: number;
  /** Simulated network latency for request/response calls, in ms. */
  latencyMs?: number;
  /** Keep mock runs in localStorage so a reload or a new tab (e.g. /slide) still finds them. */
  persist?: boolean;
}

const STORAGE_KEY = 'rubiks-cube-race:mock-runs';

type StoredRun = Pick<MockRun, 'id' | 'createdAt' | 'startedAtMs' | 'cancelSeq' | 'cancelEvent'>;

function loadStored(): StoredRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredRun[]) : [];
  } catch {
    return [];
  }
}

function saveStored(runs: Iterable<MockRun>) {
  try {
    const slim: StoredRun[] = [...runs].map(({ id, createdAt, startedAtMs, cancelSeq, cancelEvent }) => ({
      id,
      createdAt,
      startedAtMs,
      cancelSeq,
      cancelEvent,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim.slice(-20)));
  } catch {
    // storage unavailable (private mode, blocked): runs simply do not survive a reload
  }
}

interface MockRun {
  id: string;
  createdAt: string;
  startedAtMs: number;
  /** Playback offset (ms after start) of each recorded event, index = seq - 1. */
  offsets: number[];
  /** Set when cancelled: seq of the synthesized run_finished(cancelled) event. */
  cancelSeq: number | null;
  cancelEvent: unknown | null;
  listeners: Set<() => void>;
}

/** Compresses recorded gaps so a run plays in ~30 s while keeping fast vs slow models visible. */
const playbackDelay = (gapMs: number) => (gapMs <= 0 ? 0 : Math.min(1500, 60 + gapMs * 0.15));

const withRunId = <T>(value: T, runId: string): T =>
  JSON.parse(JSON.stringify(value).split(`"${RECORDED_RUN_ID}"`).join(JSON.stringify(runId))) as T;

export function createMockClient(options: MockOptions = {}): ApiClient {
  const scenario = options.scenario ?? 'default';
  const speed = options.speed ?? 1;
  const latency = options.latencyMs ?? 120;
  const persist = options.persist ?? false;
  const runs = new Map<string, MockRun>();
  let runCounter = 0;

  const recorded = fixtures.runEvents;
  const totalSeq = recorded.length;
  const buildOffsets = () => {
    let t = 0;
    return fixtures.runPlayback.gaps_ms.slice(0, totalSeq).map((gap) => (t += playbackDelay(gap) * speed));
  };

  if (persist) {
    for (const s of loadStored()) {
      runs.set(s.id, { ...s, offsets: buildOffsets(), listeners: new Set() });
      const n = Number.parseInt(s.id.replace(/\D+/g, ''), 10);
      if (Number.isFinite(n)) runCounter = Math.max(runCounter, n);
    }
  }
  const save = () => persist && saveStored(runs.values());
  const models = normalizeModels(fixtures.models);
  const puzzles = normalizePuzzles(fixtures.puzzles);

  const respond = <T>(value: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(value());
        } catch (err) {
          reject(err);
        }
      }, latency);
    });

  const fail = (status: number, code: string, message: string, details: Record<string, unknown> | null = null) =>
    new ApiError(status, { code, message, details });

  const getRunOrThrow = (id: string): MockRun => {
    const run = runs.get(id);
    if (!run) throw fail(404, 'not_found', `Unknown run ${id}`, { run_id: id });
    return run;
  };

  /** Highest recorded seq that has "happened" by now. */
  const playedSeq = (run: MockRun): number => {
    const elapsed = Date.now() - run.startedAtMs;
    let seq = 0;
    while (seq < totalSeq && (run.offsets[seq] ?? Infinity) <= elapsed) seq++;
    return run.cancelSeq !== null ? Math.min(seq, run.cancelSeq - 1) : seq;
  };

  const lastSeqOf = (run: MockRun) => (run.cancelSeq !== null ? run.cancelSeq : playedSeq(run));

  const statusOf = (run: MockRun): RunStatus => {
    if (run.cancelSeq !== null) return 'cancelled';
    const seq = playedSeq(run);
    if (seq >= totalSeq) return 'completed';
    return seq === 0 ? 'queued' : 'running';
  };

  /** Event with the given seq (1-based) as the backend would emit it for this run. */
  const eventAt = (run: MockRun, seq: number): RunEvent | null => {
    if (run.cancelSeq !== null && seq === run.cancelSeq) return normalizeEvent(run.cancelEvent);
    const raw = recorded[seq - 1];
    return raw === undefined ? null : normalizeEvent(withRunId(raw, run.id));
  };

  const summary = (run: MockRun): RunSummary => {
    const status = statusOf(run);
    const finished = status === 'completed' || status === 'cancelled';
    const lastEvent = finished ? eventAt(run, lastSeqOf(run)) : null;
    return {
      run_id: run.id,
      status,
      created_at: run.createdAt,
      finished_at: lastEvent?.type === 'run_finished' ? lastEvent.data.finished_at : null,
    };
  };

  return {
    mode: 'mock',

    getHealth: () =>
      respond(() =>
        normalizeHealth({
          ...(fixtures.health as object),
          api_key_configured: scenario !== 'missing_api_key',
        }),
      ),

    listModels: () => respond(() => models),

    createPuzzles: (req: CreatePuzzlesRequest) =>
      respond(() => {
        if (!Number.isInteger(req.count) || req.count < 1 || req.count > 50) {
          throw fail(422, 'validation_error', 'count must be between 1 and 50', { field: 'count' });
        }
        return puzzles.slice(0, req.count);
      }),

    listPuzzles: (suite?: Suite) => respond(() => (suite ? puzzles.filter((p) => p.suite === suite) : puzzles)),

    getPuzzle: (id: string) =>
      respond(() => {
        const p = puzzles.find((x) => x.puzzle_id === id);
        if (!p) throw fail(404, 'not_found', `Unknown puzzle ${id}`, { puzzle_id: id });
        return p;
      }),

    createRun: (req: CreateRunRequest) =>
      respond(() => {
        if (scenario === 'missing_api_key') {
          const body = normalizeErrorBody(fixtures.errorMissingApiKey);
          throw new ApiError(503, body ?? { code: 'missing_api_key', message: 'missing key', details: null });
        }
        if (!req.puzzle_ids.length) {
          throw fail(422, 'validation_error', 'puzzle_ids must contain at least one puzzle', { field: 'puzzle_ids' });
        }
        const unknown = (req.model_ids ?? []).find((id) => !models.some((m) => m.id === id));
        if (unknown) throw fail(422, 'validation_error', `Unknown model ${unknown}`, { field: 'model_ids' });
        runCounter += 1;
        const id = `run_mock_${String(runCounter).padStart(2, '0')}`;
        runs.set(id, {
          id,
          createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          // the recording's run_started has offset 0; leave a beat before it plays
          startedAtMs: Date.now() + 400 * speed,
          offsets: buildOffsets(),
          cancelSeq: null,
          cancelEvent: null,
          listeners: new Set(),
        });
        save();
        return { run_id: id, status: 'queued' as const };
      }),

    listRuns: () => respond(() => [...runs.values()].reverse().map(summary)),

    getRun: (id: string) =>
      respond(() => {
        const run = getRunOrThrow(id);
        const played = playedSeq(run);
        // Latest recorded checkpoint at or before what has played; SSE replays the rest.
        let best: unknown = fixtures.runSnapshots[0];
        for (const s of fixtures.runSnapshots) {
          if (normalizeRunSnapshot(s).last_seq <= played) best = s;
        }
        const snap = normalizeRunSnapshot(withRunId(best, id));
        return { ...snap, created_at: run.createdAt };
      }),

    cancelRun: (id: string) =>
      respond(() => {
        const run = getRunOrThrow(id);
        const status = statusOf(run);
        if (status === 'completed' || status === 'cancelled') {
          throw fail(409, 'conflict', `Run ${id} is already ${status}`, { status });
        }
        const seq = playedSeq(run) + 1;
        run.cancelSeq = seq;
        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        run.cancelEvent = {
          seq,
          type: 'run_finished',
          run_id: id,
          trial_id: null,
          ts,
          data: { status: 'cancelled', finished_at: ts },
        };
        save();
        run.listeners.forEach((notify) => notify());
        return { run_id: id, status: 'cancelled' as const };
      }),

    getStats: (id: string) =>
      respond(() => {
        const run = getRunOrThrow(id);
        const upTo = playedSeq(run);
        let best = fixtures.runStatsTimeline[0];
        for (const entry of fixtures.runStatsTimeline) if (entry.after_seq <= upTo) best = entry;
        const stats = normalizeRunStats(withRunId(best?.stats, id));
        return { ...stats, run_status: statusOf(run) };
      }),

    subscribeEvents: (id: string, afterSeq: number, handlers: EventStreamHandlers) => {
      const run = runs.get(id);
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!run) {
        timer = setTimeout(() => !closed && handlers.onError?.(), latency);
        return () => {
          closed = true;
          clearTimeout(timer);
        };
      }
      let delivered = afterSeq;

      const pump = () => {
        clearTimeout(timer);
        if (closed) return;
        const upTo = lastSeqOf(run);
        while (!closed && delivered < upTo) {
          delivered += 1;
          const event = eventAt(run, delivered);
          if (event) handlers.onEvent(event);
        }
        if (closed) return;
        const end = run.cancelSeq ?? totalSeq;
        if (delivered >= end) return; // stream "closes" after run_finished
        const nextAt = run.startedAtMs + (run.offsets[delivered] ?? 0);
        timer = setTimeout(pump, Math.max(0, nextAt - Date.now()));
      };

      run.listeners.add(pump);
      timer = setTimeout(() => {
        if (closed) return;
        handlers.onOpen?.();
        pump();
      }, latency);

      return () => {
        closed = true;
        clearTimeout(timer);
        run.listeners.delete(pump);
      };
    },
  };
}
