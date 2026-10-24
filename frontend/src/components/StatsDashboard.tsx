import type { ModelStats, RunStats } from '../api/types';
import { formatGap, formatMs, formatPct, formatSeconds } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import { ErrorNotice } from './ErrorNotice';
import { StatsTable } from './StatsTable';

// One card per assignment metric, one bar per model. Scales are for drawing only;
// every number shown is the backend's (GET /runs/{id}/stats). Winners come from questions_answered.

interface Metric {
  key: string;
  title: string;
  hint: string;
  foot: string;
  value: (m: ModelStats) => number | null;
  format: (v: number | null) => string;
  /** Bar length in [0, 1] for value v given the largest value in the card. */
  scale: (v: number, max: number) => number;
  /** Model the backend named best for this metric, if any. */
  best?: (s: RunStats) => string | null;
}

const linear = (v: number, max: number) => (max > 0 ? v / max : 0);
/** Log scale from 10 ms to 10 s, so 100 ms and 6 s both stay readable. */
const logLatency = (v: number) => Math.min(1, Math.max(0, (Math.log10(Math.max(v, 1)) - 1) / 3));

const METRICS: Metric[] = [
  {
    key: 'latency',
    title: 'Per-move average latency',
    hint: 'log scale · lower is faster',
    foot: 'Accepted calls only. Retries of invalid outputs are excluded.',
    value: (m) => m.avg_move_latency_ms,
    format: formatMs,
    scale: logLatency,
    best: (s) => s.questions_answered.fastest_model_id,
  },
  {
    key: 'time',
    title: 'Total solve time',
    hint: 'avg per trial · lower is faster',
    foot: 'Trial start to solved, move limit or error, including retries.',
    value: (m) => m.avg_total_time_s,
    format: formatSeconds,
    scale: linear,
  },
  {
    key: 'moves',
    title: 'Total number of moves',
    hint: 'sum over trials',
    foot: 'Valid moves applied. Invalid outputs do not consume a move.',
    value: (m) => m.total_moves,
    format: (v) => (v === null ? '—' : String(v)),
    scale: linear,
  },
  {
    key: 'success',
    title: 'Success rate',
    hint: 'solved within the move limit',
    foot: 'Move limit and error are unsuccessful attempts.',
    value: (m) => m.success_rate_pct,
    format: formatPct,
    scale: (v) => v / 100,
    best: (s) => s.questions_answered.highest_solve_rate_model_id,
  },
  {
    key: 'gap',
    title: 'Optimality gap',
    hint: 'model moves − BFS optimum · lower is better',
    foot: 'Average over solved trials on puzzles with a known optimum.',
    value: (m) => m.avg_optimality_gap,
    format: formatGap,
    scale: linear,
    best: (s) => s.questions_answered.best_optimality_gap_model_id,
  },
];

function MetricCard({ metric, stats }: { metric: Metric; stats: RunStats }) {
  const values = stats.models.map(metric.value);
  const max = Math.max(0, ...values.filter((v): v is number => v !== null));
  const best = metric.best?.(stats) ?? null;
  return (
    <article className="metric" aria-label={`${metric.title} by model`}>
      <div className="metric__head">
        <h3>{metric.title}</h3>
        <span className="muted small">{metric.hint}</span>
      </div>
      <div className="metric__rows">
        {stats.models.map((m) => {
          const v = metric.value(m);
          const frac = v === null || v <= 0 ? 0 : metric.scale(v, max);
          return (
            <div key={m.model_id} className={`metric__row ${best === m.model_id ? 'is-best' : ''}`}>
              <span className="metric__label">
                <span className="swatch" style={{ background: modelColor(m.model_id) }} aria-hidden="true" />
                {m.label}
              </span>
              <span className="metric__track">
                <span className="metric__bar bar" style={{ width: `${frac * 100}%`, background: modelColor(m.model_id) }} />
              </span>
              <span className="metric__value mono">{v === null ? 'no data' : metric.format(v)}</span>
            </div>
          );
        })}
      </div>
      <span className="muted small">{metric.foot}</span>
    </article>
  );
}

export interface StatsDashboardProps {
  stats: RunStats | null;
  error: unknown;
  loading: boolean;
  onRetry: () => void;
}

export function StatsDashboard({ stats, error, loading, onRetry }: StatsDashboardProps) {
  const partial = stats && stats.run_status !== 'completed';
  return (
    <section className="dashboard" aria-labelledby="stats-heading">
      <div className="section-head">
        <h2 id="stats-heading">Benchmark dashboard</h2>
        {stats && (
          <span className={`pill pill--sm ${partial ? 'tone-limit' : 'tone-solved'}`}>
            {partial ? `Partial: run ${stats.run_status}` : 'Final'}
          </span>
        )}
        <span className="muted small section-head__note">
          {stats ? `All values from GET /runs/${stats.run_id}/stats · computed by the backend` : ''}
          {loading ? ' · updating…' : ''}
        </span>
      </div>
      {error ? <ErrorNotice error={error} onRetry={onRetry} compact /> : null}
      {!stats && !error && <p className="muted">Statistics appear here once trials finish.</p>}
      {stats && (
        <>
          <div className="metrics-grid">
            {METRICS.map((metric) => (
              <MetricCard key={metric.key} metric={metric} stats={stats} />
            ))}
          </div>
          <details className="panel table-details">
            <summary>All figures per model (table)</summary>
            <StatsTable stats={stats} />
          </details>
        </>
      )}
    </section>
  );
}

/** Invalid outputs, retries and timeouts per model, straight from the stats. */
export function ReliabilityTable({ stats }: { stats: RunStats }) {
  return (
    <section className="panel reliability" aria-labelledby="reliability-heading">
      <h2 id="reliability-heading" className="eyebrow">
        Reliability · logged, never coerced
      </h2>
      <table className="plain-table">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col" className="num">
              Invalid
            </th>
            <th scope="col" className="num">
              Retries
            </th>
            <th scope="col" className="num">
              Timeouts
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.models.map((m) => (
            <tr key={m.model_id}>
              <th scope="row">
                <span className="swatch" style={{ background: modelColor(m.model_id) }} aria-hidden="true" />
                {m.label}
              </th>
              <td className={`num mono ${m.invalid_move_count ? 'tone-text-error' : 'muted'}`}>{m.invalid_move_count}</td>
              <td className={`num mono ${m.retry_count ? '' : 'muted'}`}>{m.retry_count}</td>
              <td className={`num mono ${m.timeout_count ? 'tone-text-limit' : 'muted'}`}>{m.timeout_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
