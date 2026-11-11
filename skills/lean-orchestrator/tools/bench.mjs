#!/usr/bin/env node
// bench.mjs: probe every non-Claude pick of every kind with a tiny known-answer task, grade it, and
// suggest a pick order. It never edits routing.json or any other file the user owns.
//
//   node bench.mjs [--kinds a,b] [--repeat N=1] [--timeout S=300] [--include-paid] [--dry-run]
//                  [--json FILE]
//       --kinds: comma list of kind names (default: every kind in routing order).
//       --repeat: positive integer; each probe runs that many times and a pick passes only when every
//       run passes. --timeout: seconds per child run. --include-paid: also run openrouter routes whose
//       id has no ":free". --dry-run: start no child and print planned rows. --json: also write the
//       rows as a JSON array to FILE.
//
// For each kind it prints "== <kind> ==", then one row per pick and route:
//   <pick> | <effort or -> | <router or -> | <result> | <secs>s
// then "suggested <kind>: a > b > c" and, when failing picks moved, "moved to end: x, y".
// Results: pass, fail, error, timeout, skipped, planned. Exit 0 when the benchmark ran, 2 on a usage
// error. A probe runs worker.mjs ask for one route; routing lives in ../routing.json (or
// WORKER_ROUTING), the same file worker.mjs reads.
//
// Probes: trivial -> reply with a nonce; scout-light and scout-deep -> read a file with a nonce;
// every other kind -> a tiny JavaScript question. BENCH_NONCE fixes the nonce (default: 8 random hex
// digits). Briefs and the probe file live in a private temp folder removed at exit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');
const DEFAULT_ROUTING = path.join(HERE, '..', 'routing.json');
const ROUTING_FILE = path.resolve(process.env.WORKER_ROUTING || DEFAULT_ROUTING);

class UsageError extends Error {}

let tempDir = null;

function cleanup() {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best effort: a just-killed child may still hold a file on Windows.
  }
  tempDir = null;
}

function ensureTemp() {
  if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  return tempDir;
}

// ---------------------------------------------------------------- argv
function parseArgs(argv) {
  const opts = {
    kinds: null,
    repeat: 1,
    timeout: 300,
    includePaid: false,
    dryRun: false,
    json: null,
  };
  const valueAt = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--include-paid') {
      opts.includePaid = true;
      continue;
    }
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--kinds') {
      const raw = valueAt(i, 'kinds');
      i++;
      const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (!names.length) throw new UsageError('--kinds needs at least one kind name');
      opts.kinds = names;
      continue;
    }
    if (arg === '--repeat') {
      const raw = valueAt(i, 'repeat');
      i++;
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new UsageError('--repeat must be a positive integer');
      }
      opts.repeat = Number(raw);
      continue;
    }
    if (arg === '--timeout') {
      const raw = valueAt(i, 'timeout');
      i++;
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new UsageError('--timeout must be a positive number of seconds');
      }
      opts.timeout = seconds;
      continue;
    }
    if (arg === '--json') {
      opts.json = valueAt(i, 'json');
      i++;
      continue;
    }
    throw new UsageError(`unknown argument "${arg}"`);
  }
  return opts;
}

