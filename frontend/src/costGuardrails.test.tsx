// Cost guardrails from contract v1.1.0, still in force in v1.3.0 (AGENTS.md 5.6, 6.1 G4/G5/G9).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from './api/ApiContext';
import { ApiError, describeError, spendCapDetails } from './api/errors';
import { createHttpClient } from './api/httpClient';
import { CONTRACT_VERSION, RUN_DEFAULTS, RUN_LIMITS, type RunEvent } from './api/types';
import { App, ROUTER_FUTURE } from './App';
import { ErrorNotice } from './components/ErrorNotice';
import { RunStatusBar, type RunStatusBarProps } from './components/RunStatusBar';
import { createMockClient, type MockScenario } from './mocks/mockClient';
import { initialRunState, runReducer } from './state/runReducer';
import { initialSnapshot } from './test/fixtureData';

const spendCapError = (details: Record<string, unknown> | null) =>
  new ApiError(409, { code: 'conflict', message: 'Estimated worst-case cost exceeds the remaining spend budget', details });

function renderApp(scenario: MockScenario) {
  const api = createMockClient({ scenario, speed: 0, latencyMs: 0 });
  render(
    <MemoryRouter initialEntries={['/']} future={ROUTER_FUTURE}>
      <ApiProvider api={api}>
        <App />
      </ApiProvider>
    </MemoryRouter>,
  );
  return api;
}

/** The custom run lives behind the "Advanced" disclosure on Setup. */
async function openCustomRun() {
  await userEvent.click(await screen.findByText('Advanced · one custom run'));
  const start = await screen.findByRole('button', { name: 'Run custom benchmark' });
  await waitFor(() => expect(start).toBeEnabled());
  return start;
}

async function clickRun() {
  await userEvent.click(await openCustomRun());
}

describe('cost-guardrail defaults', () => {
  it('uses the cost-guardrail run defaults', () => {
    expect(CONTRACT_VERSION).toBe('1.3.0');
    expect(RUN_DEFAULTS).toEqual({ max_moves: 30, timeout_s: 15, max_retries: 1, history_window: 6, concurrency: 1 });
    expect(RUN_LIMITS.timeout_s).toEqual({ min: 1, max: 20 });
    expect(RUN_LIMITS.max_retries).toEqual({ min: 0, max: 1 });
  });

  it('sends timeout_s 15 and max_retries 1 when the user changes nothing', async () => {
    const api = renderApp('default');
    const createRun = vi.spyOn(api, 'createRun');
    await clickRun();
    await waitFor(() => expect(createRun).toHaveBeenCalled());
    expect(createRun.mock.calls[0]?.[0]).toMatchObject({ timeout_s: 15, max_retries: 1, max_moves: 30, concurrency: 1 });
  });

  it('blocks out-of-range timeout and retries instead of sending them', async () => {
    renderApp('default');
    const start = await openCustomRun();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const timeout = screen.getByLabelText(/Timeout \(s, 1–20\)/);
    const retries = screen.getByLabelText(/Max retries \(0–1\)/);
    expect(timeout).toHaveAttribute('min', '1');
    expect(timeout).toHaveAttribute('max', '20');
    expect(retries).toHaveAttribute('min', '0');
    expect(retries).toHaveAttribute('max', '1');
    expect(screen.getByText(/capped by the backend to limit OpenRouter API cost/)).toBeInTheDocument();

    await userEvent.clear(timeout);
    await userEvent.type(timeout, '60');
    await userEvent.clear(retries);
    await userEvent.type(retries, '2');
    expect(start).toBeDisabled();
    expect(screen.getByText(/Timeout must be 1–20 s\./)).toHaveTextContent('Timeout must be 1–20 s. Max retries must be 0–1.');

    await userEvent.clear(timeout);
    await userEvent.type(timeout, '20');
    await userEvent.clear(retries);
    await userEvent.type(retries, '0');
    expect(start).toBeEnabled();
  });
});

