import type { RunStats } from '../api/types';
import { formatGap, formatMs, formatNumber, formatPct, formatSeconds } from '../lib/format';
import { modelColor } from '../lib/modelColors';

/** Per-model benchmark statistics exactly as GET /runs/{id}/stats reports them (AGENTS.md 5.8). */
export function StatsTable({ stats }: { stats: RunStats }) {
  const q = stats.questions_answered;
  return (
    <div className="table-scroll">
      <table className="stats-table" aria-label="Benchmark statistics per model">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col" className="num">Avg latency / move</th>
            <th scope="col" className="num">Avg total solve time</th>
            <th scope="col" className="num">Total moves</th>
            <th scope="col" className="num">Success rate</th>
            <th scope="col" className="num">Avg optimality gap</th>
            <th scope="col" className="num">Avg moves / trial</th>
            <th scope="col" className="num">Invalid</th>
            <th scope="col" className="num">Retries</th>
            <th scope="col" className="num">Timeouts</th>
          </tr>
        </thead>
        <tbody>
          {stats.models.map((m) => (
            <tr key={m.model_id} data-model={m.model_id}>
              <th scope="row">
                <span className="swatch swatch--sm" style={{ background: modelColor(m.model_id) }} aria-hidden="true" />
                {m.label}
                <span className="stats-table__cat">{m.category === 'frontier' ? 'Frontier' : 'Decision'}</span>
              </th>
              <td className="num">
                {formatMs(m.avg_move_latency_ms)}
                {q.fastest_model_id === m.model_id && <Mark text="Fastest" />}
              </td>
              <td className="num">{formatSeconds(m.avg_total_time_s)}</td>
              <td className="num">{m.total_moves}</td>
              <td className="num">
                {formatPct(m.success_rate_pct)}
                <span className="muted"> ({m.solved_trials}/{m.trials})</span>
                {q.highest_solve_rate_model_id === m.model_id && <Mark text="Top" />}
              </td>
              <td className="num">
                {formatGap(m.avg_optimality_gap)}
                {q.best_optimality_gap_model_id === m.model_id && <Mark text="Best" />}
              </td>
              <td className="num">{formatNumber(m.avg_moves_per_trial)}</td>
              <td className="num">{m.invalid_move_count}</td>
              <td className="num">{m.retry_count}</td>
              <td className="num">{m.timeout_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Mark({ text }: { text: string }) {
  return <span className="mark">★ {text}</span>;
}
