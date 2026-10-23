import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
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

describe('App on mock data', () => {
  it('shows the identity badge on the benchmark view and on the slide', async () => {
    renderApp('/');
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Final slide' }));
    expect(await screen.findByRole('heading', { name: /benchmark results/i })).toBeInTheDocument();
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
  });

  it('runs a benchmark end to end: puzzles → run → stream → results → stats', async () => {
    renderApp('/');
    const start = await screen.findByRole('button', { name: 'Run benchmark' });
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);

    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('Completed'), { timeout: 5000 });

    // one lane per model, each with a final result
    for (const label of ['Jev 1.13', 'GPT-6 Luna Decisions', 'Cloudflare Clef', 'Claude Opus 5.5']) {
      expect(screen.getByRole('region', { name: `${label} lane` })).toBeInTheDocument();
    }

    // per-puzzle results reflect the backend's trial statuses
    const matrix = screen.getByRole('heading', { name: 'Results by puzzle' }).closest('section')!;
    const statuses = within(matrix)
      .getAllByRole('status')
      .map((el) => el.getAttribute('data-status'));
    expect(statuses.sort()).toEqual(finalSnapshot.trials.map((t) => t.status).sort());
    expect(within(matrix).getAllByText('Move limit reached')).toHaveLength(1);
    expect(within(matrix).getAllByText('Error')).toHaveLength(1);

    // stats dashboard
    await waitFor(() => expect(screen.getByText('Final')).toBeInTheDocument());
    expect(screen.getByRole('table', { name: 'Benchmark statistics per model' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled();
  });

  it('explains how to fix a missing backend API key', async () => {
    renderApp('/', 'missing_api_key');
    expect(await screen.findByText('OpenRouter API key not configured on the backend')).toBeInTheDocument();
    const start = await screen.findByRole('button', { name: 'Run benchmark' });
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);
    expect(await screen.findByText('Backend has no OpenRouter API key')).toBeInTheDocument();
    expect(screen.getByText(/Set OPENROUTER_API_KEY in backend\/.env/)).toBeInTheDocument();
  });
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
});
