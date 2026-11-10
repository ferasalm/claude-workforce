import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Black-box tests for skills/lean-orchestrator/tools/bench.mjs, written from the specification only.
// Every probe reaches a cli router whose program is a recorder script that this file writes into a
// private folder. The recorder journals each start and end, answers from fixed arguments or from the
// prompt it is given, and reads no standard input.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BENCH = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'bench.mjs');

const NONCE = 'c0ffee42';
const PONG = `PONG-${NONCE}`;
const ACC = `ACC-${NONCE}`;
const SAFETY_MS = 20000; // a guard against a hung bench only; a correct run ends within seconds
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

const RECORDER = String.raw`import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const journal = path.join(path.dirname(fileURLToPath(import.meta.url)), 'calls.jsonl');
const argv = process.argv.slice(2);

function flagValue(flag) {
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

function readJournal() {
  try {
    return fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function record(entry) {
  fs.appendFileSync(journal, JSON.stringify(entry) + '\n', 'utf8');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeAnswer(text) {
  const reply = /Reply with exactly: (PONG-[^\r\n]*)/.exec(text);
  if (reply) return reply[1].trimEnd();
  if (text.includes('Read the attached file and reply with the access code only.')) {
    const code = /The access code is (ACC-\S+?)\.(?=\s|$)/.exec(text);
    if (code) return code[1];
  }
  if (text.includes('What does f(7) return? Reply with the number only.')
    && text.includes('function f(n) { return n * n + 3; }')) {
    return '52';
  }
  return 'UNRECOGNISED-PROBE';
}

async function main() {
  const tag = flagValue('--tag') ?? 'untagged';
  const fixed = flagValue('--answer');
  const exitCode = Number(flagValue('--exit') ?? 0);
  const sleepSec = Number(flagValue('--sleep') ?? 0);
  const holdMs = Number(flagValue('--hold') ?? 0);
  const probe = argv.includes('--probe');
  const alternate = argv.includes('--alternate');

  const files = {};
  for (const arg of argv) {
    try {
      if (fs.statSync(arg).isFile()) files[arg] = fs.readFileSync(arg, 'utf8');
    } catch {
      // Not a file argument.
    }
  }

  const earlier = readJournal().filter((entry) => entry.event === 'start' && entry.tag === tag).length;
  record({ event: 'start', tag, pid: process.pid, argv, files });

  let answer = fixed ?? (probe ? probeAnswer(Object.values(files).join('\n')) : 'NO-ANSWER-CONFIGURED');
  if (alternate && earlier % 2 === 1) answer = 'nope';
  if (sleepSec > 0) await delay(sleepSec * 1000);
  process.stdout.write(answer + '\n');
  if (holdMs > 0) await delay(holdMs);
  record({ event: 'end', tag, pid: process.pid });
  process.exitCode = Number.isInteger(exitCode) ? exitCode : 0;
}

main();
`;

// ---------------------------------------------------------------- fixtures

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A probe that is still alive can hold the folder on Windows; the tests that start one stop it.
    }
  });
  const sb = {
    root,
    cfg: path.join(root, 'cfg'),
    rec: path.join(root, 'rec'),
    work: path.join(root, 'work'),
    btmp: path.join(root, 'btmp'),
    slots: path.join(root, 'slots'),
    home: path.join(root, 'home'),
    routing: path.join(root, 'cfg', 'routing.json'),
    recorder: path.join(root, 'rec', 'recorder.mjs'),
    json: path.join(root, 'rows.json'),
  };
  for (const dir of [sb.cfg, sb.rec, sb.work, sb.btmp, sb.slots, sb.home]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(sb.recorder, RECORDER, 'utf8');
  return sb;
}

function cli(sb, tag, extra = [], more = {}) {
  return { type: 'cli', bin: [process.execPath], args: [sb.recorder, '--tag', tag, ...extra], ...more };
}

const fixed = (sb, tag, answer) => cli(sb, tag, ['--answer', answer]);
const probeRouter = (sb, tag, more = {}) => cli(sb, tag, ['--probe', '{briefFile}'], { fileAccess: false, ...more });
const model = (routes, extra = {}) => ({ family: 'bench', ...extra, routes });
const route = (router, id) => ({ router, id });
const kind = (picks) => ({ tier: '2', use_when: 'bench test', picks });

function routingDoc({ routers, models, kinds }) {
  const claude_agents = {};
  for (const entry of Object.values(kinds)) {
    for (const pick of entry.picks) {
      if (pick.claude) claude_agents[pick.claude] = { description: 'bench test agent' };
    }
  }
  return { version: 2, routers, models, claude_agents, kinds };
}

function writeRouting(sb, doc) {
  fs.writeFileSync(sb.routing, JSON.stringify(doc, null, 2), 'utf8');
}

function paidRouting(sb, pick, id) {
  return routingDoc({
    routers: { openrouter: probeRouter(sb, 'openrouter') },
    models: { [pick]: model([route('openrouter', id)]) },
    kinds: { trivial: kind([{ model: pick }]) },
  });
}

// ---------------------------------------------------------------- running the bench

