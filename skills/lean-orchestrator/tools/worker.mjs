#!/usr/bin/env node
// worker.mjs: hand one brief to a non-Claude worker and get a capped report back.
//
//   node worker.mjs doctor
//       Router readiness (keys / programs) and the first runnable pick per kind. Exit 0 always.
//   node worker.mjs route [kind]
//       No network. Without a kind: kind, tier and picks. With a kind: also use_when, write and friends.
//   node worker.mjs run <kind> <brief-file> [--dir D] [--write] [--files a,b,glob] [--timeout S]
//                       [--tail N] [--dry-run] [--no-claude]
//       Walk the kind's picks in order. A model pick walks its routes in order. A Claude pick prints a
//       NEXT line and exits 3 (or is skipped with --no-claude). Write kinds need --write and --dir.
//       Pair kinds run every non-Claude pick and print each Claude pick as a NEXT line.
//   node worker.mjs ask <alias> <brief-file> [--files ...] [--router R] [--effort E]
//       One model, its routes in order (only router R when given).
//   node worker.mjs oc <provider/model> <brief-file>
//   node worker.mjs agy <model> <brief-file> [--effort e]
//       Raw probes of one CLI. The last line says mode, model, exit, secs and the saved output file.
//   node worker.mjs lock <file...> [--out F]
//       Write a JSON lock (default ./.test-lock.json) with created time and sha256 of each file.
//   node worker.mjs verify [lockfile]
//       Recompute the hashes. "OK n files unchanged" (exit 0) or CHANGED/MISSING lines (exit 1).
//
// Routing lives in ../routing.json (or WORKER_ROUTING). v1 files are still accepted: plain-string
// routers, routes with `oc` run through OpenCode, routes with `agy` through agy. v2 routes have
// {router, id} and routers declare their type.
//
// A router's `bin` may be one program name or path, or an array tried in order. OpenCode with no
// `bin` and no OPENCODE_BIN tries `opencode2` then `opencode`. An OpenCode binary older than 2 is
// skipped: OpenCode 1 has no `run --standalone` (npm rm -g opencode-ai; npm i -g @opencode/cli@latest).
// A route may set `timeoutSec` (positive number): for program routes it replaces --timeout for that route.
//
// HTTP routers may set `patience`: {attempts, firstTokenSec, idleSec, backoffSec: [..], totalSec}.
// attempts: tries per route (default 2). firstTokenSec: seconds until the first stream event may
// arrive (default --timeout). idleSec: longest allowed gap between events after the first (default
// 120). backoffSec: waits between attempts; the last value repeats (default
// [WORKER_RETRY_DELAY_MS/1000]). totalSec: cap for the whole route, all attempts and waits included
// (default --timeout). Fractional seconds are allowed. HTTP requests ask for a stream and read SSE
// deltas, falling back to a plain JSON body from providers that ignore `stream`.
//
// Common: --timeout SEC (default 600, decimals allowed), --tail CHARS printed to stdout (default 3000).
// The full answer is saved next to the brief as <brief>.<kind|alias>.out.txt. Exit codes: 0 ok,
// 1 every pick failed, 2 usage error, 3 a Claude pick must be spawned by the caller, 75 no free slot.
//
// Test hooks: WORKER_ROUTING, WORKER_FAKE_HTTP, WORKER_FAKE_CLI, WORKER_FAKE_CLI_SLEEP_MS,
// WORKER_FAIL_ROUTERS, WORKER_DEBUG_PROMPT, WORKER_RETRY_DELAY_MS, WORKER_SLOT_DIR,
// WORKER_SLOT_WAIT, WORKER_AGY_SLOTS, WORKER_OPENCODE_SLOTS, WORKER_FAKE_OPENCODE_VERSION.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const DEFAULT_ROUTING = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routing.json');
const ROUTING_FILE = path.resolve(process.env.WORKER_ROUTING || DEFAULT_ROUTING);
const FAIL_ROUTERS = (process.env.WORKER_FAIL_ROUTERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const RETRY_DELAY_MS = numberEnv('WORKER_RETRY_DELAY_MS', 5000);
const SLOT_WAIT_SEC = numberEnv('WORKER_SLOT_WAIT', 480);
const SLOT_DIR = process.env.WORKER_SLOT_DIR
  ? path.resolve(process.env.WORKER_SLOT_DIR)
  : path.join(os.tmpdir(), 'worker-mjs-slots');
const SLOT_COUNTS = {
  agy: Math.max(1, numberEnv('WORKER_AGY_SLOTS', 2)),
  opencode: Math.max(1, numberEnv('WORKER_OPENCODE_SLOTS', 1)),
};
const BIN_ENV = { agy: 'AGY_BIN', opencode: 'OPENCODE_BIN' };
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

class WorkerExit extends Error {
  constructor(code, message) {
    super(message || '');
    this.code = code;
  }
}
const die = (msg) => { throw new WorkerExit(2, msg); };
const strip = (s) => String(s ?? '').replace(ANSI, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function numberEnv(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// ---------------------------------------------------------------- argv
const argv = process.argv.slice(2);
function takeFlag(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined) die(`--${name} needs a value`);
  argv.splice(i, 2);
  return v;
}
function takeBool(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}
let timeoutSec = 600;
let tail = 3000;
let dirArg;
let dir;
let fileSpecs = [];
let writeFlag = false;
let dryRun = false;
let noClaude = false;
let routerArg;
let effortArg;
let outArg;
let command;
let args = [];
function parseArgs() {
  const timeoutRaw = takeFlag('timeout');
  const tailRaw = takeFlag('tail');
  dirArg = takeFlag('dir');
  const filesRaw = takeFlag('files');
  routerArg = takeFlag('router');
  effortArg = takeFlag('effort');
  outArg = takeFlag('out');
  writeFlag = takeBool('write');
  dryRun = takeBool('dry-run');
  noClaude = takeBool('no-claude');
  timeoutSec = timeoutRaw === undefined ? 600 : Number(timeoutRaw);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) die('--timeout must be a positive number of seconds');
  tail = tailRaw === undefined ? 3000 : Number(tailRaw);
  if (!Number.isFinite(tail) || tail < 0) die('--tail must be a non-negative number');
  dir = path.resolve(dirArg || process.cwd());
  fileSpecs = filesRaw ? filesRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  command = argv[0];
  args = argv.slice(1);
}

// ---------------------------------------------------------------- routing data
function loadRouting() {
  let raw;
  try {
    raw = fs.readFileSync(ROUTING_FILE, 'utf8');
  } catch (e) {
    die(`cannot read ${ROUTING_FILE}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`cannot parse ${ROUTING_FILE}: ${e.message}`);
  }
}

function routerConfig(R, name) {
  const cfg = R && R.routers ? R.routers[name] : undefined;
  return cfg && typeof cfg === 'object' ? cfg : null;
}

// v1 routers are strings: agy/claude are named, everything else ran through OpenCode.
function routerType(R, name) {
  const cfg = routerConfig(R, name);
  if (cfg) return cfg.type || 'unknown';
  if (name === 'agy') return 'agy';
  if (name === 'claude') return 'claude';
  return 'opencode';
}

function routeInfo(R, route) {
  if (route.oc) return { mode: 'oc', id: String(route.oc) };
  if (route.agy) return { mode: 'agy', id: String(route.agy) };
  const type = routerType(R, route.router);
  const id = route.id === undefined ? '' : String(route.id);
  if (type === 'http') return { mode: 'http', id };
  if (type === 'agy') return { mode: 'agy', id };
  if (type === 'opencode') return { mode: 'oc', id };
  if (type === 'cli') return { mode: 'cli', id };
  if (type === 'claude') return { mode: 'claude', id };
  return { mode: 'unknown', id };
}

function httpMissing(R, name) {
  const cfg = routerConfig(R, name) || {};
  const vars = [];
  if (cfg.keyEnv) vars.push(cfg.keyEnv);
  for (const m of String(cfg.baseUrl || '').matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) vars.push(m[1]);
  for (const v of vars) if (!process.env[v]) return v;
  return null;
}

function programKey(mode) {
  return mode === 'agy' ? 'agy' : 'opencode';
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Windows: Node cannot spawn .cmd/.bat files without a shell (spawn EINVAL), and a shell would mangle the brief we
// pass as an argument. So a .cmd/.bat shim is followed to the .exe it launches; extensionless files (POSIX shims
// from npm) are skipped. A shim that only runs a script (npm's node shims) is skipped too; set OPENCODE_BIN/AGY_BIN.
function shimExe(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const dir = path.dirname(file);
  const expand = (s) => s
    .replace(/%~dp0%?|%dp0%/gi, dir + path.sep)
    .replace(/%([A-Za-z0-9_]+)%/g, (m, v) => process.env[v] || process.env[v.toUpperCase()] || m);
  for (const m of text.matchAll(/"([^"\r\n]+?\.exe)"|(\S+?\.exe)\b/gi)) {
    const p = path.normalize(expand(m[1] || m[2]));
    if (path.isAbsolute(p) && fileExists(p)) return p;
  }
  return null;
}

// npm installs a JavaScript CLI behind a .cmd shim that runs the script with node, in the form
//   "%dp0%\node_modules\@scope\pkg\bin\tool.js" %*
// A cli router can run such a shim as process.execPath <script> ...; agy/opencode still need a real .exe.
function shimNodeScript(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const dir = path.dirname(file);
  const expand = (s) => s
    .replace(/%~dp0%?|%dp0%/gi, dir + path.sep)
    .replace(/%([A-Za-z0-9_]+)%/g, (m, v) => process.env[v] || process.env[v.toUpperCase()] || m);
  for (const m of text.matchAll(/"([^"\r\n]+?\.(?:js|cjs|mjs))"|(\S+?\.(?:js|cjs|mjs))\b/gi)) {
    const p = path.normalize(expand(m[1] || m[2]));
    if (path.isAbsolute(p) && fileExists(p)) return p;
  }
  return null;
}

// A spawn target is the program plus any arguments that must come before the router's own arguments.
function spawnTarget(p, cli) {
  if (process.platform !== 'win32') return { bin: p, args: [] };
  const ext = path.extname(p).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { bin: p, args: [] };
  if (ext === '.cmd' || ext === '.bat') {
    // A cli router tries the node script first: npm's template names a node.exe beside the shim, and taking
    // that .exe would drop the script path.
    if (cli) {
      const script = shimNodeScript(p);
      if (script) return { bin: process.execPath, args: [script] };
    }
    const exe = shimExe(p);
    if (exe) return { bin: exe, args: [] };
  }
  return null;
}

function spawnable(p) {
  const target = spawnTarget(p, false);
  return target ? target.bin : null;
}

function whichTarget(name, cli) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const hasExt = path.extname(name) !== '';
  const exts = isWin && !hasExt
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const candidate = path.join(d, name + ext);
      if (!fileExists(candidate)) continue;
      const target = spawnTarget(candidate, cli);
      if (target) return target;
    }
  }
  return null;
}

function which(name) {
  const target = whichTarget(name, false);
  return target ? target.bin : null;
}

function expandBinEntry(entry) {
  const text = String(entry);
  let missing = false;
  const expanded = text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, n) => {
    const value = process.env[n];
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : expanded;
}

// A router's bin is one name/path or an array tried in order. A cli router may name its environment
// override with binEnv and expand ${NAME} from the environment; an entry naming an unset variable is
// skipped. With no bin and no env override, OpenCode tries opencode2 then opencode (OpenCode 2 installs both).
function binCandidates(R, name, mode) {
  const cfg = routerConfig(R, name);
  if (mode === 'cli') {
    const envName = cfg && cfg.binEnv;
    if (envName && process.env[envName]) return [String(process.env[envName])];
    const raw = cfg && cfg.bin;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const expanded = [];
    for (const entry of list) {
      const value = expandBinEntry(entry);
      if (value !== null) expanded.push(value);
    }
    if (expanded.length) return expanded;
    if (list.length) return list.map(String);
    return [name];
  }
  const envName = BIN_ENV[programKey(mode)];
  if (envName && process.env[envName]) return [process.env[envName]];
  const raw = cfg && cfg.bin;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (list.length) return list.map(String);
  return programKey(mode) === 'opencode' ? ['opencode2', 'opencode'] : [programKey(mode)];
}

function programCandidate(R, name, mode) {
  return binCandidates(R, name, mode).join(' or ');
}

function binTarget(bin, cli) {
  if (path.isAbsolute(bin) || /^[A-Za-z]:/.test(bin) || bin.includes('/') || bin.includes('\\')) {
    return fileExists(bin) ? spawnTarget(bin, cli) : null;
  }
  return whichTarget(bin, cli);
}

function binPath(bin) {
  const target = binTarget(bin, false);
  return target ? target.bin : null;
}

function programTarget(R, name, mode) {
  for (const bin of binCandidates(R, name, mode)) {
    const target = binTarget(bin, mode === 'cli');
    if (target) return target;
  }
  return null;
}

function programPath(R, name, mode) {
  const target = programTarget(R, name, mode);
  return target ? target.bin : null;
}

// ---------------------------------------------------------------- OpenCode version gate
const OPENCODE_MIN_MAJOR = 2;
const versionCache = new Map();

function versionFromText(text) {
  const m = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { version: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]) };
}

function opencodeVersion(bin) {
  const key = path.resolve(String(bin));
  if (versionCache.has(key)) return versionCache.get(key);
  const fake = process.env.WORKER_FAKE_OPENCODE_VERSION;
  let found;
  if (fake !== undefined) {
    found = versionFromText(fake);
  } else {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    found = versionFromText(`${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}`);
  }
  const info = found ? { ...found, bin } : null;
  versionCache.set(key, info);
  return info;
}

function tooOldReason(v) {
  return `too old (v${v.version} at ${v.bin}; needs OpenCode 2: npm i -g @opencode/cli@latest)`;
}

function routeAvailability(R, route, opts = {}) {
  const info = routeInfo(R, route);
  if (info.mode === 'claude') return { ok: true };
  if (info.mode === 'http') {
    const miss = httpMissing(R, route.router);
    return miss ? { ok: false, reason: `missing ${miss}` } : { ok: true };
  }
  if (info.mode === 'agy' || info.mode === 'oc' || info.mode === 'cli') {
    if (process.env.WORKER_FAKE_CLI && !opts.doctor) return { ok: true };
    const bin = programPath(R, route.router, info.mode);
    if (!bin) {
      return { ok: false, reason: `not installed (${programCandidate(R, route.router, info.mode)})` };
    }
    if (info.mode === 'oc') {
      const v = opencodeVersion(bin);
      if (v && v.major < OPENCODE_MIN_MAJOR) return { ok: false, reason: tooOldReason(v) };
    }
    return { ok: true, bin };
  }
  return { ok: false, reason: 'unknown router type' };
}

function effortFor(pick, model, mode, override, cfg) {
  if (mode === 'cli') {
    return (pick && pick.effort) || (model && model.effort) || override
      || (cfg && cfg.defaultEffort) || 'medium';
  }
  return override || (pick && pick.effort) || (model && model.effort) || (mode === 'agy' ? 'low' : undefined);
}

function routeIdFor(info, eff) {
  return info.mode === 'oc' && eff ? `${info.id}#${eff}` : info.id;
}

// A program route may override the global --timeout for its own child process.
function routeTimeout(route) {
  const raw = route && route.timeoutSec;
  if (raw === undefined) return timeoutSec;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    die(`route ${route.router}: timeoutSec must be a positive number of seconds`);
  }
  return raw;
}

function pickStr(R, p) {
  if (p.claude) {
    const a = (R.claude_agents && R.claude_agents[p.claude]) || {};
    return `claude:${p.claude} (${a.model || '?'} ${a.effort || '?'})`;
  }
  const m = (R.models && R.models[p.model]) || { routes: [] };
  const via = (m.routes || []).map((r) => {
    const info = routeInfo(R, r);
    return info.mode === 'cli' && info.id ? `${r.router}:${info.id}` : r.router;
  }).join('>');
  return `${p.model}(${p.effort || m.effort || 'default'}) via ${via}`;
}

function nextLine(R, name, file) {
  const a = (R.claude_agents && R.claude_agents[name]) || {};
  return `[worker] NEXT: spawn Claude agent "${name}" (model ${a.model || '?'}, effort ${a.effort || '?'}) with brief ${file}`;
}

// ---------------------------------------------------------------- small helpers
function readBrief(file) {
  if (!fs.existsSync(file)) die('brief file not found: ' + file);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    die(`cannot read brief ${file}: ${e.message}`);
  }
}

function show(clean) {
  const text = String(clean ?? '');
  if (text.length > tail) {
    const shown = tail > 0 ? text.slice(-tail) : '';
    console.log(`[worker] showing last ${tail} of ${text.length} chars\n${shown}`);
  } else {
    console.log(text);
  }
}

function routeKey(R, route) {
  const cfg = routerConfig(R, route.router);
  if (!cfg || !cfg.keyEnv) return '';
  return process.env[cfg.keyEnv] || '';
}

function redactText(text, key) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('<redacted>');
  return s;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- file packing
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkGlob(base, parts, index, found) {
  const part = parts[index];
  const last = index === parts.length - 1;
  if (part.includes('*')) {
    const re = new RegExp('^' + part.split('*').map(escapeRe).join('.*') + '$');
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!re.test(ent.name)) continue;
      const p = path.join(base, ent.name);
      if (last) {
        if (ent.isFile()) found.push(p);
      } else if (ent.isDirectory()) {
        walkGlob(p, parts, index + 1, found);
      }
    }
    return;
  }
  const p = path.join(base, part);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return;
  }
  if (last) {
    if (st.isFile()) found.push(p);
  } else if (st.isDirectory()) {
    walkGlob(p, parts, index + 1, found);
  }
}

