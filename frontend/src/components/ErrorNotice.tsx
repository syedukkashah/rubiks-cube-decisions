import { describeError } from '../api/errors';

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

/** Visible, specific message for any contract error envelope (AGENTS.md 5.2, 9 rule 6). */
export function ErrorNotice({
  error,
  onRetry,
  action,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  /** e.g. "Open that run" for a 409 that names one (6.1 G12, 5.10). */
  action?: NoticeAction | null;
  compact?: boolean;
}) {
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
      {action && (
        <button type="button" className="btn btn--secondary btn--sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onRetry && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
