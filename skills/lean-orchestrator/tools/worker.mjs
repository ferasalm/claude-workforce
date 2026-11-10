#!/usr/bin/env node
// worker.mjs: hand one brief to a non-Claude worker and get a capped report back.
// It exists so a lead (any model, any harness) spends no thought on paths, flags or quoting.
//
//   node worker.mjs text <alias>          <brief-file> [--max-tokens N]
//       Text in, text out. No tools, no file access: the brief must contain everything.
//       Aliases come from ~/.agents/model-delegate-mcp/models.json (cf-deepseek-flash, cf-glm-flash, cf-glm).
//   node worker.mjs oc   <provider/model> <brief-file> [--dir D] [--write]
//       OpenCode agent. Read-only (plan agent) unless --write. Can read files and run commands in D.
//   node worker.mjs agy  <model>          <brief-file> [--dir D] [--write] [--effort low|medium|high]
//       Antigravity agent (Gemini). Read-only (plan mode) unless --write. About 20 s start-up.
//   node worker.mjs list
//       Show text aliases and whether their keys are set.
//
// Routing by data file (../routing.json, the only place that names models):
//   node worker.mjs route [kind]
//       No kind: one line per kind (kind, tier, picks in order). With a kind: also use_when, not_for,
//       mode, lock, review_with, after. A model pick shows as model(effort) via router>router; a Claude
//       pick as claude:<agent> (<model> <effort>). Read-only, no network.
//   node worker.mjs run <kind> <brief-file> [--dir D] [--write] [--timeout S] [--dry-run]
//       Walk the kind's picks in order; for a model pick walk its routes in order. cloudflare/openrouter
//       run the OpenCode agent as mode oc (model id = route.oc + '#effort'; pick.effort wins over the
//       model's effort). agy runs as mode agy (--effort = pick.effort, default low). An attempt succeeds
//       only if exit code is 0 AND the ANSI-stripped output is non-empty; else
//       "[worker] route <router> <id> failed: <reason>" on stderr and the next route/pick is tried.
//       A Claude pick cannot run here: prints "[worker] NEXT: spawn Claude agent ..." and exits 3.
//       Kinds with write:true need --write and --dir; --write on any other kind is refused.
//       mode "pair" kinds run EVERY non-claude pick, save <brief>.<model>.out.txt each, print each Claude
//       pick as a NEXT line, exit 0 only if all non-claude picks succeeded (else 1).
//       Otherwise output goes to <brief>.<kind>.out.txt and the last line is
//       "[worker] kind=K picked=M via=R id=I tried=<failed routes> exit=0 secs=N out=F".
//       Attempts run strictly one at a time (parallel OpenCode processes crash with VirtualAlloc here).
//       --dry-run prints each attempt it would make (id, effort, mode) and runs nothing.
//       Test hook: env WORKER_FAIL_ROUTERS=cloudflare,openrouter makes attempts on those routers fail
//       at once with reason "forced failure (test hook)", running nothing.
//   node worker.mjs lock <file...> [--out F]
//       Write a JSON lock (default ./.test-lock.json) with created time and sha256 of each file (absolute paths).
//   node worker.mjs verify [lockfile]
//       Recompute the hashes. Prints "OK n files unchanged" (exit 0) or each CHANGED/MISSING file (exit 1).
//
// Common: --timeout SEC (default 600), --tail CHARS printed to stdout (default 6000).
// The full output is saved next to the brief as <brief-file>.out.txt. Exit code 0 means the worker ran;
// it does not mean the answer is right. Verify the fact your next step depends on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const HOME = os.homedir();
const DELEGATE = path.join(HOME, '.agents', 'model-delegate-mcp', 'models.json');
const ROUTING = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routing.json');
const OC_BIN = process.env.OPENCODE_BIN || path.join(HOME, '.local', 'opt', 'opencode-2.2.2', 'opencode.exe'); // not the npm one on PATH
const AGY_BIN = process.env.AGY_BIN || path.join(HOME, 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
const FAIL_ROUTERS = (process.env.WORKER_FAIL_ROUTERS || '').split(',').map((s) => s.trim()).filter(Boolean); // test hook

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf('--' + name); if (i < 0) return dflt; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = (name) => { const i = argv.indexOf('--' + name); if (i < 0) return false; argv.splice(i, 1); return true; };
const timeoutSec = Number(flag('timeout', 600));
const tail = Number(flag('tail', 6000));
const dirArg = flag('dir', undefined);
const dir = dirArg || process.cwd();
const effort = flag('effort', 'low');
const maxTokens = Number(flag('max-tokens', 4096));
const outArg = flag('out', undefined);
const write = bool('write');
const dryRun = bool('dry-run');
const [mode, model, briefFile] = argv;

const die = (msg) => { console.error('[worker] ' + msg); process.exit(2); };
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function getEnv(name) { // process env, else the Windows user environment (same rule as model-delegate-mcp)
  if (process.env[name]) return process.env[name];
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
      const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)\r?$/m);
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* not set */ }
  }
  return undefined;
}
const needs = (p) => [p.keyEnv, ...[...p.baseUrl.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1])];

