import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'worker.mjs');
const REPO_ROUTING = path.join(ROOT, 'skills', 'lean-orchestrator', 'routing.json');
const README = path.join(ROOT, 'README.md');
const PROVIDERS = path.join(ROOT, 'docs', 'providers.md');
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const strip = (s) => String(s ?? '').replace(ANSI, '').replace(/\r\n/g, '\n');
const slash = (s) => String(s).replace(/\\/g, '/');
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
const temp = (prefix = 'cw-opencode-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
};
const HOME = temp('cw-opencode-home-');
const T = temp('cw-opencode-case-');
let seq = 0;
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const read = (file) => fs.readFileSync(file, 'utf8');
const newBrief = (text = 'Reply with PONG.') => write(path.join(T, `brief-${++seq}.txt`), text);
const newDir = (prefix = 'dir-') => temp(`cw-opencode-${prefix}`);
after(() => {
  for (const d of temps) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});
const envFor = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => {
    const u = k.toUpperCase();
    return !BLOCKED.has(u) && !u.startsWith('WORKER_') && !u.startsWith('FAKE_PROVIDER_');
  })),
  HOME,
  USERPROFILE: HOME,
  ...extra,
});
const run = (args, { cwd = ROOT, env = {}, timeout = 15000 } = {}) => {
  const r = spawnSync(process.execPath, [WORKER, ...args], { env: envFor(env), cwd, encoding: 'utf8', timeout });
  const err = r.error ? `${r.error.code || ''} ${r.error.message}` : '';
  return {
    status: r.status,
    signal: r.signal,
    stdout: strip(r.stdout),
    stderr: strip(r.stderr),
    all: strip((r.stdout || '') + (r.stderr || '') + (err ? `\n${err}` : '')),
  };
};
const routerLine = (stdout, name) => strip(stdout).split('\n').find((line) => line.startsWith(`router ${name}:`));

