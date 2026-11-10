import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORKER = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'worker.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'fake-cli.mjs');
const V1_ROUTING = path.join(ROOT, 'test', 'fixtures', 'routing-v1.json');

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cli-'));
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const SLOT_DIR = path.join(TEMP_ROOT, 'slots');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(SLOT_DIR, { recursive: true });

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

const DROPPED_KEYS = new Set([
  'OPENROUTER_API_KEY',
  'NVIDIA_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CODEX_BIN',
  'AGY_BIN',
  'OPENCODE_BIN',
  'HERMES',
]);

function baseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^WORKER_/i.test(key)) continue;
    if (DROPPED_KEYS.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  env.HOME = HOME_DIR;
  env.USERPROFILE = HOME_DIR;
  env.WORKER_SLOT_DIR = SLOT_DIR;
  return env;
}

function runWorker(args, overrides = {}) {
  return spawnSync(process.execPath, [WORKER, ...args], {
    cwd: overrides.cwd ?? TEMP_ROOT,
    env: { ...baseEnv(), ...(overrides.env ?? {}) },
    encoding: 'utf8',
    timeout: overrides.timeout ?? 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function runWorkerAsync(args, overrides = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [WORKER, ...args], {
      cwd: overrides.cwd ?? TEMP_ROOT,
      env: { ...baseEnv(), ...(overrides.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({
        status: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        elapsedMs: Date.now() - started,
      });
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

function output(result) {
  const chunks = [];
  if (result.stdout) chunks.push(String(result.stdout));
  if (result.stderr) chunks.push(String(result.stderr));
  if (result.error) chunks.push(String(result.error.message ?? result.error));
  return chunks.join('\n');
}

function newCaseDir(label) {
  return fs.mkdtempSync(path.join(TEMP_ROOT, `case-${label}-`));
}

function writeFile(file, text) {
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function routingWith(routerName, router, options = {}) {
  const {
    id = 'codex-model-id',
    model = {},
    kind = {},
    extraRouters = {},
    extraModels = {},
  } = options;
  return {
    version: 2,
    routers: { ...extraRouters, [routerName]: router },
    models: {
      'codex-model': {
        family: 'test',
        routes: [{ router: routerName, id }],
        ...model,
      },
      ...extraModels,
    },
    claude_agents: {},
    kinds: {
      'test-kind': {
        tier: '2',
        use_when: 'test',
        picks: [{ model: 'codex-model' }],
        ...kind,
      },
      'write-kind': {
        tier: '2',
        use_when: 'test',
        write: true,
        picks: [{ model: 'codex-model' }],
      },
    },
  };
}

function cliRouter(overrides = {}) {
  const { args = [], ...rest } = overrides;
  return {
    type: 'cli',
    bin: [process.execPath],
    args: [FIXTURE, ...args],
    ...rest,
  };
}

function gitWorkTree(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n', 'utf8');
  git('add', '.');
  git('commit', '-m', 'init');
}
function setup(label, routing, options = {}) {
  const dir = newCaseDir(label);
  const routingPath = path.join(dir, 'routing.json');
  fs.writeFileSync(routingPath, JSON.stringify(routing, null, 2), 'utf8');
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  gitWorkTree(workDir);
  const brief = writeFile(path.join(dir, 'brief.md'), options.briefText ?? 'BRIEF-TEXT-MARKER');
  return { dir, routingPath, workDir, brief, env: { WORKER_ROUTING: routingPath } };
}

function runIn(caseDir, extra = [], extraEnv = {}) {
  return runWorker(
    ['run', extra.includes('--write') ? 'write-kind' : 'test-kind', caseDir.brief, '--no-claude', '--dir', caseDir.workDir, ...extra],
    { env: { ...caseDir.env, ...extraEnv } },
  );
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `expected ${flag} in ${JSON.stringify(args)}`);
  assert.ok(index + 1 < args.length, `expected a value after ${flag}`);
  return args[index + 1];
}

function fakeReport(result) {
  const line = String(result.stdout ?? '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('FAKE-REPORT '));
  assert.ok(line, `expected a FAKE-REPORT line in output:\n${output(result)}`);
  return JSON.parse(line.slice('FAKE-REPORT '.length));
}

function isInsideTemp(target) {
  const base = path.resolve(os.tmpdir()).toLowerCase();
  const value = path.resolve(target).toLowerCase();
  return value === base || value.startsWith(base + path.sep);
}

function samePath(left, right) {
  const normalise = (value) => {
    try {
      return fs.realpathSync.native(value).toLowerCase();
    } catch {
      return path.resolve(value).toLowerCase();
    }
  };
  return normalise(left) === normalise(right);
}

/* R1 ------------------------------------------------------------------ */

test('R1: route shows the cli router name and route id', () => {
  const s = setup('r1-route', routingWith('codex', cliRouter({ args: ['--fake-stdout', 'HELLO'] })));
  const res = runWorker(['route'], { env: s.env });
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.match(out, /codex/);
  assert.match(out, /codex-model-id/);
  assert.doesNotMatch(out, /unknown router type/i);
});

test('R1: run --dry-run shows the cli router name and route id', () => {
  const s = setup('r1-dry-run', routingWith('codex', cliRouter({ args: ['--fake-stdout', 'HELLO'] })));
  const res = runWorker(
    ['run', 'test-kind', s.brief, '--dry-run', '--no-claude', '--dir', s.workDir],
    { env: s.env },
  );
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.match(out, /codex/);
  assert.match(out, /codex-model-id/);
  assert.doesNotMatch(out, /unknown router type/i);
});

test('R1: doctor accepts a cli router without calling it unknown', () => {
  const s = setup('r1-doctor', routingWith('codex', cliRouter({ args: ['--fake-stdout', 'HELLO'] })));
  const res = runWorker(['doctor'], { env: s.env });
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.match(out, /codex/);
  assert.doesNotMatch(out, /unknown router type/i);
});

test('R1: run executes a cli route and shows the router and route id', () => {
  const s = setup('r1-run', routingWith('codex', cliRouter({ args: ['--fake-stdout', 'RUN-ANSWER'] })));
  const res = runIn(s);
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.match(String(res.stdout), /RUN-ANSWER/);
  assert.match(out, /codex/);
  assert.match(out, /codex-model-id/);
  assert.doesNotMatch(out, /unknown router type/i);
});

test('R1: ask executes a cli route', () => {
  const s = setup('r1-ask', routingWith('codex', cliRouter({ args: ['--fake-stdout', 'ASK-ANSWER'] })));
  const res = runWorker(
    ['ask', 'codex-model', s.brief, '--router', 'codex', '--dir', s.workDir],
    { env: s.env },
  );
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.match(String(res.stdout), /ASK-ANSWER/);
  assert.match(out, /codex/);
  assert.doesNotMatch(out, /unknown router type/i);
});

/* R2 ------------------------------------------------------------------ */

test('R2: binEnv names the only candidate when it is set and non-empty', () => {
  const s = setup('r2-binenv', routingWith('codex', {
    type: 'cli',
    bin: ['cw-cli-missing-bin'],
    binEnv: 'CW_CLI_TEST_BIN',
    args: [FIXTURE, '--fake-stdout', 'BINENV-ANSWER'],
  }));
  const res = runIn(s, [], { CW_CLI_TEST_BIN: process.execPath });
  assert.equal(res.status, 0, output(res));
  assert.match(String(res.stdout), /BINENV-ANSWER/);
});

test('R2: a binEnv path is used even when it is unavailable, with no fallback to bin', () => {
  const s = setup('r2-binenv-missing', routingWith('codex', {
    type: 'cli',
    bin: [process.execPath],
    binEnv: 'CW_CLI_TEST_BIN',
    args: [FIXTURE, '--fake-stdout', 'SHOULD-NOT-RUN'],
  }));
  const ghost = path.join(s.dir, 'missing-bin.exe');
  const res = runIn(s, [], { CW_CLI_TEST_BIN: ghost });
  const out = output(res);
  assert.ok(out.includes('not installed'), out);
  assert.ok(out.includes('missing-bin'), out);
  assert.ok(!out.includes('SHOULD-NOT-RUN'), out);
});

test('R2: bin accepts a string or an ordered array of candidates', () => {
  const asString = setup('r2-string', routingWith('codex', {
    type: 'cli',
    bin: process.execPath,
    args: [FIXTURE, '--fake-stdout', 'STRING-BIN-ANSWER'],
  }));
  const first = runIn(asString);
  assert.equal(first.status, 0, output(first));
  assert.match(String(first.stdout), /STRING-BIN-ANSWER/);

  const asArray = setup('r2-array', routingWith('codex', {
    type: 'cli',
    bin: ['cw-cli-missing-entry', process.execPath],
    args: [FIXTURE, '--fake-stdout', 'ARRAY-ANSWER'],
  }));
  const second = runIn(asArray);
  assert.equal(second.status, 0, output(second));
  assert.match(String(second.stdout), /ARRAY-ANSWER/);
});

test('R2: ${NAME} inside a bin entry is replaced from the environment', () => {
  const s = setup('r2-env', routingWith('codex', {
    type: 'cli',
    bin: ['${CW_CLI_TEST_NODE}'],
    args: [FIXTURE, '--fake-stdout', 'ENV-BIN-ANSWER'],
  }));
  const res = runIn(s, [], { CW_CLI_TEST_NODE: process.execPath });
  assert.equal(res.status, 0, output(res));
  assert.match(String(res.stdout), /ENV-BIN-ANSWER/);
});

test('R2: a bin entry naming an unset variable is skipped', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const missing = '${CW_CLI_UNSET_' + suffix + '}';
  const s = setup('r2-skip', routingWith('codex', {
    type: 'cli',
    bin: [missing, process.execPath],
    args: [FIXTURE, '--fake-stdout', 'SKIP-ANSWER'],
  }));
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  assert.match(String(res.stdout), /SKIP-ANSWER/);
});

/* R3 ------------------------------------------------------------------ */

test('R3: a .cmd node shim runs process.execPath with the script path', { skip: process.platform !== 'win32' }, () => {
  const shimDir = newCaseDir('r3-shim');
  const packageBin = path.join(shimDir, 'node_modules', '@scope', 'pkg', 'bin');
  fs.mkdirSync(packageBin, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(packageBin, 'tool.js'));
  const shim = path.join(shimDir, 'tool.cmd');
  fs.writeFileSync(
    shim,
    [
      '@ECHO off',
      'SET dp0=%~dp0',
      '"%dp0%\\node_modules\\@scope\\pkg\\bin\\tool.js" %*',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const s = setup('r3', routingWith('codex', {
    type: 'cli',
    bin: [shim],
    args: ['--fake-stdout', 'SHIM-ANSWER'],
  }));
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  assert.match(String(res.stdout), /SHIM-ANSWER/);
});

/* R4 ------------------------------------------------------------------ */

test('R4: an unavailable cli router is skipped with the candidate names', () => {
  const s = setup('r4-missing', routingWith('codex', {
    type: 'cli',
    bin: ['cw-cli-missing-a', 'cw-cli-missing-b'],
    args: [FIXTURE, '--fake-stdout', 'SHOULD-NOT-RUN'],
  }));
  const res = runIn(s);
  const out = output(res);
  assert.ok(out.includes('not installed (cw-cli-missing-a or cw-cli-missing-b)'), out);
  assert.ok(!out.includes('FAKE-REPORT'), out);
});

test('R4: doctor reports an installed cli router as READY', () => {
  const s = setup('r4-ready', routingWith('codex', cliRouter({ args: ['--fake-stdout', 'HELLO'] })));
  const res = runWorker(['doctor'], { env: s.env });
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.match(out, /router codex: READY/);
});

test('R4: doctor reports an unavailable cli router as NOT INSTALLED', () => {
  const s = setup('r4-not-installed', routingWith('codex', {
    type: 'cli',
    bin: ['cw-cli-missing-tool'],
    args: [FIXTURE],
  }));
  const res = runWorker(['doctor'], { env: s.env });
  const out = output(res);
  assert.match(out, /router codex: NOT INSTALLED/);
  assert.ok(out.includes('cw-cli-missing-tool'), out);
});

test('R4: WORKER_FAKE_CLI answers for an unavailable cli router but not in doctor', () => {
  const s = setup('r4-fake-cli', routingWith('codex', {
    type: 'cli',
    bin: ['cw-cli-missing-tool'],
    args: [FIXTURE, '--fake-stdout', 'REAL-PROGRAM-RAN'],
  }));
  const fake = writeFile(path.join(s.dir, 'worker-fake-cli.txt'), 'ANSWER-FROM-WORKER-FAKE-CLI');

  const res = runIn(s, [], { WORKER_FAKE_CLI: fake });
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.match(String(res.stdout), /ANSWER-FROM-WORKER-FAKE-CLI/);
  assert.ok(!out.includes('REAL-PROGRAM-RAN'), out);

  const doctor = runWorker(['doctor'], { env: { ...s.env, WORKER_FAKE_CLI: fake } });
  assert.match(output(doctor), /router codex: NOT INSTALLED/);
});

/* R5 ------------------------------------------------------------------ */

test('R5: a read run uses args and a write run uses writeArgs', () => {
  const s = setup('r5-args', routingWith('codex', {
    type: 'cli',
    bin: [process.execPath],
    args: [FIXTURE, '--fake-stdout', 'READ-ARGS'],
    writeArgs: [FIXTURE, '--fake-write', 'changed.txt', '--fake-stdout', 'WRITE-ARGS'],
  }));

  const read = runIn(s);
  assert.equal(read.status, 0, output(read));
  assert.match(String(read.stdout), /READ-ARGS/);
  assert.ok(!String(read.stdout).includes('WRITE-ARGS'), output(read));
  assert.equal(fs.existsSync(path.join(s.workDir, 'changed.txt')), false);

  const write = runIn(s, ['--write']);
  assert.equal(write.status, 0, output(write));
  assert.match(String(write.stdout), /WRITE-ARGS/);
  assert.equal(fs.existsSync(path.join(s.workDir, 'changed.txt')), true);
});

test('R5: a write run skips a cli router that has no writeArgs', () => {
  const s = setup('r5-no-write-args', routingWith('codex', {
    type: 'cli',
    bin: [process.execPath],
    args: [FIXTURE, '--fake-stdout', 'READ-ONLY-RAN'],
  }));
  const res = runIn(s, ['--write']);
  const out = output(res);
  assert.ok(out.includes('[worker] skip codex: read-only router (no writeArgs)'), out);
  assert.ok(!out.includes('READ-ONLY-RAN'), out);
  assert.ok(!out.includes('FAKE-REPORT'), out);
});

/* R6 ------------------------------------------------------------------ */

test('R6: placeholders are replaced in every element of the chosen array', () => {
  const s = setup('r6-placeholders', routingWith('codex', cliRouter({
    args: [
      '--fake-out-text', 'ANSWER-FROM-OUT',
      '--prompt', '{brief}',
      '--brief-file', '{briefFile}',
      '--id', '{id}',
      '--effort-value', '{effort}',
      '--dir-value', '{dir}',
      '--braces', '{notAPlaceholder}',
      '-o', '{out}',
    ],
    defaultEffort: 'high',
  })));

  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  assert.match(String(res.stdout), /ANSWER-FROM-OUT/);

  const report = fakeReport(res);
  assert.equal(valueAfter(report.args, '--id'), 'codex-model-id');
  assert.equal(valueAfter(report.args, '--effort-value'), 'high');
  assert.equal(valueAfter(report.args, '--braces'), '{notAPlaceholder}');
  assert.ok(samePath(valueAfter(report.args, '--dir-value'), s.workDir), valueAfter(report.args, '--dir-value'));
  assert.ok(valueAfter(report.args, '--prompt').includes('BRIEF-TEXT-MARKER'));
  assert.ok(samePath(report.cwd, s.workDir), `child cwd was ${report.cwd}`);

  const briefFile = valueAfter(report.args, '--brief-file');
  const outFile = valueAfter(report.args, '-o');
  assert.ok(path.isAbsolute(briefFile), briefFile);
  assert.ok(path.isAbsolute(outFile), outFile);
  assert.ok(isInsideTemp(briefFile), briefFile);
  assert.ok(isInsideTemp(outFile), outFile);
  assert.notEqual(briefFile, outFile);
  assert.ok((report.files[briefFile] ?? '').includes('BRIEF-TEXT-MARKER'), 'brief file holds the prompt');
  assert.equal(fs.existsSync(briefFile), false, `brief file left behind: ${briefFile}`);
  assert.equal(fs.existsSync(outFile), false, `out file left behind: ${outFile}`);
});

test('R6: ask --effort overrides the router defaultEffort', () => {
  const s = setup('r6-effort', routingWith('codex', cliRouter({
    args: ['--effort-value', '{effort}'],
    defaultEffort: 'low',
  })));
  const res = runWorker(
    ['ask', 'codex-model', s.brief, '--router', 'codex', '--effort', 'high', '--dir', s.workDir],
    { env: s.env },
  );
  assert.equal(res.status, 0, output(res));
  const report = fakeReport(res);
  assert.equal(valueAfter(report.args, '--effort-value'), 'high');
});

test('R6: the effort falls back to medium', () => {
  const s = setup('r6-medium', routingWith('codex', cliRouter({ args: ['--effort-value', '{effort}'] })));
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  const report = fakeReport(res);
  assert.equal(valueAfter(report.args, '--effort-value'), 'medium');
});

test('R6: temporary files are removed after a failed attempt', () => {
  const s = setup('r6-cleanup', routingWith('codex', cliRouter({
    args: ['--brief-file', '{briefFile}', '-o', '{out}', '--fake-exit', '3'],
  })));
  const res = runIn(s);
  assert.notEqual(res.status, 0, output(res));
  const report = fakeReport(res);
  const briefFile = valueAfter(report.args, '--brief-file');
  const outFile = valueAfter(report.args, '-o');
  assert.equal(fs.existsSync(briefFile), false, `brief file left behind: ${briefFile}`);
  assert.equal(fs.existsSync(outFile), false, `out file left behind: ${outFile}`);
});

/* R7 ------------------------------------------------------------------ */

test('R7: stdin true writes the full prompt to the child standard input', () => {
  const s = setup('r7-stdin', routingWith('codex', cliRouter({ stdin: true })), {
    briefText: 'STDIN-PROMPT-MARKER',
  });
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  const report = fakeReport(res);
  assert.match(report.stdin, /STDIN-PROMPT-MARKER/);
});

test('R7: without stdin the child standard input is closed at once', () => {
  const s = setup('r7-closed-stdin', routingWith('codex', cliRouter({ args: [] })));
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  const report = fakeReport(res);
  assert.equal(report.stdin, '');
});

/* R8 ------------------------------------------------------------------ */

test('R8: a non-empty {out} file is the answer', () => {
  const s = setup('r8-out', routingWith('codex', cliRouter({
    args: ['--fake-out-text', 'OUT-FILE-ANSWER', '-o', '{out}'],
  })));
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  assert.match(String(res.stdout), /OUT-FILE-ANSWER/);
  assert.ok(!String(res.stdout).includes('FAKE-REPORT'), output(res));
});

test('R8: captured standard output is the answer without a usable {out} file', () => {
  const noOut = setup('r8-stdout', routingWith('codex', cliRouter({ args: [] })));
  const first = runIn(noOut);
  assert.equal(first.status, 0, output(first));
  assert.match(String(first.stdout), /FAKE-REPORT/);

  const emptyOut = setup('r8-empty-out', routingWith('codex', cliRouter({
    args: ['--fake-out-text', '', '-o', '{out}'],
  })));
  const second = runIn(emptyOut);
  assert.equal(second.status, 0, output(second));
  assert.match(String(second.stdout), /FAKE-REPORT/);
});

test('R8: strip patterns are removed from the answer', () => {
  const s = setup('r8-strip', routingWith('codex', cliRouter({
    args: ['--fake-session', 'SESS-42'],
    strip: ['^session_id: .*$'],
  })));
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  const out = String(res.stdout);
  assert.match(out, /FAKE-REPORT/);
  assert.ok(!out.includes('session_id:'), out);
});

test('R8: an invalid strip pattern is a configuration error naming the router', () => {
  const s = setup('r8-bad-strip', routingWith('codex', cliRouter({
    args: [],
    strip: ['(unclosed'],
  })));
  const res = runIn(s);
  const out = output(res);
  assert.equal(res.status, 2, out);
  assert.match(out, /codex/);
});

/* R9 ------------------------------------------------------------------ */

test('R9: a non-zero exit code fails the route with the code and output tail', () => {
  const s = setup('r9-exit', routingWith('codex', cliRouter({
    args: ['--fake-stdout', 'FAIL-TAIL-TEXT', '--fake-exit', '7'],
  })));
  const res = runIn(s);
  const out = output(res);
  assert.notEqual(res.status, 0, out);
  assert.match(out, /exit 7/);
  assert.ok(out.includes('FAIL-TAIL-TEXT'), out);
});

test('R9: a route timeoutSec kills the program', () => {
  const s = setup('r9-timeout-sec', routingWith('codex', cliRouter({
    args: ['--fake-sleep', '5', '--fake-stdout', 'TOO-LATE'],
    timeoutSec: 1,
  })));
  const res = runIn(s);
  const out = output(res);
  assert.notEqual(res.status, 0, out);
  assert.match(out, /timed out after 1s/);
});

test('R9: --timeout kills the program', () => {
  const s = setup('r9-timeout-flag', routingWith('codex', cliRouter({
    args: ['--fake-sleep', '5', '--fake-stdout', 'TOO-LATE'],
  })));
  const res = runIn(s, ['--timeout', '1']);
  const out = output(res);
  assert.notEqual(res.status, 0, out);
  assert.match(out, /timed out after 1s/);
});

/* R10 ----------------------------------------------------------------- */

async function runPair(caseDir) {
  const started = Date.now();
  const results = await Promise.all([
    runWorkerAsync(
      ['run', 'test-kind', caseDir.brief, '--no-claude', '--dir', caseDir.workDir],
      { env: caseDir.env },
    ),
    runWorkerAsync(
      ['run', 'test-kind', caseDir.brief, '--no-claude', '--dir', caseDir.workDir],
      { env: caseDir.env },
    ),
  ]);
  return { elapsedMs: Date.now() - started, results };
}

test('R10: one slot queues runs through the same cli router', async () => {
  const s = setup('r10-one-slot', routingWith('codex', cliRouter({
    args: ['--fake-sleep', '2', '--fake-stdout', 'SLOT-DONE'],
    slots: 1,
  })));
  const { elapsedMs, results } = await runPair(s);
  for (const result of results) {
    assert.equal(result.status, 0, output(result));
  }
  assert.ok(elapsedMs >= 3800, `two runs with one slot took ${elapsedMs}ms`);
});

test('R10: two slots run two cli routes concurrently', async () => {
  const s = setup('r10-two-slots', routingWith('codex', cliRouter({
    args: ['--fake-sleep', '2', '--fake-stdout', 'SLOT-DONE'],
    slots: 2,
  })));
  const { elapsedMs, results } = await runPair(s);
  for (const result of results) {
    assert.equal(result.status, 0, output(result));
  }
  assert.ok(elapsedMs < 3800, `two runs with two slots took ${elapsedMs}ms`);
});

test('R10: a slots value that is not an integer of at least 1 is a configuration error', () => {
  const values = [0, 1.5, '2'];
  values.forEach((slots, index) => {
    const s = setup(`r10-bad-slots-${index}`, routingWith('codex', cliRouter({
      args: ['--fake-stdout', 'SHOULD-NOT-RUN'],
      slots,
    })));
    const res = runIn(s);
    const out = output(res);
    assert.equal(res.status, 2, `slots=${JSON.stringify(slots)}: ${out}`);
    assert.match(out, /codex/);
  });
});

/* R11 ----------------------------------------------------------------- */

test('R11: fileAccess false packs --files into the prompt text', () => {
  const s = setup('r11-pack', routingWith('codex', cliRouter({
    args: ['--prompt-text', '{brief}'],
    fileAccess: false,
  })));
  const extra = writeFile(path.join(s.dir, 'extra.txt'), 'PACKED-FILE-MARKER-R11');
  const res = runIn(s, ['--files', extra]);
  assert.equal(res.status, 0, output(res));
  const report = fakeReport(res);
  assert.ok(
    valueAfter(report.args, '--prompt-text').includes('PACKED-FILE-MARKER-R11'),
    valueAfter(report.args, '--prompt-text'),
  );
});

test('R11: with default file access the prompt does not pack --files', () => {
  const s = setup('r11-no-pack', routingWith('codex', cliRouter({
    args: ['--prompt-text', '{brief}'],
  })));
  const extra = writeFile(path.join(s.dir, 'extra.txt'), 'PACKED-FILE-MARKER-R11');
  const res = runIn(s, ['--files', extra]);
  assert.equal(res.status, 0, output(res));
  const report = fakeReport(res);
  assert.ok(!valueAfter(report.args, '--prompt-text').includes('PACKED-FILE-MARKER-R11'));
});

test('R11: a write run skips a cli router without file access', () => {
  const s = setup('r11-write', routingWith('codex', cliRouter({
    args: ['--fake-stdout', 'READ-ANSWER'],
    writeArgs: [FIXTURE, '--fake-write', 'change.txt', '--fake-stdout', 'SHOULD-NOT-RUN'],
    fileAccess: false,
  })));
  const res = runIn(s, ['--write']);
  const out = output(res);
  assert.ok(out.includes('[worker] skip codex: no file access'), out);
  assert.ok(!out.includes('SHOULD-NOT-RUN'), out);
  assert.ok(!out.includes('FAKE-REPORT'), out);
});

/* R12 ----------------------------------------------------------------- */

test('R12: arguments with shell metacharacters reach the program unchanged', () => {
  const literal = 'a & b | c; "x" $HOME';
  const redirect = '> SHOULD-NOT-EXIST.txt';
  const s = setup('r12-no-shell', routingWith('codex', cliRouter({
    args: ['--literal', literal, '--redirect', redirect],
  })));
  const res = runIn(s);
  assert.equal(res.status, 0, output(res));
  const report = fakeReport(res);
  assert.equal(valueAfter(report.args, '--literal'), literal);
  assert.equal(valueAfter(report.args, '--redirect'), redirect);
  assert.equal(fs.existsSync(path.join(s.workDir, 'SHOULD-NOT-EXIST.txt')), false);
});

/* R13 ----------------------------------------------------------------- */

test('R13: a routing file with a cli router and a v1 routing file both still load', () => {
  const s = setup('r13-load', routingWith(
    'codex',
    cliRouter({ args: ['--fake-stdout', 'HELLO'] }),
    { extraRouters: { legacy: 'legacy router description only' } },
  ));
  const res = runWorker(['doctor'], { env: s.env });
  const out = output(res);
  assert.equal(res.status, 0, out);
  assert.doesNotMatch(out, /unknown router type/i);

  assert.ok(fs.existsSync(V1_ROUTING), `${V1_ROUTING} should exist`);
  const v1 = runWorker(['doctor'], { env: { WORKER_ROUTING: V1_ROUTING } });
  assert.equal(v1.status, 0, output(v1));
});

/* Additions from writer B: tests that cover a requirement writer A does not. */
{
// Black-box tests for the `cli` router type of the lean-orchestrator worker.

// Written from the specification only. Every test runs worker.mjs as a child process

// with its own routing file, the fixed fake program (fake-cli.mjs) and temporary folders.


const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(TEST_DIR, '..');

const WORKER = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'worker.mjs');

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'fake-cli.mjs');

const ROUTING_V1 = path.join(ROOT, 'test', 'fixtures', 'routing-v1.json');


const SCRUBBED_NAMES = new Set([
  'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
  'CODEX_BIN', 'AGY_BIN', 'OPENCODE_BIN', 'HERMES',
]);

const SAFETY_TIMEOUT_MS = 60000; // only a guard against a hung child; no assertion depends on it

const SLOW_SECONDS = '20'; // a fake sleep that only a kill can end in time

const SLOT_LIMIT_MS = 3800; // the margin given by the specification (R10)


const created = [];

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});


function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cli-'));
  created.push(root);
  const sb = {
    root,
    home: path.join(root, 'home'),
    slot: path.join(root, 'slots'),
    work: path.join(root, 'work'),
    tmp: path.join(root, 'tmp'),
  };
  for (const dir of [sb.home, sb.slot, sb.work, sb.tmp]) fs.mkdirSync(dir, { recursive: true });
  return sb;
}


let serial = 0;

function scratch(sb, label, text, ext = '.txt') {
  const file = path.join(sb.root, `${label}-${++serial}${ext}`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const briefOf = (sb, text = 'Brief for the cli tests.') => scratch(sb, 'brief', text);

const routingOf = (sb, doc) => scratch(sb, 'routing', JSON.stringify(doc, null, 2), '.json');

const tempEnv = (sb) => ({ TEMP: sb.tmp, TMP: sb.tmp, TMPDIR: sb.tmp });


function docOf({ routers, models, kinds } = {}) {
  return {
    version: 2,
    routers,
    models: models ?? { 'codex-model': { family: 'test', routes: [{ router: 'codex', id: 'some-model-id' }] } },
    claude_agents: {},
    kinds: kinds ?? { 'test-kind': { tier: '2', use_when: 'test', picks: [{ model: 'codex-model' }] }, 'write-kind': { tier: '2', use_when: 'test', write: true, picks: [{ model: 'codex-model' }] } },
  };
}


function docFor(routerName, cfg, modelExtra = {}) {
  return docOf({
    routers: { [routerName]: cfg },
    models: { 'codex-model': { family: 'test', ...modelExtra, routes: [{ router: routerName, id: 'some-model-id' }] } },
  });
}


const cliRouter = (extra = {}) => ({ type: 'cli', bin: [process.execPath], args: [FIXTURE], ...extra });


function buildEnv(sb, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('WORKER_') || SCRUBBED_NAMES.has(upper)) continue;
    env[key] = value;
  }
  const set = { HOME: sb.home, USERPROFILE: sb.home, WORKER_SLOT_DIR: sb.slot, ...extra };
  for (const [key, value] of Object.entries(set)) {
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}


function runWorker(sb, routingFile, args, opts = {}) {
  const res = spawnSync(process.execPath, [WORKER, ...args], {
    cwd: opts.cwd ?? sb.work,
    env: buildEnv(sb, { WORKER_ROUTING: routingFile, ...(opts.env ?? {}) }),
    encoding: 'utf8',
    timeout: SAFETY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (res.error) throw res.error;
  const out = res.stdout ?? '';
  const err = res.stderr ?? '';
  return { status: res.status, out, err, all: out + err };
}


function workerAsync(sb, routingFile, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
      cwd: sb.work,
      env: buildEnv(sb, { WORKER_ROUTING: routingFile }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out, err, all: out + err }));
  });
}


async function timed(promises) {
  const start = Date.now();
  const results = await Promise.all(promises);
  return { ms: Date.now() - start, results };
}


// The fake program prints one line "FAKE-REPORT {json}" unless --fake-stdout is given.

function reportOf(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.startsWith('FAKE-REPORT '));
  assert.ok(line, `no FAKE-REPORT line in the output:\n${text}`);
  return JSON.parse(line.slice('FAKE-REPORT '.length));
}


function samePath(a, b) {
  const norm = (p) => {
    const real = fs.realpathSync.native(p);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}


function isInside(child, parent) {
  const rel = path.relative(fs.realpathSync.native(parent), fs.realpathSync.native(path.dirname(child)));
  return rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..'));
}


function listFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(dir);
  return found;
}


// R1: cli routes are treated like the other program routes.


test('routing shape: a router entry that is a string is a description and never runs a program', () => {
  const sb = sandbox();
  const asDescription = JSON.stringify({ type: 'cli', bin: [process.execPath], args: [FIXTURE, '--fake-stdout', 'STRING-RAN'] });
  const routing = routingOf(sb, docFor('codex', asDescription));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  assert.ok(!r.out.includes('STRING-RAN'), r.all);
  assert.notEqual(r.status, 0, r.all);
});


// R2: program lookup.


test('R2 binEnv: an empty variable is not a candidate, so bin is tried', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    bin: [process.execPath],
    binEnv: 'CWTEST_BIN',
    args: [FIXTURE, '--fake-stdout', 'R2-EMPTY-VAR'],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude'], {
    env: { CWTEST_BIN: '' },
  });
  assert.equal(r.status, 0, r.all);
  assert.ok(r.out.includes('R2-EMPTY-VAR'), r.all);
});


