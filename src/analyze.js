// Finds "idle returns" (you came back after a break and the whole conversation had to be
// re-cached) and simulates what different idle policies would have cost on the same gaps.
//
// Every number is an estimate built from token counts in your logs and list prices.
// The simulations assume the conversation would have gone the same way, which is not
// strictly true: compaction shrinks later turns too (makes it cheaper) but loses detail.

import { priceFor } from './pricing.js';

export const DEFAULTS = {
  minWrite: 20000, // a cache write at least this big after a gap counts as a full re-cache
  minGapMin: 5, // shortest gap that can expire a cache (5-minute TTL)
  summaryTokens: 10000, // size of a compaction summary
  prefixTokens: 27000, // system prompt + tools re-cached after a compaction (measured live on Claude Code)
  hybridCandidates: [15, 30, 60, 120, 240, 480], // minutes to keep warm before compacting
};

const BUCKETS = [
  ['5-15 min', 5, 15],
  ['15-60 min', 15, 60],
  ['1-4 h', 60, 240],
  ['4-24 h', 240, 1440],
  ['> 1 day', 1440, Infinity],
];

function writeCost(c, p) {
  return c.w5m * p.write5m + c.w1h * p.write1h;
}

/** TTL in minutes that was in force for this stream after call `c`. */
function ttlAfter(c, prevTtl) {
  if (c.w1h > 0) return 60;
  if (c.w5m > 0) return 5;
  return prevTtl;
}