// ---------------------------------------------------------------- routing data
function loadRouting() {
  let raw;
  try {
    raw = fs.readFileSync(ROUTING_FILE, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${ROUTING_FILE}: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`cannot parse ${ROUTING_FILE}: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError(`${ROUTING_FILE} does not hold a routing object`);
  }
  return doc;
}

function selectedKinds(routing, wanted) {
  const kinds = routing.kinds && typeof routing.kinds === 'object' ? routing.kinds : {};
  const known = Object.keys(kinds);
  if (!wanted) return known;
  const selected = [];
  for (const name of wanted) {
    if (!Object.hasOwn(kinds, name)) {
      const list = known.length ? known.join(', ') : '(none)';
      throw new UsageError(`unknown kind "${name}". Known kinds: ${list}`);
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return selected;
}

function routerType(routing, name) {
  const cfg = routing.routers && typeof routing.routers === 'object' ? routing.routers[name] : null;
  if (cfg && typeof cfg === 'object') return cfg.type || 'unknown';
  if (name === 'agy') return 'agy';
  if (name === 'claude') return 'claude';
  return 'opencode';
}

function pickEffort(pick, model) {
  const own = pick ? pick.effort : undefined;
  if (own !== undefined && own !== null && own !== '') return String(own);
  const inherited = model ? model.effort : undefined;
  if (inherited !== undefined && inherited !== null && inherited !== '') return String(inherited);
  return null;
}

const unitKey = (alias, router, effort) => JSON.stringify([alias, router, effort]);

// ---------------------------------------------------------------- probes
const NONCE = process.env.BENCH_NONCE || crypto.randomBytes(4).toString('hex');
const PONG = `PONG-${NONCE}`;
const ACC = `ACC-${NONCE}`;
const probeAssets = new Map();

function probeFor(kind) {
  if (kind === 'trivial') return 'reply';
  if (kind === 'scout-light' || kind === 'scout-deep') return 'file';
  return 'code';
}

function assetsFor(kind) {
  const probe = probeFor(kind);
  const cached = probeAssets.get(probe);
  if (cached) return cached;
  const dir = ensureTemp();
  let assets;
  if (probe === 'reply') {
    const brief = path.join(dir, 'reply.txt');
    fs.writeFileSync(brief, `Reply with exactly: ${PONG}\n`, 'utf8');
    assets = { probe, brief, files: null };
  } else if (probe === 'file') {
    const brief = path.join(dir, 'file.txt');
    const data = path.join(dir, 'access.txt');
    fs.writeFileSync(brief, 'Read the attached file and reply with the access code only.\n', 'utf8');
    fs.writeFileSync(data, `The access code is ${ACC}.\n`, 'utf8');
    assets = { probe, brief, files: data };
  } else {
    const brief = path.join(dir, 'code.txt');
    fs.writeFileSync(
      brief,
      'function f(n) { return n * n + 3; }\n\nWhat does f(7) return? Reply with the number only.\n',
      'utf8',
    );
    assets = { probe, brief, files: null };
  }
  probeAssets.set(probe, assets);
  return assets;
}

// The PONG/ACC tokens are literal and case-sensitive; 52 must be a whole number, not part of a
// longer digit run or a decimal.
function passed(probe, stdout) {
  if (probe === 'reply') return stdout.includes(PONG);
  if (probe === 'file') return stdout.includes(ACC);
  return /(?<![\d.])52(?![\d.])/.test(stdout);
}

// ---------------------------------------------------------------- child processes
function descendantPids(root) {
  try {
    const r = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true });
    if (!r.stdout) return [];
    const children = new Map();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const found = [];
    const queue = (children.get(root) || []).slice();
    while (queue.length) {
      const pid = queue.shift();
      found.push(pid);
      queue.push(...(children.get(pid) || []));
    }
    return found;
  } catch {
    return [];
  }
}

function killTree(child) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
  } else {
    const descendants = descendantPids(pid);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    for (const descendant of descendants.reverse()) {
      try {
        process.kill(descendant, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function runOnce(alias, router, effort, assets, timeoutSec) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [WORKER, 'ask', alias, assets.brief, '--router', router];
    if (effort !== null) args.push('--effort', effort);
    if (assets.files) args.push('--files', assets.files);
    args.push('--timeout', String(timeoutSec));
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ result: 'error', secs: 0 });
      return;
    }
    let out = '';
    let settled = false;
    let timer = null;
    let drain = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drain) clearTimeout(drain);
      if (child.stdout) child.stdout.destroy();
      if (child.stderr) child.stderr.destroy();
      resolve({ result, secs: (Date.now() - started) / 1000 });
    };
    const grade = (code) => {
      if (code !== 0) {
        // A worker that outlives the deadline is a timeout even if its own exit wins the race.
        if (Date.now() - started >= timeoutSec * 1000) return 'timeout';
        return 'error';
      }
      return passed(assets.probe, out) ? 'pass' : 'fail';
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', () => { /* Only stdout is graded. */ });
    child.on('error', () => finish('error'));
    // A grandchild may hold the pipes open, so do not wait for 'close' forever.
    child.on('exit', (code) => { drain = setTimeout(() => finish(grade(code)), 1500); });
    child.on('close', (code) => finish(grade(code)));
    timer = setTimeout(() => {
      if (settled) return;
      if (child.exitCode !== null) {
        finish(grade(child.exitCode));
        return;
      }
      killTree(child);
      finish('timeout');
    }, timeoutSec * 1000);
  });
}

async function runUnit(alias, router, effort, kind, timeoutSec, repeat) {
  const assets = assetsFor(kind);
  const results = [];
  let total = 0;
  for (let i = 0; i < repeat; i++) {
    const run = await runOnce(alias, router, effort, assets, timeoutSec);
    results.push(run.result);
    total += run.secs;
  }
  const result = results.every((r) => r === 'pass') ? 'pass' : results.find((r) => r !== 'pass');
  return { result, secs: Math.round((total / repeat) * 10) / 10 };
}

// ---------------------------------------------------------------- rows and output
function makeRow(kind, pick, claude, router, id, effort, result, secs, note) {
  return { kind, pick, claude, router, id, effort, result, secs, note };
}

function writeJson(file, sections) {
  const rows = sections.flatMap((section) => section.rows);
  try {
    fs.writeFileSync(path.resolve(file), JSON.stringify(rows, null, 2) + '\n', 'utf8');
  } catch (e) {
    throw new Error(`cannot write ${file}: ${e.message}`);
  }
}

function printSections(sections) {
  for (const section of sections) {
    console.log(`== ${section.kind} ==`);
    for (const row of section.rows) {
      const effort = row.effort === null ? '-' : row.effort;
      const router = row.router === null ? '-' : row.router;
      const secs = row.secs === null ? '-' : `${row.secs.toFixed(1)}s`;
      console.log(`${row.pick} | ${effort} | ${router} | ${row.result} | ${secs}`);
    }
    const picks = section.picks;
    const suggested = picks.filter((p) => !p.failing).concat(picks.filter((p) => p.failing));
    console.log(`suggested ${section.kind}: ${suggested.map((p) => p.name).join(' > ')}`);
    const moved = picks.filter((p) => p.failing && suggested.indexOf(p) !== picks.indexOf(p));
    if (moved.length) console.log(`moved to end: ${moved.map((p) => p.name).join(', ')}`);
  }
}

// ---------------------------------------------------------------- benchmark
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const routing = loadRouting();
  const kinds = selectedKinds(routing, opts.kinds);
  const units = new Map();
  const sections = [];

  for (const kindName of kinds) {
    const kind = routing.kinds[kindName] || {};
    const picks = Array.isArray(kind.picks) ? kind.picks : [];
    const rows = [];
    const pickRows = [];
    for (const pick of picks) {
      if (pick && pick.claude) {
        const name = String(pick.claude);
        rows.push(makeRow(kindName, name, true, null, null, null, 'skipped', null, 'claude'));
        pickRows.push({ name, failing: false });
        continue;
      }
      const alias = pick && pick.model !== undefined ? String(pick.model) : '';
      const model = routing.models && typeof routing.models === 'object' ? routing.models[alias] : null;
      const effort = pickEffort(pick, model);
      const routes = model && Array.isArray(model.routes) ? model.routes : [];
      let hasPass = false;
      let hasRunFailure = false;
      for (const route of routes) {
        const router = route && typeof route.router === 'string' ? route.router : null;
        const id = route && route.id !== undefined && route.id !== null ? String(route.id) : null;
        let result;
        let secs = null;
        let note = '';
        if (!router) {
          result = 'skipped';
          note = 'unknown';
        } else if (routerType(routing, router) === 'claude') {
          result = 'skipped';
          note = 'claude';
        } else if (router === 'openrouter' && !(id || '').includes(':free') && !opts.includePaid) {
          result = 'skipped';
          note = 'paid';
        } else {
          const key = unitKey(alias, router, effort);
          if (units.has(key)) {
            ({ result, secs } = units.get(key));
          } else if (opts.dryRun) {
            result = 'planned';
            secs = null;
            units.set(key, { result, secs });
          } else {
            const run = await runUnit(alias, router, effort, kindName, opts.timeout, opts.repeat);
            result = run.result;
            secs = run.secs;
            units.set(key, { result, secs });
          }
        }
        if (result === 'pass') hasPass = true;
        if (result === 'fail' || result === 'error' || result === 'timeout') hasRunFailure = true;
        rows.push(makeRow(kindName, alias, false, router, id, effort, result, secs, note));
      }
      pickRows.push({ name: alias, failing: !hasPass && hasRunFailure });
    }
    sections.push({ kind: kindName, rows, picks: pickRows });
  }

  printSections(sections);
  if (opts.json) writeJson(opts.json, sections);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`[bench] ${e.message}`);
    process.exitCode = 2;
  } else {
    console.error(`[bench] ${(e && e.stack) || e}`);
    process.exitCode = 1;
  }
} finally {
  cleanup();
}
