import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTranscript, parseFile, loadStreams, cachePath } from '../src/parse.js';
import { analyze } from '../src/analyze.js';
import { priceFor, priceForOpenAI } from '../src/pricing.js';
import { parseCodexFile, parseCodexLines, analyzeCodex } from '../src/codex.js';

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'ww-cache-')); // never touch the real cache

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
  for (const k of ['actual', 'compact', 'keepwarm', 'hybrid'])
    assert.ok(by.oracle.cost <= by[k].cost + 1e-12, `oracle > ${k}`);
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

test('reading a file in chunks matches parsing the text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-'));
  const f = join(dir, 'a.jsonl');
  // A huge line straddles the read chunks, and the last line has no newline.
  const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(3 << 20) } });
  const text = [line({ t: min(0), id: 'a', w1h: 1000 }), huge, line({ t: min(1), id: 'b', read: 1000 })].join('\n');
  writeFileSync(f, text);
  assert.deepEqual(parseFile(f), parseTranscript(text, f));
  assert.equal(parseFile(f).calls.length, 2);
});

test('saved results are reused until the log changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-'));
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, line({ t: min(0), id: 'a', w1h: 1000 }));
  assert.equal(loadStreams(dir).streams[0].calls.length, 1);
  assert.ok(existsSync(cachePath()));

  // Same size and time: served from the cache, proving the file wasn't re-read.
  const stamp = new Date(T0);
  utimesSync(f, stamp, stamp);
  loadStreams(dir);
  writeFileSync(f, line({ t: min(0), id: 'z', w1h: 1000 }).replace(/1000/g, '2000'));
  utimesSync(f, stamp, stamp);
  assert.equal(loadStreams(dir).streams[0].calls[0].write, 1000);
  assert.equal(loadStreams(dir, { useCache: false }).streams[0].calls[0].write, 2000);

  // A real change is picked up.
  writeFileSync(f, line({ t: min(0), id: 'y', w1h: 3000 }));
  assert.equal(loadStreams(dir).streams[0].calls[0].write, 3000);
});

test('policies pay for sessions that never come back', () => {
  const ended = parseTranscript(line({ t: min(0), id: 'e', w1h: 100000 }), '/x/ended.jsonl');
  const later = parseTranscript(line({ t: min(600), id: 'l', w1h: 1000 }), '/x/later.jsonl');
  const r = analyze([ended, later], { hybridCandidates: [120] });
  const p = priceFor('claude-opus-5-5');
  const ctx = 100003;
  const hybrid = r.policies.find((x) => x.key === 'hybrid');
  assert.equal(hybrid.pings, 2); // 120 min at one ping per 55
  assert.equal(hybrid.compactions, 1);
  assert.ok(Math.abs(hybrid.cost - (2 * ctx * p.read + ctx * p.read + 10000 * p.output)) < 1e-9);
  assert.equal(r.policies.find((x) => x.key === 'oracle').cost, 0); // hindsight wouldn't spend anything
});

test('finished subagents are not kept warm', () => {
  const sub = parseTranscript(line({ t: min(0), id: 's', w5m: 100000, sidechain: true }), '/x/s.jsonl');
  const later = parseTranscript(line({ t: min(600), id: 'l', w1h: 1000 }), '/x/later.jsonl');
  assert.equal(analyze([sub, later]).policies.find((x) => x.key === 'hybrid').pings, 0);
});

test('compact and keep-warm leave subagents alone, a longer TTL does not', () => {
  const r = analyze([parseTranscript(SUB, '/x/s.jsonl')]);
  const by = Object.fromEntries(r.policies.map((p) => [p.key, p]));
  for (const k of ['compact', 'keepwarm', 'hybrid', 'oracle']) assert.equal(by[k].saved, 0);
  assert.ok(by.ttl1h.saved > 0); // a 10-minute wait survives a 1-hour cache
});

// ---- Codex

const meta = (extra = {}) => JSON.stringify({ timestamp: new Date(min(0)).toISOString(), type: 'session_meta', payload: { cwd: '/home/me/app', source: 'vscode', ...extra } });
const ctx = (model) => JSON.stringify({ timestamp: new Date(min(0)).toISOString(), type: 'turn_context', payload: { model } });
const rec = (m, id, input, cached, output = 100, write = 0) =>
  JSON.stringify({
    timestamp: new Date(min(m)).toISOString(),
    type: 'token_usage_record',
    payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output } },
  });
const count = (m, input, cached, total) =>
  JSON.stringify({
    timestamp: new Date(min(m)).toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 10 } } },
  });
const codexLines = (...rows) => parseCodexLines(rows, '/x/rollout.jsonl');

