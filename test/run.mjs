#!/usr/bin/env node
// Runs a group of suites: `node test/run.mjs fast` (npm test) or
// `node test/run.mjs ui` (npm run test:ui). Builds the sample database once,
// runs each suite in its own process (several at a time), then prints every
// failure and a summary. A check listed in test/known-bugs.json is a real app
// bug: it is expected to fail and doesn't fail the run, but if it starts to
// pass the run fails until it is taken off the list.
//
//   node test/run.mjs fast --only=security,roles   run some suites
//   RP_TEST_SUMMARY=out.json                        also write the results as JSON
//   RP_KEEP_TEMP=1                                  keep the temp folders
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBase, tempDir } from './lib/world.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const group = process.argv[2];
if (!['fast', 'ui'].includes(group)) { console.error('usage: node test/run.mjs fast|ui [--only=a,b]'); process.exit(2); }
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const dir = path.join(HERE, group);
const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''))
  .filter((s) => !only.length || only.includes(s)).sort();
const known = JSON.parse(fs.readFileSync(path.join(HERE, 'known-bugs.json'), 'utf8'));
const JOBS = Number(process.env.RP_TEST_JOBS || (group === 'fast' ? Math.min(4, os.cpus().length) : Math.min(3, os.cpus().length)));

const t0 = Date.now();
const fmt = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
console.log(`Reel Picks ${group === 'fast' ? 'fast' : 'browser'} tests: ${suites.length} suites, ${JOBS} at a time\n`);

const baseDir = tempDir('base');
let base;
try {
  base = await buildBase(baseDir);
  console.log(`sample database built in ${fmt(base.builtMs)}\n`);
} catch (e) {
  console.error(`could not build the sample database: ${e.stack || e}`);
  process.exit(1);
}

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(dir, `${name}.mjs`)], {
      env: { ...process.env, RP_TEST_BASE: baseDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('@@RESULT '));
      let result = null;
      try { result = line ? JSON.parse(line.slice(9)) : null; } catch { /* broken line */ }
      if (!result) result = { suite: name, checks: [{ id: 'the suite ran to the end', ok: false, detail: `exit ${code}: ${out.slice(-800)}` }], servers: [], unanswered: [] };
      result.ms = Date.now() - started;
      result.output = out.split('\n').filter((l) => !l.startsWith('@@RESULT ')).join('\n');
      resolve(result);
    });
  });
}

// The installed-app update checks time real page loads in WebKit; they run on
// their own after the others, so a busy machine can't slow them past their limits.
const SOLO = new Set(['sw']);
const results = [];
const report = (r) => {
  results.push(r);
  const bad = r.checks.filter((c) => !c.ok).length;
  console.log(`${bad ? '✗' : '✓'} ${r.suite.padEnd(12)} ${String(r.checks.length - bad).padStart(4)}/${String(r.checks.length).padEnd(4)} ${fmt(r.ms)}`);
};
const queue = suites.filter((s) => !SOLO.has(s));
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  while (queue.length) report(await runSuite(queue.shift()));
}));
for (const name of suites.filter((s) => SOLO.has(s))) report(await runSuite(name));
results.sort((a, b) => a.suite.localeCompare(b.suite));

// Known bugs: expected to fail.
const failures = []; const knownHit = []; const knownFixed = [];
for (const r of results) {
  // No test server may have asked the outside world for anything unanswered.
  const un = r.unanswered || [];
  r.checks.push({ id: 'every outside request was answered from saved samples', ok: un.length === 0, detail: un.slice(0, 5).map((e) => `${e.how} ${e.host}${e.path}`).join(', ') });
  for (const c of r.checks) {
    const id = `${r.suite}: ${c.id}`;
    if (known[id]) (c.ok ? knownFixed : knownHit).push({ id, why: known[id], detail: c.detail });
    else if (!c.ok) failures.push({ id, detail: c.detail });
  }
}
const missingKnown = Object.keys(known).filter((id) => suites.includes(id.split(':')[0]) && !results.some((r) => r.checks.some((c) => `${r.suite}: ${c.id}` === id)));

if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.id}${f.detail ? `\n      ${f.detail.replace(/\n/g, '\n      ')}` : ''}`);
}
if (knownHit.length) {
  console.log('\nKnown app bugs (expected to fail, see test/known-bugs.json):');
  for (const k of knownHit) console.log(`  • ${k.id}\n      ${k.why}`);
}
if (knownFixed.length) {
  console.log('\nKnown bugs that now pass (take them off test/known-bugs.json):');
  for (const k of knownFixed) console.log(`  ✗ ${k.id}`);
}
if (missingKnown.length) {
  console.log('\nKnown bugs whose check no longer exists (take them off test/known-bugs.json):');
  for (const k of missingKnown) console.log(`  ✗ ${k}`);
}

const total = results.reduce((n, r) => n + r.checks.length, 0);
const ok = !failures.length && !knownFixed.length && !missingKnown.length;
const ms = Date.now() - t0;
console.log(`\n${total - failures.length - knownHit.length - knownFixed.length} passed, ${failures.length} failed, ${knownHit.length} known bugs, in ${fmt(ms)}`);
if (process.env.RP_TEST_SUMMARY) {
  fs.writeFileSync(process.env.RP_TEST_SUMMARY, JSON.stringify({
    group, ok, ms, suites: results.map(({ output, ...r }) => r), failures, knownHit, knownFixed, missingKnown,
  }, null, 2));
}
if (!process.env.RP_KEEP_TEMP) fs.rmSync(baseDir, { recursive: true, force: true });
if (failures.length && process.env.RP_TEST_VERBOSE) for (const r of results) if (r.checks.some((c) => !c.ok)) console.log(`\n----- ${r.suite}\n${r.output}`);
console.log(ok ? `${group.toUpperCase()} TESTS OK` : `${group.toUpperCase()} TESTS FAILED`);
process.exit(ok ? 0 : 1);