test('R2 a bare program name is found by PATH search', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    bin: [path.basename(process.execPath)],
    args: [FIXTURE, '--fake-stdout', 'R2-PATH-OK'],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude'], {
    env: { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '') },
  });
  assert.equal(r.status, 0, r.all);
  assert.ok(r.out.includes('R2-PATH-OK'), r.all);
});


// R3: npm node shims (Windows only).


// R4: availability.


// R5: read and write runs.


test('R5 a read-only run works on a router that has no writeArgs', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({ args: [FIXTURE, '--fake-stdout', 'R5-READ-ONLY-OK'] })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  assert.equal(r.status, 0, r.all);
  assert.ok(r.out.includes('R5-READ-ONLY-OK'), r.all);
});


test('R5 ask never writes: it uses args and not writeArgs', () => {
  const sb = sandbox();
  const dir = path.join(sb.root, 'run-dir');
  fs.mkdirSync(dir);
  const routing = routingOf(sb, docFor('codex', cliRouter({
    args: [FIXTURE, '--fake-stdout', 'R5-ASK-READ'],
    writeArgs: [FIXTURE, '--fake-write', 'cwtest-ask-marker.txt'],
  })));
  const r = runWorker(sb, routing, ['ask', 'codex-model', briefOf(sb), '--router', 'codex', '--dir', dir]);
  assert.ok(r.out.includes('R5-ASK-READ'), r.all);
  assert.ok(!fs.existsSync(path.join(dir, 'cwtest-ask-marker.txt')));
});


