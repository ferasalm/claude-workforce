#!/usr/bin/env node
// next-chat.mjs: open a NEW terminal window that starts a fresh Claude Code session which continues from a handoff file.
// Use it when this session's context is large (about 200k tokens) and the work is not finished.
//
//   node next-chat.mjs --handoff <file> [--model opus] [--effort xhigh] [--agent lead] [--cwd D] [--dry-run]
//
// The new window runs:  claude --model M --effort E --agent A "Read the handoff file at <abs path> and continue it under its rules."
// with CLAUDE_CODE_CHILD_SESSION removed (otherwise the new session thinks it is a child of this one).
// --dry-run prints four lines (command, cwd, env removed, launcher) and launches nothing.
// Launchers: Windows wt.exe (else powershell), macOS Terminal through osascript, Linux x-terminal-emulator or gnome-terminal,
// else the command is only printed. Exit 0 on launch or dry run, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const dryRun = argv.includes('--dry-run');
const fail = (msg) => { console.error('[next-chat] ' + msg); process.exit(2); };

const handoffArg = flag('handoff');
if (!handoffArg) fail('missing --handoff <file>: the handoff file the new session should read');
const handoff = path.resolve(handoffArg);
if (!fs.existsSync(handoff)) fail(`handoff file not found: ${handoff}`);
const model = flag('model', 'opus');
const effort = flag('effort', 'xhigh');
const agent = flag('agent', 'lead');
const cwd = path.resolve(flag('cwd', process.cwd()));
const prompt = `Read the handoff file at ${handoff.replace(/\\/g, '/')} and continue it under its rules.`;
const command = `claude --model ${model} --effort ${effort} --agent ${agent} "${prompt}"`;
const ENV_VAR = 'CLAUDE_CODE_CHILD_SESSION';

const onPath = (name) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
  return r.status === 0;
};
function pickLauncher() {
  if (process.platform === 'win32') return onPath('wt.exe') ? 'wt' : 'powershell';
  if (process.platform === 'darwin') return 'osascript';
  if (onPath('x-terminal-emulator')) return 'x-terminal-emulator';
  if (onPath('gnome-terminal')) return 'gnome-terminal';
  return 'print';
}
const launcher = pickLauncher();

if (dryRun) {
  console.log(`[next-chat] command: ${command}`);
  console.log(`[next-chat] cwd: ${cwd}`);
  console.log(`[next-chat] env removed: ${ENV_VAR}`);
  console.log(`[next-chat] launcher: ${launcher}`);
  process.exit(0);
}

const env = { ...process.env };
delete env[ENV_VAR];
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const detach = (bin, args, opts = {}) => {
  const child = spawn(bin, args, { env, detached: true, stdio: 'ignore', ...opts });
  child.on('error', (e) => { console.error(`[next-chat] could not start ${bin}: ${e.message}`); console.error(`Run this yourself:\n${command}`); process.exit(1); });
  child.unref();
};

if (launcher === 'wt' || launcher === 'powershell') {
  const ps = `Remove-Item Env:${ENV_VAR} -ErrorAction SilentlyContinue; Set-Location -LiteralPath ${psQuote(cwd)}; ${command}`;
  if (launcher === 'wt') detach('wt.exe', ['-d', cwd, 'powershell', '-NoExit', '-Command', ps]);
  else detach('cmd.exe', ['/c', 'start', '', 'powershell', '-NoExit', '-Command', ps], { windowsHide: false });
} else if (launcher === 'osascript') {
  const line = `cd ${shQuote(cwd)} && unset ${ENV_VAR} && ${command}`;
  const as = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  detach('osascript', ['-e', `tell application "Terminal" to do script "${as}"`, '-e', 'tell application "Terminal" to activate']);
} else if (launcher === 'x-terminal-emulator' || launcher === 'gnome-terminal') {
  const line = `cd ${shQuote(cwd)} && unset ${ENV_VAR}; ${command}; exec "$SHELL"`;
  if (launcher === 'gnome-terminal') detach('gnome-terminal', ['--', 'bash', '-lc', line]);
  else detach('x-terminal-emulator', ['-e', 'bash', '-lc', line]);
} else {
  console.log('[next-chat] no terminal launcher found. Open a new terminal and run:');
  console.log(`cd ${cwd}`);
  console.log(command);
}
console.log(`[next-chat] launched: ${launcher}`);
process.exit(0);
