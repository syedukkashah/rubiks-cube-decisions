import type { ModelInfo, Puzzle, RunStatus } from '../api/types';
import { formatGap } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import type { RunState } from '../state/runReducer';
import { trialFor } from '../state/selectors';
import { ResultBanner } from './ResultBanner';

export interface ResultsMatrixProps {
  state: RunState;
  models: Record<string, ModelInfo>;
  puzzles: Record<string, Puzzle>;
  runStatus: RunStatus | null;
  focusPuzzleId: string | null;
  onFocus: (puzzleId: string) => void;
}

/** Result per trial, grouped per puzzle: rows = puzzles, columns = models. */
export function ResultsMatrix({ state, models, puzzles, runStatus, focusPuzzleId, onFocus }: ResultsMatrixProps) {
  const puzzleIds = state.config?.puzzle_ids ?? [];
  const modelIds = state.config?.model_ids ?? [];
  if (!puzzleIds.length || !modelIds.length) return null;
  return (
    <section className="card" aria-labelledby="results-heading">
      <h2 id="results-heading">Results by puzzle</h2>
      <div className="table-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Puzzle</th>
              <th scope="col" className="num">Optimum</th>
              {modelIds.map((id) => (
                <th scope="col" key={id}>
                  <span className="swatch swatch--sm" style={{ background: modelColor(id) }} aria-hidden="true" />
                  {models[id]?.label ?? id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {puzzleIds.map((pid) => {
              const p = puzzles[pid];
              return (
                <tr key={pid} className={focusPuzzleId === pid ? 'is-focused' : undefined}>
                  <th scope="row">
                    <button type="button" className="link-button" onClick={() => onFocus(pid)}>
                      {pid}
                    </button>
                    {p && <span className="matrix__scramble">{p.scramble_moves.join(' ')}</span>}
                  </th>
                  <td className="num">{p ? (p.optimal_distance ?? '—') : '—'}</td>
                  {modelIds.map((mid) => {
                    const t = trialFor(state, pid, mid);
                    if (!t) return <td key={mid} className="muted">—</td>;
                    return (
                      <td key={mid}>
                        <ResultBanner status={t.status} runStatus={runStatus} error={t.error} variant="chip" />
                        <span className="matrix__detail">
                          {t.moves_used} moves
                          {t.optimality_gap !== null && <> · gap {formatGap(t.optimality_gap)}</>}
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
    </section>
  );
}
