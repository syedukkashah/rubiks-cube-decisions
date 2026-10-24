import { useState, type FormEvent } from 'react';
import { RUN_DEFAULTS, RUN_LIMITS, type ModelInfo, type Suite } from '../api/types';
import { modelColor } from '../lib/modelColors';

export interface BenchmarkRequest {
  puzzles: { source: 'generate'; suite: Suite; count: number; scramble_length: number | null; seed: number | null };
  model_ids: string[];
  max_moves: number;
  timeout_s: number;
  max_retries: number;
  history_window: number;
  concurrency: number;
}

/** Suites from AGENTS.md 4.3; ranges are input hints only, the backend validates. */
const SUITES: Record<Suite, { name: string; range: string; min: number; max: number; desc: string; opt: string }> = {
  warmup: { name: 'Warm-up', range: '3–4 turns', min: 3, max: 4, desc: 'Check adapters, move validation and the engine.', opt: 'Exact (BFS)' },
  primary: { name: 'Primary', range: '4–5 turns', min: 4, max: 5, desc: 'Main comparison. Exact shortest distance is known.', opt: 'Exact (BFS)' },
  extension: { name: 'Extension', range: '15–20 turns', min: 15, max: 20, desc: 'Harder states and failure rates. No optimum computed.', opt: 'Not computed' },
};

const COUNT = { min: 1, max: 50 } as const;
/** Assignment minimum: 5 primary puzzles × 4 models. */
const RECOMMENDED_PRIMARY_TRIALS = 20;

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
  /** A run or session is queued or running: the start button is disabled. */
  active: boolean;
  phaseLabel: string | null;
  onStart: (req: BenchmarkRequest) => void;
}