async function text(cfg, brief) {
  const m = cfg.models[model]; if (!m) die(`unknown alias "${model}". Have: ${Object.keys(cfg.models).join(', ')}`);
  const p = cfg.providers[m.provider];
  const miss = needs(p).filter((n) => !getEnv(n)); if (miss.length) die(`provider ${m.provider} needs env ${miss.join(', ')}`);
  const base = p.baseUrl.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => getEnv(n)).replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getEnv(p.keyEnv), ...(p.headers || {}) },
    body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: brief }], max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });
  const raw = await r.text();
  if (!r.ok) return { code: 1, out: `HTTP ${r.status} from ${m.provider}: ${raw.slice(0, 400).replace(getEnv(p.keyEnv), '<redacted>')}` };
  const ch = (JSON.parse(raw).choices || [])[0] || {};
  const out = (ch.message && ch.message.content) || '';
  return out ? { code: 0, out } : { code: 1, out: `no text returned (finish_reason=${ch.finish_reason}); a reasoning model may need a larger --max-tokens` };
}

function run(bin, args) {
  return new Promise((resolve) => {
    if (!fs.existsSync(bin)) return resolve({ code: 127, out: `binary not found: ${bin}` });
    // OpenCode takes its project folder from env PWD before cwd, so set both (else --dir is ignored and writes land in the caller's folder).
    const child = spawn(bin, args, { cwd: dir, env: { ...process.env, PWD: dir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let timedOut = false;
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSec * 1000);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 126, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: timedOut ? 124 : code, out: out + (timedOut ? `\n[worker] timed out after ${timeoutSec}s` : '') }); });
  });
}
// Cross-process slots: several OpenCode processes at once crash this machine (VirtualAlloc), and parallel
// sub-orchestrators each call this script. A slot is an atomic mkdir in the temp folder holding the owner's pid;
// a slot whose owner died, or that is older than the timeout plus 5 minutes, is reclaimed.
const SLOTS = { oc: Number(process.env.WORKER_OC_SLOTS || 1), agy: Number(process.env.WORKER_AGY_SLOTS || 2) };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function acquire(name) {
  const n = Math.max(1, SLOTS[name] || 1); const base = path.join(os.tmpdir(), 'worker-mjs-slots');
  fs.mkdirSync(base, { recursive: true });
  const t0 = Date.now(); let told = false;
  for (;;) {
    for (let i = 0; i < n; i++) {
      const d = path.join(base, `${name}-${i}`);
      try { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'pid'), String(process.pid)); return () => fs.rmSync(d, { recursive: true, force: true }); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          let pid = 0; try { pid = Number(fs.readFileSync(path.join(d, 'pid'), 'utf8')); } catch { /* being created */ }
          const age = (Date.now() - fs.statSync(d).mtimeMs) / 1000;
          if ((pid && !alive(pid)) || (!pid && age > 30) || age > timeoutSec + 300) fs.rmSync(d, { recursive: true, force: true });
        } catch { /* released meanwhile */ }
      }
    }
    if (!told) { console.error(`[worker] waiting for a free ${name} slot (${n} at a time; env WORKER_${name.toUpperCase()}_SLOTS)`); told = true; }
    if ((Date.now() - t0) / 1000 > timeoutSec * 4) return null;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
async function slotRun(name, bin, args) {
  const release = await acquire(name);
  if (!release) return { code: 75, out: `no free ${name} slot after waiting ${timeoutSec * 4}s` };
  try { return await run(bin, args); } finally { release(); }
}
const ocRun = (id, brief, wr) => slotRun('oc', OC_BIN, ['run', '-m', id, ...(wr ? [] : ['--agent', 'plan']), brief]);
const agyRun = (m, eff, brief, wr) => slotRun('agy', AGY_BIN, ['-p', brief, '--model', m, '--effort', eff, '--mode', wr ? 'accept-edits' : 'plan']);

