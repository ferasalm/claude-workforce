import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools');
const USAGE = path.join(TOOLS, 'usage.mjs');
const CHECK = path.join(TOOLS, 'check.mjs');
const NEXT_CHAT = path.join(TOOLS, 'next-chat.mjs');
const STATUSLINE = path.join(ROOT, 'statusline', 'usage-snapshot.mjs');
const ROUTING_V2 = path.join(ROOT, 'skills', 'lean-orchestrator', 'routing.json');
const V2 = JSON.parse(fs.readFileSync(ROUTING_V2, 'utf8'));

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const strip = (value) => String(value ?? '').replace(ANSI, '').replace(/\r\n/g, '\n');
const slash = (value) => String(value).replace(/\\/g, '/');
const BLOCKED = new Set([
  'NVIDIA_API_KEY',
  'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'AGY_BIN',
  'OPENCODE_BIN',
  'CLAUDE_CODE_CHILD_SESSION',
  // Without this, a nested `node --test` (check.mjs's tests step) skips its files.
  'NODE_TEST_CONTEXT',
]);
const temps = [];

function temp(prefix = 'cw-tools-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); // real path: macOS tmp is a symlink and child cwd is reported resolved
  temps.push(dir);
  return dir;
}

const DEFAULT_HOME = temp('cw-tools-home-');
after(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best effort cleanup
    }
  }
});

function envFor(home, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (BLOCKED.has(upper) || upper.startsWith('WORKER_')) continue;
    env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, ...extra };
}

