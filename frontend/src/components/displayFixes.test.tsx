// Layout and display fixes: long opaque IDs are cut visually but stay whole in the DOM (title,
// accessible name, copy), and move primes render as one token without changing the move text.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { RunSummary, Trial } from '../api/types';
import { ApiProvider } from '../api/ApiContext';
import { App, ROUTER_FUTURE } from '../App';
import { config } from '../config';
import { formatShortTime, formatTime } from '../lib/format';
import { createMockClient } from '../mocks/mockClient';
import { SetupView } from '../pages/SetupView';
import { initialRunState, runReducer, type RunState } from '../state/runReducer';
import { finalSnapshot } from '../test/fixtureData';
import { EventStream } from './EventStream';
import { ModelLane } from './ModelLane';
import { MoveHistory } from './MoveHistory';
import { MoveText } from './MoveText';
import { PuzzlePanel } from './PuzzlePanel';
import { FinalStates } from './ResultsMatrix';

const LONG_RUN = 'run_392e1aa305404dfcbc02497cc435921d';
const LONG_SESSION = 'sess_1e5e17eabe0d45a887ad52b85aaba03c';
const LONG_PUZZLE = 'pz_645633d28895464fb6bcf145a3fe4574';

function finishedState(): RunState {
  const reset = runReducer(initialRunState, { type: 'reset', runId: finalSnapshot.run_id });
  return runReducer(reset, { type: 'snapshot', snapshot: finalSnapshot });
}

