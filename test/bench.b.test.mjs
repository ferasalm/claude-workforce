import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');
const BENCH = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'bench.mjs');

const RECORDER_SOURCE = `
import fs from 'node:fs';

const argv = process.argv.slice(2);
function option(name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

const logFile = option('--log');
const briefFile = option('--brief');
const answerMode = option('--answer') ?? 'auto';
const exitCode = Number(option('--exit') ?? '0');
const fakeSleep = Number(option('--fake-sleep') ?? '0');
const tag = option('--tag') ?? '';
const brief = fs.readFileSync(briefFile, 'utf8');

let previous = [];
try {
  previous = fs.readFileSync(logFile, 'utf8')
    .split(/\\r?\\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch {
  // The log has not been created yet.
}

function automaticAnswer(text) {
  const match = text.match(/\\b(?:PONG|ACC)-[A-Za-z0-9_-]+\\b/);
  return match ? match[0] : '52';
}

let answer = answerMode;
if (answerMode === 'auto') answer = automaticAnswer(brief);
if (answerMode === 'wrong') answer = 'no-token';
if (answerMode === 'flaky') {
  answer = previous.length === 0 ? automaticAnswer(brief) : 'no-token';
}

const record = {
  argv,
  briefFile,
  brief,
  answer,
  tag,
  pid: process.pid,
  ppid: process.ppid,
};
fs.appendFileSync(logFile, JSON.stringify(record) + '\\n', 'utf8');

console.log(answer);
if (fakeSleep > 0) {
  await new Promise((resolve) => setTimeout(resolve, fakeSleep * 1000));
}
process.exitCode = exitCode;
`;

function makeHarness(t, makeRouting, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  const cwd = path.join(root, 'cwd');
  const tempDir = path.join(root, 'tmp');
  const home = path.join(root, 'home');
  const slots = path.join(root, 'slots');
  for (const dir of [cwd, tempDir, home, slots]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const recorder = path.join(root, 'recorder.mjs');
  const logFile = path.join(root, 'recorder.jsonl');
  const routingFile = path.join(root, 'routing.json');
  fs.writeFileSync(recorder, RECORDER_SOURCE, 'utf8');

  const cli = ({
    answer = 'auto',
    exitCode = 0,
    fakeSleep = 0,
    tag = '',
  } = {}) => {
    const args = [
      recorder,
      '--log', logFile,
      '--brief', '{briefFile}',
      '--answer', String(answer),
      '--exit', String(exitCode),
    ];
    if (fakeSleep > 0) args.push('--fake-sleep', String(fakeSleep));
    if (tag) args.push('--tag', tag);
    return {
      type: 'cli',
      bin: [process.execPath],
      args,
      fileAccess: false,
    };
  };

  const routing = makeRouting({ cli });
  routing.claude_agents ??= {
    agent: { model: 'test-model', effort: 'low' },
  };
  fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2), 'utf8');

  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith('WORKER_') ||
      key === 'BENCH_NONCE' ||
      key === 'NODE_OPTIONS' ||
      /API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TMP: tempDir,
    TEMP: tempDir,
    TMPDIR: tempDir,
    WORKER_ROUTING: routingFile,
    WORKER_SLOT_DIR: slots,
    WORKER_SLOT_WAIT: '1',
  }, extraEnv);

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return { root, cwd, tempDir, home, slots, recorder, logFile, routingFile, env };
}

function runBench(harness, args = [], { timeoutMs = 8000 } = {}) {
  const result = spawnSync(process.execPath, [BENCH, ...args], {
    cwd: harness.cwd,
    env: harness.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ...result,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function records(harness) {
  if (!fs.existsSync(harness.logFile)) return [];
  return fs.readFileSync(harness.logFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clearRecords(harness) {
  fs.rmSync(harness.logFile, { force: true });
}

function kindSection(stdout, kind) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `== ${kind} ==`);
  assert.notEqual(start, -1, `missing table header for ${kind}:\n${stdout}`);
  let end = lines.findIndex((line, index) => index > start && /^== .* ==$/.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end);
}

function assertRow(stdout, kind, pick, router, result) {
  const line = kindSection(stdout, kind).find((candidate) => {
    const columns = candidate.split(' | ');
    return columns.length >= 5 && columns[0] === pick && columns[2] === router;
  });
  assert.ok(line, `missing row for ${kind}/${pick}/${router}:\n${stdout}`);
  const columns = line.split(' | ');
  assert.equal(columns.length, 5, `unexpected table row format: ${line}`);
  assert.equal(columns[3], result, `unexpected result in row: ${line}`);
  return { line, columns };
}

function sortedListing(dir) {
  return fs.readdirSync(dir).sort();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForPidExit(pid, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return !pidAlive(pid);
}

async function stopPid(pid) {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process may have exited between the check and the signal.
  }
  await waitForPidExit(pid, 1000);
}

test('bench: dry-run plans runnable units without starting a child', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: { local: cli() },
    models: { demo: { routes: [{ router: 'local', id: 'demo-id' }] } },
    kinds: { 'builder-iq': { picks: [{ model: 'demo' }] } },
  }));

  const result = runBench(h, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertRow(result.stdout, 'builder-iq', 'demo', 'local', 'planned');
  assert.deepEqual(records(h), []);
  assert.deepEqual(sortedListing(h.tempDir), []);
});

