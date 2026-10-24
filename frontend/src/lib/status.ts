// Display look of backend statuses. Status color always ships with an icon and a text label.
import { isTerminalRun, type BenchmarkStep, type RunStatus, type SessionRunStatus, type TrialStatus } from '../api/types';

export const STEP_NAME: Record<BenchmarkStep, string> = { warmup: 'Warm-up', primary: 'Primary', extension: 'Extension' };

export type Tone = 'solved' | 'limit' | 'error' | 'run' | 'idle';

export interface StatusLook {
  tone: Tone;
  label: string;
  /** Running states pulse. */
  pulse: boolean;
}

export function trialLook(status: TrialStatus, runStatus: RunStatus | null = null, retrying = false): StatusLook {
  switch (status) {
    case 'solved':
      return { tone: 'solved', label: 'Solved', pulse: false };
    case 'move_limit':
      return { tone: 'limit', label: 'Move limit', pulse: false };
    case 'error':
      return { tone: 'error', label: 'Error', pulse: false };
    case 'running':
      if (runStatus && isTerminalRun(runStatus)) return { tone: 'idle', label: 'Stopped', pulse: false };
      return { tone: 'run', label: retrying ? 'Retrying' : 'Thinking', pulse: true };
    case 'pending':
      if (runStatus && isTerminalRun(runStatus)) return { tone: 'idle', label: 'Not started', pulse: false };
      return { tone: 'idle', label: 'Queued', pulse: false };
  }
}

export function runLook(status: SessionRunStatus | null): StatusLook {
  switch (status) {
    case 'completed':
      return { tone: 'solved', label: 'Completed', pulse: false };
    case 'failed':
      return { tone: 'error', label: 'Failed', pulse: false };
    case 'cancelled':
      return { tone: 'idle', label: 'Cancelled', pulse: false };
    case 'skipped':
      return { tone: 'idle', label: 'Skipped', pulse: false };
    case 'running':
      return { tone: 'run', label: 'Running', pulse: true };
    case 'queued':
      return { tone: 'idle', label: 'Queued', pulse: false };
    default:
      return { tone: 'idle', label: '—', pulse: false };
  }
}
