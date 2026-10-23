import { useState } from 'react';
import type { ModelStats, RunStats } from '../api/types';
import { formatGap, formatMs, formatPct, formatSeconds } from '../lib/format';
import { modelColor } from '../lib/modelColors';

// Small multiples: one horizontal bar chart per metric, one bar per model.
// One axis per chart, bars grow from a shared zero baseline, value at the tip,
// model label beside every bar (identity is never color-alone), hover tooltip per bar.
// Built from HTML so text stays at its CSS size at any chart width.
// Scales are for drawing only; every number shown is the backend's.

interface Metric {
  key: string;
  title: string;
  note: string;
  value: (m: ModelStats) => number | null;
  format: (v: number | null) => string;
  /** Fixed domain max; otherwise the largest value in the chart. */
  domainMax?: number;
}

const METRICS: Metric[] = [
  { key: 'latency', title: 'Avg latency per move', note: 'lower is faster', value: (m) => m.avg_move_latency_ms, format: formatMs },
  { key: 'time', title: 'Avg total solve time', note: 'per trial, lower is faster', value: (m) => m.avg_total_time_s, format: formatSeconds },
  { key: 'success', title: 'Success rate', note: 'higher is better', value: (m) => m.success_rate_pct, format: formatPct, domainMax: 100 },
  { key: 'gap', title: 'Avg optimality gap', note: '0 = optimal, lower is better', value: (m) => m.avg_optimality_gap, format: formatGap },
  { key: 'moves', title: 'Total moves', note: 'all trials', value: (m) => m.total_moves, format: (v) => (v === null ? '—' : String(v)) },
];

export function StatsBars({ stats }: { stats: RunStats }) {
  return (
    <div className="bars-grid">
      {METRICS.map((metric) => (
        <BarChart key={metric.key} metric={metric} models={stats.models} />
      ))}
    </div>
  );
}

function BarChart({ metric, models }: { metric: Metric; models: ModelStats[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const values = models.map(metric.value);
  const dataMax = Math.max(0, ...values.filter((v): v is number => v !== null));
  const max = metric.domainMax ?? (dataMax > 0 ? dataMax : 1);

  return (
    <figure className="bar-chart" aria-label={`${metric.title} by model`}>
      <figcaption>
        <span className="bar-chart__title">{metric.title}</span>
        <span className="bar-chart__note">{metric.note}</span>
      </figcaption>
      <div className="bar-chart__rows" onMouseLeave={() => setHover(null)}>
        {models.map((m) => {
          const v = metric.value(m);
          const frac = v === null || v <= 0 ? 0 : Math.max(0.012, v / max);
          const text = v === null ? 'no data' : metric.format(v);
          return (
            <div
              key={m.model_id}
              className={`bar-row ${hover === m.model_id ? 'is-hover' : ''}`}
              onMouseEnter={() => setHover(m.model_id)}
              onFocus={() => setHover(m.model_id)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${m.label}: ${text}`}
            >
              <span className="bar-row__label">{m.label}</span>
              <span className="bar-row__track">
                <span
                  className="bar-row__bar"
                  style={{ width: `calc((100% - 84px) * ${frac})`, background: modelColor(m.model_id) }}
                />
                <span className="bar-row__value">{text}</span>
              </span>
              {hover === m.model_id && (
                <span className="tooltip" role="tooltip">
                  <span>
                    <span className="swatch swatch--sm" style={{ background: modelColor(m.model_id) }} aria-hidden="true" />
                    <strong>{m.label}</strong>
                  </span>
                  <span>
                    {metric.title}: {text}
                  </span>
                  <span className="muted">
                    {m.solved_trials}/{m.trials} solved · {m.category === 'frontier' ? 'frontier' : 'decision'}
                  </span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </figure>
  );
}
