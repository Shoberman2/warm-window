// List prices in USD per million tokens (Anthropic first-party API, cached 2026-10).
// `read` is the cache-read price. Cache writes are a multiple of `input`:
// 1.25x for the 5-minute TTL and 2x for the 1-hour TTL.
// These are estimates for comparison. Check https://claude.com/pricing for current rates.

export const WRITE_5M_MULT = 1.25;
export const WRITE_1H_MULT = 2.0;

const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, read: 1.0 },
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, read: 1.5 },
  'claude-opus-4': { input: 15, output: 75, read: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, read: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, read: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, read: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, read: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, read: 0.08 },
};

const FAMILY_FALLBACK = {
  fable: 'claude-fable-5-1',
  mythos: 'claude-mythos-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

const DEFAULT_MODEL = 'claude-opus-5-5';

/** Returns { input, output, read, write5m, write1h, model, exact } in USD per token. */
export function priceFor(model) {
  const id = String(model || '').toLowerCase().replace(/-\d{8}$/, '');
  let key = PRICES[id] ? id : null;
  if (!key) {
    // Longest known prefix wins, e.g. "claude-opus-4-1-xyz" -> "claude-opus-4-1".
    key = Object.keys(PRICES)
      .filter((k) => id.startsWith(k))
      .sort((a, b) => b.length - a.length)[0] || null;
  }
  const exact = Boolean(key);
  if (!key) {
    const fam = Object.keys(FAMILY_FALLBACK).find((f) => id.includes(f));
    key = fam ? FAMILY_FALLBACK[fam] : DEFAULT_MODEL;
  }
  const p = PRICES[key];
  const M = 1e6;
  return {
    model: key,
    exact,
    input: p.input / M,
    output: p.output / M,
    read: p.read / M,
    write5m: (p.input * WRITE_5M_MULT) / M,
    write1h: (p.input * WRITE_1H_MULT) / M,
  };
}

// OpenAI list prices per 1M tokens: [input, cached read, 30-minute cache write, output].
// Standard tier, short context. No write price = no separate write charge on that model.
// Source: developers.openai.com/api/docs/pricing, checked 2026-11-05.
const OPENAI = {
  'gpt-6-astra': [10, 1, 12.5, 50],
  'gpt-6.1-sol': [2, 0.1, 2.5, 10],
  'gpt-6.1-terra': [1, 0.05, 1.25, 5],
  'gpt-6-luna': [0.1, 0.01, 0.125, 0.5],
  'gpt-6-sol': [2, 0.2, 2.5, 10],
  'gpt-5.6-sol': [4, 0.4, 5, 20],
  'gpt-5.6-terra': [2, 0.2, 2.5, 12],
  'gpt-5.6-luna': [0.2, 0.02, 0.25, 1.2],
  'gpt-5.5': [5, 0.5, 5, 30],
  'gpt-5.5-pro': [30, 30, 30, 180],
  'gpt-5.4': [2.5, 0.25, 2.5, 15],
  'gpt-5.4-pro': [30, 30, 30, 180],
  'gpt-5.4-mini': [0.75, 0.075, 0.75, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 0.2, 1.25],
  'gpt-5.2': [1.75, 0.175, 1.75, 14],
  'gpt-5.2-pro': [21, 21, 21, 168],
  'gpt-5.1': [1.25, 0.125, 1.25, 10],
  'gpt-5': [1.25, 0.125, 1.25, 10],
  'gpt-5-mini': [0.25, 0.025, 0.25, 2],
  'gpt-5-nano': [0.05, 0.005, 0.05, 0.4],
  'gpt-5-pro': [15, 15, 15, 120],
};
const OPENAI_NAMES = Object.keys(OPENAI).sort((a, b) => b.length - a.length);

/** Per-token prices for an OpenAI model, or null if we don't know it. We never guess a price. */
export function priceForOpenAI(model) {
  const name = OPENAI_NAMES.find((n) => model === n || model.startsWith(`${n}-`));
  if (!name) return null;
  const [input, read, write, output] = OPENAI[name].map((x) => x / 1e6);
  return { model: name, input, read, write, output };
}