/** One custom run through POST /puzzles + POST /runs (the "Advanced" path next to the one-click benchmark). */
export function RunControls({ models, busy, active, phaseLabel, onStart }: RunControlsProps) {
  const [suite, setSuite] = useState<Suite>('primary');
  const [count, setCount] = useState(5);
  const [scrambleLength, setScrambleLength] = useState('');
  const [seed, setSeed] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[] | null>(null);
  const [maxMoves, setMaxMoves] = useState(String(RUN_DEFAULTS.max_moves));
  const [timeoutS, setTimeoutS] = useState(String(RUN_DEFAULTS.timeout_s));
  const [maxRetries, setMaxRetries] = useState(String(RUN_DEFAULTS.max_retries));
  const [historyWindow, setHistoryWindow] = useState(String(RUN_DEFAULTS.history_window));
  const [concurrency, setConcurrency] = useState(String(RUN_DEFAULTS.concurrency));
  const [editing, setEditing] = useState(false);

  const availableIds = (models ?? []).filter((m) => m.available).map((m) => m.id);
  const modelIds = (selectedModels ?? availableIds).filter((id) => availableIds.includes(id));
  const toggle = (id: string) =>
    setSelectedModels(modelIds.includes(id) ? modelIds.filter((x) => x !== id) : [...modelIds, id]);

  // Out-of-range values would only earn a 422, so they block the start button instead.
  const { max_moves: mm, timeout_s: to, max_retries: mr, concurrency: cc } = RUN_LIMITS;
  const limitErrors = [
    !inRange(maxMoves, mm, true) && `Max moves must be ${mm.min}–${mm.max}.`,
    !inRange(timeoutS, to, false) && `Timeout must be ${to.min}–${to.max} s.`,
    !inRange(maxRetries, mr, true) && `Max retries must be ${mr.min}–${mr.max}.`,
    !inRange(concurrency, cc, true) && `Concurrency must be ${cc.min}–${cc.max}.`,
  ].filter((e): e is string => typeof e === 'string');
  const canStart = !busy && !active && modelIds.length > 0 && limitErrors.length === 0;
  const trials = count * modelIds.length;
  const info = SUITES[suite];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    onStart({
      puzzles: { source: 'generate', suite, count, scramble_length: toInt(scrambleLength), seed: toInt(seed) },
      // keep GET /models order so lanes and colors stay stable
      model_ids: availableIds.filter((id) => modelIds.includes(id)),
      max_moves: toInt(maxMoves) ?? RUN_DEFAULTS.max_moves,
      timeout_s: Number(timeoutS),
      max_retries: toInt(maxRetries) ?? RUN_DEFAULTS.max_retries,
      history_window: toInt(historyWindow) ?? RUN_DEFAULTS.history_window,
      concurrency: toInt(concurrency) ?? RUN_DEFAULTS.concurrency,
    });
  };

  const fairPlay: [string, string][] = [
    ['Max moves', maxMoves],
    ['Timeout / call', `${timeoutS} s`],
    ['Retries / move', maxRetries],
    ['History window', `${historyWindow} moves`],
    ['Concurrency', concurrency],
    ['Move set', '18 · HTM'],
  ];

  return (
    <form className="custom-run" onSubmit={submit} aria-label="Custom run settings">
      <fieldset className="step">
        <legend className="eyebrow">1 · Test suite</legend>
        <div className="suite-cards">
          {(Object.keys(SUITES) as Suite[]).map((s) => (
            <button
              key={s}
              type="button"
              className="suite-card"
              aria-pressed={suite === s}
              onClick={() => {
                setSuite(s);
                setScrambleLength('');
              }}
            >
              <span className="suite-card__top">
                <span className="suite-card__name">{SUITES[s].name}</span>
                <span className="mono small muted">{SUITES[s].range}</span>
              </span>
              <span className="suite-card__desc">{SUITES[s].desc}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="step step--row">
        <legend className="eyebrow">2 · Puzzles</legend>
        <div className="field">
          <span id="count-label" className="field__label">
            How many scrambles
          </span>
          <div className="stepper" role="group" aria-labelledby="count-label">
            <button type="button" aria-label="Fewer puzzles" onClick={() => setCount((c) => Math.max(COUNT.min, c - 1))}>
              −
            </button>
            <output aria-live="polite">{count}</output>
            <button type="button" aria-label="More puzzles" onClick={() => setCount((c) => Math.min(COUNT.max, c + 1))}>
              +
            </button>
          </div>
        </div>
        <label className="field">
          <span className="field__label">Seed (reproducible)</span>
          <input className="input input--mono" inputMode="numeric" placeholder="random" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Scramble length</span>
          <input
            className="input"
            type="number"
            min={info.min}
            max={info.max}
            placeholder="Random in range"
            value={scrambleLength}
            onChange={(e) => setScrambleLength(e.target.value)}
          />
        </label>
      </fieldset>

      <fieldset className="step">
        <legend className="eyebrow">3 · Models</legend>
        {!models && <span className="muted small">Loading models…</span>}
        <div className="model-cards">
          {models?.map((m) => {
            const on = m.available && modelIds.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                className="model-card"
                aria-pressed={on}
                disabled={!m.available}
                onClick={() => toggle(m.id)}
                title={m.id}
              >
                <span className="model-card__box" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </span>
                <span className="model-card__swatch" style={{ background: modelColor(m.id) }} aria-hidden="true" />
                <span className="model-card__text">
                  <span className="model-card__label">{m.label}</span>
                  <span className="model-card__sub">
                    {m.category === 'frontier' ? 'Frontier LLM · Chat completions' : 'System-1 · Decisions API'}
                  </span>
                </span>
                <span className={`avail ${m.available ? 'avail--on' : 'avail--off'}`}>
                  <span className="avail__dot" aria-hidden="true" />
                  {m.available ? 'Available' : 'Unavailable'}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="step">
        <legend className="eyebrow">4 · Fair-play rules · identical for every model</legend>
        <div className="fair-chips">
          {fairPlay.map(([k, v]) => (
            <span key={k} className="fair-chip">
              <span className="muted">{k}</span>
              <span className="mono strong">{v}</span>
            </span>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" aria-expanded={editing || limitErrors.length > 0} onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        </div>
        {(editing || limitErrors.length > 0) && (
          <div className="fair-edit">
            <label className="field">
              <span className="field__label">Max moves</span>
              <input className="input input--narrow" type="number" min={mm.min} max={mm.max} step={1} value={maxMoves} onChange={(e) => setMaxMoves(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">
                Timeout (s, {to.min}–{to.max})
              </span>
              <input
                className="input input--narrow"
                type="number"
                min={to.min}
                max={to.max}
                step="any"
                value={timeoutS}
                onChange={(e) => setTimeoutS(e.target.value)}
                aria-describedby="cost-cap-hint"
              />
            </label>
            <label className="field">
              <span className="field__label">
                Max retries ({mr.min}–{mr.max})
              </span>
              <input
                className="input input--narrow"
                type="number"
                min={mr.min}
                max={mr.max}
                step={1}
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                aria-describedby="cost-cap-hint"
              />
            </label>
            <label className="field">
              <span className="field__label">History window</span>
              <input className="input input--narrow" type="number" min={0} value={historyWindow} onChange={(e) => setHistoryWindow(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Concurrency</span>
              <input className="input input--narrow" type="number" min={cc.min} max={cc.max} step={1} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
            </label>
          </div>
        )}
        <p id="cost-cap-hint" className="hint small">
          Timeout and retries are capped by the backend to limit OpenRouter API cost; every retry is a billed call.
          Concurrency stays at 1 so parallel calls don't skew latency numbers.
        </p>
        {limitErrors.length > 0 && (
          <p className="invalid small" role="alert">
            {limitErrors.join(' ')}
          </p>
        )}
      </fieldset>

      <div className="custom-run__footer">
        <div className="custom-run__summary">
          <span className="mono strong">{trials}</span>
          <span className="muted">
            trials = {count} {info.name.toLowerCase()} × {modelIds.length} models · shortest solution {info.opt.toLowerCase()}
          </span>
          {suite === 'primary' && trials < RECOMMENDED_PRIMARY_TRIALS && (
            <span className="warn small">Below the recommended 20 primary trials. Fine for a check, thin as evidence.</span>
          )}
        </div>
        <button type="submit" className="btn btn--secondary btn--lg" disabled={!canStart}>
          {busy ? (phaseLabel ?? 'Starting…') : active ? 'Run in progress' : 'Run custom benchmark'}
        </button>
      </div>
    </form>
  );
}