function collectFiles(base, specs) {
  const found = [];
  for (const spec of specs) {
    const normalized = String(spec).replace(/\\/g, '/');
    if (!normalized.includes('*')) {
      const p = path.resolve(base, spec);
      try {
        if (fs.statSync(p).isFile()) found.push(p);
      } catch {
        // Missing file: ignore it.
      }
      continue;
    }
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length) walkGlob(base, parts, 0, found);
  }
  return [...new Set(found)];
}

function packFiles(base, specs) {
  const chunks = [];
  let total = 0;
  for (const file of collectFiles(base, specs)) {
    let rel = path.relative(base, file);
    if (!rel) rel = path.basename(file);
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const chunk = `=== FILE: ${rel} ===\n${content}\n`;
    total += chunk.length;
    if (total > 80000) die('files exceed the 80,000 character cap (nothing was sent)');
    chunks.push(chunk);
  }
  return chunks.join('');
}

const SYSTEM_READ = 'You are a worker. Answer the brief directly and completely. '
  + 'You cannot read the project folder; only the text in this message is available to you.';
const SYSTEM_WRITE = 'You are a worker that edits files. Return every file you change in full, using exactly this format:\n'
  + '=== FILE: <relative path> ===\n<full file content>\n=== END FILE ===\n'
  + 'Use paths relative to the project folder only; never absolute paths and never "..".';

