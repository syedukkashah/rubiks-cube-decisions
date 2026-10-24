import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from './api/ApiContext';
import { App, ROUTER_FUTURE } from './App';
import { createMockClient } from './mocks/mockClient';
import { finalSnapshot } from './test/fixtureData';

function renderApp(path = '/', scenario = 'default') {
  const api = createMockClient({ scenario, speed: 0, latencyMs: 0 });
  render(
    <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
      <ApiProvider api={api}>
        <App />
      </ApiProvider>
    </MemoryRouter>,
  );
  return api;
}

/** Opens the "Advanced" disclosure and starts a custom run with its defaults. */
async function startCustomRun() {
  await userEvent.click(await screen.findByText('Advanced · one custom run'));
  const start = await screen.findByRole('button', { name: 'Run custom benchmark' });
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start);
}

async function startOneClick() {
  const start = await screen.findByRole('button', { name: /^Run full benchmark/ });
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start);
}

const sessionSteps = () => screen.findByRole('list', { name: 'Benchmark steps' });

describe('App on mock data', () => {
  it('shows the identity badge on setup and on the slide', async () => {
    renderApp('/');
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Slide' }));
    expect(await screen.findByRole('heading', { name: 'Fast decisions vs. frontier planning' })).toBeInTheDocument();
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
  });

  it('runs a custom benchmark end to end: puzzles → run → stream → results → stats', async () => {
    renderApp('/');
    await startCustomRun();

    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('Completed'), { timeout: 5000 });
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();

    // one final-state card per model
    const finals = screen.getByRole('heading', { name: 'Final state per puzzle' }).closest('section')!;
    for (const label of ['Jev 1.13', 'GPT-6 Luna Decisions', 'Cloudflare Clef', 'Claude Opus 5.5']) {
      expect(within(finals).getByText(label)).toBeInTheDocument();
    }

    // the matrix reflects the backend's trial statuses
    const matrix = screen.getByRole('heading', { name: /Results matrix/ }).closest('section')!;
    const statuses = [...matrix.querySelectorAll('[data-status]')].map((el) => el.getAttribute('data-status'));
    expect(statuses.sort()).toEqual(finalSnapshot.trials.map((t) => t.status).sort());
    expect(within(matrix).getAllByText(/· limit$/)).toHaveLength(1);
    expect(within(matrix).getAllByText('error')).toHaveLength(1);

    // stats dashboard and the questions
    await waitFor(() => expect(screen.getByText('Final')).toBeInTheDocument());
    expect(screen.getByRole('table', { name: 'Benchmark statistics per model' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What the experiment answers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New run' })).toBeInTheDocument();

    // the Race view of the finished run: four lanes, the event stream and the badge
    await userEvent.click(screen.getByRole('link', { name: 'Race' }));
    for (const label of ['Jev 1.13', 'GPT-6 Luna Decisions', 'Cloudflare Clef', 'Claude Opus 5.5']) {
      expect(await screen.findByRole('region', { name: `${label} lane` })).toBeInTheDocument();
    }
    expect(screen.getByRole('region', { name: 'Event stream' })).toBeInTheDocument();
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
  });

  it('explains how to fix a missing backend API key', async () => {
    renderApp('/', 'missing_api_key');
    expect(await screen.findByText('OpenRouter API key not configured on the backend')).toBeInTheDocument();
    await startCustomRun();
    expect(await screen.findByText('Backend has no OpenRouter API key')).toBeInTheDocument();
    expect(screen.getByText(/Set OPENROUTER_API_KEY in backend\/.env/)).toBeInTheDocument();
  });
});

describe('one-click benchmark (contract v1.2.0)', () => {
  it('replays the live recording with no OpenRouter calls and labels it as a replay', async () => {
    const api = renderApp('/');
    const createSession = vi.spyOn(api, 'createSession');
    expect(await screen.findByText('Replays your live recording · no OpenRouter calls')).toBeInTheDocument();
    await startOneClick();

    expect(createSession).toHaveBeenCalledWith({ source: 'auto', speed: 1, include_extension: true });
    expect(await screen.findByTestId('source-chip')).toHaveTextContent(/^Replay of live recording/);
    expect(screen.getByTestId('source-chip')).not.toHaveTextContent(/Live · OpenRouter/);

    // the session runs warm-up, primary and extension, then shows the primary run's results
    const steps = await sessionSteps();
    await waitFor(() => expect(within(steps).getAllByText('Completed')).toHaveLength(3), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('Completed'), { timeout: 5000 });
    expect(screen.getByText(/PRIMARY BENCHMARK · STEP 2 OF 3/)).toBeInTheDocument();
    expect(screen.queryByTestId('recording-saved')).toBeNull();
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
  });

  it('simulates when no recording exists yet', async () => {
    renderApp('/', 'no_recording');
    expect(await screen.findByText('Simulated · no OpenRouter calls')).toBeInTheDocument();
    await startOneClick();
    expect(await screen.findByTestId('source-chip')).toHaveTextContent('Simulated · no OpenRouter calls');
  });

  it('runs live only after explicit confirmation and then says the recording was saved', async () => {
    const api = renderApp('/', 'live_ready');
    const createSession = vi.spyOn(api, 'createSession');
    await userEvent.click(await screen.findByRole('button', { name: 'Run live once…' }));
    const confirm = screen.getByRole('button', { name: 'Start live run' });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /I ran live_smoke.py/ }));
    await userEvent.click(confirm);

    expect(createSession).toHaveBeenCalledWith({ source: 'live', include_extension: true, confirm_cost: true });
    expect(await screen.findByTestId('source-chip')).toHaveTextContent('Live · OpenRouter');
    expect(await screen.findByTestId('recording-saved', {}, { timeout: 8000 })).toHaveTextContent('Live recording saved');
    expect(screen.getAllByTestId('step-gate').length).toBeGreaterThan(0);
  }, 15000);

  it('shows the gate that stopped a live session', async () => {
    renderApp('/', 'gate_stop');
    await userEvent.click(await screen.findByRole('button', { name: 'Run live once…' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /I ran live_smoke.py/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start live run' }));

    const notice = await screen.findByTestId('gate-stop', {}, { timeout: 8000 });
    expect(notice).toHaveTextContent('Stopped at gate after the warm-up step: primary did not start');
    expect(notice).toHaveTextContent('No recording was saved.');
    expect(screen.queryByTestId('recording-saved')).toBeNull();
  }, 15000);
});

describe('mock client', () => {
  it('cancels a run with a run_finished(cancelled) event and rejects a second cancel with 409', async () => {
    const api = createMockClient({ speed: 1, latencyMs: 0 });
    const [p] = await api.createPuzzles({ suite: 'primary', count: 1 });
    const { run_id } = await api.createRun({ puzzle_ids: [p!.puzzle_id] });
    const seen: string[] = [];
    const close = api.subscribeEvents(run_id, 0, { onEvent: (e) => seen.push(`${e.seq}:${e.type}`) });
    await api.cancelRun(run_id);
    await waitFor(() => expect(seen.at(-1)).toMatch(/run_finished$/));
    close();
    const err = await api.cancelRun(run_id).catch((e: { code: string }) => e);
    expect((err as { code: string }).code).toBe('conflict');
    expect((await api.getStats(run_id)).run_status).toBe('cancelled');
  });

  it('stamps replayed events with the replay time, not the time of the recording', async () => {
    const api = createMockClient({ speed: 0, latencyMs: 0 });
    const [p] = await api.createPuzzles({ suite: 'primary', count: 1 });
    const { run_id } = await api.createRun({ puzzle_ids: [p!.puzzle_id] });
    const snap = await api.getRun(run_id);
    const age = (iso: string | null) => Math.abs(Date.now() - Date.parse(iso ?? ''));
    expect(age(snap.started_at)).toBeLessThan(5000);
    for (const t of snap.trials) expect(age(t.finished_at)).toBeLessThan(5000);
  });

  it('rejects a replay without a recording and a second live pass with a 409 reason', async () => {
    const none = createMockClient({ scenario: 'no_recording', latencyMs: 0 });
    const noRec = await none.createSession({ source: 'replay' }).catch((e: { status: number; details: unknown }) => e);
    expect(noRec).toMatchObject({ status: 409, details: { reason: 'no_recording' } });

    const recorded = createMockClient({ scenario: 'default', latencyMs: 0 });
    const live = await recorded.createSession({ source: 'live', confirm_cost: true }).catch((e: { status: number; details: unknown }) => e);
    expect(live).toMatchObject({ status: 409 });
  });
});
