import { describeError } from '../api/errors';

/** Visible, specific message for any contract error envelope (AGENTS.md 5.2, 9 rule 6). */
export function ErrorNotice({ error, onRetry, compact = false }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const d = describeError(error);
  return (
    <div className={`notice notice--error ${compact ? 'notice--compact' : ''}`} role="alert">
      <span className="notice__icon" aria-hidden="true">
        !
      </span>
      <div className="notice__body">
        <strong>{d.title}</strong>
        {d.message && <span className="notice__message">{d.message}</span>}
        {d.guidance && <span className="notice__guidance">{d.guidance}</span>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
