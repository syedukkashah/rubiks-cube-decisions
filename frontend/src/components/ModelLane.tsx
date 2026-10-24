import type { ReactNode } from 'react';
import { isTerminalRun, isTerminalTrial, type ModelInfo, type ModelStats, type RunStatus, type Trial } from '../api/types';
import { formatConfidence, formatGap, formatMs, formatSeconds, INVALID_REASON_LABEL } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import { trialLook } from '../lib/status';
import type { InvalidOutput, TrialLive } from '../state/runReducer';
import { invalidForNextMove } from '../state/selectors';
import { CubeNet } from './CubeNet';

export interface ModelLaneProps {
  modelId: string;
  model: ModelInfo | null;
  trial: Trial | null;
  live: TrialLive | null;
  runStatus: RunStatus | null;
  maxMoves: number | null;
  timeoutS: number | null;
  maxRetries: number | null;
  /** This model's partial or final GET /runs/{id}/stats entry (source of "avg / move"). */
  stats: ModelStats | null;
  /** Display clock (ms) for the trial timer and timeout gauge. */
  now: number;
}

const CATEGORY_LABEL = { decision: 'System-1 decision', frontier: 'Frontier LLM' } as const;
const CHIPS_SHOWN = 9;

type Chip =
  | { kind: 'move'; key: string; order: number; n: number; label: string; title: string }
  | { kind: 'invalid'; key: string; order: number; label: string; title: string };

/** Applied moves plus rejected outputs, each rejected output slotted before the move it preceded. */
function chipsOf(trial: Trial, invalid: InvalidOutput[]): Chip[] {
  return [
    ...trial.moves.map(
      (m): Chip => ({ kind: 'move', key: `m${m.index}`, order: m.index, n: m.index, label: m.move, title: `Move ${m.index} · ${formatMs(m.latency_ms)}` }),
    ),
    ...invalid.map(
      (i): Chip => ({
        kind: 'invalid',
        key: `i${i.seq}`,
        order: i.move_index - 0.5 + i.attempt / 1000,
        label: i.raw_response ? i.raw_response.slice(0, 8) : i.reason === 'timeout' ? 'timeout' : '—',
        title: `Invalid output (${INVALID_REASON_LABEL[i.reason] ?? i.reason}): logged, not applied`,
      }),
    ),
  ].sort((a, b) => a.order - b.order);
}

const secondsSince = (ts: string | null, now: number): number | null => {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 1000);
};

/** One model playing: current cube and move, live metrics, move chips and a fixed-height status row. */
export function ModelLane({ modelId, model, trial, live, runStatus, maxMoves, timeoutS, maxRetries, stats, now }: ModelLaneProps) {
  const label = model?.label ?? modelId;
  const color = modelColor(modelId);
  const runOver = runStatus !== null && isTerminalRun(runStatus);
  const awaiting = trial?.status === 'running' && !runOver ? (live?.awaiting ?? null) : null;
  const look = trial ? trialLook(trial.status, runStatus, (awaiting?.attempt ?? 1) > 1) : null;
  const terminal = trial ? isTerminalTrial(trial.status) : false;

  return (
    <section
      className={`lane ${terminal && look ? `lane--${look.tone}` : ''}`}
      aria-label={`${label} lane`}
      data-model={modelId}
      style={{ ['--model' as string]: color }}
    >
      <header className="lane__head">
        <span className="lane__swatch" aria-hidden="true" />
        <div className="lane__title">
          <h3>{label}</h3>
          <span className="lane__sub">
            {model ? CATEGORY_LABEL[model.category] : 'Model'} · {model?.interface === 'chat_completions' ? 'Chat completions' : 'Decisions API'}
          </span>
        </div>
        {look && (
          <span className={`pill tone-${look.tone}`} data-testid="lane-status">
            <span className={`pill__dot ${look.pulse ? 'pulse' : ''}`} aria-hidden="true" />
            {look.label}
          </span>
        )}
      </header>

      {!trial ? (
        <div className="lane__empty">No trial for this model on this puzzle.</div>
      ) : (
        <LaneBody
          trial={trial}
          live={live}
          label={label}
          model={model}
          maxMoves={maxMoves}
          timeoutS={timeoutS}
          maxRetries={maxRetries}
          stats={stats}
          now={now}
          awaiting={awaiting}
          runStatus={runStatus}
        />
      )}
    </section>
  );
}

