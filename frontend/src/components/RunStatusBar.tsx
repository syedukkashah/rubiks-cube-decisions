import { Link } from 'react-router-dom';
import type { RunStatus, RunSummary } from '../api/types';
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
}

export function RunStatusBar({ runId, status, stream, progress, startedAt, finishedAt, runs, onSelectRun }: RunStatusBarProps) {
  const pct = progress.total ? (progress.finished / progress.total) * 100 : 0;
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
    </div>
  );
}