function buildUserText(brief, packed, isWrite, hasDirArg) {
  let user = brief;
  if (packed) user += '\n\n' + packed;
  else if (!isWrite && hasDirArg) user += '\n\nNo files were attached to this prompt; you cannot read the project folder.';
  return user;
}

function userTextFactory(brief, base, specs, isWrite, hasDirArg) {
  let cached;
  return () => {
    if (cached !== undefined) return cached;
    const packed = specs.length ? packFiles(base, specs) : '';
    cached = buildUserText(brief, packed, isWrite, hasDirArg);
    return cached;
  };
}

// ---------------------------------------------------------------- http routes
function extractContent(json) {
  const choice = (json && json.choices && json.choices[0]) || {};
  let content = choice.message ? choice.message.content : choice.text;
  if (content === undefined || content === null) content = '';
  if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
  return String(content);
}

function readFakeHttp(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const m = lines[0] && lines[0].match(/^HTTP\s+(\d{3})\s*$/);
  if (!m) return { status: 200, body: text };
  return { status: Number(m[1]), body: lines.slice(1).join('\n') };
}

const secText = (n) => String(Math.round(n * 1000) / 1000);

function patienceConfig(R, name) {
  const cfg = routerConfig(R, name) || {};
  const raw = cfg.patience;
  const dflt = {
    attempts: 2,
    firstTokenSec: timeoutSec,
    idleSec: 120,
    backoffSec: [Math.max(0, RETRY_DELAY_MS) / 1000],
    totalSec: timeoutSec,
  };
  if (raw === undefined || raw === null) return dflt;
  if (typeof raw !== 'object' || Array.isArray(raw)) die(`router ${name}: patience must be an object`);
  const out = { ...dflt };
  if (raw.attempts !== undefined) {
    if (!Number.isInteger(raw.attempts) || raw.attempts < 1) {
      die(`router ${name}: patience.attempts must be an integer >= 1`);
    }
    out.attempts = raw.attempts;
  }
  for (const field of ['firstTokenSec', 'idleSec', 'totalSec']) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field]) || raw[field] <= 0) {
      die(`router ${name}: patience.${field} must be a positive number of seconds`);
    }
    out[field] = raw[field];
  }
  if (raw.backoffSec !== undefined) {
    const list = raw.backoffSec;
    if (!Array.isArray(list) || !list.length) {
      die(`router ${name}: patience.backoffSec must be a non-empty array of positive seconds`);
    }
    for (const v of list) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        die(`router ${name}: patience.backoffSec must be a non-empty array of positive seconds`);
      }
    }
    out.backoffSec = list.slice();
  }
  return out;
}

function httpTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function retryAfterSeconds(res) {
  let raw;
  try {
    raw = res.headers.get('retry-after');
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 120);
}

function streamDelta(json) {
  const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
  if (!delta) return '';
  const content = delta.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  }
  return '';
}

// Read an SSE body incrementally. Every chunk (and so every event) calls touch() to reset the idle
// timer; only choices[0].delta.content contributes to the answer. Stops at `data: [DONE]`.
async function readSse(stream, touch) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let out = '';
  let finished = false;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') {
      finished = true;
      return;
    }
    try {
      out += streamDelta(JSON.parse(payload));
    } catch {
      // A malformed event still counts as activity; ignore its content.
    }
  };
  const takeLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  };
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while (!finished && (nl = buffer.indexOf('\n')) >= 0) {
        takeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (!finished) {
      if (buffer) takeLine(buffer);
      dispatch();
    }
  } finally {
    if (finished) {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
    }
  }
  return out;
}

async function httpPass(url, body, key, patience, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) {
    return { ok: false, transient: false, reason: `total patience ${secText(patience.totalSec)}s exceeded` };
  }
  const controller = new AbortController();
  let firstTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let timeoutReason = '';
  let overTotal = false;
  let touched = false;
  const touch = () => {
    if (!touched) {
      touched = true;
      if (firstTimer) {
        clearTimeout(firstTimer);
        firstTimer = null;
      }
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutReason = `no stream activity for ${secText(patience.idleSec)}s`;
      controller.abort();
    }, patience.idleSec * 1000);
  };
  firstTimer = setTimeout(() => {
    timeoutReason = `no first token within ${secText(patience.firstTokenSec)}s`;
    controller.abort();
  }, patience.firstTokenSec * 1000);
  totalTimer = setTimeout(() => {
    overTotal = true;
    timeoutReason = `total patience ${secText(patience.totalSec)}s exceeded`;
    controller.abort();
  }, left);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let raw = '';
      try {
        raw = await res.text();
      } catch {
        // The status alone is enough to report the failure.
      }
      return {
        ok: false,
        transient: httpTransientStatus(res.status),
        retryAfterSec: res.status === 429 || res.status === 503 ? retryAfterSeconds(res) : null,
        reason: `HTTP ${res.status}: ${redactText(raw, key).slice(0, 400)}`,
      };
    }
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/event-stream') && res.body) {
      return { ok: true, out: await readSse(res.body, touch) };
    }
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, transient: false, reason: `invalid JSON from provider: ${redactText(raw, key).slice(0, 200)}` };
    }
    return { ok: true, out: extractContent(json) };
  } catch (e) {
    if (timeoutReason) return { ok: false, transient: !overTotal, reason: timeoutReason };
    const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
    const msg = String(code || (e && e.message) || e);
    return { ok: false, transient: true, reason: `request failed: ${msg}` };
  } finally {
    if (firstTimer) clearTimeout(firstTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}

async function httpAttempt(R, route, ctx) {
  const cfg = routerConfig(R, route.router) || {};
  const key = (cfg.keyEnv && process.env[cfg.keyEnv]) || '';
  const base = String(cfg.baseUrl || '')
    .replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, n) => process.env[n] || '')
    .replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: ctx.info.id,
    messages: [
      { role: 'system', content: ctx.write ? SYSTEM_WRITE : SYSTEM_READ },
      { role: 'user', content: ctx.userText() },
    ],
    stream: true,
  };
  const debugFile = process.env.WORKER_DEBUG_PROMPT;
  if (debugFile) {
    try {
      fs.mkdirSync(path.dirname(debugFile), { recursive: true });
      fs.writeFileSync(debugFile, JSON.stringify(body, null, 2));
    } catch {
      // Debug output only: never fail the route for it.
    }
  }

  const fake = process.env.WORKER_FAKE_HTTP;
  if (fake) {
    const once = async () => {
      let fakeRes;
      try {
        fakeRes = readFakeHttp(fake);
      } catch (e) {
        return { ok: false, reason: `fake http read failed: ${e.message}` };
      }
      if (fakeRes.status < 200 || fakeRes.status >= 300) {
        const transient = fakeRes.status === 429 || (fakeRes.status >= 500 && fakeRes.status < 600);
        return { ok: false, transient, reason: `HTTP ${fakeRes.status}: ${redactText(fakeRes.body, key).slice(0, 400)}` };
      }
      return { ok: true, out: fakeRes.body };
    };
    let result = await once();
    if (!result.ok && result.transient) {
      console.error(`[worker] route ${route.router} ${ctx.displayId} retry after ${oneLine(redactText(result.reason, key))} (${RETRY_DELAY_MS}ms)`);
      await sleep(RETRY_DELAY_MS);
      result = await once();
    }
    return result;
  }

  const patience = patienceConfig(R, route.router);
  const deadline = Date.now() + patience.totalSec * 1000;
  let last = { ok: false, transient: false, reason: 'no attempt made' };
  for (let attempt = 1; attempt <= patience.attempts; attempt++) {
    if (Date.now() >= deadline) {
      last = { ok: false, transient: false, reason: `total patience ${secText(patience.totalSec)}s exceeded` };
      break;
    }
    const res = await httpPass(url, body, key, patience, deadline);
    if (res.ok) return res;
    const reason = oneLine(redactText(res.reason, key));
    const backoff = patience.backoffSec[Math.min(attempt - 1, patience.backoffSec.length - 1)];
    const delay = res.retryAfterSec !== null && res.retryAfterSec !== undefined && res.retryAfterSec > backoff
      ? res.retryAfterSec
      : backoff;
    const mayRetry = res.transient && attempt < patience.attempts && Date.now() + delay * 1000 < deadline;
    if (!mayRetry) {
      console.error(`[worker] route ${route.router} ${ctx.displayId} attempt ${attempt}/${patience.attempts} failed: ${reason}`);
      return { ok: false, reason: res.reason, transient: res.transient };
    }
    console.error(`[worker] route ${route.router} ${ctx.displayId} attempt ${attempt}/${patience.attempts} failed: ${reason}; retry in ${secText(delay)}s`);
    await sleep(delay * 1000);
    last = res;
  }
  return { ok: false, reason: last.reason, transient: false };
}

// ---------------------------------------------------------------- child processes
function runChild(bin, childArgs, cwd, seconds = timeoutSec, opts = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const stdinText = opts.stdinText === undefined ? null : opts.stdinText;
    let child;
    try {
      child = spawn(bin, childArgs, {
        cwd,
        env: { ...process.env, PWD: cwd },
        windowsHide: true,
        stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: !isWin,
      });
    } catch (e) {
      resolve({ code: 126, out: String(e), timedOut: false });
      return;
    }
    if (stdinText !== null) {
      // Write the whole prompt, then close standard input so a reader sees end-of-file.
      child.stdin.on('error', () => { /* The child may exit before reading. */ });
      child.stdin.end(stdinText);
    }
    let out = '';
    let settled = false;
    let timer;
    let drain;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      // Drop the pipes so an inherited handle in a grandchild cannot keep this process alive.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: timedOut ? 124 : code, out, timedOut: !!timedOut });
    };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += String(e); finish(126, false); });
    // A grandchild may hold the pipes open, so do not wait for 'close' forever: give it 2 s to drain.
    child.on('exit', (code) => { drain = setTimeout(() => finish(code, false), 2000); });
    child.on('close', (code) => finish(code, false));
    timer = setTimeout(() => {
      try {
        if (isWin) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
      finish(124, true);
    }, seconds * 1000);
  });
}

