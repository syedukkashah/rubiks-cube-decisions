import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../api/types';
import { events, finalSnapshot, initialSnapshot, midSnapshot } from '../test/fixtureData';
import { initialRunState, runReducer, type RunState } from './runReducer';
import { trialsOf } from './selectors';

const RUN = 'run_01';
const start = () => runReducer(initialRunState, { type: 'reset', runId: RUN });
const snap = (s: RunState, snapshot = initialSnapshot) => runReducer(s, { type: 'snapshot', snapshot });
const feed = (s: RunState, evs: RunEvent[]) => evs.reduce((acc, event) => runReducer(acc, { type: 'event', event }), s);
const bySeq = (seq: number) => events.find((e) => e.seq === seq)!;

/** Deterministic shuffle so failures reproduce. */
function shuffle<T>(xs: T[], seed = 7): T[] {
  const out = [...xs];
  let a = seed;
  for (let i = out.length - 1; i > 0; i--) {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    const j = a % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('runReducer: snapshot + seq-ordered events', () => {
  it('replaying the recorded stream from the initial snapshot reproduces the final backend snapshot', () => {
    const s = feed(snap(start()), events);
    expect(s.lastSeq).toBe(finalSnapshot.last_seq);
    expect(s.status).toBe('completed');
    expect(trialsOf(s)).toEqual(finalSnapshot.trials);
    expect(s.pending).toEqual({});
  });

  it('live events up to a checkpoint match the backend snapshot taken at that seq', () => {
    const s = feed(snap(start()), events.filter((e) => e.seq <= midSnapshot.last_seq));
    expect(s.status).toBe(midSnapshot.status);
    for (const expected of midSnapshot.trials) {
      const t = s.trials[expected.trial_id]!;
      expect(t.status).toBe(expected.status);
      expect(t.moves).toEqual(expected.moves);
      expect(t.moves_used).toBe(expected.moves_used);
      expect(t.current_facelets).toBe(expected.current_facelets);
      expect(t.solved).toBe(expected.solved);
      expect(t.started_at).toBe(expected.started_at);
    }
  });

  it('resumes from a mid-run snapshot: events with seq <= last_seq are discarded', () => {
    // the whole stream arrives again (as on a reconnect without after_seq); only seq > 89 may apply
    const s = feed(snap(start(), midSnapshot), events);
    expect(midSnapshot.last_seq).toBeGreaterThan(0);
    expect(trialsOf(s)).toEqual(finalSnapshot.trials);
    expect(s.lastSeq).toBe(finalSnapshot.last_seq);
  });

  it('applies out-of-order and duplicated delivery in seq order', () => {
    const noisy = shuffle([...events, ...events.slice(10, 60)]);
    const s = feed(snap(start()), noisy);
    expect(trialsOf(s)).toEqual(finalSnapshot.trials);
    expect(s.lastSeq).toBe(finalSnapshot.last_seq);
  });

  it('buffers events after a gap until the missing seq arrives', () => {
    let s = feed(snap(start()), [bySeq(1), bySeq(2), bySeq(4), bySeq(5)]);
    expect(s.lastSeq).toBe(2);
    expect(Object.keys(s.pending).map(Number)).toEqual([4, 5]);
    s = feed(s, [bySeq(3)]);
    expect(s.lastSeq).toBe(5);
    expect(s.pending).toEqual({});
  });

  it('buffers events that arrive before the first snapshot, then drains the ones after last_seq', () => {
    const early = events.filter((e) => e.seq > midSnapshot.last_seq - 5 && e.seq <= midSnapshot.last_seq + 5);
    let s = feed(start(), early);
    expect(s.loaded).toBe(false);
    expect(s.lastSeq).toBe(0);
    s = snap(s, midSnapshot);
    expect(s.lastSeq).toBe(midSnapshot.last_seq + 5);
    expect(s.pending).toEqual({});
  });

  it('ignores a snapshot older than what is already applied', () => {
    const s = feed(snap(start()), events.slice(0, 120));
    const after = snap(s, midSnapshot); // last_seq 89 < 120
    expect(after).toBe(s);
  });

  it('a newer snapshot repairs a gap and keeps later buffered events', () => {
    // seq 89 lost: 90..95 wait in pending until a snapshot covering 89 arrives
    let s = feed(snap(start()), events.filter((e) => e.seq <= 88 || (e.seq >= 90 && e.seq <= 95)));
    expect(s.lastSeq).toBe(88);
    s = snap(s, midSnapshot);
    expect(s.lastSeq).toBe(95);
  });

  it('ignores events from another run', () => {
    const foreign = { ...bySeq(1), run_id: 'run_other' };
    const s = feed(snap(start()), [foreign]);
    expect(s.lastSeq).toBe(0);
  });

  it('an unknown event type still advances seq so ordering does not stall', () => {
    const unknown: RunEvent = { seq: 1, type: 'unknown', run_id: RUN, trial_id: null, ts: '', data: {} };
    const s = feed(snap(start()), [unknown, bySeq(2)]);
    expect(s.lastSeq).toBe(2);
  });
});

describe('runReducer: live move state', () => {
  it('tracks waiting, invalid outputs and applied moves for a trial', () => {
    const invalid = events.find((e) => e.type === 'move_invalid')!;
    const upTo = (seq: number) => feed(snap(start()), events.filter((e) => e.seq <= seq));
    const tid = invalid.trial_id!;

    const requested = events.filter((e) => e.type === 'move_requested' && e.trial_id === tid && e.seq < invalid.seq).at(-1)!;
    expect(upTo(requested.seq).live[tid]?.awaiting).toEqual({ ...requested.data, ts: requested.ts });

    const afterInvalid = upTo(invalid.seq);
    expect(afterInvalid.live[tid]?.awaiting).toBeNull();
    expect(afterInvalid.live[tid]?.invalid).toHaveLength(1);
    expect(afterInvalid.live[tid]?.invalid[0]).toMatchObject({ reason: invalid.type === 'move_invalid' ? invalid.data.reason : '' });

    const applied = events.find((e) => e.type === 'move_applied' && e.trial_id === tid && e.seq > invalid.seq)!;
    const afterApplied = upTo(applied.seq);
    expect(afterApplied.live[tid]?.awaiting).toBeNull();
    const t = afterApplied.trials[tid]!;
    expect(t.moves.at(-1)?.index).toBe(applied.type === 'move_applied' ? applied.data.index : -1);
    expect(t.current_facelets).toBe(applied.type === 'move_applied' ? applied.data.facelets_after : '');
    // move records never carry the event-only fields
    expect(Object.keys(t.moves.at(-1)!)).not.toContain('moves_used');
  });

  it('keeps the latest events newest first for the event stream', () => {
    const s = feed(snap(start()), events);
    expect(s.recentEvents.map((e) => e.seq)).toEqual(events.slice(-8).map((e) => e.seq).reverse());
  });

  it('bumps statsEpoch on trial and run completion', () => {
    const s0 = snap(start());
    const s1 = feed(s0, events);
    const finishes = events.filter((e) => e.type === 'trial_finished' || e.type === 'run_finished').length;
    expect(s1.statsEpoch - s0.statsEpoch).toBe(finishes);
  });

  it('records run cancellation and leaves unfinished trials as reported', () => {
    const cut = 40;
    const cancel: RunEvent = {
      seq: cut + 1,
      type: 'run_finished',
      run_id: RUN,
      trial_id: null,
      ts: '2026-10-24T09:31:00Z',
      data: { status: 'cancelled', finished_at: '2026-10-24T09:31:00Z' },
    };
    const s = feed(snap(start()), [...events.filter((e) => e.seq <= cut), cancel]);
    expect(s.status).toBe('cancelled');
    expect(s.finishedAt).toBe('2026-10-24T09:31:00Z');
    expect(trialsOf(s).some((t) => t.status === 'running')).toBe(true);
    expect(Object.values(s.live).every((l) => l.awaiting === null)).toBe(true);
  });
});
