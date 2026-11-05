// Reads OpenAI Codex logs (~/.codex/sessions/**/*.jsonl) and measures the idle tax.
// Measuring only: compact and keep-warm simulations are Claude-specific and not tested here.
// Like the Claude reader, this takes token counts and timestamps, never message text.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { linesMatching, loadStreams } from './parse.js';
import { priceForOpenAI } from './pricing.js';

export const DEFAULT_CODEX_DIR = join(homedir(), '.codex', 'sessions');

const MARKERS = ['"type":"token_usage_record"', '"type":"token_count"', '"type":"turn_context"', '"type":"session_meta"'].map(
  (s) => Buffer.from(s),
);

function toCall(t, u, model) {
  const input = u.input_tokens || 0;
  const read = u.cached_input_tokens || 0;
  const write = u.cache_write_input_tokens || 0;
  return { t, model, input, read, write, uncached: Math.max(0, input - read - write), output: u.output_tokens || 0 };
}

/** Parse Codex log lines into one stream. Exported for tests. */
export function parseCodexLines(lines, file = '') {
  const records = new Map(); // response_id -> call
  const counts = [];
  let lastTotal = -1;
  let model = '';
  let project = '';
  let kind = 'main';
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = e.payload || {};
    const t = Date.parse(e.timestamp);
    if (e.type === 'session_meta') {
      if (p.cwd) project = p.cwd;
      if (p.parent_thread_id || (p.source && p.source.subagent)) kind = 'subagent';
    } else if (e.type === 'turn_context') {
      if (p.model) model = p.model;
      if (!project && p.cwd) project = p.cwd;
    } else if (Number.isNaN(t)) {
      continue;
    } else if (e.type === 'token_usage_record' && p.usage) {
      records.set(p.response_id || `${e.timestamp}:${records.size}`, toCall(t, p.usage, model));
    } else if (e.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) {
      // Older logs only have this, and repeat it. The running total moves only on a new response.
      const total = (p.info.total_token_usage || {}).total_tokens ?? -2;
      if (total !== lastTotal) counts.push(toCall(t, p.info.last_token_usage, model));
      lastTotal = total;
    }
  }
  const calls = records.size ? [...records.values()] : counts;
  calls.sort((a, b) => a.t - b.t);
  return { file, project, kind, calls };
}

export function parseCodexFile(path) {
  return parseCodexLines(linesMatching(path, MARKERS), path);
}

export function loadCodex(dir, opts = {}) {
  return loadStreams(dir, { ...opts, parser: parseCodexFile });
}

const BUCKETS = [
  { label: '5-15 min', max: 15 },
  { label: '15-60 min', max: 60 },
  { label: '1-4 h', max: 240 },
  { label: '4-24 h', max: 1440 },
  { label: '> 1 day', max: Infinity },
];

export function analyzeCodex(streams, { minWrite = 20000, minGapMin = 5 } = {}) {
  const totals = { calls: 0, streams: streams.length, readTokens: 0, inputTokens: 0, spend: 0, firstT: Infinity, lastT: 0 };
  const unknown = new Set();
  const byProject = new Map();
  const buckets = BUCKETS.map((b) => ({ ...b, main: 0, subagent: 0, tax: 0 }));
  const idle = { events: 0, tokens: 0, tax: 0, main: { events: 0, tax: 0 }, subagent: { events: 0, tax: 0 } };

  for (const s of streams) {
    let prev = null;
    for (const c of s.calls) {
      totals.calls++;
      totals.readTokens += c.read;
      totals.inputTokens += c.input;
      totals.firstT = Math.min(totals.firstT, c.t);
      totals.lastT = Math.max(totals.lastT, c.t);
      const p = priceForOpenAI(c.model);
      if (!p) {
        if (c.model) unknown.add(c.model);
        prev = c;
        continue;
      }
      totals.spend += c.uncached * p.input + c.read * p.read + c.write * p.write + c.output * p.output;
      if (prev) {
        const g = (c.t - prev.t) / 60000;
        // Tokens that were already in the conversation and had to be processed again.
        // New content on this turn would cost the same either way, so it isn't idle tax.
        const redone = Math.min(c.uncached + c.write, Math.max(0, prev.input - c.read));
        if (g > minGapMin && redone >= minWrite && c.read < 0.5 * prev.input) {
          const paid = c.uncached + c.write;
          const rate = paid ? (c.uncached * p.input + c.write * p.write) / paid : p.input;
          const tax = redone * (rate - p.read);
          idle.events++;
          idle.tokens += redone;
          idle.tax += tax;
          idle[s.kind].events++;
          idle[s.kind].tax += tax;
          const b = buckets.find((x) => g <= x.max);
          b[s.kind]++;
          b.tax += tax;
          const key = s.project || '(unknown)';
          const r = byProject.get(key) || { project: key, events: 0, tax: 0, tokens: 0 };
          r.events++;
          r.tax += tax;
          r.tokens += redone;
          byProject.set(key, r);
        }
      }
      prev = c;
    }
  }
  return {
    totals: { ...totals, unknownModels: [...unknown], hitRate: totals.inputTokens ? totals.readTokens / totals.inputTokens : 0 },
    idle: {
      ...idle,
      shareOfSpend: totals.spend ? idle.tax / totals.spend : 0,
      avgRedone: idle.events ? idle.tokens / idle.events : 0,
      buckets: buckets.map(({ max, ...b }) => b),
    },
    projects: [...byProject.values()].sort((a, b) => b.tax - a.tax),
  };
}