// R6: placeholders, effort and temporary files.


test('R6 {dir} without --dir is the current directory of the run', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({ args: [FIXTURE, '{dir}'] })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  const rep = reportOf(r.out);
  assert.ok(samePath(rep.args[0], sb.work), `${rep.args[0]} is not ${sb.work}`);
  assert.ok(samePath(rep.cwd, sb.work), `child cwd ${rep.cwd} is not ${sb.work}`);
});


test('R6 temporary file names differ between runs', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({ args: [FIXTURE, '{briefFile}', '-o', '{out}'] })));
  const brief = briefOf(sb);
  const first = reportOf(runWorker(sb, routing, ['run', 'test-kind', brief, '--no-claude'], { env: tempEnv(sb) }).out).args;
  const second = reportOf(runWorker(sb, routing, ['run', 'test-kind', brief, '--no-claude'], { env: tempEnv(sb) }).out).args;
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[2], second[2]);
});


test('R6 temporary files are removed after a successful run', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    args: [FIXTURE, '{briefFile}', '-o', '{out}', '--fake-out-text', 'R6-OK-TEXT'],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude'], { env: tempEnv(sb) });
  assert.equal(r.status, 0, r.all);
  assert.ok(r.out.includes('R6-OK-TEXT'), r.all);
  assert.deepEqual(listFiles(sb.tmp), []);
});


