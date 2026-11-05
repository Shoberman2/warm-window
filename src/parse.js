// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) into per-stream call lists.
// Each .jsonl file is one stream: a main session or a subagent. Each stream has its own cache.
// Nothing leaves the machine: we only read token counts and timestamps, never message text.

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

const CACHE_VERSION = 1; // bump when the parsed call format changes
export const DEFAULT_DIR = join(homedir(), '.claude', 'projects');

export function findTranscripts(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const ASSISTANT = Buffer.from('"type":"assistant"');
const NEWLINE = 10;
const CHUNK = 1 << 20;

/** Turns the usage lines of a transcript into one stream. Lines arrive as strings. */
function buildStream(lines, file) {
  const calls = [];
  const seen = new Set();
  let project = '';
  for (const line of lines) {
    if (!line || line[0] !== '{' || !line.includes('"usage"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'assistant') continue;
    const m = e.message || {};
    const u = m.usage;
    if (!u || !e.timestamp) continue;
    if (m.model === '<synthetic>') continue;
    const id = m.id || e.requestId || e.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (!project && e.cwd) project = e.cwd;
    const write = u.cache_creation_input_tokens || 0;
    const split = u.cache_creation || {};
    let w1h = split.ephemeral_1h_input_tokens || 0;
    let w5m = split.ephemeral_5m_input_tokens || 0;
    if (w1h + w5m === 0 && write > 0) w5m = write; // older logs: no split, API default is 5m
    calls.push({
      t,
      model: m.model || '',
      read: u.cache_read_input_tokens || 0,
      write,
      w5m,
      w1h,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      sidechain: Boolean(e.isSidechain),
    });
  }
  calls.sort((a, b) => a.t - b.t);
  const kind = /[\\/]subagents[\\/]/.test(file) || (calls.length && calls[0].sidechain) ? 'subagent' : 'main';
  return { file, project, kind, calls };
}

/** Parse transcript text into an ordered list of API calls. */
export function parseTranscript(text, file = '') {
  return buildStream(text.split('\n'), file);
}

/**
 * Yields only lines containing a needle, without decoding the rest. Most of a transcript
 * is message text we never need, and this also handles files too big for one string.
 */
export function* linesMatching(path, needles) {
  const wanted = (line) => needles.some((n) => line.includes(n));
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let carry = [];
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, null);
      if (n === 0) break;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(NEWLINE, start);
        if (nl === -1 || nl >= n) break;
        const piece = chunk.subarray(start, nl);
        const line = carry.length ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        if (wanted(line)) yield line.toString('utf8');
        start = nl + 1;
      }
      if (start < n) carry.push(Buffer.from(chunk.subarray(start, n)));
    }
    if (carry.length) {
      const line = Buffer.concat(carry);
      if (wanted(line)) yield line.toString('utf8');
    }
  } finally {
    closeSync(fd);
  }
}

export function parseFile(path) {
  return buildStream(linesMatching(path, [ASSISTANT]), path);
}

export function cachePath() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'warm-window', `calls-v${CACHE_VERSION}.json`);
}

function readCache() {
  try {
    return JSON.parse(readFileSync(cachePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(entries) {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // a cache we can't write only costs speed
  }
}

export function loadStreams(dir, { sinceMs = 0, useCache = true, parser = parseFile } = {}) {
  const files = findTranscripts(dir);
  const cache = useCache ? readCache() : {};
  const found = new Set(files);
  let changed = false;
  const streams = [];
  for (const f of files) {
    try {
      const st = statSync(f);
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      let s = cache[f];
      if (!s || s.mtimeMs !== st.mtimeMs || s.size !== st.size) {
        const parsed = parser(f);
        s = { mtimeMs: st.mtimeMs, size: st.size, project: parsed.project, kind: parsed.kind, calls: parsed.calls };
        cache[f] = s;
        changed = true;
      }
      const calls = sinceMs ? s.calls.filter((c) => c.t >= sinceMs) : s.calls;
      if (calls.length) streams.push({ file: f, project: s.project, kind: s.kind, calls });
    } catch {
      // unreadable file: skip
    }
  }
  if (useCache) {
    const root = dir.endsWith(sep) ? dir : dir + sep;
    for (const f of Object.keys(cache)) {
      if (f.startsWith(root) && !found.has(f)) {
        delete cache[f];
        changed = true;
      }
    }
    if (changed) writeCache(cache);
  }
  return { files: files.length, streams };
}
