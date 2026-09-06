#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [model, effort, outputArg] = process.argv.slice(2);
if (!/^[A-Za-z0-9._-]+$/.test(model || '') || !/^(low|medium|high)$/.test(effort || '') || !outputArg) {
  throw new Error('usage: node scripts/eval/run-cursor-skill-eval-matrix.mjs <model> <low|medium|high> <output.json>');
}

const output = resolve(outputArg);
const evalRunner = process.env.CURSOR_EVAL_MATRIX_RUNNER
  ? resolve(process.env.CURSOR_EVAL_MATRIX_RUNNER)
  : resolve(repository, 'scripts/run-cursor-skill-eval.mjs');
const progressMs = process.env.CURSOR_EVAL_MATRIX_PROGRESS_MS === undefined
  ? 30_000 : Number(process.env.CURSOR_EVAL_MATRIX_PROGRESS_MS);
if (!Number.isSafeInteger(progressMs) || progressMs < 10 || progressMs > 30_000) {
  throw new Error('CURSOR_EVAL_MATRIX_PROGRESS_MS must be an integer from 10 through 30000');
}
const concurrency = process.env.CURSOR_EVAL_MATRIX_CONCURRENCY === undefined
  ? 8 : Number(process.env.CURSOR_EVAL_MATRIX_CONCURRENCY);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
  throw new Error('CURSOR_EVAL_MATRIX_CONCURRENCY must be an integer from 1 through 16');
}
const corpusPath = resolve(repository, 'evals/cursor-subagent-scenarios.v1.json');
const skillPath = resolve(repository, 'skills/cursor-subagent/SKILL.md');
const digest = async (path) => {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
};
const emit = (event) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), model, effort, ...event })}\n`);
const initial = { corpus: await digest(corpusPath), skill: await digest(skillPath) };
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const scenarioIds = corpus.scenarios.filter(({ lane }) => lane === 'model-behavior').map(({ scenario_id }) => scenario_id);

const runOne = async (scenarioId, index, attempt) => {
  const started = Date.now();
  emit({ event: 'scenario_started', scenario_id: scenarioId, index, total: scenarioIds.length, attempt });
  const child = spawn(process.execPath, [evalRunner, scenarioId], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_HOSTED_MODEL: model,
      CURSOR_EVAL_HOSTED_REASONING_EFFORT: effort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const progress = setInterval(() => emit({ event: 'scenario_progress', scenario_id: scenarioId,
    index, total: scenarioIds.length, attempt, elapsed_ms: Date.now() - started }), progressMs);
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, 'close');
  clearInterval(progress);
  const text = Buffer.concat(stdout).toString('utf8').trim();
  let result;
  try { result = JSON.parse(text.split('\n').at(-1)); }
  catch {
    result = { schema_version: 1, scenario_id: scenarioId, eval_status: 'integration_failure',
      error_code: 'matrix_child_output_invalid', message: Buffer.concat(stderr).toString('utf8').slice(-4_000),
      evidence_ref: null, actual_task_outcome: 'not_observed', reported_task_outcome: 'not_reported',
      fixture_assertion_outcome: 'not_observed', evidence_publication_status: 'not_attempted',
      cleanup_status: 'not_required', failure_stage: 'runner' };
  }
  const completed = { ...result, process: { code, signal, duration_ms: Date.now() - started } };
  emit({ event: 'scenario_completed', scenario_id: scenarioId, index, total: scenarioIds.length, attempt,
    eval_status: completed.eval_status, error_code: completed.error_code, duration_ms: completed.process.duration_ms });
  return completed;
};

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const results = Array(scenarioIds.length);
let nextOffset = 0;
emit({ event: 'matrix_started', total: scenarioIds.length, output, concurrency });
const worker = async () => {
  while (nextOffset < scenarioIds.length) {
    const offset = nextOffset++;
    const scenarioId = scenarioIds[offset];
    const index = offset + 1;
    const attempts = [];
    let result = await runOne(scenarioId, index, 1);
    attempts.push(result);
    if (result.eval_status === 'integration_failure') {
      emit({ event: 'scenario_retrying', scenario_id: scenarioId, index, total: scenarioIds.length, next_attempt: 2 });
      result = await runOne(scenarioId, index, 2);
      attempts.push(result);
    }
    results[offset] = { ...result, attempts: attempts.map(({ eval_status, error_code, process }) => ({ eval_status, error_code, process })) };
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, scenarioIds.length) }, () => worker()));
const final = { corpus: await digest(corpusPath), skill: await digest(skillPath) };
const counts = Object.fromEntries(['pass', 'agent_behavior_mismatch', 'integration_failure', 'skipped']
  .map((status) => [status, results.filter(({ eval_status }) => eval_status === status).length]));
const summary = {
  schema_version: 1, model, effort, concurrency, started_at: startedAt, finished_at: new Date().toISOString(),
  duration_ms: Date.now() - startedMs, initial, final, digest_stable: JSON.stringify(initial) === JSON.stringify(final),
  counts: { total: results.length, ...counts }, pass_rate: results.length ? counts.pass / results.length : 0,
  attempted_runs: results.reduce((sum, item) => sum + item.attempts.length, 0), results,
};
await writeFile(`${output}.tmp`, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
await rename(`${output}.tmp`, output);
emit({ event: 'matrix_completed', output, counts: summary.counts, pass_rate: summary.pass_rate,
  duration_ms: summary.duration_ms, digest_stable: summary.digest_stable });
process.exitCode = counts.pass === results.length && summary.digest_stable ? 0 : 1;
