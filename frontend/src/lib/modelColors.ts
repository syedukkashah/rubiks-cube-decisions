// Fixed categorical identity per model (design tokens, docs/design). Color follows the entity,
// never its rank: slots are assigned in GET /models order and never re-assigned by a filter.
// The four slots are kept apart from the status colors (solved / limit / error / running).
// Identity is never color-alone: every swatch sits beside the model label.
const SLOTS = ['#6EA8FE', '#C08CFF', '#3CCBDA', '#FF9466'];

const CONTRACT_ORDER = [
  'typesafe/jev-1.13',
  'openai/gpt-6-luna-decisions',
  'cloudflare/clef',
  'anthropic/claude-opus-5.5',
];

export function modelColor(modelId: string, knownOrder: readonly string[] = CONTRACT_ORDER): string {
  let i = knownOrder.indexOf(modelId);
  if (i < 0) i = CONTRACT_ORDER.indexOf(modelId);
  if (i < 0) return '#A0A6AD';
  return SLOTS[i % SLOTS.length] ?? '#A0A6AD';
}

/** Short lane label, e.g. "Jev 1.13" → "Jev"; falls back to the full label. */
export function shortLabel(label: string): string {
  const known: Record<string, string> = {
    'Jev 1.13': 'Jev',
    'GPT-6 Luna Decisions': 'Luna',
    'Cloudflare Clef': 'Clef',
    'Claude Opus 5.5': 'Opus',
  };
  return known[label] ?? label.split(' ')[0] ?? label;
}
