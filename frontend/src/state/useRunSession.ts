import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useApi } from '../api/ApiContext';
import { isTerminalRun } from '../api/types';
import { initialRunState, runReducer, type RunState } from './runReducer';

export type StreamStatus = 'idle' | 'loading' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

export interface RunSession {
  state: RunState;
  stream: StreamStatus;
  loadError: unknown;
  reload: () => void;
}

const GAP_RESYNC_MS = 3000;
const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));

/**
 * Loads GET /runs/{id}, then follows GET /runs/{id}/events from the snapshot's last_seq.
 * On a dropped stream it resubscribes with ?after_seq=<last applied seq> (exponential backoff).
 * If a seq gap does not fill on its own, it refetches the snapshot.
 */
export function useRunSession(runId: string | null): RunSession {
  const api = useApi();
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const [stream, setStream] = useState<StreamStatus>('idle');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  // Read by stream callbacks that outlive a render.
  const lastSeqRef = useRef(0);
  const terminalRef = useRef(false);
  useEffect(() => {
    lastSeqRef.current = state.lastSeq;
    terminalRef.current = state.status !== null && isTerminalRun(state.status);
  }, [state.lastSeq, state.status]);

  useEffect(() => {
    dispatch({ type: 'reset', runId });
    lastSeqRef.current = 0;
    terminalRef.current = false;
    setLoadError(null);
    if (!runId) {
      setStream('idle');
      return;
    }
    setStream('loading');

    let disposed = false;
    let finished = false;
    let close: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const connect = () => {
      if (disposed || finished || terminalRef.current) return;
      setStream(attempts === 0 ? 'connecting' : 'reconnecting');
      close = api.subscribeEvents(runId, lastSeqRef.current, {
        onOpen: () => {
          attempts = 0;
          if (!disposed) setStream('live');
        },
        onEvent: (event) => {
          if (disposed) return;
          dispatch({ type: 'event', event });
          if (event.type === 'run_finished') {
            finished = true;
            close?.();
            setStream('closed');
          }
        },
        onError: () => {
          close = null;
          if (disposed || finished) return;
          if (terminalRef.current) {
            setStream('closed');
            return;
          }
          attempts += 1;
          setStream('reconnecting');
          timer = setTimeout(connect, backoff(attempts));
        },
      });
    };

    api.getRun(runId).then(
      (snapshot) => {
        if (disposed) return;
        dispatch({ type: 'snapshot', snapshot });
        lastSeqRef.current = Math.max(lastSeqRef.current, snapshot.last_seq);
        if (isTerminalRun(snapshot.status)) {
          finished = true;
          setStream('closed');
          return;
        }
        connect();
      },
      (err: unknown) => {
        if (disposed) return;
        setLoadError(err);
        setStream('error');
      },
    );

    return () => {
      disposed = true;
      clearTimeout(timer);
      close?.();
    };
  }, [api, runId, nonce]);

  // A gap that does not fill (lost event) is repaired from a fresh snapshot.
  const hasGap = state.loaded && Object.keys(state.pending).length > 0;
  useEffect(() => {
    if (!hasGap || !runId) return;
    const t = setTimeout(() => {
      api.getRun(runId).then(
        (snapshot) => dispatch({ type: 'snapshot', snapshot }),
        () => undefined,
      );
    }, GAP_RESYNC_MS);
    return () => clearTimeout(t);
  }, [api, runId, hasGap, state.lastSeq]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, stream, loadError, reload };
}
