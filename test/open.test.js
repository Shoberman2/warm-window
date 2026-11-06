import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { conversationId, readUsage, startRecorder } from '../src/record.js';
import { analyzeOpen, isLocal, loadCalls, parsePrice } from '../src/open.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ww-open-'));
const T0 = Date.parse('2026-11-01T09:00:00Z');
const at = (m) => T0 + m * 60000;
const call = (m, over = {}) => ({ t: at(m), conv: 'a', host: '127.0.0.1', model: 'qwen', input: 10000, cached: 9000, write: 0, output: 50, ...over });

test('readUsage understands each API', () => {
  assert.deepEqual(readUsage({ model: 'm', usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, cost: 0.01 } }), { model: 'm', input: 100, cached: 60, write: 10, output: 5, cost: 0.01 });
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens: 1 } }), { input: 100, cached: 70, output: 1 }); // DeepSeek
  assert.deepEqual(readUsage({ message: { usage: { input_tokens: 3, cache_read_input_tokens: 90, cache_creation_input_tokens: 7, output_tokens: 1 } } }), { cached: 90, write: 7, input: 100, output: 1 }); // Anthropic format
  assert.deepEqual(readUsage({ response: { usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 } } } }), { input: 100, cached: 80, output: 2 }); // Responses
  assert.deepEqual(readUsage({ timings: { cache_n: 40, prompt_n: 10, prompt_ms: 900 } }), { cached: 40, promptMs: 900, input: 50 }); // llama.cpp
  assert.deepEqual(readUsage({ done: true, model: 'm', prompt_eval_count: 30, prompt_eval_cached_count: 4, prompt_eval_duration: 2e9, load_duration: 3e9, eval_count: 4 }), { model: 'm', cached: 4, input: 30, promptMs: 2000, loadMs: 3000, output: 4 }); // Ollama
  assert.deepEqual(readUsage({ done: true, prompt_eval_count: 9, prompt_eval_duration: 2e9 }), { promptMs: 2000 }); // older Ollama
});

test('a model file path is cut to its name, but a vendor/model id is kept', () => {
  assert.equal(readUsage({ model: '/Users/me/models/qwen.gguf' }).model, 'qwen.gguf');
  assert.equal(readUsage({ model: 'C:\\models\\qwen.gguf' }).model, 'qwen.gguf');
  assert.equal(readUsage({ model: 'deepseek/deepseek-chat' }).model, 'deepseek/deepseek-chat');
});

test('a streamed Anthropic reply keeps its input count when the final chunk reports only output', () => {
  const acc = readUsage({ message: { usage: { input_tokens: 3, cache_read_input_tokens: 90 } } });
  readUsage({ usage: { output_tokens: 12 } }, acc);
  assert.equal(acc.input, 93);
  assert.equal(acc.output, 12);
});

test('conversations with a string input are told apart by more than their first letters', () => {
  const key = Buffer.from('k');
  assert.notEqual(conversationId({ input: 'Hello there' }, key), conversationId({ input: 'Hello world' }, key));
  assert.equal(conversationId({ messages: [{ c: 1 }, { c: 2 }, { c: 3 }] }, key), conversationId({ messages: [{ c: 1 }, { c: 2 }] }, key));
});

test('local hosts are recognised and public ones are not', () => {
  for (const h of ['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.2', '172.20.1.1', 'box.local', '::1']) assert.ok(isLocal(h), h);
  for (const h of ['api.deepseek.com', 'openrouter.ai', '172.32.0.1', '8.8.8.8']) assert.ok(!isLocal(h), h);
});

test('parsePrice rejects bad input', () => {
  assert.deepEqual(parsePrice('1,0.1,2'), { input: 1, read: 0.1, output: 2, write: 1 });
  assert.equal(parsePrice('1,2'), null);
  assert.equal(parsePrice('a,b,c'), null);
});

test('a local cold return is measured in seconds, not dollars', () => {
  const r = analyzeOpen([
    call(0, { cached: 0, input: 8000, promptMs: 16000 }),
    call(1, { input: 9000, cached: 8000, promptMs: 1000 }),
    call(2, { input: 10000, cached: 9000, promptMs: 1000 }),
    call(62, { input: 10200, cached: 0, promptMs: 21000 }),
  ]);
  assert.equal(r.idle.events, 1);
  assert.equal(r.idle.tokens, 10000); // only what was already there, not the new 200
  assert.equal(r.idle.seconds, 20);
  assert.equal(r.idle.tax, 0);
  assert.equal(r.idle.buckets.find((b) => b.label === '15-60 min').events, 1);
});

