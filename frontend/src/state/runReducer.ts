// Run state = GET /runs/{id} snapshot + SSE events applied strictly in seq order
// (AGENTS.md 5.6, 5.7 and 9 rule 2).
//
// - Events with seq <= lastSeq are duplicates (replay overlap) and are dropped.
// - Events that arrive ahead of a gap are buffered in `pending` until the gap fills,
//   or until a fresh snapshot covers it.
// - Events received before the first snapshot are buffered too.
// - A snapshot older than what is already applied is ignored.
//
// The reducer only copies what the backend reports. It never validates or applies
// moves, never decides "solved" and never computes statistics.
import {
  isTerminalTrial,
  type MoveInvalidData,
  type MoveRequestedData,
  type RunConfig,
  type RunErrorData,
  type RunEvent,
  type RunSnapshot,
  type RunStatus,
  type Timestamp,
  type Trial,
} from '../api/types';

export interface InvalidOutput extends MoveInvalidData {
  seq: number;
  ts: Timestamp;
}

/** Live, event-only details that the snapshot does not carry. */
export interface TrialLive {
  /** Set by move_requested, cleared when that request resolves. */
  awaiting: MoveRequestedData | null;
  /** Every move_invalid seen for this trial, in seq order. */
  invalid: InvalidOutput[];
}

export interface RunState {
  runId: string | null;
  /** True once a snapshot has been applied. */
  loaded: boolean;
  status: RunStatus | null;
  config: RunConfig | null;
  createdAt: Timestamp | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  trialOrder: string[];
  trials: Record<string, Trial>;
  live: Record<string, TrialLive>;
  /** Highest seq reflected in this state. */
  lastSeq: number;
  /** Received events with seq > lastSeq + 1, keyed by seq. */
  pending: Record<number, RunEvent>;
  trialCount: number | null;
  runError: RunErrorData | null;
  /** Bumped whenever backend stats may have changed (trial or run finished, snapshot applied). */
  statsEpoch: number;
}

export type RunAction =
  | { type: 'reset'; runId: string | null }
  | { type: 'snapshot'; snapshot: RunSnapshot }
  | { type: 'event'; event: RunEvent };

export const initialRunState: RunState = {
  runId: null,
  loaded: false,
  status: null,
  config: null,
  createdAt: null,
  startedAt: null,
  finishedAt: null,
  trialOrder: [],
  trials: {},
  live: {},
  lastSeq: 0,
  pending: {},
  trialCount: null,
  runError: null,
  statsEpoch: 0,
};

const EMPTY_LIVE: TrialLive = { awaiting: null, invalid: [] };

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'reset':
      return { ...initialRunState, runId: action.runId };
    case 'snapshot':
      return applySnapshot(state, action.snapshot);
    case 'event':
      return receiveEvent(state, action.event);
  }
}

function applySnapshot(state: RunState, snap: RunSnapshot): RunState {
  if (state.runId !== null && snap.run_id !== state.runId) return state;
  if (state.loaded && snap.last_seq < state.lastSeq) return state; // stale

  const trials: Record<string, Trial> = {};
  const trialOrder: string[] = [];
  for (const t of snap.trials) {
    trials[t.trial_id] = t;
    trialOrder.push(t.trial_id);
  }
  const live: Record<string, TrialLive> = {};
  for (const [id, l] of Object.entries(state.live)) {
    const t = trials[id];
    live[id] = t && isTerminalTrial(t.status) ? { ...l, awaiting: null } : l;
  }
  const pending: Record<number, RunEvent> = {};
  for (const e of Object.values(state.pending)) if (e.seq > snap.last_seq) pending[e.seq] = e;

  return drain({
    ...state,
    runId: snap.run_id,
    loaded: true,
    status: snap.status,
    config: snap.config,
    createdAt: snap.created_at,
    startedAt: snap.started_at,
    finishedAt: snap.finished_at,
    trialOrder,
    trials,
    live,
    lastSeq: snap.last_seq,
    pending,
    statsEpoch: state.statsEpoch + 1,
  });
}

function receiveEvent(state: RunState, event: RunEvent): RunState {
  if (state.runId !== null && event.run_id && event.run_id !== state.runId) return state;
  if (state.loaded && event.seq <= state.lastSeq) return state;
  if (state.pending[event.seq]) return state;
  const next = { ...state, pending: { ...state.pending, [event.seq]: event } };
  return next.loaded ? drain(next) : next;
}

