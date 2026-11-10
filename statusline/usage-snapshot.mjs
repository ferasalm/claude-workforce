#!/usr/bin/env node
// usage-snapshot.mjs: a Claude Code status line command that also saves your plan usage to disk.
//
// Claude Code runs it after each turn and sends a JSON status on stdin. It prints one plain line
//   <model> | ctx <p>% | 5h <p>% (resets h:mm) | 7d <p>%
// (h:mm = time left until the window resets) and writes ~/.claude/usage-snapshot.json
//   { saved_at, saved_at_epoch, rate_limits }
// so a model, which cannot run /usage itself, can read the account limits with tools/usage.mjs.
// The snapshot is only rewritten when the status carries rate_limits. It never throws and always exits 0.
//
// Install: node install.mjs --statusline   (or set "statusLine" in ~/.claude/settings.json yourself)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function left(at, nowSec) {
  const sec = Math.max(0, Math.floor(at - nowSec));
  return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
}

function render(j) {
  const nowSec = Date.now() / 1000;
  const model = (j.model && (j.model.display_name || j.model.id)) || 'claude';
  const out = [String(model)];
  const used = num(j.context_window && j.context_window.used_percentage);
  if (used !== null) out.push(`ctx ${Math.round(used)}%`);
  const rl = j.rate_limits;
  if (rl && typeof rl === 'object') {
    for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
      const p = num(rl[key] && rl[key].used_percentage);
      if (p === null) continue;
      const at = num(rl[key].resets_at);
      out.push(`${label} ${Math.round(p)}%` + (label === '5h' && at !== null ? ` (resets ${left(at, nowSec)})` : ''));
    }
  }
  return out.join(' | ');
}

function save(j) {
  if (!j.rate_limits || typeof j.rate_limits !== 'object') return;
  const dir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const snap = { saved_at: new Date(now).toISOString(), saved_at_epoch: Math.floor(now / 1000), rate_limits: j.rate_limits };
  fs.writeFileSync(path.join(dir, 'usage-snapshot.json'), JSON.stringify(snap, null, 2) + '\n');
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
let line = 'claude';
try {
  const j = JSON.parse(raw);
  if (j && typeof j === 'object') {
    line = render(j);
    try { save(j); } catch { /* a status line must never fail */ }
  }
} catch { /* invalid JSON: fallback line */ }
console.log(line);
process.exit(0);
