// A small local recorder for any model server: llama.cpp, Ollama, vLLM, LM Studio, or a
// hosted API such as DeepSeek or OpenRouter. It forwards each request unchanged and keeps
// token counts and timing. It never stores prompts, replies or API keys.

import http from 'node:http';
import https from 'node:https';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function logPath() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'warm-window', 'calls.jsonl');
}

/** Merge whatever usage a server reported into acc. Handles each API's field names. */
export function readUsage(o, acc = {}) {
  if (!o || typeof o !== 'object') return acc;
  const model = o.model || o.response?.model || o.message?.model;
  // llama.cpp reports the model's file path, which shouldn't end up in a log.
  if (typeof model === 'string' && model) acc.model = /^(\/|~|[A-Za-z]:\\)/.test(model) ? model.split(/[\\/]/).pop() : model;
  const u = o.usage || o.response?.usage || o.message?.usage;
  if (u) {
    const details = u.prompt_tokens_details || u.input_tokens_details || {};
    if (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
      // Anthropic format: input_tokens leaves out both cache counts.
      acc.cached = u.cache_read_input_tokens || 0;
      acc.write = u.cache_creation_input_tokens || 0;
      acc.input = (u.input_tokens || 0) + acc.cached + acc.write;
    } else if (u.prompt_tokens !== undefined) {
      acc.input = u.prompt_tokens;
    } else if (u.input_tokens !== undefined) {
      acc.input ??= u.input_tokens;
    }
    const cached = details.cached_tokens ?? u.prompt_cache_hit_tokens;
    if (cached !== undefined) acc.cached = cached;
    if (details.cache_write_tokens !== undefined) acc.write = details.cache_write_tokens;
    const out = u.completion_tokens ?? u.output_tokens;
    if (out !== undefined) acc.output = out;
    if (typeof u.cost === 'number') acc.cost = u.cost;
  }
  if (o.timings) {
    // llama.cpp
    if (o.timings.cache_n !== undefined) acc.cached = o.timings.cache_n;
    if (o.timings.prompt_ms !== undefined) acc.promptMs = o.timings.prompt_ms;
    if (acc.input === undefined && o.timings.prompt_n !== undefined) acc.input = o.timings.prompt_n + (o.timings.cache_n || 0);
  }
  if (o.done === true) {
    // Ollama native API. Older versions leave cached tokens out of prompt_eval_count, so
    // it only counts as context size when the cached count is there too.
    if (o.prompt_eval_cached_count !== undefined) {
      acc.cached = o.prompt_eval_cached_count;
      if (o.prompt_eval_count !== undefined) acc.input = o.prompt_eval_count;
    }
    if (o.prompt_eval_duration !== undefined) acc.promptMs = o.prompt_eval_duration / 1e6;
    if (o.load_duration !== undefined) acc.loadMs = o.load_duration / 1e6;
    if (o.eval_count !== undefined) acc.output = o.eval_count;
  }
  return acc;
}

function salt(path) {
  const file = join(dirname(path), 'salt');
  if (existsSync(file)) return readFileSync(file);
  const s = randomBytes(32);
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

/** A keyed hash of how the conversation starts, so its calls can be grouped without storing its text. */
export function conversationId(body, key) {
  const opening = (x) => (Array.isArray(x) ? x.slice(0, 2) : typeof x === 'string' ? x.slice(0, 2000) : null);
  const start = opening(body.messages) ?? opening(body.input) ?? opening(body.prompt) ?? '';
  return createHmac('sha256', key).update(JSON.stringify([body.system ?? null, start])).digest('hex').slice(0, 16);
}

const DROP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'te', 'upgrade']);

const isUsageOnly = (o) => o && Array.isArray(o.choices) && o.choices.length === 0 && o.usage;

