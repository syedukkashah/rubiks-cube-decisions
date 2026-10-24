import { Link } from 'react-router-dom';
import type { RunErrorData, RunStatus, RunSummary } from '../api/types';
import { formatTime } from '../lib/format';
import type { RunProgress } from '../state/selectors';
import type { StreamStatus } from '../state/useRunSession';

const STREAM_LABEL: Record<StreamStatus, string> = {
  idle: 'No run',
  loading: 'Loading snapshot…',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Stream closed',
  error: 'Failed to load',
};

const RUN_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export interface RunStatusBarProps {
  runId: string | null;
  status: RunStatus | null;
  stream: StreamStatus;
  progress: RunProgress;
  startedAt: string | null;
  finishedAt: string | null;
  runs: RunSummary[] | null;
  onSelectRun: (runId: string) => void;
  /** Run-level `error` event (5.7), e.g. a spend/call cap or out-of-credits abort (6.1 G4). */
  runError?: RunErrorData | null;
}

export function RunStatusBar({
  runId,
  status,
  stream,
  progress,
  startedAt,
  finishedAt,
  runs,
  onSelectRun,
  runError = null,
}: RunStatusBarProps) {
  const pct = progress.total ? (progress.finished / progress.total) * 100 : 0;
  const aborted = status === 'failed' || runError !== null;
  return (
    <div className="statusbar card" role="region" aria-label="Run status">
      <div className="statusbar__item">
        <span className="statusbar__label">Run</span>
        {runs && runs.length > 0 ? (
          <select value={runId ?? ''} onChange={(e) => e.target.value && onSelectRun(e.target.value)} aria-label="Select run">
            {!runId && <option value="">Select a run…</option>}
            {runId && !runs.some((r) => r.run_id === runId) && <option value={runId}>{runId}</option>}
            {runs.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {r.run_id} · {RUN_LABEL[r.status]}
              </option>
            ))}
          </select>
        ) : (
          <strong>{runId ?? '—'}</strong>
        )}
      </div>
      <div className="statusbar__item">
        <span className="statusbar__label">Status</span>
        <span className={`chip chip--run-${status ?? 'none'}`} data-testid="run-status">
          {status ? RUN_LABEL[status] : '—'}
        </span>
      </div>
      <div className="statusbar__item statusbar__progress">
        <span className="statusbar__label">Trials finished</span>
        <div className="progress" aria-label={`${progress.finished} of ${progress.total} trials finished`}>
          <div className="progress__fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="tabular">
          {progress.finished}/{progress.total || '—'}
        </span>
      </div>
      <div className="statusbar__item">
        <span className="statusbar__label">Stream</span>
        <span className={`stream stream--${stream}`}>
          <span className="stream__dot" aria-hidden="true" />
          {STREAM_LABEL[stream]}
        </span>
      </div>
      <div className="statusbar__item statusbar__times">
        <span className="statusbar__label">Started</span>
        <span className="small">{formatTime(startedAt)}</span>
      </div>
      <div className="statusbar__item statusbar__times">
        <span className="statusbar__label">Finished</span>
        <span className="small">{formatTime(finishedAt)}</span>
      </div>
      {runId && (
        <Link className="btn btn--ghost statusbar__slide" to={`/slide?run=${encodeURIComponent(runId)}`}>
          Final slide →
        </Link>
      )}
      {aborted && (
        <div className="statusbar__abort" role="alert" data-testid="run-abort">
          <span className="notice__icon" aria-hidden="true">
            !
          </span>
          <strong>{status === 'failed' ? 'Run aborted by the backend' : 'Run error'}</strong>
          {runError ? (
            <>
              <span className="statusbar__abort-message">{runError.message || 'No message given.'}</span>
              <code className="statusbar__abort-code">{runError.code}</code>
            </>
          ) : (
            <span className="statusbar__abort-message muted">
              No reason available: the backend sends it only as a live event, not in the run snapshot. Trial errors are
              shown below.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
