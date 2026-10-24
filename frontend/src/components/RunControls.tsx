import { useState, type FormEvent } from 'react';
import { useApi } from '../api/ApiContext';
import { RUN_DEFAULTS, RUN_LIMITS, type ModelInfo, type Suite } from '../api/types';
import { modelColor } from '../lib/modelColors';
import { useAsync } from '../state/useAsync';

export interface BenchmarkRequest {
  puzzles:
    | { source: 'generate'; suite: Suite; count: number; scramble_length: number | null; seed: number | null }
    | { source: 'stored'; puzzle_ids: string[] };
  model_ids: string[];
  max_moves: number;
  timeout_s: number;
  max_retries: number;
  history_window: number;
  concurrency: number;
}

/** Scramble-length ranges per suite (AGENTS.md 4.3); used for input hints only, the backend validates. */
const SUITES: Record<Suite, { label: string; min: number; max: number }> = {
  warmup: { label: 'Warm-up (3–4 turns)', min: 3, max: 4 },
  primary: { label: 'Primary (4–5 turns)', min: 4, max: 5 },
  extension: { label: 'Extension (15–20 turns)', min: 15, max: 20 },
};

const toInt = (s: string): number | null => (s.trim() === '' ? null : Number.parseInt(s, 10));

/** True when the field holds a number inside the backend's accepted range (RUN_LIMITS). */
function inRange(s: string, limit: { min: number; max: number }, integer: boolean): boolean {
  if (s.trim() === '') return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= limit.min && n <= limit.max && (!integer || Number.isInteger(n));
}

export interface RunControlsProps {
  models: ModelInfo[] | null;
  busy: boolean;
  /** A run is queued or running: the start button is disabled. */
  active: boolean;
  phaseLabel: string | null;
  onStart: (req: BenchmarkRequest) => void;
  onCancel: () => void;
  canCancel: boolean;
  cancelling: boolean;
}