function alive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function acquireSlot(name, seconds, slots) {
  const count = Number.isInteger(slots) && slots >= 1 ? slots : (SLOT_COUNTS[name] || 1);
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  const started = Date.now();
  let announced = false;
  for (;;) {
    for (let i = 0; i < count; i++) {
      const folder = path.join(SLOT_DIR, `${name}-${i}`);
      try {
        fs.mkdirSync(folder);
        try {
          fs.writeFileSync(path.join(folder, 'owner.json'), JSON.stringify({
            pid: process.pid,
            deadline: Date.now() + seconds * 1000 + 60000,
          }));
        } catch (e) {
          try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* Best effort. */ }
          throw e;
        }
        return () => {
          try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* Best effort. */ }
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let owner = null;
        try {
          owner = JSON.parse(fs.readFileSync(path.join(folder, 'owner.json'), 'utf8'));
        } catch {
          // Being created or released.
        }
        if (owner && typeof owner === 'object') {
          const pid = Number(owner.pid);
          const deadline = Number(owner.deadline);
          if (!alive(pid) || (Number.isFinite(deadline) && Date.now() > deadline)) {
            try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* Raced. */ }
            continue;
          }
        } else {
          try {
            const age = Date.now() - fs.statSync(folder).mtimeMs;
            if (age > 30000) {
              fs.rmSync(folder, { recursive: true, force: true });
              continue;
            }
          } catch {
            // Released.
          }
        }
      }
    }
    if ((Date.now() - started) / 1000 >= SLOT_WAIT_SEC) {
      console.error(`[worker] no free ${name} slot after waiting ${SLOT_WAIT_SEC}s`);
      throw new WorkerExit(75);
    }
    if (!announced) {
      console.error(`[worker] waiting for a free ${name} slot`);
      announced = true;
    }
    await sleep(100);
  }
}

function fillPlaceholders(arg, values) {
  let text = String(arg);
  for (const [key, value] of Object.entries(values)) text = text.split(`{${key}}`).join(String(value));
  return text;
}

function applyStrip(text, patterns) {
  let s = String(text ?? '');
  for (const re of patterns) s = s.replace(re, '');
  return s;
}

// A cli router's strip list is compiled before the program runs: a bad pattern is a configuration error.
function stripPatternsFor(cfg, name) {
  const raw = cfg && cfg.strip;
  const list = raw === undefined || raw === null ? [] : (Array.isArray(raw) ? raw : [raw]);
  return list.map((pattern) => {
    try {
      return new RegExp(String(pattern), 'gm');
    } catch (e) {
      die(`router ${name}: invalid strip pattern ${JSON.stringify(pattern)}: ${e.message}`);
    }
  });
}

function slotCountFor(cfg, name) {
  const raw = cfg && cfg.slots;
  if (raw === undefined) return 1;
  if (!Number.isInteger(raw) || raw < 1) die(`router ${name}: slots must be an integer >= 1`);
  return raw;
}

// A cli router may set timeoutSec on the route or on the router configuration.
function cliTimeoutFor(R, route) {
  if (route && route.timeoutSec !== undefined) return routeTimeout(route);
  const cfg = routerConfig(R, route.router) || {};
  if (cfg.timeoutSec !== undefined) return routeTimeout({ router: route.router, timeoutSec: cfg.timeoutSec });
  return timeoutSec;
}

async function cliRouterAttempt(R, route, ctx) {
  const name = route.router;
  const cfg = routerConfig(R, name) || {};
  const secs = cliTimeoutFor(R, route);
  const patterns = stripPatternsFor(cfg, name);
  const slots = slotCountFor(cfg, name);
  const isWrite = !!ctx.write;
  const rawArgs = isWrite ? cfg.writeArgs : cfg.args;
  const argList = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  // fileAccess false: the program cannot read the folder, so pack the files into the prompt as for http.
  const promptText = cfg.fileAccess === false ? ctx.userText() : ctx.brief;
  const release = await acquireSlot(name, secs, slots);
  let tmpDir = null;
  try {
    const fake = process.env.WORKER_FAKE_CLI;
    if (fake) {
      const sleepMs = numberEnv('WORKER_FAKE_CLI_SLEEP_MS', 0);
      const timeoutMs = secs * 1000;
      if (sleepMs >= timeoutMs) {
        await sleep(timeoutMs);
        return { ok: false, reason: `timed out after ${secs}s` };
      }
      if (sleepMs > 0) await sleep(sleepMs);
      try {
        return { ok: true, out: applyStrip(fs.readFileSync(fake, 'utf8'), patterns) };
      } catch (e) {
        return { ok: false, reason: `fake cli read failed: ${e.message}` };
      }
    }
    const target = programTarget(R, name, 'cli');
    if (!target) return { ok: false, reason: `not installed (${programCandidate(R, name, 'cli')})` };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-cli-'));
    const briefFile = path.join(tmpDir, 'brief.txt');
    const outFile = path.join(tmpDir, 'out.txt');
    fs.writeFileSync(briefFile, promptText, 'utf8');
    fs.writeFileSync(outFile, '', 'utf8');
    const usedOut = argList.some((arg) => arg.includes('{out}'));
    const values = {
      id: ctx.info.id,
      effort: ctx.eff || 'medium',
      dir: ctx.dir,
      out: outFile,
      briefFile,
      brief: promptText,
    };
    const childArgs = argList.map((arg) => fillPlaceholders(arg, values));
    const res = await runChild(target.bin, [...target.args, ...childArgs], ctx.dir, secs, {
      stdinText: cfg.stdin ? promptText : null,
    });
    if (res.timedOut) return { ok: false, reason: `timed out after ${secs}s` };
    if (res.code !== 0) {
      const tailText = oneLine(strip(res.out || '')).slice(-200);
      return { ok: false, reason: `exit ${res.code}${tailText ? ': ' + tailText : ''}` };
    }
    let answer = res.out;
    if (usedOut) {
      try {
        const fromOut = fs.readFileSync(outFile, 'utf8');
        if (fromOut.length) answer = fromOut;
      } catch {
        // No answer file: keep the captured output.
      }
    }
    return { ok: true, out: applyStrip(answer, patterns) };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
    release();
  }
}