describe('MoveText', () => {
  it("renders a prime as one token and keeps the text exactly as sent (R')", () => {
    const { container } = render(<MoveText move="R'" />);
    const token = container.querySelector('.move')!;
    expect(token).toHaveTextContent(/^R'$/);
    expect(token.querySelectorAll('.move__prime')).toHaveLength(1);
    expect(token.querySelector('.move__prime')).toHaveTextContent("'");
  });

  it('leaves moves without a prime untouched and tightens every prime in raw text', () => {
    const { container, rerender } = render(<MoveText move="U2" />);
    expect(container.querySelector('.move')).toHaveTextContent(/^U2$/);
    expect(container.querySelector('.move__prime')).toBeNull();
    rerender(<MoveText move="R' U' F" />);
    expect(container.querySelector('.move')).toHaveTextContent(/^R' U' F$/);
    expect(container.querySelectorAll('.move__prime')).toHaveLength(2);
  });

  it('is used for applied moves and struck-through raw outputs in the move history', () => {
    const trial = finalSnapshot.trials.find((t) => t.moves.some((m) => m.move.endsWith("'")))!;
    const { container } = render(
      <MoveHistory moves={trial.moves} invalid={[{ seq: 7, ts: '', move_index: 1, attempt: 1, reason: 'illegal_move', raw_response: "R'2" }]} />,
    );
    const primed = trial.moves.filter((m) => m.move.endsWith("'")).length;
    expect(container.querySelectorAll('.history__move .move__prime')).toHaveLength(primed);
    expect(container.querySelector('.history__raw')).toHaveTextContent(/^R'2$/);
    expect(container.querySelector('.history__raw .move__prime')).not.toBeNull();
  });
});

describe('formatShortTime', () => {
  it('drops the seconds, and the year when it is the current one', () => {
    const now = new Date('2026-11-09T18:00:00Z');
    const ts = '2026-11-09T12:58:59Z';
    expect(formatShortTime(ts, now)).not.toContain('2026');
    expect(formatShortTime(ts, now).length).toBeLessThan(formatTime(ts).length);
    expect(formatShortTime('2025-03-01T12:00:00Z', now)).toContain('2025');
    expect(formatShortTime(null, now)).toBe('—');
  });
});

describe('Setup: previous runs', () => {
  const runs: RunSummary[] = [
    { run_id: LONG_RUN, status: 'completed', created_at: '2026-11-09T12:58:59Z', finished_at: null },
    { run_id: 'run_01', status: 'failed', created_at: '2026-11-09T12:26:27Z', finished_at: null },
  ];
  const renderSetup = () => {
    const onOpenRun = vi.fn();
    const onOpenSession = vi.fn();
    render(
      <SetupView
        info={null}
        models={null}
        runs={runs}
        lastSessionId={LONG_SESSION}
        busy={null}
        phaseLabel={null}
        onStartSession={() => undefined}
        onStartRun={() => undefined}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />,
    );
    return { onOpenRun, onOpenSession };
  };

  it('keeps the whole ID as selectable text with a tooltip, and gives Open its own labelled button', async () => {
    const { onOpenRun } = renderSetup();
    const list = screen.getByRole('list', { name: 'Previous runs' });
    const id = within(list).getByText(LONG_RUN);
    expect(id).toHaveClass('run-row__id', 'ellipsis');
    expect(id).toHaveAttribute('title', LONG_RUN);
    expect(id.closest('button')).toBeNull(); // plain text, so it can be selected and copied

    const open = within(list).getByRole('button', { name: `Open run ${LONG_RUN}` });
    expect(open).toHaveTextContent(/^Open$/);
    await userEvent.click(open);
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    expect(onOpenRun).toHaveBeenCalledWith(LONG_RUN);
  });

  it('shows status and a short time on one line, with the full time in the tooltip', () => {
    renderSetup();
    const meta = screen.getByText(`Completed · ${formatShortTime('2026-11-09T12:58:59Z')}`);
    expect(meta).toHaveClass('ellipsis');
    expect(meta).toHaveAttribute('title', `Completed · ${formatTime('2026-11-09T12:58:59Z')}`);
  });

  it('opens from the row but not from a click on the ID (that selects it for copying)', async () => {
    const { onOpenRun, onOpenSession } = renderSetup();
    await userEvent.click(screen.getByText(LONG_RUN));
    expect(onOpenRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText(`Completed · ${formatShortTime('2026-11-09T12:58:59Z')}`));
    expect(onOpenRun).toHaveBeenCalledWith(LONG_RUN);

    const session = screen.getByRole('list', { name: 'Last one-click session' });
    expect(within(session).getByText(LONG_SESSION)).toHaveAttribute('title', LONG_SESSION);
    await userEvent.click(within(session).getByRole('button', { name: `Open session ${LONG_SESSION}` }));
    expect(onOpenSession).toHaveBeenCalledWith(LONG_SESSION);
  });
});

describe('Race: puzzles in this run', () => {
  it('labels each row with the puzzle ID in its own column, cut visually but whole in the title', async () => {
    const state = finishedState();
    const cfg = { ...state.config!, puzzle_ids: [LONG_PUZZLE, ...state.config!.puzzle_ids] };
    const onFocus = vi.fn();
    const { container } = render(
      <PuzzlePanel
        state={state}
        config={cfg}
        puzzles={{}}
        models={{}}
        shownPuzzleId={LONG_PUZZLE}
        focusPuzzleId={null}
        onFocus={onFocus}
        runStatus="completed"
      />,
    );
    const table = container.querySelector('.mini-matrix')!;
    // one ID column plus one column per model, so the cells line up under the model headers
    expect(table.querySelectorAll('colgroup col')).toHaveLength(1 + cfg.model_ids.length);
    expect(table.querySelector('col.mini-matrix__id-col')).not.toBeNull();

    const row = within(table as HTMLElement).getByRole('button', { name: LONG_PUZZLE });
    expect(row).toHaveAttribute('title', LONG_PUZZLE);
    expect(row.querySelector('.ellipsis')).toHaveTextContent(LONG_PUZZLE);
    expect(row.closest('th')).toHaveAttribute('scope', 'row');
    await userEvent.click(row);
    expect(onFocus).toHaveBeenCalledWith(LONG_PUZZLE);

    // the scramble head keeps a long ID beside the heading with an ellipsis and a tooltip
    expect(container.querySelector('.panel__meta')).toHaveAttribute('title', LONG_PUZZLE);
  });
});

describe('Race: model lane', () => {
  it("shows the current move's prime as one token and keeps the label on its own line", () => {
    const state = finishedState();
    const trial = state.trials['tr_05'] as Trial; // last move D'
    expect(trial.moves.at(-1)?.move).toBe("D'");
    const { container } = render(
      <ModelLane
        modelId={trial.model_id}
        model={null}
        trial={trial}
        live={null}
        runStatus="completed"
        maxMoves={30}
        timeoutS={15}
        maxRetries={1}
        stats={null}
        now={Date.now()}
      />,
    );
    const glyph = container.querySelector('.lane__glyph')!;
    expect(glyph).toHaveTextContent(/^D'$/);
    expect(glyph.querySelectorAll('.move__prime')).toHaveLength(1);
    // "Current move" is not inside the glyph/caption row, so it never squeezes into a wrap there
    expect(container.querySelector('.lane__move-label')!.closest('.lane__move-row')).toBeNull();
    expect(container.querySelector('.lane__move-row .lane__caption')).toHaveTextContent(`${trial.moves_used} moves`);

    const chips = container.querySelectorAll('.chips [data-chip]');
    expect(chips).toHaveLength(trial.moves.length);
    expect(chips[chips.length - 1]).toHaveClass('is-latest');
    expect(chips[chips.length - 1]!.querySelector('.move__prime')).not.toBeNull();
  });

  it('renders a rejected output with a prime as one token in its invalid chip', () => {
    const state = finishedState();
    const trial = state.trials['tr_05'] as Trial;
    const last = trial.moves.at(-1)!;
    const { container } = render(
      <ModelLane
        modelId={trial.model_id}
        model={null}
        trial={trial}
        live={{ awaiting: null, invalid: [{ seq: 99, ts: '', move_index: last.index, attempt: 1, reason: 'illegal_move', raw_response: "R'2" }] }}
        runStatus="completed"
        maxMoves={30}
        timeoutS={15}
        maxRetries={1}
        stats={null}
        now={Date.now()}
      />,
    );
    const invalid = container.querySelector('.chips .chip-move--invalid')!;
    expect(invalid).toHaveTextContent(/^R'2$/);
    expect(invalid.querySelectorAll('.move__prime')).toHaveLength(1);
    expect(invalid).toHaveAttribute('title', expect.stringContaining('Invalid output'));
    // slotted before the move it preceded, so the applied move stays the newest chip
    expect(invalid.nextElementSibling).toHaveClass('is-latest');
  });
});

describe('Results: final states', () => {
  it('keeps long puzzle IDs whole in the tab titles and splits the detail into unbreakable facts', () => {
    const state = finishedState();
    const longState: RunState = { ...state, config: { ...state.config!, puzzle_ids: [...state.config!.puzzle_ids, LONG_PUZZLE] } };
    render(<FinalStates state={longState} models={{}} puzzleId="pz_01" onSelect={() => undefined} />);
    const tab = screen.getByRole('tab', { name: LONG_PUZZLE });
    expect(tab).toHaveAttribute('title', LONG_PUZZLE);
    expect(tab.querySelector('.ellipsis')).not.toBeNull();

    const limited = state.trials['tr_03'] as Trial; // move_limit on pz_01
    const card = screen.getByText(limited.model_id).closest('article')!;
    const facts = [...card.querySelectorAll('.final-card__fact')].map((f) => f.textContent);
    expect(facts).toEqual([`${limited.moves_used} / 30 moves`, 'not solved']);
    expect(card.querySelector('.final-card__detail')).toHaveTextContent(`${limited.moves_used} / 30 moves · not solved`);
  });
});

describe('Event stream', () => {
  it('does not claim to be waiting for events once the run is over', () => {
    const { rerender } = render(<EventStream events={[]} trials={{}} models={{}} runStatus="running" />);
    expect(screen.getByText('Waiting for the first event…')).toBeInTheDocument();
    rerender(<EventStream events={[]} trials={{}} models={{}} runStatus="completed" />);
    expect(screen.queryByText('Waiting for the first event…')).toBeNull();
    expect(screen.getByText(/the run had already completed when it was opened/)).toBeInTheDocument();
  });
});

describe('Student identity in the header', () => {
  it('renders VITE_STUDENT_NAME / VITE_STUDENT_ROLL exactly as configured', async () => {
    render(
      <MemoryRouter initialEntries={['/']} future={ROUTER_FUTURE}>
        <ApiProvider api={createMockClient({ speed: 0, latencyMs: 0 })}>
          <App />
        </ApiProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: /^Run full benchmark/ });
    const badge = screen.getByTestId('identity-badge');
    const { studentName, studentRoll } = config;
    if (!studentName || !studentRoll) {
      // Not configured in this environment: the badge must say so instead of rendering nothing.
      expect(badge).toHaveAttribute('role', 'alert');
      return;
    }
    // exact strings, no case change (getByText is case-sensitive and matches the whole text)
    expect(within(badge).getByText(studentName)).toHaveClass('identity__name');
    expect(within(badge).getByText(studentRoll)).toHaveClass('identity__roll');
    expect(badge).toHaveAccessibleName(`Student ${studentName}, roll number ${studentRoll}`);
  });
});