test('a hosted model uses --price, and a reported cost beats the estimate', () => {
  const calls = [
    call(0, { host: 'api.x.ai', input: 100000, cached: 0 }),
    call(1, { host: 'api.x.ai', input: 101000, cached: 100000 }),
    call(40, { host: 'api.x.ai', input: 102000, cached: 0 }),
  ];
  const noPrice = analyzeOpen(calls);
  assert.equal(noPrice.idle.events, 1);
  assert.equal(noPrice.idle.tax, 0);
  assert.deepEqual(noPrice.unpriced, ['qwen']);
  const priced = analyzeOpen(calls, { price: parsePrice('1,0.1,2') });
  assert.ok(Math.abs(priced.idle.tax - 0.0909) < 1e-9); // 101k redone at $0.90 per 1M saved
  assert.deepEqual(priced.unpriced, []);
  const reported = analyzeOpen(calls.map((c) => ({ ...c, cost: 1 })), { price: parsePrice('1,0.1,2') });
  assert.equal(reported.totals.spend, 3);
});

test('a short gap, or a small context, is not a cold return', () => {
  const shortGap = analyzeOpen([call(0, { input: 20000 }), call(3, { input: 20000, cached: 0 })]);
  assert.equal(shortGap.idle.events, 0);
  const small = analyzeOpen([call(0, { input: 900 }), call(60, { input: 1000, cached: 0 })]);
  assert.equal(small.idle.events, 0);
});

test('a server with no cache data is judged by wait time, and only with a warm baseline', () => {
  const quiet = (m, ms) => call(m, { input: null, cached: null, promptMs: ms });
  const noBaseline = analyzeOpen([quiet(0, 500), quiet(60, 9000)]);
  assert.equal(noBaseline.idle.events, 0);
  const r = analyzeOpen([quiet(0, 500), quiet(1, 500), quiet(2, 500), quiet(3, 500), quiet(60, 9500)]);
  assert.equal(r.idle.events, 1);
  assert.equal(r.idle.timeOnly, 1);
  assert.equal(r.idle.seconds, 9);
  assert.equal(r.totals.hitRate, null);
});

test('a missing cached count means zero when that model reports it elsewhere', () => {
  const r = analyzeOpen([
    call(0, { input: 8000, cached: null }),
    call(1, { input: 9000, cached: 8000 }),
    call(60, { input: 8000, cached: null, ttftMs: 1000 }),
  ]);
  assert.equal(r.idle.events, 1);
  assert.equal(r.idle.tokens, 8000);
  assert.equal(r.idle.timeOnly, 0);
  assert.equal(r.totals.noCacheData, 0);
  assert.ok(Math.abs(r.totals.hitRate - 8000 / 25000) < 1e-9);
});

async function withServers(handler, fn) {
  const dir = tmp();
  process.env.XDG_DATA_HOME = dir;
  const seen = {};
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.body = b ? JSON.parse(b) : null;
      handler(req, res, seen.body);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const log = join(dir, 'calls.jsonl');
  const rec = await startRecorder({ target: `http://127.0.0.1:${upstream.address().port}/api`, port: 0, log });
  const base = `http://127.0.0.1:${rec.address().port}`;
  try {
    await fn({ base, log, seen });
  } finally {
    rec.close();
    upstream.close();
  }
}

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('recorder forwards a normal reply and saves counts, never the prompt or key', async () => {
  const reply = { id: 'x', model: 'qwen', choices: [{ message: { content: 'SECRET-REPLY' } }], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 30 } } };
  await withServers(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    },
    async ({ base, log, seen }) => {
      const res = await post(`${base}/v1/chat/completions?x=1`, { model: 'qwen', messages: [{ role: 'user', content: 'SECRET-PROMPT' }] }, { authorization: 'Bearer SECRET-KEY' });
      assert.deepEqual(await res.json(), reply);
      assert.equal(seen.url, '/api/v1/chat/completions?x=1');
      assert.equal(seen.auth, 'Bearer SECRET-KEY');
      const text = readFileSync(log, 'utf8');
      assert.ok(!/SECRET/.test(text));
      const [c] = loadCalls(log);
      assert.equal(c.input, 50);
      assert.equal(c.cached, 30);
      assert.equal(c.conv.length, 16);
      assert.equal(statSync(log).mode & 0o077, process.platform === 'win32' ? statSync(log).mode & 0o077 : 0);
    },
  );
});

