import type { RunStatus, Trial } from '../api/types';
import { trialLook } from '../lib/status';

/** One segment per trial in run order, coloured by Trial.status (with a text total beside it). */
export function TrialBar({ trials, total, runStatus }: { trials: Trial[]; total: number; runStatus: RunStatus | null }) {
  const done = trials.filter((t) => t.status === 'solved' || t.status === 'move_limit' || t.status === 'error').length;
  const segments = Array.from({ length: Math.max(total, trials.length) }, (_, i) => trials[i] ?? null);
  return (
    <div className="trialbar">
      <div className="trialbar__text">
        <span>Trials</span>
        <span className="mono">
          {done} / {total || '—'}
        </span>
      </div>
      <div className="trialbar__segs" role="img" aria-label={`${done} of ${total} trials finished`}>
        {segments.map((t, i) => {
          const look = t ? trialLook(t.status, runStatus) : null;
          return (
            <span
              key={t?.trial_id ?? i}
              className={`seg-cell ${look ? `tone-${look.tone}` : ''} ${look?.pulse ? 'pulse' : ''}`}
              title={t ? `${t.puzzle_id} · ${t.model_id}: ${look?.label}` : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
