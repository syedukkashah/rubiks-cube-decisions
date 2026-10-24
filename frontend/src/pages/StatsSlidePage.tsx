import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/ApiContext';
import { isTerminalRun, type ModelStats, type RunStats, type RunSummary, type Suite } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { IdentityBadge } from '../components/IdentityBadge';
import { QuestionsAnswered } from '../components/QuestionsAnswered';
import { config as appConfig } from '../config';
import { STEP_NAME } from '../lib/status';
import { formatGap, formatMs, formatPct, formatSeconds, formatTime } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import { useAsync } from '../state/useAsync';
import { sessionResultsRunId } from '../state/useSession';

const SUITE_LABEL: Record<Suite, string> = { warmup: 'warm-up', primary: 'primary', extension: 'extension' };
const REFRESH_MS = 4000;
const STAGE = { width: 1920, height: 1080 } as const;

/** Newest completed run, else the newest run (GET /runs is newest first). */
const pickRun = (runs: RunSummary[] | null): string | null =>
  runs?.find((r) => r.status === 'completed')?.run_id ?? runs?.[0]?.run_id ?? null;

interface Column {
  title: string;
  value: (m: ModelStats) => number | null;
  format: (v: number | null) => string;
  /** The backend's winner for this column (questions_answered), if it names one. */
  winner?: (s: RunStats) => string | null;
}

const COLUMNS: Column[] = [
  { title: 'Avg latency / move', value: (m) => m.avg_move_latency_ms, format: formatMs, winner: (s) => s.questions_answered.fastest_model_id },
  { title: 'Total solve time', value: (m) => m.avg_total_time_s, format: formatSeconds },
  { title: 'Total moves', value: (m) => m.total_moves, format: (v) => (v === null ? '—' : String(v)) },
  { title: 'Success rate', value: (m) => m.success_rate_pct, format: formatPct, winner: (s) => s.questions_answered.highest_solve_rate_model_id },
  {
    title: 'Optimality gap',
    value: (m) => m.avg_optimality_gap,
    format: (v) => (v === 0 ? '0.00' : formatGap(v)),
    winner: (s) => s.questions_answered.best_optimality_gap_model_id,
  },
];

/** Scale factor that fits the fixed 1920×1080 stage into the viewport. */
function useStageScale(): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / STAGE.width, window.innerHeight / STAGE.height) || 1);
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

/** Full-screen, presentation-ready benchmark slide for the end of the recording (AGENTS.md 9 item 7). */
export function StatsSlidePage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const explicit = params.get('run');
  const sessionId = params.get('session');
  const session = useAsync(sessionId ? () => api.getSession(sessionId) : null, [api, sessionId]);
  const runs = useAsync(explicit || sessionId ? null : () => api.listRuns(), [api, explicit, sessionId]);
  const runId = explicit ?? (session.data ? sessionResultsRunId(session.data) : null) ?? pickRun(runs.data);

  const snapshot = useAsync(runId ? () => api.getRun(runId) : null, [api, runId]);
  const stats = useAsync(runId ? () => api.getStats(runId) : null, [api, runId]);
  const puzzles = useAsync(runId ? () => api.listPuzzles() : null, [api, runId]);
  const scale = useStageScale();

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
  const src = session.data?.source ?? null;
  const backHref = `/?${new URLSearchParams([...(sessionId ? [['session', sessionId]] : []), ...(runId ? [['run', runId]] : [])]).toString()}`;
  const trials = config ? config.puzzle_ids.length * config.model_ids.length : 0;

  return (
    <div className="slide-viewport">
      <div className="slide-toolbar">
        <Link to={backHref} className="btn btn--ghost btn--sm">
          ← Back
        </Link>
        {session.data && (
          <div className="seg" role="group" aria-label="Session step">
            {session.data.runs
              .filter((r) => r.status !== 'skipped')
              .map((r) => (
                <button
                  key={r.run_id}
                  type="button"
                  aria-pressed={r.run_id === runId}
                  onClick={() => setParams({ ...(sessionId ? { session: sessionId } : {}), run: r.run_id })}
                >
                  {STEP_NAME[r.step]}
                </button>
              ))}
          </div>
        )}
      </div>
      <div className="slide" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <header className="slide__top">
          <div className="slide__titles">
            <span className="slide__kicker">
              <svg width="26" height="26" viewBox="0 0 22 22" aria-hidden="true">
                <rect x="0" y="0" width="10" height="10" rx="2" fill="#E0393E" />
                <rect x="12" y="0" width="10" height="10" rx="2" fill="#F2F3F5" />
                <rect x="0" y="12" width="10" height="10" rx="2" fill="#2D6BDF" />
                <rect x="12" y="12" width="10" height="10" rx="2" fill="#22A95B" />
              </svg>
              RUBIK'S CUBE RACE · BENCHMARK RESULTS
            </span>
            <h1>Fast decisions vs. frontier planning</h1>
            {config && (
              <p className="slide__meta">
                {runId} · {config.puzzle_ids.length} {suites.map((x) => SUITE_LABEL[x]).join(' + ')} puzzle{config.puzzle_ids.length === 1 ? '' : 's'} ×{' '}
                {config.model_ids.length} models = {trials} trials · max {config.max_moves} moves · HTM · same scramble, prompt, {config.timeout_s} s
                timeout and {config.max_retries} {config.max_retries === 1 ? 'retry' : 'retries'} for every model
              </p>
            )}
          </div>
          <IdentityBadge name={appConfig.studentName} roll={appConfig.studentRoll} variant="slide" />
        </header>

        {!runId && !runs.loading && !runs.error && !session.loading && <p className="slide__empty">No benchmark runs yet. Run one first.</p>}
        {runs.error ? <ErrorNotice error={runs.error} onRetry={runs.reload} /> : null}
        {stats.error ? <ErrorNotice error={stats.error} onRetry={stats.reload} /> : null}

        {s && (
          <>
            {s.run_status !== 'completed' && (
              <p className="slide__partial" role="status">
                Run {s.run_status}: figures are partial
              </p>
            )}
            <div className="slide__table-wrap">
              <table className="slide__table" aria-label="Benchmark statistics per model">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    {COLUMNS.map((c) => (
                      <th scope="col" key={c.title}>
                        {c.title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.models.map((m) => (
                    <tr key={m.model_id}>
                      <th scope="row">
                        <span className="slide__model">
                          <span className="slide__swatch" style={{ background: modelColor(m.model_id) }} aria-hidden="true" />
                          <span>
                            <span className="slide__model-name">{m.label}</span>
                            <span className="slide__model-sub">
                              {m.category === 'frontier' ? 'Frontier LLM · Chat completions' : 'System-1 · Decisions API'}
                            </span>
                          </span>
                        </span>
                      </th>
                      {COLUMNS.map((c) => {
                        const win = c.winner?.(s) === m.model_id;
                        return (
                          <td key={c.title}>
                            <span className={win ? 'slide__win' : undefined}>{c.format(c.value(m))}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <QuestionsAnswered stats={s} size="slide" />
          </>
        )}

        <footer className="slide__footer">
          <span>
            Source: GET /runs/{runId ?? '{id}'}/stats · all metrics computed by the backend
            {src === 'replay' && session.data?.recorded_at ? ` · replay of the live recording from ${formatTime(session.data.recorded_at)}` : ''}
            {src === 'simulated' ? ' · simulated session (no OpenRouter calls)' : ''}
          </span>
          <span>Optimality gap = model moves − exact BFS shortest moves</span>
        </footer>
      </div>
    </div>
  );
}
