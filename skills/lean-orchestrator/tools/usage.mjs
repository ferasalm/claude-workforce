#!/usr/bin/env node
// usage.mjs: read the plan-usage snapshot that the status line saves and report it, or measure a task's cost.
//
//   node usage.mjs                 one line: 5h <p>% (resets in h:mm) | 7d <p>% (resets in h:mm) | age <n> min [| STALE]
//   node usage.mjs --start [--file F]   save the current 5h and 7d percentages (default ./.usage-start.json)
//   node usage.mjs --end   [--file F]   print the change since --start, then a CSV fragment for METRICS.csv:
//                                       used since start: 5h +6% 7d +9%
//                                       d5h_pct,d7d_pct
//                                       6,9
//
// The snapshot is ~/.claude/usage-snapshot.json (written by statusline/usage-snapshot.mjs from an open
// interactive Claude Code session). STALE means it is older than 30 minutes: then ask the user for the numbers.
// Exit 0 ok; 2 when the snapshot or the start file is missing. Never invents a number.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SNAPSHOT = path.join(os.homedir(), '.claude', 'usage-snapshot.json');
const STALE_MIN = 30;
const NO_SNAPSHOT = 'no snapshot: ask the user for their usage numbers';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const fileIdx = argv.indexOf('--file');
const startFile = path.resolve(fileIdx >= 0 && argv[fileIdx + 1] ? argv[fileIdx + 1] : '.usage-start.json');

function readSnapshot() {
  try {
    const s = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (w) => { const v = num(w && w.used_percentage); return v === null ? null : Math.round(v); };
const left = (w, nowSec) => {
  const at = num(w && w.resets_at);
  if (at === null) return '?';
  const sec = Math.max(0, Math.floor(at - nowSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
};

function savedAtSec(s) {
  const e = num(s.saved_at_epoch);
  if (e !== null) return e;
  const t = Date.parse(s.saved_at);
  return Number.isNaN(t) ? null : t / 1000;
}

const snap = readSnapshot();
if (!snap) {
  console.log(NO_SNAPSHOT);
  process.exit(2);
}
const limits = snap.rate_limits || {};
const five = limits.five_hour;
const seven = limits.seven_day;
const p5 = pct(five);
const p7 = pct(seven);
const nowSec = Date.now() / 1000;

if (has('--start')) {
  fs.writeFileSync(startFile, JSON.stringify({ '5h': p5, '7d': p7, saved_at: new Date().toISOString() }, null, 2) + '\n');
  console.log(`usage start saved: 5h ${p5 ?? '?'}% 7d ${p7 ?? '?'}%`);
  process.exit(0);
}

if (has('--end')) {
  let start;
  try {
    start = JSON.parse(fs.readFileSync(startFile, 'utf8'));
  } catch {
    console.error('no start file: run usage.mjs --start first');
    process.exit(2);
  }
  const d5 = p5 === null || num(start['5h']) === null ? null : p5 - start['5h'];
  const d7 = p7 === null || num(start['7d']) === null ? null : p7 - start['7d'];
  const sign = (d) => (d === null ? '?' : `${d >= 0 ? '+' : ''}${d}`);
  console.log(`used since start: 5h ${sign(d5)}% 7d ${sign(d7)}%`);
  console.log('d5h_pct,d7d_pct');
  console.log(`${d5 ?? ''},${d7 ?? ''}`);
  process.exit(0);
}

const saved = savedAtSec(snap);
const ageMin = saved === null ? null : Math.max(0, Math.floor((nowSec - saved) / 60));
const parts = [
  `5h ${p5 === null ? '?' : p5 + '%'} (resets in ${left(five, nowSec)})`,
  `7d ${p7 === null ? '?' : p7 + '%'} (resets in ${left(seven, nowSec)})`,
  `age ${ageMin === null ? '?' : ageMin} min`,
];
if (ageMin === null || ageMin > STALE_MIN) parts.push('STALE');
console.log(parts.join(' | '));