test('recorder asks for streamed usage and hides that extra chunk from the client', async () => {
  const send = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  await withServers(
    (req, res, body) => {
      assert.equal(body.stream_options.include_usage, true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send(res, { model: 'qwen', choices: [{ delta: { content: 'hi' } }] });
      send(res, { model: 'qwen', choices: [], usage: { prompt_tokens: 40, completion_tokens: 1 } });
      res.end('data: [DONE]\n\n');
    },
    async ({ base, log }) => {
      const res = await post(`${base}/chat/completions`, { model: 'qwen', stream: true, messages: [] });
      const text = await res.text();
      assert.ok(text.includes('"hi"'));
      assert.ok(text.includes('[DONE]'));
      assert.ok(!text.includes('prompt_tokens'));
      assert.equal(loadCalls(log)[0].input, 40);
    },
  );
});

test('recorder leaves streamed usage alone when the client asked for it', async () => {
  await withServers(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7 } })}\n\n`);
    },
    async ({ base }) => {
      const res = await post(`${base}/chat/completions`, { model: 'm', stream: true, stream_options: { include_usage: true }, messages: [] });
      assert.ok((await res.text()).includes('prompt_tokens'));
    },
  );
});

test('recorder passes other requests through and skips failed calls', async () => {
  await withServers(
    (req, res) => {
      res.writeHead(req.method === 'GET' ? 200 : 500, { 'content-type': 'application/json' });
      res.end('{"usage":{"prompt_tokens":1},"data":[]}');
    },
    async ({ base, log }) => {
      assert.equal((await fetch(`${base}/v1/models`)).status, 200);
      assert.equal((await post(`${base}/v1/chat/completions`, { model: 'm', messages: [] })).status, 500);
      assert.deepEqual(loadCalls(log), []);
    },
  );
});

test('recorder does not count embeddings as conversations', async () => {
  await withServers(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"model":"e","usage":{"prompt_tokens":9}}');
    },
    async ({ base, log }) => {
      assert.equal((await post(`${base}/v1/embeddings`, { model: 'e', input: 'x' })).status, 200);
      assert.deepEqual(loadCalls(log), []);
    },
  );
});

test('recorder returns a clear error when the server is down', async () => {
  const log = join(tmp(), 'calls.jsonl');
  const rec = await startRecorder({ target: 'http://127.0.0.1:9', port: 0, log });
  const res = await post(`http://127.0.0.1:${rec.address().port}/v1/chat/completions`, { model: 'm', messages: [] });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /could not reach/);
  rec.close();
});

test('recorder only listens on this machine', async () => {
  const log = join(tmp(), 'calls.jsonl');
  const rec = await startRecorder({ target: 'http://127.0.0.1:9', port: 0, log });
  assert.equal(rec.address().address, '127.0.0.1');
  rec.close();
});

test('scan --agent open reads a log, and a half-written line is skipped', () => {
  const log = join(tmp(), 'calls.jsonl');
  const rows = [call(0, { input: 8000, cached: 0, promptMs: 16000 }), call(1, { promptMs: 1000 }), call(60, { input: 10200, cached: 0, promptMs: 21000 })];
  writeFileSync(log, rows.map((c) => JSON.stringify(c)).join('\n') + '\n{"t":17');
  const cli = fileURLToPath(new URL('../bin/warm-window.js', import.meta.url));
  const text = execFileSync('node', [cli, 'scan', '--agent', 'open', '--log', log], { encoding: 'utf8' });
  assert.match(text, /Extra waiting/);
  assert.match(text, /qwen/);
  const json = JSON.parse(execFileSync('node', [cli, 'scan', '--agent', 'open', '--log', log, '--json'], { encoding: 'utf8' }));
  assert.equal(json.open.idle.events, 1);
});
