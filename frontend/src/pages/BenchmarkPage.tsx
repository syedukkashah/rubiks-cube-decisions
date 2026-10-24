import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api/ApiContext';
import { isTerminalRun, type ModelInfo, type Puzzle } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { ModelLane } from '../components/ModelLane';
import { PuzzlePanel } from '../components/PuzzlePanel';
import { ResultsMatrix } from '../components/ResultsMatrix';
import { RunControls, type BenchmarkRequest } from '../components/RunControls';
import { RunStatusBar } from '../components/RunStatusBar';
import { StatsDashboard } from '../components/StatsDashboard';
import { laneTrial, livePuzzleId, runProgress, trialsOf } from '../state/selectors';
import { useAsync } from '../state/useAsync';
import { useRunSession } from '../state/useRunSession';

type Phase = 'puzzles' | 'run' | null;
const PHASE_LABEL = { puzzles: 'Generating puzzles…', run: 'Starting run…' } as const;

export function BenchmarkPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');

  const { state, stream, loadError, reload } = useRunSession(runId);
  const models = useAsync(() => api.listModels(), [api]);
  const runs = useAsync(() => api.listRuns(), [api, runId, state.status]);
  const storedPuzzles = useAsync(runId ? () => api.listPuzzles() : null, [api, runId]);
  const stats = useAsync(runId ? () => api.getStats(runId) : null, [api, runId, state.statsEpoch]);

  const [createdPuzzles, setCreatedPuzzles] = useState<Record<string, Puzzle>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => setFocus(null), [runId]);

  const modelsById = useMemo(() => {
    const map: Record<string, ModelInfo> = {};
    for (const m of models.data ?? []) map[m.id] = m;
    return map;
  }, [models.data]);

  const puzzlesById = useMemo(() => {
    const map: Record<string, Puzzle> = { ...createdPuzzles };
    for (const p of storedPuzzles.data ?? []) map[p.puzzle_id] = p;
    return map;
  }, [createdPuzzles, storedPuzzles.data]);

  const active = state.loaded && state.status !== null && !isTerminalRun(state.status);
  const runStats = stats.data && stats.data.run_id === runId ? stats.data : null;
  const shownPuzzleId = focus ?? livePuzzleId(state);
  const fallbackFacelets = trialsOf(state).find((t) => t.puzzle_id === shownPuzzleId)?.initial_facelets ?? null;
  const modelIds = state.config?.model_ids ?? [];

  async function start(req: BenchmarkRequest) {
    setActionError(null);
    try {
      let puzzleIds: string[];
      if (req.puzzles.source === 'generate') {
        setPhase('puzzles');
        const { suite, count, scramble_length, seed } = req.puzzles;
        const created = await api.createPuzzles({ suite, count, scramble_length, seed });
        setCreatedPuzzles((prev) => ({ ...prev, ...Object.fromEntries(created.map((p) => [p.puzzle_id, p])) }));
        puzzleIds = created.map((p) => p.puzzle_id);
      } else {
        puzzleIds = req.puzzles.puzzle_ids;
      }
      setPhase('run');
      const run = await api.createRun({
        puzzle_ids: puzzleIds,
        model_ids: req.model_ids,
        max_moves: req.max_moves,
        timeout_s: req.timeout_s,
        max_retries: req.max_retries,
        history_window: req.history_window,
        concurrency: req.concurrency,
      });
      setParams({ run: run.run_id });
    } catch (err) {
      setActionError(err);
    } finally {
      setPhase(null);
    }
  }

  async function cancel() {
    if (!runId) return;
    setCancelling(true);
    setActionError(null);
    try {
      await api.cancelRun(runId);
    } catch (err) {
      setActionError(err);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="page">
      <RunControls
        models={models.data}
        busy={phase !== null}
        active={active}
        phaseLabel={phase ? PHASE_LABEL[phase] : null}
        onStart={start}
        onCancel={cancel}
        canCancel={active}
        cancelling={cancelling}
      />
      {models.error ? <ErrorNotice error={models.error} onRetry={models.reload} /> : null}
      {actionError ? <ErrorNotice error={actionError} /> : null}

      {(runId || (runs.data && runs.data.length > 0)) && (
        <RunStatusBar
          runId={runId}
          status={state.status}
          stream={stream}
          progress={runProgress(state)}
          startedAt={state.startedAt}
          finishedAt={state.finishedAt}
          runs={runs.data}
          onSelectRun={(id) => setParams({ run: id })}
          runError={state.runError}
        />
      )}
      {loadError ? <ErrorNotice error={loadError} onRetry={reload} /> : null}

      {!runId ? (
        <section className="card empty-state">
          <h2>No benchmark selected</h2>
          <p className="muted">
            Press <strong>Run benchmark</strong> to generate scrambles and race the four models on the same cube, or pick a
            previous run above. Every model gets the same scramble, engine, move set, timeout and retry policy.
          </p>
        </section>
      ) : (
        <>
          <div className="arena">
            <PuzzlePanel
              puzzleIds={state.config?.puzzle_ids ?? []}
              puzzles={puzzlesById}
              shownPuzzleId={shownPuzzleId}
              focusPuzzleId={focus}
              onFocus={setFocus}
              fallbackFacelets={fallbackFacelets}
            />
            <div className="lanes" data-count={modelIds.length}>
              {modelIds.map((id) => {
                const trial = laneTrial(state, id, focus);
                return (
                  <ModelLane
                    key={id}
                    modelId={id}
                    model={modelsById[id] ?? null}
                    trial={trial}
                    live={trial ? (state.live[trial.trial_id] ?? null) : null}
                    runStatus={state.status}
                    maxMoves={state.config?.max_moves ?? null}
                  />
                );
              })}
              {state.loaded && modelIds.length === 0 && <p className="muted">This run has no models.</p>}
              {!state.loaded && !loadError && <p className="muted">Loading run…</p>}
            </div>
          </div>

          <ResultsMatrix
            state={state}
            models={modelsById}
            puzzles={puzzlesById}
            runStatus={state.status}
            focusPuzzleId={focus}
            onFocus={setFocus}
          />

          <StatsDashboard stats={runStats} error={stats.error} loading={stats.loading} onRetry={stats.reload} />
        </>
      )}
    </div>
  );
}
