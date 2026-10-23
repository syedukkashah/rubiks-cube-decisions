import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/ApiContext';
import { isTerminalRun, type ModelStats, type RunSummary, type Suite } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { QuestionsAnswered } from '../components/QuestionsAnswered';
import { formatGap, formatMs, formatPct, formatSeconds, formatTime } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import { useAsync } from '../state/useAsync';

const SUITE_LABEL: Record<Suite, string> = { warmup: 'warm-up', primary: 'primary', extension: 'extension' };
const REFRESH_MS = 4000;

/** Newest completed run, else the newest run (GET /runs is newest first). */
const pickRun = (runs: RunSummary[] | null): string | null =>
  runs?.find((r) => r.status === 'completed')?.run_id ?? runs?.[0]?.run_id ?? null;

interface Column {
  title: string;
  sub: string;
  value: (m: ModelStats) => number | null;
  format: (v: number | null) => string;
  /** Fixed scale max for the in-cell bar; otherwise scaled to the column's largest value. */
  max?: number;
}

const COLUMNS: Column[] = [
  { title: 'Avg latency', sub: 'per move', value: (m) => m.avg_move_latency_ms, format: formatMs },
  { title: 'Total solve time', sub: 'avg per trial', value: (m) => m.avg_total_time_s, format: formatSeconds },
  { title: 'Total moves', sub: 'all trials', value: (m) => m.total_moves, format: (v) => (v === null ? '—' : String(v)) },
  { title: 'Success rate', sub: 'solved ≤ move limit', value: (m) => m.success_rate_pct, format: formatPct, max: 100 },
  { title: 'Optimality gap', sub: 'avg, 0 = optimal', value: (m) => m.avg_optimality_gap, format: formatGap },
];

/** Full-screen, presentation-ready benchmark slide for the end of the recording (AGENTS.md 9 item 7). */
export function StatsSlidePage() {
  const api = useApi();
  const [params] = useSearchParams();
  const explicit = params.get('run');
  const runs = useAsync(explicit ? null : () => api.listRuns(), [api, explicit]);
  const runId = explicit ?? pickRun(runs.data);

  const snapshot = useAsync(runId ? () => api.getRun(runId) : null, [api, runId]);
  const stats = useAsync(runId ? () => api.getStats(runId) : null, [api, runId]);
  const puzzles = useAsync(runId ? () => api.listPuzzles() : null, [api, runId]);

  // Keep a slide opened mid-run current until the run ends.
  const running = stats.data ? !isTerminalRun(stats.data.run_status) : false;
  const { reload: reloadStats } = stats;
  const { reload: reloadSnapshot } = snapshot;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      reloadStats();
      reloadSnapshot();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [running, reloadStats, reloadSnapshot]);

  const config = snapshot.data?.config ?? null;
  const suites = useMemo(() => {
    if (!config || !puzzles.data) return [];
    const set = new Set<Suite>();
    for (const p of puzzles.data) if (config.puzzle_ids.includes(p.puzzle_id)) set.add(p.suite);
    return [...set];
  }, [config, puzzles.data]);

  const s = stats.data && stats.data.run_id === runId ? stats.data : null;
  const maxes = useMemo(
    () =>
      COLUMNS.map((c) => c.max ?? Math.max(0, ...(s?.models ?? []).map((m) => c.value(m) ?? 0))),
    [s],
  );

  return (
    <div className="slide">
      <Link to={runId ? `/?run=${encodeURIComponent(runId)}` : '/'} className="slide__back">
        ← Benchmark
      </Link>
      <header className="slide__header">
        <p className="slide__kicker">AI Engineering · Assignment 02</p>
        <h1>Rubik’s Cube Race: benchmark results</h1>
        <p className="slide__question">
          Is a model that decides in milliseconds more useful than a frontier LLM that plans longer but may need fewer moves?
        </p>
        {config && (
          <p className="slide__meta">
            {config.puzzle_ids.length} {suites.map((x) => SUITE_LABEL[x]).join(' + ')} puzzle{config.puzzle_ids.length === 1 ? '' : 's'} ×{' '}
            {config.model_ids.length} models · max {config.max_moves} moves · same scramble, engine, timeout ({config.timeout_s} s)
            and retries ({config.max_retries}) for every model
          </p>
        )}
      </header>

      {!runId && !runs.loading && !runs.error && <p className="slide__empty">No benchmark runs yet. Run one first.</p>}
      {runs.error ? <ErrorNotice error={runs.error} onRetry={runs.reload} /> : null}
      {stats.error ? <ErrorNotice error={stats.error} onRetry={stats.reload} /> : null}

      {s && (
        <>
          {s.run_status !== 'completed' && (
            <p className="slide__partial" role="status">
              Run {s.run_status}: figures are partial
            </p>
          )}
          <table className="slide__table" aria-label="Benchmark statistics per model">
            <thead>
              <tr>
                <th scope="col">Model</th>
                {COLUMNS.map((c) => (
                  <th scope="col" key={c.title} className="num">
                    {c.title}
                    <span>{c.sub}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.models.map((m) => (
                <tr key={m.model_id}>
                  <th scope="row">
                    <span className="slide__rowhead">
                      <span className="swatch swatch--lg" style={{ background: modelColor(m.model_id) }} aria-hidden="true" />
                      <span className="slide__model">
                        {m.label}
                        <span>{m.category === 'frontier' ? 'Frontier LLM' : 'System-1 decision model'}</span>
                      </span>
                    </span>
                  </th>
                  {COLUMNS.map((c, i) => {
                    const v = c.value(m);
                    const max = maxes[i] ?? 0;
                    return (
                      <td key={c.title} className="num">
                        <span className="slide__value">{c.format(v)}</span>
                        <span className="slide__bar" aria-hidden="true">
                          <span
                            style={{
                              width: v === null || v <= 0 || max <= 0 ? 0 : `${Math.max(2, (v / max) * 100)}%`,
                              background: modelColor(m.model_id),
                            }}
                          />
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <QuestionsAnswered stats={s} size="large" />
        </>
      )}

      <footer className="slide__footer">
        <span>{runId ?? '—'}</span>
        <span>{formatTime(snapshot.data?.finished_at ?? snapshot.data?.created_at)}</span>
        <span>Figures from the backend’s GET /runs/{'{id}'}/stats</span>
      </footer>
    </div>
  );
}
