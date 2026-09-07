#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEvalResultV1, assertEvidenceManifestV1, EVAL_LIMITS, readEvaluatorInventory } from '../cursor-skill-eval.mjs';
import { canonicalJson, parseScenarioCorpus } from '../cursor-eval-scenario.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [model, effort, outputArg] = process.argv.slice(2);
if (!/^[A-Za-z0-9._-]+$/.test(model || '') || !/^(low|medium|high)$/.test(effort || '') || !outputArg) {
  throw new Error('usage: node scripts/eval/run-cursor-skill-eval-matrix.mjs <model> <low|medium|high> <output.json>');
}

const output = resolve(outputArg);
const artifactRoot = `${output}.artifacts`;
const bundleRoot = dirname(output);
const bundlePath = (path) => relative(bundleRoot, path);
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
const serial = process.env.CURSOR_EVAL_MATRIX_SERIAL === undefined
  ? 1 : Number(process.env.CURSOR_EVAL_MATRIX_SERIAL);
if (!Number.isSafeInteger(serial) || serial < 1 || serial > 10) {
  throw new Error('CURSOR_EVAL_MATRIX_SERIAL must be an integer from 1 through 10');
}
const corpusPath = resolve(repository, 'evals/cursor-subagent-scenarios.v1.json');
const skillPath = resolve(repository, 'skills/cursor-subagent/SKILL.md');
const digest = async (path) => {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
};
const emit = (event) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), model, effort, ...event })}\n`);
const inventory = await readEvaluatorInventory();
const initial = { corpus: await digest(corpusPath), skill: await digest(skillPath), evaluator: inventory.digest };
const corpus = parseScenarioCorpus(await readFile(corpusPath));
const scenarioIds = corpus.scenarios.filter(({ lane }) => lane === 'model-behavior').map(({ scenario_id }) => scenario_id);
await mkdir(bundleRoot, { recursive: true });
await mkdir(artifactRoot);
let candidate = null;
const candidatePath = resolve(artifactRoot, 'candidate.json');
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const bindCandidate = (manifest) => {
  assertEvidenceManifestV1(manifest);
  if (!manifest || !same(manifest.evaluator, initial.evaluator) || !same(manifest.corpus, initial.corpus)
    || !same(manifest.installed_skill, initial.skill) || !manifest.client?.version
    || !manifest.installed_payload?.payload_hash || !manifest.adapter?.sha256) throw new Error('child candidate proof differs from frozen inputs');
  const payload = { evaluator: manifest.evaluator, corpus: manifest.corpus, skill: manifest.installed_skill,
    adapter: manifest.adapter, package_payload: manifest.installed_payload.payload_hash, client: manifest.client };
  const encoded = Buffer.from(canonicalJson(payload));
  const observed = { sha256: createHash('sha256').update(encoded).digest('hex'), bytes: encoded.length };
  if (candidate && !same(candidate.digest, observed)) throw new Error('child candidate drift within matrix');
  candidate ||= { schema_version: 1, digest: observed, payload, inputs: inventory.files, selected_runner: inventory.selected_runner };
};

const runOne = async (scenarioId, index, attempt, serialIndex) => {
  const started = Date.now();
  const attemptArtifactRoot = resolve(artifactRoot, `serial-${serialIndex}`, `${scenarioId.replace(/[^A-Za-z0-9._-]/g, '_')}-attempt-${attempt}`);
  await mkdir(attemptArtifactRoot, { recursive: true });
  if (interrupted) return null;
  emit({ event: 'scenario_started', serial_index: serialIndex, serial, scenario_id: scenarioId, index, total: scenarioIds.length, attempt });
  const child = spawn(process.execPath, [evalRunner, scenarioId], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_HOSTED_MODEL: model,
      CURSOR_EVAL_HOSTED_REASONING_EFFORT: effort, NODE_TEST_ARTIFACT_ROOT: attemptArtifactRoot,
      CURSOR_EVAL_EVALUATOR_SHA256: initial.evaluator.sha256, CURSOR_EVAL_EVALUATOR_BYTES: String(initial.evaluator.bytes),
      CURSOR_EVAL_EVIDENCE_ROOT: resolve(attemptArtifactRoot, 'evidence') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  const progress = setInterval(() => emit({ event: 'scenario_progress', serial_index: serialIndex, serial, scenario_id: scenarioId,
    index, total: scenarioIds.length, attempt, elapsed_ms: Date.now() - started }), progressMs);
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, 'close');
  activeChildren.delete(child);
  clearInterval(progress);
  await Promise.all([
    writeFile(resolve(attemptArtifactRoot, 'driver-stdout.txt'), Buffer.concat(stdout), { flag: 'wx' }),
    writeFile(resolve(attemptArtifactRoot, 'driver-stderr.txt'), Buffer.concat(stderr), { flag: 'wx' }),
  ]);
  const text = Buffer.concat(stdout).toString('utf8').trim();
  let result;
  try {
    if (Buffer.concat(stdout).length > EVAL_LIMITS.stdoutBytes) throw new Error('child stdout exceeds its byte limit');
    result = assertEvalResultV1(JSON.parse(text));
    if (result.scenario_id !== scenarioId || result.lane !== 'model-behavior') throw new Error('wrong scenario result');
    if (result.eval_status === 'skipped') throw new Error('enabled matrix scenario cannot be skipped');
    if (result.eval_status === 'pass' && (code !== 0 || signal)) throw new Error('passing result without successful child close');
    if (['agent_behavior_mismatch', 'integration_failure'].includes(result.eval_status)
      && (!Number.isInteger(code) || code === 0 || signal !== null)) throw new Error('failing result without failed child close');
  }
  catch {
    result = { schema_version: 1, scenario_id: scenarioId, lane: 'model-behavior', eval_status: 'integration_failure',
      error_code: 'matrix_child_output_invalid', message: [...Buffer.concat(stderr).toString('utf8')].slice(-2_000).join(''),
      evidence_ref: null, actual_task_outcome: 'not_observed', reported_task_outcome: 'not_checked',
      fixture_assertion_outcome: 'not_observed', evidence_publication_status: 'not_attempted',
      cleanup_status: 'not_required', failure_stage: 'runner' };
  }
  if (result.evidence_ref) {
    const childEvidenceRef = result.evidence_ref;
    const childResult = result;
    result = { ...result, evidence_ref: null, evidence_publication_status: 'failed' };
    try {
      const evidencePath = resolve(childEvidenceRef);
      const rel = relative(attemptArtifactRoot, evidencePath);
      if (rel.startsWith('..') || rel === '') throw new Error('evidence is outside this attempt');
      const evidenceBytes = await readFile(evidencePath);
      if (evidenceBytes.length > EVAL_LIMITS.evidenceBytes) throw new Error('published evidence exceeds its byte limit');
      const evidence = JSON.parse(evidenceBytes.toString('utf8'));
      if (evidence.schema_version !== 1) throw new Error('unsupported published evidence version');
      assertEvalResultV1(evidence.final_result);
      if (evidence.scenario_id !== scenarioId || evidence.lane !== childResult.lane
        || !same(evidence.final_result, { ...childResult, evidence_ref: basename(evidencePath) })) throw new Error('published evidence does not match the child verdict');
      result.evidence_ref = bundlePath(evidencePath);
      result.evidence_publication_status = 'published';
      bindCandidate(evidence.manifest);
    } catch (error) {
      result = { ...result, eval_status: 'integration_failure', failure_stage: 'inspection',
        error_code: 'matrix_candidate_evidence_invalid', message: error.message };
    }
  } else if (result.eval_status === 'pass') {
    result = { ...result, eval_status: 'integration_failure', failure_stage: 'inspection',
      error_code: 'matrix_candidate_evidence_missing', message: 'passing child has no candidate evidence' };
  }
  try { assertEvalResultV1(result); }
  catch {
    result = { ...result, eval_status: 'integration_failure', failure_stage: 'inspection',
      error_code: 'matrix_result_invalid', message: 'matrix result exceeded the public result contract',
      evidence_ref: null, evidence_publication_status: 'failed' };
    assertEvalResultV1(result);
  }
  const completed = { ...result, process: { code, signal, duration_ms: Date.now() - started, artifact_root: bundlePath(attemptArtifactRoot) } };
  emit({ event: 'scenario_completed', serial_index: serialIndex, serial, scenario_id: scenarioId, index, total: scenarioIds.length, attempt,
    eval_status: completed.eval_status, error_code: completed.error_code, duration_ms: completed.process.duration_ms });
  return completed;
};

let interrupted = false;
const activeChildren = new Set();
const interrupt = (signal) => {
  if (interrupted) return;
  interrupted = true;
  for (const child of activeChildren) child.kill(signal);
};
const onInterrupt = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
const runMatrix = async (serialIndex) => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const results = Array(scenarioIds.length);
  let nextOffset = 0;
  emit({ event: 'matrix_started', serial_index: serialIndex, serial, total: scenarioIds.length, output, concurrency });
  const worker = async () => {
    while (!interrupted && nextOffset < scenarioIds.length) {
      const offset = nextOffset++;
      const scenarioId = scenarioIds[offset];
      const index = offset + 1;
      const attempts = [];
      let result = await runOne(scenarioId, index, 1, serialIndex);
      if (result === null) break;
      attempts.push(result);
      results[offset] = {
        ...result,
        artifact_root: result.process.artifact_root,
        attempts: attempts.map(({ eval_status, error_code, process }) => ({ eval_status, error_code, process })),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarioIds.length) }, () => worker()));
  const final = { corpus: await digest(corpusPath), skill: await digest(skillPath), evaluator: (await readEvaluatorInventory()).digest };
  const counts = Object.fromEntries(['pass', 'agent_behavior_mismatch', 'integration_failure', 'skipped']
    .map((status) => [status, results.filter(({ eval_status }) => eval_status === status).length]));
  const summary = {
    schema_version: 1, model, effort, concurrency, serial_index: serialIndex, started_at: startedAt, finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs, initial, final, digest_stable: JSON.stringify(initial) === JSON.stringify(final),
    counts: { total: results.length, ...counts }, pass_rate: results.length ? counts.pass / results.length : 0,
    attempted_runs: results.reduce((sum, item) => sum + item.attempts.length, 0), results,
    candidate_digest: candidate?.digest || null,
  };
  emit({ event: 'matrix_completed', serial_index: serialIndex, serial, output, counts: summary.counts, pass_rate: summary.pass_rate,
    duration_ms: summary.duration_ms, digest_stable: summary.digest_stable });
  return summary;
};
const suiteStartedAt = new Date().toISOString();
const suiteStartedMs = Date.now();
const runs = [];
for (let serialIndex = 1; serialIndex <= serial && !interrupted; serialIndex += 1) runs.push(await runMatrix(serialIndex));
process.removeListener('SIGINT', onInterrupt);
process.removeListener('SIGTERM', onInterrupt);
if (interrupted) {
  process.exitCode = 130;
}
if (!interrupted) {
const counts = Object.fromEntries(['pass', 'agent_behavior_mismatch', 'integration_failure', 'skipped']
  .map((status) => [status, runs.reduce((total, run) => total + run.counts[status], 0)]));
const first = runs[0];
const results = runs.flatMap((run) => run.results.map((result) => ({ ...result, serial_index: run.serial_index })));
const runSummaries = runs.map(({ results: _results, ...run }) => run);
const summary = {
  schema_version: first.schema_version, model, effort, concurrency, serial,
  started_at: suiteStartedAt, finished_at: new Date().toISOString(), duration_ms: Date.now() - suiteStartedMs,
  initial: first.initial, final: runs.at(-1).final,
  digest_stable: runs.every(({ digest_stable: stable }) => stable), counts: { total: results.length, ...counts },
  pass_rate: counts.pass / results.length,
  attempted_runs: runs.reduce((total, run) => total + run.attempted_runs, 0),
  results,
  runs: runSummaries,
  candidate_digest: candidate?.digest || null,
  candidate_ref: candidate ? bundlePath(candidatePath) : null,
  attempt_policy: 'one-attempt-per-scenario-run',
};
await writeFile(candidatePath, `${JSON.stringify(candidate || { schema_version: 1, inputs: inventory.files, initial }, null, 2)}\n`, { flag: 'wx' });
const artifacts = [];
const indexArtifacts = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await indexArtifacts(path);
    else if (entry.isFile()) artifacts.push({ path: bundlePath(path), ...await digest(path) });
    else throw new Error('unsupported bundle artifact');
  }
};
await indexArtifacts(artifactRoot);
summary.artifacts = artifacts.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(`${output}.tmp`, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
await rename(`${output}.tmp`, output);
emit({ event: 'matrix_completed', output, counts: summary.counts, pass_rate: summary.pass_rate,
  duration_ms: summary.duration_ms, digest_stable: summary.digest_stable });
process.exitCode = counts.pass === summary.counts.total && summary.digest_stable && candidate ? 0 : 1;
}