function parseLine(buf) {
  const s = buf.toString('utf8').trim().replace(/^data:\s*/, '');
  if (!s || s[0] !== '{') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function startRecorder({ target, port = 8788, host = '127.0.0.1', log = logPath() }) {
  const up = new URL(target);
  const client = up.protocol === 'https:' ? https : http;
  const prefix = up.pathname.replace(/\/$/, '');
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const key = salt(log);

  const record = (c) => {
    try {
      appendFileSync(log, JSON.stringify(c) + '\n', { mode: 0o600 });
    } catch (e) {
      process.stderr.write(`warm-window: could not write ${log}: ${e.message}\n`); // never break the call itself
    }
  };

  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      let raw = Buffer.concat(parts);
      let body = null;
      if (req.method === 'POST') {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = null;
        }
      }
      const isEmbedding = /embed/i.test(req.url.split('?')[0]);
      const isModelCall = body && typeof body === 'object' && typeof body.model === 'string' && !isEmbedding;
      // Streaming chat replies leave usage out unless asked. If this client didn't ask,
      // ask for it, then hide that extra chunk so the client sees what it expected.
      let hideUsage = false;
      if (isModelCall && body.stream === true && req.url.split('?')[0].endsWith('/chat/completions') && !body.stream_options?.include_usage) {
        body.stream_options = { ...body.stream_options, include_usage: true };
        raw = Buffer.from(JSON.stringify(body));
        hideUsage = true;
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
      headers['content-length'] = raw.length;
      headers['accept-encoding'] = 'identity';

      const started = Date.now();
      const acc = {};
      let ttftMs = null;
      const proxied = client.request(
        { protocol: up.protocol, hostname: up.hostname, port: up.port, method: req.method, path: prefix + req.url, headers },
        (upRes) => {
          const type = String(upRes.headers['content-type'] || '');
          const streaming = /event-stream|ndjson/.test(type);
          const readable = !upRes.headers['content-encoding'];
          const out = { ...upRes.headers };
          delete out['transfer-encoding'];
          delete out.connection;
          if (streaming) delete out['content-length'];
          res.writeHead(upRes.statusCode, out);

          let tail = Buffer.alloc(0);
          const whole = [];
          let size = 0;
          const handleLine = (line) => {
            const o = isModelCall && readable ? parseLine(line) : null;
            if (o) {
              if (ttftMs === null) ttftMs = Date.now() - started;
              readUsage(o, acc);
            }
            return !(hideUsage && isUsageOnly(o));
          };
          upRes.on('data', (d) => {
            if (!streaming) {
              res.write(d);
              if (isModelCall && readable && size < 20e6) {
                whole.push(d);
                size += d.length;
              }
              return;
            }
            tail = Buffer.concat([tail, d]);
            let i;
            while ((i = tail.indexOf(10)) >= 0) {
              const line = tail.subarray(0, i + 1);
              tail = tail.subarray(i + 1);
              if (handleLine(line)) res.write(line);
            }
          });
          upRes.on('end', () => {
            if (tail.length && handleLine(tail)) res.write(tail);
            res.end();
            if (!streaming && whole.length) {
              const o = parseLine(Buffer.concat(whole));
              if (o) readUsage(o, acc);
            }
            if (isModelCall && upRes.statusCode < 300 && Object.keys(acc).some((k) => k !== 'model')) {
              record({
                t: started,
                conv: conversationId(body, key),
                host: up.hostname,
                model: acc.model || body.model,
                input: acc.input ?? null,
                cached: acc.cached ?? null,
                write: acc.write ?? 0,
                output: acc.output ?? 0,
                ...(acc.cost !== undefined && { cost: acc.cost }),
                ...(acc.promptMs !== undefined && { promptMs: Math.round(acc.promptMs) }),
                ...(acc.loadMs !== undefined && { loadMs: Math.round(acc.loadMs) }),
                ...(ttftMs !== null && { ttftMs }),
              });
            }
          });
          upRes.on('error', () => res.destroy());
        },
      );
      proxied.on('error', (e) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `warm-window could not reach ${target}: ${e.message}` } }));
      });
      res.on('close', () => {
        if (!res.writableEnded) proxied.destroy();
      });
      proxied.end(raw);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