// The fake agent: OPENCODE_BIN=process.execPath makes the worker run
// `node run --standalone -m <id> ...` with cwd = --dir, so run.js is the agent.
function fakeAgent(dir, { marker, sleepMs = 0, answer = 'PONG2' } = {}) {
  const lines = [];
  if (marker) lines.push(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const print = `process.stdout.write(${JSON.stringify(`${answer}\n`)});`;
  lines.push(sleepMs ? `setTimeout(() => { ${print} }, ${sleepMs});` : print);
  return write(path.join(dir, 'run.js'), `${lines.join('\n')}\n`);
}
const fakeHttp = (answer) => write(path.join(temp('cw-opencode-http-'), 'answer.txt'), answer);

// A v2 routing file with one read-only kind: OpenCode first, then an http fake.
function makeRouting({ timeoutSec } = {}) {
  const opencodeRoute = { router: 'opencode', id: 'p/m' };
  if (timeoutSec !== undefined) opencodeRoute.timeoutSec = timeoutSec;
  return write(path.join(temp('cw-opencode-routing-'), 'routing.json'), JSON.stringify({
    version: 2,
    routers: {
      opencode: { type: 'opencode', bin: ['opencode2', 'opencode'], free: 'uses your OpenCode providers' },
      fake: { type: 'http', baseUrl: 'https://fake.invalid/v1', keyEnv: 'FAKE_PROVIDER_KEY', signup: 'https://example.invalid', free: true },
    },
    models: {
      'probe-model': {
        family: 'probe',
        routes: [opencodeRoute, { router: 'fake', id: 'm' }],
      },
    },
    claude_agents: {},
    kinds: {
      probe: { tier: '0', use_when: 'OpenCode version gate tests', picks: [{ model: 'probe-model' }] },
    },
  }, null, 2));
}
const programEnv = (routing, version, answer) => ({
  WORKER_ROUTING: routing,
  OPENCODE_BIN: process.execPath,
  WORKER_FAKE_OPENCODE_VERSION: version,
  WORKER_FAKE_HTTP: fakeHttp(answer),
  FAKE_PROVIDER_KEY: 'fake-provider-key',
  WORKER_SLOT_DIR: newDir('slots-'),
  WORKER_OPENCODE_SLOTS: '1',
  WORKER_SLOT_WAIT: '2',
});

describe('worker.mjs doctor OpenCode version', () => {
  it('marks OpenCode 1.19.5 as TOO OLD and points at @opencode/cli', () => {
    const r = run(['doctor'], { env: {
      OPENCODE_BIN: process.execPath,
      WORKER_FAKE_OPENCODE_VERSION: 'opencode v1.19.5',
    } });
    assert.equal(r.status, 0, r.all);
    const line = routerLine(r.stdout, 'opencode');
    assert.ok(line, `no "router opencode:" line in:\n${r.stdout}`);
    assert.match(line, /TOO OLD/, line);
    assert.ok(line.includes('1.19.5'), line);
    assert.ok(line.includes('@opencode/cli'), line);
  });

  it('marks OpenCode 2.2.7 as READY for every version text the CLI prints', () => {
    for (const version of ['opencode v2.2.7', '2.2.7', 'v2.2.7\r\n']) {
      const r = run(['doctor'], { env: {
        OPENCODE_BIN: process.execPath,
        WORKER_FAKE_OPENCODE_VERSION: version,
      } });
      assert.equal(r.status, 0, `${JSON.stringify(version)}\n${r.all}`);
      const line = routerLine(r.stdout, 'opencode');
      assert.ok(line, `no "router opencode:" line for ${JSON.stringify(version)}:\n${r.stdout}`);
      assert.match(line, /READY/, `${JSON.stringify(version)}: ${line}`);
      assert.ok(line.includes('2.2.7'), `${JSON.stringify(version)}: ${line}`);
    }
  });
});

describe('worker.mjs OpenCode routes', () => {
  it('skips an OpenCode 1 binary and takes the next route', () => {
    const dir = newDir('oc-old-');
    const marker = path.join(dir, 'ran.marker');
    fakeAgent(dir, { marker, answer: 'PONG2' });
    const brief = newBrief();
    const r = run(['run', 'probe', brief, '--dir', dir, '--no-claude'], {
      env: programEnv(makeRouting(), 'opencode v1.19.5', 'PONG'),
    });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stderr, /too old/i, r.all);
    assert.ok(r.stdout.includes('PONG'), r.all);
    assert.ok(!r.stdout.includes('PONG2'), `the fake agent answered:\n${r.all}`);
    assert.ok(!fs.existsSync(marker), 'run.js ran even though the OpenCode binary is too old');
  });

  it('runs the OpenCode 2 agent and returns its answer', () => {
    const dir = newDir('oc-new-');
    fakeAgent(dir, { answer: 'PONG2' });
    const brief = newBrief();
    const r = run(['run', 'probe', brief, '--dir', dir, '--no-claude'], {
      env: programEnv(makeRouting(), 'opencode v2.2.7', 'PONG'),
    });
    assert.equal(r.status, 0, r.all);
    assert.ok(r.stdout.includes('PONG2'), r.all);
  });

  it('enforces a per-route timeoutSec and then takes the next route', () => {
    const dir = newDir('oc-slow-');
    fakeAgent(dir, { sleepMs: 6000, answer: 'PONG2' });
    const brief = newBrief();
    const started = Date.now();
    const r = run(['run', 'probe', brief, '--dir', dir, '--no-claude', '--timeout', '60'], {
      env: programEnv(makeRouting({ timeoutSec: 1 }), 'opencode v2.2.7', 'PONG'),
    });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 0, r.all);
    assert.match(r.stderr, /timed out after 1s/i, r.all);
    assert.ok(elapsed < 5000, `the route took ${elapsed}ms; timeoutSec 1 was not enforced`);
    assert.ok(r.stdout.includes('PONG'), r.all);
    assert.ok(!r.stdout.includes('PONG2'), `the slow fake agent answered:\n${r.all}`);
  });
});

