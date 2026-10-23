import type { Puzzle } from '../api/types';
import { CubeNet } from './CubeNet';

export interface PuzzlePanelProps {
  puzzleIds: string[];
  puzzles: Record<string, Puzzle>;
  /** Puzzle currently shown. */
  shownPuzzleId: string | null;
  /** null = follow live. */
  focusPuzzleId: string | null;
  onFocus: (puzzleId: string | null) => void;
  /** Fallback start state when the Puzzle object is not loaded (from Trial.initial_facelets). */
  fallbackFacelets?: string | null;
}

const SUITE_LABEL = { warmup: 'Warm-up', primary: 'Primary', extension: 'Extension' } as const;

/** The scrambled start state every model receives, plus puzzle navigation. */
export function PuzzlePanel({ puzzleIds, puzzles, shownPuzzleId, focusPuzzleId, onFocus, fallbackFacelets }: PuzzlePanelProps) {
  const puzzle = shownPuzzleId ? puzzles[shownPuzzleId] : undefined;
  const facelets = puzzle?.facelets ?? fallbackFacelets ?? '';
  return (
    <section className="puzzle-panel card" aria-label="Scrambled cube">
      <div className="puzzle-panel__head">
        <h2>Scrambled cube</h2>
        <span className="muted">{shownPuzzleId ?? '—'}</span>
      </div>
      <CubeNet facelets={facelets} size={300} label={`Scrambled start state ${shownPuzzleId ?? ''}`} />
      <dl className="puzzle-panel__facts">
        <div>
          <dt>Suite</dt>
          <dd>{puzzle ? SUITE_LABEL[puzzle.suite] : '—'}</dd>
        </div>
        <div>
          <dt>Optimal (BFS)</dt>
          <dd>{puzzle ? (puzzle.optimal_distance === null ? 'not computed' : `${puzzle.optimal_distance} moves`) : '—'}</dd>
        </div>
      </dl>
      <div className="puzzle-panel__scramble">
        <span className="muted">Scramble</span>
        <div className="move-chips">
          {puzzle ? puzzle.scramble_moves.map((m, i) => <span className="move-chip" key={i}>{m}</span>) : <span className="muted">—</span>}
        </div>
      </div>
      {puzzleIds.length > 0 && (
        <div className="puzzle-panel__nav" role="group" aria-label="Choose puzzle to inspect">
          <button type="button" className={`pill ${focusPuzzleId === null ? 'pill--on' : ''}`} onClick={() => onFocus(null)} aria-pressed={focusPuzzleId === null}>
            Follow live
          </button>
          {puzzleIds.map((id) => (
            <button key={id} type="button" className={`pill ${focusPuzzleId === id ? 'pill--on' : ''}`} onClick={() => onFocus(id)} aria-pressed={focusPuzzleId === id}>
              {id}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
