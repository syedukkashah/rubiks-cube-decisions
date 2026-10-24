import type { ModelInfo, Puzzle, RunStatus, Trial } from '../api/types';
import { formatGap, formatSeconds } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import { trialLook } from '../lib/status';
import type { RunState } from '../state/runReducer';
import { trialFor } from '../state/selectors';
import { CubeNet } from './CubeNet';
import { MoveHistory } from './MoveHistory';

/** Matrix cell text: moves used and the backend's gap, or the unsuccessful outcome. */
function cellText(t: Trial, runStatus: RunStatus | null): string {
  switch (t.status) {
    case 'solved':
      if (t.optimality_gap === null) return `${t.moves_used}`;
      return t.optimality_gap === 0 ? `${t.moves_used} · optimal` : `${t.moves_used} (${formatGap(t.optimality_gap)})`;
    case 'move_limit':
      return `${t.moves_used} · limit`;
    case 'error':
      return 'error';
    default:
      return trialLook(t.status, runStatus).label;
  }
}

export interface ResultsMatrixProps {
  state: RunState;
  models: Record<string, ModelInfo>;
  puzzles: Record<string, Puzzle>;
  selectedPuzzleId: string | null;
  onSelect: (puzzleId: string) => void;
}

/** Result per trial: rows = puzzles, columns = models (from Trial.status, moves_used, optimality_gap). */
export function ResultsMatrix({ state, models, puzzles, selectedPuzzleId, onSelect }: ResultsMatrixProps) {
  const puzzleIds = state.config?.puzzle_ids ?? [];
  const modelIds = state.config?.model_ids ?? [];
  if (!puzzleIds.length || !modelIds.length) return null;
  return (
    <section className="panel" aria-labelledby="results-heading">
      <h2 id="results-heading" className="eyebrow">
        Results matrix · moves used (gap to optimum)
      </h2>
      <div className="table-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Puzzle</th>
              <th scope="col">BFS opt.</th>
              {modelIds.map((id) => (
                <th scope="col" key={id} style={{ color: modelColor(id) }}>
                  {models[id]?.label ?? id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {puzzleIds.map((pid) => {
              const p = puzzles[pid];
              const opt = p ? p.optimal_distance : (trialFor(state, pid, modelIds[0] ?? '')?.optimal_distance ?? null);
              return (
                <tr key={pid} className={selectedPuzzleId === pid ? 'is-selected' : undefined} onClick={() => onSelect(pid)}>
                  <th scope="row">
                    <button type="button" className="link-button mono" onClick={() => onSelect(pid)}>
                      {pid}
                    </button>
                  </th>
                  <td className="mono muted">{opt ?? 'n/a'}</td>
                  {modelIds.map((mid) => {
                    const t = trialFor(state, pid, mid);
                    if (!t) return <td key={mid} className="muted">—</td>;
                    const look = trialLook(t.status, state.status);
                    return (
                      <td key={mid}>
                        <span className={`result-pill tone-${look.tone}`} data-status={t.status} title={t.error ? `${t.error.code}: ${t.error.message}` : look.label}>
                          {cellText(t, state.status)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="legend small">
        <span>
          <span className="dot tone-bg-solved" aria-hidden="true" />
          Solved
        </span>
        <span>
          <span className="dot tone-bg-limit" aria-hidden="true" />
          Move limit reached (unsuccessful)
        </span>
        <span>
          <span className="dot tone-bg-error" aria-hidden="true" />
          Error (unsuccessful)
        </span>
      </div>
    </section>
  );
}

const VERDICT = { solved: 'Solved', move_limit: 'Move limit reached', error: 'Error' } as const;

function verdictDetail(t: Trial, maxMoves: number | null): string {
  switch (t.status) {
    case 'solved':
      return t.optimal_distance !== null
        ? `${t.moves_used} moves · optimum ${t.optimal_distance} · gap ${formatGap(t.optimality_gap)}`
        : `${t.moves_used} moves · ${formatSeconds(t.total_time_s)}`;
    case 'move_limit':
      return `${t.moves_used} / ${maxMoves ?? t.moves_used} moves · not solved`;
    case 'error':
      return `${t.error?.code ?? 'error'} · ${t.moves_used} ${t.moves_used === 1 ? 'move' : 'moves'} applied`;
    default:
      return `${t.moves_used} moves so far`;
  }
}

export interface FinalStatesProps {
  state: RunState;
  models: Record<string, ModelInfo>;
  puzzleId: string | null;
  onSelect: (puzzleId: string) => void;
}

/** Puzzle tabs plus one card per model: final cube, verdict, moves and gap, and the move history. */
export function FinalStates({ state, models, puzzleId, onSelect }: FinalStatesProps) {
  const puzzleIds = state.config?.puzzle_ids ?? [];
  const modelIds = state.config?.model_ids ?? [];
  if (!puzzleIds.length) return null;
  return (
    <section className="panel" aria-labelledby="final-heading">
      <div className="panel__head">
        <h2 id="final-heading" className="eyebrow">
          Final state per puzzle
        </h2>
        <div className="seg seg--mono" role="tablist" aria-label="Puzzle">
          {puzzleIds.map((pid) => (
            <button key={pid} type="button" role="tab" aria-selected={pid === puzzleId} onClick={() => onSelect(pid)}>
              {pid}
            </button>
          ))}
        </div>
      </div>
      <div className="final-cards">
        {modelIds.map((mid) => {
          const t = puzzleId ? trialFor(state, puzzleId, mid) : null;
          const label = models[mid]?.label ?? mid;
          if (!t) return null;
          const look = trialLook(t.status, state.status);
          const verdict = t.status in VERDICT ? VERDICT[t.status as keyof typeof VERDICT] : look.label;
          return (
            <article key={mid} className={`final-card tone-border-${look.tone}`}>
              <div className="final-card__top">
                <CubeNet facelets={t.current_facelets} size={128} label={`${label} final cube on ${t.puzzle_id}`} />
                <div className="final-card__text">
                  <span className="final-card__model">
                    <span className="swatch" style={{ background: modelColor(mid) }} aria-hidden="true" />
                    {label}
                  </span>
                  <span className={`final-card__verdict tone-text-${look.tone}`}>{verdict}</span>
                  <span className="mono small">{verdictDetail(t, state.config?.max_moves ?? null)}</span>
                </div>
              </div>
              <details className="final-card__history">
                <summary>Move history</summary>
                <MoveHistory
                  moves={t.moves}
                  invalid={state.live[t.trial_id]?.invalid ?? []}
                  showConfidence={models[mid]?.category !== 'frontier'}
                  height={180}
                />
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}