test('bench: pass, fail, error, and timeout results are graded', async (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: {
      pass: cli({ tag: 'pass' }),
      fail: cli({ answer: 'wrong', tag: 'fail' }),
      error: cli({ exitCode: 7, tag: 'error' }),
      timeout: cli({ fakeSleep: 30, tag: 'timeout' }),
    },
    models: {
      passModel: { routes: [{ router: 'pass', id: 'pass-id' }] },
      failModel: { routes: [{ router: 'fail', id: 'fail-id' }] },
      errorModel: { routes: [{ router: 'error', id: 'error-id' }] },
      timeoutModel: {
        routes: [{ router: 'timeout', id: 'timeout-id', timeoutSec: 30 }],
      },
    },
    kinds: {
      'builder-iq': {
        picks: [
          { model: 'passModel' },
          { model: 'failModel' },
          { model: 'errorModel' },
          { model: 'timeoutModel' },
        ],
      },
    },
  }));

  let result;
  let workerStopped = true;
  let recorderStopped = true;
  try {
    result = runBench(h, ['--timeout', '1'], { timeoutMs: 6000 });
  } finally {
    const record = records(h).find((item) => item.tag === 'timeout');
    if (record) {
      [recorderStopped, workerStopped] = await Promise.all([
        waitForPidExit(record.pid),
        waitForPidExit(record.ppid),
      ]);
      if (!recorderStopped) await stopPid(record.pid);
      if (!workerStopped) await stopPid(record.ppid);
    }
  }

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertRow(result.stdout, 'builder-iq', 'passModel', 'pass', 'pass');
  assertRow(result.stdout, 'builder-iq', 'failModel', 'fail', 'fail');
  assertRow(result.stdout, 'builder-iq', 'errorModel', 'error', 'error');
  assertRow(result.stdout, 'builder-iq', 'timeoutModel', 'timeout', 'timeout');
  assert.equal(records(h).length, 4);
  assert.equal(recorderStopped, true, 'timed-out recorder process was left running');
  assert.equal(workerStopped, true, 'timed-out worker process was left running');
});

