import type { RunStats } from '../api/types';
import { ErrorNotice } from './ErrorNotice';
import { QuestionsAnswered } from './QuestionsAnswered';
import { StatsBars } from './StatsBars';
import { StatsTable } from './StatsTable';

export interface StatsDashboardProps {
  stats: RunStats | null;
  error: unknown;
  loading: boolean;
  onRetry: () => void;
}

export function StatsDashboard({ stats, error, loading, onRetry }: StatsDashboardProps) {
  const partial = stats && stats.run_status !== 'completed';
  return (
    <section className="card" aria-labelledby="stats-heading">
      <div className="card__head">
        <h2 id="stats-heading">Benchmark dashboard</h2>
        {stats && (
          <span className={`chip ${partial ? 'chip--warn' : ''}`}>
            {partial ? `Partial: run ${stats.run_status}` : 'Final'}
          </span>
        )}
        {loading && <span className="muted small">updating…</span>}
      </div>
      {error ? <ErrorNotice error={error} onRetry={onRetry} compact /> : null}
      {!stats && !error && <p className="muted">Statistics appear here once trials finish.</p>}
      {stats && (
        <>
          <QuestionsAnswered stats={stats} />
          <StatsBars stats={stats} />
          <StatsTable stats={stats} />
        </>
      )}
    </section>
  );
}