function LaneBody({
  trial,
  live,
  label,
  model,
  maxMoves,
  timeoutS,
  maxRetries,
  stats,
  now,
  awaiting,
  runStatus,
}: Omit<ModelLaneProps, 'modelId' | 'trial'> & { trial: Trial; label: string; awaiting: TrialLive['awaiting'] }) {
  const lastMove = trial.moves.at(-1) ?? null;
  const used = trial.moves_used;
  const limit = maxMoves ?? 30;
  const chips = chipsOf(trial, live?.invalid ?? []);
  const shown = chips.slice(-CHIPS_SHOWN);
  const hidden = chips.length - shown.length;
  const terminal = isTerminalTrial(trial.status);
  const trialSeconds = terminal ? trial.total_time_s : trial.status === 'running' ? secondsSince(trial.started_at, now) : null;
  const confidence = lastMove?.confidence ?? null;
  const optimum = trial.optimal_distance;

  return (
    <>
      <div className="lane__stage">
        <CubeNet facelets={trial.current_facelets} highlightFace={lastMove?.move[0] ?? null} size={190} label={`${label} cube after ${used} moves`} />
        <div className="lane__now">
          <div className="lane__move-row">
            <span className="lane__move-label">Current move</span>
            <span key={`${trial.trial_id}-${used}`} className={`lane__glyph pop ${lastMove ? '' : 'is-empty'}`} aria-live="polite">
              {lastMove ? lastMove.move : '—'}
            </span>
            <span className="lane__caption mono">{terminal ? `${used} moves` : `next: move ${used + 1}`}</span>
          </div>
          <dl className="lane__metrics">
            <div>
              <dt>Last call</dt>
              <dd>{formatMs(lastMove?.latency_ms)}</dd>
            </div>
            <div>
              <dt>Avg / move</dt>
              <dd title="From GET /runs/{id}/stats">{formatMs(stats?.avg_move_latency_ms)}</dd>
            </div>
            <div>
              <dt>Trial time</dt>
              <dd>{formatSeconds(trialSeconds)}</dd>
            </div>
            <div>
              <dt>Confidence</dt>
              <dd>{confidence !== null ? formatConfidence(confidence) : model?.category === 'frontier' ? 'not supplied' : '—'}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="lane__used">
        <div className="lane__used-text">
          <span>Moves used</span>
          <span className="mono">
            {used} / {limit}
          </span>
        </div>
        <div className="usedbar" aria-label={`Moves used ${used} of ${limit}`}>
          <div className="usedbar__fill bar" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
          {optimum !== null && optimum <= limit && (
            <span className="usedbar__tick" style={{ left: `${(optimum / limit) * 100}%` }} title={`BFS optimum: ${optimum} moves`} />
          )}
        </div>
        <div className="usedbar__labels">
          {optimum !== null && optimum <= limit && <span style={{ left: `${(optimum / limit) * 100}%` }}>opt {optimum}</span>}
        </div>
      </div>

      <div className="chips" aria-label="Move history">
        {hidden > 0 && <span className="chips__more">+{hidden}</span>}
        {shown.map((c, i) =>
          c.kind === 'move' ? (
            <span key={c.key} className={`chip-move ${i === shown.length - 1 ? 'is-latest' : ''}`} title={c.title}>
              <span className="chip-move__n">{c.n}</span>
              {c.label}
            </span>
          ) : (
            <span key={c.key} className="chip-move chip-move--invalid" title={c.title}>
              {c.label}
            </span>
          ),
        )}
        {chips.length === 0 && <span className="muted small">No moves yet</span>}
      </div>

      <div className="lane__status">
        <StatusRow trial={trial} live={live} awaiting={awaiting} runStatus={runStatus} timeoutS={timeoutS} maxRetries={maxRetries} limit={limit} now={now} />
      </div>
    </>
  );
}

