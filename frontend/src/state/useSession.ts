import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api/ApiContext';
import { isTerminalRun, type BenchmarkSession } from '../api/types';

const POLL_MS = 1000;

export interface SessionState {
  session: BenchmarkSession | null;
  error: unknown;
  reload: () => void;
}

/**
 * Follows GET /benchmark/sessions/{id} (5.10). Sessions have no event stream, so this polls
 * while the session is queued or running; each run of the session is followed through its own SSE.
 */
export function useBenchmarkSession(sessionId: string | null): SessionState {
  const api = useApi();
  const [session, setSession] = useState<BenchmarkSession | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setSession(null);
    setError(null);
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      api.getSession(sessionId).then(
        (s) => {
          if (disposed) return;
          setSession(s);
          setError(null);
          if (!isTerminalRun(s.status)) timer = setTimeout(poll, POLL_MS);
        },
        (err: unknown) => {
          if (disposed) return;
          setError(err);
          timer = setTimeout(poll, POLL_MS * 3);
        },
      );
    };
    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [api, sessionId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { session, error, reload };
}

/** The run a session is on: the running one, else the next queued one, else the last that ran. */
export function sessionActiveRunId(session: BenchmarkSession): string | null {
  const runs = session.runs;
  return (
    runs.find((r) => r.status === 'running')?.run_id ??
    runs.find((r) => r.status === 'queued')?.run_id ??
    [...runs].reverse().find((r) => r.status !== 'skipped' && r.status !== 'cancelled')?.run_id ??
    runs[0]?.run_id ??
    null
  );
}

/** Results and slide default to the primary step (handoff: one-click benchmark). */
export function sessionResultsRunId(session: BenchmarkSession): string | null {
  const primary = session.runs.find((r) => r.step === 'primary' && r.status !== 'skipped');
  return primary?.run_id ?? sessionActiveRunId(session);
}
