// Mock backend for VITE_USE_MOCKS=true. It replays a recorded run from ./fixtures
// through the same ApiClient interface and the same normalizers as the HTTP client,
// so the UI cannot tell the difference. It computes nothing about the game: every
// snapshot, event and stats payload comes from the recording.
//
// One-click benchmark sessions (5.10) are scripted on top: each plan step is one more
// replay of the same recorded run, started when the previous one finishes.
import type { ApiClient, EventStreamHandlers } from '../api/client';
import { ApiError } from '../api/errors';
import {
  normalizeBenchmarkInfo,
  normalizeErrorBody,
  normalizeEvent,
  normalizeHealth,
  normalizeModels,
  normalizePuzzles,
  normalizeRunSnapshot,
  normalizeRunStats,
  normalizeSession,
} from '../api/normalize';
import {
  SESSION_SPEED,
  type BenchmarkInfo,
  type BenchmarkRequestedSource,
  type BenchmarkSession,
  type BenchmarkSource,
  type BenchmarkStep,
  type CreatePuzzlesRequest,
  type CreateRunRequest,
  type CreateSessionRequest,
  type Recording,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  type SessionRunStatus,
  type StepGate,
  type Suite,
} from '../api/types';
import { fixtures, RECORDED_RUN_ID } from './fixtures';

/**
 * - `default`: a live recording exists, so the one-click benchmark replays it.
 * - `no_recording`: nothing recorded yet and no key; the one-click benchmark simulates.
 * - `live_ready`: key set and MOCK_MODELS=false; "Run live once" is offered and saves a recording.
 * - `gate_stop`: like live_ready, but the warm-up's step gate fails and stops the live session.
 * - `missing_api_key`: no OPENROUTER_API_KEY on the backend; POST /runs is a 503.
 * - `spend_cap`: POST /runs and live sessions fail the spend pre-check with a 409 (5.6, 6.1 G5).
 * - `run_abort`: a run is aborted mid-way by the live spend cap (6.1 G4):
 *   a run-level `error` event, then `run_finished` with status `failed`.
 */
export type MockScenario =
  | 'default'
  | 'no_recording'
  | 'live_ready'
  | 'gate_stop'
  | 'missing_api_key'
  | 'spend_cap'
  | 'run_abort';

export interface MockOptions {
  scenario?: MockScenario | string;
  /** Multiplier on playback delays; 0 replays everything at once (tests). */
  speed?: number;
  /** Simulated network latency for request/response calls, in ms. */
  latencyMs?: number;
  /** Keep mock runs in localStorage so a reload or a new tab (e.g. /slide) still finds them. */
  persist?: boolean;
}

/** How a run stops early: synthesized events that follow recorded seq `afterSeq`. */
interface MockEnding {
  afterSeq: number;
  status: 'cancelled' | 'failed';
  /** Raw event envelopes with seq afterSeq + 1, afterSeq + 2, … */
  events: unknown[];
}

interface MockRun {
  id: string;
  createdAt: string;
  startedAtMs: number;
  /** Delay multiplier of this run (1 = default mock pace; sessions divide it by their speed). */
  pace: number;
  /** Playback offset (ms after start) of each recorded event, index = seq - 1. */
  offsets: number[];
  ending: MockEnding | null;
  listeners: Set<() => void>;
}

interface MockSessionRun {
  step: BenchmarkStep;
  suite: Suite;
  run_id: string;
}

interface MockSession {
  id: string;
  source: BenchmarkSource;
  requested: BenchmarkRequestedSource;
  speed: number;
  createdAt: string;
  finishedAt: string | null;
  replayOf: string | null;
  recordedAt: string | null;
  cancelled: boolean;
  /** Index of the step whose gate fails and stops the session (gate_stop scenario). */
  gateStopAt: number | null;
  runs: MockSessionRun[];
}

const STORAGE_KEY = 'rubiks-cube-race:mock-runs:v3';

type StoredRun = Pick<MockRun, 'id' | 'createdAt' | 'startedAtMs' | 'pace' | 'ending'>;

