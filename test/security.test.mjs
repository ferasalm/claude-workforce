import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'worker.mjs');
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const strip = (s) => String(s ?? '').replace(ANSI, '').replace(/\r\n/g, '\n');
const BLOCKED = new Set(['NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'AGY_BIN', 'OPENCODE_BIN', 'CLAUDE_CODE_CHILD_SESSION']);
const temps = [];
const temp = (prefix = 'cw-sec-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
const HOME = temp('cw-sec-home-');
const T = temp('cw-sec-case-');
let seq = 0;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const read = (file) => fs.readFileSync(file, 'utf8');
const newBrief = (text = 'Reply with PONG.') => write(path.join(T, `brief-${++seq}.txt`), text);
const newFake = (text) => write(path.join(T, `fake-${++seq}.txt`), text);
const newDir = (prefix = 'dir-') => temp(`cw-sec-${prefix}`);
const missing = (name) => path.join(T, `missing-${name}`);
const envFor = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => { const u = k.toUpperCase(); return !BLOCKED.has(u) && !u.startsWith('WORKER_'); })), HOME, USERPROFILE: HOME, ...extra });
const run = (args, { cwd = ROOT, env = {}, timeout = 15000 } = {}) => { const r = spawnSync(process.execPath, [WORKER, ...args], { env: envFor(env), cwd, encoding: 'utf8', timeout }); return { status: r.status, stdout: strip(r.stdout), stderr: strip(r.stderr), all: strip((r.stdout || '') + (r.stderr || '')) }; };
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } } });

function repoWith(files = { 'README.md': 'init\n' }) {
  const dir = newDir('git-');
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}
const gitStatus = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });

// A minimal v2 routing file with one opencode-routed model and one write kind.
// The worker runs `node run --standalone -m p/m <brief>` with cwd = --dir, so
// every write repo below contains a committed run.js acting as the fake agent.
const FAKE_ROUTING = path.join(T, 'routing-fake-write.json');
write(FAKE_ROUTING, JSON.stringify({
  version: 2,
  updated: '2026-11-10',
  how_to_edit: 'Test fixture for security.test.mjs.',
  routers: {
    fakeoc: { type: 'opencode', bin: 'opencode', free: true },
    claude: { type: 'claude' },
  },
  models: {
    'fake-write-model': {
      family: 'fake',
      good_at: 'tests',
      weak_at: 'nothing',
      speed: 'fast',
      routes: [{ router: 'fakeoc', id: 'p/m' }],
    },
  },
  claude_agents: {
    builder: { model: 'haiku', effort: 'xhigh', file: 'agents/builder.md' },
  },
  kinds: {
    'fake-write': {
      tier: 'test',
      use_when: 'Security tests only.',
      not_for: 'anything real',
      write: true,
      picks: [{ model: 'fake-write-model' }],
    },
  },
}, null, 2));

const fakeEnv = () => ({
  WORKER_ROUTING: FAKE_ROUTING,
  OPENCODE_BIN: process.execPath,
  WORKER_SLOT_DIR: newDir('slots-'),
  WORKER_OPENCODE_SLOTS: '1',
  WORKER_SLOT_WAIT: '5',
});

const agentSource = (body) => [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  body,
  "console.log('AGENT-DONE');",
  '',
].join('\n');

