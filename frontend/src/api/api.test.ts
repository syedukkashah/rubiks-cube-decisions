import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, describeError } from './errors';
import { createHttpClient, openEventSource } from './httpClient';
import { normalizeEvent, normalizeRunSnapshot, normalizeTrial } from './normalize';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('normalizers', () => {
  it('drops unknown fields and fills missing nullable fields with null', () => {
    const t = normalizeTrial({ trial_id: 'tr_1', status: 'running', extra_field: 42, moves: [{ index: 1, move: 'R', surprise: true }] });
    expect(t).not.toHaveProperty('extra_field');
    expect(t.moves[0]).not.toHaveProperty('surprise');
    expect(t.total_time_s).toBeNull();
    expect(t.optimality_gap).toBeNull();
    expect(t.finished_at).toBeNull();
    expect(t.error).toBeNull();
    expect(t.moves[0]?.confidence).toBeNull();
  });

  it('rejects events without a usable seq and maps unknown types', () => {
    expect(normalizeEvent({ type: 'run_started', data: {} })).toBeNull();
    expect(normalizeEvent({ seq: 0, type: 'run_started' })).toBeNull();
    expect(normalizeEvent({ seq: 3, type: 'brand_new_event', run_id: 'r' })?.type).toBe('unknown');
  });

  it('splits move_applied into a MoveRecord plus moves_used/solved', () => {
    const e = normalizeEvent({
      seq: 5,
      type: 'move_applied',
      run_id: 'r',
      trial_id: 't',
      ts: 'x',
      data: { index: 2, move: "U'", facelets_before: 'a', facelets_after: 'b', latency_ms: 12.5, confidence: 0.9, retries: 0, moves_used: 2, solved: false },
    });
    expect(e?.type).toBe('move_applied');
    if (e?.type === 'move_applied') {
      expect(e.data).toMatchObject({ index: 2, move: "U'", moves_used: 2, solved: false, confidence: 0.9 });
    }
  });

  it('keeps snapshot trials in backend order', () => {
    const s = normalizeRunSnapshot({ run_id: 'r', status: 'running', trials: [{ trial_id: 'b' }, { trial_id: 'a' }] });
    expect(s.trials.map((t) => t.trial_id)).toEqual(['b', 'a']);
    expect(s.finished_at).toBeNull();
  });
});

describe('http client', () => {
  it('turns an error envelope into an ApiError with the contract code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(503, { error: { code: 'missing_api_key', message: 'OPENROUTER_API_KEY is not set', details: null } }),
    );
    const api = createHttpClient('/api/v1', fetchImpl);
    const err = await api.createRun({ puzzle_ids: ['pz_01'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('missing_api_key');
    expect((err as ApiError).status).toBe(503);
    expect(describeError(err).guidance).toMatch(/OPENROUTER_API_KEY/);
  });

  it('reports the field for validation errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(422, { error: { code: 'validation_error', message: 'max_moves must be between 1 and 30', details: { field: 'max_moves' } } }),
    );
    const err = await createHttpClient('/api/v1', fetchImpl).createRun({ puzzle_ids: ['p'], max_moves: 99 }).catch((e: unknown) => e);
    expect(describeError(err).title).toBe('Invalid value for "max_moves"');
  });

  it('maps a network failure to network_error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await createHttpClient('/api/v1', fetchImpl).getHealth().catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('network_error');
  });

  it('omits null optional request fields and hits the contract paths', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, { puzzles: [] }));
    await createHttpClient('/api/v1', fetchImpl).createPuzzles({ suite: 'primary', count: 5, scramble_length: null, seed: 42 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/puzzles');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ suite: 'primary', count: 5, seed: 42 });
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: MessageEvent) => void) | null = null;
  listeners = new Map<string, (m: MessageEvent) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (m: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('event stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it('resumes with after_seq, parses named events and closes itself on error', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onEvent = vi.fn();
    const onError = vi.fn();
    const api = createHttpClient('/api/v1', vi.fn());
    api.subscribeEvents('run_01', 17, { onEvent, onError });
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/api/v1/runs/run_01/events?after_seq=17');

    es.emit('move_requested', { seq: 18, type: 'move_requested', run_id: 'run_01', trial_id: 't', ts: 'x', data: { move_index: 3, attempt: 1 } });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ seq: 18, type: 'move_requested' }));

    es.onerror?.();
    expect(es.closed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('ignores messages after close', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onEvent = vi.fn();
    const close = openEventSource('/x', { onEvent });
    close();
    FakeEventSource.instances[0]!.emit('run_started', { seq: 1, type: 'run_started', run_id: 'r', data: { trial_count: 1 } });
    expect(onEvent).not.toHaveBeenCalled();
  });
});
