#!/usr/bin/env node
// check.mjs: the one gate for this repo. One "ok <step>" or "FAIL <step>" line per step; after a FAIL at most
// 12 lines of detail (indented two spaces). Exit 0 only when every step is ok and at least one step ran.
//
//   node check.mjs [--root R] [--skip-tests]
//
// Steps: tests (node --test of R/test), routing (routing.json parses and has kinds, models, claude_agents),
// agents (frontmatter model and effort equal routing.json claude_agents), effort (no haiku at low effort),
// lead-size (skills/lead/SKILL.md under 130 lines), lessons-size (LESSONS.md under 60 lines),
// model-names (no non-Claude model id from routing.json appears in skills/**/*.md or agents/*.md).
// Default root is three folders above this file. Paths that do not exist are skipped, not failed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const ROOT = path.resolve(rootIdx >= 0 && argv[rootIdx + 1] ? argv[rootIdx + 1] : path.join(here, '..', '..', '..'));
const skipTests = argv.includes('--skip-tests');

const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');
const lineCount = (text) => (text.length === 0 ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length);

function walk(dir, test, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*?)\s*$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fm;
}

const routingPath = path.join(ROOT, 'skills', 'lean-orchestrator', 'routing.json');
let routing = null;
let routingError = '';
try {
  routing = JSON.parse(read(routingPath));
  for (const key of ['kinds', 'models', 'claude_agents']) {
    if (!routing[key] || typeof routing[key] !== 'object') throw new Error(`routing.json has no "${key}" object`);
  }
} catch (e) {
  routing = null;
  routingError = exists(routingPath) ? `routing.json is not usable: ${e.message}` : `routing.json not found: ${routingPath}`;
}

const agentFiles = () => walk(path.join(ROOT, 'agents'), (n) => n.endsWith('.md')).filter((f) => !/^(lead|lean-orchestrator)\.md$/.test(path.basename(f)));

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

if (!skipTests) {
  step('tests', () => {
    const files = walk(path.join(ROOT, 'test'), (n) => /\.test\.m?js$/.test(n));
    if (!files.length) return ['no test files found in ' + path.join(ROOT, 'test')];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // a nested node --test would otherwise think it is a child run and skip its files
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return [];
    const all = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter((l) => l.trim() !== '');
    return all.slice(-12);
  });
}

step('routing', () => (routing ? [] : [routingError]));

step('agents', () => {
  const files = agentFiles();
  if (!files.length) return [];
  if (!routing) return [routingError];
  const bad = [];
  for (const f of files) {
    const name = path.basename(f, '.md');
    const fm = frontmatter(read(f));
    const want = routing.claude_agents[name];
    if (!fm || !fm.model || !fm.effort) bad.push(`${path.basename(f)}: needs model: and effort: in its frontmatter`);
    else if (!want) bad.push(`${path.basename(f)}: not listed in routing.json claude_agents`);
    else if (fm.model !== want.model || fm.effort !== want.effort) bad.push(`${path.basename(f)}: has ${fm.model} ${fm.effort}, routing.json says ${want.model} ${want.effort}`);
  }
  return bad;
});

step('effort', () => {
  const bad = [];
  const low = (m, e) => /haiku/i.test(String(m)) && /^low$/i.test(String(e));
  for (const [name, a] of Object.entries((routing && routing.claude_agents) || {})) if (low(a.model, a.effort)) bad.push(`routing.json claude_agents.${name}: haiku at low effort`);
  for (const f of agentFiles()) {
    const fm = frontmatter(read(f));
    if (fm && low(fm.model, fm.effort)) bad.push(`${path.basename(f)}: haiku at low effort`);
  }
  return bad;
});

const sizeStep = (name, rel, limit) => step(name, () => {
  const p = path.join(ROOT, ...rel);
  if (!exists(p)) return [];
  const n = lineCount(read(p));
  return n < limit ? [] : [`${rel.join('/')} has ${n} lines, limit is under ${limit}`];
});
sizeStep('lead-size', ['skills', 'lead', 'SKILL.md'], 130);
sizeStep('lessons-size', ['skills', 'lean-orchestrator', 'LESSONS.md'], 60);

step('model-names', () => {
  if (!routing) return [routingError];
  const ids = new Set();
  for (const m of Object.values(routing.models)) {
    for (const r of (m && m.routes) || []) for (const k of ['id', 'oc', 'agy']) if (typeof r[k] === 'string' && r[k]) ids.add(r[k]);
  }
  const docs = [
    ...walk(path.join(ROOT, 'skills'), (n) => n.endsWith('.md')),
    ...walk(path.join(ROOT, 'agents'), (n) => n.endsWith('.md')),
  ];
  const bad = [];
  for (const f of docs) {
    const text = read(f);
    for (const id of ids) if (text.includes(id)) bad.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}: names model id ${id} (model names live only in routing.json)`);
  }
  return bad;
});

let failed = 0;
for (const s of steps) {
  let detail;
  try { detail = s.fn(); } catch (e) { detail = [`check crashed: ${e.message}`]; }
  if (!detail.length) { console.log(`ok ${s.name}`); continue; }
  failed++;
  console.log(`FAIL ${s.name}`);
  for (const line of detail.slice(-12)) console.log('  ' + line);
}
if (!steps.length) { console.log('FAIL no checks ran'); process.exit(1); }
process.exit(failed ? 1 : 0);