export function analyze(streams, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const S = o.summaryTokens;
  const PREFIX = o.prefixTokens;

  const totals = {
    calls: 0,
    streams: streams.length,
    readTokens: 0,
    writeTokens: 0,
    write5mTokens: 0,
    write1hTokens: 0,
    readCost: 0,
    writeCost: 0,
    firstT: Infinity,
    lastT: 0,
    unknownModels: new Set(),
  };

  const events = []; // idle returns
  const gaps = []; // every gap long enough for a policy to act on
  const ends = []; // main sessions at their last call

  for (const s of streams) {
    let ttl = 5;
    let prev = null;
    for (const c of s.calls) {
      const p = priceFor(c.model);
      if (!p.exact && c.model) totals.unknownModels.add(c.model);
      totals.calls++;
      totals.readTokens += c.read;
      totals.writeTokens += c.write;
      totals.write5mTokens += c.w5m;
      totals.write1hTokens += c.w1h;
      totals.readCost += c.read * p.read;
      totals.writeCost += writeCost(c, p);
      totals.firstT = Math.min(totals.firstT, c.t);
      totals.lastT = Math.max(totals.lastT, c.t);

      if (prev) {
        const g = (c.t - prev.t) / 60000;
        if (g >= 4) {
          const ctx = c.read + c.write + c.input;
          // Cold = big write AND reads collapsed. A big write on top of a healthy read is just new content.
          const prevCtx = prev.read + prev.write + prev.input;
          const missed = c.write >= o.minWrite && g > o.minGapMin && c.read < 0.5 * prevCtx;
          const gap = {
            g,
            ttl,
            ctx,
            missed,
            write: c.write,
            w5m: c.w5m,
            actual: writeCost(c, p),
            p,
            project: s.project,
            kind: s.kind || 'main',
            t: c.t,
          };
          gaps.push(gap);
          if (missed) events.push(gap);
        }
      }
      ttl = ttlAfter(c, ttl);
      prev = c;
    }
    // A main session that ended. Nothing can know you won't return, so a live policy keeps paying.
    if (prev && s.kind !== 'subagent') {
      const ctx = prev.read + prev.write + prev.input;
      if (ctx >= o.minWrite) ends.push({ t: prev.t, ttl, ctx, p: priceFor(prev.model) });
    }
  }
  const scanEnd = totals.lastT;

  // ---- idle tax: what the idle re-caches cost, minus what they'd cost as warm cache reads
  let idleWriteTokens = 0;
  let idleCost = 0;
  let idleTax = 0;
  for (const e of events) {
    idleWriteTokens += e.write;
    idleCost += e.actual;
    idleTax += e.actual - e.write * e.p.read;
  }

  const buckets = BUCKETS.map(([label, lo, hi]) => {
    const inB = events.filter((e) => e.g > lo && e.g <= hi);
    return {
      label,
      events: inB.length,
      main: inB.filter((e) => e.kind === 'main').length,
      subagent: inB.filter((e) => e.kind === 'subagent').length,
      tokens: inB.reduce((a, e) => a + e.write, 0),
      cost: inB.reduce((a, e) => a + e.actual, 0),
    };
  });

  // ---- what a policy spends on sessions that never came back
  // No summary write here: a compacted session nobody resumes never re-caches anything.
  const endCost = (K, thenCompact) => {
    let cost = 0;
    let compactions = 0;
    let pings = 0;
    for (const e of ends) {
      const idle = (scanEnd - e.t) / 60000;
      const n = Math.floor(Math.min(idle, K) / pingEvery(e.ttl));
      pings += n;
      cost += n * e.ctx * e.p.read;
      if (thenCompact && idle > K) {
        cost += e.ctx * e.p.read + S * e.p.output;
        compactions++;
      }
    }
    return { cost, compactions, pings };
  };

  // ---- policy simulations over every gap >= 4 min
  const pingEvery = (ttl) => (ttl >= 60 ? 55 : 4.5);
  const compactAt = (ttl) => (ttl >= 60 ? 55 : 4);
  const summaryWrite = (gp) => (S + PREFIX) * (gp.ttl >= 60 ? gp.p.write1h : gp.p.write5m);
  const compactCost = (gp) => gp.ctx * gp.p.read + S * gp.p.output + summaryWrite(gp);

  // Nothing outside a running subagent can ping or compact it. Only a longer TTL reaches it.
  const untouchable = (gp) => gp.kind === 'subagent';

  const policyActual = () => gaps.reduce((a, gp) => a + gp.actual, 0);

  // A) Force 1-hour TTL on every write.
  function policyTtl1h() {
    let cost = 0;
    for (const gp of gaps) {
      if (gp.missed && gp.g <= 60) cost += gp.write * gp.p.read;
      else if (gp.missed) cost += gp.write * gp.p.write1h;
      else cost += gp.actual;
    }
    // Every 5-minute write anywhere now costs the 1-hour rate.
    let surcharge = 0;
    for (const s of streams)
      for (const c of s.calls) {
        if (!c.w5m) continue;
        const p = priceFor(c.model);
        surcharge += c.w5m * (p.write1h - p.write5m);
      }
    // Cold returns were already repriced above, so they don't pay the surcharge again.
    for (const gp of gaps) if (gp.missed) surcharge -= gp.w5m * (gp.p.write1h - gp.p.write5m);
    return { cost: cost + surcharge, surcharge };
  }

  // B) Compact just before the cache would expire.
  function policyCompact() {
    let cost = 0;
    let compactions = 0;
    for (const gp of gaps) {
      if (untouchable(gp)) cost += gp.actual;
      else if (gp.g > compactAt(gp.ttl)) {
        cost += compactCost(gp);
        compactions++;
      } else cost += gp.actual;
    }
    let endSpend = 0;
    for (const e of ends) {
      if ((scanEnd - e.t) / 60000 > compactAt(e.ttl)) {
        endSpend += e.ctx * e.p.read + S * e.p.output;
        compactions++;
      }
    }
    return { cost: cost + endSpend, compactions, endSpend };
  }

  // C) Keep the cache warm with tiny pings for up to K minutes, then (optionally) compact.
  function policyHybrid(K, thenCompact) {
    let cost = 0;
    let compactions = 0;
    let pings = 0;
    for (const gp of gaps) {
      if (untouchable(gp)) {
        cost += gp.actual;
        continue;
      }
      const every = pingEvery(gp.ttl);
      const n = Math.floor(Math.min(gp.g, K) / every);
      pings += n;
      cost += n * gp.ctx * gp.p.read;
      if (gp.g <= K) {
        cost += gp.missed ? gp.write * gp.p.read : gp.actual;
      } else if (thenCompact) {
        cost += compactCost(gp);
        compactions++;
      } else {
        cost += gp.actual;
      }
    }
    const end = endCost(K, thenCompact);
    return {
      cost: cost + end.cost,
      compactions: compactions + end.compactions,
      pings: pings + end.pings,
      endSpend: end.cost,
    };
  }

  // D) Hindsight: the cheapest choice for each gap if you knew when you'd return.
  function policyOracle() {
    let cost = 0;
    for (const gp of gaps) {
      if (untouchable(gp)) {
        cost += gp.actual;
        continue;
      }
      const warm =
        Math.floor(gp.g / pingEvery(gp.ttl)) * gp.ctx * gp.p.read +
        (gp.missed ? gp.write * gp.p.read : gp.actual);
      cost += Math.min(gp.actual, warm, compactCost(gp));
    }
    return { cost };
  }

  const actual = policyActual();
  const hybrids = o.hybridCandidates.map((K) => ({ K, ...policyHybrid(K, true) }));
  const bestHybrid = hybrids.reduce((a, b) => (b.cost < a.cost ? b : a));
  const bestKeepWarm = o.hybridCandidates
    .map((K) => ({ K, ...policyHybrid(K, false) }))
    .reduce((a, b) => (b.cost < a.cost ? b : a));

  const policies = [
    { key: 'actual', name: 'What you did', cost: actual, note: '' },
    {
      key: 'ttl1h',
      name: 'Force 1-hour cache everywhere (ENABLE_PROMPT_CACHING_1H)',
      ...policyTtl1h(),
    },
    { key: 'compact', name: 'Compact right before the cache expires', ...policyCompact() },
    {
      key: 'keepwarm',
      name: `Keep warm up to ${bestKeepWarm.K} min, then let it expire`,
      ...bestKeepWarm,
    },
    {
      key: 'hybrid',
      name: `Keep warm up to ${bestHybrid.K} min, then compact (Warm Window)`,
      ...bestHybrid,
    },
    { key: 'oracle', name: 'Best possible (hindsight, not achievable)', ...policyOracle() },
  ].map((pl) => ({ ...pl, saved: actual - pl.cost, savedPct: actual ? (actual - pl.cost) / actual : 0 }));

  // per-project idle tax
  const byProject = new Map();
  for (const e of events) {
    const k = e.project || '(unknown)';
    const r = byProject.get(k) || { project: k, events: 0, tax: 0, tokens: 0 };
    r.events++;
    r.tax += e.actual - e.write * e.p.read;
    r.tokens += e.write;
    byProject.set(k, r);
  }

  const byKind = {};
  for (const k of ['main', 'subagent']) {
    const ev = events.filter((e) => e.kind === k);
    byKind[k] = {
      events: ev.length,
      tokens: ev.reduce((a, e) => a + e.write, 0),
      tax: ev.reduce((a, e) => a + e.actual - e.write * e.p.read, 0),
    };
  }

  const cacheSpend = totals.readCost + totals.writeCost;
  return {
    options: o,
    totals: { ...totals, unknownModels: [...totals.unknownModels], cacheSpend },
    idle: {
      events: events.length,
      writeTokens: idleWriteTokens,
      shareOfWrites: totals.writeTokens ? idleWriteTokens / totals.writeTokens : 0,
      cost: idleCost,
      tax: idleTax,
      shareOfCacheSpend: cacheSpend ? idleTax / cacheSpend : 0,
      avgRewrite: events.length ? idleWriteTokens / events.length : 0,
      byKind,
      buckets,
    },
    gapsConsidered: gaps.length,
    policies,
    hybrids: hybrids.map(({ K, cost }) => ({ K, cost, saved: actual - cost })),
    projects: [...byProject.values()].sort((a, b) => b.tax - a.tax),
  };
}