async function cliAttempt(R, route, ctx) {
  const info = ctx.info;
  if (info.mode === 'cli') return cliRouterAttempt(R, route, ctx);
  const name = info.mode === 'agy' ? 'agy' : 'opencode';
  const secs = routeTimeout(route);
  const release = await acquireSlot(name, secs);
  try {
    const fake = process.env.WORKER_FAKE_CLI;
    if (fake) {
      const sleepMs = numberEnv('WORKER_FAKE_CLI_SLEEP_MS', 0);
      const timeoutMs = secs * 1000;
      if (sleepMs >= timeoutMs) {
        await sleep(timeoutMs);
        return { ok: false, reason: `timed out after ${secs}s` };
      }
      if (sleepMs > 0) await sleep(sleepMs);
      try {
        return { ok: true, out: fs.readFileSync(fake, 'utf8') };
      } catch (e) {
        return { ok: false, reason: `fake cli read failed: ${e.message}` };
      }
    }
    const bin = programPath(R, route.router, info.mode);
    if (!bin) return { ok: false, reason: `not installed (${programCandidate(R, route.router, info.mode)})` };
    const childArgs = info.mode === 'agy'
      ? ['-p', ctx.brief, '--model', info.id, '--effort', ctx.eff || 'low', '--mode', ctx.write ? 'accept-edits' : 'plan']
      : ['run', '--standalone', '-m', ctx.displayId, ...(ctx.write ? [] : ['--agent', 'plan']), ctx.brief]; // --standalone: a private server, so killing this process also stops the agent
    const res = await runChild(bin, childArgs, ctx.dir, secs);
    if (res.timedOut) return { ok: false, reason: `timed out after ${secs}s` };
    if (res.code !== 0) {
      const tailText = oneLine(strip(res.out || '')).slice(-200);
      return { ok: false, reason: `exit ${res.code}${tailText ? ': ' + tailText : ''}` };
    }
    return { ok: true, out: res.out };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- write checks
function isGitWorkTree(d) {
  try {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: d, env: { ...process.env, PWD: d }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    return r.status === 0 && String(r.stdout).trim() === 'true';
  } catch {
    return false;
  }
}

function gitSnapshot(d) {
  const hash = crypto.createHash('sha256');
  const git = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: d, env: { ...process.env, PWD: d }, timeout: 10000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
  // status --porcelain misses new edits to files that were already dirty, so hash the diff itself.
  const diff = git(['diff', '--binary', 'HEAD']) || git(['diff', '--binary']);
  if (diff) hash.update(diff);
  const others = git(['ls-files', '--others', '--exclude-standard', '-z']);
  for (const rel of String(others || '').split('\0').filter(Boolean)) {
    let contentHash = '<unreadable>';
    try {
      contentHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, rel))).digest('hex');
    } catch {
      // Vanished or unreadable: still counts as a distinct state.
    }
    hash.update('\0' + rel + '\0' + contentHash);
  }
  return hash.digest('hex');
}

function dirSignature(d) {
  const rows = [];
  const walk = (base, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const p = path.join(base, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else if (ent.isFile()) {
        try {
          const st = fs.statSync(p);
          rows.push(`${r}:${st.size}:${st.mtimeMs}`);
        } catch {
          // Vanished.
        }
      }
    }
  };
  walk(d, '');
  return rows.join('\n');
}

function changeDetector(d, useGit) {
  return useGit ? () => gitSnapshot(d) : () => dirSignature(d);
}

function parseFileBlocks(answer) {
  const lines = String(answer).split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const start = line.match(/^=== FILE: (.*?) ===\s*$/);
    if (start && !current) {
      current = { rel: start[1].trim(), lines: [] };
      continue;
    }
    if (current && /^=== END FILE ===\s*$/.test(line)) {
      blocks.push({ rel: current.rel, content: current.lines.join('\n') + '\n' });
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks;
}

const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// The nearest existing ancestor must really live under the real base, so a symlink or junction cannot point out.
function insideRealBase(base, abs) {
  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    return false;
  }
  let cur = base;
  let nearest = base;
  for (const part of path.relative(base, abs).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      fs.lstatSync(cur);
      nearest = cur;
    } catch {
      break; // Nothing below a missing component can exist yet.
    }
  }
  let real;
  try {
    real = fs.realpathSync(nearest);
  } catch {
    return false;
  }
  const relative = path.relative(realBase, real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRelPath(base, rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || path.isAbsolute(cleaned)) return null;
  const parts = cleaned.split('/').filter((p) => p && p !== '.'); // './src/a.txt' is fine
  if (!parts.length) return null;
  for (const part of parts) {
    if (part === '..' || part.toLowerCase() === '.git') return null;
    if (part.includes(':') || /[. ]$/.test(part) || WIN_DEVICE.test(part)) return null;
  }
  const abs = path.resolve(base, cleaned);
  const relative = path.relative(base, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!insideRealBase(base, abs)) return null;
  return { abs, rel: relative };
}

function writeFileBlocks(base, answer) {
  const blocks = parseFileBlocks(answer);
  if (!blocks.length) return { ok: false, reason: 'no files changed (no full-file blocks in the answer)' };
  const safe = [];
  for (const block of blocks) {
    const s = safeRelPath(base, block.rel);
    if (!s) return { ok: false, reason: `invalid file path in answer: ${block.rel}` };
    safe.push({ ...s, content: block.content });
  }
  const wrote = [];
  try {
    for (const block of safe) {
      fs.mkdirSync(path.dirname(block.abs), { recursive: true });
      fs.writeFileSync(block.abs, block.content);
      wrote.push(block.rel);
    }
  } catch (e) {
    return { ok: false, reason: `cannot write file: ${e.message}` };
  }
  return { ok: true, wrote };
}

// ---------------------------------------------------------------- route walking
async function attemptRoute(R, route, ctx) {
  const info = ctx.info;
  const displayId = ctx.displayId;
  if (FAIL_ROUTERS.includes(route.router)) {
    return { ok: false, reason: 'forced failure (test hook)' };
  }
  if (info.mode === 'cli' && ctx.write) {
    const cfg = routerConfig(R, route.router) || {};
    if (cfg.fileAccess === false) {
      console.error(`[worker] skip ${route.router}: no file access`);
      return { ok: false, skip: true };
    }
    if (!cfg.writeArgs) {
      console.error(`[worker] skip ${route.router}: read-only router (no writeArgs)`);
      return { ok: false, skip: true };
    }
  }
  const avail = routeAvailability(R, route);
  if (!avail.ok) {
    console.error(`[worker] skip ${route.router}: ${avail.reason}`);
    return { ok: false, skip: true };
  }
  const before = ctx.write ? ctx.snapshot() : null;
  let res;
  if (info.mode === 'http') res = await httpAttempt(R, route, ctx);
  else if (info.mode === 'oc' || info.mode === 'agy' || info.mode === 'cli') res = await cliAttempt(R, route, ctx);
  else res = { ok: false, reason: `unknown router type for ${route.router}` };
  if (!res.ok) return { ok: false, reason: res.reason };

  const clean = strip(res.out || '').trim();
  if (!clean) return { ok: false, reason: 'empty output' };
  const head = clean.slice(0, 300);
  if (/^(Error|error):|Model unavailable|insufficient credits|rate limit/i.test(head)) {
    return { ok: false, reason: `error-looking answer: ${head.slice(0, 120)}` };
  }
  if (ctx.write) {
    if (info.mode === 'http') {
      const w = writeFileBlocks(ctx.dir, clean);
      if (!w.ok) return { ok: false, reason: w.reason };
      for (const rel of w.wrote) console.log(`[worker] wrote ${rel}`);
    }
    const after = ctx.snapshot();
    if (before === after) return { ok: false, reason: `no files changed in ${ctx.dir}` };
  }
  return { ok: true, out: clean };
}