function run(script, args, { cwd = ROOT, home = DEFAULT_HOME, env = {}, input } = {}) {
  const options = { env: envFor(home, env), cwd, encoding: 'utf8', timeout: 60000 };
  if (input !== undefined) options.input = input;
  const result = spawnSync(process.execPath, [script, ...args], options);
  const stdout = strip(result.stdout);
  const stderr = strip(result.stderr);
  return { status: result.status, stdout, stderr, all: stdout + stderr };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const read = (file) => fs.readFileSync(file, 'utf8');
const newHome = () => temp('cw-tools-home-');
const lines = (count, label = 'line') => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`).join('\n') + '\n';
const snapshotFile = (home) => path.join(home, '.claude', 'usage-snapshot.json');

function snapshotData({ five = 44, seven = 31, fiveIn = 5400, sevenIn = 263100, ageMin = 0, epoch = true } = {}) {
  const now = Date.now();
  const base = Math.floor(now / 1000);
  const saved = now - ageMin * 60000;
  const data = {
    saved_at: new Date(saved).toISOString(),
    saved_at_epoch: Math.floor(saved / 1000),
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: base + fiveIn },
      seven_day: { used_percentage: seven, resets_at: base + sevenIn },
    },
  };
  if (!epoch) delete data.saved_at_epoch;
  return data;
}

const writeSnapshot = (home, data) => write(snapshotFile(home), JSON.stringify(data));

describe('usage.mjs', () => {
  it('prints one fresh line with reset times and age', () => {
    const home = newHome();
    writeSnapshot(home, snapshotData());
    const r = run(USAGE, [], { home });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout.trim(), /^5h 44% \(resets in 1:(29|30)\) \| 7d 31% \(resets in 73:0(4|5)\) \| age 0 min$/);
    assert.equal(r.stdout.trim().split('\n').length, 1);
  });

  it('marks a 40-minute-old snapshot STALE and falls back to saved_at', () => {
    const home = newHome();
    writeSnapshot(home, snapshotData({ ageMin: 40, epoch: false, fiveIn: 620, sevenIn: -100 }));
    const r = run(USAGE, [], { home });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout.trim(), /^5h 44% \(resets in 0:1(0|1)\) \| 7d 31% \(resets in 0:00\) \| age 40 min \| STALE$/);
  });

  it('exits 2 on a missing snapshot, for both read and --start', () => {
    const home = newHome();
    let r = run(USAGE, [], { home });
    assert.equal(r.status, 2, r.all);
    assert.equal(r.stdout.trim(), 'no snapshot: ask the user for their usage numbers');
    assert.equal(r.stderr.trim(), '');
    const cwd = temp('cw-tools-cwd-');
    r = run(USAGE, ['--start'], { home, cwd });
    assert.equal(r.status, 2, r.all);
    assert.match(r.stdout, /no snapshot: ask the user for their usage numbers/);
    assert.equal(fs.existsSync(path.join(cwd, '.usage-start.json')), false);
  });

  it('--start saves the baseline and --end prints the deltas', () => {
    const home = newHome();
    const cwd = temp('cw-tools-cwd-');
    writeSnapshot(home, snapshotData());
    let r = run(USAGE, ['--start'], { home, cwd });
    assert.equal(r.status, 0, r.all);
    assert.equal(r.stdout.trim(), 'usage start saved: 5h 44% 7d 31%');
    const start = JSON.parse(read(path.join(cwd, '.usage-start.json')));
    assert.equal(start['5h'], 44);
    assert.equal(start['7d'], 31);
    assert.match(start.saved_at, /^\d{4}-\d{2}-\d{2}T/);
    writeSnapshot(home, snapshotData({ five: 50, seven: 40 }));
    r = run(USAGE, ['--end'], { home, cwd });
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(r.stdout.trim().split('\n'), [
      'used since start: 5h +6% 7d +9%',
      'd5h_pct,d7d_pct',
      '6,9',
    ]);
  });

  it('--start/--end honour --file and print negative deltas', () => {
    const home = newHome();
    const cwd = temp('cw-tools-cwd-');
    const file = path.join(cwd, 'custom-start.json');
    writeSnapshot(home, snapshotData());
    let r = run(USAGE, ['--start', '--file', file], { home, cwd });
    assert.equal(r.status, 0, r.all);
    assert.ok(fs.existsSync(file));
    assert.equal(fs.existsSync(path.join(cwd, '.usage-start.json')), false);
    writeSnapshot(home, snapshotData({ five: 40, seven: 28 }));
    r = run(USAGE, ['--end', '--file', file], { home, cwd });
    assert.equal(r.status, 0, r.all);
    const out = r.stdout.trim().split('\n');
    assert.equal(out.length, 3);
    assert.match(out[0], /^used since start: 5h .*% 7d .*%$/);
    assert.equal(out[1], 'd5h_pct,d7d_pct');
    assert.equal(out[2], '-4,-3');
  });

  it('--end without a start file exits 2', () => {
    const home = newHome();
    const cwd = temp('cw-tools-cwd-');
    writeSnapshot(home, snapshotData());
    const r = run(USAGE, ['--end'], { home, cwd });
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /no start file: run usage\.mjs --start first/);
  });
});

describe('statusline/usage-snapshot.mjs', () => {
  const payloadFor = (fiveIn = 5400, sevenIn = 7260) => {
    const base = Math.floor(Date.now() / 1000);
    return {
      model: { display_name: 'Test Model' },
      context_window: { used_percentage: 23 },
      rate_limits: {
        five_hour: { used_percentage: 44, resets_at: base + fiveIn },
        seven_day: { used_percentage: 31, resets_at: base + sevenIn },
      },
    };
  };

  it('prints the plain line and writes the snapshot', () => {
    const home = newHome();
    const payload = payloadFor();
    const r = run(STATUSLINE, [], { home, input: JSON.stringify(payload) });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout.trim(), /^Test Model \| ctx 23% \| 5h 44% \(resets 1:(29|30)\) \| 7d 31%$/);
    const snap = JSON.parse(read(snapshotFile(home)));
    assert.match(snap.saved_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof snap.saved_at_epoch, 'number');
    assert.ok(Math.abs(snap.saved_at_epoch - Math.floor(Date.now() / 1000)) <= 120);
    assert.deepEqual(snap.rate_limits, payload.rate_limits);
  });

  it('leaves an existing snapshot byte-identical when rate_limits is absent', () => {
    const home = newHome();
    const original = '{"keep":true}\n';
    write(snapshotFile(home), original);
    const r = run(STATUSLINE, [], {
      home,
      input: JSON.stringify({ model: { display_name: 'Solo' }, context_window: { used_percentage: 12 } }),
    });
    assert.equal(r.status, 0, r.all);
    assert.equal(r.stdout.trim(), 'Solo | ctx 12%');
    assert.equal(read(snapshotFile(home)), original);
    const only = run(STATUSLINE, [], { home, input: JSON.stringify({ model: { display_name: 'Only' } }) });
    assert.equal(only.status, 0, only.all);
    assert.equal(only.stdout.trim(), 'Only');
    assert.equal(read(snapshotFile(home)), original);
    const fresh = newHome();
    const none = run(STATUSLINE, [], { home: fresh, input: JSON.stringify({ model: { display_name: 'None' } }) });
    assert.equal(none.status, 0, none.all);
    assert.equal(fs.existsSync(snapshotFile(fresh)), false);
  });

  it('always exits 0 with a fallback line for invalid or empty stdin', () => {
    for (const input of ['not json at all', '']) {
      const r = run(STATUSLINE, [], { home: newHome(), input });
      assert.equal(r.status, 0, r.all);
      assert.ok(r.stdout.trim().length > 0, 'fallback line is empty');
      assert.equal(r.stdout.trim().split('\n').length, 1);
    }
  });

  it('round-trips: usage.mjs reads what the status line wrote', () => {
    const home = newHome();
    const payload = payloadFor(5400, 7260);
    const s = run(STATUSLINE, [], { home, input: JSON.stringify(payload) });
    assert.equal(s.status, 0, s.all);
    const u = run(USAGE, [], { home });
    assert.equal(u.status, 0, u.all);
    assert.match(u.stdout.trim(), /^5h 44% \(resets in 1:(29|30)\) \| 7d 31% \(resets in 2:0(0|1)\) \| age 0 min$/);
  });
});

describe('check.mjs', () => {
  const frontmatter = (name, model, effort) => `---\nname: ${name}\nmodel: ${model}\neffort: ${effort}\n---\n\nAgent ${name}.\n`;

  function goodTree() {
    const root = temp('cw-tools-check-');
    write(path.join(root, 'skills', 'lean-orchestrator', 'routing.json'), read(ROUTING_V2));
    for (const [name, agent] of Object.entries(V2.claude_agents)) {
      write(path.join(root, 'agents', `${name}.md`), frontmatter(name, agent.model, agent.effort));
    }
    write(path.join(root, 'agents', 'lead.md'), '# lead\n');
    write(path.join(root, 'agents', 'lean-orchestrator.md'), '# lean orchestrator\n');
    write(path.join(root, 'skills', 'lead', 'SKILL.md'), lines(20));
    write(path.join(root, 'skills', 'lean-orchestrator', 'LESSONS.md'), lines(10));
    return root;
  }

  const runCheck = (root, args = ['--skip-tests']) => run(CHECK, ['--root', root, ...args], { cwd: ROOT });

  function assertOk(r, steps) {
    assert.equal(r.status, 0, r.all);
    assert.ok(!/^FAIL /m.test(r.stdout), r.stdout);
    for (const step of steps) assert.match(r.stdout, new RegExp(`^ok ${step}$`, 'm'));
  }

  function failDetail(out, step) {
    const all = out.split('\n');
    const index = all.findIndex((line) => line === `FAIL ${step}`);
    if (index < 0) return null;
    const rest = all.slice(index + 1);
    const end = rest.findIndex((line) => /^(ok|FAIL) /.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== '');
  }

  it('passes a good tree with every step ok', () => {
    const r = runCheck(goodTree());
    assertOk(r, ['routing', 'agents', 'effort', 'lead-size', 'lessons-size', 'model-names']);
    assert.ok(!/^ok tests$/m.test(r.stdout));
  });

  it('skips agents, lead-size and lessons-size when those paths are absent', () => {
    const root = temp('cw-tools-sparse-');
    write(path.join(root, 'skills', 'lean-orchestrator', 'routing.json'), read(ROUTING_V2));
    const r = runCheck(root);
    assertOk(r, ['routing', 'agents', 'effort', 'lead-size', 'lessons-size', 'model-names']);
  });

  it('fails agents when an agent effort differs', () => {
    const root = goodTree();
    const agent = V2.claude_agents['sub-orchestrator-sonnet'];
    write(path.join(root, 'agents', 'sub-orchestrator-sonnet.md'), frontmatter('sub-orchestrator-sonnet', agent.model, 'low'));
    const r = runCheck(root);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL agents$/m);
    assert.ok(failDetail(r.stdout, 'agents').some((line) => line.includes('sub-orchestrator-sonnet.md')));
    assert.ok(!/^FAIL effort$/m.test(r.stdout));
  });

  it('fails agents for a file without frontmatter', () => {
    const root = goodTree();
    write(path.join(root, 'agents', 'builder.md'), '# builder without frontmatter\n');
    const r = runCheck(root);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL agents$/m);
    assert.ok(failDetail(r.stdout, 'agents').some((line) => line.includes('builder.md')));
  });

  it('fails agents for a file that is not in claude_agents', () => {
    const root = goodTree();
    write(path.join(root, 'agents', 'extra-agent.md'), frontmatter('extra-agent', 'haiku', 'medium'));
    const r = runCheck(root);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL agents$/m);
    assert.ok(failDetail(r.stdout, 'agents').some((line) => line.includes('extra-agent.md')));
  });

  it('fails effort for a haiku entry at low effort', () => {
    const root = goodTree();
    const routingPath = path.join(root, 'skills', 'lean-orchestrator', 'routing.json');
    const routing = JSON.parse(read(routingPath));
    routing.claude_agents['scout-lite'].effort = 'low';
    write(routingPath, JSON.stringify(routing, null, 2));
    write(path.join(root, 'agents', 'scout-lite.md'), frontmatter('scout-lite', 'haiku', 'low'));
    const r = runCheck(root);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL effort$/m);
    assert.ok(!/^FAIL agents$/m.test(r.stdout));
  });

  it('fails lead-size at 130 lines and lessons-size at 60 lines', () => {
    const root = goodTree();
    const lead = path.join(root, 'skills', 'lead', 'SKILL.md');
    const lessons = path.join(root, 'skills', 'lean-orchestrator', 'LESSONS.md');
    write(lead, lines(129));
    write(lessons, lines(59));
    let r = runCheck(root);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^ok lead-size$/m);
    assert.match(r.stdout, /^ok lessons-size$/m);
    write(lead, lines(130));
    r = runCheck(root);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL lead-size$/m);
    write(lead, lines(129));
    write(lessons, lines(60));
    r = runCheck(root);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL lessons-size$/m);
  });

  it('fails model-names when a route id appears in a markdown file', () => {
    const root = goodTree();
    const id = V2.models['deepseek-flash'].routes.find((route) => route.router === 'cloudflare').id;
    write(path.join(root, 'skills', 'other', 'notes.md'), `The model is ${id} here.\n`);
    const r = runCheck(root);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL model-names$/m);
    const detail = failDetail(r.stdout, 'model-names');
    assert.ok(detail);
    assert.ok(detail.some((line) => line.includes('notes.md')));
    assert.ok(detail.join('\n').includes(id));
  });

  it('fails routing and exits 1 for an empty root', () => {
    const r = runCheck(temp('cw-tools-empty-'));
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL routing$/m);
  });

  it('runs the tests step with a passing and then a failing test folder', () => {
    const root = goodTree();
    write(
      path.join(root, 'test', 'pass.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passes', () => assert.equal(1, 1));\n",
    );
    let r = runCheck(root, []);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^ok tests$/m);
    write(
      path.join(root, 'test', 'fail.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n",
    );
    r = runCheck(root, []);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stdout, /^FAIL tests$/m);
    const detail = failDetail(r.stdout, 'tests');
    assert.ok(detail && detail.length > 0, r.stdout);
    assert.ok(detail.length <= 12, `tests detail has ${detail.length} lines\n${r.stdout}`);
  });
});

describe('next-chat.mjs', () => {
  const LAUNCHER = /^\[next-chat\] launcher: (wt|powershell|osascript|gnome-terminal|x-terminal-emulator|print)$/;

  it('--dry-run prints the default command, cwd and launcher', () => {
    const cwd = temp('cw-tools-chat-');
    write(path.join(cwd, 'handoff.md'), '# handoff\n');
    const r = run(NEXT_CHAT, ['--handoff', 'handoff.md', '--dry-run'], { cwd });
    assert.equal(r.status, 0, r.all);
    const out = r.stdout.trim().split('\n');
    const handoff = slash(path.join(cwd, 'handoff.md'));
    assert.equal(out.length, 4);
    assert.equal(
      out[0],
      `[next-chat] command: claude --model opus --effort xhigh --agent lead "Read the handoff file at ${handoff} and continue it under its rules."`,
    );
    assert.equal(slash(out[1]), `[next-chat] cwd: ${slash(path.resolve(cwd))}`);
    assert.equal(out[2], '[next-chat] env removed: CLAUDE_CODE_CHILD_SESSION');
    assert.match(out[3], LAUNCHER);
  });

  it('--dry-run honours model, effort, agent and cwd overrides', () => {
    const cwd = temp('cw-tools-chat-');
    const sub = path.join(cwd, 'sub dir');
    fs.mkdirSync(sub);
    const handoff = write(path.join(cwd, 'handoff.md'), '# handoff\n');
    const r = run(
      NEXT_CHAT,
      ['--handoff', handoff, '--model', 'sonnet', '--effort', 'high', '--agent', 'builder', '--cwd', 'sub dir', '--dry-run'],
      { cwd },
    );
    assert.equal(r.status, 0, r.all);
    const out = r.stdout.trim().split('\n');
    assert.equal(out.length, 4);
    assert.equal(
      out[0],
      `[next-chat] command: claude --model sonnet --effort high --agent builder "Read the handoff file at ${slash(handoff)} and continue it under its rules."`,
    );
    assert.equal(slash(out[1]), `[next-chat] cwd: ${slash(path.resolve(cwd, 'sub dir'))}`);
    assert.equal(out[2], '[next-chat] env removed: CLAUDE_CODE_CHILD_SESSION');
    assert.match(out[3], LAUNCHER);
  });

  it('exits 2 for a missing handoff file or a missing flag', () => {
    const cwd = temp('cw-tools-chat-');
    let r = run(NEXT_CHAT, ['--handoff', path.join(cwd, 'missing.md'), '--dry-run'], { cwd });
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /handoff/i);
    r = run(NEXT_CHAT, ['--dry-run'], { cwd });
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /handoff/i);
  });
});
