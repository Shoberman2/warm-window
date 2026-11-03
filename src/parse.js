// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) into per-stream call lists.
// Each .jsonl file is one stream: a main session or a subagent. Each stream has its own cache.
// Nothing leaves the machine: we only read token counts and timestamps, never message text.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

/**
 * Parse one transcript into an ordered list of API calls.
 * A streamed response can be logged as several lines with the same message id; we keep one.
 */
export function parseTranscript(text, file = '') {
  const calls = [];
  const seen = new Set();
  let project = '';
  for (const line of text.split('\n')) {
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

export function loadStreams(dir, { sinceMs = 0 } = {}) {
  const files = findTranscripts(dir);
  const streams = [];
  for (const f of files) {
    try {
      if (sinceMs && statSync(f).mtimeMs < sinceMs) continue;
      const s = parseTranscript(readFileSync(f, 'utf8'), f);
      if (sinceMs) s.calls = s.calls.filter((c) => c.t >= sinceMs);
      if (s.calls.length) streams.push(s);
    } catch {
      // unreadable file: skip
    }
  }
  return { files: files.length, streams };
}