async function walkRoutes(R, pick, model, routes, ctx) {
  let tried = 0;
  for (const route of routes) {
    const info = routeInfo(R, route);
    const eff = effortFor(pick, model, info.mode, ctx.effortOverride, routerConfig(R, route.router));
    const displayId = routeIdFor(info, eff);
    const res = await attemptRoute(R, route, { ...ctx, info, eff, displayId });
    if (res.skip) continue;
    if (res.ok) return { ok: true, router: route.router, id: displayId, out: res.out, key: routeKey(R, route), tried };
    tried++;
    console.error(`[worker] route ${route.router} ${displayId} failed: ${oneLine(redactText(res.reason, routeKey(R, route)))}`);
  }
  return { ok: false, tried };
}

// ---------------------------------------------------------------- commands
function commandDoctor() {
  let R;
  try {
    R = loadRouting();
  } catch (e) {
    if (e instanceof WorkerExit) {
      console.error('[worker] ' + e.message);
      return 0;
    }
    throw e;
  }
  for (const [name, cfg] of Object.entries(R.routers || {})) {
    const type = routerType(R, name);
    if (type === 'claude') {
      console.log(`router ${name}: READY`);
    } else if (type === 'http') {
      const miss = httpMissing(R, name);
      if (miss) console.log(`router ${name}: NO KEY (${miss}) -> ${(cfg && cfg.signup) || ''}`.trimEnd());
      else console.log(`router ${name}: READY`);
    } else if (type === 'agy' || type === 'opencode' || type === 'cli') {
      const mode = type === 'agy' ? 'agy' : type === 'cli' ? 'cli' : 'oc';
      const bin = programPath(R, name, mode);
      if (!bin) {
        console.log(`router ${name}: NOT INSTALLED (${programCandidate(R, name, mode)})`);
      } else if (mode === 'oc') {
        const v = opencodeVersion(bin);
        if (v && v.major < OPENCODE_MIN_MAJOR) {
          console.log(`router ${name}: TOO OLD (v${v.version} at ${bin}; needs OpenCode 2: npm i -g @opencode/cli@latest)`);
        } else if (v) {
          console.log(`router ${name}: READY (v${v.version} at ${bin})`);
        } else {
          console.log(`router ${name}: READY`);
        }
      } else {
        console.log(`router ${name}: READY`);
      }
    } else {
      console.log(`router ${name}: READY`);
    }
  }
  for (const [kind, k] of Object.entries(R.kinds || {})) {
    let found = null;
    for (const p of k.picks || []) {
      if (p.claude) {
        found = `claude:${p.claude}`;
        break;
      }
      const m = R.models && R.models[p.model];
      if (!m) continue;
      for (const route of m.routes || []) {
        const avail = routeAvailability(R, route, { doctor: true });
        if (avail.ok) {
          found = `${p.model} via ${route.router}`;
          break;
        }
      }
      if (found) break;
    }
    console.log(`kind ${kind}: ${found || 'NONE runnable'}`);
  }
  return 0;
}

function commandRoute(R) {
  if (!args.length) {
    for (const [k, v] of Object.entries(R.kinds || {})) {
      console.log(`${k}\t${v.tier}\t${(v.picks || []).map((p) => pickStr(R, p)).join(' | ')}`);
    }
    return 0;
  }
  const name = args[0];
  const v = R.kinds && R.kinds[name];
  if (!v) die(`unknown kind "${name}". Have: ${Object.keys(R.kinds || {}).join(', ')}`);
  console.log(`${name}\t${v.tier}\t${(v.picks || []).map((p) => pickStr(R, p)).join(' | ')}`);
  for (const field of ['use_when', 'not_for', 'mode', 'lock', 'review_with', 'after']) {
    if (v[field] !== undefined) console.log(`  ${field}: ${v[field]}`);
  }
  if (v.write) console.log('  write: true (needs --write and --dir)');
  return 0;
}

function commandLock() {
  const files = args;
  if (!files.length) die('usage: worker.mjs lock <file...> [--out F]');
  const lock = { created: new Date().toISOString(), files: {} };
  for (const f of files) {
    const a = path.resolve(f);
    if (!fs.existsSync(a)) die('file not found: ' + a);
    try {
      lock.files[a] = sha(a);
    } catch (e) {
      die(`cannot read ${a}: ${e.message}`);
    }
  }
  const out = path.resolve(outArg || '.test-lock.json');
  fs.writeFileSync(out, JSON.stringify(lock, null, 2) + '\n');
  console.log(`[worker] locked ${files.length} files -> ${out}`);
  return 0;
}

function commandVerify() {
  const lf = path.resolve(args[0] || '.test-lock.json');
  if (!fs.existsSync(lf)) die('lock file not found: ' + lf);
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lf, 'utf8'));
  } catch (e) {
    die(`cannot read lock file ${lf}: ${e.message}`);
  }
  const bad = [];
  for (const [f, h] of Object.entries((lock && lock.files) || {})) {
    if (!fs.existsSync(f)) bad.push('MISSING ' + f);
    else if (sha(f) !== h) bad.push('CHANGED ' + f);
  }
  if (bad.length) {
    console.log(bad.join('\n'));
    return 1;
  }
  console.log(`OK ${Object.keys((lock && lock.files) || {}).length} files unchanged`);
  return 0;
}

function printDryRun(R, kind, isWrite, briefFile) {
  for (const p of kind.picks || []) {
    if (p.claude) {
      console.log(nextLine(R, p.claude, briefFile));
      continue;
    }
    const m = R.models && R.models[p.model];
    if (!m) continue;
    for (const route of m.routes || []) {
      const info = routeInfo(R, route);
      const eff = effortFor(p, m, info.mode, undefined, routerConfig(R, route.router));
      const displayId = routeIdFor(info, eff);
      const avail = routeAvailability(R, route);
      let line = `[worker] would try ${p.model} route ${route.router} id=${displayId} effort=${eff || 'default'} mode=${info.mode} ${isWrite ? 'WRITE' : 'read-only'}`;
      if (!avail.ok) line += ` [would skip: ${avail.reason}]`;
      console.log(line);
    }
  }
}

