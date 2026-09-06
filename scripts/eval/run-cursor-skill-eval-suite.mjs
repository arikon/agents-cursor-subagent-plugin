#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [planArg, outputArg] = process.argv.slice(2);
if (!planArg || !outputArg || process.argv.length !== 4) {
  throw new Error('usage: node scripts/eval/run-cursor-skill-eval-suite.mjs <plan.json> <output.json>');
}

const planPath = resolve(planArg);
const output = resolve(outputArg);
const matrixRunner = process.env.CURSOR_EVAL_SUITE_MATRIX_RUNNER
  ? resolve(process.env.CURSOR_EVAL_SUITE_MATRIX_RUNNER)
  : resolve(repository, 'scripts/eval/run-cursor-skill-eval-matrix.mjs');
const concurrency = process.env.CURSOR_EVAL_SUITE_CONCURRENCY === undefined
  ? 3 : Number(process.env.CURSOR_EVAL_SUITE_CONCURRENCY);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) {
  throw new Error('CURSOR_EVAL_SUITE_CONCURRENCY must be an integer from 1 through 3');
}

const plan = JSON.parse(await readFile(planPath, 'utf8'));
if (plan?.schema_version !== 1 || typeof plan.name !== 'string' || !Array.isArray(plan.rows) || plan.rows.length === 0) {
  throw new Error('plan must be a v1 object with nonempty name and rows');
}
const seen = new Set();
for (const row of plan.rows) {
  if (!/^[A-Za-z0-9._-]+$/.test(row?.model || '') || !/^(low|medium|high)$/.test(row?.effort || '')) {
    throw new Error('each plan row requires a safe model and low, medium, or high effort');
  }
  const key = `${row.model}/${row.effort}`;
  if (seen.has(key)) throw new Error(`duplicate plan row: ${key}`);
  seen.add(key);
}

const outputStem = basename(output, extname(output));
const rowDirectory = resolve(dirname(output), `${outputStem}.rows`);
const emit = (event) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const results = Array(plan.rows.length);

const runRow = async (row, index) => {
  const rowOutput = resolve(rowDirectory, `${row.model}-${row.effort}.json`);
  const started = Date.now();
  emit({ event: 'row_started', index, total: plan.rows.length, model: row.model, effort: row.effort, output: rowOutput });
  const child = spawn(process.execPath, [matrixRunner, row.model, row.effort, rowOutput], {
    cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => {
    stdout.push(chunk);
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line) continue;
      try { emit({ event: 'row_progress', index, total: plan.rows.length, model: row.model, effort: row.effort, matrix_event: JSON.parse(line) }); }
      catch { /* matrix output is validated below; preserve the bounded error instead of guessing */ }
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, 'close');
  let summary = null;
  let error = null;
  try { summary = JSON.parse(await readFile(rowOutput, 'utf8')); }
  catch { error = Buffer.concat(stderr).toString('utf8').slice(-4_000) || 'matrix summary was not published'; }
  const result = { ...row, output: rowOutput, process: { code, signal, duration_ms: Date.now() - started }, summary, error };
  emit({ event: 'row_completed', index, total: plan.rows.length, model: row.model, effort: row.effort,
    eval_status: summary?.counts?.pass === summary?.counts?.total && summary?.digest_stable ? 'pass' : 'failed',
    duration_ms: result.process.duration_ms });
  return result;
};

await mkdir(rowDirectory);
let nextOffset = 0;
emit({ event: 'suite_started', plan: plan.name, total: plan.rows.length, concurrency, output });
const worker = async () => {
  while (nextOffset < plan.rows.length) {
    const offset = nextOffset++;
    results[offset] = await runRow(plan.rows[offset], offset + 1);
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, plan.rows.length) }, () => worker()));
const counts = { total: results.length, passed: 0, failed: 0 };
for (const result of results) {
  if (result.summary?.counts?.pass === result.summary?.counts?.total && result.summary?.digest_stable) counts.passed += 1;
  else counts.failed += 1;
}
const summary = { schema_version: 1, plan: { name: plan.name, rows: plan.rows }, concurrency,
  started_at: startedAt, finished_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
  counts, results };
await writeFile(`${output}.tmp`, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
await rename(`${output}.tmp`, output);
emit({ event: 'suite_completed', output, counts, duration_ms: summary.duration_ms });
process.exitCode = counts.failed === 0 ? 0 : 1;
