import type { BenchmarkInfo, CreateSessionRequest, ModelInfo, RunSummary } from '../api/types';
import { OneClickBenchmark } from '../components/OneClickBenchmark';
import { RunControls, type BenchmarkRequest } from '../components/RunControls';
import { formatShortTime, formatTime } from '../lib/format';
import { runLook, type Tone } from '../lib/status';

export interface SetupViewProps {
  info: BenchmarkInfo | null;
  models: ModelInfo[] | null;
  runs: RunSummary[] | null;
  lastSessionId: string | null;
  busy: 'session' | 'run' | null;
  phaseLabel: string | null;
  onStartSession: (req: CreateSessionRequest) => void;
  onStartRun: (req: BenchmarkRequest) => void;
  onOpenRun: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}

interface RunRowProps {
  id: string;
  kind: 'run' | 'session';
  tone: Tone;
  pulse?: boolean;
  meta: string;
  /** Tooltip for the meta line, e.g. with the full timestamp. */
  metaTitle?: string;
  onOpen: () => void;
}

/**
 * A previous run or session. The ID is plain text cut with an ellipsis (full ID in its tooltip, still
 * selectable and copyable) and "Open" has its own column, so the two never overlap. A click elsewhere
 * on the row opens it too; keyboard users get the Open button.
 */
function RunRow({ id, kind, tone, pulse = false, meta, metaTitle, onOpen }: RunRowProps) {
  return (
    <li
      className="run-row"
      onClick={(e) => {
        // Clicks on the ID select it for copying; the Open button handles its own clicks.
        if ((e.target as Element).closest('.run-row__id, .run-row__open')) return;
        onOpen();
      }}
    >
      <span className={`dot tone-bg-${tone} ${pulse ? 'pulse' : ''}`} aria-hidden="true" />
      <span className="run-row__text">
        <span className="run-row__id ellipsis mono strong" title={id}>
          {id}
        </span>
        <span className="ellipsis muted small" title={metaTitle ?? meta}>
          {meta}
        </span>
      </span>
      <button type="button" className="run-row__open" aria-label={`Open ${kind} ${id}`} onClick={onOpen}>
        Open
      </button>
    </li>
  );
}

/** Setup (design: Setup): the one-click benchmark first, a custom single run as the advanced path. */
export function SetupView({ info, models, runs, lastSessionId, busy, phaseLabel, onStartSession, onStartRun, onOpenRun, onOpenSession }: SetupViewProps) {
  const available = models?.filter((m) => m.available).length ?? null;
  const active = runs?.some((r) => r.status === 'queued' || r.status === 'running') ?? false;
  return (
    <div className="page page--setup">
      <div className="intro">
        <h1>Race four models on the same cube</h1>
        <p>
          Three System-1 decision models against one frontier LLM. Each picks one move at a time until the cube is solved or the move limit
          is used.
        </p>
      </div>

      <div className="setup-grid">
        <div className="setup-main">
          <div className="card">
            <OneClickBenchmark info={info} modelCount={available} busy={busy === 'session'} active={active} onStart={onStartSession} />
          </div>
          <details className="card advanced">
            <summary>
              <span className="eyebrow">Advanced · one custom run</span>
              <span className="muted small">Pick the suite, count, seed, models and limits yourself (POST /runs)</span>
            </summary>
            <RunControls models={models} busy={busy === 'run'} active={active} phaseLabel={phaseLabel} onStart={onStartRun} />
          </details>
        </div>

        <aside className="setup-aside">
          <section className="card" aria-labelledby="this-run-heading">
            <h2 id="this-run-heading" className="eyebrow">
              The plan
            </h2>
            <div className="big-number">
              <span className="mono">{info && available ? info.plan.reduce((n, p) => n + p.count, 0) * available : '—'}</span>
              <span className="muted">trials = puzzles × {available ?? '—'} models</span>
            </div>
            <div className="rule" />
            <dl className="facts">
              <div>
                <dt>Primary step</dt>
                <dd>{info?.plan.find((p) => p.step === 'primary')?.count ?? '—'} puzzles × 4 = assignment minimum</dd>
              </div>
              <div>
                <dt>Shortest solution</dt>
                <dd>
                  Exact (BFS) for <span className="nowrap">warm-up</span> and primary
                </dd>
              </div>
              <div>
                <dt>Fair play</dt>
                <dd>Same scramble, prompt, limits for every model</dd>
              </div>
            </dl>
          </section>

          <section className="card" aria-labelledby="previous-heading">
            <h2 id="previous-heading" className="eyebrow">
              Previous runs
            </h2>
            {lastSessionId && (
              <ul className="run-list" aria-label="Last one-click session">
                <RunRow
                  id={lastSessionId}
                  kind="session"
                  tone="run"
                  meta="Last one-click session in this browser"
                  onOpen={() => onOpenSession(lastSessionId)}
                />
              </ul>
            )}
            {runs?.length === 0 && !lastSessionId && <span className="muted small">No runs yet.</span>}
            {runs && runs.length > 0 && (
              <ul className="run-list" aria-label="Previous runs">
                {runs.slice(0, 12).map((r) => {
                  const look = runLook(r.status);
                  return (
                    <RunRow
                      key={r.run_id}
                      id={r.run_id}
                      kind="run"
                      tone={look.tone}
                      pulse={look.pulse}
                      meta={`${look.label} · ${formatShortTime(r.created_at)}`}
                      metaTitle={`${look.label} · ${formatTime(r.created_at)}`}
                      onOpen={() => onOpenRun(r.run_id)}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
