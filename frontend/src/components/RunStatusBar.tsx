import type { RunErrorData, RunStatus, RunSummary } from '../api/types';
import { formatTime } from '../lib/format';
import { runLook } from '../lib/status';
import type { RunProgress } from '../state/selectors';
import type { StreamStatus } from '../state/useRunSession';

export interface RunStatusBarProps {
  runId: string | null;
  status: RunStatus | null;
  stream: StreamStatus;
  progress: RunProgress;
  startedAt: string | null;
  finishedAt: string | null;
  runs?: RunSummary[] | null;
  onSelectRun?: (runId: string) => void;
  /** Run-level `error` event (5.7), e.g. a spend/call cap or out-of-credits abort (6.1 G4). */
  runError?: RunErrorData | null;
}

/** Run status pill and times, plus a clear alert when the backend aborted the run. */
export function RunStatusBar({ runId, status, progress, startedAt, finishedAt, runError = null }: RunStatusBarProps) {
  const look = runLook(status);
  const aborted = status === 'failed' || runError !== null;
  return (
    <div className="runmeta" role="region" aria-label="Run status">
      <div className="runmeta__line">
        <span className={`pill pill--sm tone-${look.tone}`} data-testid="run-status">
          <span className={`pill__dot ${look.pulse ? 'pulse' : ''}`} aria-hidden="true" />
          {look.label}
        </span>
        <span className="mono small muted">{runId ?? '—'}</span>
        <span className="small muted">
          {progress.finished}/{progress.total || '—'} trials
        </span>
        <span className="small muted">Started {formatTime(startedAt)}</span>
        {finishedAt && <span className="small muted">Finished {formatTime(finishedAt)}</span>}
      </div>
      {aborted && (
        <div className="abort" role="alert" data-testid="run-abort">
          <span className="notice__icon" aria-hidden="true">
            !
          </span>
          <strong>{status === 'failed' ? 'Run aborted by the backend' : 'Run error'}</strong>
          {runError ? (
            <>
              <span className="abort__message">{runError.message || 'No message given.'}</span>
              <code className="abort__code">{runError.code}</code>
            </>
          ) : (
            <span className="abort__message muted">
              No reason available: the backend sends it only as a live event, not in the run snapshot. Trial errors are shown in
              the lanes.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
