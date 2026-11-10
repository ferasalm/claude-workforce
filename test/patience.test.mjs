import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'worker.mjs');
const REPO_ROUTING = path.join(ROOT, 'skills', 'lean-orchestrator', 'routing.json');
const KEY = 'test-key-123';
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const strip = (s) => String(s ?? '').replace(ANSI, '').replace(/\r\n/g, '\n');
const BLOCKED = new Set([
  'NVIDIA_API_KEY',
  'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'AGY_BIN',
  'OPENCODE_BIN',
  'CLAUDE_CODE_CHILD_SESSION',
]);
const temps = [];
const temp = (prefix = 'cw-patience-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
};
const HOME = temp('cw-patience-home-');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const read = (file) => fs.readFileSync(file, 'utf8');
const envFor = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => {
    const u = k.toUpperCase();
    return !BLOCKED.has(u) && !u.startsWith('WORKER_') && !u.startsWith('FAKE_PROVIDER_');
  })),
  HOME,
  USERPROFILE: HOME,
  ...extra,
});
after(() => {
  for (const d of temps) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

// The fake provider lives in this process, so the worker must never be spawned sync.
function runWorker(args, { env = {}, cwd = ROOT, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { env: envFor(env), cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) });
    });
  });
}

// Scripted per request number. The script runs after the worker's body has arrived.
function serve(script) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const entry = { n: requests.length + 1, at: Date.now(), method: req.method, url: req.url, headers: req.headers, body: '' };
    requests.push(entry);
    const n = entry.n;
    req.setEncoding('utf8');
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('data', (chunk) => { entry.body += chunk; });
    req.on('end', () => {
      entry.endedAt = Date.now();
      Promise.resolve()
        .then(() => script({ n, req, res, entry, requests }))
        .catch(() => { try { res.destroy(); } catch { /* already gone */ } });
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        requests,
        close: () => new Promise((done) => {
          for (const socket of sockets) { try { socket.destroy(); } catch { /* already gone */ } }
          server.close(() => done());
        }),
      });
    });
  });
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
const sseDelta = (res, text) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
function ssePong(res) {
  res.writeHead(200, SSE_HEADERS);
  sseDelta(res, 'PO');
  sseDelta(res, 'NG');
  res.write('data: [DONE]\n\n');
  res.end();
}
function jsonPong(res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'PONG' } }] }));
}
function status(res, code) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `status ${code}` } }));
}
const hold = () => {};

async function start(script, { patience } = {}) {
  const srv = await serve(script);
  const router = {
    type: 'http',
    baseUrl: `http://127.0.0.1:${srv.port}/v1`,
    keyEnv: 'FAKE_PROVIDER_KEY',
    signup: 'https://example.invalid',
  };
  if (patience) router.patience = patience;
  const routing = write(path.join(temp('cw-patience-routing-'), 'routing.json'), JSON.stringify({
    version: 2,
    routers: { fake: router },
    models: { 'fake-model': { family: 'fake', routes: [{ router: 'fake', id: 'm' }] } },
    claude_agents: {},
    kinds: { probe: { tier: '0', use_when: 'patience tests', picks: [{ model: 'fake-model' }] } },
  }, null, 2));
  const brief = write(path.join(temp('cw-patience-case-'), 'brief.txt'), 'Reply with PONG.');
  return {
    ...srv,
    brief,
    routing,
    run: (opts = {}) => runWorker(['run', 'probe', brief, '--no-claude', '--timeout', '60'], {
      env: { WORKER_ROUTING: routing, FAKE_PROVIDER_KEY: KEY },
      ...opts,
    }),
  };
}
const outFile = (c) => `${c.brief}.probe.out.txt`;

