import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools');
const WORKER = path.join(TOOLS, 'worker.mjs');
const ROUTING_V2 = path.join(ROOT, 'skills', 'lean-orchestrator', 'routing.json');
const ROUTING_V1 = path.join(ROOT, 'test', 'fixtures', 'routing-v1.json');
const V2 = JSON.parse(fs.readFileSync(ROUTING_V2, 'utf8'));
const V1 = JSON.parse(fs.readFileSync(ROUTING_V1, 'utf8'));
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const strip = (s) => String(s ?? '').replace(ANSI, '').replace(/\r\n/g, '\n');
const BLOCKED = new Set(['NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'AGY_BIN', 'OPENCODE_BIN', 'CLAUDE_CODE_CHILD_SESSION']);
const temps = [];
const temp = (prefix = 'cw-worker-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(d); return d; };
const HOME = temp('cw-worker-home-');
const T = temp('cw-worker-case-');
let seq = 0;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const read = (file) => fs.readFileSync(file, 'utf8');
const newBrief = (text = 'Reply with PONG.') => write(path.join(T, `brief-${++seq}.txt`), text);
const newFake = (text) => write(path.join(T, `fake-${++seq}.txt`), text);
const newDir = (prefix = 'dir-') => temp(`cw-worker-${prefix}`);
const missing = (name) => path.join(T, `missing-${name}`);
const lastLine = (s) => strip(s).trimEnd().split(/\r?\n/).at(-1) || '';
const norm = (p) => path.resolve(p).replace(/\\/g, '/');
const slash = (s) => String(s).replace(/\\/g, '/');
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ } } });
const envFor = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => { const u = k.toUpperCase(); return !BLOCKED.has(u) && !u.startsWith('WORKER_'); })), HOME, USERPROFILE: HOME, ...extra });
const run = (args, { cwd = ROOT, env = {} } = {}) => { const r = spawnSync(process.execPath, [WORKER, ...args], { env: envFor(env), cwd, encoding: 'utf8', timeout: 60000 }); return { status: r.status, stdout: strip(r.stdout), stderr: strip(r.stderr), all: strip((r.stdout || '') + (r.stderr || '')) }; };
function gitRepo() {
  const dir = newDir('git-');
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  write(path.join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}
const gitStatus = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
const pickLabel = (R, p) => p.claude ? `claude:${p.claude} (${R.claude_agents[p.claude].model} ${R.claude_agents[p.claude].effort})` : `${p.model}(${p.effort || R.models[p.model].effort || 'default'}) via ${R.models[p.model].routes.map((r) => r.router).join('>')}`;
const hasWouldTry = (lines, prefix) => lines.some((l) => l === prefix || l.startsWith(`${prefix} [would skip:`));

describe('worker.mjs doctor', () => {
  it('reports missing keys, missing programs and runnable kinds with no keys', () => {
    const r = run(['doctor'], { env: { AGY_BIN: missing('agy'), OPENCODE_BIN: missing('opencode') } });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^router nvidia: NO KEY \(NVIDIA_API_KEY\) -> https:\/\/build\.nvidia\.com$/m);
    assert.match(r.stdout, /^router openrouter: NO KEY \(OPENROUTER_API_KEY\) -> https:\/\/openrouter\.ai\/keys$/m);
    assert.match(r.stdout, /^router cloudflare: NO KEY \(.+\) -> https:\/\/dash\.cloudflare\.com$/m);
    assert.match(r.stdout, /^router agy: NOT INSTALLED \(.+\)$/m);
    assert.match(r.stdout, /^router opencode: NOT INSTALLED \(.+\)$/m);
    assert.match(r.stdout, /^router claude: READY$/m);
    assert.match(r.stdout, /^kind trivial: claude:scout-lite$/m);
    assert.match(r.stdout, /^kind scout-light: NONE runnable$/m);
    assert.match(r.stdout, /^kind builder-iq: claude:builder$/m);
  });
  it('reports READY and the first runnable route when NVIDIA_API_KEY is set', () => {
    const key = 'nv-test-key-doctor';
    const r = run(['doctor'], { env: { NVIDIA_API_KEY: key, AGY_BIN: missing('agy'), OPENCODE_BIN: missing('opencode') } });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^router nvidia: READY$/m);
    assert.match(r.stdout, /^kind trivial: nemotron-free via nvidia$/m);
    assert.match(r.stdout, /^kind builder-iq: deepseek-flash via nvidia$/m);
  });
  it('honours AGY_BIN and reports a missing path as NOT INSTALLED', () => {
    const r = run(['doctor'], { env: { AGY_BIN: missing('agy-explicit'), OPENCODE_BIN: missing('opencode') } });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^router agy: NOT INSTALLED \(.+\)$/m);
    assert.match(r.stdout, /^kind trivial: claude:scout-lite$/m);
  });
});
describe('worker.mjs routing', () => {
  it('prints every v2 kind and the builder-iq details', () => {
    const r = run(['route']);
    assert.equal(r.status, 0, r.all);
    const lines = r.stdout.split('\n');
    for (const [kind, k] of Object.entries(V2.kinds)) {
      const want = `${kind}\t${k.tier}\t${k.picks.map((p) => pickLabel(V2, p)).join(' | ')}`;
      assert.ok(lines.includes(want), `missing route line: ${want}\n${r.stdout}`);
    }
    const want = 'builder-iq\t3b\tdeepseek-flash(max) via opencode>opencode>nvidia>cloudflare>openrouter | gpt-luna(max) via codex | claude:builder (haiku xhigh) | gemini-flash(high) via agy';
    const d = run(['route', 'builder-iq']);
    assert.equal(d.status, 0, d.all);
    assert.equal(d.stdout.split('\n')[0], want);
    assert.ok(d.stdout.includes(`  use_when: ${V2.kinds['builder-iq'].use_when}`));
    assert.ok(d.stdout.includes('  write: true (needs --write and --dir)'));
  });
  it('prints every v1 kind through the old routing fixture', () => {
    const r = run(['route'], { env: { WORKER_ROUTING: ROUTING_V1 } });
    assert.equal(r.status, 0, r.all);
    const lines = r.stdout.split('\n');
    for (const [kind, k] of Object.entries(V1.kinds)) {
      const want = `${kind}\t${k.tier}\t${k.picks.map((p) => pickLabel(V1, p)).join(' | ')}`;
      assert.ok(lines.includes(want), `missing route line: ${want}\n${r.stdout}`);
    }
    assert.ok(lines.includes('builder-iq\t3b\tdeepseek-flash(max) via cloudflare>openrouter | claude:builder (haiku xhigh) | gemini-flash(high) via agy'));
    assert.ok(run(['route', 'builder-iq'], { env: { WORKER_ROUTING: ROUTING_V1 } }).stdout.includes('  write: true (needs --write and --dir)'));
  });
});
describe('worker.mjs dry-run', () => {
  it('lists every v2 builder-iq route and Claude pick without keys', () => {
    const d = gitRepo(), b = newBrief(), dbg = path.join(d, 'debug.json');
    const r = run(['run', 'builder-iq', b, '--write', '--dir', d, '--dry-run'], { env: { WORKER_DEBUG_PROMPT: dbg } });
    assert.equal(r.status, 0, r.all);
    const lines = r.stdout.split('\n');
    assert.ok(hasWouldTry(lines, '[worker] would try deepseek-flash route nvidia id=deepseek-ai/deepseek-v4.1-flash effort=max mode=http WRITE'), r.stdout);
    assert.ok(hasWouldTry(lines, '[worker] would try deepseek-flash route cloudflare id=@cf/deepseek-ai/deepseek-v4.1-flash-1017 effort=max mode=http WRITE'), r.stdout);
    assert.ok(hasWouldTry(lines, '[worker] would try deepseek-flash route openrouter id=deepseek/deepseek-v4.1-flash-1017 effort=max mode=http WRITE'), r.stdout);
    assert.ok(hasWouldTry(lines, '[worker] would try gemini-flash route agy id=gemini-3.8-flash effort=high mode=agy WRITE'), r.stdout);
    assert.ok(lines.includes(`[worker] NEXT: spawn Claude agent "builder" (model haiku, effort xhigh) with brief ${b}`), r.stdout);
    assert.ok(!fs.existsSync(dbg), 'dry-run sent an http request');
  });
  it('lists v1 builder-iq routes with oc ids and #effort', () => {
    const d = gitRepo(), b = newBrief();
    const r = run(['run', 'builder-iq', b, '--write', '--dir', d, '--dry-run'], { env: { WORKER_ROUTING: ROUTING_V1 } });
    assert.equal(r.status, 0, r.all);
    const lines = r.stdout.split('\n');
    assert.ok(hasWouldTry(lines, '[worker] would try deepseek-flash route cloudflare id=cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017#max effort=max mode=oc WRITE'), r.stdout);
    assert.ok(hasWouldTry(lines, '[worker] would try deepseek-flash route openrouter id=openrouter/deepseek/deepseek-v4.1-flash-1017#max effort=max mode=oc WRITE'), r.stdout);
    assert.ok(hasWouldTry(lines, '[worker] would try gemini-flash route agy id=gemini-3.8-flash effort=high mode=agy WRITE'), r.stdout);
    assert.ok(lines.includes(`[worker] NEXT: spawn Claude agent "builder" (model haiku, effort xhigh) with brief ${b}`), r.stdout);
  });
});
describe('worker.mjs route walking', () => {
  it('prints skip lines for missing keys and missing programs', () => {
    const b = newBrief();
    let r = run(['run', 'trivial', b], { env: { AGY_BIN: missing('agy'), OPENCODE_BIN: missing('opencode') } });
    assert.equal(r.status, 3, r.all);
    assert.match(r.stderr, /\[worker\] skip nvidia: .*NVIDIA_API_KEY/);
    assert.match(r.stderr, /\[worker\] skip openrouter: .*OPENROUTER_API_KEY/);
    assert.match(r.stderr, /\[worker\] skip agy: .*not installed/i);
    assert.ok(!/\[worker\] route .* failed:/.test(r.stderr));
    r = run(['run', 'builder-iq', b, '--write', '--dir', gitRepo()], { env: { CLOUDFLARE_API_TOKEN: 'cf-token', AGY_BIN: missing('agy'), OPENCODE_BIN: missing('opencode') } });
    assert.equal(r.status, 3, r.all);
    assert.match(r.stderr, /\[worker\] skip cloudflare: .*CLOUDFLARE_ACCOUNT_ID/);
  });
  it('runs a model over http and saves the full answer', () => {
    const b = newBrief(), answer = 'PONG from fake http';
    const r = run(['run', 'trivial', b], { env: { NVIDIA_API_KEY: 'nv-test-key', WORKER_FAKE_HTTP: newFake(answer) } });
    assert.equal(r.status, 0, r.all);
    assert.ok(r.stdout.includes(answer));
    const out = `${b}.trivial.out.txt`;
    assert.equal(read(out).trim(), answer);
    const last = lastLine(r.stdout);
    assert.match(last, /^\[worker\] kind=trivial picked=nemotron-free via=nvidia id=nvidia\/nemotron-3-ultra-550b-a55b tried=0 exit=0 secs=\d+ out=/);
    assert.ok(slash(last).includes(`out=${slash(out)}`));
  });
  it('fails error-looking answers in the first 300 chars but accepts them later', () => {
    const b = newBrief(), key = 'nv-test-key';
    for (const answer of ['Error: boom', 'Model unavailable', 'insufficient credits', 'rate limit exceeded']) {
      const r = run(['ask', 'nemotron-free', b, '--router', 'nvidia'], { env: { NVIDIA_API_KEY: key, WORKER_FAKE_HTTP: newFake(answer) } });
      assert.equal(r.status, 1, `${answer}\n${r.all}`);
      assert.match(r.stderr, /\[worker\] route nvidia .* failed:/);
    }
    const long = `${'A'.repeat(320)}\nModel unavailable; insufficient credits; rate limit`;
    const r = run(['ask', 'nemotron-free', b, '--router', 'nvidia'], { env: { NVIDIA_API_KEY: key, WORKER_FAKE_HTTP: newFake(long) } });
    assert.equal(r.status, 0, r.all);
    assert.match(lastLine(r.stdout), /^\[worker\] kind=ask picked=nemotron-free via=nvidia id=nvidia\/nemotron-3-ultra-550b-a55b tried=0 exit=0/);
    assert.equal(read(`${b}.nemotron-free.out.txt`).trim(), long);
  });
  it('fails an empty answer with "empty output"', () => {
    const b = newBrief();
    const r = run(['ask', 'nemotron-free', b, '--router', 'nvidia'], { env: { NVIDIA_API_KEY: 'nv', WORKER_FAKE_HTTP: newFake('') } });
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /empty output/i);
  });
  it('retries an HTTP 500 exactly once and then fails', () => {
    const b = newBrief();
    const r = run(['ask', 'nemotron-free', b, '--router', 'nvidia'], { env: { NVIDIA_API_KEY: 'nv', WORKER_FAKE_HTTP: newFake('HTTP 500\nserver error\n'), WORKER_RETRY_DELAY_MS: '1' } });
    assert.equal(r.status, 1, r.all);
    const retryLines = r.stderr.split('\n').filter((l) => /retry/i.test(l) && !/failed:/i.test(l));
    assert.equal(retryLines.length, 1, r.stderr);
    assert.match(r.stderr, /\[worker\] route nvidia .* failed:/);
  });
  it('does not retry an HTTP 401', () => {
    const b = newBrief();
    const r = run(['ask', 'nemotron-free', b, '--router', 'nvidia'], { env: { NVIDIA_API_KEY: 'nv', WORKER_FAKE_HTTP: newFake('HTTP 401\nunauthorized\n'), WORKER_RETRY_DELAY_MS: '1' } });
    assert.equal(r.status, 1, r.all);
    assert.ok(!/retry/i.test(r.stderr), r.stderr);
  });
  it('never prints the API key, even from an echoed error body', () => {
    const b = newBrief(), key = 'sk-test-secret-987654321';
    const r = run(['ask', 'nemotron-free', b, '--router', 'nvidia'], { env: { NVIDIA_API_KEY: key, WORKER_FAKE_HTTP: newFake(`HTTP 401\nbad key ${key} rejected\n`) } });
    assert.equal(r.status, 1, r.all);
    assert.ok(!r.stdout.includes(key), r.stdout);
    assert.ok(!r.stderr.includes(key), r.stderr);
  });
  it('falls through from a failing nvidia route to openrouter', () => {
    const b = newBrief(), answer = 'PONG from openrouter';
    const r = run(['run', 'trivial', b], { env: { NVIDIA_API_KEY: 'nv', OPENROUTER_API_KEY: 'or', WORKER_FAKE_HTTP: newFake(answer), WORKER_FAIL_ROUTERS: 'nvidia' } });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stderr, /\[worker\] route nvidia .* failed: forced failure \(test hook\)/);
    assert.match(lastLine(r.stdout), /^\[worker\] kind=trivial picked=nemotron-free via=openrouter id=nvidia\/nemotron-3-ultra-550b-a55b:free tried=1 exit=0/);
    assert.equal(read(`${b}.trivial.out.txt`).trim(), answer);
  });
  it('prints a NEXT line and exits 3 when only a Claude pick is left', () => {
    const b = newBrief();
    const r = run(['run', 'trivial', b], { env: { AGY_BIN: missing('agy'), OPENCODE_BIN: missing('opencode') } });
    assert.equal(r.status, 3, r.all);
    const a = V2.claude_agents['scout-lite'];
    assert.ok(r.stdout.includes(`[worker] NEXT: spawn Claude agent "scout-lite" (model ${a.model}, effort ${a.effort}) with brief ${b}`), r.stdout);
    assert.ok(!/\[worker\] route .* failed:/.test(r.stderr));
  });
  it('skips Claude picks with --no-claude and exits 1 when nothing runs', () => {
    const b = newBrief();
    const r = run(['run', 'trivial', b, '--no-claude'], { env: { AGY_BIN: missing('agy'), OPENCODE_BIN: missing('opencode') } });
    assert.equal(r.status, 1, r.all);
    assert.ok(!r.stdout.includes('NEXT'), r.stdout);
    assert.match(r.stderr, /no-claude|every pick failed/i);
    assert.match(r.stderr, /NVIDIA_API_KEY|not installed/i);
  });
});
describe('worker.mjs files and http writes', () => {
  it('packs files with globs into the http prompt and enforces the 80,000 cap', () => {
    const d = newDir('files-'), b = newBrief('BRIEF-MARKER-123'), dbg = path.join(d, 'debug.json'), f = newFake('ok'), key = 'nv-test-key-files';
    write(path.join(d, 'a.txt'), 'ALPHA');
    write(path.join(d, 'sub', 'b.js'), 'BETA');
    write(path.join(d, 'sub', 'c.md'), 'SKIP-ME');
    const r = run(['run', 'trivial', b, '--dir', d, '--files', 'a.txt,sub/*.js'], { env: { NVIDIA_API_KEY: key, WORKER_FAKE_HTTP: f, WORKER_DEBUG_PROMPT: dbg } });
    assert.equal(r.status, 0, r.all);
    const body = JSON.parse(read(dbg));
    assert.equal(body.model, 'nvidia/nemotron-3-ultra-550b-a55b');
    const text = body.messages.map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('\n') : JSON.stringify(m.content))).join('\n');
    assert.ok(text.includes('BRIEF-MARKER-123'));
    assert.ok(text.includes('=== FILE: a.txt ===\nALPHA\n'), text);
    assert.match(text, /=== FILE: sub[\\/]b\.js ===\nBETA\n/);
    assert.ok(!text.includes('SKIP-ME'), text);
    assert.ok(!read(dbg).includes(key));
    write(path.join(d, 'big.txt'), 'x'.repeat(80100));
    const dbg2 = path.join(d, 'debug2.json');
    const r2 = run(['run', 'trivial', b, '--dir', d, '--files', 'big.txt'], { env: { NVIDIA_API_KEY: key, WORKER_FAKE_HTTP: f, WORKER_DEBUG_PROMPT: dbg2 } });
    assert.equal(r2.status, 2, r2.all);
    assert.ok(r2.all.includes('80,000'), r2.all);
    assert.ok(!fs.existsSync(dbg2), 'sent a request over the 80,000 cap');
  });
  it('tells the model when --dir has no --files', () => {
    const d = newDir('files-'), b = newBrief('BRIEF-MARKER-456'), dbg = path.join(d, 'debug.json');
    write(path.join(d, 'hidden.txt'), 'SHOULD-NOT-APPEAR');
    const r = run(['run', 'trivial', b, '--dir', d], { env: { NVIDIA_API_KEY: 'nv-key', WORKER_FAKE_HTTP: newFake('ok'), WORKER_DEBUG_PROMPT: dbg } });
    assert.equal(r.status, 0, r.all);
    const text = JSON.parse(read(dbg)).messages.map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('\n') : JSON.stringify(m.content))).join('\n');
    assert.ok(text.includes('No files were attached to this prompt; you cannot read the project folder.'), text);
    assert.ok(text.includes('BRIEF-MARKER-456'));
    assert.ok(!text.includes('SHOULD-NOT-APPEAR'));
  });
  it('writes full-file blocks from an http answer under --dir', () => {
    const repo = gitRepo(), b = newBrief('Write two files.');
    const answer = '=== FILE: src/new.txt ===\nHELLO\n=== END FILE ===\n=== FILE: top.txt ===\nTOP\n=== END FILE ===\n';
    const r = run(['run', 'builder-iq', b, '--write', '--dir', repo], { env: { NVIDIA_API_KEY: 'nv-key', WORKER_FAKE_HTTP: newFake(answer) } });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /\[worker\] wrote src[\\/]new\.txt/);
    assert.match(r.stdout, /\[worker\] wrote top\.txt/);
    assert.equal(read(path.join(repo, 'src', 'new.txt')).trim(), 'HELLO');
    assert.equal(read(path.join(repo, 'top.txt')).trim(), 'TOP');
    assert.match(lastLine(r.stdout), /^\[worker\] kind=builder-iq picked=deepseek-flash via=nvidia id=deepseek-ai\/deepseek-v4\.1-flash tried=0 exit=0/);
  });
  it('rejects traversal and absolute paths without writing anything', () => {
    const repo = gitRepo(), b = newBrief('Write.');
    for (const bad of ['../escape-1.txt', '/abs-escape-2.txt', 'C:/abs-escape-3.txt']) {
      const answer = `=== FILE: ok.txt ===\nOK\n=== END FILE ===\n=== FILE: ${bad} ===\nEVIL\n=== END FILE ===\n`;
      const r = run(['run', 'builder-iq', b, '--write', '--dir', repo, '--no-claude'], { env: { NVIDIA_API_KEY: 'nv-key', WORKER_FAKE_HTTP: newFake(answer), AGY_BIN: missing('agy') } });
      assert.equal(r.status, 1, `${bad}\n${r.all}`);
      assert.match(r.stderr, /\[worker\] route nvidia .* failed:/);
      assert.ok(!fs.existsSync(path.join(repo, 'ok.txt')), `wrote ok.txt for ${bad}`);
      assert.equal(gitStatus(repo).trim(), '', `repo changed for ${bad}`);
    }
  });
  it('refuses a non-git write dir, even one named x-copy, and writes in a git repo', () => {
    const plain = newDir('plain-'), b = newBrief('Write one file.');
    const answer = '=== FILE: made.txt ===\nMADE\n=== END FILE ===\n', f = newFake(answer), dbg = path.join(plain, 'debug.json');
    let r = run(['run', 'builder-iq', b, '--write', '--dir', plain], { env: { NVIDIA_API_KEY: 'nv-key', WORKER_FAKE_HTTP: f, WORKER_DEBUG_PROMPT: dbg } });
    assert.equal(r.status, 2, r.all);
    assert.match(r.all, /git/i);
    assert.ok(!fs.existsSync(dbg), 'sent a request before the git check');
    const copy = newDir('x-copy-'), copyDbg = path.join(copy, 'debug.json');
    r = run(['run', 'builder-iq', b, '--write', '--dir', copy], { env: { NVIDIA_API_KEY: 'nv-key', WORKER_FAKE_HTTP: f, WORKER_DEBUG_PROMPT: copyDbg } });
    assert.equal(r.status, 2, r.all);
    assert.match(r.all, /git/i);
    assert.ok(!fs.existsSync(copyDbg), 'sent a request before the git check');
    const repo = gitRepo();
    r = run(['run', 'builder-iq', b, '--write', '--dir', repo], { env: { NVIDIA_API_KEY: 'nv-key', WORKER_FAKE_HTTP: f } });
    assert.equal(r.status, 0, r.all);
    assert.equal(read(path.join(repo, 'made.txt')).trim(), 'MADE');
    assert.match(r.stdout, /\[worker\] wrote made\.txt/);
  });
  it('fails a write route when the fake CLI changes no files', () => {
    const repo = gitRepo(), b = newBrief('Change something.');
    const r = run(['run', 'builder-iq', b, '--write', '--dir', repo, '--no-claude'], { env: {
      NVIDIA_API_KEY: 'nv', OPENROUTER_API_KEY: 'or', CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct', WORKER_FAIL_ROUTERS: 'nvidia,cloudflare,openrouter',
      WORKER_FAKE_CLI: newFake('I changed nothing.\n'), AGY_BIN: process.execPath, WORKER_SLOT_DIR: newDir('slots-'), WORKER_AGY_SLOTS: '1', WORKER_SLOT_WAIT: '5',
    } });
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /\[worker\] route agy .* failed: .*no files changed/i);
    assert.equal(gitStatus(repo).trim(), '');
  });
});
describe('worker.mjs pair, ask and v1', () => {
  it('pair mode runs model picks with and without --no-claude', () => {
    const b = newBrief('Pair brief.');
    const env = { NVIDIA_API_KEY: 'nv', OPENROUTER_API_KEY: 'or', CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct', WORKER_FAKE_HTTP: newFake('PAIR ANSWER') };
    let r = run(['run', 'test-writer', b, '--no-claude'], { env });
    assert.equal(r.status, 0, r.all);
    assert.ok(!r.stdout.includes('NEXT'), r.stdout);
    assert.equal(read(`${b}.deepseek-flash.out.txt`).trim(), 'PAIR ANSWER');
    assert.match(lastLine(r.stdout), /^\[worker\] kind=test-writer pair tried=0 exit=0 secs=\d+$/);
    r = run(['run', 'test-writer', b], { env });
    assert.equal(r.status, 0, r.all);
    const a = V2.claude_agents['test-writer'];
    assert.ok(r.stdout.includes(`[worker] NEXT: spawn Claude agent "test-writer" (model ${a.model}, effort ${a.effort}) with brief ${b}`), r.stdout);
    assert.match(lastLine(r.stdout), /^\[worker\] kind=test-writer pair tried=0 exit=0 secs=\d+$/);
    r = run(['run', 'test-writer', b, '--no-claude'], { env: { ...env, WORKER_FAIL_ROUTERS: 'nvidia,cloudflare,openrouter' } });
    assert.equal(r.status, 1, r.all);
    assert.match(r.all, /kind=test-writer pair tried=3 exit=1/);
  });
  it('ask --router uses only the named router', () => {
    const b = newBrief('Ask brief.'), dbg = path.join(T, 'ask-debug.json');
    const r = run(['ask', 'deepseek-flash', b, '--router', 'cloudflare'], { env: {
      NVIDIA_API_KEY: 'nv', OPENROUTER_API_KEY: 'or', CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct', WORKER_FAKE_HTTP: newFake('ROUTER ANSWER'), WORKER_DEBUG_PROMPT: dbg, WORKER_FAIL_ROUTERS: 'nvidia',
    } });
    assert.equal(r.status, 0, r.all);
    assert.equal(JSON.parse(read(dbg)).model, '@cf/deepseek-ai/deepseek-v4.1-flash-1017');
    assert.match(lastLine(r.stdout), /^\[worker\] kind=ask picked=deepseek-flash via=cloudflare id=@cf\/deepseek-ai\/deepseek-v4\.1-flash-1017 tried=0 exit=0/);
    assert.equal(read(`${b}.deepseek-flash.out.txt`).trim(), 'ROUTER ANSWER');
  });
  it('runs a v1 opencode route through the fake CLI', () => {
    const b = newBrief('V1 brief.');
    const r = run(['run', 'trivial', b, '--no-claude'], { env: {
      WORKER_ROUTING: ROUTING_V1, WORKER_FAKE_CLI: newFake('V1 ANSWER'), OPENCODE_BIN: process.execPath, AGY_BIN: process.execPath, WORKER_SLOT_DIR: newDir('slots-'), WORKER_OPENCODE_SLOTS: '1', WORKER_SLOT_WAIT: '5',
    } });
    assert.equal(r.status, 0, r.all);
    assert.ok(r.stdout.includes('V1 ANSWER'));
    assert.match(lastLine(r.stdout), /^\[worker\] kind=trivial picked=nemotron-free via=openrouter id=openrouter\/nvidia\/nemotron-3-ultra-550b-a55b:free tried=0 exit=0 secs=\d+ out=/);
  });
});
describe('worker.mjs timeouts, slots and probes', () => {
  it('rejects non-positive and non-numeric --timeout values', () => {
    const b = newBrief();
    for (const value of ['0', '-5', 'abc']) {
      const r = run(['run', 'trivial', b, '--timeout', value]);
      assert.equal(r.status, 2, `${value}\n${r.all}`);
      assert.match(r.stderr, /--timeout/);
    }
  });
  it('times out a slow fake CLI quickly', () => {
    const b = newBrief('Slow brief.'), started = Date.now();
    const r = run(['ask', 'gemini-flash', b, '--router', 'agy', '--timeout', '0.5'], { env: {
      WORKER_FAKE_CLI: newFake('never'), WORKER_FAKE_CLI_SLEEP_MS: '5000', AGY_BIN: process.execPath, WORKER_SLOT_DIR: newDir('slots-'), WORKER_AGY_SLOTS: '1', WORKER_SLOT_WAIT: '5', WORKER_RETRY_DELAY_MS: '1',
    } });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /timed out/i);
    assert.ok(elapsed < 4000, `took ${elapsed}ms`);
  });
  it('exits 75 for a live slot and reclaims dead or expired slots', () => {
    const b = newBrief('Slot brief.'), f = newFake('SLOT ANSWER');
    const ask = (slots) => run(['ask', 'gemini-flash', b, '--router', 'agy'], { env: { AGY_BIN: process.execPath, WORKER_FAKE_CLI: f, WORKER_SLOT_DIR: slots, WORKER_AGY_SLOTS: '1', WORKER_SLOT_WAIT: '2' } });
    let slots = newDir('slots-'), slot = path.join(slots, 'agy-0');
    fs.mkdirSync(slot);
    write(path.join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, deadline: Date.now() + 600000 }));
    let r = ask(slots);
    assert.equal(r.status, 75, r.all);
    assert.match(r.stderr, /\[worker\] no free agy slot after waiting 2s/);
    slots = newDir('slots-'); slot = path.join(slots, 'agy-0');
    const deadPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
    fs.mkdirSync(slot);
    write(path.join(slot, 'owner.json'), JSON.stringify({ pid: deadPid, deadline: Date.now() + 600000 }));
    r = ask(slots);
    assert.equal(r.status, 0, r.all);
    assert.match(lastLine(r.stdout), /^\[worker\] kind=ask picked=gemini-flash via=agy id=gemini-3\.8-flash tried=0 exit=0/);
    assert.ok(!fs.existsSync(slot), 'slot folder left behind');
    slots = newDir('slots-'); slot = path.join(slots, 'agy-0');
    fs.mkdirSync(slot);
    write(path.join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, deadline: Date.now() - 1000 }));
    r = ask(slots);
    assert.equal(r.status, 0, r.all);
    assert.ok(!fs.existsSync(slot), 'slot folder left behind');
  });
  it('runs a raw agy probe through the fake CLI', () => {
    const b = newBrief('Raw brief.');
    const r = run(['agy', 'gemini-3.8-flash', b, '--effort', 'high'], { env: {
      AGY_BIN: process.execPath, WORKER_FAKE_CLI: newFake('AGY-FAKE-ANSWER'), WORKER_SLOT_DIR: newDir('slots-'), WORKER_AGY_SLOTS: '1', WORKER_SLOT_WAIT: '5',
    } });
    assert.equal(r.status, 0, r.all);
    assert.ok(r.stdout.includes('AGY-FAKE-ANSWER'));
    const last = lastLine(r.stdout);
    assert.match(last, /^\[worker\] mode=agy model=gemini-3\.8-flash .*exit=0 secs=\d+ out=/);
    const out = last.match(/out=(.+)$/)?.[1];
    assert.ok(out && fs.existsSync(out), last);
  });
});
describe('worker.mjs lock, verify, tail and usage', () => {
  it('locks files and verifies OK, CHANGED and MISSING', () => {
    const d = newDir('lock-'), a = write(path.join(d, 'a.txt'), 'alpha'), b = write(path.join(d, 'b.txt'), 'beta'), lock = path.join(d, 'lock.json');
    let r = run(['lock', a, b, '--out', lock]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /\[worker\] locked 2 files -> /);
    assert.ok(slash(r.stdout).includes(slash(lock)));
    const data = JSON.parse(read(lock));
    assert.ok(data.created);
    for (const f of [a, b]) {
      const entry = Object.entries(data.files).find(([k]) => norm(k) === norm(f));
      assert.ok(entry, `missing ${f}`);
      assert.equal(entry[1], crypto.createHash('sha256').update(read(f)).digest('hex'));
    }
    r = run(['verify', lock]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /OK 2 files unchanged/);
    write(a, 'alpha changed');
    r = run(['verify', lock]);
    assert.equal(r.status, 1, r.all);
    assert.ok(slash(r.stdout).includes('CHANGED'));
    assert.ok(slash(r.stdout).includes(slash(a)));
    write(a, 'alpha');
    fs.unlinkSync(b);
    r = run(['verify', lock]);
    assert.equal(r.status, 1, r.all);
    assert.ok(slash(r.stdout).includes('MISSING'));
    assert.ok(slash(r.stdout).includes(slash(b)));
    r = run(['verify', path.join(d, 'no-lock.json')]);
    assert.equal(r.status, 2, r.all);
  });
  it('shows only the last --tail characters and says how many', () => {
    const b = newBrief(), answer = '0123456789'.repeat(20);
    const r = run(['run', 'trivial', b, '--tail', '50'], { env: { NVIDIA_API_KEY: 'nv', WORKER_FAKE_HTTP: newFake(answer) } });
    assert.equal(r.status, 0, r.all);
    assert.equal(r.stdout.split('\n')[0], '[worker] showing last 50 of 200 chars');
    assert.ok(r.stdout.includes(answer.slice(-50)));
    assert.equal(read(`${b}.trivial.out.txt`).trim(), answer);
    assert.match(lastLine(r.stdout), /^\[worker\] kind=trivial picked=nemotron-free via=nvidia id=nvidia\/nemotron-3-ultra-550b-a55b tried=0 exit=0/);
  });
  it('exits 2 with a [worker] message on usage errors', () => {
    const d = newDir('usage-'), b = newBrief();
    const cases = [
      ['unknown command', ['frobnicate']], ['missing run args', ['run', 'trivial']], ['unknown kind', ['run', 'no-such-kind', b]],
      ['missing brief', ['run', 'trivial', path.join(d, 'no-brief.txt')]], ['write kind without --write', ['run', 'builder-iq', b]],
      ['write kind without --dir', ['run', 'builder-iq', b, '--write']], ['--write on read-only kind', ['run', 'trivial', b, '--write', '--dir', d]],
      ['unknown route kind', ['route', 'no-such-kind']], ['lock without files', ['lock']], ['verify missing lock', ['verify', path.join(d, 'no-lock.json')]],
    ];
    for (const [name, args] of cases) {
      const r = run(args);
      assert.equal(r.status, 2, `${name}\n${r.all}`);
      assert.match(r.stderr, /\[worker\]/, name);
    }
  });
});