describe('409 spend-cap notice', () => {
  it('shows the backend estimate and remaining budget when details are present', () => {
    const err = spendCapError({ estimated_max_cost_usd: 1.67, remaining_budget_usd: 0.85 });
    expect(spendCapDetails(err)).toEqual({ estimated_max_cost_usd: 1.67, remaining_budget_usd: 0.85 });
    const d = describeError(err);
    expect(d.title).toBe('Run blocked by spend cap');
    expect(d.message).toBe('Worst-case $1.67, remaining budget $0.85.');
    expect(d.guidance).toMatch(/raise MAX_SPEND_USD on the backend/);
  });

  it('falls back to the generic conflict notice when details are missing or incomplete', () => {
    for (const details of [null, {}, { estimated_max_cost_usd: 1.67 }, { estimated_max_cost_usd: '1.67', remaining_budget_usd: 0.85 }]) {
      const err = spendCapError(details);
      expect(spendCapDetails(err)).toBeNull();
      expect(describeError(err)).toMatchObject({
        title: 'Not possible right now',
        message: 'Estimated worst-case cost exceeds the remaining spend budget',
      });
    }
  });

  it('is only used for conflict errors', () => {
    const err = new ApiError(422, {
      code: 'validation_error',
      message: 'bad',
      details: { estimated_max_cost_usd: 1, remaining_budget_usd: 0 },
    });
    expect(spendCapDetails(err)).toBeNull();
  });

  it('parses the 409 from the HTTP client', async () => {
    const body = {
      error: {
        code: 'conflict',
        message: 'Estimated worst-case cost exceeds the remaining spend budget',
        details: { estimated_max_cost_usd: 1.67, remaining_budget_usd: 0.85 },
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
    const err = await createHttpClient('/api/v1', fetchImpl).createRun({ puzzle_ids: ['pz_01'] }).catch((e: unknown) => e);
    render(<ErrorNotice error={err} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Run blocked by spend cap');
    expect(screen.getByRole('alert')).toHaveTextContent('Worst-case $1.67, remaining budget $0.85.');
  });

  it('appears in the app when the mock backend rejects the run', async () => {
    renderApp('spend_cap');
    await clickRun();
    const notice = (await screen.findByText('Run blocked by spend cap')).closest('[role="alert"]') as HTMLElement;
    expect(notice).toHaveTextContent('Worst-case $1.67, remaining budget $0.85.');
    expect(notice).toHaveTextContent('Use fewer puzzles or models, or raise MAX_SPEND_USD on the backend.');
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
  });
});

describe('run-level abort', () => {
  const base: RunStatusBarProps = {
    runId: 'run_01',
    status: 'failed',
    stream: 'closed',
    progress: { finished: 4, total: 12 },
    startedAt: null,
    finishedAt: null,
    runs: null,
    onSelectRun: () => undefined,
  };
  const renderBar = (props: Partial<RunStatusBarProps>) =>
    render(
      <MemoryRouter future={ROUTER_FUTURE}>
        <RunStatusBar {...base} {...props} />
      </MemoryRouter>,
    );

  it('shows the error message of a failed run in the status bar', () => {
    renderBar({ runError: { code: 'upstream_error', message: 'insufficient credits' } });
    const abort = screen.getByTestId('run-abort');
    expect(abort).toHaveTextContent('Run aborted by the backend');
    expect(abort).toHaveTextContent('insufficient credits');
    expect(abort).toHaveTextContent('upstream_error');
    expect(screen.getByTestId('run-status')).toHaveTextContent('Failed');
  });

  it('still flags a failed run when no error event was received', () => {
    renderBar({ runError: null });
    expect(screen.getByTestId('run-abort')).toHaveTextContent('No reason available');
  });

  it('shows nothing extra for a healthy run', () => {
    renderBar({ status: 'running', runError: null });
    expect(screen.queryByTestId('run-abort')).toBeNull();
  });

  it('reduces an error event followed by run_finished(failed)', () => {
    const ev = (seq: number, type: 'error' | 'run_finished', data: object): RunEvent =>
      ({ seq, type, run_id: 'run_01', trial_id: null, ts: '2026-10-24T09:31:00Z', data }) as RunEvent;
    let s = runReducer(runReducer(initialRunState, { type: 'reset', runId: 'run_01' }), {
      type: 'snapshot',
      snapshot: initialSnapshot,
    });
    s = runReducer(s, { type: 'event', event: ev(1, 'error', { code: 'conflict', message: 'Live spend cap reached' }) });
    s = runReducer(s, { type: 'event', event: ev(2, 'run_finished', { status: 'failed', finished_at: '2026-10-24T09:31:00Z' }) });
    expect(s.status).toBe('failed');
    expect(s.runError).toEqual({ code: 'conflict', message: 'Live spend cap reached' });
  });

  it('shows "Live spend cap reached" when the mock backend aborts a run', async () => {
    renderApp('run_abort');
    await clickRun();
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('Failed'), { timeout: 5000 });
    const abort = screen.getByTestId('run-abort');
    expect(abort).toHaveTextContent('Live spend cap reached');
    expect(abort).toHaveTextContent('conflict');
    // unfinished trials are not presented as still playing
    const matrix = screen.getByRole('heading', { name: /Results matrix/ }).closest('section')!;
    expect(within(matrix).queryByText(/Thinking|Retrying/)).toBeNull();
    expect(screen.getByRole('link', { name: 'New run' })).toBeInTheDocument();
    expect(screen.getByTestId('identity-badge')).toBeInTheDocument();
  });
});

describe('mock health', () => {
  it('reports contract 1.3.0', async () => {
    const health = await createMockClient({ latencyMs: 0 }).getHealth();
    expect(health.contract_version).toBe('1.3.0');
  });
});
