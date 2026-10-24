import type { ModelInfo, Puzzle, RunConfig, RunStatus } from '../api/types';
import { modelColor, shortLabel } from '../lib/modelColors';
import { trialLook } from '../lib/status';
import type { RunState } from '../state/runReducer';
import { trialFor } from '../state/selectors';
import { CubeNet } from './CubeNet';

export interface PuzzlePanelProps {
  state: RunState;
  config: RunConfig | null;
  puzzles: Record<string, Puzzle>;
  models: Record<string, ModelInfo>;
  /** Puzzle currently shown. */
  shownPuzzleId: string | null;
  /** null = follow live. */
  focusPuzzleId: string | null;
  onFocus: (puzzleId: string | null) => void;
  /** Fallback start state when the Puzzle object is not loaded (from Trial.initial_facelets). */
  fallbackFacelets?: string | null;
  /** Plan seed when the run is a session step. */
  seed?: number | null;
  runStatus: RunStatus | null;
}

/** The shared scrambled start state, its facts, and a compact puzzles × models matrix. */
export function PuzzlePanel({
  state,
  config,
  puzzles,
  models,
  shownPuzzleId,
  focusPuzzleId,
  onFocus,
  fallbackFacelets,
  seed = null,
  runStatus,
}: PuzzlePanelProps) {
  const puzzle = shownPuzzleId ? puzzles[shownPuzzleId] : undefined;
  const facelets = puzzle?.facelets ?? fallbackFacelets ?? '';
  const puzzleIds = config?.puzzle_ids ?? [];
  const modelIds = config?.model_ids ?? [];

  return (
    <aside className="puzzle-col">
      <section className="panel" aria-label="Shared scramble">
        <div className="panel__head">
          <h2 className="eyebrow">Shared scramble</h2>
          <span className="mono small muted">{seed !== null ? `seed ${seed}` : (shownPuzzleId ?? '—')}</span>
        </div>
        <div className="puzzle-net">
          <CubeNet facelets={facelets} size={286} label={`Scrambled cube net, ${shownPuzzleId ?? ''}`} />
        </div>
        <div className="scramble">
          <span className="muted small">Scramble applied to the solved cube</span>
          <div className="scramble__chips">
            {puzzle ? (
              puzzle.scramble_moves.map((m, i) => (
                <span className="move-chip" key={i}>
                  {m}
                </span>
              ))
            ) : (
              <span className="muted">—</span>
            )}
          </div>
        </div>
        <div className="tiles">
          <div className="tile">
            <span>BFS optimum</span>
            <strong>{puzzle ? (puzzle.optimal_distance ?? 'n/a') : '—'}</strong>
          </div>
          <div className="tile">
            <span>Move limit</span>
            <strong>{config?.max_moves ?? '—'}</strong>
          </div>
          <div className="tile">
            <span>Metric</span>
            <strong>HTM</strong>
          </div>
        </div>
        {config && (
          <p className="fairness small">
            Same scramble, engine, move set, prompt, {config.history_window}-move history, {config.timeout_s} s timeout and{' '}
            {config.max_retries} {config.max_retries === 1 ? 'retry' : 'retries'} for every model. Only the model ID changes.
          </p>
        )}
      </section>

      {puzzleIds.length > 0 && modelIds.length > 0 && (
        <section className="panel" aria-label="Puzzles in this run">
          <div className="panel__head">
            <h2 className="eyebrow">Puzzles in this run</h2>
            <button type="button" className={`link-button small ${focusPuzzleId === null ? 'is-on' : ''}`} aria-pressed={focusPuzzleId === null} onClick={() => onFocus(null)}>
              Follow live
            </button>
          </div>
          <table className="mini-matrix">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Puzzle</span>
                </th>
                {modelIds.map((id) => (
                  <th scope="col" key={id} style={{ color: modelColor(id) }}>
                    {shortLabel(models[id]?.label ?? id)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {puzzleIds.map((pid) => (
                <tr key={pid} className={pid === shownPuzzleId ? 'is-shown' : undefined}>
                  <th scope="row">
                    <button type="button" className="link-button mono" aria-pressed={focusPuzzleId === pid} onClick={() => onFocus(pid)}>
                      {pid}
                    </button>
                  </th>
                  {modelIds.map((mid) => {
                    const t = trialFor(state, pid, mid);
                    if (!t) return <td key={mid}>·</td>;
                    const look = trialLook(t.status, runStatus);
                    const text =
                      t.status === 'solved'
                        ? `${t.moves_used}${t.optimality_gap === 0 ? ' ✓' : ''}`
                        : t.status === 'move_limit'
                          ? 'limit'
                          : t.status === 'error'
                            ? 'error'
                            : t.status === 'running' && look.tone === 'run'
                              ? '…'
                              : '·';
                    return (
                      <td key={mid}>
                        <span className={`mini-cell tone-${look.tone} ${look.pulse ? 'pulse' : ''}`} title={`${models[mid]?.label ?? mid}: ${look.label}`}>
                          {text}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <span className="muted tiny">Number = moves used when solved · ✓ marks the BFS optimum</span>
        </section>
      )}
    </aside>
  );
}