function drain(state: RunState): RunState {
  let s = state;
  let next = s.pending[s.lastSeq + 1];
  if (!next) return s;
  const pending = { ...s.pending };
  while (next) {
    delete pending[next.seq];
    s = { ...applyEvent(s, next), lastSeq: next.seq };
    next = pending[s.lastSeq + 1];
  }
  return { ...s, pending };
}

function stubTrial(state: RunState, id: string, e: RunEvent & { type: 'trial_started' }): Trial {
  return {
    trial_id: id,
    run_id: state.runId ?? e.run_id,
    puzzle_id: e.data.puzzle_id,
    model_id: e.data.model_id,
    status: 'pending',
    initial_facelets: e.data.initial_facelets,
    current_facelets: e.data.initial_facelets,
    moves: [],
    moves_used: 0,
    solved: false,
    invalid_move_count: 0,
    retry_count: 0,
    timeout_count: 0,
    total_time_s: null,
    optimal_distance: null,
    optimality_gap: null,
    started_at: null,
    finished_at: null,
    error: null,
  };
}

function withTrial(state: RunState, trial: Trial): RunState {
  const known = trial.trial_id in state.trials;
  return {
    ...state,
    trials: { ...state.trials, [trial.trial_id]: trial },
    trialOrder: known ? state.trialOrder : [...state.trialOrder, trial.trial_id],
  };
}

function withLive(state: RunState, id: string, update: (l: TrialLive) => TrialLive): RunState {
  return { ...state, live: { ...state.live, [id]: update(state.live[id] ?? EMPTY_LIVE) } };
}

function applyEvent(state: RunState, e: RunEvent): RunState {
  const id = e.trial_id;
  const trial = id ? state.trials[id] : undefined;

  switch (e.type) {
    case 'run_started':
      return {
        ...state,
        status: state.status === 'queued' || state.status === null ? 'running' : state.status,
        startedAt: state.startedAt ?? e.ts,
        trialCount: e.data.trial_count,
      };

    case 'trial_started': {
      if (!id) return state;
      const base = trial ?? stubTrial(state, id, e);
      const fresh = base.moves.length === 0;
      return withTrial(state, {
        ...base,
        status: isTerminalTrial(base.status) ? base.status : 'running',
        initial_facelets: e.data.initial_facelets || base.initial_facelets,
        current_facelets: fresh ? e.data.initial_facelets || base.current_facelets : base.current_facelets,
        started_at: base.started_at ?? e.ts,
      });
    }

    case 'move_requested':
      if (!id) return state;
      return withLive(state, id, (l) => ({ ...l, awaiting: e.data }));

    case 'move_invalid':
      if (!id) return state;
      return withLive(state, id, (l) => ({
        awaiting: null,
        invalid: [...l.invalid, { ...e.data, seq: e.seq, ts: e.ts }],
      }));

    case 'move_applied': {
      if (!id) return state;
      const s = withLive(state, id, (l) => ({ ...l, awaiting: null }));
      if (!trial) return s; // trial_finished will deliver the full record
      const { moves_used, solved, ...record } = e.data;
      const moves = trial.moves.some((m) => m.index === record.index)
        ? trial.moves
        : [...trial.moves, record].sort((a, b) => a.index - b.index);
      return withTrial(s, {
        ...trial,
        status: trial.status === 'pending' ? 'running' : trial.status,
        moves,
        current_facelets: record.facelets_after,
        moves_used,
        solved,
      });
    }

    case 'trial_finished': {
      const finished = e.data;
      const s = withLive(state, finished.trial_id, (l) => ({ ...l, awaiting: null }));
      return { ...withTrial(s, finished), statsEpoch: s.statsEpoch + 1 };
    }

    case 'run_finished': {
      const live: Record<string, TrialLive> = {};
      for (const [k, l] of Object.entries(state.live)) live[k] = { ...l, awaiting: null };
      return {
        ...state,
        status: e.data.status,
        finishedAt: e.data.finished_at ?? e.ts,
        live,
        statsEpoch: state.statsEpoch + 1,
      };
    }

    case 'error':
      return { ...state, runError: e.data };

    case 'unknown':
      return state;
  }
}
