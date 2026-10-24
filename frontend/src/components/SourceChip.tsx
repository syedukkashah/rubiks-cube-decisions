import type { BenchmarkSession } from '../api/types';
import { formatTime } from '../lib/format';

/** Where a session's moves come from (5.10). A replay is never presented as live. */
export function SourceChip({ session, size = 'md' }: { session: BenchmarkSession; size?: 'md' | 'lg' }) {
  const speed = session.source !== 'live' && session.speed !== 1 ? ` · ${session.speed}×` : '';
  if (session.source === 'replay') {
    return (
      <span className={`source source--replay source--${size}`} data-testid="source-chip">
        <span className="source__dot" aria-hidden="true" />
        Replay of live recording{session.recorded_at ? ` · ${formatTime(session.recorded_at)}` : ''}
        {speed}
      </span>
    );
  }
  if (session.source === 'live') {
    return (
      <span className={`source source--live source--${size}`} data-testid="source-chip">
        <span className="source__dot" aria-hidden="true" />
        Live · OpenRouter
      </span>
    );
  }
  return (
    <span className={`source source--simulated source--${size}`} data-testid="source-chip">
      <span className="source__dot" aria-hidden="true" />
      Simulated · no OpenRouter calls{speed}
    </span>
  );
}