test('R6 temporary files are removed after a timeout', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    timeoutSec: 1,
    args: [FIXTURE, '{briefFile}', '-o', '{out}', '--fake-sleep', SLOW_SECONDS],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude'], { env: tempEnv(sb) });
  assert.ok(r.all.includes('timed out after 1s'), r.all);
  assert.deepEqual(listFiles(sb.tmp), []);
});


test('R6 {effort} is the model effort before the ask --effort', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({ args: [FIXTURE, 'effort={effort}'] }), { effort: 'low' }));
  const r = runWorker(sb, routing, ['ask', 'codex-model', briefOf(sb), '--router', 'codex', '--effort', 'high']);
  assert.deepEqual(reportOf(r.out).args, ['effort=low'], r.all);
});


test('R6 {effort} is the pick effort before the model effort', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docOf({
    routers: { codex: cliRouter({ args: [FIXTURE, 'effort={effort}'] }) },
    models: { 'codex-model': { family: 'test', effort: 'low', routes: [{ router: 'codex', id: 'some-model-id' }] } },
    kinds: { 'test-kind': { tier: '2', use_when: 'test', picks: [{ model: 'codex-model', effort: 'high' }] } },
  }));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  assert.deepEqual(reportOf(r.out).args, ['effort=high'], r.all);
});