function readBrief(file) {
  if (!fs.existsSync(file)) die('brief file not found: ' + file);
  const b = fs.readFileSync(file, 'utf8');
  if (b.length > 24000) die('brief is over 24,000 characters; point the worker at files instead of pasting them');
  return b;
}
const show = (clean) => console.log(clean.length > tail ? `[worker] showing last ${tail} of ${clean.length} chars\n` + clean.slice(-tail) : clean);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function loadRouting() {
  try { return JSON.parse(fs.readFileSync(ROUTING, 'utf8')); } catch (e) { die(`cannot read ${ROUTING}: ${e.message}`); }
}
function pickStr(R, p) {
  if (p.claude) { const a = R.claude_agents[p.claude] || {}; return `claude:${p.claude} (${a.model || '?'} ${a.effort || '?'})`; }
  const m = R.models[p.model] || { routes: [] };
  return `${p.model}(${p.effort || m.effort || 'default'}) via ${m.routes.map((r) => r.router).join('>')}`;
}
const nextLine = (R, name, file) => { const a = R.claude_agents[name] || {}; return `[worker] NEXT: spawn Claude agent "${name}" (model ${a.model || '?'}, effort ${a.effort || '?'}) with brief ${file}`; };

if (mode === 'list') {
  const cfg = JSON.parse(fs.readFileSync(DELEGATE, 'utf8'));
  for (const [a, m] of Object.entries(cfg.models)) console.log(`${a}\t${needs(cfg.providers[m.provider]).every(getEnv) ? 'key ok' : 'NO KEY'}\t${m.model}\t${m.note}`);
  process.exit(0);
}

if (mode === 'route') {
  const R = loadRouting();
  if (!model) {
    for (const [k, v] of Object.entries(R.kinds)) console.log(`${k}\t${v.tier}\t${v.picks.map((p) => pickStr(R, p)).join(' | ')}`);
  } else {
    const v = R.kinds[model]; if (!v) die(`unknown kind "${model}". Have: ${Object.keys(R.kinds).join(', ')}`);
    console.log(`${model}\t${v.tier}\t${v.picks.map((p) => pickStr(R, p)).join(' | ')}`);
    for (const f of ['use_when', 'not_for', 'mode', 'lock', 'review_with', 'after']) if (v[f] !== undefined) console.log(`  ${f}: ${v[f]}`);
    if (v.write) console.log('  write: true (needs --write and --dir)');
  }
  process.exit(0);
}

if (mode === 'lock') {
  const files = argv.slice(1); if (!files.length) die('usage: worker.mjs lock <file...> [--out F]');
  const lock = { created: new Date().toISOString(), files: {} };
  for (const f of files) { const a = path.resolve(f); if (!fs.existsSync(a)) die('file not found: ' + a); lock.files[a] = sha(a); }
  const out = path.resolve(outArg || '.test-lock.json');
  fs.writeFileSync(out, JSON.stringify(lock, null, 2) + '\n');
  console.log(`[worker] locked ${files.length} files -> ${out}`);
  process.exit(0);
}
if (mode === 'verify') {
  const lf = path.resolve(model || '.test-lock.json'); if (!fs.existsSync(lf)) die('lock file not found: ' + lf);
  const lock = JSON.parse(fs.readFileSync(lf, 'utf8')); const bad = [];
  for (const [f, h] of Object.entries(lock.files)) { if (!fs.existsSync(f)) bad.push('MISSING ' + f); else if (sha(f) !== h) bad.push('CHANGED ' + f); }
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
  console.log(`OK ${Object.keys(lock.files).length} files unchanged`);
  process.exit(0);
}

