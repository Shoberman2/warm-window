#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { analyze, DEFAULTS } from '../src/analyze.js';
import { loadStreams, DEFAULT_DIR } from '../src/parse.js';
import { analyzeCodex, loadCodex, DEFAULT_CODEX_DIR } from '../src/codex.js';
import { renderReport, receiptLine, renderCodexReport, codexReceiptLine } from '../src/report.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `warm-window ${pkg.version}
Find your Claude Code or Codex "idle tax": what you pay to re-cache a long conversation
after a break, and what keeping it warm or compacting first would have cost.
Runs locally. Reads only token counts and timestamps. Sends nothing anywhere.

Usage
  npx warm-window scan [options]

Options
  --agent <name>        claude, codex or all (default: all that are installed)
  --dir <path>          Claude Code transcripts folder (default: ~/.claude/projects)
  --codex-dir <path>    Codex sessions folder (default: ~/.codex/sessions)
  --days <n>            only the last n days
  --min-write <tokens>  smallest re-cache that counts as a return (default ${DEFAULTS.minWrite})
  --summary <tokens>    assumed compaction summary size (default ${DEFAULTS.summaryTokens})
  --json                machine-readable output
  --receipt             print only the one-line shareable receipt
  --paths               show full project paths instead of folder names
  --top <n>             projects to list (default 5)
  --no-cache            re-read every log instead of using saved results
  -v, --version
  -h, --help
`;

function parseArgs(argv) {
  const a = { cmd: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.flags.help = true;
    else if (x === '-v' || x === '--version') a.flags.version = true;
    else if (x.startsWith('--')) {
      const key = x.slice(2);
      const boolean = ['json', 'receipt', 'paths', 'no-cache'].includes(key);
      if (boolean) a.flags[key] = true;
      else {
        const val = argv[++i];
        if (val === undefined) die(`Missing value for --${key}`);
        a.flags[key] = val;
      }
    } else if (!a.cmd) a.cmd = x;
    else die(`Unexpected argument: ${x}`);
  }
  return a;
}

function die(msg) {
  process.stderr.write(`warm-window: ${msg}\nRun "warm-window --help" for usage.\n`);
  process.exit(2);
}

function num(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) die(`--${name} must be a non-negative number`);
  return n;
}

const { cmd, flags } = parseArgs(process.argv.slice(2));
if (flags.version) {
  console.log(pkg.version);
  process.exit(0);
}
if (flags.help || !cmd) {
  console.log(HELP);
  process.exit(0);
}
if (cmd !== 'scan') die(`Unknown command "${cmd}"`);

const agent = flags.agent || 'all';
if (!['all', 'claude', 'codex'].includes(agent)) die('--agent must be claude, codex or all');
const days = num(flags.days, 'days');
const sinceMs = days ? Date.now() - days * 86400000 : 0;
const useCache = !flags['no-cache'];
const top = num(flags.top, 'top') ?? 5;
const minWrite = num(flags['min-write'], 'min-write') ?? DEFAULTS.minWrite;
const shortName = (p) => ({ ...p, project: p.project.split(/[\\/]/).pop() });

// An explicit folder means that agent only. Otherwise use whatever is on this machine.
const dir = flags.dir || DEFAULT_DIR;
const codexDir = flags['codex-dir'] || DEFAULT_CODEX_DIR;
const auto = agent === 'all' && !flags.dir && !flags['codex-dir'];
const wantClaude = agent === 'claude' || (agent === 'all' && (flags.dir || (auto && existsSync(dir))));
const wantCodex = agent === 'codex' || (agent === 'all' && (flags['codex-dir'] || (auto && existsSync(codexDir))));

const claude = wantClaude ? loadStreams(dir, { sinceMs, useCache }) : { files: 0, streams: [] };
const codex = wantCodex ? loadCodex(codexDir, { sinceMs, useCache }) : { files: 0, streams: [] };

if (!claude.streams.length && !codex.streams.length) {
  const files = claude.files + codex.files;
  const where = [wantClaude && dir, wantCodex && codexDir].filter(Boolean).join(' or ') || dir;
  die(
    files
      ? `Found ${files} transcript files in ${where} but no model calls with usage data${days ? ` in the last ${days} days` : ''}.`
      : `No transcripts found in ${where}. Use --dir or --codex-dir to point at them.`,
  );
}

const result = claude.streams.length
  ? analyze(claude.streams, {
      minWrite,
      summaryTokens: num(flags.summary, 'summary') ?? DEFAULTS.summaryTokens,
    })
  : null;
const codexResult = codex.streams.length ? analyzeCodex(codex.streams, { minWrite }) : null;

if (flags.json) {
  const out = { version: pkg.version };
  if (result) {
    const { options, totals, idle, gapsConsidered, policies, hybrids, projects } = result;
    Object.assign(out, {
      options,
      totals,
      idle,
      gapsConsidered,
      policies,
      hybrids,
      projects: flags.paths ? projects : projects.map(shortName),
    });
  }
  if (codexResult) {
    out.codex = { ...codexResult, projects: flags.paths ? codexResult.projects : codexResult.projects.map(shortName) };
  }
  console.log(JSON.stringify(out, null, 2));
} else if (flags.receipt) {
  if (result) console.log(receiptLine(result));
  if (codexResult) console.log(codexReceiptLine(codexResult));
} else {
  const options = { showPaths: Boolean(flags.paths), top };
  if (result) console.log(renderReport(result, options));
  if (codexResult) console.log(renderCodexReport(codexResult, options));
}
