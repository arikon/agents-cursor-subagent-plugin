import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, parseScenarioCorpus } from '../scripts/cursor-eval-scenario.mjs';
import { buildCloseout, finalizeCloseout, parseFinalizeArgs, publishCloseout } from '../scripts/eval/finalize-cursor-skill-eval.mjs';

const repository = new URL('..', import.meta.url);
const closeoutScript = fileURLToPath(new URL('../scripts/eval/finalize-cursor-skill-eval.mjs', import.meta.url));
const corpusBytes = await readFile(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url));
const corpus = parseScenarioCorpus(corpusBytes);
const scenarios = corpus.scenarios.filter(({ lane }) => lane === 'model-behavior');
const digest = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fixed = (character, bytes = 1) => ({ bytes, sha256: character.repeat(64) });
const START = '<!-- cursor-skill-eval-closeout:start -->';
const END = '<!-- cursor-skill-eval-closeout:end -->';

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(content);
  await writeFile(path, bytes);
  return { path, ...digest(bytes) };
}

function publicResult(scenarioId, evidenceRef) {
  return { schema_version: 1, error_code: null, message: null, evidence_ref: evidenceRef, scenario_id: scenarioId,
    lane: 'model-behavior', eval_status: 'pass', actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked',
    fixture_assertion_outcome: 'pass', evidence_publication_status: 'published', cleanup_status: 'succeeded', failure_stage: null };
}

