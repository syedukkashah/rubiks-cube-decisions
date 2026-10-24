import { useState } from 'react';
import { formatUsd } from '../api/errors';
import type { BenchmarkInfo, CreateSessionRequest } from '../api/types';
import { formatTime } from '../lib/format';
import { STEP_NAME } from '../lib/status';

const SPEEDS = [1, 2, 4] as const;

export interface OneClickBenchmarkProps {
  info: BenchmarkInfo | null;
  /** Number of models in the run, for the trials = puzzles × models line. */
  modelCount: number | null;
  /** A request is in flight. */
  busy: boolean;
  /** A run or session is still going: starting another is pointless. */
  active: boolean;
  onStart: (req: CreateSessionRequest) => void;
}

/**
 * The whole 6.2 plan from one request (5.10). "Run full benchmark" sends source "auto", which
 * the backend resolves to a replay of the live recording or a simulation: it never spends.
 * The paid live pass is a separate, explicitly confirmed action.
 */
export function OneClickBenchmark({ info, modelCount, busy, active, onStart }: OneClickBenchmarkProps) {
  const [speed, setSpeed] = useState<number>(1);
  const [includeExtension, setIncludeExtension] = useState(true);
  const [liveOpen, setLiveOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const steps = info?.plan.filter((p) => !p.optional || includeExtension) ?? [];
  const puzzles = steps.reduce((n, p) => n + p.count, 0);
  const trials = modelCount ? puzzles * modelCount : null;
  const replay = info?.auto_source === 'replay' && info.recording ? info.recording : null;
  const disabled = busy || active || !info;

  return (
    <section className="oneclick" aria-labelledby="oneclick-heading">
      <div className="oneclick__head">
        <h2 id="oneclick-heading" className="eyebrow">
          One click · full benchmark
        </h2>
        <span className="muted small">Warm-up, primary and extension run one after another</span>
      </div>

      <ol className="plan">
        {info?.plan.map((p, i) => {
          const on = !p.optional || includeExtension;
          return (
            <li key={p.step} className={`plan__step ${on ? '' : 'is-off'}`}>
              <span className="plan__n mono">{i + 1}</span>
              <span className="plan__name">{STEP_NAME[p.step]}</span>
              <span className="plan__meta mono">
                {p.count} {p.count === 1 ? 'puzzle' : 'puzzles'} · seed {p.seed} · max {p.max_moves} moves
              </span>
              <span className="plan__trials mono">{modelCount ? `${p.count * modelCount} trials` : ''}</span>
              {p.optional && (
                <label className="check">
                  <input type="checkbox" checked={includeExtension} onChange={(e) => setIncludeExtension(e.target.checked)} />
                  Include
                </label>
              )}
            </li>
          );
        }) ?? <li className="muted small">Loading the plan…</li>}
      </ol>

      <div className="oneclick__source" data-source={info?.auto_source ?? 'unknown'}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
        </svg>
        {replay ? (
          <div>
            <strong>Replays your live recording · no OpenRouter calls</strong>
            <span>
              Recorded {formatTime(replay.recorded_at)} · {replay.trial_count} trials
              {replay.total_cost_usd !== null ? ` · ${formatUsd(replay.total_cost_usd)} spent once, $0 now` : ''}. Same moves,
              latencies and results as the original; only the pacing follows the speed below.
            </span>
          </div>
        ) : (
          <div>
            <strong>Simulated · no OpenRouter calls</strong>
            <span>No live recording yet, so the backend's mock players play the plan. Nothing is spent.</span>
          </div>
        )}
      </div>

      <div className="oneclick__actions">
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((v) => (
            <button key={v} type="button" aria-pressed={speed === v} onClick={() => setSpeed(v)}>
              {v}×
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={disabled}
          onClick={() => onStart({ source: 'auto', speed, include_extension: includeExtension })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 4.5v15l13-7.5z" />
          </svg>
          {busy ? 'Starting…' : active ? 'Benchmark in progress' : `Run full benchmark${trials ? ` · ${trials} trials` : ''}`}
        </button>
      </div>

      {info?.sources.live && (
        <div className="live">
          {!liveOpen ? (
            <button type="button" className="btn btn--ghost" disabled={disabled} onClick={() => setLiveOpen(true)}>
              Run live once…
            </button>
          ) : (
            <div className="live__confirm" role="group" aria-label="Confirm live run">
              <strong>Live run through OpenRouter · spends credit</strong>
              <ul>
                <li>The backend checks the worst-case cost of the warm-up and primary steps against the remaining budget first, and refuses if it does not fit.</li>
                <li>
                  After each step it checks the step gates (cost vs. expected, Opus truncations, aborts, budget) and stops before the next step if one fails.
                </li>
                <li>A completed session is saved as the recording. Every later "Run full benchmark" replays it for free.</li>
              </ul>
              <label className="check">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                I ran live_smoke.py and --calibrate, and I want to spend credit on one live pass.
              </label>
              <div className="live__buttons">
                <button
                  type="button"
                  className="btn btn--live"
                  disabled={disabled || !acknowledged}
                  onClick={() => onStart({ source: 'live', include_extension: includeExtension, confirm_cost: true })}
                >
                  Start live run
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setLiveOpen(false);
                    setAcknowledged(false);
                  }}
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {info && !info.sources.live && info.recording && (
        <p className="muted small">
          The live pass is done: its recording ({formatTime(info.recording.recorded_at)}) is what this button replays. Another live pass is
          blocked unless the backend sets ALLOW_LIVE_RERUN=true.
        </p>
      )}
    </section>
  );
}
