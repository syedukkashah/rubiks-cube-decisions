// View selection helpers: which already-reported trial to show where.
// These only pick and group backend data for display; they never derive results.
import { isTerminalTrial, type Trial } from '../api/types';
import type { InvalidOutput, RunState } from './runReducer';

export function trialsOf(state: RunState): Trial[] {
  return state.trialOrder.map((id) => state.trials[id]).filter((t): t is Trial => t !== undefined);
}

export function trialFor(state: RunState, puzzleId: string, modelId: string): Trial | null {
  return trialsOf(state).find((t) => t.puzzle_id === puzzleId && t.model_id === modelId) ?? null;
}

/**
 * The trial a model lane shows. With a focused puzzle: that puzzle's trial.
 * Otherwise "follow live": the running trial, else the most recently started one,
 * else the model's first queued trial.
 */
export function laneTrial(state: RunState, modelId: string, focusPuzzleId: string | null): Trial | null {
  if (focusPuzzleId) return trialFor(state, focusPuzzleId, modelId);
  const mine = trialsOf(state).filter((t) => t.model_id === modelId);
  const running = mine.find((t) => t.status === 'running');
  if (running) return running;
  let latest: Trial | null = null;
  for (const t of mine) {
    if (t.started_at === null) continue;
    if (!latest || (latest.started_at ?? '') <= t.started_at) latest = t;
  }
  return latest ?? mine[0] ?? null;
}

/**
 * The puzzle whose scramble the board shows while following live: the most recently
 * started running trial's puzzle, else the most recently started trial's (matching the
 * lanes), else the first puzzle of the run.
 */
export function livePuzzleId(state: RunState): string | null {
  const trials = trialsOf(state);
  const latestStarted = (pool: Trial[]) => {
    let latest: Trial | null = null;
    for (const t of pool) {
      if (t.started_at === null) continue;
      if (!latest || (latest.started_at ?? '') <= t.started_at) latest = t;
    }
    return latest;
  };
  const latest = latestStarted(trials.filter((t) => t.status === 'running')) ?? latestStarted(trials);
  return latest?.puzzle_id ?? state.config?.puzzle_ids[0] ?? null;
}

/** Invalid outputs reported for the move the model is currently being asked for. */
export function invalidForNextMove(invalid: InvalidOutput[], trial: Trial): InvalidOutput[] {
  return invalid.filter((i) => i.move_index > trial.moves_used);
}

export interface RunProgress {
  finished: number;
  total: number;
}

export function runProgress(state: RunState): RunProgress {
  const trials = trialsOf(state);
  return {
    finished: trials.filter((t) => isTerminalTrial(t.status)).length,
    total: state.trialCount ?? trials.length,
  };
}
