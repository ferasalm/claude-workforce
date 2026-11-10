// Windows only: a .cmd shim on PATH must be followed to the .exe it launches (Node cannot spawn .cmd files: EINVAL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'skills', 'lean-orchestrator', 'tools', 'worker.mjs');
const win = process.platform === 'win32';

function doctor(env) {
  const r = spawnSync(process.execPath, [WORKER, 'doctor'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
}

test('a .cmd shim resolves to the .exe it calls', { skip: !win }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  fs.mkdirSync(path.join(tmp, 'real'));
  const exe = path.join(tmp, 'real', 'opencode.exe');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(tmp, 'opencode.cmd'), '@echo off\r\n"%~dp0real\\opencode.exe" %*\r\n');
  const out = doctor({ PATH: tmp, OPENCODE_BIN: '' });
  assert.match(out, /opencode/i);
  assert.ok(out.includes(exe) || /opencode[^\n]*READY/i.test(out), 'opencode should be found through the shim:\n' + out);
});

test('a .cmd shim without an .exe is not offered as spawnable', { skip: !win }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  fs.writeFileSync(path.join(tmp, 'opencode.cmd'), '@echo off\r\nnode "%~dp0node_modules\\x\\bin\\opencode" %*\r\n');
  const out = doctor({ PATH: tmp, OPENCODE_BIN: '' });
  assert.ok(!/opencode[^\n]*READY/i.test(out), 'a script-only shim must not be READY:\n' + out);
});
