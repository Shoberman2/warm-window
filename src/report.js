import { basename } from 'node:path';

export const REPO = 'https://github.com/Shoberman2/warm-window';
export const AUTO_POLICY_ISSUE = `${REPO}/issues/1`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c('1');
const dim = c('2');
const green = c('32');
const yellow = c('33');
const cyan = c('36');

export const usd = (n) => {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  return `${sign}$${a >= 100 ? a.toFixed(0) : a.toFixed(2)}`;
};
export const tok = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
};
export const pct = (x) => `${(x * 100).toFixed(1)}%`;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - visible(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - visible(s))) + String(s);
// eslint-disable-next-line no-control-regex
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;

function bar(frac, width = 24) {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return '█'.repeat(n) + dim('░'.repeat(width - n));
}

export function receiptLine(r) {
  return `My Claude Code idle tax: ${usd(r.idle.tax)} across ${r.idle.events} cold returns (${pct(
    r.idle.shareOfCacheSpend,
  )} of cache spend). Check yours: npx warm-window scan`;
}

export function renderReport(r, { showPaths = false, top = 5 } = {}) {
  const L = [];
  const t = r.totals;
  const I = r.idle;

  L.push('');
  L.push(bold('  warm-window') + dim('  ·  your Claude Code idle tax'));
  L.push(
    dim(
      `  ${t.calls.toLocaleString()} model calls · ${t.streams} sessions & subagents · ${day(t.firstT)} → ${day(t.lastT)}`,
    ),
  );
  L.push('');

  // ---- receipt
  L.push(bold('  THE RECEIPT'));
  L.push(`  Cache hit rate          ${pct(t.readTokens / Math.max(1, t.readTokens + t.writeTokens))} ${dim('(looks great, hides the expensive moments)')}`);
  L.push(`  Cache spend (est.)      ${usd(t.cacheSpend)} ${dim(`= ${usd(t.readCost)} reads + ${usd(t.writeCost)} writes`)}`);
  L.push(`  Cold returns            ${bold(I.events)} ${dim(`times a conversation resumed after its cache expired (~${tok(I.avgRewrite)} tokens re-cached each)`)}`);
  L.push(dim(`    you took a break      ${padL(I.byKind.main.events, 4)} · ${usd(I.byKind.main.tax)} idle tax`));
  L.push(dim(`    a subagent waited     ${padL(I.byKind.subagent.events, 4)} · ${usd(I.byKind.subagent.tax)} idle tax (slow tool, 5-min cache)`));
  L.push(`  Re-cached after gaps    ${tok(I.writeTokens)} tokens ${dim(`= ${pct(I.shareOfWrites)} of all cache writes`)}`);
  L.push(`  ${bold('Idle tax')}                ${bold(yellow(usd(I.tax)))} ${dim(`= ${pct(I.shareOfCacheSpend)} of cache spend, extra paid vs. a warm cache`)}`);
  L.push('');

  // ---- when you come back
  L.push(bold('  HOW LONG THE GAPS WERE') + dim('  (you / subagent)'));
  const maxEv = Math.max(1, ...I.buckets.map((b) => b.events));
  for (const b of I.buckets) {
    L.push(`  ${pad(b.label, 11)} ${bar(b.events / maxEv)} ${padL(b.main, 4)} / ${pad(b.subagent, 4)} ${dim(`· ${usd(b.cost)}`)}`);
  }
  L.push('');

  // ---- policies
  L.push(bold('  WHAT EACH FIX WOULD HAVE COST') + dim(`  (same ${r.gapsConsidered} gaps, cache cost around them)`));
  for (const p of r.policies) {
    const saved =
      p.key === 'actual'
        ? dim('baseline')
        : p.saved >= 0
          ? green(`saves ${usd(p.saved)} (${pct(p.savedPct)})`)
          : yellow(`costs ${usd(-p.saved)} more`);
    const name = p.key === 'hybrid' ? bold(p.name) : p.key === 'oracle' ? dim(p.name) : p.name;
    L.push(`  ${pad(name, 64)} ${padL(usd(p.cost), 8)}  ${saved}`);
    const extra = [];
    if (p.surcharge) extra.push(`includes ${usd(p.surcharge)} extra for paying the 1-hour rate on every write`);
    if (p.compactions) extra.push(`${p.compactions} compactions (each one is lossy)`);
    if (p.pings) extra.push(`${p.pings.toLocaleString()} keep-warm pings`);
    if (extra.length) L.push(dim(`      ${extra.join(' · ')}`));
  }
  L.push('');

  // ---- projects
  if (r.projects.length) {
    L.push(bold('  WHERE THE IDLE TAX CAME FROM'));
    for (const p of r.projects.slice(0, top)) {
      const name = showPaths ? p.project : basename(p.project) || p.project;
      L.push(`  ${pad(name, 32)} ${padL(usd(p.tax), 8)}  ${dim(`${p.events} returns · ${tok(p.tokens)} re-cached`)}`);
    }
    L.push('');
  }

  // ---- what to do
  const best = r.policies.find((p) => p.key === 'hybrid');
  L.push(bold('  WHAT YOU CAN DO TODAY'));
  L.push(`  1. Before you step away from a long session, run ${cyan('/compact')} (or start a fresh session with a handoff note).`);
  L.push(`  2. Try ${cyan('"promptCacheTtl": "1h"')} in ~/.claude/settings.json if your breaks are mostly 5-60 min.`);
  L.push(`  3. Want Warm Window to do this for you automatically (est. ${usd(best.saved)} here)?`);
  L.push(`     👍 or comment on ${cyan(AUTO_POLICY_ISSUE)}. That decides whether it gets built.`);
  L.push('');

  L.push(dim('  Share your receipt:'));
  L.push(`  ${receiptLine(r)}`);
  L.push('');

  L.push(
    dim(
      `  Estimates at Anthropic API list prices. On a Pro/Max plan you pay in usage limits, not dollars, but the proportions hold.\n` +
        `  A "cold return" = a cache write ≥ ${tok(r.options.minWrite)} tokens after a gap > ${r.options.minGapMin} min. Some may be deliberate fresh starts.\n` +
        `  Simulations assume a ${tok(r.options.summaryTokens)}-token summary and ignore that compaction also makes later turns cheaper.\n` +
        `  Keep-warm pings may count against plan usage limits. Nothing was sent anywhere: this ran entirely on your machine.`,
    ),
  );
  if (t.unknownModels.length) L.push(dim(`  Priced by family fallback: ${t.unknownModels.join(', ')}`));
  L.push('');
  return L.join('\n');
}