describe('worker.mjs OpenCode lookup', () => {
  it('prefers opencode2 over opencode on PATH', () => {
    const dirA = newDir('path-a-');
    const dirB = newDir('path-b-');
    const exe = process.platform === 'win32' ? '.exe' : '';
    for (const [dir, name] of [[dirA, 'opencode'], [dirB, 'opencode2']]) {
      const file = path.join(dir, `${name}${exe}`);
      fs.copyFileSync(process.execPath, file);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
    }
    const r = run(['doctor'], { env: {
      PATH: `${dirA}${path.delimiter}${dirB}`,
      WORKER_FAKE_OPENCODE_VERSION: '2.2.7',
    } });
    assert.equal(r.status, 0, r.all);
    const line = routerLine(r.stdout, 'opencode');
    assert.ok(line, `no "router opencode:" line in:\n${r.stdout}`);
    const flat = slash(line);
    assert.ok(
      flat.includes(slash(path.join(dirB, 'opencode2'))),
      `doctor did not name the opencode2 path (${path.join(dirB, 'opencode2')}): ${line}`,
    );
    assert.ok(
      !flat.includes(slash(path.join(dirA, 'opencode'))),
      `doctor named the opencode path instead of opencode2: ${line}`,
    );
  });
});

describe('routing.json OpenCode routes', () => {
  const R = JSON.parse(read(REPO_ROUTING));
  const isHttp = (route) => R.routers?.[route.router]?.type === 'http';
  for (const model of ['deepseek-flash', 'glm-flash']) {
    it(`${model} tries OpenCode before any http route`, () => {
      const routes = R.models?.[model]?.routes || [];
      const firstOc = routes.findIndex((route) => route.router === 'opencode');
      const firstHttp = routes.findIndex(isHttp);
      assert.ok(firstOc >= 0, `${model} has no opencode route: ${JSON.stringify(routes)}`);
      assert.ok(firstHttp >= 0, `${model} has no http route: ${JSON.stringify(routes)}`);
      assert.ok(
        firstOc < firstHttp,
        `${model} puts its opencode route at ${firstOc}, after its first http route at ${firstHttp}: ${JSON.stringify(routes)}`,
      );
    });
  }

  it('uses namespaced OpenCode ids and prefers opencode2', () => {
    assert.ok(R.routers?.opencode, 'routers.opencode is missing');
    assert.deepEqual(R.routers.opencode.bin, ['opencode2', 'opencode']);
    const ids = [];
    for (const [name, model] of Object.entries(R.models || {})) {
      for (const route of model.routes || []) {
        if (route.router === 'opencode') ids.push({ name, id: route.id });
      }
    }
    assert.ok(ids.length > 0, 'routing.json has no opencode routes');
    const prefixes = ['nvidia/', 'cloudflare-workers-ai/', 'openrouter/'];
    for (const { name, id } of ids) {
      assert.ok(
        typeof id === 'string' && prefixes.some((prefix) => id.startsWith(prefix)),
        `${name}: bad opencode id ${JSON.stringify(id)}`,
      );
    }
  });
});

describe('OpenCode docs', () => {
  it('README names both packages, the login command and stays under 240 lines', () => {
    const text = read(README);
    assert.ok(text.includes('@opencode/cli'), 'README.md does not mention @opencode/cli');
    assert.ok(text.includes('opencode-ai'), 'README.md does not mention opencode-ai');
    assert.ok(text.includes('opencode auth login'), 'README.md does not show opencode auth login');
    const lines = text.trimEnd().split(/\r?\n/).length;
    assert.ok(lines < 240, `README.md has ${lines} lines`);
  });

  it('docs/providers.md explains the package, patience and the 5 to 10 minute cold start', () => {
    const text = read(PROVIDERS);
    for (const needle of ['@opencode/cli', 'patience', '5 to 10 minutes']) {
      assert.ok(text.includes(needle), `docs/providers.md does not mention ${JSON.stringify(needle)}`);
    }
  });
});
