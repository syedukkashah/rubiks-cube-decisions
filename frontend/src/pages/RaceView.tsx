import { isTerminalRun, type BenchmarkSession, type ModelInfo, type Puzzle, type RunStats } from '../api/types';
import { EventStream } from '../components/EventStream';
import { ModelLane } from '../components/ModelLane';
import { PuzzlePanel } from '../components/PuzzlePanel';
import { RunStatusBar } from '../components/RunStatusBar';
import { GateStopNotice, SessionProgress } from '../components/SessionProgress';
import { TrialBar } from '../components/TrialBar';
import type { RunState } from '../state/runReducer';
import { livePuzzleId, runProgress, trialFor, trialsOf } from '../state/selectors';
import { useNow } from '../state/useNow';
import type { StreamStatus } from '../state/useRunSession';

export interface RaceViewProps {
  runId: string;
  state: RunState;
  stream: StreamStatus;
  session: BenchmarkSession | null;
  models: Record<string, ModelInfo>;
  puzzles: Record<string, Puzzle>;
  stats: RunStats | null;
  kicker: string;
  seed: number | null;
  focus: string | null;
  onFocus: (puzzleId: string | null) => void;
  onSelectRun: (runId: string) => void;
  canCancel: boolean;
  cancelling: boolean;
  onCancel: () => void;
}

/** Run clock m:ss.s from the run's own timestamps (display timer only). */
function clock(startedAt: string | null, finishedAt: string | null, now: number): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isNaN(start)) return '0:00.0';
  const end = finishedAt ? Date.parse(finishedAt) : now;
  const ms = Math.max(0, (Number.isNaN(end) ? now : end) - start);
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

/** Race (design: Main): the in-progress stage with the shared scramble and four model lanes. */
export function RaceView(props: RaceViewProps) {
  const { runId, state, stream, session, models, puzzles, stats, kicker, seed, focus, onFocus, onSelectRun, canCancel, cancelling, onCancel } = props;
  const running = state.status !== null && !isTerminalRun(state.status);
  const now = useNow(running);
  const shownPuzzleId = focus ?? livePuzzleId(state);
  const puzzleIds = state.config?.puzzle_ids ?? [];
  const index = shownPuzzleId ? puzzleIds.indexOf(shownPuzzleId) : -1;
  const modelIds = state.config?.model_ids ?? [];
  const trials = trialsOf(state);
  const progress = runProgress(state);
  const fallbackFacelets = trials.find((t) => t.puzzle_id === shownPuzzleId)?.initial_facelets ?? null;

  return (
    <div className="page page--race">
      <section className="title-row">
        <div className="title-row__main">
          <span className="eyebrow">{kicker}</span>
          <h1>
            {index >= 0 ? `Puzzle ${index + 1} of ${puzzleIds.length}` : 'Loading run…'}
            {shownPuzzleId && <span className="muted"> · {shownPuzzleId}</span>}
          </h1>
        </div>
        <TrialBar trials={trials} total={progress.total} runStatus={state.status} />
        <div className="title-row__actions">
          <span className="clock mono" aria-label="Run clock">
            {clock(state.startedAt, state.finishedAt, now)}
          </span>
          {canCancel && (
            <button type="button" className="btn btn--danger" onClick={onCancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : session ? 'Cancel benchmark' : 'Cancel run'}
            </button>
          )}
        </div>
      </section>

      {session && <SessionProgress session={session} selectedRunId={runId} onSelect={onSelectRun} />}
      {session && <GateStopNotice session={session} />}
      <RunStatusBar
        runId={runId}
        status={state.status}
        stream={stream}
        progress={progress}
        startedAt={state.startedAt}
        finishedAt={state.finishedAt}
        runError={state.runError}
      />

      <div className="race-grid">
        <PuzzlePanel
          state={state}
          config={state.config}
          puzzles={puzzles}
          models={models}
          shownPuzzleId={shownPuzzleId}
          focusPuzzleId={focus}
          onFocus={onFocus}
          fallbackFacelets={fallbackFacelets}
          seed={seed}
          runStatus={state.status}
        />
        <section className="lanes" aria-label="Model lanes">
          {modelIds.map((id) => {
            const trial = shownPuzzleId ? trialFor(state, shownPuzzleId, id) : null;
            return (
              <ModelLane
                key={id}
                modelId={id}
                model={models[id] ?? null}
                trial={trial}
                live={trial ? (state.live[trial.trial_id] ?? null) : null}
                runStatus={state.status}
                maxMoves={state.config?.max_moves ?? null}
                timeoutS={state.config?.timeout_s ?? null}
                maxRetries={state.config?.max_retries ?? null}
                stats={stats?.models.find((m) => m.model_id === id) ?? null}
                now={now}
              />
            );
          })}
          {state.loaded && modelIds.length === 0 && <p className="muted">This run has no models.</p>}
          {!state.loaded && <p className="muted">Loading run…</p>}
        </section>
      </div>

      <EventStream events={state.recentEvents} trials={state.trials} models={models} />
    </div>
  );
}
