import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools');
const ROUTING_V2 = path.join(ROOT, 'skills', 'lean-orchestrator', 'routing.json');
const ROUTING_V1 = path.join(ROOT, 'test', 'fixtures', 'routing-v1.json');
const INSTALL = path.join(ROOT, 'install.mjs');

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const strip = (value) => String(value ?? '').replace(ANSI, '');
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

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function makeHome() {
  return tempDir('cw-install-home-');
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function buildSource() {
  const src = tempDir('cw-install-src-');
  const lo = path.join(src, 'skills', 'lean-orchestrator');
  write(path.join(lo, 'SKILL.md'), 'dir={{SKILLS_DIR}}/lean-orchestrator\n');
  write(path.join(lo, 'routing.json'), '{"version":1,"models":{}}\n');
  write(path.join(lo, 'LESSONS.md'), '# lessons\n');
  write(path.join(lo, 'METRICS.csv'), 'date,metric\n');
  write(path.join(lo, 'tools', 'worker.mjs'), "// {{SKILLS_DIR}}/lean-orchestrator\nconsole.log('DOCTOR-STUB ok');\n");
  write(path.join(lo, 'tools', 'INDEX.md'), 'index at {{SKILLS_DIR}}/lean-orchestrator\n');
  write(path.join(src, 'skills', 'lead', 'SKILL.md'), 'lead dir={{SKILLS_DIR}}/lead\n');
  write(path.join(src, 'agents', 'lead.md'), 'agent at {{SKILLS_DIR}}/lean-orchestrator\n');
  write(path.join(src, 'agents', 'builder.md'), '# builder\n');
  write(path.join(src, 'statusline', 'usage-snapshot.mjs'), "console.log('snapshot');\n");
  write(path.join(lo, '.install-manifest.json'), '{"junk":true}\n');
  write(path.join(lo, 'node_modules', 'junk.js'), 'junk\n');
  write(path.join(lo, '.git', 'config'), 'junk\n');
  return src;
}

let SRC;

before(() => {
  SRC = buildSource();
});

after(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // best effort cleanup
    }
  }
});

function envFor(home, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (BLOCKED.has(key) || key.startsWith('WORKER_')) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  return Object.assign(env, extra);
}

function run(args, home, extraEnv = {}) {
  const result = spawnSync(process.execPath, [INSTALL, ...args], {
    env: envFor(home, extraEnv),
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const stdout = strip(result.stdout);
  const stderr = strip(result.stderr);
  return { ...result, stdout, stderr, all: stdout + stderr };
}

function install(home, args = [], src = SRC) {
  return run(['--src', src, '--home', home, ...args], home);
}

function canon(file) {
  const normalized = path.normalize(path.resolve(file)).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function manifestPath(home) {
  return path.join(home, '.claude', 'skills', 'lean-orchestrator', '.install-manifest.json');
}

function readManifest(home) {
  return JSON.parse(read(manifestPath(home)));
}

function manifestSet(home) {
  const manifest = readManifest(home);
  assert.equal(typeof manifest.version, 'string');
  assert.ok(manifest.version.length > 0);
  assert.match(manifest.installedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(manifest.files));
  for (const file of manifest.files) {
    assert.ok(path.isAbsolute(file), `not absolute: ${file}`);
    assert.ok(fs.existsSync(file), `manifest lists a missing file: ${file}`);
  }
  return new Set(manifest.files.map(canon));
}

function expectedFiles(home) {
  const claude = path.join(home, '.claude');
  const relative = [
    'skills/lean-orchestrator/SKILL.md',
    'skills/lean-orchestrator/routing.json',
    'skills/lean-orchestrator/LESSONS.md',
    'skills/lean-orchestrator/METRICS.csv',
    'skills/lean-orchestrator/tools/worker.mjs',
    'skills/lean-orchestrator/tools/INDEX.md',
    'skills/lead/SKILL.md',
    'agents/lead.md',
    'agents/builder.md',
  ];
  return new Set(relative.map((file) => canon(path.join(claude, file))));
}

function assertSameSet(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else files.push(full);
  }
  return files;
}

function assertNoSymlinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    assert.equal(fs.lstatSync(full).isSymbolicLink(), false, `symlink installed: ${full}`);
    if (entry.isDirectory()) assertNoSymlinks(full);
  }
}