function StatusRow({
  trial,
  live,
  awaiting,
  runStatus,
  timeoutS,
  maxRetries,
  limit,
  now,
}: {
  trial: Trial;
  live: TrialLive | null;
  awaiting: TrialLive['awaiting'];
  runStatus: RunStatus | null;
  timeoutS: number | null;
  maxRetries: number | null;
  limit: number;
  now: number;
}) {
  const time = formatSeconds(trial.total_time_s);
  switch (trial.status) {
    case 'solved':
      return (
        <Verdict status="solved" title={`Solved in ${trial.moves_used} moves`}>
          {trial.optimal_distance !== null
            ? `Optimum ${trial.optimal_distance} · gap ${formatGap(trial.optimality_gap)} · ${time}`
            : `No optimum computed for this suite · ${time}`}
        </Verdict>
      );
    case 'move_limit':
      return (
        <Verdict status="move_limit" title="Move limit reached">
          {trial.moves_used} / {limit} valid moves · cube not solved · {time}
        </Verdict>
      );
    case 'error':
      return (
        <Verdict status="error" title="Error · retries exhausted" hint={trial.error?.message}>
          {trial.error?.code ?? 'error'} on move {trial.moves_used + 1} · {trial.timeout_count} timeouts · {time}
        </Verdict>
      );
    default:
      break;
  }
  if (runStatus && isTerminalRun(runStatus)) {
    return (
      <div className="waitrow muted" role="status" data-status={trial.status}>
        {trial.status === 'running' ? `Stopped: run ${runStatus}` : `Not started: run ${runStatus}`}
      </div>
    );
  }
  if (trial.status === 'pending') {
    return (
      <div className="waitrow muted" role="status" data-status="pending">
        Queued · trials run one at a time
      </div>
    );
  }
  const attempts = (maxRetries ?? 0) + 1;
  const elapsed = awaiting ? secondsSince(awaiting.ts, now) : null;
  const limitS = timeoutS ?? null;
  const frac = elapsed !== null && limitS ? Math.min(1, elapsed / limitS) : 0;
  const lastInvalid = live && invalidForNextMove(live.invalid, trial).at(-1);
  const labelText = !awaiting
    ? 'Applying the last move…'
    : awaiting.attempt > 1
      ? `Retry · attempt ${awaiting.attempt} of ${attempts}${lastInvalid ? ` after ${INVALID_REASON_LABEL[lastInvalid.reason]?.toLowerCase() ?? lastInvalid.reason}` : ''}`
      : `Waiting for move ${awaiting.move_index} · attempt 1 of ${attempts}`;
  return (
    <div className="waitrow" role="status" data-status="running">
      <div className="waitrow__text">
        <span>{labelText}</span>
        {elapsed !== null && (
          <span className="mono">
            {elapsed.toFixed(1)} s{limitS ? ` / ${limitS} s` : ''}
          </span>
        )}
      </div>
      <div className="gauge">
        <div className={`gauge__fill ${frac > 2 / 3 ? 'is-late' : ''}`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

const VERDICT_ICON = {
  solved: <path d="M7.5 12.5l3 3 6-6.5" />,
  move_limit: <path d="M12 10v4.5M12 17.5v.01" />,
  error: <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />,
};

function Verdict({ status, title, hint, children }: { status: 'solved' | 'move_limit' | 'error'; title: string; hint?: string; children: ReactNode }) {
  const tone = status === 'solved' ? 'solved' : status === 'move_limit' ? 'limit' : 'error';
  return (
    <div className={`verdict pop tone-${tone}`} role="status" data-status={status} title={hint}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {status === 'move_limit' ? <path d="M12 3l9.5 17h-19z" /> : <circle cx="12" cy="12" r="10" />}
        {VERDICT_ICON[status]}
      </svg>
      <div>
        <span className="verdict__title">{title}</span>
        <span className="verdict__detail">{children}</span>
      </div>
    </div>
  );
}
