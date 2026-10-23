import { normalizeEvent, normalizeRunSnapshot, normalizeRunStats } from '../api/normalize';
import type { RunEvent, RunSnapshot, RunStats } from '../api/types';
import { fixtures } from '../mocks/fixtures';

export const events: RunEvent[] = fixtures.runEvents.map((e) => {
  const n = normalizeEvent(e);
  if (!n) throw new Error('bad fixture event');
  return n;
});

export const [initialSnapshot, midSnapshot, finalSnapshot] = fixtures.runSnapshots.map(normalizeRunSnapshot) as [
  RunSnapshot,
  RunSnapshot,
  RunSnapshot,
];

export const finalStats: RunStats = normalizeRunStats(fixtures.runStatsTimeline.at(-1)?.stats);