test('bench: kind names select the reply, file, and code probes', (t) => {
  const cases = [
    { kind: 'trivial', alias: 'trivial', answer: 'auto' },
    { kind: 'trivial', alias: 'lowerPong', answer: 'pong-probe7' },
    { kind: 'scout-light', alias: 'scoutLight', answer: 'auto' },
    { kind: 'scout-light', alias: 'lowerAcc', answer: 'acc-probe7' },
    { kind: 'scout-deep', alias: 'scoutDeep', answer: 'auto' },
    { kind: 'builder-iq', alias: 'builderIq', answer: 'auto' },
    { kind: 'builder-iq', alias: 'embeddedDigits', answer: '152' },
    { kind: 'builder-eq', alias: 'builderEq', answer: 'auto' },
    { kind: 'builder-eq', alias: 'decimal', answer: '5.2' },
    { kind: 'test-writer', alias: 'testWriter', answer: 'auto' },
  ];

  const h = makeHarness(t, ({ cli }) => {
    const routers = {};
    const models = {};
    const kinds = {};
    for (const item of cases) {
      const router = `r-${item.alias}`;
      routers[router] = cli({ answer: item.answer, tag: item.alias });
      models[item.alias] = {
        routes: [{ router, id: `id-${item.alias}` }],
      };
      kinds[item.kind] ??= { picks: [] };
      kinds[item.kind].picks.push({ model: item.alias });
    }
    return { routers, models, kinds };
  }, { BENCH_NONCE: 'probe7' });

  const result = runBench(h, ['--timeout', '4']);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const [kind, alias] of [
    ['trivial', 'trivial'],
    ['scout-light', 'scoutLight'],
    ['scout-deep', 'scoutDeep'],
    ['builder-iq', 'builderIq'],
    ['builder-eq', 'builderEq'],
    ['test-writer', 'testWriter'],
  ]) {
    assertRow(result.stdout, kind, alias, `r-${alias}`, 'pass');
  }
  assertRow(result.stdout, 'trivial', 'lowerPong', 'r-lowerPong', 'fail');
  assertRow(result.stdout, 'scout-light', 'lowerAcc', 'r-lowerAcc', 'fail');
  assertRow(result.stdout, 'builder-iq', 'embeddedDigits', 'r-embeddedDigits', 'fail');
  assertRow(result.stdout, 'builder-eq', 'decimal', 'r-decimal', 'fail');

  const byTag = new Map(records(h).map((item) => [item.tag, item]));
  assert.equal(byTag.get('trivial').answer, 'PONG-probe7');
  assert.ok(byTag.get('trivial').brief.includes('Reply with exactly: PONG-probe7'));
  assert.equal(byTag.get('scoutLight').answer, 'ACC-probe7');
  assert.ok(byTag.get('scoutLight').brief.includes(
    'Read the attached file and reply with the access code only.',
  ));
  assert.ok(byTag.get('scoutLight').brief.includes('The access code is ACC-probe7.'));
  const briefArgIndex = byTag.get('scoutLight').argv.indexOf('--brief');
  assert.notEqual(briefArgIndex, -1, 'recorder did not receive a brief file argument');
  assert.equal(
    byTag.get('scoutLight').argv[briefArgIndex + 1],
    byTag.get('scoutLight').briefFile,
  );
  assert.equal(byTag.get('scoutDeep').answer, 'ACC-probe7');
  for (const tag of ['builderIq', 'builderEq', 'testWriter']) {
    assert.equal(byTag.get(tag).answer, '52');
    assert.ok(byTag.get(tag).brief.includes('function f(n) { return n * n + 3; }'));
    assert.ok(byTag.get(tag).brief.includes(
      'What does f(7) return? Reply with the number only.',
    ));
  }
});

test('bench: paid openrouter routes skip by default while free and included paid routes run', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: { openrouter: cli() },
    models: {
      paidModel: {
        routes: [{ router: 'openrouter', id: 'provider/model:paid' }],
      },
      freeModel: {
        routes: [{ router: 'openrouter', id: 'provider/model:free' }],
      },
    },
    kinds: {
      'builder-iq': {
        picks: [{ model: 'paidModel' }, { model: 'freeModel' }],
      },
    },
  }));

  const jsonFile = path.join(h.cwd, 'paid-results.json');
  const defaultRun = runBench(h, ['--timeout', '4', '--json', jsonFile]);
  assert.equal(defaultRun.status, 0, defaultRun.stderr || defaultRun.stdout);
  assertRow(defaultRun.stdout, 'builder-iq', 'paidModel', 'openrouter', 'skipped');
  assertRow(defaultRun.stdout, 'builder-iq', 'freeModel', 'openrouter', 'pass');
  assert.equal(records(h).length, 1);
  const paidRow = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    .find((row) => row.pick === 'paidModel');
  assert.equal(paidRow.note, 'paid');

  clearRecords(h);
  const includedRun = runBench(h, ['--timeout', '4', '--include-paid']);
  assert.equal(includedRun.status, 0, includedRun.stderr || includedRun.stdout);
  assertRow(includedRun.stdout, 'builder-iq', 'paidModel', 'openrouter', 'pass');
  assertRow(includedRun.stdout, 'builder-iq', 'freeModel', 'openrouter', 'pass');
  assert.equal(records(h).length, 2);
});

test('bench: Claude picks and Claude routes are skipped without starting a Claude process', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: {
      claudeRoute: { type: 'claude' },
      local: cli(),
    },
    models: {
      demo: {
        routes: [
          { router: 'claudeRoute', id: 'agent-model' },
          { router: 'local', id: 'local-id' },
        ],
      },
    },
    kinds: {
      trivial: {
        picks: [{ claude: 'agent' }, { model: 'demo' }],
      },
    },
  }));

  const result = runBench(h, ['--timeout', '4']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertRow(result.stdout, 'trivial', 'agent', '-', 'skipped');
  assertRow(result.stdout, 'trivial', 'demo', 'claudeRoute', 'skipped');
  assertRow(result.stdout, 'trivial', 'demo', 'local', 'pass');
  assert.equal(records(h).length, 1);
});