// R7: standard input.


// R8: the answer.


test('R8 an empty answer file falls back to the captured standard output', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    args: [FIXTURE, '--fake-stdout', 'R8-EMPTY-FALLBACK', '-o', '{out}', '--fake-out-text', ''],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  assert.equal(r.status, 0, r.all);
  assert.ok(r.out.includes('R8-EMPTY-FALLBACK'), r.all);
});


test('R8 a missing answer file falls back to the captured standard output', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    args: [FIXTURE, '--fake-stdout', 'R8-MISSING-FALLBACK', '-o', '{out}'],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  assert.equal(r.status, 0, r.all);
  assert.ok(r.out.includes('R8-MISSING-FALLBACK'), r.all);
});


test('R8 an answer that strip removes entirely fails like an empty output', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    strip: ['[\\s\\S]+'],
    args: [FIXTURE, '--fake-stdout', 'R8-EMPTIED'],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  assert.notEqual(r.status, 0, r.all);
  assert.doesNotMatch(r.all, /unknown router type/);
  assert.match(r.all, /empty|no output/i);
});


test('R8 an error-looking answer fails the route', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    args: [FIXTURE, '--fake-stdout', 'Error: R8 looks broken'],
  })));
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--no-claude']);
  assert.notEqual(r.status, 0, r.all);
  assert.doesNotMatch(r.all, /unknown router type/);
  assert.match(r.all, /error|looks broken/i);
});