async function matrixFixture(root, name, effort, serial, freeze, candidate, concurrency = 4) {
  const path = join(root, 'hosted', name, 'matrix.json'); const base = dirname(path);
  const artifactRoot = `${path}.artifacts`; const artifacts = [];
  const candidatePath = join(artifactRoot, 'candidate.json');
  const candidateFile = await write(candidatePath, json(candidate));
  artifacts.push({ path: relative(base, candidateFile.path), bytes: candidateFile.bytes, sha256: candidateFile.sha256 });
  const results = [];
  for (let serialIndex = 1; serialIndex <= serial; serialIndex += 1) {
    for (const scenario of scenarios) {
      const attempt = join(artifactRoot, `serial-${serialIndex}`, `${scenario.scenario_id}-attempt-1`);
      const evidencePath = join(attempt, 'evidence', 'evidence.json');
      const evidenceRef = relative(base, evidencePath);
      const finalResult = publicResult(scenario.scenario_id, 'evidence.json');
      const captures = Array.from({ length: scenario.followups.length + 1 }, (_value, index) => ({
        turn_index: index + 1, text: 'observed final', turn_id: `turn-${index + 1}`, turn_status: 'completed',
        phase: 'final_answer', source: 'thread/items/list', completeness: 'complete', error_code: null,
      }));
      const evidence = { schema_version: 1, scenario_id: scenario.scenario_id, lane: 'model-behavior', failure_artifact: false,
        skill: freeze.skill, transcript: { calls: [], dropped_calls: 0, turn_call_ranges: Array.from({ length: captures.length }, () => ({ start: 0, end: 0 })), unexpected_input_requests: 0 },
        provider_oracle: {}, captured_finals: captures,
        fixture_oracle: { assertion_outcome: 'pass', eval_status: 'pass', reported_task_outcome: 'not_checked', components: { outcome_report: 'not_checked', safety_disclosure: 'not_checked' } },
        harness: {}, final_result: finalResult,
        manifest: { schema_version: 1, hash_algorithm: 'sha256', hash_encoding: 'lowercase-hex', installed_skill: freeze.skill,
          corpus: freeze.corpus, materialized_scenario: fixed('6'), adapter: candidate.payload.adapter, evaluator: freeze.evaluator.digest,
          installed_payload: { marker_format: 1, payload_hash: candidate.payload.package_payload, artifact_hash: '7'.repeat(64), manifest_version: '0.1.0+fixture' },
          client: candidate.payload.client, model: { provider: null, name: 'gpt-5.6-terra' } } };
      const evidenceFile = await write(evidencePath, json(evidence));
      const driverFile = await write(join(attempt, 'driver-stdout.txt'), '{}\n');
      const driverStderr = await write(join(attempt, 'driver-stderr.txt'), '');
      const supervisor = join(attempt, 'supervisor');
      const supervisorResult = await write(join(supervisor, 'result.json'), json({ schema_version: 1, lane: 'eval', verdict: 'passed',
        terminal_cause: 'close_0', child: { code: 0, signal: null }, tests: { success: true, counts: { tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0 } },
        coverage: null, artifacts: { tap: 'tap.txt', stderr: 'stderr.txt', failures: 'failures.jsonl', result: 'result.json' }, infrastructure: null }));
      const supervisorTap = await write(join(supervisor, 'tap.txt'), 'TAP version 13\n');
      const supervisorStderr = await write(join(supervisor, 'stderr.txt'), '');
      const supervisorFailures = await write(join(supervisor, 'failures.jsonl'), '');
      for (const file of [evidenceFile, driverFile, driverStderr, supervisorResult, supervisorTap, supervisorStderr, supervisorFailures]) {
        artifacts.push({ path: relative(base, file.path), bytes: file.bytes, sha256: file.sha256 });
      }
      const process = { code: 0, signal: null, duration_ms: 1, artifact_root: relative(base, attempt) };
      results.push({ ...publicResult(scenario.scenario_id, evidenceRef), process, artifact_root: process.artifact_root,
        attempts: [{ eval_status: 'pass', error_code: null, process }], serial_index: serialIndex });
    }
  }
  const frozen = { corpus: freeze.corpus, skill: freeze.skill, evaluator: freeze.evaluator.digest };
  const counts = { total: results.length, pass: results.length, agent_behavior_mismatch: 0, integration_failure: 0, skipped: 0 };
  const runs = Array.from({ length: serial }, (_value, index) => ({ schema_version: 1, model: 'gpt-5.6-terra', effort,
    concurrency, serial_index: index + 1, initial: frozen, final: frozen, digest_stable: true,
    counts: { ...counts, total: scenarios.length, pass: scenarios.length }, pass_rate: 1, attempted_runs: scenarios.length,
    candidate_digest: candidate.digest }));
  const matrix = { schema_version: 1, model: 'gpt-5.6-terra', effort, concurrency, serial, initial: frozen, final: frozen,
    digest_stable: true, counts, pass_rate: 1, attempted_runs: results.length, results, runs,
    candidate_digest: candidate.digest, candidate_ref: relative(base, candidatePath), attempt_policy: 'one-attempt-per-scenario-run',
    artifacts: artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
  await writeFile(path, json(matrix));
  return path;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cursor-closeout-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle'); await mkdir(bundle, { recursive: true });
  const evaluatorFiles = [
    { path: 'A-fixture.mjs', bytes: 1, sha256: '0'.repeat(64) },
    { path: 'scripts/run-cursor-skill-eval.mjs', bytes: 1, sha256: '1'.repeat(64) },
  ];
  const selectedRunner = 'scripts/run-cursor-skill-eval.mjs';
  const evaluatorDigest = digest(Buffer.from(JSON.stringify({ files: evaluatorFiles, selected_runner: selectedRunner })));
  const freeze = { schema_version: 1, frozen_at: '2026-09-07T00:00:00.000Z',
    evaluator: { files: evaluatorFiles, selected_runner: selectedRunner, digest: evaluatorDigest },
    corpus: digest(corpusBytes), skill: fixed('3'), verification: {} };
  const payload = { evaluator: freeze.evaluator.digest, corpus: freeze.corpus, skill: freeze.skill,
    adapter: fixed('4'), package_payload: '5'.repeat(64), client: { name: 'codex-app-server', version: 'codex-cli 0.153.4' } };
  const encodedPayload = Buffer.from(canonicalJson(payload));
  const candidate = { schema_version: 1, digest: digest(encodedPayload), payload,
    inputs: freeze.evaluator.files, selected_runner: freeze.evaluator.selected_runner };
  const freezePath = join(bundle, 'candidate', 'frozen-inputs.json');
  const diagnostic = await matrixFixture(bundle, 'diagnostic', 'high', 1, freeze, candidate);
  const high = await matrixFixture(bundle, 'high', 'high', 3, freeze, candidate);
  const medium = await matrixFixture(bundle, 'medium', 'medium', 3, freeze, candidate);
  const coverageFiles = [{ path: selectedRunner, bytes: 1, sha256: '1'.repeat(64) }];
  const sourceBytes = Buffer.from(JSON.stringify(coverageFiles));
  const sourceDigest = digest(sourceBytes);
  const rawCoverage = { files: [{ path: `/checkout/${selectedRunner}`, lines: [{ line: 1, count: 0 }], branches: [], functions: [] }] };
  const failures = await write(join(bundle, 'coverage', 'failures.jsonl'), `${JSON.stringify({ type: 'test:coverage', data: { summary: rawCoverage } })}\n`);
  const tap = await write(join(bundle, 'coverage', 'tap.txt'), 'TAP version 13\n');
  const stderr = await write(join(bundle, 'coverage', 'stderr.txt'), '');
  const previous = await write(join(bundle, 'coverage', 'previous-review.json'), json({ schema_version: 1, source_digests: [],
    zero_counters: [], classifications: [], provenance: fixed('9') }));
  const coverageResult = await write(join(bundle, 'coverage', 'result.json'), json({
    schema_version: 1, lane: 'coverage', verdict: 'passed', terminal_cause: 'close_0', child: { code: 0, signal: null },
    tests: { success: true, counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } },
    coverage: { enabled: true, manifest: [selectedRunner], reported: [selectedRunner], diagnostics: [],
      sources: { algorithm: 'sha256', digest: sourceDigest, files: coverageFiles, stable: true },
      artifact_digests: { failures: { bytes: failures.bytes, sha256: failures.sha256 }, tap: { bytes: tap.bytes, sha256: tap.sha256 },
        stderr: { bytes: stderr.bytes, sha256: stderr.sha256 } } },
    artifacts: { failures: 'failures.jsonl', result: 'result.json', tap: 'tap.txt', stderr: 'stderr.txt' },
  }));
  const coverageAudit = join(bundle, 'coverage', 'zero-counter-audit.json');
  const zeroCounter = { path: selectedRunner, source_sha256: coverageFiles[0].sha256, metric: 'lines', line: 1, occurrence: 1 };
  const classification = { ...zeroCounter, classification: 'observable_contract_already_owned', disposition: 'covered by fixture behavior', source: 'sidecar' };
  await writeFile(coverageAudit, json({ schema_version: 1, status: 'passed', source_digest: sourceDigest,
    evidence: { coverage_result: { path: 'result.json', bytes: coverageResult.bytes, sha256: coverageResult.sha256 },
      failures: { path: 'failures.jsonl', bytes: failures.bytes, sha256: failures.sha256 },
      tap: { path: 'tap.txt', bytes: tap.bytes, sha256: tap.sha256 },
      stderr: { path: 'stderr.txt', bytes: stderr.bytes, sha256: stderr.sha256 },
      previous: { path: 'previous-review.json', bytes: previous.bytes, sha256: previous.sha256 } },
    classification_counts: { external_hosted_gate: 0, observable_contract_already_owned: 1, realistic_failure_already_owned: 0, unreachable_defensive: 0 },
    totals: { zero_counters: 1, classified: 1, unclassified: 0, added: 1, removed: 0 },
    zero_counters: [zeroCounter], added: [zeroCounter], removed: [], unclassified: [], classifications: [classification] }));
  freeze.verification.coverage_audit = relative(bundle, coverageAudit);
  const localVerification = await write(join(bundle, 'verification', 'local-gate.json'), '{"status":"passed"}\n');
  freeze.verification.local_gate = relative(bundle, localVerification.path);
  freeze.coverage_sources_digest = sourceDigest;
  await write(freezePath, json(freeze));
  const targets = join(root, 'targets'); const baseline = join(targets, 'baseline.json'); const report = join(targets, 'report.md');
  const tasks = join(targets, 'tasks.md'); const output = join(bundle, 'closeout-proof.json');
  await mkdir(targets, { recursive: true });
  await writeFile(baseline, json({ schema_version: 1,
    historical: Array.from({ length: 7 }, (_value, index) => ({ id: `kept-${index + 1}` })) }));
  await writeFile(report, '# Historical report\n\nKeep this paragraph.\n');
  await writeFile(tasks, ['- [ ] 5.7 stays open', '- [ ] 5.8 diagnostic', '- [ ] 5.9 high', '- [ ] 5.10 medium', '- [ ] 5.11 publish', '- [ ] 5.12 archive'].join('\n') + '\n');
  return { root, bundle, targets, paths: { freeze: freezePath, diagnostic, high, medium, 'coverage-audit': coverageAudit, baseline, report, tasks, output } };
}

