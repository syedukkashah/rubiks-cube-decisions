import type { ModelInfo, RunEvent, Trial } from '../api/types';
import { formatConfidence, formatMs, formatSeconds, INVALID_REASON_LABEL } from '../lib/format';
import { modelColor } from '../lib/modelColors';
import { trialLook } from '../lib/status';

const SHOWN = 6;

function detailOf(e: RunEvent): string {
  switch (e.type) {
    case 'run_started':
      return `${e.data.trial_count} trials`;
    case 'trial_started':
      return `${e.data.puzzle_id} · same initial facelets`;
    case 'move_requested':
      return `move ${e.data.move_index} · attempt ${e.data.attempt}`;
    case 'move_invalid':
      return `move ${e.data.move_index} · attempt ${e.data.attempt} · ${INVALID_REASON_LABEL[e.data.reason] ?? e.data.reason}${
        e.data.raw_response ? ` · raw "${e.data.raw_response.slice(0, 24)}"` : ''
      }`;
    case 'move_applied':
      return `move ${e.data.index} · ${e.data.move} · ${formatMs(e.data.latency_ms)}${
        e.data.confidence !== null ? ` · conf ${formatConfidence(e.data.confidence)}` : ''
      }${e.data.solved ? ' · solved' : ''}`;
    case 'trial_finished':
      return `status ${e.data.status} · ${e.data.moves_used} moves · ${formatSeconds(e.data.total_time_s)}`;
    case 'run_finished':
      return `run ${e.data.status}`;
    case 'error':
      return `${e.data.code}: ${e.data.message}`;
    case 'unknown':
      return '';
  }
}

export interface EventStreamProps {
  /** Newest first (RunState.recentEvents). */
  events: RunEvent[];
  trials: Record<string, Trial>;
  models: Record<string, ModelInfo>;
}

/** The last SSE events as they were applied, newest on top; older lines fade. */
export function EventStream({ events, trials, models }: EventStreamProps) {
  return (
    <section className="panel events" aria-label="Event stream">
      <div className="panel__head">
        <h2 className="eyebrow">Event stream</h2>
        <span className="muted small">Invalid outputs, retries and timeouts are logged, never coerced into moves</span>
      </div>
      <ol className="events__list">
        {events.slice(0, SHOWN).map((e, i) => {
          const trial = e.trial_id ? trials[e.trial_id] : undefined;
          const modelId = trial?.model_id ?? (e.type === 'trial_started' ? e.data.model_id : null);
          const tone =
            e.type === 'move_invalid' || e.type === 'error'
              ? 'error'
              : e.type === 'trial_finished'
                ? trialLook(e.data.status).tone
                : e.type === 'trial_started' || e.type === 'move_requested'
                  ? 'muted'
                  : 'plain';
          return (
            <li key={e.seq} className="events__row" style={{ opacity: 1 - i * 0.12 }}>
              <span className="muted">#{e.seq}</span>
              <span className={`events__type tone-text-${tone}`}>{e.type === 'unknown' ? 'unknown event' : e.type}</span>
              <span style={{ color: modelId ? modelColor(modelId) : undefined }}>{modelId ? (models[modelId]?.label ?? modelId) : 'run'}</span>
              <span className="events__detail">{detailOf(e)}</span>
            </li>
          );
        })}
        {events.length === 0 && <li className="muted small">Waiting for the first event…</li>}
      </ol>
    </section>
  );
}
