#!/usr/bin/env node
// test-worker.mjs: checks for worker.mjs routing. Plain node, no framework. Exit 1 on any FAIL.
//   node test-worker.mjs            offline checks, then two live checks (one tiny request each)
//   SKIP_LIVE=1 node test-worker.mjs  offline checks only
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'worker.mjs');
const ROUTING = path.join(here, '..', 'routing.json');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-worker-'));
let fails = 0;

const worker = (args, env = {}, timeout = 700000) => {
  const r = spawnSync(process.execPath, [WORKER, ...args], { encoding: 'utf8', env: { ...process.env, WORKER_FAIL_ROUTERS: '', ...env }, timeout });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const check = (name, fn) => {
  try { const r = fn(); if (r === true || r === undefined) console.log('PASS ' + name); else { fails++; console.log('FAIL ' + name + (typeof r === 'string' ? ': ' + r : '')); } }
  catch (e) { fails++; console.log('FAIL ' + name + ': ' + e.message); }
};
const mk = (name, content) => { const f = path.join(tmpRoot, name); fs.writeFileSync(f, content); return f; };
const tail = (s) => s.slice(-300).replace(/\s+/g, ' ');

try {
  let R;
  check('routing.json parses', () => { R = JSON.parse(fs.readFileSync(ROUTING, 'utf8')); return !!(R.kinds && R.models && R.claude_agents); });
  if (!R) process.exit(1);
  check('every model named in a pick exists', () => { const bad = []; for (const [k, v] of Object.entries(R.kinds)) for (const p of v.picks) if (p.model && !R.models[p.model]) bad.push(`${k}:${p.model}`); return bad.length ? 'missing ' + bad : true; });
  check('every claude pick exists in claude_agents', () => { const bad = []; for (const [k, v] of Object.entries(R.kinds)) for (const p of v.picks) if (p.claude && !R.claude_agents[p.claude]) bad.push(`${k}:${p.claude}`); return bad.length ? 'missing ' + bad : true; });
  check('every model has at least one route', () => { const bad = Object.entries(R.models).filter(([, m]) => !Array.isArray(m.routes) || !m.routes.length).map(([n]) => n); return bad.length ? 'no routes: ' + bad : true; });
  check('worker list still works', () => { const r = worker(['list']); return r.code === 0 || tail(r.out); });
  check('route prints every kind', () => { const r = worker(['route']); if (r.code !== 0) return tail(r.out); const miss = Object.keys(R.kinds).filter((k) => !r.out.includes(k)); return miss.length ? 'missing ' + miss : true; });
  check('route builder-iq prints details', () => { const r = worker(['route', 'builder-iq']); return (r.code === 0 && r.out.includes('use_when') && r.out.includes('review_with') && r.out.includes('claude:builder (haiku xhigh)')) || tail(r.out); });
  check('route with unknown kind fails', () => worker(['route', 'nope']).code !== 0);

  const brief = mk('brief.txt', 'Reply with exactly the word PONG.');
  const wdir = fs.mkdtempSync(path.join(tmpRoot, 'dry-'));
  check('run builder-iq --dry-run without --write fails', () => { const r = worker(['run', 'builder-iq', brief, '--dry-run']); return (r.code !== 0 && r.out.includes('--write')) || tail(r.out); });
  check('run trivial with --write fails (read-only kind)', () => worker(['run', 'trivial', brief, '--write', '--dry-run']).code !== 0);
  check('run builder-iq --write without --dir fails', () => worker(['run', 'builder-iq', brief, '--write', '--dry-run']).code !== 0);
  check('run builder-iq dry-run lists cloudflare then openrouter with #max', () => {
    const r = worker(['run', 'builder-iq', brief, '--write', '--dir', wdir, '--dry-run']);
    const c = r.out.indexOf('route cloudflare'); const o = r.out.indexOf('route openrouter');
    return (r.code === 0 && c >= 0 && o > c && /cloudflare-workers-ai[^\s]*#max/.test(r.out) && /openrouter\/[^\s]*#max/.test(r.out)) || tail(r.out);
  });
  check('run scout-deep with agy failing exits 3 and names scout', () => {
    const r = worker(['run', 'scout-deep', brief], { WORKER_FAIL_ROUTERS: 'agy' });
    return (r.code === 3 && /NEXT: spawn Claude agent "scout"/.test(r.out) && r.out.includes('route agy') && r.out.includes('forced failure (test hook)')) || `code ${r.code} ${tail(r.out)}`;
  });

  check('lock/verify round trip', () => {
    const a = mk('a.txt', 'alpha'); const b = mk('b.txt', 'beta'); const lock = path.join(tmpRoot, 'lock.json');
    let r = worker(['lock', a, b, '--out', lock]); if (r.code !== 0 || !fs.existsSync(lock)) return 'lock failed: ' + tail(r.out);
    r = worker(['verify', lock]); if (r.code !== 0 || !r.out.includes('OK 2 files unchanged')) return 'verify clean: ' + tail(r.out);
    fs.writeFileSync(a, 'alpha changed');
    r = worker(['verify', lock]); if (r.code !== 1 || !r.out.includes('CHANGED') || !r.out.includes(a)) return 'verify changed: ' + tail(r.out);
    fs.writeFileSync(a, 'alpha'); fs.unlinkSync(b);
    r = worker(['verify', lock]); if (r.code !== 1 || !r.out.includes('MISSING') || !r.out.includes(b)) return 'verify missing: ' + tail(r.out);
    return true;
  });

  if (process.env.SKIP_LIVE) console.log('SKIP live checks (SKIP_LIVE set)');
  else {
    check('live (a): run trivial replies PONG', () => {
      const r = worker(['run', 'trivial', brief, '--timeout', '240']);
      return (r.code === 0 && /PONG/i.test(r.out)) || `code ${r.code} ${tail(r.out)}`;
    });
    check('live (b): builder-iq falls back to openrouter and writes hello.txt', () => {
      const fresh = fs.mkdtempSync(path.join(tmpRoot, 'live-'));
      const b2 = mk('brief-write.txt', 'Create a file named hello.txt in the current directory containing exactly PONG, then stop.');
      const r = worker(['run', 'builder-iq', b2, '--write', '--dir', fresh, '--timeout', '300'], { WORKER_FAIL_ROUTERS: 'cloudflare' });
      const f = path.join(fresh, 'hello.txt');
      if (!(r.code === 0 && r.out.includes('via=openrouter'))) return `code ${r.code} ${tail(r.out)}`;
      if (!fs.existsSync(f)) return 'hello.txt not created; ' + tail(r.out);
      return fs.readFileSync(f, 'utf8').includes('PONG') || 'hello.txt lacks PONG';
    });
  }
} finally {
  // a worker process may hold its working directory for a moment on Windows: retry, then warn (not a check failure)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
  catch (e) { console.log('WARN could not delete ' + tmpRoot + ': ' + e.code); }
}
console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