async function historicalReferenceFixture(t) {
  const value = await fixture(t); const { bundle, paths } = value;
  const freeze = JSON.parse(await readFile(paths.freeze)); const source = structuredClone(freeze);
  const sourceCorpus = JSON.parse(corpusBytes);
  sourceCorpus.scenarios[0].initial_input += ' Historical instruction';
  const corpusRef = await write(join(bundle, 'reference', 'source-corpus.json'), json(sourceCorpus));
  source.corpus = { bytes: corpusRef.bytes, sha256: corpusRef.sha256 };
  source.evaluator.files[0].sha256 = 'a'.repeat(64);
  source.evaluator.digest = digest(Buffer.from(JSON.stringify({ files: source.evaluator.files, selected_runner: source.evaluator.selected_runner })));
  const candidateFor = (item) => {
    const payload = { evaluator: item.evaluator.digest, corpus: item.corpus, skill: item.skill,
      adapter: fixed('4'), package_payload: (item === source ? 'a' : '5').repeat(64),
      client: { name: 'codex-app-server', version: 'codex-cli 0.153.4' } };
    return { schema_version: 1, digest: digest(Buffer.from(canonicalJson(payload))), payload,
      inputs: item.evaluator.files, selected_runner: item.evaluator.selected_runner };
  };
  paths.diagnostic = await matrixFixture(bundle, 'diagnostic', 'high', 1, freeze, candidateFor(freeze), 12);
  paths.medium = await matrixFixture(bundle, 'medium', 'medium', 3, freeze, candidateFor(freeze), 12);
  paths.high = await matrixFixture(bundle, 'high', 'high', 3, source, candidateFor(source), 4);
  const sourceRef = await write(join(bundle, 'reference', 'source-freeze.json'), json(source));
  freeze.high_reference = { source_freeze: { ...sourceRef, path: relative(bundle, sourceRef.path) },
    source_corpus: { ...corpusRef, path: relative(bundle, corpusRef.path) } };
  const authorization = await write(join(bundle, 'reference', 'authorization.json'), json({ authorization: 'preserve historical high reference' }));
  freeze.verification.high_reference_authorization = relative(bundle, authorization.path);
  await writeFile(paths.freeze, json(freeze));
  return { ...value, sourceFreezePath: sourceRef.path, sourceCorpusPath: corpusRef.path, authorizationPath: authorization.path };
}

