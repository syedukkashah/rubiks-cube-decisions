import { isTerminalTrial, type ModelInfo, type RunStatus, type Trial } from '../api/types';
import { formatGap, formatSeconds, INVALID_REASON_LABEL } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import type { TrialLive } from '../state/runReducer';
import { invalidForNextMove } from '../state/selectors';
import { CubeNet } from './CubeNet';
import { MoveHistory } from './MoveHistory';
import { ResultBanner } from './ResultBanner';

export interface ModelLaneProps {
  modelId: string;
  model: ModelInfo | null;
  trial: Trial | null;
  live: TrialLive | null;
  runStatus: RunStatus | null;
  maxMoves: number | null;
}

const CATEGORY_LABEL = { decision: 'System-1 decision', frontier: 'Frontier LLM' } as const;

/** One model playing: current cube, current move, live request state, result and history. */
export function ModelLane({ modelId, model, trial, live, runStatus, maxMoves }: ModelLaneProps) {
  const label = model?.label ?? modelId;
  const lastMove = trial?.moves.at(-1) ?? null;
  const awaiting = trial && trial.status === 'running' ? (live?.awaiting ?? null) : null;
  const flagged = trial && trial.status === 'running' && live ? invalidForNextMove(live.invalid, trial) : [];
  const lastFlag = flagged.at(-1) ?? null;
  const used = trial?.moves_used ?? 0;
  const pct = maxMoves ? Math.min(100, (used / maxMoves) * 100) : 0;
  const showConfidence = model ? model.category === 'decision' : true;
  const terminal = trial ? isTerminalTrial(trial.status) : false;

  return (
    <section className="lane" aria-label={`${label} lane`} data-model={modelId}>
      <header className="lane__header">
        <span className="swatch" style={{ background: modelColor(modelId) }} aria-hidden="true" />
        <div className="lane__title">
          <h3>{label}</h3>
          <span className="lane__meta">
            {model ? CATEGORY_LABEL[model.category] : 'Model'} · {model?.interface === 'chat_completions' ? 'Chat completions' : 'Decisions API'}
          </span>
        </div>
        {trial && <span className="lane__puzzle">{trial.puzzle_id}</span>}
      </header>

      {!trial ? (
        <div className="lane__empty">No trial for this model here.</div>
      ) : (
        <>
          <div className="lane__stage">
            <CubeNet
              facelets={trial.current_facelets}
              highlightFace={lastMove?.move[0] ?? null}
              size={184}
              label={`${label} current cube`}
            />
            <div className="lane__now">
              <span className="lane__now-label">Current move</span>
              <span className="lane__move" aria-live="polite">
                {lastMove ? lastMove.move : '—'}
              </span>
              <div className="lane__activity">
                {awaiting ? (
                  <span className="activity activity--waiting">
                    <span className="spinner" aria-hidden="true" />
                    Awaiting move {awaiting.move_index}
                    {awaiting.attempt > 1 ? ` · try ${awaiting.attempt}` : ''}
                  </span>
                ) : trial.status === 'running' && runStatus === 'running' ? (
                  <span className="activity muted">Thinking…</span>
                ) : (
                  <span className="activity muted">&nbsp;</span>
                )}
              </div>
              <div className="lane__flag">
                {lastFlag ? (
                  <span className="activity activity--invalid" role="alert">
                    ⚠ {INVALID_REASON_LABEL[lastFlag.reason] ?? lastFlag.reason}
                    {lastFlag.raw_response ? `: “${lastFlag.raw_response.slice(0, 24)}”` : ''}
                  </span>
                ) : (
                  <span className="activity">&nbsp;</span>
                )}
              </div>
            </div>
          </div>

          <div className="meter" aria-label={`Moves used ${used} of ${maxMoves ?? '?'}`}>
            <div className="meter__track">
              <div className="meter__fill" style={{ width: `${pct}%`, background: modelColor(modelId) }} />
            </div>
            <span className="meter__text">
              {used}/{maxMoves ?? '?'} moves
              {trial.optimal_distance !== null && <span className="muted"> · optimum {trial.optimal_distance}</span>}
            </span>
          </div>

          <ResultBanner
            status={trial.status}
            runStatus={runStatus}
            error={trial.error}
            detail={
              trial.status === 'solved'
                ? `${trial.moves_used} moves · gap ${formatGap(trial.optimality_gap)} · ${formatSeconds(trial.total_time_s)}`
                : trial.status === 'move_limit'
                  ? `Unsolved after ${trial.moves_used} moves · ${formatSeconds(trial.total_time_s)}`
                  : null
            }
          />

          {/* Backend counters are authoritative once the trial is final; while it runs,
              rejected outputs show up live in the flag above and in the history below. */}
          <dl className="lane__counters">
            <div>
              <dt>Invalid</dt>
              <dd>{terminal ? trial.invalid_move_count : '…'}</dd>
            </div>
            <div>
              <dt>Retries</dt>
              <dd>{terminal ? trial.retry_count : '…'}</dd>
            </div>
            <div>
              <dt>Timeouts</dt>
              <dd>{terminal ? trial.timeout_count : '…'}</dd>
            </div>
          </dl>

          <MoveHistory moves={trial.moves} invalid={live?.invalid ?? []} showConfidence={showConfidence} height={190} />
        </>
      )}
    </section>
  );
}
