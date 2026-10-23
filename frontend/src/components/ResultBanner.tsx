import { isTerminalRun, type RunStatus, type TrialError, type TrialStatus } from '../api/types';

// Trial outcome exactly as the backend reports it in Trial.status (AGENTS.md 5.6).
// Status color always ships with an icon and a label, never color alone.

interface Look {
  tone: 'good' | 'serious' | 'critical' | 'active' | 'idle';
  icon: string;
  label: string;
}

function resultLook(status: TrialStatus, runStatus: RunStatus | null = null): Look {
  switch (status) {
    case 'solved':
      return { tone: 'good', icon: '✓', label: 'Solved' };
    case 'move_limit':
      return { tone: 'serious', icon: '■', label: 'Move limit reached' };
    case 'error':
      return { tone: 'critical', icon: '!', label: 'Error' };
    case 'running':
      if (runStatus && isTerminalRun(runStatus)) return { tone: 'idle', icon: '–', label: `Stopped (run ${runStatus})` };
      return { tone: 'active', icon: '●', label: 'Playing…' };
    case 'pending':
      if (runStatus && isTerminalRun(runStatus)) return { tone: 'idle', icon: '–', label: `Not started (run ${runStatus})` };
      return { tone: 'idle', icon: '○', label: 'Queued' };
  }
}

export interface ResultBannerProps {
  status: TrialStatus;
  runStatus?: RunStatus | null;
  error?: TrialError | null;
  /** `banner` = full-width lane result, `chip` = compact cell badge. */
  variant?: 'banner' | 'chip';
  detail?: string | null;
}

export function ResultBanner({ status, runStatus = null, error = null, variant = 'banner', detail = null }: ResultBannerProps) {
  const look = resultLook(status, runStatus);
  const errorText = status === 'error' && error ? `${error.code}: ${error.message}` : null;
  return (
    <div
      className={`result result--${variant} result--${look.tone}`}
      role="status"
      data-status={status}
      title={errorText ?? undefined}
    >
      <span className="result__icon" aria-hidden="true">
        {look.icon}
      </span>
      <span className="result__label">{look.label}</span>
      {variant === 'banner' && (detail || errorText) && <span className="result__detail">{errorText ?? detail}</span>}
    </div>
  );
}
