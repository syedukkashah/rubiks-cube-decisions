// Canonical example payloads for mock mode and tests, read from the shared /contract/fixtures.
// Only run_playback.json (replay timing) and error_spend_cap.json are frontend-local.
import health from '../../../contract/fixtures/health.json';
import models from '../../../contract/fixtures/models.json';
import puzzles from '../../../contract/fixtures/puzzles.json';
import runCreated from '../../../contract/fixtures/run_created.json';
import runSnapshots from '../../../contract/fixtures/run_snapshots.json';
import runEvents from '../../../contract/fixtures/run_events.json';
import runStats from '../../../contract/fixtures/run_stats.json';
import errorMissingApiKey from '../../../contract/fixtures/error_missing_api_key.json';
import runPlayback from './fixtures/run_playback.json';
// 409 spend pre-check example from AGENTS.md 5.6 (v1.1.0). Local until /contract/fixtures has one.
import errorSpendCap from './fixtures/error_spend_cap.json';

// run_stats.json holds GET /runs/{id}/stats as it read before the run (seq 0) and then after each
// trial_finished / run_finished event, in order. Pair each response with that seq for playback.
const statsCheckpoints = [
  0,
  ...(runEvents as Array<{ seq: number; type: string }>)
    .filter((e) => e.type === 'trial_finished' || e.type === 'run_finished')
    .map((e) => e.seq),
];
if (statsCheckpoints.length !== runStats.length) {
  throw new Error(`run_stats.json has ${runStats.length} entries, expected ${statsCheckpoints.length}`);
}

export const fixtures = {
  health: health as unknown,
  models: models as unknown,
  puzzles: puzzles as unknown,
  runCreated: runCreated as unknown,
  /** Recorded GET /runs/{id} snapshots at increasing last_seq checkpoints. */
  runSnapshots: runSnapshots as unknown[],
  /** The recorded SSE stream, seq 1..N. */
  runEvents: runEvents as unknown[],
  /** gaps_ms[i] = simulated ms between event i-1 and event i of the recording. */
  runPlayback: runPlayback as { gaps_ms: number[] },
  /** GET /runs/{id}/stats as it read after each trial_finished / run_finished seq. */
  runStatsTimeline: (runStats as unknown[]).map((stats, i) => ({ after_seq: statsCheckpoints[i] ?? 0, stats })),
  errorMissingApiKey: errorMissingApiKey as unknown,
  errorSpendCap: errorSpendCap as unknown,
};

/** The run id used inside the recording. */
export const RECORDED_RUN_ID = 'run_01';