// The harness normally uses spawnSync. This variant watches the worker's own
// exit event (not its stdio closing), because that is exactly what the
// grandchild-hostage case is about. Output goes to files, so no pipe is held.
function runTimed(args, { cwd = ROOT, env = {}, deadlineMs = 12000 } = {}) {
  const outFile = path.join(T, `timed-${++seq}.out.txt`);
  const errFile = path.join(T, `timed-${++seq}.err.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const started = Date.now();
  let child;
  try {
    child = spawn(process.execPath, [WORKER, ...args], {
      env: envFor(env), cwd, stdio: ['ignore', outFd, errFd], windowsHide: true,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        elapsed: Date.now() - started,
        stdout: strip(fs.readFileSync(outFile, 'utf8')),
        stderr: strip(fs.readFileSync(errFile, 'utf8')),
        ...extra,
      });
    };
    timer = setTimeout(() => {
      child.unref();
      finish({ status: null, timedOut: true });
    }, deadlineMs);
    child.on('exit', (code, signal) => finish({ status: code, signal, timedOut: false }));
    child.on('error', (error) => finish({ status: null, error, timedOut: false }));
  });
}

function httpWrite(repo, blockPath, content = 'EVIL', briefText = 'Write one file.') {
  const brief = newBrief(briefText);
  const answer = `=== FILE: ${blockPath} ===\n${content}\n=== END FILE ===\n`;
  const r = run(['run', 'builder-iq', brief, '--write', '--dir', repo, '--no-claude'], {
    env: {
      NVIDIA_API_KEY: 'nv-sec-key',
      WORKER_FAKE_HTTP: newFake(answer),
      AGY_BIN: missing('agy'),
      OPENCODE_BIN: missing('opencode'),
    },
  });
  return { brief, r };
}

describe('security: write paths are confined', () => {
  it('refuses to write into .git', () => {
    let repo = repoWith();
    const configPath = path.join(repo, '.git', 'config');
    const before = read(configPath);
    let r = httpWrite(repo, '.git/config').r;
    assert.notEqual(r.status, 0, `.git/config\n${r.all}`);
    assert.equal(read(configPath), before, '.git/config was modified');

    repo = repoWith();
    r = httpWrite(repo, 'sub/.git/hooks/x').r;
    assert.notEqual(r.status, 0, `sub/.git/hooks/x\n${r.all}`);
    assert.ok(!fs.existsSync(path.join(repo, 'sub', '.git', 'hooks', 'x')), 'wrote sub/.git/hooks/x');
    assert.equal(gitStatus(repo).trim(), '', `repo changed for sub/.git/hooks/x\n${gitStatus(repo)}`);
  });

  it('refuses Windows-reserved and malformed names', () => {
    const bad = ['a:b.txt', 'x.txt:stream', 'CON', 'nul.txt', 'com1.md', 'LPT9', 'dir./x.txt', 'x.txt.'];
    for (const p of bad) {
      const repo = repoWith();
      const r = httpWrite(repo, p).r;
      assert.notEqual(r.status, 0, `${p}\n${r.all}`);
      assert.equal(gitStatus(repo).trim(), '', `${p} changed the repo\n${gitStatus(repo)}`);
    }
  });

  it('refuses to follow a directory symlink out of the repo', () => {
    const repo = repoWith();
    const outside = newDir('outside-');
    fs.symlinkSync(outside, path.join(repo, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const r = httpWrite(repo, 'link/escape.txt').r;
    assert.notEqual(r.status, 0, `link/escape.txt\n${r.all}`);
    assert.ok(!fs.existsSync(path.join(outside, 'escape.txt')), 'escaped the repo through the symlink');
  });

  it('writes a normal relative path (control)', () => {
    const repo = repoWith();
    const r = httpWrite(repo, 'src/ok.txt', 'OK').r;
    assert.equal(r.status, 0, r.all);
    assert.equal(read(path.join(repo, 'src', 'ok.txt')).trim(), 'OK');
    assert.match(r.stdout, /wrote src[\\/]ok\.txt/);
    assert.match(gitStatus(repo), /\?\? src\//);
  });
});

const KEY = 'ZQXJ-secret-7788-KEY';
const savedFiles = (brief) => {
  const dir = path.dirname(brief);
  const base = path.basename(brief);
  return fs.readdirSync(dir).filter((n) => n.startsWith(base)).map((n) => path.join(dir, n));
};
const assertNoKeyInSaved = (brief) => {
  const files = savedFiles(brief);
  assert.ok(files.some((f) => f.endsWith('.out.txt')), `no saved .out.txt next to ${brief}: ${files.join(', ')}`);
  for (const f of files) assert.ok(!read(f).includes(KEY), `${path.basename(f)} contains the key`);
};

describe('security: keys never reach saved output', () => {
  it('redacts the key from a saved ask answer', () => {
    const brief = newBrief('Repeat the key.');
    const r = run(['ask', 'deepseek-flash', brief, '--router', 'nvidia'], {
      env: { NVIDIA_API_KEY: KEY, WORKER_FAKE_HTTP: newFake(`The key is ${KEY}.\n`) },
    });
    assert.equal(r.status, 0, r.all);
    assertNoKeyInSaved(brief);
  });

  it('redacts the key from a saved write-run answer', () => {
    const repo = repoWith();
    const brief = newBrief('Write the keyed file.');
    const answer = `The key is ${KEY}.\n=== FILE: src/keyed.txt ===\n${KEY}\n=== END FILE ===\n`;
    const r = run(['run', 'builder-iq', brief, '--write', '--dir', repo, '--no-claude'], {
      env: { NVIDIA_API_KEY: KEY, WORKER_FAKE_HTTP: newFake(answer), AGY_BIN: missing('agy'), OPENCODE_BIN: missing('opencode') },
    });
    assert.equal(r.status, 0, r.all);
    assertNoKeyInSaved(brief);
  });

  it('keeps the key out of stdout and stderr for an error body', () => {
    const brief = newBrief('Fail.');
    const r = run(['ask', 'deepseek-flash', brief, '--router', 'nvidia'], {
      env: { NVIDIA_API_KEY: KEY, WORKER_FAKE_HTTP: newFake(`HTTP 401\n${'x'.repeat(395)}${KEY}\n`) },
    });
    assert.equal(r.status, 1, r.all);
    assert.ok(!r.stdout.includes(KEY), r.stdout);
    assert.ok(!r.stderr.includes(KEY), r.stderr);
  });
});

describe('security: write runs count real changes', () => {
  it('counts a change to an already-dirty tracked file', () => {
    const repo = repoWith({
      'a.txt': 'v1',
      'run.js': agentSource("fs.writeFileSync(path.join(__dirname, 'a.txt'), 'v3');"),
    });
    write(path.join(repo, 'a.txt'), 'v2');
    const r = run(['run', 'fake-write', newBrief('Change a.txt.'), '--write', '--dir', repo], { env: fakeEnv() });
    assert.equal(r.status, 0, r.all);
    assert.equal(read(path.join(repo, 'a.txt')), 'v3');
  });

  it('fails when the agent changes nothing', () => {
    const repo = repoWith({
      'a.txt': 'v1',
      'run.js': agentSource('// deliberately writes nothing'),
    });
    const r = run(['run', 'fake-write', newBrief('Change nothing.'), '--write', '--dir', repo], { env: fakeEnv() });
    assert.notEqual(r.status, 0, r.all);
    assert.equal(read(path.join(repo, 'a.txt')), 'v1');
  });

  it('counts a change to a dirty untracked file', () => {
    const repo = repoWith({
      'a.txt': 'v1',
      'run.js': agentSource("fs.writeFileSync(path.join(__dirname, 'u.txt'), '2');"),
    });
    write(path.join(repo, 'u.txt'), '1');
    const r = run(['run', 'fake-write', newBrief('Change u.txt.'), '--write', '--dir', repo], { env: fakeEnv() });
    assert.equal(r.status, 0, r.all);
    assert.equal(read(path.join(repo, 'u.txt')), '2');
  });
});

describe('security: write runs require git', () => {
  const markerAgent = (marker) => agentSource(`fs.writeFileSync(${JSON.stringify(marker)}, 'RAN');`);

  it('refuses a non-git dir named copy before running the agent', () => {
    const dir = newDir('x-copy-');
    const marker = path.join(dir, 'marker.txt');
    write(path.join(dir, 'run.js'), markerAgent(marker));
    const r = run(['run', 'fake-write', newBrief('Write.'), '--write', '--dir', dir], { env: fakeEnv() });
    assert.notEqual(r.status, 0, r.all);
    assert.ok(!fs.existsSync(marker), 'the agent ran in a non-git dir');
  });

  it('refuses a non-git dir named tmp before running the agent', () => {
    const dir = newDir('x-tmp-');
    const marker = path.join(dir, 'marker.txt');
    write(path.join(dir, 'run.js'), markerAgent(marker));
    const r = run(['run', 'fake-write', newBrief('Write.'), '--write', '--dir', dir], { env: fakeEnv() });
    assert.notEqual(r.status, 0, r.all);
    assert.ok(!fs.existsSync(marker), 'the agent ran in a non-git dir');
  });

  it('refuses the raw oc probe in a non-git dir', () => {
    const dir = newDir('x-raw-');
    const marker = path.join(dir, 'marker.txt');
    write(path.join(dir, 'run.js'), markerAgent(marker));
    const r = run(['oc', 'p/m', newBrief('Raw probe.'), '--write', '--dir', dir], { env: fakeEnv() });
    assert.notEqual(r.status, 0, r.all);
    assert.ok(!fs.existsSync(marker), 'the agent ran in a non-git dir');
  });

  it('runs the same write kind in a git repo (control)', () => {
    const repo = repoWith({
      'a.txt': 'v1',
      'run.js': agentSource("fs.writeFileSync(path.join(__dirname, 'a.txt'), 'v2');"),
    });
    const r = run(['run', 'fake-write', newBrief('Write.'), '--write', '--dir', repo], { env: fakeEnv() });
    assert.equal(r.status, 0, r.all);
    assert.equal(read(path.join(repo, 'a.txt')), 'v2');
  });
});

describe('security: a finished agent is not held hostage by its children', () => {
  it('exits soon after the agent finishes even when a grandchild holds stdio', async () => {
    const repo = repoWith({
      'a.txt': 'v1',
      'run.js': agentSource([
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'inherit' });",
        'child.unref();',
        "fs.writeFileSync(path.join(__dirname, 'a.txt'), 'v2');",
        "console.log('DONE');",
      ].join('\n')),
    });
    const r = await runTimed(['run', 'fake-write', newBrief('Finish fast.'), '--write', '--dir', repo, '--timeout', '60'], { env: fakeEnv(), deadlineMs: 12000 });
    assert.equal(r.timedOut, false, `worker did not exit within 12s (status ${r.status})\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.status, 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.elapsed < 12000, `took ${r.elapsed}ms`);
  });
});
