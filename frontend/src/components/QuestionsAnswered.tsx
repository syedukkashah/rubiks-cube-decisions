import type { ModelStats, RunStats } from '../api/types';
import { formatGap, formatMs, formatPct } from '../lib/format';
import { modelColor } from '../lib/modelColors';

/** The assignment's questions, answered from the backend's questions_answered (AGENTS.md 5.8). */
export function QuestionsAnswered({ stats, size = 'normal' }: { stats: RunStats; size?: 'normal' | 'large' }) {
  const q = stats.questions_answered;
  const byId = (id: string | null): ModelStats | null => (id ? (stats.models.find((m) => m.model_id === id) ?? null) : null);
  const fastest = byId(q.fastest_model_id);
  const top = byId(q.highest_solve_rate_model_id);
  const best = byId(q.best_optimality_gap_model_id);

  return (
    <div className={`answers answers--${size}`}>
      <Answer n={1} question="Fastest at making decisions" model={fastest} value={fastest ? `${formatMs(fastest.avg_move_latency_ms)} per move` : null} />
      <Answer
        n={2}
        question="Highest solve rate"
        model={top}
        value={top ? `${formatPct(top.success_rate_pct)} (${top.solved_trials}/${top.trials} solved)` : null}
      />
      <Answer
        n={3}
        question="Shortest solutions (closest to optimum)"
        model={best}
        value={best ? `avg gap ${formatGap(best.avg_optimality_gap)}` : null}
      />
      <div className="answer">
        <span className="answer__q">
          <span className="answer__n">Q4</span> Did the fastest model also achieve the best quality?
        </span>
        <span className="answer__a">
          {q.fastest_is_also_best_quality === null ? (
            <span className="muted">Not determined yet</span>
          ) : q.fastest_is_also_best_quality ? (
            <strong>Yes</strong>
          ) : (
            <strong>No</strong>
          )}
        </span>
        <span className="answer__v muted">
          {q.fastest_is_also_best_quality === null
            ? ' '
            : q.fastest_is_also_best_quality
              ? 'Fastest model also has the top solve rate and lowest gap'
              : 'Speed and solution quality came from different models'}
        </span>
      </div>
    </div>
  );
}

function Answer({ n, question, model, value }: { n: number; question: string; model: ModelStats | null; value: string | null }) {
  return (
    <div className="answer">
      <span className="answer__q">
        <span className="answer__n">Q{n}</span> {question}
      </span>
      <span className="answer__a">
        {model ? (
          <>
            <span className="swatch" style={{ background: modelColor(model.model_id) }} aria-hidden="true" />
            <strong>{model.label}</strong>
          </>
        ) : (
          <span className="muted">Not determined yet</span>
        )}
      </span>
      <span className="answer__v muted">{value ?? ' '}</span>
    </div>
  );
}