test('codex: a collapsed cache is a cold return, priced on redone tokens only', () => {
  // 100k warm, then back after 40 min: 21k cached, 130k input, so 30k of it is new content.
  const s = codexLines(meta(), ctx('gpt-6-astra'), rec(0, 'a', 100000, 90000), rec(40, 'b', 130000, 21000));
  const r = analyzeCodex([s]);
  const p = priceForOpenAI('gpt-6-astra');
  assert.equal(r.idle.events, 1);
  assert.equal(r.idle.tokens, 79000); // 100k already there, minus the 21k still cached
  assert.ok(Math.abs(r.idle.tax - 79000 * (p.input - p.read)) < 1e-9);
  assert.equal(r.projects[0].project, '/home/me/app');
});

test('codex: a warm return after a gap is not a cold return', () => {
  const s = codexLines(meta(), ctx('gpt-6-astra'), rec(0, 'a', 100000, 90000), rec(30, 'b', 150000, 99000));
  assert.equal(analyzeCodex([s]).idle.events, 0);
});

test('codex: spend counts cached and uncached input at their own rates', () => {
  const s = codexLines(ctx('gpt-6.1-sol'), rec(0, 'a', 1000, 600, 50));
  const p = priceForOpenAI('gpt-6.1-sol');
  assert.ok(Math.abs(analyzeCodex([s]).totals.spend - (400 * p.input + 600 * p.read + 50 * p.output)) < 1e-12);
});

test('codex: repeated records and token_count fallback', () => {
  assert.equal(codexLines(ctx('gpt-6-luna'), rec(0, 'a', 10, 0), rec(1, 'a', 10, 0)).calls.length, 1);
  const old = codexLines(ctx('gpt-6-luna'), count(0, 10, 0, 20), count(0, 10, 0, 20), count(1, 30, 10, 60));
  assert.equal(old.calls.length, 2);
  // When a file has both, the record wins so nothing is counted twice.
  assert.equal(codexLines(ctx('gpt-6-luna'), count(0, 10, 0, 20), rec(0, 'a', 10, 0)).calls.length, 1);
});

test('codex: subagent threads are detected', () => {
  assert.equal(codexLines(meta({ source: { subagent: { other: 'guardian' } } })).kind, 'subagent');
  assert.equal(codexLines(meta({ parent_thread_id: 'x' })).kind, 'subagent');
  assert.equal(codexLines(meta()).kind, 'main');
});

test('codex: unknown models are reported, never guessed', () => {
  assert.equal(priceForOpenAI('llama-99'), null);
  assert.equal(priceForOpenAI('gpt-5.4-mini').model, 'gpt-5.4-mini');
  assert.equal(priceForOpenAI('gpt-5.1-codex').model, 'gpt-5.1');
  const r = analyzeCodex([codexLines(ctx('llama-99'), rec(0, 'a', 100, 0))]);
  assert.deepEqual(r.totals.unknownModels, ['llama-99']);
  assert.equal(r.totals.spend, 0);
});

test('codex: the file reader skips message text and handles huge lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ww-'));
  const f = join(dir, 'rollout.jsonl');
  const noise = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(3 << 20) } });
  writeFileSync(f, [meta(), noise, ctx('gpt-6-astra'), rec(0, 'a', 10, 0), noise, rec(1, 'b', 20, 10)].join('\n'));
  const s = parseCodexFile(f);
  assert.equal(s.calls.length, 2);
  assert.equal(s.project, '/home/me/app');
});

test('CLI: --agent picks the report, and --dir alone stays on Claude', () => {
  const codexDir = mkdtempSync(join(tmpdir(), 'ww-'));
  writeFileSync(join(codexDir, 'rollout.jsonl'), [meta(), ctx('gpt-6-astra'), rec(0, 'a', 100000, 90000), rec(40, 'b', 130000, 21000)].join('\n'));
  const claudeDir = mkdtempSync(join(tmpdir(), 'ww-'));
  writeFileSync(join(claudeDir, 'sess.jsonl'), MAIN);
  const bin = fileURLToPath(new URL('../bin/warm-window.js', import.meta.url));
  const run = (...a) => execFileSync(process.execPath, [bin, 'scan', ...a], { env: { ...process.env, NO_COLOR: '1' } }).toString();

  const only = run('--agent', 'codex', '--codex-dir', codexDir);
  assert.match(only, /your Codex idle tax/);
  assert.doesNotMatch(only, /WHAT EACH FIX/);
  assert.equal(JSON.parse(run('--codex-dir', codexDir, '--json')).codex.idle.events, 1);
  assert.doesNotMatch(run('--dir', claudeDir), /Codex/);

  const both = run('--dir', claudeDir, '--codex-dir', codexDir);
  assert.match(both, /Claude Code idle tax/);
  assert.match(both, /your Codex idle tax/);
  assert.match(run('--dir', claudeDir, '--codex-dir', codexDir, '--receipt'), /My Codex idle tax/);
  assert.throws(() => execFileSync(process.execPath, [bin, 'scan', '--agent', 'gemini'], { stdio: 'pipe' }));
});
