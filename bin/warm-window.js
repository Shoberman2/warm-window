#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { analyze, DEFAULTS } from '../src/analyze.js';
import { loadStreams, DEFAULT_DIR } from '../src/parse.js';
import { renderReport, receiptLine } from '../src/report.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `warm-window ${pkg.version}
Find your Claude Code "idle tax": what you pay to re-cache a long conversation
after a break, and what keeping it warm or compacting first would have cost.
Runs locally. Reads only token counts and timestamps. Sends nothing anywhere.

Usage
  npx warm-window scan [options]

Options
  --dir <path>          transcripts folder (default: ~/.claude/projects)
  --days <n>            only the last n days
  --min-write <tokens>  smallest re-cache that counts as a return (default ${DEFAULTS.minWrite})
  --summary <tokens>    assumed compaction summary size (default ${DEFAULTS.summaryTokens})
  --json                machine-readable output
  --receipt             print only the one-line shareable receipt
  --paths               show full project paths instead of folder names
  --top <n>             projects to list (default 5)
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
      const boolean = ['json', 'receipt', 'paths'].includes(key);
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

const dir = flags.dir || DEFAULT_DIR;
const days = num(flags.days, 'days');
const sinceMs = days ? Date.now() - days * 86400000 : 0;
const { files, streams } = loadStreams(dir, { sinceMs });

if (!streams.length) {
  die(
    files
      ? `Found ${files} transcript files in ${dir} but no model calls with usage data${days ? ` in the last ${days} days` : ''}.`
      : `No Claude Code transcripts found in ${dir}. Use --dir to point at them.`,
  );
}

const result = analyze(streams, {
  minWrite: num(flags['min-write'], 'min-write') ?? DEFAULTS.minWrite,
  summaryTokens: num(flags.summary, 'summary') ?? DEFAULTS.summaryTokens,
});

if (flags.json) {
  const { options, totals, idle, gapsConsidered, policies, hybrids, projects } = result;
  const out = {
    version: pkg.version,
    options,
    totals,
    idle,
    gapsConsidered,
    policies,
    hybrids,
    projects: flags.paths ? projects : projects.map((p) => ({ ...p, project: p.project.split('/').pop() })),
  };
  console.log(JSON.stringify(out, null, 2));
} else if (flags.receipt) {
  console.log(receiptLine(result));
} else {
  console.log(renderReport(result, { showPaths: Boolean(flags.paths), top: num(flags.top, 'top') ?? 5 }));
}
