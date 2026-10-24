import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatUsd } from '../api/errors';
import type { BenchmarkSession, ModelInfo, Puzzle, RunStats } from '../api/types';
import { QuestionsAnswered } from '../components/QuestionsAnswered';
import { FinalStates, ResultsMatrix } from '../components/ResultsMatrix';
import { RunStatusBar } from '../components/RunStatusBar';
import { GateStopNotice, SessionProgress } from '../components/SessionProgress';
import { ReliabilityTable, StatsDashboard } from '../components/StatsDashboard';
import type { RunState } from '../state/runReducer';
import { runProgress, trialsOf } from '../state/selectors';
import type { StreamStatus } from '../state/useRunSession';

export interface ResultsViewProps {
  runId: string;
  state: RunState;
  stream: StreamStatus;
  session: BenchmarkSession | null;
  models: Record<string, ModelInfo>;
  puzzles: Record<string, Puzzle>;
  stats: RunStats | null;
  statsError: unknown;
  statsLoading: boolean;
  onReloadStats: () => void;
  kicker: string;
  slideHref: string;
  onSelectRun: (runId: string) => void;
}

/** Saves what the screen shows (backend snapshot values and stats) as a JSON file. */
function exportResults(runId: string, state: RunState, stats: RunStats | null) {
  const body = {
    exported_at: new Date().toISOString(),
    run_id: runId,
    status: state.status,
    config: state.config,
    started_at: state.startedAt,
    finished_at: state.finishedAt,
    trials: trialsOf(state),
    stats,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${runId}-results.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Results (design: Results): the completion stage of a finished run. */
export function ResultsView(props: ResultsViewProps) {
  const { runId, state, stream, session, models, puzzles, stats, statsError, statsLoading, onReloadStats, kicker, slideHref, onSelectRun } = props;
  const [picked, setPicked] = useState<string | null>(null);
  const puzzleIds = state.config?.puzzle_ids ?? [];
  const selected = picked && puzzleIds.includes(picked) ? picked : (puzzleIds[0] ?? null);
  const progress = runProgress(state);
  const recordingSaved = session?.source === 'live' && session.status === 'completed';

  return (
    <div className="page page--results">
      <section className="title-row">
        <div className="title-row__main">
          <span className="eyebrow">{kicker}</span>
          <h1>
            {progress.finished} trials finished
            <span className="muted">
              {' '}
              · {puzzleIds.length} {puzzleIds.length === 1 ? 'puzzle' : 'puzzles'} × {state.config?.model_ids.length ?? 0} models
            </span>
          </h1>
        </div>
        <div className="title-row__actions">
          <Link className="btn btn--primary" to={slideHref}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            Present slide
          </Link>
          <button type="button" className="btn btn--secondary" onClick={() => exportResults(runId, state, stats)}>
            Export results
          </button>
          <Link className="btn btn--secondary" to="/">
            New run
          </Link>
        </div>
      </section>

      {session && <SessionProgress session={session} selectedRunId={runId} onSelect={onSelectRun} />}
      {session && <GateStopNotice session={session} />}
      {recordingSaved && (
        <div className="notice notice--ok" role="status" data-testid="recording-saved">
          <span className="notice__icon" aria-hidden="true">
            ✓
          </span>
          <div className="notice__body">
            <strong>Live recording saved</strong>
            <span className="notice__message">
              Every later "Run full benchmark" replays this session with no OpenRouter calls
              {session.total_cost_usd !== null ? `. Spent on this live pass: ${formatUsd(session.total_cost_usd)}.` : '.'}
            </span>
          </div>
        </div>
      )}
      <RunStatusBar
        runId={runId}
        status={state.status}
        stream={stream}
        progress={progress}
        startedAt={state.startedAt}
        finishedAt={state.finishedAt}
        runError={state.runError}
      />

      <FinalStates state={state} models={models} puzzleId={selected} onSelect={setPicked} />

      <div className="results-grid">
        <ResultsMatrix state={state} models={models} puzzles={puzzles} selectedPuzzleId={selected} onSelect={setPicked} />
        {stats && <ReliabilityTable stats={stats} />}
      </div>

      <StatsDashboard stats={stats} error={statsError} loading={statsLoading} onRetry={onReloadStats} />

      {stats && (
        <section className="answers-section" aria-labelledby="answers-heading">
          <h2 id="answers-heading">What the experiment answers</h2>
          <QuestionsAnswered stats={stats} />
        </section>
      )}
    </div>
  );
}