export function RunControls({ models, busy, active, phaseLabel, onStart, onCancel, canCancel, cancelling }: RunControlsProps) {
  const api = useApi();
  const [source, setSource] = useState<'generate' | 'stored'>('generate');
  const [suite, setSuite] = useState<Suite>('primary');
  const [count, setCount] = useState('5');
  const [scrambleLength, setScrambleLength] = useState('');
  const [seed, setSeed] = useState('');
  const [selectedStored, setSelectedStored] = useState<string[] | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[] | null>(null);
  const [maxMoves, setMaxMoves] = useState(String(RUN_DEFAULTS.max_moves));
  const [timeoutS, setTimeoutS] = useState(String(RUN_DEFAULTS.timeout_s));
  const [maxRetries, setMaxRetries] = useState(String(RUN_DEFAULTS.max_retries));
  const [historyWindow, setHistoryWindow] = useState(String(RUN_DEFAULTS.history_window));
  const [concurrency, setConcurrency] = useState(String(RUN_DEFAULTS.concurrency));
  const [fairnessOpen, setFairnessOpen] = useState(false);

  const stored = useAsync(source === 'stored' ? () => api.listPuzzles(suite) : null, [api, source, suite]);
  const storedIds = selectedStored ?? (stored.data ?? []).map((p) => p.puzzle_id);
  const availableIds = (models ?? []).filter((m) => m.available).map((m) => m.id);
  const modelIds = (selectedModels ?? availableIds).filter((id) => availableIds.includes(id));

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const puzzlesReady = source === 'generate' ? toInt(count) !== null : storedIds.length > 0;
  // Out-of-range values would only earn a 422, so they block the start button instead.
  const { max_moves: mm, timeout_s: to, max_retries: mr, concurrency: cc } = RUN_LIMITS;
  const limitErrors = [
    !inRange(maxMoves, mm, true) && `Max moves must be ${mm.min}–${mm.max}.`,
    !inRange(timeoutS, to, false) && `Timeout must be ${to.min}–${to.max} s.`,
    !inRange(maxRetries, mr, true) && `Max retries must be ${mr.min}–${mr.max}.`,
    !inRange(concurrency, cc, true) && `Concurrency must be ${cc.min}–${cc.max}.`,
  ].filter((e): e is string => typeof e === 'string');
  const canStart = !busy && !active && modelIds.length > 0 && puzzlesReady && limitErrors.length === 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    onStart({
      puzzles:
        source === 'generate'
          ? { source, suite, count: toInt(count) ?? 1, scramble_length: toInt(scrambleLength), seed: toInt(seed) }
          : { source, puzzle_ids: storedIds },
      // keep GET /models order so lanes and colors stay stable
      model_ids: availableIds.filter((id) => modelIds.includes(id)),
      max_moves: toInt(maxMoves) ?? RUN_DEFAULTS.max_moves,
      timeout_s: Number(timeoutS),
      max_retries: toInt(maxRetries) ?? RUN_DEFAULTS.max_retries,
      history_window: toInt(historyWindow) ?? RUN_DEFAULTS.history_window,
      concurrency: toInt(concurrency) ?? RUN_DEFAULTS.concurrency,
    });
  };

  const range = SUITES[suite];

  return (
    <form className="controls card" onSubmit={submit} aria-label="Benchmark settings">
      <div className="controls__row">
        <fieldset className="field-group">
          <legend>Puzzles</legend>
          <div className="segmented" role="radiogroup" aria-label="Puzzle source">
            <label className={source === 'generate' ? 'is-on' : ''}>
              <input type="radio" name="source" checked={source === 'generate'} onChange={() => setSource('generate')} />
              Generate new
            </label>
            <label className={source === 'stored' ? 'is-on' : ''}>
              <input type="radio" name="source" checked={source === 'stored'} onChange={() => setSource('stored')} />
              Use stored
            </label>
          </div>
          <label className="field">
            <span>Suite</span>
            <select
              value={suite}
              onChange={(e) => {
                setSuite(e.target.value as Suite);
                setScrambleLength('');
                setSelectedStored(null);
              }}
            >
              {(Object.keys(SUITES) as Suite[]).map((s) => (
                <option key={s} value={s}>
                  {SUITES[s].label}
                </option>
              ))}
            </select>
          </label>
          {source === 'generate' ? (
            <>
              <label className="field field--narrow">
                <span>Count</span>
                <input type="number" min={1} max={50} required value={count} onChange={(e) => setCount(e.target.value)} />
              </label>
              <label className="field field--narrow">
                <span>Scramble length</span>
                <input
                  type="number"
                  min={range.min}
                  max={range.max}
                  placeholder="random"
                  value={scrambleLength}
                  onChange={(e) => setScrambleLength(e.target.value)}
                />
              </label>
              <label className="field field--narrow">
                <span>Seed</span>
                <input type="number" placeholder="random" value={seed} onChange={(e) => setSeed(e.target.value)} />
              </label>
            </>
          ) : (
            <div className="stored-list" aria-label="Stored puzzles">
              {stored.loading && <span className="muted small">Loading puzzles…</span>}
              {stored.data && stored.data.length === 0 && <span className="muted small">No stored {suite} puzzles yet.</span>}
              {stored.data?.map((p) => (
                <label key={p.puzzle_id} className="check">
                  <input
                    type="checkbox"
                    checked={storedIds.includes(p.puzzle_id)}
                    onChange={() => setSelectedStored(toggle(storedIds, p.puzzle_id))}
                  />
                  <span>{p.puzzle_id}</span>
                  <span className="muted small">
                    {p.scramble_moves.join(' ')} · opt {p.optimal_distance ?? 'n/a'}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="field-group">
          <legend>Models</legend>
          {!models && <span className="muted small">Loading models…</span>}
          <div className="model-checks">
            {models?.map((m) => (
              <label key={m.id} className={`check ${m.available ? '' : 'is-disabled'}`} title={m.id}>
                <input
                  type="checkbox"
                  disabled={!m.available}
                  checked={m.available && modelIds.includes(m.id)}
                  onChange={() => setSelectedModels(toggle(modelIds, m.id))}
                />
                <span className="swatch swatch--sm" style={{ background: modelColor(m.id) }} aria-hidden="true" />
                <span>{m.label}</span>
                <span className="muted small">{m.available ? (m.category === 'frontier' ? 'frontier' : 'decision') : 'unavailable'}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <details
          className="field-group advanced"
          open={fairnessOpen || limitErrors.length > 0}
          onToggle={(e) => setFairnessOpen(e.currentTarget.open)}
        >
          <summary>
            Fairness settings
            <span className="advanced__summary">
              {timeoutS || '?'} s timeout · {maxRetries || '?'} {maxRetries === '1' ? 'retry' : 'retries'}
            </span>
          </summary>
          <p className="muted small">Applied identically to every model.</p>
          <div className="advanced__fields">
            <label className="field field--narrow">
              <span>Max moves</span>
              <input
                type="number"
                min={mm.min}
                max={mm.max}
                step={1}
                value={maxMoves}
                onChange={(e) => setMaxMoves(e.target.value)}
              />
            </label>
            <label className="field field--narrow">
              <span>
                Timeout (s, {to.min}–{to.max})
              </span>
              <input
                type="number"
                min={to.min}
                max={to.max}
                step="any"
                value={timeoutS}
                onChange={(e) => setTimeoutS(e.target.value)}
                aria-describedby="cost-cap-hint"
              />
            </label>
            <label className="field field--narrow">
              <span>
                Max retries ({mr.min}–{mr.max})
              </span>
              <input
                type="number"
                min={mr.min}
                max={mr.max}
                step={1}
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                aria-describedby="cost-cap-hint"
              />
            </label>
            <label className="field field--narrow">
              <span>History window</span>
              <input type="number" min={0} value={historyWindow} onChange={(e) => setHistoryWindow(e.target.value)} />
            </label>
            <label className="field field--narrow">
              <span>Concurrency</span>
              <input
                type="number"
                min={cc.min}
                max={cc.max}
                step={1}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
              />
            </label>
          </div>
          <p id="cost-cap-hint" className="advanced__hint small">
            Timeout and retries are capped by the backend to limit OpenRouter API cost; every retry is a billed call.
          </p>
        </details>

        <div className="controls__actions">
          <button type="submit" className="btn btn--primary btn--lg" disabled={!canStart}>
            {busy ? (phaseLabel ?? 'Starting…') : active ? 'Run in progress' : 'Run benchmark'}
          </button>
          {canCancel && (
            <button type="button" className="btn btn--danger" onClick={onCancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
          {limitErrors.length > 0 && (
            <p className="controls__invalid small" role="alert">
              {limitErrors.join(' ')}
            </p>
          )}
        </div>
      </div>
      {api.mode === 'mock' && (
        <p className="controls__mock small">
          Mock mode: the backend is simulated by replaying a recorded fixture run (3 primary puzzles × 4 models). Your
          settings are sent and validated, but the replay is always the same recording.
        </p>
      )}
    </form>
  );
}
