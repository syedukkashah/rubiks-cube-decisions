import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BenchmarkSession } from '../api/types';
import type { StreamStatus } from './useRunSession';

/** What the app header shows about the run on screen: stream state and session source. */
export type Stage = 'setup' | 'race' | 'results';

export interface ShellStatus {
  stage: Stage;
  stream: StreamStatus;
  session: BenchmarkSession | null;
}

const IDLE: ShellStatus = { stage: 'setup', stream: 'idle', session: null };

const ShellStatusContext = createContext<{ status: ShellStatus; set: (s: ShellStatus) => void }>({
  status: IDLE,
  set: () => undefined,
});

export function ShellStatusProvider({ children }: { children: ReactNode }) {
  const [status, set] = useState<ShellStatus>(IDLE);
  return <ShellStatusContext.Provider value={{ status, set }}>{children}</ShellStatusContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useShellStatus(): ShellStatus {
  return useContext(ShellStatusContext).status;
}

/** Publishes the page's status to the header; resets it when the page unmounts. */
// eslint-disable-next-line react-refresh/only-export-components
export function usePublishShellStatus(stage: Stage, stream: StreamStatus, session: BenchmarkSession | null) {
  const { set } = useContext(ShellStatusContext);
  useEffect(() => set({ stage, stream, session }), [set, stage, stream, session]);
  useEffect(() => () => set(IDLE), [set]);
}