if (mode === 'run') {
  const R = loadRouting(); const K = model; const kind = R.kinds[K];
  if (!K || !briefFile) die('usage: worker.mjs run <kind> <brief-file> [--dir D] [--write] [--timeout S] [--dry-run]');
  if (!kind) die(`unknown kind "${K}". Have: ${Object.keys(R.kinds).join(', ')}`);
  if (kind.write === true && !write) die(`kind ${K} writes files: pass --write (and --dir)`);
  if (kind.write !== true && write) die(`kind ${K} is read-only: do not pass --write`);
  if (kind.write === true && !dirArg) die(`kind ${K} writes files: pass --dir <directory>`);
  if (dirArg && !fs.existsSync(dir)) die('directory not found: ' + dir);
  const brief = readBrief(briefFile);
  const pair = kind.mode === 'pair';
  const started = Date.now();
  let failedRoutes = 0;

  // Try one model pick: its routes in order. Returns { ok, router, id, clean } or { ok: false }.
  async function runPick(p) {
    const m = R.models[p.model]; if (!m) die(`kind ${K} names unknown model "${p.model}"`);
    for (const r of m.routes) {
      const agy = r.router === 'agy';
      const eff = agy ? (p.effort || 'low') : (p.effort || m.effort);
      const id = agy ? r.agy : r.oc + (eff ? '#' + eff : '');
      if (dryRun) { console.log(`[worker] would try ${p.model} route ${r.router} id=${id} effort=${eff || 'default'} mode=${agy ? 'agy' : 'oc'} ${write ? 'WRITE' : 'read-only'}`); continue; }
      let res;
      if (FAIL_ROUTERS.includes(r.router)) res = { code: 1, out: '', reason: 'forced failure (test hook)' };
      else if (agy) res = await agyRun(id, eff, brief, write);
      else if (r.router === 'cloudflare' || r.router === 'openrouter') res = await ocRun(id, brief, write);
      else res = { code: 1, out: '', reason: 'unknown router' };
      const clean = strip(res.out || '').trim();
      if (!res.reason) res.reason = res.code !== 0 ? `exit ${res.code}: ${clean.slice(-200).replace(/\s+/g, ' ')}` : (!clean ? 'empty output' : '');
      if (res.reason) { failedRoutes++; console.error(`[worker] route ${r.router} ${id} failed: ${res.reason}`); continue; }
      return { ok: true, router: r.router, id, clean };
    }
    return { ok: false };
  }
  const secs = () => Math.round((Date.now() - started) / 1000);

  if (pair) {
    let allOk = true;
    for (const p of kind.picks) {
      if (p.claude) { console.log(nextLine(R, p.claude, briefFile)); continue; }
      const r = await runPick(p);
      if (dryRun) continue;
      if (!r.ok) { allOk = false; console.error(`[worker] pick ${p.model} failed on every route`); continue; }
      const f = `${briefFile}.${p.model}.out.txt`; fs.writeFileSync(f, r.clean + '\n');
      console.log(`--- ${p.model} ---`); show(r.clean);
      console.log(`[worker] kind=${K} picked=${p.model} via=${r.router} id=${r.id} out=${f}`);
    }
    if (!dryRun) console.log(`[worker] kind=${K} pair tried=${failedRoutes} exit=${allOk ? 0 : 1} secs=${secs()}`);
    process.exit(dryRun || allOk ? 0 : 1);
  }

  for (const p of kind.picks) {
    if (p.claude) {
      console.log(nextLine(R, p.claude, briefFile));
      if (dryRun) continue; // dry-run lists every pick
      process.exit(3);
    }
    const r = await runPick(p);
    if (dryRun || !r.ok) continue;
    const f = `${briefFile}.${K}.out.txt`; fs.writeFileSync(f, r.clean + '\n');
    show(r.clean);
    console.log(`\n[worker] kind=${K} picked=${p.model} via=${r.router} id=${r.id} tried=${failedRoutes} exit=0 secs=${secs()} out=${f}`);
    process.exit(0);
  }
  if (dryRun) process.exit(0);
  console.error(`[worker] kind=${K} every pick failed tried=${failedRoutes} exit=1 secs=${secs()}`);
  process.exit(1);
}

if (!['text', 'oc', 'agy'].includes(mode) || !model || !briefFile) die('usage: worker.mjs text|oc|agy <model> <brief-file> [flags] | list | route [kind] | run <kind> <brief-file> [flags] | lock <file...> | verify [lockfile]  (see the header of this file)');
const brief = readBrief(briefFile);

const started = Date.now();
let res;
if (mode === 'text') res = await text(JSON.parse(fs.readFileSync(DELEGATE, 'utf8')), brief).catch((e) => ({ code: 1, out: 'request failed: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message) }));
if (mode === 'oc') res = await ocRun(model, brief, write);
if (mode === 'agy') res = await agyRun(model, effort, brief, write);

const clean = strip(res.out).trim();
const outFile = briefFile + '.out.txt';
fs.writeFileSync(outFile, clean + '\n');
show(clean);
console.log(`\n[worker] mode=${mode} model=${model} ${mode === 'text' ? 'no-tools' : write ? 'WRITE' : 'read-only'} exit=${res.code} secs=${Math.round((Date.now() - started) / 1000)} out=${outFile}`);
process.exit(res.code === 0 ? 0 : 1);
