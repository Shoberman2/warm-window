// Measures the idle tax from calls saved by `warm-window record`, for any model on any server.
// A hosted model costs money. A local model costs time, so it's reported in seconds.

import { existsSync, readFileSync } from 'node:fs';

const LOCAL = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|.*\.local$)/;
export const isLocal = (host) => LOCAL.test(host || '');

export const DEFAULT_LOCAL_MIN = 2000; // local contexts are smaller, and 2k tokens is already a visible wait
const BUCKETS = [
  { label: 'under 5 min', max: 5 },
  { label: '5-15 min', max: 15 },
  { label: '15-60 min', max: 60 },
  { label: '1-4 h', max: 240 },
  { label: '> 4 h', max: Infinity },
];

export function loadCalls(path, { sinceMs = 0 } = {}) {
  if (!existsSync(path)) return [];
  const calls = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const c = JSON.parse(line);
      if (c.t >= sinceMs) calls.push(c);
    } catch {
      // a half-written last line
    }
  }
  return calls;
}

/** "--price 0.14,0.014,0.28" or with a fourth cache-write number. Dollars per million tokens. */
export function parsePrice(s) {
  if (!s) return null;
  const n = s.split(',').map(Number);
  if ((n.length !== 3 && n.length !== 4) || n.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return { input: n[0], read: n[1], output: n[2], write: n[3] ?? n[0] };
}

const waitOf = (c) => (c.promptMs !== undefined ? c.promptMs + (c.loadMs || 0) : c.ttftMs ?? null);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function analyzeOpen(rawCalls, { price = null, minWrite = null, minGapMin = 5 } = {}) {
  // vLLM leaves the cached count out on a full miss. If a model reports it on any call,
  // a missing count on that model means zero, not unknown.
  const reports = new Set(rawCalls.filter((c) => c.cached !== null).map((c) => `${c.host}|${c.model}`));
  const calls = rawCalls.map((c) => (c.cached === null && c.input !== null && reports.has(`${c.host}|${c.model}`) ? { ...c, cached: 0 } : c));
  const convs = new Map();
  for (const c of calls) {
    const k = `${c.host}|${c.conv}`;
    if (!convs.has(k)) convs.set(k, []);
    convs.get(k).push(c);
  }

  // Walk each conversation once to find what a normal warm wait looks like per model.
  const warm = new Map();
  for (const list of convs.values()) {
    list.sort((a, b) => a.t - b.t);
    list.forEach((c, i) => {
      const w = waitOf(c);
      const gap = i ? (c.t - list[i - 1].t) / 60000 : Infinity;
      if (w === null || gap > minGapMin) return;
      if (c.cached !== null && c.input && c.cached < 0.5 * c.input) return;
      if (!warm.has(c.model)) warm.set(c.model, []);
      warm.get(c.model).push(w);
    });
  }
  const warmWait = (m) => median(warm.get(m) || []);

  const byModel = new Map();
  const buckets = BUCKETS.map((b) => ({ ...b, events: 0, seconds: 0, tax: 0 }));
  const idle = { events: 0, tokens: 0, seconds: 0, tax: 0, timeOnly: 0 };
  const totals = { calls: calls.length, conversations: convs.size, spend: 0, inputTokens: 0, readTokens: 0, firstT: Infinity, lastT: 0, noCacheData: 0 };

  for (const list of convs.values()) {
    list.forEach((c, i) => {
      const local = isLocal(c.host);
      totals.firstT = Math.min(totals.firstT, c.t);
      totals.lastT = Math.max(totals.lastT, c.t);
      if (c.cached === null) totals.noCacheData++;
      else {
        totals.inputTokens += c.input || 0;
        totals.readTokens += c.cached;
      }
      const m =
        byModel.get(`${c.host}|${c.model}`) ||
        { host: c.host, model: c.model, local, calls: 0, events: 0, tokens: 0, seconds: 0, tax: 0, spend: 0, priced: false };
      byModel.set(`${c.host}|${c.model}`, m);
      m.calls++;
      const uncached = Math.max(0, (c.input || 0) - (c.cached || 0) - (c.write || 0));
      const rates = !local ? price : null;
      if (c.cost !== undefined) {
        m.spend += c.cost;
        m.priced = true;
      } else if (rates) {
        m.spend += (uncached * rates.input + (c.cached || 0) * rates.read + (c.write || 0) * rates.write + (c.output || 0) * rates.output) / 1e6;
        m.priced = true;
      }
      if (!i) return;
      const prev = list[i - 1];
      const gap = (c.t - prev.t) / 60000;
      if (gap <= minGapMin) return;

      const usual = warmWait(c.model);
      const wait = waitOf(c);
      let redone = 0;
      let cold;
      if (c.cached !== null && prev.input) {
        redone = Math.min(uncached + (c.write || 0), Math.max(0, prev.input - c.cached));
        cold = redone >= (minWrite ?? (local ? DEFAULT_LOCAL_MIN : 20000)) && c.cached < 0.5 * prev.input;
      } else {
        // The server doesn't report cache use, so the only evidence is a much longer wait.
        cold = wait !== null && usual !== null && (warm.get(c.model) || []).length >= 3 && wait > 2 * usual;
        if (cold) idle.timeOnly++;
      }
      if (!cold) return;

      const seconds = wait === null ? 0 : Math.max(0, wait - (usual ?? 0)) / 1000;
      const tax = rates ? (redone * (((uncached + c.write) ? (uncached * rates.input + c.write * rates.write) / (uncached + c.write) : rates.input) - rates.read)) / 1e6 : 0;
      idle.events++;
      idle.tokens += redone;
      idle.seconds += seconds;
      idle.tax += tax;
      m.events++;
      m.tokens += redone;
      m.seconds += seconds;
      m.tax += tax;
      const b = buckets.find((x) => gap <= x.max);
      b.events++;
      b.seconds += seconds;
      b.tax += tax;
    });
  }
  const models = [...byModel.values()].sort((a, b) => b.seconds - a.seconds || b.tax - a.tax);
  for (const m of models) totals.spend += m.spend;
  return {
    totals: { ...totals, hitRate: totals.inputTokens ? totals.readTokens / totals.inputTokens : null },
    idle: { ...idle, buckets: buckets.map(({ max, ...b }) => b) },
    models,
    unpriced: models.filter((m) => !m.local && !m.priced).map((m) => m.model),
  };
}
