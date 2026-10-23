// Display formatting only (rounding, units, placeholders). Values come from the backend.

export const DASH = '—';

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Seconds, switching to minutes past 90 s (assignment: "seconds or minutes"). */
export function formatSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return DASH;
  if (s < 90) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m} min ${String(rest).padStart(2, '0')} s`;
}

export function formatPct(p: number | null | undefined): string {
  if (p === null || p === undefined) return DASH;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

export function formatNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return DASH;
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

/** Optimality gap: 0 reads as optimal, positive values carry a sign. */
export function formatGap(g: number | null | undefined): string {
  if (g === null || g === undefined) return DASH;
  if (g === 0) return '0 (optimal)';
  return `+${formatNumber(g)}`;
}

export function formatConfidence(c: number | null | undefined): string {
  if (c === null || c === undefined) return DASH;
  return `${Math.round(c * 100)}%`;
}

export function formatTime(ts: string | null | undefined): string {
  if (!ts) return DASH;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const INVALID_REASON_LABEL: Record<string, string> = {
  illegal_move: 'Illegal move',
  malformed_response: 'Malformed response',
  timeout: 'Timeout',
  upstream_error: 'Upstream error',
};