test('R8 a write run that changes no files reports no files changed', () => {
  const sb = sandbox();
  const dir = path.join(sb.root, 'run-dir');
  fs.mkdirSync(dir);
  gitWorkTree(dir);
  const routing = routingOf(sb, docFor('codex', cliRouter({
    args: [FIXTURE],
    writeArgs: [FIXTURE, '--fake-stdout', 'R8-NO-CHANGE'],
  })));
  const r = runWorker(sb, routing, ['run', 'write-kind', briefOf(sb), '--write', '--dir', dir, '--no-claude']);
  assert.match(r.all, /no files changed/);
});


// R9: failure, timeouts.


test('R9 the route timeoutSec wins over --timeout', () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({
    timeoutSec: 1,
    args: [FIXTURE, '--fake-sleep', SLOW_SECONDS, '--fake-stdout', 'R9-LATE'],
  })));
  const start = Date.now();
  const r = runWorker(sb, routing, ['run', 'test-kind', briefOf(sb), '--timeout', '60', '--no-claude']);
  const ms = Date.now() - start;
  assert.ok(r.all.includes('timed out after 1s'), r.all);
  assert.ok(ms < 15000, `the run took ${ms} ms, so the route timeoutSec was not used`);
});


// R10: slots. Timing uses a fake program that sleeps 2 s, with the margins of the specification.