describe('install.mjs', () => {
  it('installs every file, substitutes {{SKILLS_DIR}} and writes the manifest', () => {
    const home = makeHome();
    const result = install(home);
    assert.equal(result.status, 0, result.all);

    const claude = path.join(home, '.claude');
    const skillsDir = path.join(claude, 'skills');
    const skillsDirFwd = skillsDir.replace(/\\/g, '/');
    const skill = path.join(skillsDir, 'lean-orchestrator', 'SKILL.md');

    assert.equal(read(skill), `dir=${skillsDirFwd}/lean-orchestrator\n`);
    assert.equal(read(path.join(skillsDir, 'lead', 'SKILL.md')), `lead dir=${skillsDirFwd}/lead\n`);
    assert.equal(read(path.join(claude, 'agents', 'lead.md')), `agent at ${skillsDirFwd}/lean-orchestrator\n`);
    assert.ok(fs.existsSync(path.join(skillsDir, 'lean-orchestrator', 'tools', 'worker.mjs')));
    assert.ok(fs.existsSync(path.join(claude, 'agents', 'builder.md')));
    assert.ok(!fs.existsSync(path.join(skillsDir, 'lean-orchestrator', 'node_modules')));
    assert.ok(!fs.existsSync(path.join(skillsDir, 'lean-orchestrator', '.git')));

    const manifest = readManifest(home);
    assert.equal(typeof manifest.version, 'string');
    assert.match(manifest.installedAt, /^\d{4}-\d{2}-\d{2}T/);
    assertSameSet(manifestSet(home), expectedFiles(home), 'manifest files');
    assert.ok(!manifest.files.some((file) => /node_modules|\.git/.test(file)));

    assert.equal(fs.lstatSync(claude).isSymbolicLink(), false, '.claude is a symlink');
    assertNoSymlinks(claude);
    for (const file of walkFiles(claude)) {
      if (/\.(md|json|mjs|csv|txt)$/i.test(file)) {
        assert.ok(!read(file).includes('{{'), `unsubstituted placeholder in ${file}`);
      }
    }
    assert.match(result.stdout, /DOCTOR-STUB ok/);
  });

  it('re-installs idempotently without rewriting unchanged files', () => {
    const home = makeHome();
    assert.equal(install(home).status, 0);

    const builder = path.join(home, '.claude', 'agents', 'builder.md');
    const old = new Date('2020-01-02T03:04:05Z');
    fs.utimesSync(builder, old, old);
    const beforeMtime = fs.statSync(builder).mtimeMs;
    const beforeFiles = manifestSet(home);
    const beforeContent = new Map(
      walkFiles(path.join(home, '.claude'))
        .filter((file) => !file.endsWith('.install-manifest.json'))
        .map((file) => [file, read(file)]),
    );

    const result = install(home);
    assert.equal(result.status, 0, result.all);
    assert.equal(fs.statSync(builder).mtimeMs, beforeMtime);
    for (const [file, content] of beforeContent) assert.equal(read(file), content, file);
    assertSameSet(manifestSet(home), beforeFiles, 'manifest files changed');
    assert.match(result.stdout, /unchanged/i);
  });

  it('keeps a modified file without --force and backs it up with --force', () => {
    const home = makeHome();
    assert.equal(install(home).status, 0);

    const target = path.join(home, '.claude', 'skills', 'lean-orchestrator', 'SKILL.md');
    fs.writeFileSync(target, 'mine\n');

    const kept = install(home);
    assert.equal(kept.status, 0, kept.all);
    assert.match(kept.stdout, /kept yours:/);
    assert.ok(kept.stdout.includes('SKILL.md'));
    assert.equal(read(target), 'mine\n');
    assert.ok(manifestSet(home).has(canon(target)), 'previously installed file should stay listed');

    const forced = install(home, ['--force']);
    assert.equal(forced.status, 0, forced.all);
    const expected = `dir=${path.join(home, '.claude', 'skills').replace(/\\/g, '/')}/lean-orchestrator\n`;
    assert.equal(read(target), expected);

    const backups = path.join(home, '.claude', 'backups');
    const stamps = fs.readdirSync(backups);
    assert.equal(stamps.length, 1, `backup folders: ${stamps.join(', ')}`);
    assert.match(stamps[0], /^claude-workforce-\d{8}-\d{6}$/);
    const backup = path.join(backups, stamps[0], 'skills', 'lean-orchestrator', 'SKILL.md');
    assert.equal(read(backup), 'mine\n');
  });

  it('never overwrites routing.json, LESSONS.md or METRICS.csv, even with --force', () => {
    const home = makeHome();
    assert.equal(install(home).status, 0);

    const base = path.join(home, '.claude', 'skills', 'lean-orchestrator');
    const names = ['routing.json', 'LESSONS.md', 'METRICS.csv'];
    for (const name of names) fs.writeFileSync(path.join(base, name), `custom ${name}\n`);

    const result = install(home, ['--force']);
    assert.equal(result.status, 0, result.all);
    for (const name of names) {
      assert.equal(read(path.join(base, name)), `custom ${name}\n`);
      assert.ok(
        result.stdout.split(/\r?\n/).some((line) => line.includes('kept yours:') && line.includes(name)),
        `no kept-yours line for ${name}: ${result.stdout}`,
      );
    }
  });

  it('--dry-run prints destinations and writes nothing', () => {
    const home = makeHome();
    const result = install(home, ['--dry-run']);
    assert.equal(result.status, 0, result.all);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
    assert.deepEqual(fs.readdirSync(home), []);

    const plan = result.stdout
      .split(/\r?\n/)
      .filter((line) => /SKILL\.md|routing\.json|LESSONS\.md|METRICS\.csv|worker\.mjs|INDEX\.md|lead\.md|builder\.md/.test(line));
    assert.ok(plan.length >= 9, `expected one destination per file:\n${result.stdout}`);
    assert.ok(result.stdout.includes('.claude'), 'plan does not name destinations under .claude');
  });

  it('--statusline installs usage-snapshot.mjs and sets statusLine in a fresh home', () => {
    const home = makeHome();
    const result = install(home, ['--statusline']);
    assert.equal(result.status, 0, result.all);

    const script = path.join(home, '.claude', 'usage-snapshot.mjs');
    assert.equal(read(script), read(path.join(SRC, 'statusline', 'usage-snapshot.mjs')));
    assert.ok(manifestSet(home).has(canon(script)), 'usage-snapshot.mjs is not in the manifest');

    const settings = JSON.parse(read(path.join(home, '.claude', 'settings.json')));
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: `node "${script.replace(/\\/g, '/')}"`,
    });
  });

  it('--statusline keeps an existing statusLine', () => {
    const home = makeHome();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    write(settingsPath, `${JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' }, theme: 'dark' }, null, 2)}\n`);

    const result = install(home, ['--statusline']);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /kept your statusLine/);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'usage-snapshot.mjs')));

    const settings = JSON.parse(read(settingsPath));
    assert.deepEqual(settings.statusLine, { type: 'command', command: 'echo mine' });
    assert.equal(settings.theme, 'dark');
  });

  it('--statusline backs up settings.json before adding statusLine', () => {
    const home = makeHome();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const original = '{"theme":"dark","env":{"A":"1"}}\n';
    write(settingsPath, original);

    const result = install(home, ['--statusline']);
    assert.equal(result.status, 0, result.all);

    const settings = JSON.parse(read(settingsPath));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.env.A, '1');
    assert.equal(settings.statusLine.type, 'command');

    const backups = path.join(home, '.claude', 'backups');
    const stamps = fs.readdirSync(backups);
    assert.equal(stamps.length, 1, `backup folders: ${stamps.join(', ')}`);
    assert.match(stamps[0], /^claude-workforce-\d{8}-\d{6}$/);
    assert.equal(read(path.join(backups, stamps[0], 'settings.json')), original);
  });

  it('--statusline leaves invalid settings.json alone and warns', () => {
    const home = makeHome();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const original = '{ this is not json\n';
    write(settingsPath, original);

    const result = install(home, ['--statusline']);
    assert.equal(result.status, 0, result.all);
    assert.equal(read(settingsPath), original);
    assert.match(result.all, /warn|invalid|not valid|parse/i);
  });

  it('--uninstall removes manifest files but keeps data, user files and settings', () => {
    const home = makeHome();
    assert.equal(install(home, ['--statusline']).status, 0);

    const claude = path.join(home, '.claude');
    const base = path.join(claude, 'skills', 'lean-orchestrator');
    write(path.join(base, 'notes.txt'), 'mine\n');
    write(path.join(claude, 'skills', 'other', 'SKILL.md'), 'other\n');
    const settingsPath = path.join(claude, 'settings.json');
    const settingsBefore = read(settingsPath);

    const result = install(home, ['--uninstall']);
    assert.equal(result.status, 0, result.all);

    assert.equal(fs.existsSync(manifestPath(home)), false);
    for (const name of ['routing.json', 'LESSONS.md', 'METRICS.csv']) {
      assert.ok(fs.existsSync(path.join(base, name)), `data file removed: ${name}`);
    }
    assert.equal(read(path.join(base, 'notes.txt')), 'mine\n');
    assert.equal(read(path.join(claude, 'skills', 'other', 'SKILL.md')), 'other\n');
    for (const rel of ['SKILL.md', 'tools/worker.mjs', 'tools/INDEX.md']) {
      assert.equal(fs.existsSync(path.join(base, rel)), false, `installed file not removed: ${rel}`);
    }
    assert.equal(fs.existsSync(path.join(claude, 'agents', 'lead.md')), false);
    assert.equal(fs.existsSync(path.join(claude, 'skills', 'lead', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(claude, 'usage-snapshot.mjs')), false);
    assert.equal(read(settingsPath), settingsBefore);
    assert.equal(fs.existsSync(path.join(base, 'tools')), false, 'empty tools folder should be removed');
    assert.match(result.stdout, /kept/i);

    const again = install(home, ['--uninstall']);
    assert.equal(again.status, 0, again.all);
    assert.match(again.all, /nothing|not installed|no manifest|no install/i);
  });

  it('--uninstall without a manifest exits 0 and says nothing was installed', () => {
    const home = makeHome();
    const result = install(home, ['--uninstall']);
    assert.equal(result.status, 0, result.all);
    assert.match(result.all, /nothing|not installed|no manifest|no install/i);
  });

  it('exits 1 when --src has no skills folder', () => {
    const src = tempDir('cw-install-noskills-');
    const home = makeHome();
    const result = install(home, [], src);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /skills|source/i);
  });

  it('exits 1 on an unknown flag', () => {
    const home = makeHome();
    const result = install(home, ['--bogus']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.trim().length > 0);
  });

  it('installs the real repo when its skill files are present', (t) => {
    const realSkill = path.join(ROOT, 'skills', 'lean-orchestrator', 'SKILL.md');
    if (!fs.existsSync(realSkill)) return t.skip('real skills/lean-orchestrator/SKILL.md is not present');

    const home = makeHome();
    const result = install(home, [], ROOT);
    assert.equal(result.status, 0, result.all);
    for (const file of walkFiles(path.join(home, '.claude'))) {
      if (file.endsWith('.md')) assert.ok(!read(file).includes('{{'), `unsubstituted placeholder in ${file}`);
    }
  });
});
