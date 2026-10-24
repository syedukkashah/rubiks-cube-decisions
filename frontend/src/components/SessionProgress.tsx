import { formatUsd } from '../api/errors';
import type { BenchmarkSession, StepGate } from '../api/types';
import { runLook, STEP_NAME } from '../lib/status';


const GATE_REASON: Record<string, string> = {
  cost_over_expected: 'cost over expected',
  opus_truncation: 'Opus truncations',
  run_aborted: 'run aborted',
  budget: 'next step over budget',
};

const GATE_ADVICE: Record<string, string> = {
  cost_over_expected: 'Check the spend ledger and the price table before another live pass.',
  opus_truncation: 'Re-run live_smoke.py --calibrate and lower CHAT_MAX_TOKENS if Opus keeps hitting the cap.',
  run_aborted: 'Open the step to read its abort reason (key, credits or a cap).',
  budget: "The next step's worst case no longer fits MAX_SPEND_USD; it cannot run on this budget.",
};

const pct = (v: number | null) => (v === null ? 'no Opus calls' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);

/** Gate figures exactly as the backend reports them (5.10 "Step gates"). */
function GateChip({ gate }: { gate: StepGate }) {
  const figures = `${formatUsd(gate.cost_usd)} of ${formatUsd(gate.expected_cost_usd)} expected · Opus truncations ${pct(gate.opus_truncation_pct)}`;
  return (
    <span className={`gate ${gate.passed ? 'gate--pass' : 'gate--fail'}`} title={figures} data-testid="step-gate">
      <span aria-hidden="true">{gate.passed ? '✓' : '✕'}</span>
      {gate.passed ? 'Gate passed' : `Gate failed: ${gate.reasons.map((r) => GATE_REASON[r] ?? r).join(', ')}`}
      <span className="gate__figures mono">{figures}</span>
    </span>
  );
}

export interface SessionProgressProps {
  session: BenchmarkSession;
  /** Run on screen. */
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}

/** The session's steps in plan order with status and, for live sessions, each step's gate. */
export function SessionProgress({ session, selectedRunId, onSelect }: SessionProgressProps) {
  return (
    <ol className="session-steps" aria-label="Benchmark steps">
      {session.runs.map((r, i) => {
        const look = runLook(r.status);
        const selectable = r.status !== 'skipped';
        return (
          <li key={r.run_id} className={`session-step ${selectedRunId === r.run_id ? 'is-selected' : ''}`}>
            <button type="button" disabled={!selectable} aria-pressed={selectedRunId === r.run_id} onClick={() => onSelect(r.run_id)}>
              <span className="session-step__n mono">{i + 1}</span>
              <span className="session-step__name">{STEP_NAME[r.step]}</span>
              <span className={`pill pill--sm tone-${look.tone}`}>
                <span className={`pill__dot ${look.pulse ? 'pulse' : ''}`} aria-hidden="true" />
                {look.label}
              </span>
            </button>
            {r.gate && <GateChip gate={r.gate} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Shown when a failed step gate stopped a live session before its next step (v1.3.0). */
export function GateStopNotice({ session }: { session: BenchmarkSession }) {
  if (session.stop_reason !== 'gate') return null;
  const index = session.runs.findIndex((r) => r.gate && !r.gate.passed);
  const stopped = session.runs[index];
  const next = session.runs[index + 1];
  if (!stopped?.gate) return null;
  const gate = stopped.gate;
  return (
    <div className="notice notice--warn notice--gate" role="alert" data-testid="gate-stop">
      <span className="notice__icon" aria-hidden="true">
        !
      </span>
      <div className="notice__body">
        <strong>
          Stopped at gate after the {STEP_NAME[stopped.step].toLowerCase()} step
          {next ? `: ${STEP_NAME[next.step].toLowerCase()} did not start` : ''}
        </strong>
        <span className="notice__message">
          Step cost {formatUsd(gate.cost_usd)} against {formatUsd(gate.expected_cost_usd)} expected · Opus truncations{' '}
          {pct(gate.opus_truncation_pct)} · {gate.reasons.map((r) => GATE_REASON[r] ?? r).join(', ')}.
          {session.status === 'completed'
            ? ' The required steps finished, so the recording was saved without the extension.'
            : ' No recording was saved.'}
        </span>
        {gate.reasons.map((r) => (
          <span key={r} className="notice__guidance">
            {GATE_ADVICE[r] ?? `Check "${r}" before another live pass.`}
          </span>
        ))}
      </div>
    </div>
  );
}
