import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../api/ApiContext';
import { conflictTarget } from '../api/errors';
import { isTerminalRun, type CreateSessionRequest, type ModelInfo, type Puzzle, type Suite } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import type { BenchmarkRequest } from '../components/RunControls';
import { STEP_NAME } from '../lib/status';
import { usePublishShellStatus, type Stage } from '../state/shellStatus';
import { useAsync } from '../state/useAsync';
import { useRunSession } from '../state/useRunSession';
import { sessionActiveRunId, sessionResultsRunId, useBenchmarkSession } from '../state/useSession';
import { RaceView } from './RaceView';
import { ResultsView } from './ResultsView';
import { SetupView } from './SetupView';

const LAST_SESSION_KEY = 'rubiks-cube-race:last-session';
const SUITE_KICKER: Record<Suite, string> = { warmup: 'WARM-UP', primary: 'PRIMARY', extension: 'EXTENSION' };

function readLastSession(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

function rememberSession(id: string) {
  try {
    localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    // per-browser convenience only
  }
}

/**
 * `/` with no selection = Setup. `?session=` follows a one-click session along its runs;
 * `?run=` shows one run. The stage is Race while the run (or session) is active and Results
 * once it is over, unless `?view=race|results` picks one.
 */
export function BenchmarkPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('session');
  const pickedRun = params.get('run');
  const viewParam = params.get('view');

  const { session, error: sessionError, reload: reloadSession } = useBenchmarkSession(sessionId);
  const sessionOver = session ? isTerminalRun(session.status) : false;
  const followRun = session ? (sessionOver ? sessionResultsRunId(session) : sessionActiveRunId(session)) : null;
  const runId = pickedRun ?? followRun;

  const { state, stream, loadError, reload } = useRunSession(runId);
  const models = useAsync(() => api.listModels(), [api]);
  const info = useAsync(() => api.getBenchmark(), [api, !runId, sessionOver]);
  const runs = useAsync(!runId && !sessionId ? () => api.listRuns() : null, [api, runId, sessionId]);
  const storedPuzzles = useAsync(runId ? () => api.listPuzzles() : null, [api, runId]);
  const stats = useAsync(runId ? () => api.getStats(runId) : null, [api, runId, state.statsEpoch]);

  const [createdPuzzles, setCreatedPuzzles] = useState<Record<string, Puzzle>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'session' | 'run' | null>(null);
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [lastSession, setLastSession] = useState<string | null>(readLastSession);

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

  const runActive = state.loaded && state.status !== null && !isTerminalRun(state.status);
  const stage: Stage = !runId
    ? 'setup'
    : viewParam === 'race' || viewParam === 'results'
      ? viewParam
      : (session && !sessionOver) || !state.loaded || runActive
        ? 'race'
        : 'results';
  usePublishShellStatus(stage, runId ? stream : 'idle', session);

  const runStats = stats.data && stats.data.run_id === runId ? stats.data : null;
  const step = session?.runs.find((r) => r.run_id === runId) ?? null;
  const planStep = step ? info.data?.plan.find((p) => p.step === step.step) : undefined;
  const suite: Suite | null = step?.suite ?? puzzlesById[state.config?.puzzle_ids[0] ?? '']?.suite ?? null;
  const kicker = [
    suite ? `${SUITE_KICKER[suite]} BENCHMARK` : 'BENCHMARK',
    step ? `STEP ${session!.runs.indexOf(step) + 1} OF ${session!.runs.length} · ${STEP_NAME[step.step].toUpperCase()}` : null,
    runId?.toUpperCase(),
    stage === 'results' && state.status ? state.status.toUpperCase() : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const selectRun = (id: string) => {
    const next = new URLSearchParams();
    if (sessionId) next.set('session', sessionId);
    next.set('run', id);
    setParams(next);
  };

  const openTarget = (err: unknown) => {
    const target = conflictTarget(err);
    if (!target) return null;
    return {
      label: target.kind === 'session' ? 'Open that session' : 'Open that run',
      onClick: () => {
        setActionError(null);
        setParams(target.kind === 'session' ? { session: target.id } : { run: target.id });
      },
    };
  };

  async function startSession(req: CreateSessionRequest) {
    setActionError(null);
    setBusy('session');
    try {
      const s = await api.createSession(req);
      rememberSession(s.session_id);
      setLastSession(s.session_id);
      setParams({ session: s.session_id });
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  async function startRun(req: BenchmarkRequest) {
    setActionError(null);
    setBusy('run');
    try {
      setPhaseLabel('Generating puzzles…');
      const { suite: s, count, scramble_length, seed } = req.puzzles;
      const created = await api.createPuzzles({ suite: s, count, scramble_length, seed });
      setCreatedPuzzles((prev) => ({ ...prev, ...Object.fromEntries(created.map((p) => [p.puzzle_id, p])) }));
      setPhaseLabel('Starting run…');
      const run = await api.createRun({
        puzzle_ids: created.map((p) => p.puzzle_id),
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
      setBusy(null);
      setPhaseLabel(null);
    }
  }

  async function cancel() {
    setCancelling(true);
    setActionError(null);
    try {
      if (session && !sessionOver) {
        await api.cancelSession(session.session_id);
        reloadSession();
      } else if (runId) {
        await api.cancelRun(runId);
      }
    } catch (err) {
      setActionError(err);
    } finally {
      setCancelling(false);
    }
  }

  const notices = (
    <>
      {models.error ? <ErrorNotice error={models.error} onRetry={models.reload} /> : null}
      {info.error && !runId ? <ErrorNotice error={info.error} onRetry={info.reload} /> : null}
      {actionError ? <ErrorNotice error={actionError} action={openTarget(actionError)} /> : null}
      {sessionError ? <ErrorNotice error={sessionError} onRetry={reloadSession} /> : null}
      {loadError ? <ErrorNotice error={loadError} onRetry={reload} /> : null}
    </>
  );

  if (!runId) {
    return (
      <>
        <div className="page-notices">{notices}</div>
        {sessionId && !session && !sessionError ? (
          <p className="page muted">Loading benchmark session…</p>
        ) : (
          <SetupView
            info={info.data}
            models={models.data}
            runs={runs.data}
            lastSessionId={lastSession}
            busy={busy}
            phaseLabel={phaseLabel}
            onStartSession={startSession}
            onStartRun={startRun}
            onOpenRun={(id) => setParams({ run: id })}
            onOpenSession={(id) => setParams({ session: id })}
          />
        )}
      </>
    );
  }

  const slide = new URLSearchParams();
  if (sessionId) slide.set('session', sessionId);
  slide.set('run', runId);

  return (
    <>
      <div className="page-notices">{notices}</div>
      {stage === 'race' ? (
        <RaceView
          runId={runId}
          state={state}
          stream={stream}
          session={session}
          models={modelsById}
          puzzles={puzzlesById}
          stats={runStats}
          kicker={kicker}
          seed={planStep?.seed ?? null}
          focus={focus}
          onFocus={setFocus}
          onSelectRun={selectRun}
          canCancel={session ? !sessionOver : runActive}
          cancelling={cancelling}
          onCancel={cancel}
        />
      ) : (
        <ResultsView
          runId={runId}
          state={state}
          stream={stream}
          session={session}
          models={modelsById}
          puzzles={puzzlesById}
          stats={runStats}
          statsError={stats.error}
          statsLoading={stats.loading}
          onReloadStats={stats.reload}
          kicker={kicker}
          slideHref={`/slide?${slide.toString()}`}
          onSelectRun={selectRun}
        />
      )}
    </>
  );
}