test('bench: a shared alias, router, and effort runs once across kinds', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: { local: cli() },
    models: {
      shared: {
        effort: 'low',
        routes: [{ router: 'local', id: 'shared-id' }],
      },
    },
    kinds: {
      first: { picks: [{ model: 'shared', effort: 'low' }] },
      second: { picks: [{ model: 'shared', effort: 'low' }] },
    },
  }));

  const result = runBench(h, ['--timeout', '4']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertRow(result.stdout, 'first', 'shared', 'local', 'pass');
  assertRow(result.stdout, 'second', 'shared', 'local', 'pass');
  assert.equal(records(h).length, 1);
});

test('bench: routing bytes stay unchanged and run files are cleaned up', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: { local: cli() },
    models: { demo: { routes: [{ router: 'local', id: 'demo-id' }] } },
    kinds: { 'builder-iq': { picks: [{ model: 'demo' }] } },
  }));

  const routingHashBefore = sha256(h.routingFile);
  const cwdBefore = sortedListing(h.cwd);
  const tempBefore = sortedListing(h.tempDir);
  const result = runBench(h, ['--timeout', '4']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertRow(result.stdout, 'builder-iq', 'demo', 'local', 'pass');
  assert.equal(sha256(h.routingFile), routingHashBefore);
  assert.deepEqual(sortedListing(h.cwd), cwdBefore);
  assert.deepEqual(sortedListing(h.tempDir), tempBefore);
});

test('bench: --json writes an array with the documented row keys and types', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: {
      claudeRoute: { type: 'claude' },
      local: cli(),
    },
    models: { demo: { routes: [{ router: 'local', id: 'local-id' }] } },
    kinds: {
      trivial: {
        picks: [{ claude: 'agent' }, { model: 'demo' }],
      },
    },
  }));

  const jsonFile = path.join(h.cwd, 'results.json');
  const result = runBench(h, ['--timeout', '4', '--json', jsonFile]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const rows = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 2);

  const expectedKeys = [
    'kind', 'pick', 'claude', 'router', 'id', 'effort',
    'result', 'secs', 'note',
  ].sort();

  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), expectedKeys);
    assert.equal(typeof row.kind, 'string');
    assert.equal(typeof row.pick, 'string');
    assert.equal(typeof row.claude, 'boolean');
    assert.ok(row.router === null || typeof row.router === 'string');
    assert.ok(row.id === null || typeof row.id === 'string');
    assert.ok(row.effort === null || typeof row.effort === 'string');
    assert.equal(typeof row.result, 'string');
    assert.ok(row.secs === null || typeof row.secs === 'number');
    assert.equal(typeof row.note, 'string');
  }

  const claudeRow = rows.find((row) => row.claude);
  assert.ok(claudeRow);
  assert.equal(claudeRow.kind, 'trivial');
  assert.equal(claudeRow.pick, 'agent');
  assert.equal(claudeRow.router, null);
  assert.equal(claudeRow.id, null);
  assert.equal(claudeRow.result, 'skipped');
  assert.equal(claudeRow.note, 'claude');
  assert.equal(claudeRow.secs, null);

  const modelRow = rows.find((row) => row.pick === 'demo');
  assert.ok(modelRow);
  assert.equal(modelRow.claude, false);
  assert.equal(modelRow.router, 'local');
  assert.equal(modelRow.id, 'local-id');
  assert.equal(modelRow.result, 'pass');
  assert.equal(typeof modelRow.secs, 'number');
});