const TWO_SECOND_ANSWER = [FIXTURE, '--fake-sleep', '2', '--fake-stdout', 'R10-DONE'];


test('R10 the default slot count is one: two concurrent runs take at least 3.8 s in total', async () => {
  const sb = sandbox();
  const routing = routingOf(sb, docFor('codex', cliRouter({ args: TWO_SECOND_ANSWER })));
  const brief = briefOf(sb);
  const { ms, results } = await timed([1, 2].map(() => workerAsync(sb, routing, ['run', 'test-kind', brief, '--no-claude'])));
  for (const r of results) assert.equal(r.status, 0, r.all);
  assert.ok(ms >= SLOT_LIMIT_MS, `two runs with the default slot count took ${ms} ms`);
});


test('R10 runs through different cli routers do not share a slot', async () => {
  const sb = sandbox();
  const routing = routingOf(sb, docOf({
    routers: {
      'cwtest-slot-a': cliRouter({ slots: 1, args: TWO_SECOND_ANSWER }),
      'cwtest-slot-b': cliRouter({ slots: 1, args: TWO_SECOND_ANSWER }),
    },
    models: {
      'model-a': { family: 'test', routes: [{ router: 'cwtest-slot-a', id: 'id-a' }] },
      'model-b': { family: 'test', routes: [{ router: 'cwtest-slot-b', id: 'id-b' }] },
    },
    kinds: {
      'kind-a': { tier: '2', use_when: 'test', picks: [{ model: 'model-a' }] },
      'kind-b': { tier: '2', use_when: 'test', picks: [{ model: 'model-b' }] },
    },
  }));
  const brief = briefOf(sb);
  const { ms, results } = await timed([
    workerAsync(sb, routing, ['run', 'kind-a', brief, '--no-claude']),
    workerAsync(sb, routing, ['run', 'kind-b', brief, '--no-claude']),
  ]);
  for (const r of results) assert.equal(r.status, 0, r.all);
  assert.ok(ms < SLOT_LIMIT_MS, `runs through two routers took ${ms} ms`);
});


// R11: file access.


// R12: no shell.


// R13: nothing else changes.
}