function benchEnv(sb, nonce, extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith('WORKER_') || upper === 'BENCH_NONCE') continue;
    if (upper === 'NODE_TEST_CONTEXT' || SECRET_NAME.test(key)) continue;
    env[key] = value;
  }
  const set = {
    HOME: sb.home,
    USERPROFILE: sb.home,
    TEMP: sb.btmp,
    TMP: sb.btmp,
    TMPDIR: sb.btmp,
    WORKER_ROUTING: sb.routing,
    WORKER_SLOT_DIR: sb.slots,
    ...(nonce === null ? {} : { BENCH_NONCE: nonce }),
    ...extra,
  };
  for (const [key, value] of Object.entries(set)) {
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

async function runBench(sb, args, { nonce = NONCE, env = {} } = {}) {
  assert.ok(fs.existsSync(BENCH), `the implementation file does not exist yet: ${BENCH}`);
  const child = spawn(process.execPath, [BENCH, ...args], {
    cwd: sb.work,
    env: benchEnv(sb, nonce, env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill();
      reject(new Error(`the bench did not exit within ${SAFETY_MS / 1000} s: bench.mjs ${args.join(' ')}`));
    }, SAFETY_MS);
    child.on('error', (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
  });
}

function assertExit(result, expected = 0) {
  assert.equal(
    result.code,
    expected,
    `bench exited ${result.code}, expected ${expected}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
  );
}

// ---------------------------------------------------------------- reading the output

function sectionsOf(stdout) {
  const sections = new Map();
  let current = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const header = /^== (.+) ==$/.exec(line);
    if (header) {
      current = { rows: [], suggested: null, moved: null };
      sections.set(header[1], current);
    } else if (current && line.startsWith('suggested ')) {
      current.suggested = line;
    } else if (current && line.startsWith('moved to end: ')) {
      current.moved = line;
    } else if (current && line.includes(' | ')) {
      current.rows.push(line.split(' | '));
    }
  }
  return sections;
}

function sectionOf(stdout, kind) {
  const section = sectionsOf(stdout).get(kind);
  assert.ok(section, `no "== ${kind} ==" table in the output:\n${stdout}`);
  return section;
}

function rowsOf(stdout, kind, pick, router) {
  return sectionOf(stdout, kind).rows.filter(
    (cells) => cells[0] === pick && (router === undefined || cells[2] === router),
  );
}

function onlyRow(stdout, kind, pick, router) {
  const rows = rowsOf(stdout, kind, pick, router);
  const label = `${kind} / ${pick}${router === undefined ? '' : ` / ${router}`}`;
  assert.equal(rows.length, 1, `expected one row for ${label}, found ${rows.length}:\n${stdout}`);
  return rows[0];
}

// The result cell is the fourth column: pick | effort | router | result | secs.
function resultOf(stdout, kind, pick, router) {
  return onlyRow(stdout, kind, pick, router)[3];
}

function tableRowCount(stdout) {
  return stdout.split(/\r?\n/).filter((line) => line.includes(' | ')).length;
}

function readRows(sb) {
  assert.ok(fs.existsSync(sb.json), 'the bench did not write the --json file');
  return JSON.parse(fs.readFileSync(sb.json, 'utf8'));
}

function rowFor(rows, kind, pick) {
  const found = rows.filter((row) => row.kind === kind && row.pick === pick);
  assert.equal(found.length, 1, `expected one JSON row for ${kind} / ${pick}, found ${found.length}`);
  return found[0];
}

// ---------------------------------------------------------------- what the recorder saw

function journal(sb) {
  const file = path.join(sb.rec, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function probesOf(sb, tag) {
  return journal(sb).filter((entry) => entry.event === 'start' && (tag === undefined || entry.tag === tag));
}

function listTree(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      found.push(path.relative(dir, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found.sort();
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitUntilGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

// ---------------------------------------------------------------- classes of result

test('bench: --dry-run starts no child process, prints planned rows in routing order, and exits 0', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-pong': fixed(sb, 'say-pong', PONG), openrouter: probeRouter(sb, 'openrouter') },
    models: {
      'm-cli': model([route('say-pong', 'cli-id')]),
      'm-paid': model([route('openrouter', 'vendor/paid-model')]),
      'm-b': model([route('say-pong', 'b-id')]),
    },
    kinds: {
      trivial: kind([{ model: 'm-cli' }, { model: 'm-paid' }, { claude: 'reviewer' }]),
      'builder-iq': kind([{ model: 'm-b' }]),
    },
  }));
  const r = await runBench(sb, ['--dry-run']);
  assertExit(r, 0);
  assert.equal(probesOf(sb).length, 0, 'a dry run started a child process');
  assert.deepEqual(listTree(sb.btmp), [], 'a dry run left files in the temporary folder');
  const trivial = sectionOf(r.stdout, 'trivial');
  assert.deepEqual(
    trivial.rows.map((cells) => [cells[0], cells[3]]),
    [['m-cli', 'planned'], ['m-paid', 'skipped'], ['reviewer', 'skipped']],
    r.stdout,
  );
  assert.equal(trivial.suggested, 'suggested trivial: m-cli > m-paid > reviewer', r.stdout);
  assert.equal(trivial.moved, null, 'a dry run has nothing failing, so nothing moves');
  assert.equal(sectionOf(r.stdout, 'builder-iq').rows[0][3], 'planned', r.stdout);
  assert.ok(
    r.stdout.indexOf('== trivial ==') < r.stdout.indexOf('== builder-iq =='),
    'kinds must be printed in routing order',
  );
});

test('bench: an answer containing the expected token is graded pass', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-pong': fixed(sb, 'say-pong', PONG) },
    models: { 'pong-m': model([route('say-pong', 'pong-id')]) },
    kinds: { trivial: kind([{ model: 'pong-m' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'pong-m'), 'pass', r.stdout);
});

test('bench: an answer without the expected token is graded fail, and the run still exits 0', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: {
      'say-nope': fixed(sb, 'say-nope', 'nope'),
      'say-lookalike': fixed(sb, 'say-lookalike', 'PONG-c0ffee43'),
    },
    models: {
      'nope-m': model([route('say-nope', 'nope-id')]),
      'look-m': model([route('say-lookalike', 'look-id')]),
    },
    kinds: { trivial: kind([{ model: 'nope-m' }, { model: 'look-m' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'nope-m'), 'fail', r.stdout);
  assert.equal(resultOf(r.stdout, 'trivial', 'look-m'), 'fail', r.stdout);
});

test('bench: a child that exits non-zero, and a program that cannot start, are graded error', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: {
      'say-boom': cli(sb, 'say-boom', ['--exit', '3']),
      absent: { type: 'cli', bin: ['cw-bench-no-such-program'], args: [sb.recorder, '--tag', 'absent'] },
    },
    models: {
      'boom-m': model([route('say-boom', 'boom-id')]),
      'absent-m': model([route('absent', 'absent-id')]),
    },
    kinds: { trivial: kind([{ model: 'boom-m' }, { model: 'absent-m' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'boom-m'), 'error', r.stdout);
  assert.equal(resultOf(r.stdout, 'trivial', 'absent-m'), 'error', r.stdout);
});

test('bench: a child that outlives --timeout is graded timeout', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { hang: cli(sb, 'hang', ['--sleep', '30', '--answer', PONG]) },
    models: { 'hang-m': model([route('hang', 'hang-id')]) },
    kinds: { trivial: kind([{ model: 'hang-m' }]) },
  }));
  const r = await runBench(sb, ['--timeout', '1']);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'hang-m'), 'timeout', r.stdout);
});

test('bench: the process tree of a child that outlives --timeout is killed', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { tree: cli(sb, 'tree', ['--sleep', '60', '--answer', PONG]) },
    models: { 'tree-m': model([route('tree', 'tree-id')]) },
    kinds: { trivial: kind([{ model: 'tree-m' }]) },
  }));
  const r = await runBench(sb, ['--timeout', '3']);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'tree-m'), 'timeout', r.stdout);
  const started = probesOf(sb, 'tree');
  assert.equal(started.length, 1, 'the probe never started, so there was no process to time out');
  const pid = started[0].pid;
  const gone = await waitUntilGone(pid, 5000);
  if (!gone) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  assert.ok(
    gone,
    `probe process ${pid} is still running after the bench returned: a timeout must kill the whole child tree`,
  );
});

test('bench: the PONG and ACC tokens are matched case-sensitively', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: {
      'lower-pong': fixed(sb, 'lower-pong', PONG.toLowerCase()),
      'lower-acc': fixed(sb, 'lower-acc', ACC.toLowerCase()),
    },
    models: {
      'lp-m': model([route('lower-pong', 'lp-id')]),
      'la-m': model([route('lower-acc', 'la-id')]),
    },
    kinds: { trivial: kind([{ model: 'lp-m' }]), 'scout-light': kind([{ model: 'la-m' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'lp-m'), 'fail', r.stdout);
  assert.equal(resultOf(r.stdout, 'scout-light', 'la-m'), 'fail', r.stdout);
});

// ---------------------------------------------------------------- probes

test('bench: the reply, file and code probes send their exact sentences, and the file probe sends the file content', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { probe: probeRouter(sb, 'probe') },
    models: {
      'p-trivial': model([route('probe', 'p1')]),
      'p-scout': model([route('probe', 'p2')]),
      'p-deep': model([route('probe', 'p3')]),
      'p-builder': model([route('probe', 'p4')]),
    },
    kinds: {
      trivial: kind([{ model: 'p-trivial' }]),
      'scout-light': kind([{ model: 'p-scout' }]),
      'scout-deep': kind([{ model: 'p-deep' }]),
      'builder-iq': kind([{ model: 'p-builder' }]),
    },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'p-trivial'), 'pass', r.stdout);
  assert.equal(resultOf(r.stdout, 'scout-light', 'p-scout'), 'pass', r.stdout);
  assert.equal(resultOf(r.stdout, 'scout-deep', 'p-deep'), 'pass', r.stdout);
  assert.equal(resultOf(r.stdout, 'builder-iq', 'p-builder'), 'pass', r.stdout);

  const calls = probesOf(sb, 'probe');
  assert.equal(calls.length, 4, 'one probe per unit');
  const textOf = (call) => Object.values(call.files).join('\n');
  const reply = calls.filter((call) => textOf(call).includes(`Reply with exactly: ${PONG}`));
  assert.equal(reply.length, 1, 'exactly one call must carry the reply probe brief with PONG-<nonce>');
  const scout = calls.filter((call) => textOf(call).includes('Read the attached file and reply with the access code only.'));
  assert.equal(scout.length, 2, 'both scout kinds must send the file probe brief');
  for (const call of scout) {
    const carries = call.argv.some(
      (arg) => call.files[arg] !== undefined && call.files[arg].includes(`The access code is ${ACC}.`),
    );
    assert.ok(carries, 'the file probe must pass the attached file: a file argument must hold its content with the nonce');
  }
  const code = calls.filter((call) => textOf(call).includes('What does f(7) return? Reply with the number only.'));
  assert.equal(code.length, 1, 'exactly one call must carry the code probe question');
  assert.ok(textOf(code[0]).includes('function f(n) { return n * n + 3; }'), 'the code probe must include the function');
});

test('bench: each kind is graded with the probe its name selects, so another probe token does not pass', async (t) => {
  const sb = sandbox(t);
  const plan = [
    ['trivial', 't-pong', 'say-pong', 'pass'],
    ['trivial', 't-acc', 'say-acc', 'fail'],
    ['trivial', 't-52', 'say-52', 'fail'],
    ['scout-light', 's-acc', 'say-acc', 'pass'],
    ['scout-light', 's-pong', 'say-pong', 'fail'],
    ['scout-deep', 'd-acc', 'say-acc', 'pass'],
    ['scout-deep', 'd-52', 'say-52', 'fail'],
    ['builder-iq', 'b-52', 'say-52', 'pass'],
    ['builder-iq', 'b-pong', 'say-pong', 'fail'],
    ['builder-eq', 'e-52', 'say-52', 'pass'],
    ['test-writer', 'w-52', 'say-52', 'pass'],
    ['test-writer', 'w-acc', 'say-acc', 'fail'],
    ['mystery', 'm-52', 'say-52', 'pass'],
    ['mystery', 'm-acc', 'say-acc', 'fail'],
  ];
  const routers = {
    'say-pong': fixed(sb, 'say-pong', PONG),
    'say-acc': fixed(sb, 'say-acc', ACC),
    'say-52': fixed(sb, 'say-52', '52'),
  };
  const models = {};
  const kinds = {};
  for (const [kindName, pick, router] of plan) {
    models[pick] = model([route(router, `${pick}-id`)]);
    kinds[kindName] ??= kind([]);
    kinds[kindName].picks.push({ model: pick });
  }
  writeRouting(sb, routingDoc({ routers, models, kinds }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  for (const [kindName, pick, , expected] of plan) {
    assert.equal(resultOf(r.stdout, kindName, pick), expected, `${kindName} / ${pick} should be ${expected}:\n${r.stdout}`);
  }
});

test('bench: the code probe passes a whole 52 and fails 152, 5.2, 520 and 52.5', async (t) => {
  const sb = sandbox(t);
  const cases = [['52', 'pass'], ['152', 'fail'], ['5.2', 'fail'], ['520', 'fail'], ['52.5', 'fail']];
  const routers = {};
  const models = {};
  const picks = [];
  cases.forEach(([answer], index) => {
    routers[`ans${index}`] = fixed(sb, `ans${index}`, answer);
    models[`m${index}`] = model([route(`ans${index}`, `id${index}`)]);
    picks.push({ model: `m${index}` });
  });
  writeRouting(sb, routingDoc({ routers, models, kinds: { 'builder-iq': kind(picks) } }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  cases.forEach(([answer, expected], index) => {
    assert.equal(
      resultOf(r.stdout, 'builder-iq', `m${index}`),
      expected,
      `answer "${answer}" should be ${expected}:\n${r.stdout}`,
    );
  });
});

// ---------------------------------------------------------------- skipped picks and routes

test('bench: a Claude pick is listed as skipped and starts no process, and so is a route to a claude router', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'trap-r': probeRouter(sb, 'trap-r'), 'claude-r': { type: 'claude' } },
    models: {
      trap: model([route('trap-r', 'trap-id')]),
      'claude-only': model([route('claude-r', 'sonnet-id')]),
    },
    kinds: { trivial: kind([{ claude: 'trap' }, { model: 'claude-only' }]) },
  }));
  const r = await runBench(sb, ['--json', sb.json]);
  assertExit(r, 0);
  assert.equal(probesOf(sb).length, 0, 'a Claude pick or a claude route started a child process');
  assert.equal(resultOf(r.stdout, 'trivial', 'trap'), 'skipped', r.stdout);
  assert.equal(resultOf(r.stdout, 'trivial', 'claude-only'), 'skipped', r.stdout);
  const rows = readRows(sb);
  const agent = rowFor(rows, 'trivial', 'trap');
  assert.equal(agent.claude, true);
  assert.equal(agent.router, null);
  assert.equal(agent.result, 'skipped');
  assert.equal(agent.note, 'claude');
  assert.equal(rowFor(rows, 'trivial', 'claude-only').note, 'claude');
});

test('bench: an openrouter route whose id has no :free is skipped with note paid', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, paidRouting(sb, 'paid-m', 'vendor/paid-model'));
  const r = await runBench(sb, ['--json', sb.json]);
  assertExit(r, 0);
  assert.equal(probesOf(sb).length, 0, 'a paid route ran without --include-paid');
  assert.equal(resultOf(r.stdout, 'trivial', 'paid-m'), 'skipped', r.stdout);
  const row = rowFor(readRows(sb), 'trivial', 'paid-m');
  assert.equal(row.note, 'paid');
  assert.equal(row.router, 'openrouter');
  assert.equal(row.id, 'vendor/paid-model');
});

test('bench: --include-paid runs an openrouter route whose id has no :free', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, paidRouting(sb, 'paid-m', 'vendor/paid-model'));
  const r = await runBench(sb, ['--include-paid']);
  assertExit(r, 0);
  assert.equal(probesOf(sb).length, 1, '--include-paid must run the paid route once');
  assert.equal(resultOf(r.stdout, 'trivial', 'paid-m'), 'pass', r.stdout);
});

test('bench: an openrouter route whose id has :free runs without --include-paid', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, paidRouting(sb, 'free-m', 'vendor/free-model:free'));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(probesOf(sb).length, 1, 'a :free route must run without --include-paid');
  assert.equal(resultOf(r.stdout, 'trivial', 'free-m'), 'pass', r.stdout);
});

// ---------------------------------------------------------------- units

test('bench: a unit used by two kinds runs once and its result appears in both tables', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { probe: probeRouter(sb, 'probe') },
    models: { shared: model([route('probe', 'shared-id')]) },
    kinds: { 'builder-iq': kind([{ model: 'shared' }]), 'test-writer': kind([{ model: 'shared' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(probesOf(sb).length, 1, 'a unit shared by two kinds must run once');
  assert.equal(resultOf(r.stdout, 'builder-iq', 'shared', 'probe'), 'pass', r.stdout);
  assert.equal(resultOf(r.stdout, 'test-writer', 'shared', 'probe'), 'pass', r.stdout);
});

test('bench: effort is the pick effort, else the model effort, else none, and it separates units', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { probe: probeRouter(sb, 'probe') },
    models: {
      'eff-m': model([route('probe', 'eff-id')], { effort: 'low' }),
      'plain-m': model([route('probe', 'plain-id')]),
    },
    kinds: {
      'builder-iq': kind([{ model: 'eff-m' }, { model: 'plain-m' }]),
      'test-writer': kind([{ model: 'eff-m', effort: 'high' }]),
    },
  }));
  const r = await runBench(sb, ['--json', sb.json]);
  assertExit(r, 0);
  assert.equal(probesOf(sb, 'probe').length, 3, 'effort low, no effort and effort high are three different units');
  const rows = readRows(sb);
  assert.equal(rowFor(rows, 'builder-iq', 'eff-m').effort, 'low');
  assert.equal(rowFor(rows, 'builder-iq', 'plain-m').effort, null);
  assert.equal(rowFor(rows, 'test-writer', 'eff-m').effort, 'high');
  assert.equal(onlyRow(r.stdout, 'builder-iq', 'eff-m')[1], 'low', r.stdout);
  assert.equal(onlyRow(r.stdout, 'builder-iq', 'plain-m')[1], '-', r.stdout);
  assert.equal(onlyRow(r.stdout, 'test-writer', 'eff-m')[1], 'high', r.stdout);
});

test('bench: routing.json and other files beside it are not edited, and no files are left behind', async (t) => {
  const sb = sandbox(t);
  const sibling = path.join(sb.cfg, 'other-owned.json');
  fs.writeFileSync(sibling, '{"owned": "by the user"}\n', 'utf8');
  writeRouting(sb, routingDoc({
    routers: { probe: probeRouter(sb, 'probe'), openrouter: probeRouter(sb, 'openrouter') },
    models: {
      'p-m': model([route('probe', 'p-id')]),
      'p-scout': model([route('probe', 'scout-id')]),
      'paid-m': model([route('openrouter', 'vendor/paid')]),
    },
    kinds: {
      trivial: kind([{ model: 'p-m' }, { model: 'paid-m' }, { claude: 'reviewer' }]),
      'scout-light': kind([{ model: 'p-scout' }]),
    },
  }));
  const routingBefore = sha256(sb.routing);
  const siblingBefore = sha256(sibling);
  const workBefore = listTree(sb.work);
  const r = await runBench(sb, []);
  assertExit(r, 0);
  assert.equal(probesOf(sb, 'probe').length, 2, 'the probe units must have run');
  assert.equal(sha256(sb.routing), routingBefore, 'the bench edited routing.json');
  assert.equal(sha256(sibling), siblingBefore, 'the bench edited another file in the routing folder');
  assert.deepEqual(listTree(sb.work), workBefore, 'the bench left files in the working directory');
  assert.deepEqual(listTree(sb.btmp), [], 'the bench left files in the temporary folder');
});

// ---------------------------------------------------------------- output formats

test('bench: --json writes an array of rows with the documented keys and value types', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: {
      'say-pong': fixed(sb, 'say-pong', PONG),
      'say-nope': fixed(sb, 'say-nope', 'nope'),
      'say-boom': cli(sb, 'say-boom', ['--exit', '3']),
      openrouter: probeRouter(sb, 'openrouter'),
      'claude-r': { type: 'claude' },
    },
    models: {
      'ok-m': model([route('say-pong', 'ok-id')], { effort: 'low' }),
      'no-m': model([route('say-nope', 'no-id')]),
      'boom-m': model([route('say-boom', 'boom-id')]),
      'paid-m': model([route('openrouter', 'vendor/paid')]),
      'claude-m': model([route('claude-r', 'sonnet-id')]),
    },
    kinds: {
      trivial: kind([
        { model: 'ok-m' },
        { model: 'no-m' },
        { model: 'boom-m' },
        { model: 'paid-m' },
        { model: 'claude-m' },
        { claude: 'reviewer' },
      ]),
    },
  }));
  const r = await runBench(sb, ['--json', sb.json]);
  assertExit(r, 0);
  const rows = readRows(sb);
  assert.ok(Array.isArray(rows), 'the --json file must hold a JSON array');
  assert.equal(rows.length, tableRowCount(r.stdout), 'the JSON rows must match the table rows');
  const results = new Set(['pass', 'fail', 'error', 'timeout', 'skipped', 'planned']);
  for (const row of rows) {
    for (const key of ['kind', 'pick', 'claude', 'router', 'id', 'effort', 'result', 'secs', 'note']) {
      assert.ok(Object.hasOwn(row, key), `row ${JSON.stringify(row)} has no ${key}`);
    }
    assert.equal(typeof row.kind, 'string');
    assert.equal(typeof row.pick, 'string');
    assert.equal(typeof row.claude, 'boolean');
    assert.ok(row.router === null || typeof row.router === 'string', `router of ${row.pick}`);
    assert.ok(row.id === null || typeof row.id === 'string', `id of ${row.pick}`);
    assert.ok(row.effort === null || typeof row.effort === 'string', `effort of ${row.pick}`);
    assert.ok(results.has(row.result), `unknown result ${row.result} for ${row.pick}`);
    assert.equal(typeof row.note, 'string');
    if (row.result === 'skipped') {
      assert.equal(row.secs, null, `a skipped row has no secs: ${row.pick}`);
    } else {
      assert.ok(typeof row.secs === 'number' && row.secs >= 0, `a row that ran needs secs: ${row.pick}`);
    }
  }
  const ok = rowFor(rows, 'trivial', 'ok-m');
  assert.equal(ok.result, 'pass');
  assert.equal(ok.router, 'say-pong');
  assert.equal(ok.id, 'ok-id');
  assert.equal(ok.effort, 'low');
  assert.equal(ok.claude, false);
  assert.equal(rowFor(rows, 'trivial', 'no-m').result, 'fail');
  assert.equal(rowFor(rows, 'trivial', 'boom-m').result, 'error');
  const paid = rowFor(rows, 'trivial', 'paid-m');
  assert.equal(paid.result, 'skipped');
  assert.equal(paid.note, 'paid');
  assert.equal(paid.router, 'openrouter');
  assert.equal(paid.claude, false);
  assert.equal(rowFor(rows, 'trivial', 'claude-m').note, 'claude');
  const agent = rowFor(rows, 'trivial', 'reviewer');
  assert.equal(agent.claude, true);
  assert.equal(agent.router, null);
  assert.equal(agent.id, null);
  assert.equal(agent.effort, null);
  assert.equal(agent.result, 'skipped');
  assert.equal(agent.secs, null);
  assert.equal(agent.note, 'claude');
});

// ---------------------------------------------------------------- kinds and usage errors

test('bench: --kinds keeps only the named kinds, and a comma list keeps several', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-pong': fixed(sb, 'say-pong', PONG), probe: probeRouter(sb, 'probe') },
    models: {
      t1: model([route('say-pong', 't1-id')]),
      b1: model([route('probe', 'b1-id')]),
    },
    kinds: { trivial: kind([{ model: 't1' }]), 'builder-iq': kind([{ model: 'b1' }]) },
  }));
  const only = await runBench(sb, ['--kinds', 'trivial']);
  assertExit(only, 0);
  assert.ok(sectionsOf(only.stdout).has('trivial'), only.stdout);
  assert.equal(sectionsOf(only.stdout).has('builder-iq'), false, '--kinds trivial must not print builder-iq');
  assert.equal(probesOf(sb, 'probe').length, 0, 'an unselected kind ran a probe');
  assert.equal(resultOf(only.stdout, 'trivial', 't1'), 'pass', only.stdout);
  const both = await runBench(sb, ['--kinds', 'trivial,builder-iq']);
  assertExit(both, 0);
  assert.ok(sectionsOf(both.stdout).has('trivial'), both.stdout);
  assert.ok(sectionsOf(both.stdout).has('builder-iq'), both.stdout);
  assert.equal(probesOf(sb, 'probe').length, 1, 'the builder unit must run once when it is selected');
});

test('bench: --kinds with an unknown kind exits 2, names it and the known kinds, and runs nothing', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-pong': fixed(sb, 'say-pong', PONG), probe: probeRouter(sb, 'probe') },
    models: {
      t1: model([route('say-pong', 't1-id')]),
      b1: model([route('probe', 'b1-id')]),
    },
    kinds: { trivial: kind([{ model: 't1' }]), 'builder-iq': kind([{ model: 'b1' }]) },
  }));
  const r = await runBench(sb, ['--kinds', 'nope']);
  assert.equal(r.code, 2, `an unknown kind must exit 2:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /nope/, 'stderr must name the unknown kind');
  assert.match(r.stderr, /trivial/, 'stderr must name a known kind');
  assert.match(r.stderr, /builder-iq/, 'stderr must name a known kind');
  assert.equal(probesOf(sb).length, 0, 'an unknown kind started a child process');
  assert.doesNotMatch(r.stdout, / \| /, 'a usage error must print no table');
});

test('bench: invalid --repeat, --timeout, --kinds or --json values, unknown flags and missing values exit 2 and run nothing', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-pong': fixed(sb, 'say-pong', PONG) },
    models: { 'pong-m': model([route('say-pong', 'pong-id')]) },
    kinds: { trivial: kind([{ model: 'pong-m' }]) },
  }));
  const invalid = [
    ['--repeat', '0'],
    ['--repeat', '-1'],
    ['--repeat', 'abc'],
    ['--repeat', '1.5'],
    ['--repeat'],
    ['--timeout', 'abc'],
    ['--timeout', '0'],
    ['--timeout', '-1'],
    ['--timeout'],
    ['--kinds'],
    ['--json'],
    ['--bogus'],
  ];
  for (const args of invalid) {
    const r = await runBench(sb, args);
    assert.equal(r.code, 2, `"bench ${args.join(' ')}" should exit 2:\n${r.stdout}\n${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '', `"bench ${args.join(' ')}" should say what is wrong on stderr`);
    assert.doesNotMatch(r.stdout, / \| /, `"bench ${args.join(' ')}" should run nothing and print no table`);
  }
  assert.equal(probesOf(sb).length, 0, 'an invalid command line started a child process');
  assert.deepEqual(listTree(sb.btmp), [], 'an invalid command line left files in the temporary folder');
});

test('bench: an unreadable routing file exits 2 and runs nothing', async (t) => {
  const sb = sandbox(t);
  const missing = path.join(sb.root, 'no-such-folder', 'routing.json');
  const r = await runBench(sb, [], { env: { WORKER_ROUTING: missing } });
  assert.equal(r.code, 2, `an unreadable routing file must exit 2:\n${r.stdout}\n${r.stderr}`);
  assert.notEqual(r.stderr.trim(), '', 'the error must be explained on stderr');
  assert.equal(probesOf(sb).length, 0, 'a probe ran without a routing file');
  assert.doesNotMatch(r.stdout, / \| /, 'nothing may be run or printed as a table');
});

// ---------------------------------------------------------------- suggested order

test('bench: a failing pick (fail, timeout or error) moves to the end, and the other picks keep their order', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: {
      'say-nope': fixed(sb, 'say-nope', 'nope'),
      'say-pong': fixed(sb, 'say-pong', PONG),
      hang: cli(sb, 'hang', ['--sleep', '30', '--answer', PONG]),
      'say-boom': cli(sb, 'say-boom', ['--exit', '3']),
      openrouter: probeRouter(sb, 'openrouter'),
    },
    models: {
      'f-nope': model([route('say-nope', 'f-id')]),
      'p-pass': model([route('say-pong', 'p-id')]),
      'p-pass2': model([route('say-pong', 'p2-id')]),
      'u-paid': model([route('openrouter', 'vendor/paid')]),
      't-slow': model([route('hang', 't-id')]),
      'e-boom': model([route('say-boom', 'e-id')]),
    },
    kinds: {
      trivial: kind([
        { model: 'f-nope' },
        { model: 'p-pass' },
        { claude: 'reviewer' },
        { model: 't-slow' },
        { model: 'u-paid' },
        { model: 'e-boom' },
        { model: 'p-pass2' },
      ]),
    },
  }));
  const r = await runBench(sb, ['--timeout', '5']);
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 't-slow'), 'timeout', r.stdout);
  const section = sectionOf(r.stdout, 'trivial');
  assert.equal(
    section.suggested,
    'suggested trivial: p-pass > reviewer > u-paid > p-pass2 > f-nope > t-slow > e-boom',
    r.stdout,
  );
  assert.equal(section.moved, 'moved to end: f-nope, t-slow, e-boom', r.stdout);
});

test('bench: a pick with a passing route is not failing and stays in place', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-nope': fixed(sb, 'say-nope', 'nope'), 'say-pong': fixed(sb, 'say-pong', PONG) },
    models: {
      'f-only': model([route('say-nope', 'f-id')]),
      mixed: model([route('say-nope', 'mx-nope'), route('say-pong', 'mx-pong')]),
      'g-pass': model([route('say-pong', 'g-id')]),
    },
    kinds: { trivial: kind([{ model: 'f-only' }, { model: 'mixed' }, { model: 'g-pass' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  const section = sectionOf(r.stdout, 'trivial');
  assert.equal(section.suggested, 'suggested trivial: mixed > g-pass > f-only', r.stdout);
  assert.equal(section.moved, 'moved to end: f-only', r.stdout);
  assert.deepEqual(
    rowsOf(r.stdout, 'trivial', 'mixed').map((cells) => [cells[2], cells[3]]),
    [['say-nope', 'fail'], ['say-pong', 'pass']],
    r.stdout,
  );
});

test('bench: when nothing fails there is no moved line and the routing order is kept', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-pong': fixed(sb, 'say-pong', PONG), openrouter: probeRouter(sb, 'openrouter') },
    models: {
      p1: model([route('say-pong', 'p1-id')]),
      u1: model([route('openrouter', 'vendor/paid')]),
    },
    kinds: { trivial: kind([{ claude: 'reviewer' }, { model: 'p1' }, { model: 'u1' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  const section = sectionOf(r.stdout, 'trivial');
  assert.equal(section.suggested, 'suggested trivial: reviewer > p1 > u1', r.stdout);
  assert.equal(section.moved, null, r.stdout);
  assert.doesNotMatch(r.stdout, /moved to end/);
});

// ---------------------------------------------------------------- repeats

test('bench: --repeat 2 runs each unit twice and reports secs with one decimal', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { probe: probeRouter(sb, 'probe') },
    models: { rep: model([route('probe', 'rep-id')]) },
    kinds: { trivial: kind([{ model: 'rep' }]) },
  }));
  const r = await runBench(sb, ['--repeat', '2', '--json', sb.json]);
  assertExit(r, 0);
  assert.equal(probesOf(sb, 'probe').length, 2, '--repeat 2 must run the unit twice');
  const row = rowFor(readRows(sb), 'trivial', 'rep');
  assert.equal(row.result, 'pass');
  assert.equal(typeof row.secs, 'number');
  assert.ok(Math.abs(row.secs * 10 - Math.round(row.secs * 10)) < 1e-6, `secs ${row.secs} must have one decimal`);
});

test('bench: --repeat grades a unit that passes once and fails once as fail, never pass', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { flaky: cli(sb, 'flaky', ['--probe', '{briefFile}', '--alternate'], { fileAccess: false }) },
    models: { 'flaky-m': model([route('flaky', 'flaky-id')]) },
    kinds: { trivial: kind([{ model: 'flaky-m' }]) },
  }));
  const r = await runBench(sb, ['--repeat', '2']);
  assertExit(r, 0);
  assert.equal(probesOf(sb, 'flaky').length, 2, '--repeat 2 must run the unit twice');
  assert.equal(resultOf(r.stdout, 'trivial', 'flaky-m'), 'fail', r.stdout);
});

// ---------------------------------------------------------------- nonce

test('bench: BENCH_NONCE fixes the token every probe expects', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { 'say-pong': fixed(sb, 'say-pong', PONG), probe: probeRouter(sb, 'probe') },
    models: {
      'fixed-ok': model([route('say-pong', 'fixed-id')]),
      'probe-m': model([route('probe', 'probe-id')]),
    },
    kinds: { trivial: kind([{ model: 'fixed-ok' }, { model: 'probe-m' }]) },
  }));
  const r = await runBench(sb, [], { nonce: NONCE });
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'fixed-ok'), 'pass', r.stdout);
  assert.equal(resultOf(r.stdout, 'trivial', 'probe-m'), 'pass', r.stdout);
  const [call] = probesOf(sb, 'probe');
  assert.ok(
    Object.values(call.files).join('\n').includes(`Reply with exactly: ${PONG}`),
    'the reply brief must carry the fixed nonce',
  );
});

test('bench: without BENCH_NONCE each run draws a new 8-hex-digit nonce', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: { probe: probeRouter(sb, 'probe') },
    models: { 'probe-m': model([route('probe', 'probe-id')]) },
    kinds: { trivial: kind([{ model: 'probe-m' }]) },
  }));
  const first = await runBench(sb, [], { nonce: null });
  const second = await runBench(sb, [], { nonce: null });
  assertExit(first, 0);
  assertExit(second, 0);
  assert.equal(resultOf(first.stdout, 'trivial', 'probe-m'), 'pass', first.stdout);
  assert.equal(resultOf(second.stdout, 'trivial', 'probe-m'), 'pass', second.stdout);
  const nonces = probesOf(sb, 'probe').map((call) => {
    const match = /Reply with exactly: PONG-([0-9a-fA-F]+)/.exec(Object.values(call.files).join('\n'));
    return match ? match[1] : '';
  });
  assert.equal(nonces.length, 2, 'two runs must make two probes');
  for (const nonce of nonces) {
    assert.match(nonce, /^[0-9a-f]{8}$/i, `nonce "${nonce}" is not 8 hex digits`);
  }
  assert.notEqual(nonces[0], nonces[1], 'two runs without BENCH_NONCE must not share a nonce');
});

test('bench: the nonce is matched literally as data, so a regex-like near miss fails', async (t) => {
  const sb = sandbox(t);
  writeRouting(sb, routingDoc({
    routers: {
      'say-lit': fixed(sb, 'say-lit', 'PONG-a.b+c'),
      'say-near': fixed(sb, 'say-near', 'PONG-aXbbc'),
      probe: probeRouter(sb, 'probe'),
    },
    models: {
      lit: model([route('say-lit', 'lit-id')]),
      near: model([route('say-near', 'near-id')]),
      'probe-m': model([route('probe', 'probe-id')]),
    },
    kinds: { trivial: kind([{ model: 'lit' }, { model: 'near' }, { model: 'probe-m' }]) },
  }));
  const r = await runBench(sb, [], { nonce: 'a.b+c' });
  assertExit(r, 0);
  assert.equal(resultOf(r.stdout, 'trivial', 'lit'), 'pass', r.stdout);
  assert.equal(resultOf(r.stdout, 'trivial', 'near'), 'fail', r.stdout);
  assert.equal(resultOf(r.stdout, 'trivial', 'probe-m'), 'pass', r.stdout);
  const [call] = probesOf(sb, 'probe');
  assert.ok(
    Object.values(call.files).join('\n').includes('Reply with exactly: PONG-a.b+c'),
    'the brief must carry the nonce exactly as it was set',
  );
});

// ---------------------------------------------------------------- sequencing

test('bench: probes run one after another, never in parallel', async (t) => {
  const sb = sandbox(t);
  const hold = (n) => cli(sb, `hold-${n}`, ['--answer', PONG, '--hold', '300']);
  writeRouting(sb, routingDoc({
    routers: { 'hold-1': hold(1), 'hold-2': hold(2), 'hold-3': hold(3) },
    models: {
      h1: model([route('hold-1', 'h1-id')]),
      h2: model([route('hold-2', 'h2-id')]),
      h3: model([route('hold-3', 'h3-id')]),
    },
    kinds: { trivial: kind([{ model: 'h1' }, { model: 'h2' }, { model: 'h3' }]) },
  }));
  const r = await runBench(sb, []);
  assertExit(r, 0);
  for (const pick of ['h1', 'h2', 'h3']) {
    assert.equal(resultOf(r.stdout, 'trivial', pick), 'pass', r.stdout);
  }
  const events = journal(sb).filter((entry) => entry.event === 'start' || entry.event === 'end');
  assert.equal(events.filter((entry) => entry.event === 'start').length, 3, 'three probes must start');
  let open = 0;
  for (const entry of events) {
    open += entry.event === 'start' ? 1 : -1;
    assert.ok(open === 0 || open === 1, `probes overlapped in the journal: ${JSON.stringify(events)}`);
  }
  assert.equal(open, 0, 'every probe must end');
});