async function snapshot(paths) {
  return Promise.all([paths.baseline, paths.report, paths.tasks, paths.output].map((path) => readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))));
}

async function runCli(paths) {
  const argv = Object.entries(paths).flatMap(([name, path]) => [`--${name}`, path]);
  const child = spawn(process.execPath, [closeoutScript, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  return { argv, code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

async function mutateIndexedEvidence(matrixPath, mutate, resultIndex = 0) {
  const matrix = JSON.parse(await readFile(matrixPath)); const result = matrix.results[resultIndex]; const path = join(dirname(matrixPath), result.evidence_ref);
  const evidence = JSON.parse(await readFile(path)); mutate(evidence); const bytes = Buffer.from(json(evidence)); await writeFile(path, bytes);
  const entry = matrix.artifacts.find(({ path: ref }) => ref === result.evidence_ref); Object.assign(entry, digest(bytes));
  await writeFile(matrixPath, json(matrix));
}

async function mutateIndexedFile(matrixPath, filePath, mutate) {
  const matrix = JSON.parse(await readFile(matrixPath)); const value = JSON.parse(await readFile(filePath));
  mutate(value); const bytes = Buffer.from(json(value)); await writeFile(filePath, bytes);
  const ref = relative(dirname(matrixPath), filePath); const entry = matrix.artifacts.find(({ path }) => path === ref);
  assert.ok(entry, `missing fixture index for ${ref}`); Object.assign(entry, digest(bytes)); await writeFile(matrixPath, json(matrix));
}

async function mutationCase(paths, touched, mutate, error) {
  const saved = new Map();
  for (const path of touched) saved.set(path, await readFile(path).catch((cause) => cause.code === 'ENOENT' ? null : Promise.reject(cause)));
  try {
    await mutate();
    const before = await snapshot(paths);
    await assert.rejects(buildCloseout(paths), error);
    assert.deepEqual(await snapshot(paths), before);
  } finally {
    for (const [path, bytes] of saved) {
      if (bytes === null) await rm(path, { recursive: true, force: true });
      else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
    }
  }
}

async function rewriteCoverage(paths, mutateResult, failuresText) {
  const base = dirname(paths['coverage-audit']); const resultPath = join(base, 'result.json'); const failuresPath = join(base, 'failures.jsonl');
  const audit = JSON.parse(await readFile(paths['coverage-audit'])); const result = JSON.parse(await readFile(resultPath));
  if (failuresText !== undefined) {
    const bytes = Buffer.from(failuresText); await writeFile(failuresPath, bytes);
    Object.assign(audit.evidence.failures, digest(bytes)); result.coverage.artifact_digests.failures = digest(bytes);
  }
  mutateResult?.(result, audit);
  const resultBytes = Buffer.from(json(result)); await writeFile(resultPath, resultBytes);
  Object.assign(audit.evidence.coverage_result, digest(resultBytes)); await writeFile(paths['coverage-audit'], json(audit));
}


export {
  assert, spawn, createHash, once, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile, tmpdir, dirname, join, relative, fileURLToPath,
  canonicalJson, parseScenarioCorpus, buildCloseout, finalizeCloseout, parseFinalizeArgs, publishCloseout,
  repository, closeoutScript, corpusBytes, corpus, scenarios, digest, json, fixed, START, END, write, publicResult, matrixFixture, fixture, historicalReferenceFixture, snapshot, runCli, mutateIndexedEvidence, mutateIndexedFile, mutationCase, rewriteCoverage,
};