describe('worker.mjs patience', () => {
  it('sends a streaming POST to /v1/chat/completions with the bearer key', { timeout: 20000 }, async () => {
    const c = await start(({ res }) => ssePong(res));
    try {
      const r = await c.run();
      assert.equal(r.status, 0, r.all);
      assert.equal(c.requests.length, 1, `saw ${c.requests.length} requests`);
      const req = c.requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, `Bearer ${KEY}`);
      assert.equal(JSON.parse(req.body).stream, true, 'request body did not set "stream": true');
    } finally {
      await c.close();
    }
  });

  it('prints and saves the concatenated stream deltas', { timeout: 20000 }, async () => {
    const c = await start(({ res }) => ssePong(res));
    try {
      const r = await c.run();
      assert.equal(r.status, 0, r.all);
      assert.ok(r.stdout.includes('PONG'), r.stdout);
      assert.equal(read(outFile(c)).trim(), 'PONG');
    } finally {
      await c.close();
    }
  });

  it('accepts a plain JSON answer from a server that ignores stream', { timeout: 20000 }, async () => {
    const c = await start(({ res }) => jsonPong(res));
    try {
      const r = await c.run();
      assert.equal(r.status, 0, r.all);
      assert.ok(r.stdout.includes('PONG'), r.stdout);
      assert.equal(read(outFile(c)).trim(), 'PONG');
    } finally {
      await c.close();
    }
  });

  it('reconnects through a socket error, a stall, 429 and 504', { timeout: 20000 }, async () => {
    const c = await start(({ n, req, res }) => {
      if (n === 1) { req.socket.destroy(); return; }
      if (n === 2) return hold();
      if (n === 3) return status(res, 429);
      if (n === 4) return status(res, 504);
      return ssePong(res);
    }, { patience: { attempts: 6, firstTokenSec: 0.5, idleSec: 1, backoffSec: [0.1] } });
    try {
      const r = await c.run();
      assert.equal(r.status, 0, r.all);
      assert.ok(r.stdout.includes('PONG'), r.stdout);
      assert.equal(read(outFile(c)).trim(), 'PONG');
      assert.equal(c.requests.length, 5, `saw ${c.requests.length} requests`);
      const retries = r.stderr.split('\n').filter((line) => /retry/i.test(line) && /attempt/i.test(line));
      assert.ok(retries.length >= 4, `expected a retry line per failed attempt, got ${retries.length}:\n${r.stderr}`);
    } finally {
      await c.close();
    }
  });

  it('gives up after the configured attempts when no first token arrives', { timeout: 20000 }, async () => {
    const c = await start(hold, { patience: { attempts: 3, firstTokenSec: 0.5, idleSec: 1, backoffSec: [0.1] } });
    const started = Date.now();
    let r;
    try {
      r = await c.run({ timeoutMs: 11000 });
    } finally {
      await c.close();
    }
    const elapsed = Date.now() - started;
    assert.notEqual(r.status, 0, r.all);
    assert.ok(elapsed < 10000, `took ${elapsed}ms; firstTokenSec did not stop the route`);
    assert.equal(c.requests.length, 3, `saw ${c.requests.length} requests`);
  });

  it('drops partial text and retries after an idle stream', { timeout: 20000 }, async () => {
    const MARK = 'XXPARTIALXX';
    const c = await start(({ n, res }) => {
      if (n === 1) {
        res.writeHead(200, SSE_HEADERS);
        sseDelta(res, MARK);
        return hold();
      }
      return ssePong(res);
    }, { patience: { attempts: 3, firstTokenSec: 2, idleSec: 0.5, backoffSec: [0.1] } });
    try {
      const r = await c.run({ timeoutMs: 10000 });
      assert.equal(r.status, 0, r.all);
      assert.equal(c.requests.length, 2, `saw ${c.requests.length} requests`);
      assert.ok(!r.stdout.includes(MARK), `partial text from the failed attempt leaked:\n${r.stdout}`);
      assert.ok(r.stdout.includes('PONG'), r.stdout);
      assert.equal(read(outFile(c)).trim(), 'PONG');
    } finally {
      await c.close();
    }
  });

  it('waits the configured backoff between reconnects', { timeout: 20000 }, async () => {
    const c = await start(({ n, res }) => (n < 3 ? status(res, 503) : ssePong(res)), {
      patience: { attempts: 6, firstTokenSec: 1, idleSec: 1, backoffSec: [0.6, 1.2] },
    });
    try {
      const r = await c.run();
      assert.equal(r.status, 0, r.all);
      assert.equal(c.requests.length, 3, `saw ${c.requests.length} requests`);
      const firstGap = c.requests[1].at - c.requests[0].at;
      const secondGap = c.requests[2].at - c.requests[1].at;
      assert.ok(firstGap >= 500, `gap after request 1 was ${firstGap}ms`);
      assert.ok(secondGap >= 1100, `gap after request 2 was ${secondGap}ms`);
      assert.equal(read(outFile(c)).trim(), 'PONG');
    } finally {
      await c.close();
    }
  });

  it('does not retry a client error', { timeout: 20000 }, async () => {
    const c = await start(({ res }) => status(res, 400), {
      patience: { attempts: 6, firstTokenSec: 1, idleSec: 1, backoffSec: [0.1] },
    });
    try {
      const r = await c.run();
      assert.notEqual(r.status, 0, r.all);
      assert.equal(c.requests.length, 1, `retried a client error: ${c.requests.length} requests`);
    } finally {
      await c.close();
    }
  });

  it('caps the whole route with totalSec', { timeout: 20000 }, async () => {
    const c = await start(hold, {
      patience: { attempts: 50, firstTokenSec: 0.5, idleSec: 1, backoffSec: [0.1], totalSec: 2 },
    });
    try {
      const started = Date.now();
      const r = await c.run({ timeoutMs: 8000 });
      const elapsed = Date.now() - started;
      assert.notEqual(r.status, 0, r.all);
      assert.ok(elapsed < 6000, `took ${elapsed}ms; totalSec did not cap the route`);
    } finally {
      await c.close();
    }
  });

  it('retries once by default and never leaks the provider key', { timeout: 20000 }, async () => {
    const c = await start(({ n, res }) => (n === 1 ? status(res, 503) : ssePong(res)));
    try {
      const r = await c.run();
      const outPath = outFile(c);
      const out = fs.existsSync(outPath) ? read(outPath) : '';
      assert.ok(!r.stdout.includes(KEY), `key leaked to stdout:\n${r.stdout}`);
      assert.ok(!r.stderr.includes(KEY), `key leaked to stderr:\n${r.stderr}`);
      assert.ok(!out.includes(KEY), `key leaked to the .out.txt file:\n${out}`);
      assert.equal(r.status, 0, r.all);
      assert.ok(c.requests.length >= 2, `saw ${c.requests.length} requests; no default retry`);
      assert.equal(out.trim(), 'PONG');
    } finally {
      await c.close();
    }
  });

  it('ships an nvidia patience for multi-minute cold starts', { timeout: 20000 }, () => {
    const routing = JSON.parse(read(REPO_ROUTING));
    const patience = routing?.routers?.nvidia?.patience;
    assert.ok(patience, 'routers.nvidia.patience is missing from skills/lean-orchestrator/routing.json');
    assert.ok(Number(patience.attempts) >= 8, `nvidia attempts = ${patience.attempts}`);
    assert.ok(Number(patience.totalSec) >= 900, `nvidia totalSec = ${patience.totalSec}`);
  });
});