interface Stored {
  runs: StoredRun[];
  sessions: MockSession[];
  /** undefined = nothing stored yet, so the scenario decides. */
  recording?: Recording | null;
}

function loadStored(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = (raw ? JSON.parse(raw) : null) as Partial<Stored> | null;
    if (!parsed || typeof parsed !== 'object') return { runs: [], sessions: [] };
    return {
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      recording: parsed.recording,
    };
  } catch {
    return { runs: [], sessions: [] };
  }
}

function saveStored(stored: Stored) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...stored, runs: stored.runs.slice(-30), sessions: stored.sessions.slice(-10) }),
    );
  } catch {
    // storage unavailable (private mode, blocked): runs simply do not survive a reload
  }
}

/** Compresses recorded gaps so a run plays in ~30 s while keeping fast vs slow models visible. */
const playbackDelay = (gapMs: number) => (gapMs <= 0 ? 0 : Math.min(1500, 60 + gapMs * 0.15));

/** Share of the recording that plays before the `run_abort` scenario stops it. */
const ABORT_AT = 0.4;
/** Pause between two steps of a session, before speed scaling. */
const STEP_GAP_MS = 1500;
/** Beat between creation and the recording's run_started, before speed scaling. */
const START_DELAY_MS = 400;

/** Gates the mock reports for a passing live step (scripted display values, not a real ledger). */
const PASSING_GATES: Record<BenchmarkStep, StepGate> = {
  warmup: { passed: true, cost_usd: 0.02, expected_cost_usd: 0.03, opus_truncation_pct: 0, reasons: [] },
  primary: { passed: true, cost_usd: 0.31, expected_cost_usd: 0.33, opus_truncation_pct: 4.2, reasons: [] },
  extension: { passed: true, cost_usd: 0.18, expected_cost_usd: 0.2, opus_truncation_pct: 6.1, reasons: [] },
};

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const withRunId = <T>(value: T, runId: string): T =>
  JSON.parse(JSON.stringify(value).split(`"${RECORDED_RUN_ID}"`).join(JSON.stringify(runId))) as T;

const isTerminal = (s: SessionRunStatus) => s === 'completed' || s === 'cancelled' || s === 'failed';

const counterOf = (id: string) => Number.parseInt(id.replace(/\D+/g, ''), 10);

