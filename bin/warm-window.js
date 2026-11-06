#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { analyze, DEFAULTS } from '../src/analyze.js';
import { loadStreams, DEFAULT_DIR } from '../src/parse.js';
import { analyzeCodex, loadCodex, DEFAULT_CODEX_DIR } from '../src/codex.js';
import { analyzeOpen, loadCalls, parsePrice } from '../src/open.js';
import { logPath, startRecorder } from '../src/record.js';
import {
  renderReport,
  receiptLine,
  renderCodexReport,
  codexReceiptLine,
  renderOpenReport,
  openReceiptLine,
} from '../src/report.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `warm-window ${pkg.version}
Find your "idle tax": what you pay to re-cache a long conversation after a break, on
Claude Code, Codex, or any open model. Runs locally. Keeps only token counts and timing.

Usage
  npx warm-window scan [options]
  npx warm-window record --target <url> [--port <n>]

Record (for open models and anything else)
  Point your tool at the printed address. Calls go on to --target unchanged, and only
  token counts and timing are saved. Examples:
    warm-window record --target http://127.0.0.1:8080       llama.cpp
    warm-window record --target http://127.0.0.1:11434      Ollama
    warm-window record --target https://api.deepseek.com    hosted API
    warm-window record --target https://openrouter.ai/api   OpenRouter

Options
  --agent <name>        claude, codex, open or all (default: all found on this machine)
  --dir <path>          Claude Code transcripts folder (default: ~/.claude/projects)
  --codex-dir <path>    Codex sessions folder (default: ~/.codex/sessions)
  --log <path>          recorded calls (default: ${logPath()})
  --price <i,c,o[,w]>   open-model prices per 1M tokens: input, cached, output, cache write
  --min-gap <minutes>   open models: shortest gap that counts as a return (default 5)
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
if (cmd === 'record') {
  if (!flags.target) die('record needs --target, the server to forward to, such as http://127.0.0.1:8080');
  let url;
  try {
    url = new URL(flags.target);
  } catch {
    die(`--target is not a valid URL: ${flags.target}`);
  }
  if (!/^https?:$/.test(url.protocol)) die('--target must start with http:// or https://');
  const port = num(flags.port, 'port') ?? 8788;
  const log = flags.log || logPath();
  try {
    await startRecorder({ target: flags.target, port, log });
  } catch (e) {
    die(`could not listen on port ${port}: ${e.message}`);
  }
  console.log(`warm-window is recording on http://127.0.0.1:${port} and forwarding to ${flags.target}`);
  console.log('Point your tool at that address instead of the server, keeping any path such as /v1.');
  console.log(`Saving token counts and timing to ${log}. Press Ctrl+C to stop.`);
  await new Promise(() => {});
}
if (cmd !== 'scan') die(`Unknown command "${cmd}"`);

const agent = flags.agent || 'all';
if (!['all', 'claude', 'codex', 'open'].includes(agent)) die('--agent must be claude, codex, open or all');
const days = num(flags.days, 'days');
const sinceMs = days ? Date.now() - days * 86400000 : 0;
const useCache = !flags['no-cache'];
const top = num(flags.top, 'top') ?? 5;
const minWriteFlag = num(flags['min-write'], 'min-write');
const minWrite = minWriteFlag ?? DEFAULTS.minWrite;
const price = parsePrice(flags.price);
if (flags.price && !price) die('--price must be input,cached,output or input,cached,output,write in dollars per 1M tokens');
const shortName = (p) => ({ ...p, project: p.project.split(/[\\/]/).pop() });

// An explicit folder means that agent only. Otherwise use whatever is on this machine.
const dir = flags.dir || DEFAULT_DIR;
const codexDir = flags['codex-dir'] || DEFAULT_CODEX_DIR;
const openLog = flags.log || logPath();
const auto = agent === 'all' && !flags.dir && !flags['codex-dir'] && !flags.log;
const wantClaude = agent === 'claude' || (agent === 'all' && (flags.dir || (auto && existsSync(dir))));
const wantCodex = agent === 'codex' || (agent === 'all' && (flags['codex-dir'] || (auto && existsSync(codexDir))));
const wantOpen = agent === 'open' || (agent === 'all' && (flags.log || (auto && existsSync(openLog))));

const claude = wantClaude ? loadStreams(dir, { sinceMs, useCache }) : { files: 0, streams: [] };
const codex = wantCodex ? loadCodex(codexDir, { sinceMs, useCache }) : { files: 0, streams: [] };
const openCalls = wantOpen ? loadCalls(openLog, { sinceMs }) : [];

if (agent === 'open' && !openCalls.length) {
  die(`No recorded calls in ${openLog}. Run "warm-window record --target <url>" and use your tool through it first.`);
}
if (!claude.streams.length && !codex.streams.length && !openCalls.length) {
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
const openResult = openCalls.length
  ? analyzeOpen(openCalls, { price, minWrite: minWriteFlag ?? null, minGapMin: num(flags['min-gap'], 'min-gap') ?? 5 })
  : null;

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
  if (openResult) out.open = openResult;
  console.log(JSON.stringify(out, null, 2));
} else if (flags.receipt) {
  if (result) console.log(receiptLine(result));
  if (codexResult) console.log(codexReceiptLine(codexResult));
  if (openResult) console.log(openReceiptLine(openResult));
} else {
  const options = { showPaths: Boolean(flags.paths), top };
  if (result) console.log(renderReport(result, options));
  if (codexResult) console.log(renderCodexReport(codexResult, options));
  if (openResult) console.log(renderOpenReport(openResult));
}
