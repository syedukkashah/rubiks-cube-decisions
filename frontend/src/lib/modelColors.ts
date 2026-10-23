// Fixed categorical identity per model. Color follows the entity, never its rank:
// slots are assigned in GET /models order and never re-assigned by a filter.
// Dark-surface steps, validated as a set (CVD ΔE ≥ 8.4 adjacent, ≥ 3:1 on #1a1a19).
// Identity is never color-alone: every swatch sits beside the model label.
const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const CONTRACT_ORDER = [
  'typesafe/jev-1.13',
  'openai/gpt-6-luna-decisions',
  'cloudflare/clef',
  'anthropic/claude-opus-5.5',
];

export function modelColor(modelId: string, knownOrder: readonly string[] = CONTRACT_ORDER): string {
  let i = knownOrder.indexOf(modelId);
  if (i < 0) i = CONTRACT_ORDER.indexOf(modelId);
  if (i < 0) return '#898781';
  return SLOTS[i % SLOTS.length] ?? '#898781';
}
