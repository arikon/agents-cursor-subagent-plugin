#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEvalResultV1, assertEvidenceManifestV1, EVAL_LIMITS, readEvaluatorInventory } from '../cursor-skill-eval.mjs';
import { canonicalJson, parseScenarioCorpus } from '../cursor-eval-scenario.mjs';
import { emptyEvalTokenUsage, mergeEvalTokenUsage, readTokenUsageFromEvidence } from '../eval-token-usage.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [model, effort, outputArg] = process.argv.slice(2);
if (!/^[A-Za-z0-9._-]+$/.test(model || '') || !/^(low|medium|high|xhigh|max)$/.test(effort || '') || !outputArg) {
  throw new Error('usage: node scripts/eval/run-cursor-skill-eval-matrix.mjs <model> <low|medium|high|xhigh|max> <output.json>');
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
  ? 16 : Number(process.env.CURSOR_EVAL_MATRIX_CONCURRENCY);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
  throw new Error('CURSOR_EVAL_MATRIX_CONCURRENCY must be an integer from 1 through 16');
}
const serial = process.env.CURSOR_EVAL_MATRIX_SERIAL === undefined
  ? 1 : Number(process.env.CURSOR_EVAL_MATRIX_SERIAL);
if (!Number.isSafeInteger(serial) || serial < 1 || serial > 10) {
  throw new Error('CURSOR_EVAL_MATRIX_SERIAL must be an integer from 1 through 10');
}
const resume = process.env.CURSOR_EVAL_MATRIX_RESUME === '1';
const pauseAfterRun = process.env.CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN === '1';
if (pauseAfterRun && (resume || serial !== 3)) throw new Error('pause requires a new three-run series');
const continueOnFailure = process.env.CURSOR_EVAL_MATRIX_CONTINUE_ON_FAILURE === '1';
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
if (!resume) {
  await mkdir(artifactRoot);
  try { await readFile(output); throw new Error('matrix output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const declarationPath = resolve(artifactRoot, 'declaration.json');
const checkpointPath = resolve(artifactRoot, 'checkpoint.json');
const executionEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  (key.startsWith('CURSOR_EVAL_') || key === 'NODE_OPTIONS')
  && !['CURSOR_EVAL_MATRIX_RESUME', 'CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN', 'CURSOR_EVAL_MATRIX_PROGRESS_MS'].includes(key)));
const declaration = { schema_version: 1, model, effort, serial, concurrency, continue_on_failure: continueOnFailure,
  initial, runner: await digest(evalRunner), scenarios: scenarioIds, node: process.version, platform: process.platform,
  arch: process.arch, execution_environment_sha256: createHash('sha256').update(canonicalJson(executionEnvironment)).digest('hex'), hosted: process.env.CURSOR_EVAL_HOSTED_CODEX || null };
let retained = null;
if (resume) {
  if (canonicalJson(JSON.parse(await readFile(declarationPath))) !== canonicalJson(declaration)) throw new Error('series declaration or inputs changed');
  const checkpoint = JSON.parse(await readFile(checkpointPath));
  if (canonicalJson(await digest(output)) !== canonicalJson(checkpoint.aggregate)) throw new Error('retained aggregate changed');
  retained = JSON.parse(await readFile(output));
  if (retained.stop_reason !== 'review_required' || retained.complete !== false || retained.runs.length !== 1
    || retained.serial !== 3 || retained.runs[0].serial_index !== 1 || retained.counts.pass !== scenarioIds.length
    || retained.counts.total !== scenarioIds.length || !retained.digest_stable
    || new Set(retained.results.map(item => item.scenario_id)).size !== scenarioIds.length
    || retained.results.some(item => item.serial_index !== 1 || item.eval_status !== 'pass' || !scenarioIds.includes(item.scenario_id))) {
    throw new Error('retained series is not an eligible reviewed first run');
  }
  for (const artifact of retained.artifacts) {
    const path = resolve(bundleRoot, artifact.path);
    if (!path.startsWith(`${artifactRoot}/`) || canonicalJson(await digest(path)) !== canonicalJson({ sha256: artifact.sha256, bytes: artifact.bytes })) {
      throw new Error('retained artifact changed');
    }
  }
  await mkdir(resolve(artifactRoot, 'resume-lock'));
} else {
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`, { flag: 'wx' });
}
let candidate = retained ? JSON.parse(await readFile(resolve(artifactRoot, 'candidate.json'))) : null;
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
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  activeChildren.add(child);
  child.on('message', (message) => { if (message?.type === 'usage_limit_exceeded') stopForQuota(child); });
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
  let tokenUsage = emptyEvalTokenUsage();
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
      try { tokenUsage = readTokenUsageFromEvidence(evidence); }
      catch { tokenUsage = emptyEvalTokenUsage(); }
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
  const completed = { ...result, process: { code, signal, duration_ms: Date.now() - started, artifact_root: bundlePath(attemptArtifactRoot) }, token_usage: tokenUsage };
  if (result.error_code === 'usage_limit_exceeded') stopForQuota();
  emit({ event: 'scenario_completed', serial_index: serialIndex, serial, scenario_id: scenarioId, index, total: scenarioIds.length, attempt,
    eval_status: completed.eval_status, error_code: completed.error_code, duration_ms: completed.process.duration_ms });
  return completed;
};

let interrupted = false;
let quotaStopped = false;
const activeChildren = new Set();
const stopForQuota = (source) => {
  if (quotaStopped) return;
  quotaStopped = true;
  interrupted = true;
  if (process.connected) process.send({ type: 'usage_limit_exceeded' });
  emit({ event: 'quota_exhausted', error_code: 'usage_limit_exceeded' });
  for (const child of activeChildren) if (child !== source) child.kill('SIGTERM');
};
const onMessage = (message) => { if (message?.type === 'usage_limit_exceeded') stopForQuota(); };
process.on('message', onMessage);
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
  const slots = Array(scenarioIds.length);
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
      slots[offset] = {
        ...result,
        artifact_root: result.process.artifact_root,
        attempts: attempts.map(({ eval_status, error_code, process }) => ({ eval_status, error_code, process })),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarioIds.length) }, () => worker()));
  const results = slots.filter(Boolean);
  const final = { corpus: await digest(corpusPath), skill: await digest(skillPath), evaluator: (await readEvaluatorInventory()).digest };
  const counts = Object.fromEntries(['pass', 'agent_behavior_mismatch', 'integration_failure', 'skipped']
    .map((status) => [status, results.filter(({ eval_status }) => eval_status === status).length]));
  const summary = {
    schema_version: 1, model, effort, concurrency, serial_index: serialIndex, started_at: startedAt, finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs, initial, final, digest_stable: JSON.stringify(initial) === JSON.stringify(final),
    counts: { total: results.length, ...counts }, pass_rate: results.length ? counts.pass / results.length : 0,
    attempted_runs: results.reduce((sum, item) => sum + item.attempts.length, 0), results,
    token_usage: mergeEvalTokenUsage(results.map((item) => item.token_usage)),
    candidate_digest: candidate?.digest || null,
    ...(quotaStopped ? { complete: false, stop_reason: 'usage_limit_exceeded', planned_total: scenarioIds.length,
      not_started_total: scenarioIds.length - results.length } : {}),
  };
  emit({ event: 'matrix_completed', serial_index: serialIndex, serial, output, counts: summary.counts, pass_rate: summary.pass_rate,
    duration_ms: summary.duration_ms, digest_stable: summary.digest_stable });
  return summary;
};
const suiteStartedAt = retained?.started_at || new Date().toISOString();
// Whole-series wall time includes the explicit review pause before resume.
const suiteStartedMs = Date.parse(suiteStartedAt);
const runs = retained ? retained.runs.map(run => ({ ...run, results: retained.results.filter(item => item.serial_index === run.serial_index) })) : [];
let serialStopReason = null;
for (let serialIndex = runs.length + 1; serialIndex <= serial && !interrupted; serialIndex += 1) {
  const run = await runMatrix(serialIndex);
  runs.push(run);
  if (pauseAfterRun && serialIndex === 1 && run.digest_stable && run.counts.pass === scenarioIds.length && !interrupted) {
    serialStopReason = 'review_required';
    interrupted = true;
  }
  if (serialIndex < serial && !continueOnFailure && (run.complete === false || !run.digest_stable
    || run.counts.agent_behavior_mismatch > 0 || run.counts.integration_failure > 0 || run.counts.skipped > 0
    || run.counts.pass !== run.counts.total)) {
    serialStopReason = run.complete === false ? run.stop_reason
      : !run.digest_stable ? 'digest_drift' : 'nonpass';
    interrupted = true;
  }
}
process.removeListener('SIGINT', onInterrupt);
process.removeListener('SIGTERM', onInterrupt);
process.removeListener('message', onMessage);
if (process.connected) process.disconnect();
if (interrupted && !serialStopReason && !quotaStopped) {
  process.exitCode = 130;
}
if (!interrupted || quotaStopped || serialStopReason) {
const counts = Object.fromEntries(['pass', 'agent_behavior_mismatch', 'integration_failure', 'skipped']
  .map((status) => [status, runs.reduce((total, run) => total + run.counts[status], 0)]));
const first = runs[0] || { schema_version: 1, initial, final: initial };
const results = runs.flatMap((run) => run.results.map((result) => ({ ...result, serial_index: run.serial_index })));
const runSummaries = runs.map(({ results: _results, ...run }) => run);
const summary = {
  schema_version: first.schema_version, model, effort, concurrency, serial,
  started_at: suiteStartedAt, finished_at: new Date().toISOString(), duration_ms: Date.now() - suiteStartedMs,
  initial: first.initial, final: runs.at(-1)?.final || initial,
  digest_stable: runs.every(({ digest_stable: stable }) => stable), counts: { total: results.length, ...counts },
  pass_rate: results.length ? counts.pass / results.length : 0,
  attempted_runs: runs.reduce((total, run) => total + run.attempted_runs, 0),
  results,
  token_usage: mergeEvalTokenUsage(runs.map((run) => run.token_usage)),
  runs: runSummaries,
  candidate_digest: candidate?.digest || null,
  candidate_ref: candidate ? bundlePath(candidatePath) : null,
  attempt_policy: 'one-attempt-per-scenario-run',
  ...((quotaStopped || serialStopReason) ? { complete: false, stop_reason: quotaStopped ? 'usage_limit_exceeded' : serialStopReason,
    planned_total: scenarioIds.length * serial, not_started_total: scenarioIds.length * serial - results.length } : {}),
};
if (!resume) await writeFile(candidatePath, `${JSON.stringify(candidate || { schema_version: 1, inputs: inventory.files, initial }, null, 2)}\n`, { flag: 'wx' });
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
if (serialStopReason === 'review_required') await writeFile(checkpointPath, JSON.stringify({ aggregate: await digest(output) }), { flag: 'wx' });
emit({ event: 'matrix_completed', output, counts: summary.counts, pass_rate: summary.pass_rate,
  duration_ms: summary.duration_ms, digest_stable: summary.digest_stable });
process.exitCode = !interrupted && !quotaStopped && counts.pass === summary.counts.total && summary.digest_stable && candidate ? 0 : 1;
}