test('bench: kind filtering and usage errors do not run workers', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: { local: cli() },
    models: {
      modelA: { routes: [{ router: 'local', id: 'a-id' }] },
      modelB: { routes: [{ router: 'local', id: 'b-id' }] },
    },
    kinds: {
      a: { picks: [{ model: 'modelA' }] },
      b: { picks: [{ model: 'modelB' }] },
    },
  }));

  const filtered = runBench(h, ['--kinds', 'a', '--timeout', '4']);
  assert.equal(filtered.status, 0, filtered.stderr || filtered.stdout);
  assert.match(filtered.stdout, /^== a ==$/m);
  assert.doesNotMatch(filtered.stdout, /^== b ==$/m);
  assert.equal(records(h).length, 1);

  clearRecords(h);
  const unknownKind = runBench(h, ['--kinds', 'nope']);
  assert.equal(unknownKind.status, 2, unknownKind.stderr || unknownKind.stdout);
  assert.match(`${unknownKind.stderr}\n${unknownKind.stdout}`, /nope/);
  assert.ok(
    `${unknownKind.stderr}\n${unknownKind.stdout}`.includes('a') &&
    `${unknownKind.stderr}\n${unknownKind.stdout}`.includes('b'),
    'unknown-kind error did not name the known kinds',
  );
  assert.deepEqual(records(h), []);

  const originalRouting = h.env.WORKER_ROUTING;
  h.env.WORKER_ROUTING = path.join(h.root, 'missing-routing.json');
  const unreadableRouting = runBench(h, []);
  h.env.WORKER_ROUTING = originalRouting;
  assert.equal(unreadableRouting.status, 2, unreadableRouting.stderr || unreadableRouting.stdout);
  assert.deepEqual(records(h), []);

  for (const args of [
    ['--repeat', '0'],
    ['--timeout', 'abc'],
    ['--unknown-flag'],
    ['--kinds'],
    ['--repeat'],
  ]) {
    const invalid = runBench(h, args);
    assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout);
    assert.deepEqual(records(h), []);
  }
});

test('bench: only failing picks move to the end of the suggested order', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: {
      failing: cli({ answer: 'wrong' }),
      passing: cli(),
      openrouter: cli(),
    },
    models: {
      bad: { routes: [{ router: 'failing', id: 'bad-id' }] },
      unknown: { routes: [] },
      good: { routes: [{ router: 'passing', id: 'good-id' }] },
      paid: {
        routes: [{ router: 'openrouter', id: 'provider/model:paid' }],
      },
    },
    kinds: {
      'builder-eq': {
        picks: [
          { model: 'bad' },
          { model: 'unknown' },
          { model: 'good' },
          { model: 'paid' },
          { claude: 'helper' },
        ],
      },
    },
  }));

  const result = runBench(h, ['--timeout', '4']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertRow(result.stdout, 'builder-eq', 'bad', 'failing', 'fail');
  assertRow(result.stdout, 'builder-eq', 'good', 'passing', 'pass');
  assertRow(result.stdout, 'builder-eq', 'paid', 'openrouter', 'skipped');
  assertRow(result.stdout, 'builder-eq', 'helper', '-', 'skipped');
  assert.match(
    result.stdout,
    /^suggested builder-eq: unknown > good > paid > helper > bad$/m,
  );
  assert.match(result.stdout, /^moved to end: bad$/m);
});

test('bench: repeat runs each unit twice and reports a flaky unit as failing', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: { flaky: cli({ answer: 'flaky', tag: 'flaky' }) },
    models: { model: { routes: [{ router: 'flaky', id: 'flaky-id' }] } },
    kinds: { 'builder-iq': { picks: [{ model: 'model' }] } },
  }));

  const result = runBench(h, ['--repeat', '2', '--timeout', '4']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const row = assertRow(result.stdout, 'builder-iq', 'model', 'flaky', 'fail');
  assert.match(row.columns[4], /^\d+\.\d+s$/);
  assert.equal(records(h).length, 2);
});

test('bench: fixed nonce is honored and generated nonces differ across runs', (t) => {
  const h = makeHarness(t, ({ cli }) => ({
    routers: { local: cli({ tag: 'trivial' }) },
    models: { model: { routes: [{ router: 'local', id: 'local-id' }] } },
    kinds: { trivial: { picks: [{ model: 'model' }] } },
  }), { BENCH_NONCE: 'fixed-42' });

  const fixed = runBench(h, ['--timeout', '4']);
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
  assertRow(fixed.stdout, 'trivial', 'model', 'local', 'pass');
  assert.equal(records(h)[0].answer, 'PONG-fixed-42');
  assert.ok(records(h)[0].brief.includes('Reply with exactly: PONG-fixed-42'));

  delete h.env.BENCH_NONCE;
  clearRecords(h);

  const first = runBench(h, ['--timeout', '4']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = runBench(h, ['--timeout', '4']);
  assert.equal(second.status, 0, second.stderr || second.stdout);

  const generated = records(h).map((record) => {
    const match = record.brief.match(/\bPONG-([0-9a-f]{8})\b/);
    assert.ok(match, `missing generated nonce in recorder prompt: ${record.brief}`);
    return match[1];
  });
  assert.equal(generated.length, 2);
  assert.notEqual(generated[0], generated[1]);
});