async function commandRun(R) {
  const kindName = args[0];
  const briefFile = args[1];
  if (!kindName || !briefFile) {
    die('usage: worker.mjs run <kind> <brief-file> [--dir D] [--write] [--files a,b] [--timeout S] [--tail N] [--dry-run] [--no-claude]');
  }
  const kind = R.kinds && R.kinds[kindName];
  if (!kind) die(`unknown kind "${kindName}". Have: ${Object.keys(R.kinds || {}).join(', ')}`);
  const isWrite = kind.write === true;
  if (isWrite && !writeFlag) die(`kind ${kindName} writes files: pass --write (and --dir)`);
  if (!isWrite && writeFlag) die(`kind ${kindName} is read-only: do not pass --write`);
  if (isWrite && !dirArg) die(`kind ${kindName} writes files: pass --dir <directory>`);
  if (dirArg && !fs.existsSync(dir)) die('directory not found: ' + dir);
  const brief = readBrief(briefFile);
  if (dryRun) {
    printDryRun(R, kind, isWrite, briefFile);
    return 0;
  }

  let useGit = false;
  if (isWrite) {
    if (!isGitWorkTree(dir)) {
      die(`--dir is not inside a git work tree: ${dir}`);
    }
    useGit = true;
  }
  const ctx = {
    brief,
    briefFile,
    write: isWrite,
    dir,
    snapshot: isWrite ? changeDetector(dir, useGit) : null,
    userText: userTextFactory(brief, dir, fileSpecs, isWrite, !!dirArg),
  };
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);

  if (kind.mode === 'pair') {
    let allOk = true;
    let modelPicks = 0;
    let ran = 0;
    let tried = 0;
    for (const p of kind.picks || []) {
      if (p.claude) {
        if (!noClaude) console.log(nextLine(R, p.claude, briefFile));
        continue;
      }
      modelPicks++;
      const m = R.models && R.models[p.model];
      if (!m) {
        allOk = false;
        console.error(`[worker] pick ${p.model} failed: unknown model`);
        continue;
      }
      const r = await walkRoutes(R, p, m, m.routes || [], ctx);
      tried += r.tried;
      if (!r.ok) {
        allOk = false;
        console.error(`[worker] pick ${p.model} failed on every route`);
        continue;
      }
      ran++;
      const outFile = `${briefFile}.${p.model}.out.txt`;
      fs.writeFileSync(outFile, redactText(r.out, r.key) + '\n');
      console.log(`--- ${p.model} ---`);
      show(redactText(r.out, r.key));
    }
    if (modelPicks > 0 && ran === 0) allOk = false;
    console.log(`[worker] kind=${kindName} pair tried=${tried} exit=${allOk ? 0 : 1} secs=${secs()}`);
    return allOk ? 0 : 1;
  }

  let totalTried = 0;
  for (const p of kind.picks || []) {
    if (p.claude) {
      if (noClaude) continue;
      console.log(nextLine(R, p.claude, briefFile));
      return 3;
    }
    const m = R.models && R.models[p.model];
    if (!m) {
      console.error(`[worker] pick ${p.model} failed: unknown model`);
      continue;
    }
    const r = await walkRoutes(R, p, m, m.routes || [], ctx);
    totalTried += r.tried;
    if (!r.ok) {
      console.error(`[worker] pick ${p.model} failed on every route`);
      continue;
    }
    const outFile = `${briefFile}.${kindName}.out.txt`;
    fs.writeFileSync(outFile, redactText(r.out, r.key) + '\n');
    show(redactText(r.out, r.key));
    console.log(`\n[worker] kind=${kindName} picked=${p.model} via=${r.router} id=${r.id} tried=${totalTried} exit=0 secs=${secs()} out=${outFile}`);
    return 0;
  }
  console.error(`[worker] kind=${kindName} every pick failed${noClaude ? ' (no-claude: Claude picks skipped)' : ''} exit=1 secs=${secs()}`);
  return 1;
}

async function commandAsk(R) {
  const alias = args[0];
  const briefFile = args[1];
  if (!alias || !briefFile) die('usage: worker.mjs ask <alias> <brief-file> [--files a,b] [--router R] [--effort E]');
  const model = R.models && R.models[alias];
  if (!model) die(`unknown model "${alias}". Have: ${Object.keys(R.models || {}).join(', ')}`);
  if (writeFlag) die('ask is read-only: do not pass --write');
  if (dirArg && !fs.existsSync(dir)) die('directory not found: ' + dir);
  const brief = readBrief(briefFile);
  let routes = model.routes || [];
  if (routerArg) {
    if (!R.routers || !(routerArg in R.routers)) {
      die(`unknown router "${routerArg}". Have: ${Object.keys(R.routers || {}).join(', ')}`);
    }
    routes = routes.filter((r) => r.router === routerArg);
  }
  if (!routes.length) {
    console.error(`[worker] ask ${alias} has no routes${routerArg ? ` on ${routerArg}` : ''}`);
    return 1;
  }
  const ctx = {
    brief,
    briefFile,
    write: false,
    dir,
    snapshot: null,
    effortOverride: effortArg,
    userText: userTextFactory(brief, dir, fileSpecs, false, !!dirArg),
  };
  const started = Date.now();
  const r = await walkRoutes(R, { model: alias }, model, routes, ctx);
  if (!r.ok) {
    console.error(`[worker] ask ${alias} every route failed tried=${r.tried} exit=1 secs=${Math.round((Date.now() - started) / 1000)}`);
    return 1;
  }
  const outFile = `${briefFile}.${alias}.out.txt`;
  fs.writeFileSync(outFile, redactText(r.out, r.key) + '\n');
  show(redactText(r.out, r.key));
  console.log(`\n[worker] kind=ask picked=${alias} via=${r.router} id=${r.id} tried=${r.tried} exit=0 secs=${Math.round((Date.now() - started) / 1000)} out=${outFile}`);
  return 0;
}

async function commandProbe(R, mode) {
  const model = args[0];
  const briefFile = args[1];
  if (!model || !briefFile) die(`usage: worker.mjs ${mode} <model> <brief-file>${mode === 'agy' ? ' [--effort e]' : ''}`);
  if (dirArg && !fs.existsSync(dir)) die('directory not found: ' + dir);
  if (writeFlag && !isGitWorkTree(dir)) die(`--dir is not inside a git work tree: ${dir}`);
  const brief = readBrief(briefFile);
  const started = Date.now();
  const eff = mode === 'agy' ? (effortArg || 'low') : effortArg;
  const name = mode === 'agy' ? 'agy' : 'opencode';
  const displayId = mode === 'oc' && eff ? `${model}#${eff}` : model;
  const ctx = {
    brief,
    briefFile,
    write: writeFlag,
    dir,
    info: { mode, id: model },
    eff,
    displayId,
    snapshot: null,
    userText: () => brief,
  };
  const res = await cliAttempt(R, { router: name }, ctx);
  const clean = strip(res.out || '').trim();
  const key = routeKey(R, { router: name });
  const outFile = briefFile + '.out.txt';
  fs.writeFileSync(outFile, redactText(clean, key) + '\n');
  show(redactText(clean, key));
  const code = res.ok ? 0 : 1;
  console.log(`\n[worker] mode=${mode} model=${model}${mode === 'agy' ? ` effort=${eff}` : ''} ${writeFlag ? 'WRITE' : 'read-only'} exit=${code} secs=${Math.round((Date.now() - started) / 1000)} out=${outFile}`);
  return code;
}

// ---------------------------------------------------------------- dispatch
async function main() {
  parseArgs();
  if (!command) die('usage: worker.mjs doctor | route [kind] | run <kind> <brief-file> | ask <alias> <brief-file> | oc|agy <model> <brief-file> | lock <file...> | verify [lockfile]');
  if (command === 'doctor') return commandDoctor();
  if (command === 'route') return commandRoute(loadRouting());
  if (command === 'lock') return commandLock();
  if (command === 'verify') return commandVerify();
  if (command === 'run') return commandRun(loadRouting());
  if (command === 'ask') return commandAsk(loadRouting());
  if (command === 'oc') return commandProbe(loadRouting(), 'oc');
  if (command === 'agy') return commandProbe(loadRouting(), 'agy');
  die(`unknown command "${command}". Try: doctor, route, run, ask, oc, agy, lock, verify`);
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof WorkerExit) {
    if (e.message) console.error('[worker] ' + e.message);
    process.exitCode = e.code;
  } else {
    console.error('[worker] ' + ((e && e.stack) || e));
    process.exitCode = 1;
  }
}
