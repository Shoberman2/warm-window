import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTranscript, loadStreams } from '../src/parse.js';
import { analyze } from '../src/analyze.js';
import { priceFor } from '../src/pricing.js';

const T0 = Date.parse('2026-10-01T09:00:00Z');
const min = (m) => T0 + m * 60000;

function line({ t, id, model = 'claude-opus-5-5', read = 0, w5m = 0, w1h = 0, sidechain = false }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(t).toISOString(),
    cwd: '/home/me/proj',
    isSidechain: sidechain,
    message: {
      id,
      model,
      usage: {
        input_tokens: 3,
        output_tokens: 100,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: w5m + w1h,
        cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h },
      },
    },
  });
}

// Main session: warm turns, then a 2-hour break and a full 150k re-cache (1h TTL).
const MAIN = [
  line({ t: min(0), id: 'a', w1h: 140000 }),
  line({ t: min(1), id: 'b', read: 140000, w1h: 2000 }),
  line({ t: min(1), id: 'b', read: 140000, w1h: 2000 }), // duplicate streamed line
  line({ t: min(121), id: 'c', read: 0, w1h: 150000 }),
  '{"type":"user","message":{"content":"hi"}}',
  'not json',
].join('\n');

// Subagent: 5m TTL, waits 10 min on a slow tool, re-caches 60k.
const SUB = [
  line({ t: min(0), id: 's1', w5m: 50000, sidechain: true }),
  line({ t: min(10), id: 's2', w5m: 60000, sidechain: true }),
].join('\n');

test('parse dedupes streamed lines and skips junk', () => {
  const s = parseTranscript(MAIN, '/x/session.jsonl');
  assert.equal(s.calls.length, 3);
  assert.equal(s.kind, 'main');
  assert.equal(s.project, '/home/me/proj');
});

test('subagent streams are detected by path or sidechain flag', () => {
  assert.equal(parseTranscript(SUB, '/x/y.jsonl').kind, 'subagent');
  assert.equal(parseTranscript(MAIN, '/x/abc/subagents/agent-1.jsonl').kind, 'subagent');
});

test('idle tax = re-cache cost minus warm read cost', () => {
  const r = analyze([parseTranscript(MAIN, '/x/m.jsonl'), parseTranscript(SUB, '/x/s.jsonl')]);
  const p = priceFor('claude-opus-5-5');
  assert.equal(r.idle.events, 2);
  assert.equal(r.idle.byKind.main.events, 1);
  assert.equal(r.idle.byKind.subagent.events, 1);
  const expected = 150000 * (p.write1h - p.read) + 60000 * (p.write5m - p.read);
  assert.ok(Math.abs(r.idle.tax - expected) < 1e-9, `${r.idle.tax} vs ${expected}`);
  assert.equal(r.idle.writeTokens, 210000);
});

test('policies: hindsight is the floor, hybrid beats doing nothing here', () => {
  const r = analyze([parseTranscript(MAIN, '/x/m.jsonl'), parseTranscript(SUB, '/x/s.jsonl')]);
  const by = Object.fromEntries(r.policies.map((p) => [p.key, p]));
  for (const k of Object.keys(by)) assert.ok(by.oracle.cost <= by[k].cost + 1e-12, `oracle > ${k}`);
  assert.ok(by.hybrid.cost < by.actual.cost);
  assert.equal(by.actual.saved, 0);
});

test('small writes after a gap are not counted as cold returns', () => {
  const s = parseTranscript(
    [line({ t: min(0), id: 'a', w1h: 100000 }), line({ t: min(30), id: 'b', read: 100000, w1h: 500 })].join('\n'),
  );
  assert.equal(analyze([s]).idle.events, 0);
});

test('unknown models fall back by family', () => {
  assert.equal(priceFor('claude-opus-9').model, 'claude-opus-5-5');
  assert.equal(priceFor('claude-sonnet-4-5-20250929').model, 'claude-sonnet-4-5');
  assert.equal(priceFor('claude-opus-4-1').exact, true);
});

test('CLI scan works end to end on a folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-'));
  mkdirSync(join(dir, 'proj', 'sess', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'proj', 'sess.jsonl'), MAIN);
  writeFileSync(join(dir, 'proj', 'sess', 'subagents', 'agent-1.jsonl'), SUB);
  const bin = fileURLToPath(new URL('../bin/warm-window.js', import.meta.url));
  const json = JSON.parse(execFileSync(process.execPath, [bin, 'scan', '--dir', dir, '--json']).toString());
  assert.equal(json.idle.events, 2);
  const text = execFileSync(process.execPath, [bin, 'scan', '--dir', dir], { env: { ...process.env, NO_COLOR: '1' } }).toString();
  assert.match(text, /Idle tax/);
  const receipt = execFileSync(process.execPath, [bin, 'scan', '--dir', dir, '--receipt']).toString();
  assert.match(receipt, /npx warm-window scan/);
  const { streams } = loadStreams(dir);
  assert.equal(streams.length, 2);
});

test('no cold returns: report says so instead of pitching a $0 fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(
    join(dir, 'p', 'a.jsonl'),
    [line({ t: min(0), id: 'a', w1h: 30000 }), line({ t: min(1), id: 'b', read: 30000, w1h: 100 })].join('\n'),
  );
  const bin = fileURLToPath(new URL('../bin/warm-window.js', import.meta.url));
  const text = execFileSync(process.execPath, [bin, 'scan', '--dir', dir], { env: { ...process.env, NO_COLOR: '1' } }).toString();
  assert.match(text, /No idle tax found/);
  assert.doesNotMatch(text, /WHAT EACH FIX/);
});

test('a big write on top of a healthy cache read is not a cold return', () => {
  const s = parseTranscript(
    [line({ t: min(0), id: 'a', w1h: 100000 }), line({ t: min(10), id: 'b', read: 100000, w1h: 30000 })].join('\n'),
  );
  assert.equal(analyze([s]).idle.events, 0);
});

test('force-1h does not double-charge cold returns', () => {
  const s = parseTranscript(
    [line({ t: min(0), id: 'a', w5m: 100000 }), line({ t: min(10), id: 'b', w5m: 100000 })].join('\n'),
  );
  const ttl = analyze([s]).policies.find((x) => x.key === 'ttl1h');
  const p = priceFor('claude-opus-5-5');
  // First write pays the 1h premium; the return is a warm read under a 1h cache.
  const expected = 100000 * p.read + 100000 * (p.write1h - p.write5m);
  assert.ok(Math.abs(ttl.cost - expected) < 1e-9, `${ttl.cost} vs ${expected}`);
});

test('compaction cost includes re-caching the system prompt', () => {
  const s = parseTranscript(
    [line({ t: min(0), id: 'a', w1h: 100000 }), line({ t: min(120), id: 'b', w1h: 100000 })].join('\n'),
  );
  const compact = analyze([s]).policies.find((x) => x.key === 'compact');
  const p = priceFor('claude-opus-5-5');
  const expected = 100003 * p.read + 10000 * p.output + 37000 * p.write1h;
  assert.ok(Math.abs(compact.cost - expected) < 1e-9, `${compact.cost} vs ${expected}`);
});
