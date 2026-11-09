import type { BenchmarkSession } from '../api/types';
import { formatShortTime, formatTime } from '../lib/format';

/** Where a session's moves come from (5.10). A replay is never presented as live. */
export function SourceChip({ session, size = 'md' }: { session: BenchmarkSession; size?: 'md' | 'lg' }) {
  const speed = session.source !== 'live' && session.speed !== 1 ? ` · ${session.speed}×` : '';
  if (session.source === 'replay') {
    // Compact date in the chip; the tooltip keeps the full recording time.
    const at = (format: (ts: string) => string) => (session.recorded_at ? ` · ${format(session.recorded_at)}` : '');
    return (
      <span className={`source source--replay source--${size}`} data-testid="source-chip" title={`Replay of live recording${at(formatTime)}${speed}`}>
        <span className="source__dot" aria-hidden="true" />
        <span className="ellipsis">
          Replay of live recording{at((ts) => formatShortTime(ts))}
          {speed}
        </span>
      </span>
    );
  }
  if (session.source === 'live') {
    return (
      <span className={`source source--live source--${size}`} data-testid="source-chip" title="Live · OpenRouter">
        <span className="source__dot" aria-hidden="true" />
        <span className="ellipsis">Live · OpenRouter</span>
      </span>
    );
  }
  return (
    <span className={`source source--simulated source--${size}`} data-testid="source-chip" title={`Simulated · no OpenRouter calls${speed}`}>
      <span className="source__dot" aria-hidden="true" />
      <span className="ellipsis">Simulated · no OpenRouter calls{speed}</span>
    </span>
  );
}