export function createMockClient(options: MockOptions = {}): ApiClient {
  const scenario = options.scenario ?? 'default';
  const speed = options.speed ?? 1;
  const latency = options.latencyMs ?? 120;
  const persist = options.persist ?? false;
  const runs = new Map<string, MockRun>();
  const sessions = new Map<string, MockSession>();
  let runCounter = 0;
  let sessionCounter = 0;

  const recorded = fixtures.runEvents;
  const totalSeq = recorded.length;
  const buildOffsets = (pace: number) => {
    let t = 0;
    return fixtures.runPlayback.gaps_ms.slice(0, totalSeq).map((gap) => (t += playbackDelay(gap) * speed * pace));
  };

  const baseInfo = normalizeBenchmarkInfo(fixtures.benchmarkInfo);
  const liveAvailable = scenario === 'live_ready' || scenario === 'gate_stop' || scenario === 'spend_cap';
  let recording: Recording | null = scenario === 'default' ? baseInfo.recording : null;

  if (persist) {
    const stored = loadStored();
    for (const s of stored.runs) {
      const pace = s.pace ?? 1;
      runs.set(s.id, { ...s, pace, ending: s.ending ?? null, offsets: buildOffsets(pace), listeners: new Set() });
      if (Number.isFinite(counterOf(s.id))) runCounter = Math.max(runCounter, counterOf(s.id));
    }
    for (const s of stored.sessions) {
      sessions.set(s.id, s);
      if (Number.isFinite(counterOf(s.id))) sessionCounter = Math.max(sessionCounter, counterOf(s.id));
    }
    if (stored.recording !== undefined) recording = stored.recording;
  }
  const save = () =>
    persist &&
    saveStored({
      runs: [...runs.values()].map(({ id, createdAt, startedAtMs, pace, ending }) => ({ id, createdAt, startedAtMs, pace, ending })),
      sessions: [...sessions.values()],
      recording,
    });
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

  const fixtureError = (status: number, raw: unknown, extraDetails: Record<string, unknown> = {}) => {
    const body = normalizeErrorBody(raw);
    return new ApiError(
      status,
      body
        ? { ...body, details: { ...(body.details ?? {}), ...extraDetails } }
        : { code: 'internal_error', message: 'bad mock fixture', details: null },
    );
  };

  const getRunOrThrow = (id: string): MockRun => {
    const run = runs.get(id);
    if (!run) throw fail(404, 'not_found', `Unknown run ${id}`, { run_id: id });
    return run;
  };

  /** Recorded events whose playback time has passed, ignoring any ending. */
  const rawPlayed = (run: MockRun): number => {
    const elapsed = Date.now() - run.startedAtMs;
    if (elapsed < 0) return 0;
    let seq = 0;
    while (seq < totalSeq && (run.offsets[seq] ?? Infinity) <= elapsed) seq++;
    return seq;
  };

  /** Highest recorded seq that has "happened" by now. */
  const playedSeq = (run: MockRun): number =>
    run.ending ? Math.min(rawPlayed(run), run.ending.afterSeq) : rawPlayed(run);

  const hasEnded = (run: MockRun): boolean =>
    run.ending !== null && Date.now() >= run.startedAtMs && rawPlayed(run) >= run.ending.afterSeq;

  const lastSeqOf = (run: MockRun): number =>
    run.ending && hasEnded(run) ? run.ending.afterSeq + run.ending.events.length : playedSeq(run);

  const statusOf = (run: MockRun): RunStatus => {
    if (run.ending && hasEnded(run)) return run.ending.status;
    const seq = rawPlayed(run);
    if (seq >= totalSeq) return 'completed';
    return seq === 0 ? 'queued' : 'running';
  };

  /** Event with the given seq (1-based) as the backend would emit it for this run. */
  const eventAt = (run: MockRun, seq: number): RunEvent | null => {
    if (run.ending && seq > run.ending.afterSeq) {
      return normalizeEvent(run.ending.events[seq - run.ending.afterSeq - 1]);
    }
    const raw = recorded[seq - 1];
    return raw === undefined ? null : normalizeEvent(retime(run, withRunId(raw, run.id)));
  };

  // The recording carries the wall-clock times of the original run. A backend replay stamps
  // events when it emits them, so recorded times are moved onto this run's playback timeline:
  // run clocks and timeout gauges then read real elapsed time, while recorded latencies stay as data.
  const recordedMs = recorded.map((raw) => Date.parse(String((raw as { ts?: unknown }).ts)));

  /** Playback time (ms epoch) of recorded seq `seq` (1-based) in this run. */
  const playbackMs = (run: Pick<MockRun, 'startedAtMs' | 'offsets'>, seq: number): number =>
    run.startedAtMs + (run.offsets[seq - 1] ?? 0);

  const retimeMs = (run: Pick<MockRun, 'startedAtMs' | 'offsets'>, t: number): number => {
    let i = 0;
    while (i < totalSeq && (recordedMs[i] ?? Infinity) <= t) i++;
    if (i === 0) return run.startedAtMs;
    const next = i < totalSeq ? playbackMs(run, i + 1) : Infinity;
    return Math.min(playbackMs(run, i) + (t - (recordedMs[i - 1] ?? t)), next);
  };

  /** Copy of a recorded payload with every `ts` / `*_at` timestamp moved onto the run's timeline. */
  const retime = <T>(run: MockRun, value: T): T =>
    JSON.parse(JSON.stringify(value), (key, v: unknown) => {
      if (typeof v !== 'string' || !(key === 'ts' || key.endsWith('_at'))) return v;
      const t = Date.parse(v);
      return Number.isNaN(t) ? v : new Date(retimeMs(run, t)).toISOString();
    }) as T;

  const envelope = (runId: string, seq: number, type: string, ts: string, data: object) => ({
    seq,
    type,
    run_id: runId,
    trial_id: null,
    ts,
    data,
  });

  const cancelEnding = (runId: string, afterSeq: number): MockEnding => {
    const ts = nowIso();
    return {
      afterSeq,
      status: 'cancelled',
      events: [envelope(runId, afterSeq + 1, 'run_finished', ts, { status: 'cancelled', finished_at: ts })],
    };
  };

  /**
   * Live spend cap hit mid-run (6.1 G4). The backend would also mark the remaining trials
   * `error`; this replay does not synthesize trial records, so they stay as last reported.
   */
  const abortEnding = (runId: string, afterSeq: number, ts: string): MockEnding => {
    return {
      afterSeq,
      status: 'failed',
      events: [
        envelope(runId, afterSeq + 1, 'error', ts, { code: 'conflict', message: 'Live spend cap reached' }),
        envelope(runId, afterSeq + 2, 'run_finished', ts, { status: 'failed', finished_at: ts }),
      ],
    };
  };

  const newRun = (
    startedAtMs: number,
    pace: number,
    ending: (id: string, tsOf: (seq: number) => string) => MockEnding | null = () => null,
  ): MockRun => {
    runCounter += 1;
    const id = `run_mock_${String(runCounter).padStart(2, '0')}`;
    const offsets = buildOffsets(pace);
    const tsOf = (seq: number) => new Date(playbackMs({ startedAtMs, offsets }, seq)).toISOString();
    const run: MockRun = { id, createdAt: nowIso(), startedAtMs, pace, offsets, ending: ending(id, tsOf), listeners: new Set() };
    runs.set(id, run);
    return run;
  };

  /** Stops an unfinished run; a run that has not started yet ends before its first event. */
  const stopRun = (run: MockRun) => {
    if (isTerminal(statusOf(run))) return;
    if (Date.now() < run.startedAtMs) run.startedAtMs = Date.now();
    run.ending = cancelEnding(run.id, playedSeq(run));
    run.listeners.forEach((notify) => notify());
  };

  const summary = (run: MockRun): RunSummary => {
    const status = statusOf(run);
    const lastEvent = isTerminal(status) ? eventAt(run, lastSeqOf(run)) : null;
    return {
      run_id: run.id,
      status,
      created_at: run.createdAt,
      finished_at: lastEvent?.type === 'run_finished' ? lastEvent.data.finished_at : null,
    };
  };

  // ---------- 5.10 sessions ----------

  const info = (): BenchmarkInfo => ({
    ...baseInfo,
    sources: { simulated: true, live: liveAvailable && recording === null, replay: recording !== null },
    auto_source: recording ? 'replay' : 'simulated',
    recording,
  });

  /** Mock "ledger": the sum of the scripted step costs. */
  const totalCost = (gates: (StepGate | null)[]) =>
    Math.round(gates.reduce((sum, g) => sum + (g?.cost_usd ?? 0), 0) * 100) / 100;

  /** Current state of a session, derived from its runs' playback. Saves the recording when a live session succeeds. */
  function sessionView(s: MockSession): BenchmarkSession {
    const failingGate = normalizeSession(fixtures.benchmarkSessionGateStop).runs[0]?.gate ?? null;
    const views = s.runs.map((r, i) => {
      const run = runs.get(r.run_id);
      const status: SessionRunStatus = run ? statusOf(run) : 'cancelled';
      const view: { step: BenchmarkStep; suite: Suite; run_id: string; status: SessionRunStatus; gate: StepGate | null } = {
        step: r.step,
        suite: r.suite,
        run_id: r.run_id,
        status,
        gate: null,
      };
      if (s.source === 'live' && (status === 'completed' || status === 'failed')) {
        view.gate = s.gateStopAt === i ? failingGate : PASSING_GATES[r.step];
      }
      return view;
    });

    // a failed gate stops the session before the next step (5.10 "Step gates")
    const stopIndex = views.findIndex((v) => v.gate !== null && !v.gate.passed);
    const stopped = stopIndex >= 0 && stopIndex < views.length - 1;
    if (stopped) {
      for (const v of views.slice(stopIndex + 1)) {
        const run = runs.get(v.run_id);
        if (run) stopRun(run);
        v.status = v.step === 'extension' && stopIndex === views.length - 2 ? 'skipped' : 'cancelled';
      }
    }

    const statuses = views.map((v) => v.status);
    let status: RunStatus;
    if (s.cancelled) status = 'cancelled';
    else if (stopped) status = views[stopIndex + 1]?.step === 'extension' ? 'completed' : 'failed';
    else if (statuses.includes('failed')) status = 'failed';
    else if (statuses.every((x) => x === 'completed' || x === 'skipped')) status = 'completed';
    else if (statuses.every((x) => x === 'queued' || x === 'skipped')) status = 'queued';
    else status = 'running';

    const cost = s.source === 'live' ? totalCost(views.map((v) => v.gate)) : null;
    if (isTerminal(status) && s.finishedAt === null) {
      s.finishedAt = nowIso();
      if (s.source === 'live' && status === 'completed') {
        recording = {
          recording_id: `rec_${s.id}`,
          recorded_at: s.finishedAt,
          session_id: s.id,
          trial_count: baseInfo.recording?.trial_count ?? 0,
          total_cost_usd: cost,
        };
      }
      save();
    }
    return normalizeSession({
      session_id: s.id,
      source: s.source,
      requested_source: s.requested,
      status,
      speed: s.speed,
      created_at: s.createdAt,
      finished_at: s.finishedAt,
      replay_of_session_id: s.replayOf,
      recorded_at: s.recordedAt,
      total_cost_usd: cost,
      stop_reason: stopped ? 'gate' : null,
      runs: views,
    });
  }

  const activeSession = (): MockSession | null =>
    [...sessions.values()].find((s) => !isTerminal(sessionView(s).status)) ?? null;

  const getSessionOrThrow = (id: string): MockSession => {
    const s = sessions.get(id);
    if (!s) throw fail(404, 'not_found', `Unknown session ${id}`, { session_id: id });
    return s;
  };

  const createSession = (req: CreateSessionRequest): BenchmarkSession => {
    const requested = req.source ?? 'auto';
    const sessionSpeed = req.speed ?? SESSION_SPEED.default;
    if (!(sessionSpeed >= SESSION_SPEED.min && sessionSpeed <= SESSION_SPEED.max)) {
      throw fail(422, 'validation_error', `speed must be between ${SESSION_SPEED.min} and ${SESSION_SPEED.max}`, {
        field: 'speed',
      });
    }
    const source: BenchmarkSource = requested === 'auto' ? (recording ? 'replay' : 'simulated') : requested;
    if (source === 'live' && req.confirm_cost !== true) {
      throw fail(422, 'validation_error', 'confirm_cost must be true for a live session', { field: 'confirm_cost' });
    }
    const active = activeSession();
    if (active) throw fail(409, 'conflict', `Session ${active.id} is still running`, { active_session_id: active.id });
    if (source === 'replay' && !recording) {
      throw fail(409, 'conflict', 'No live recording exists yet', { reason: 'no_recording' });
    }
    if (source === 'live') {
      if (scenario === 'missing_api_key') throw fixtureError(503, fixtures.errorMissingApiKey);
      if (!liveAvailable) throw fail(409, 'conflict', 'The backend runs with MOCK_MODELS=true', { reason: 'mock_mode' });
      if (recording) throw fail(409, 'conflict', 'A live recording already exists', { reason: 'recording_exists' });
      if (scenario === 'spend_cap') throw fixtureError(409, fixtures.errorSpendCap, { reason: 'budget' });
    }

    // live plays at the normal mock pace; simulated and replay are paced by the requested speed
    const pace = source === 'live' ? 1 : 1 / sessionSpeed;
    const duration = buildOffsets(pace).at(-1) ?? 0;
    const steps = baseInfo.plan.filter((p) => !p.optional || req.include_extension !== false);
    let at = Date.now() + START_DELAY_MS * speed * pace;
    const sessionRuns = steps.map((p): MockSessionRun => {
      const run = newRun(at, pace);
      at += duration + STEP_GAP_MS * speed * pace;
      return { step: p.step, suite: p.suite, run_id: run.id };
    });

    sessionCounter += 1;
    const s: MockSession = {
      id: `sess_mock_${String(sessionCounter).padStart(2, '0')}`,
      source,
      requested,
      speed: sessionSpeed,
      createdAt: nowIso(),
      finishedAt: null,
      replayOf: source === 'replay' ? (recording?.session_id ?? null) : null,
      recordedAt: source === 'replay' ? (recording?.recorded_at ?? null) : null,
      cancelled: false,
      gateStopAt: source === 'live' && scenario === 'gate_stop' ? 0 : null,
      runs: sessionRuns,
    };
    sessions.set(s.id, s);
    save();
    return sessionView(s);
  };

  return {
    mode: 'mock',

    getHealth: () =>
      respond(() =>
        normalizeHealth({
          ...(fixtures.health as object),
          api_key_configured: scenario !== 'missing_api_key' && scenario !== 'no_recording',
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
        if (scenario === 'missing_api_key') throw fixtureError(503, fixtures.errorMissingApiKey);
        if (!req.puzzle_ids.length) {
          throw fail(422, 'validation_error', 'puzzle_ids must contain at least one puzzle', { field: 'puzzle_ids' });
        }
        const unknown = (req.model_ids ?? []).find((id) => !models.some((m) => m.id === id));
        if (unknown) throw fail(422, 'validation_error', `Unknown model ${unknown}`, { field: 'model_ids' });
        if (scenario === 'spend_cap') throw fixtureError(409, fixtures.errorSpendCap);
        // the recording's run_started has offset 0; leave a beat before it plays
        const run = newRun(Date.now() + START_DELAY_MS * speed, 1, (id, tsOf) =>
          scenario === 'run_abort' ? abortEnding(id, Math.floor(totalSeq * ABORT_AT), tsOf(Math.floor(totalSeq * ABORT_AT))) : null,
        );
        save();
        return { run_id: run.id, status: 'queued' as const };
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
        const snap = normalizeRunSnapshot(retime(run, withRunId(best, id)));
        return { ...snap, created_at: run.createdAt };
      }),

    cancelRun: (id: string) =>
      respond(() => {
        const run = getRunOrThrow(id);
        const status = statusOf(run);
        if (isTerminal(status)) throw fail(409, 'conflict', `Run ${id} is already ${status}`, { status });
        stopRun(run);
        save();
        return { run_id: id, status: 'cancelled' as const };
      }),

    getStats: (id: string) =>
      respond(() => {
        const run = getRunOrThrow(id);
        const upTo = playedSeq(run);
        let best = fixtures.runStatsTimeline[0];
        for (const entry of fixtures.runStatsTimeline) if (entry.after_seq <= upTo) best = entry;
        const stats = normalizeRunStats(retime(run, withRunId(best?.stats, id)));
        return { ...stats, run_status: statusOf(run) };
      }),

    getBenchmark: () => respond(info),

    createSession: (req: CreateSessionRequest) => respond(() => createSession(req)),

    getSession: (id: string) => respond(() => sessionView(getSessionOrThrow(id))),

    cancelSession: (id: string) =>
      respond(() => {
        const s = getSessionOrThrow(id);
        const view = sessionView(s);
        if (isTerminal(view.status)) {
          throw fail(409, 'conflict', `Session ${id} is already ${view.status}`, { status: view.status });
        }
        for (const r of s.runs) {
          const run = runs.get(r.run_id);
          if (run) stopRun(run);
        }
        s.cancelled = true;
        save();
        return sessionView(s);
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
        const end = run.ending ? run.ending.afterSeq + run.ending.events.length : totalSeq;
        if (delivered >= end) return; // stream "closes" after run_finished
        // Wake for the next recorded event; an ending plays once its last recorded event has.
        const nextAt =
          run.ending && run.ending.afterSeq === 0
            ? run.startedAtMs
            : run.startedAtMs +
              (run.offsets[run.ending ? Math.min(delivered, run.ending.afterSeq - 1) : delivered] ?? 0);
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
