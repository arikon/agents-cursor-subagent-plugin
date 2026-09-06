import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const matrix = fileURLToPath(new URL('../scripts/eval/run-cursor-skill-eval-matrix.mjs', import.meta.url));
const suite = fileURLToPath(new URL('../scripts/eval/run-cursor-skill-eval-suite.mjs', import.meta.url));
const fakeChild = fileURLToPath(new URL('./fixtures/fake-eval-matrix-child.mjs', import.meta.url));

test('eval matrix emits per-scenario progress and writes atomic aggregate statistics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-matrix-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'summary.json');
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-sol', 'low', output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, CURSOR_EVAL_MATRIX_PROGRESS_MS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const events = Buffer.concat(stdout).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.counts.total, 24);
  assert.equal(summary.counts.pass, 24);
  assert.equal(summary.pass_rate, 1);
  assert.equal(summary.concurrency, 8);
  assert.equal(summary.digest_stable, true);
  assert.equal(events.filter(({ event }) => event === 'scenario_started').length, 24);
  assert.equal(events.filter(({ event }) => event === 'scenario_completed').length, 24);
  assert.ok(events.filter(({ event }) => event === 'scenario_progress').length >= 24);
  assert.equal(events.at(0).event, 'matrix_started');
  assert.equal(events.at(-1).event, 'matrix_completed');
  const firstCompletion = events.findIndex(({ event }) => event === 'scenario_completed');
  assert.equal(events.slice(0, firstCompletion).filter(({ event }) => event === 'scenario_started').length, 8);
  assert.deepEqual(events.filter(({ event }) => event === 'scenario_started').map(({ index }) => index).sort((a, b) => a - b),
    Array.from({ length: 24 }, (_, index) => index + 1));
});

test('eval suite runs saved model rows with default parallelism and preserves every row result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-suite-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = join(root, 'plan.json');
  const output = join(root, 'summary.json');
  await writeFile(plan, `${JSON.stringify({ schema_version: 1, name: 'fixture', rows: [
    { model: 'gpt-5.6-sol', effort: 'low' },
    { model: 'gpt-5.6-terra', effort: 'medium' },
    { model: 'gpt-5.6-luna', effort: 'high' },
  ] })}\n`);
  const child = spawn(process.execPath, [suite, plan, output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_SUITE_MATRIX_RUNNER: matrix, CURSOR_EVAL_MATRIX_RUNNER: fakeChild,
      CURSOR_EVAL_MATRIX_PROGRESS_MS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const events = Buffer.concat(stdout).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(summary.counts, { total: 3, passed: 3, failed: 0 });
  assert.equal(summary.concurrency, 3);
  assert.equal(events.at(0).event, 'suite_started');
  assert.equal(events.at(-1).event, 'suite_completed');
  assert.equal(events.filter(({ event }) => event === 'row_started').length, 3);
  for (const row of summary.results) {
    assert.equal(row.summary.counts.pass, 24);
    assert.equal(row.summary.digest_stable, true);
    await readFile(row.output, 'utf8');
  }
});
