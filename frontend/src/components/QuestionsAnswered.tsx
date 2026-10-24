import type { ModelStats, RunStats } from '../api/types';
import { formatGap, formatMs, formatPct } from '../lib/format';
import { modelColor } from '../lib/modelColors';

/** The assignment's questions, answered from the backend's questions_answered (AGENTS.md 5.8). */
export function QuestionsAnswered({ stats, size = 'normal' }: { stats: RunStats; size?: 'normal' | 'slide' }) {
  const q = stats.questions_answered;
  const byId = (id: string | null): ModelStats | null => (id ? (stats.models.find((m) => m.model_id === id) ?? null) : null);
  const fastest = byId(q.fastest_model_id);
  const top = byId(q.highest_solve_rate_model_id);
  const best = byId(q.best_optimality_gap_model_id);
  const slide = size === 'slide';
  const verdict = q.fastest_is_also_best_quality;

  return (
    <div className={`answers answers--${size}`}>
      <Answer
        label={slide ? 'Fastest decisions' : 'Q1 · Fastest at making decisions'}
        model={fastest}
        value={fastest ? `${formatMs(fastest.avg_move_latency_ms)} per move on average` : null}
      />
      <Answer
        label={slide ? 'Highest solve rate' : 'Q2 · Highest solve rate'}
        model={top}
        value={top ? `${formatPct(top.success_rate_pct)} (${top.solved_trials}/${top.trials} solved)` : null}
      />
      <Answer
        label={slide ? 'Shortest solutions' : 'Q3 · Shortest solutions (closest to optimum)'}
        model={best}
        value={best ? `avg gap ${formatGap(best.avg_optimality_gap)}` : null}
      />
      <article className="answer">
        <span className="answer__q">{slide ? 'Fastest = best quality?' : 'Q4 · Did the fastest model also achieve the best quality?'}</span>
        <span className={`answer__a ${verdict === false ? 'tone-text-limit' : verdict ? 'tone-text-solved' : 'muted'}`}>
          {verdict === null ? 'Not determined yet' : verdict ? 'Yes' : 'No'}
        </span>
        <span className="answer__v">
          {verdict === null
            ? ' '
            : verdict
              ? 'The fastest model also has the top solve rate and the lowest gap'
              : 'Speed and solution quality came from different models'}
        </span>
      </article>
      {!slide && (
        <article className="answer answer--open">
          <span className="answer__q">Q5 · What would you deploy?</span>
          <span className="answer__a">Your conclusion</span>
          <span className="answer__v muted">Fast model, frontier LLM or a hybrid, argued from the evidence above in the written analysis</span>
        </article>
      )}
    </div>
  );
}

function Answer({ label, model, value }: { label: string; model: ModelStats | null; value: string | null }) {
  return (
    <article className="answer">
      <span className="answer__q">{label}</span>
      <span className="answer__a" style={model ? { color: modelColor(model.model_id) } : undefined}>
        {model ? model.label : <span className="muted">Not determined yet</span>}
      </span>
      <span className="answer__v">{value ?? ' '}</span>
    </article>
  );
}
