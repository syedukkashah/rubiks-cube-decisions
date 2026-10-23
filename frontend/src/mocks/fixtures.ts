// Canonical example payloads for mock mode and tests.
// TODO(contract M0): once /contract/fixtures exists, point these imports at it
// (e.g. '../../../contract/fixtures/...') and delete the local copies. Shapes are identical.
import health from './fixtures/health.json';
import models from './fixtures/models.json';
import puzzles from './fixtures/puzzles.json';
import runCreated from './fixtures/run_created.json';
import runSnapshots from './fixtures/run_snapshots.json';
import runEvents from './fixtures/run_events.json';
import runPlayback from './fixtures/run_playback.json';
import runStatsTimeline from './fixtures/run_stats_timeline.json';
import errorMissingApiKey from './fixtures/error_missing_api_key.json';

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
  runStatsTimeline: runStatsTimeline as Array<{ after_seq: number; stats: unknown }>,
  errorMissingApiKey: errorMissingApiKey as unknown,
};

/** The run id used inside the recording. */
export const RECORDED_RUN_ID = 'run_01';
