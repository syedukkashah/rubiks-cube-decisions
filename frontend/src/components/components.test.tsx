import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { finalSnapshot, finalStats } from '../test/fixtureData';
import { CubeNet } from './CubeNet';
import { IdentityBadge } from './IdentityBadge';
import { QuestionsAnswered } from './QuestionsAnswered';
import { MoveHistory } from './MoveHistory';
import { ResultBanner } from './ResultBanner';
import { StatsDashboard } from './StatsDashboard';

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

describe('ResultBanner', () => {
  it.each([
    ['solved', 'Solved'],
    ['move_limit', 'Move limit reached'],
    ['error', 'Error'],
    ['running', 'Playing…'],
    ['pending', 'Queued'],
  ] as const)('shows %s as "%s"', (status, label) => {
    render(<ResultBanner status={status} />);
    expect(screen.getByRole('status')).toHaveTextContent(label);
    expect(screen.getByRole('status')).toHaveAttribute('data-status', status);
  });

  it('never presents an unfinished trial of a cancelled run as playing', () => {
    render(<ResultBanner status="running" runStatus="cancelled" />);
    expect(screen.getByRole('status')).toHaveTextContent('Stopped (run cancelled)');
  });

  it('shows the backend error for errored trials', () => {
    render(<ResultBanner status="error" error={{ code: 'upstream_timeout', message: 'timed out' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('upstream_timeout: timed out');
  });
});

describe('CubeNet', () => {
  it('renders all 54 facelets', () => {
    const { container } = render(<CubeNet facelets={SOLVED} />);
    expect(container.querySelectorAll('.cube-net__sticker')).toHaveLength(54);
    expect(container.querySelectorAll('[data-face]')).toHaveLength(6);
  });

  it('shows a placeholder instead of a broken cube for a malformed string', () => {
    render(<CubeNet facelets="UUU" label="Lane" />);
    expect(screen.getByRole('img', { name: 'Lane: unavailable' })).toHaveTextContent('State unavailable');
  });
});

describe('MoveHistory', () => {
  it('lists applied moves with latency and confidence, and rejected outputs inline', () => {
    const trial = finalSnapshot.trials.find((t) => t.model_id === 'typesafe/jev-1.13' && t.moves.length > 0)!;
    render(
      <MoveHistory
        moves={trial.moves}
        invalid={[{ seq: 99, ts: '', move_index: 2, attempt: 1, reason: 'illegal_move', raw_response: 'R3' }]}
      />,
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(trial.moves.length + 1);
    expect(rows[1]).toHaveTextContent('Illegal move (attempt 1)');
    expect(rows[1]).toHaveTextContent('R3');
    expect(rows[0]).toHaveTextContent(trial.moves[0]!.move);
  });
});

describe('StatsDashboard', () => {
  it('renders every model with backend-provided values', () => {
    render(<StatsDashboard stats={finalStats} error={null} loading={false} onRetry={() => undefined} />);
    const table = screen.getByRole('table', { name: 'Benchmark statistics per model' });
    for (const m of finalStats.models) {
      const row = within(table).getByText(m.label).closest('tr')!;
      expect(row).toHaveTextContent(String(m.total_moves));
    }
    const clef = within(table).getByText('Cloudflare Clef').closest('tr')!;
    expect(clef).toHaveTextContent('66.7%');
    expect(clef).toHaveTextContent('(2/3)');
    expect(clef).toHaveTextContent('115 ms');
    expect(clef).toHaveTextContent('Fastest');
    expect(screen.getByText('Final')).toBeInTheDocument();
  });

  it('answers the assignment questions from questions_answered', () => {
    render(<QuestionsAnswered stats={finalStats} />);
    expect(screen.getByText('Q1 · Fastest at making decisions').closest('.answer')).toHaveTextContent('Cloudflare Clef');
    expect(screen.getByText('Q2 · Highest solve rate').closest('.answer')).toHaveTextContent('Jev 1.13');
    expect(screen.getByText(/Shortest solutions/).closest('.answer')).toHaveTextContent('Claude Opus 5.5');
    expect(screen.getByText(/Did the fastest model/).closest('.answer')).toHaveTextContent('No');
    expect(screen.getByText(/What would you deploy/).closest('.answer')).toHaveClass('answer--open');
  });

  it('marks partial stats and shows null metrics as dashes', () => {
    const partial = {
      ...finalStats,
      run_status: 'running' as const,
      models: finalStats.models.map((m) => ({ ...m, trials: 0, solved_trials: 0, avg_move_latency_ms: null, success_rate_pct: null })),
    };
    render(<StatsDashboard stats={partial} error={null} loading={false} onRetry={() => undefined} />);
    expect(screen.getByText('Partial: run running')).toBeInTheDocument();
    expect(screen.getAllByText('no data').length).toBeGreaterThan(0);
  });
});

describe('IdentityBadge', () => {
  it('shows name and roll number', () => {
    render(<IdentityBadge name="Ada Lovelace" roll="21K-1234" />);
    const badge = screen.getByTestId('identity-badge');
    expect(badge).toHaveTextContent('Ada Lovelace');
    expect(badge).toHaveTextContent('21K-1234');
    expect(badge).toHaveAccessibleName('Student Ada Lovelace, roll number 21K-1234');
  });

  it('warns loudly when identity is not configured', () => {
    render(<IdentityBadge name="" roll="" />);
    expect(screen.getByRole('alert')).toHaveTextContent('STUDENT IDENTITY MISSING');
    expect(screen.getByRole('alert')).toHaveTextContent('VITE_STUDENT_NAME and VITE_STUDENT_ROLL');
  });
});
