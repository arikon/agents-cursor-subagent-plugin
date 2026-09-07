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

test('closeout validates all gates, preserves history, and checks only tasks 5.8 through 5.11', async (t) => {
  const { root, bundle, targets, paths } = await fixture(t); const proof = await finalizeCloseout(paths);
  assert.deepEqual({ status: proof.status, tasks: proof.completed_tasks, semantics: proof.semantic_checks },
    { status: 'passed', tasks: ['5.8', '5.9', '5.10', '5.11'], semantics: 'not_checked' });
  const baseline = JSON.parse(await readFile(paths.baseline));
  assert.deepEqual(baseline.historical, Array.from({ length: 7 }, (_value, index) => ({ id: `kept-${index + 1}` })));
  assert.equal(baseline.current_acceptance.high.counts.pass, scenarios.length * 3);
  assert.equal(baseline.current_acceptance.high.execution, 'fresh');
  assert.equal(baseline.current_acceptance.high.applies_to_current_candidate, true);
  const report = await readFile(paths.report, 'utf8'); assert.match(report, /Keep this paragraph/); assert.match(report, /Current acceptance/);
  assert.match(report, /100% for mechanics, evidence, and exact delivery/); assert.match(report, /completeness disclosure: `not_checked`/);
  assert.equal(JSON.stringify(proof).includes(root), false);
  const tasks = await readFile(paths.tasks, 'utf8');
  assert.match(tasks, /- \[ \] 5\.7/); assert.match(tasks, /- \[x\] 5\.8/); assert.match(tasks, /- \[x\] 5\.11/); assert.match(tasks, /- \[ \] 5\.12/);
  assert.equal(proof.current_acceptance.coverage.totals.zero_counters, 1);
  assert.equal(proof.current_acceptance.local_verification.local_gate.path, 'verification/local-gate.json');
  assert.match(proof.current_acceptance.local_verification.local_gate.sha256, /^[a-f0-9]{64}$/);
  await rm(targets, { recursive: true });
  const moved = join(root, 'moved-bundle'); await rename(bundle, moved);
  for (const ref of Object.values(proof.published_documents)) {
    const bytes = await readFile(join(moved, ref.path)); assert.deepEqual(digest(bytes), { bytes: ref.bytes, sha256: ref.sha256 });
  }
});

test('closeout CLI accepts only explicit paths and publishes its proof', async (t) => {
  const { paths } = await fixture(t);
  const success = await runCli(paths);
  assert.deepEqual(parseFinalizeArgs(success.argv), paths);
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).status, 'passed');
  assert.equal(JSON.parse(await readFile(paths.output)).kind, 'CloseoutProofV1');

  const before = await snapshot(paths); const matrix = JSON.parse(await readFile(paths.high));
  matrix.results[0].process.code = 1; await writeFile(paths.high, json(matrix));
  const failure = await runCli(paths);
  assert.notEqual(failure.code, 0); assert.equal(failure.stdout, ''); assert.deepEqual(await snapshot(paths), before);
});

test('closeout validation rejects malformed paths and evidence without mutating destinations', async (t) => {
  const { paths } = await fixture(t); const before = await snapshot(paths);
  assert.throws(() => parseFinalizeArgs(['--freeze', 'relative']), /all closeout paths|required/);
  const matrix = JSON.parse(await readFile(paths.high)); matrix.results[0].attempts.push(matrix.results[0].attempts[0]); await writeFile(paths.high, json(matrix));
  await assert.rejects(buildCloseout(paths), /invalid matrix result shape|non-passing matrix result/);
  assert.deepEqual(await snapshot(paths), before);

  matrix.results[0].attempts.pop(); matrix.results[0].scenario_id = matrix.results[1].scenario_id; await writeFile(paths.high, json(matrix));
  await assert.rejects(buildCloseout(paths), /scenario/); assert.deepEqual(await snapshot(paths), before);

  matrix.results[0].scenario_id = scenarios[0].scenario_id; matrix.results[0].process.code = 1; await writeFile(paths.high, json(matrix));
  await assert.rejects(buildCloseout(paths), /non-passing matrix result/); assert.deepEqual(await snapshot(paths), before);

  const candidateMatrix = JSON.parse(await readFile(paths.diagnostic)); candidateMatrix.candidate_digest.sha256 = '0'.repeat(64);
  await writeFile(paths.diagnostic, json(candidateMatrix));
  await assert.rejects(buildCloseout(paths), /candidate digest mismatch|candidate differs/); assert.deepEqual(await snapshot(paths), before);
});

test('closeout rejects traversal, hash drift, incomplete finals, dropped calls, and incomplete coverage', async (t) => {
  const { paths } = await fixture(t); const before = await snapshot(paths);
  for (const kind of ['traversal', 'hash', 'process-shape', 'driver-stderr', 'supervisor', 'final', 'duplicate-turn',
    'public-result', 'dropped', 'recovery-proof', 'coverage', 'coverage-decision', 'coverage-source', 'coverage-failures',
    'freeze-coverage-digest', 'shared-source-hash', 'coverage-ref-missing']) {
    const saved = new Map();
    const save = async (path) => { if (!saved.has(path)) saved.set(path, await readFile(path)); };
    try {
      if (kind === 'traversal' || kind === 'hash' || kind === 'process-shape') {
        await save(paths.diagnostic); const matrix = JSON.parse(await readFile(paths.diagnostic));
        if (kind === 'traversal') matrix.artifacts[0].path = '../escape';
        else if (kind === 'hash') matrix.artifacts[0].sha256 = '0'.repeat(64);
        else matrix.results[0].process.extra = true;
        await writeFile(paths.diagnostic, json(matrix));
      } else if (kind === 'driver-stderr' || kind === 'supervisor') {
        const matrix = JSON.parse(await readFile(paths.diagnostic)); const root = join(dirname(paths.diagnostic), matrix.results[0].artifact_root);
        const target = join(root, kind === 'driver-stderr' ? 'driver-stderr.txt' : 'supervisor/tap.txt'); await save(target); await rm(target);
      } else if (['final', 'duplicate-turn', 'public-result', 'dropped', 'recovery-proof'].includes(kind)) {
        const index = kind === 'duplicate-turn' ? scenarios.findIndex(({ followups }) => followups.length > 0) : 0;
        const matrix = JSON.parse(await readFile(paths.diagnostic)); const evidencePath = join(dirname(paths.diagnostic), matrix.results[index].evidence_ref);
        await save(paths.diagnostic); await save(evidencePath);
        await mutateIndexedEvidence(paths.diagnostic, (evidence) => {
          if (kind === 'final') evidence.captured_finals[0].text = '';
          else if (kind === 'duplicate-turn') evidence.captured_finals[1].turn_id = evidence.captured_finals[0].turn_id;
          else if (kind === 'public-result') evidence.final_result.actual_task_outcome = 'failed';
          else if (kind === 'dropped') evidence.transcript.dropped_calls = 1;
          else delete evidence.transcript.turn_call_ranges;
        }, index);
      } else if (kind === 'coverage-failures') {
        const failures = join(dirname(paths['coverage-audit']), 'failures.jsonl'); await save(failures); await writeFile(failures, '{}\n');
      } else if (kind === 'freeze-coverage-digest' || kind === 'coverage-ref-missing') {
        await save(paths.freeze); const freeze = JSON.parse(await readFile(paths.freeze));
        if (kind === 'freeze-coverage-digest') freeze.coverage_sources_digest.sha256 = '0'.repeat(64);
        else delete freeze.verification.coverage_audit;
        await writeFile(paths.freeze, json(freeze));
      } else if (kind === 'shared-source-hash') {
        const resultPath = join(dirname(paths['coverage-audit']), 'result.json');
        await save(paths.freeze); await save(resultPath); await save(paths['coverage-audit']);
        const result = JSON.parse(await readFile(resultPath)); result.coverage.sources.files[0].sha256 = 'a'.repeat(64);
        const sourceBytes = Buffer.from(JSON.stringify(result.coverage.sources.files)); result.coverage.sources.digest = digest(sourceBytes);
        const resultContent = json(result); await writeFile(resultPath, resultContent);
        const audit = JSON.parse(await readFile(paths['coverage-audit'])); audit.source_digest = result.coverage.sources.digest;
        for (const entry of [...audit.zero_counters, ...audit.added, ...audit.classifications]) entry.source_sha256 = 'a'.repeat(64);
        Object.assign(audit.evidence.coverage_result, digest(Buffer.from(resultContent))); await writeFile(paths['coverage-audit'], json(audit));
        const freeze = JSON.parse(await readFile(paths.freeze)); freeze.coverage_sources_digest = result.coverage.sources.digest;
        await writeFile(paths.freeze, json(freeze));
      } else {
        await save(paths['coverage-audit']); const audit = JSON.parse(await readFile(paths['coverage-audit']));
        if (kind === 'coverage') { audit.status = 'unclassified'; audit.unclassified = [{}]; audit.totals.unclassified = 1; }
        else if (kind === 'coverage-decision') {
          audit.classifications = []; audit.classification_counts.observable_contract_already_owned = 0; audit.totals.classified = 0;
        } else audit.zero_counters[0].source_sha256 = '0'.repeat(64);
        await writeFile(paths['coverage-audit'], json(audit));
      }
      await assert.rejects(buildCloseout(paths)); assert.deepEqual(await snapshot(paths), before, kind);
    } finally {
      for (const [path, bytes] of saved) await writeFile(path, bytes);
    }
  }
});

test('closeout rejects symlinked bundle roots and matrix artifact parents', async (t) => {
  const parent = await fixture(t); const before = await snapshot(parent.paths);
  const artifactRoot = `${parent.paths.diagnostic}.artifacts`; const outside = join(parent.root, 'outside-artifacts');
  await rename(artifactRoot, outside); await symlink(outside, artifactRoot, 'dir');
  await assert.rejects(buildCloseout(parent.paths), /symlink|artifact root/); assert.deepEqual(await snapshot(parent.paths), before);

  const rootCase = await fixture(t); const alias = join(rootCase.root, 'bundle-alias'); await symlink(rootCase.bundle, alias, 'dir');
  const aliased = Object.fromEntries(Object.entries(rootCase.paths).map(([name, path]) => [name,
    path.startsWith(rootCase.bundle) ? `${alias}${path.slice(rootCase.bundle.length)}` : path]));
  await assert.rejects(buildCloseout(aliased), /bundle root/);
});

test('closeout rejects each CLI, bundle, JSON, and artifact boundary before publication', async (t) => {
  const { root, bundle, paths } = await fixture(t); const argv = Object.entries(paths).flatMap(([name, path]) => [`--${name}`, path]);
  assert.throws(() => parseFinalizeArgs(['--unknown', paths.freeze, ...argv.slice(2)]), /invalid closeout arguments/);
  assert.throws(() => parseFinalizeArgs(['freeze', paths.freeze, ...argv.slice(2)]), /invalid closeout arguments/);
  assert.throws(() => parseFinalizeArgs(argv.slice(0, -1)), /invalid closeout arguments/);
  const repeated = [...argv]; repeated[2] = '--freeze';
  assert.throws(() => parseFinalizeArgs(repeated), /invalid closeout arguments/);
  assert.throws(() => parseFinalizeArgs(argv.map((value, index) => index === 1 ? 'relative.json' : value)), /--freeze must be absolute/);
  const duplicate = [...argv]; duplicate[3] = duplicate[1];
  assert.throws(() => parseFinalizeArgs(duplicate), /closeout paths must be distinct/);
  const outside = { ...paths, freeze: join(root, 'outside.json') }; await writeFile(outside.freeze, '{}');
  await assert.rejects(buildCloseout(outside), /authoritative path escapes the output bundle/);
  const before = await snapshot(paths);
  const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await assert.rejects(buildCloseout(paths, { lstat: async (path) => path === bundle ? missing() : lstat(path) }), /output bundle root must be a real directory/);
  await assert.rejects(buildCloseout(paths, { lstat: async (path) => path === dirname(paths.freeze) ? missing() : lstat(path) }), /authoritative path has a symlink or invalid parent/);
  await assert.rejects(buildCloseout(paths, { realpath: async (path) => path === dirname(paths.freeze) ? root : realpath(path) }), /authoritative path escapes the real output bundle/);
  assert.deepEqual(await snapshot(paths), before);
  const candidateParent = dirname(paths.freeze); const realCandidateParent = `${candidateParent}.real`;
  await rename(candidateParent, realCandidateParent); await symlink(realCandidateParent, candidateParent, 'dir');
  try { await assert.rejects(buildCloseout(paths), /authoritative path has a symlink or invalid parent/); }
  finally { await rm(candidateParent); await rename(realCandidateParent, candidateParent); }
  await mutationCase(paths, [paths.freeze], () => writeFile(paths.freeze, '{'), /invalid JSON/);
  const artifactRoot = `${paths.diagnostic}.artifacts`;
  await assert.rejects(buildCloseout(paths, { lstat: async (path) => path === artifactRoot ? missing() : lstat(path) }), /invalid artifact root/);
  assert.deepEqual(await snapshot(paths), before);
  const badLeaf = join(artifactRoot, 'unsupported-link'); await symlink(join(artifactRoot, 'candidate.json'), badLeaf);
  try { await assert.rejects(buildCloseout(paths), /unsupported artifact entry/); assert.deepEqual(await snapshot(paths), before); }
  finally { await rm(badLeaf); }
});

test('closeout reaches matrix index, evidence, supervisor, capture, set, and summary guards', async (t) => {
  const { paths } = await fixture(t); const matrixPath = paths.diagnostic; const base = dirname(matrixPath);
  const matrixOnly = async (mutate, error) => mutationCase(paths, [matrixPath], async () => {
    const matrix = JSON.parse(await readFile(matrixPath)); mutate(matrix); await writeFile(matrixPath, json(matrix));
  }, error);
  await matrixOnly((matrix) => { matrix.schema_version = 2; }, /invalid matrix contract/);
  await matrixOnly((matrix) => { matrix.initial.skill.sha256 = '0'.repeat(64); }, /matrix input drift/);
  await matrixOnly((matrix) => { matrix.results.pop(); }, /matrix result count mismatch/);
  await matrixOnly((matrix) => { matrix.runs = []; }, /matrix serial count mismatch/);
  await matrixOnly((matrix) => { delete matrix.artifacts; }, /matrix artifact index missing/);
  await matrixOnly((matrix) => { matrix.artifacts[0].bytes = -1; }, /invalid matrix artifact index/);
  await matrixOnly((matrix) => { matrix.candidate_ref = 'not-indexed.json'; }, /candidate reference is not indexed/);
  await matrixOnly((matrix) => { matrix.results[0].evidence_ref = matrix.candidate_ref; }, /unindexed result evidence/);
  await matrixOnly((matrix) => { matrix.counts.pass -= 1; }, /matrix aggregate mismatch/);
  await matrixOnly((matrix) => { matrix.runs[0].pass_rate = 0; }, /matrix run summary mismatch/);

  const matrix = JSON.parse(await readFile(matrixPath)); const result = matrix.results[0]; const attempt = join(base, result.artifact_root);
  const evidencePath = join(base, result.evidence_ref); const driverOut = join(attempt, 'driver-stdout.txt'); const driverErr = join(attempt, 'driver-stderr.txt');
  const outsideArtifact = join(base, 'outside-artifact.json');
  await mutationCase(paths, [matrixPath, outsideArtifact], async () => {
    const file = await write(outsideArtifact, '{}\n'); const current = JSON.parse(await readFile(matrixPath));
    current.artifacts.push({ path: relative(base, file.path), bytes: file.bytes, sha256: file.sha256 }); await writeFile(matrixPath, json(current));
  }, /artifact outside matrix root/);
  const unindexed = join(`${matrixPath}.artifacts`, 'unindexed.txt');
  await mutationCase(paths, [unindexed], () => write(unindexed, 'extra'), /unindexed matrix artifacts/);
  const candidatePath = join(base, matrix.candidate_ref);
  await mutationCase(paths, [matrixPath, candidatePath], () => mutateIndexedFile(matrixPath, candidatePath, (value) => { value.payload.adapter.sha256 = 'a'.repeat(64); }), /candidate digest mismatch/);
  for (const [file, message] of [[evidencePath, /unindexed result evidence/], [driverOut, /unindexed result evidence/], [driverErr, /unindexed result evidence/]]) {
    await mutationCase(paths, [matrixPath, file], async () => {
      const current = JSON.parse(await readFile(matrixPath)); const ref = relative(base, file);
      current.artifacts = current.artifacts.filter(({ path }) => path !== ref); await rm(file); await writeFile(matrixPath, json(current));
    }, message);
  }
  const supervisor = join(attempt, 'supervisor'); const supervisorFiles = ['result.json', 'failures.jsonl', 'tap.txt', 'stderr.txt'].map((name) => join(supervisor, name));
  await mutationCase(paths, [matrixPath, ...supervisorFiles], async () => {
    const current = JSON.parse(await readFile(matrixPath)); const refs = new Set(supervisorFiles.map((file) => relative(base, file)));
    current.artifacts = current.artifacts.filter(({ path }) => !refs.has(path)); await Promise.all(supervisorFiles.map((file) => rm(file)));
    await writeFile(matrixPath, json(current));
  }, /missing supervisor artifacts/);
  await mutationCase(paths, [matrixPath, join(supervisor, 'result.json')], () => mutateIndexedFile(matrixPath, join(supervisor, 'result.json'), (value) => { value.verdict = 'failed'; }), /non-passing supervisor artifacts/);
  const secondSupervisor = join(attempt, 'supervisor-2');
  const secondSupervisorFiles = ['result.json', 'failures.jsonl', 'tap.txt', 'stderr.txt'].map((name) => join(secondSupervisor, name));
  await mutationCase(paths, [matrixPath, ...secondSupervisorFiles], async () => {
    await cp(supervisor, secondSupervisor, { recursive: true }); const current = JSON.parse(await readFile(matrixPath));
    for (const name of ['result.json', 'failures.jsonl', 'tap.txt', 'stderr.txt']) {
      const file = await readFile(join(secondSupervisor, name)); current.artifacts.push({ path: relative(base, join(secondSupervisor, name)), ...digest(file) });
    }
    await writeFile(matrixPath, json(current));
  }, /missing supervisor artifacts/);
  await mutationCase(paths, [matrixPath, evidencePath], () => mutateIndexedEvidence(matrixPath, (value) => { value.captured_finals = {}; }), /incomplete final capture/);
  await mutationCase(paths, [matrixPath, evidencePath], () => mutateIndexedEvidence(matrixPath, (value) => { value.captured_finals[0].text = null; }), /incomplete final capture/);
  await mutationCase(paths, [matrixPath, evidencePath], () => mutateIndexedEvidence(matrixPath, (value) => { value.captured_finals[0].text = 'x'.repeat(1_048_577); }), /incomplete final capture/);

  await mutationCase(paths, [matrixPath], async () => {
    const current = JSON.parse(await readFile(matrixPath)); current.results[0] = structuredClone(current.results[1]); await writeFile(matrixPath, json(current));
  }, /scenario set mismatch/);
});

test('closeout reconstructs coverage evidence and rejects each inconsistent boundary', async (t) => {
  const { paths } = await fixture(t); const base = dirname(paths['coverage-audit']);
  const auditPath = paths['coverage-audit']; const resultPath = join(base, 'result.json'); const failuresPath = join(base, 'failures.jsonl'); const previousPath = join(base, 'previous-review.json');
  const auditOnly = async (mutate, error) => mutationCase(paths, [auditPath], async () => {
    const audit = JSON.parse(await readFile(auditPath)); mutate(audit); await writeFile(auditPath, json(audit));
  }, error);
  await auditOnly((audit) => { delete audit.evidence.tap; }, /coverage audit evidence is incomplete/);
  await auditOnly((audit) => { audit.evidence = null; }, /coverage audit evidence is incomplete/);
  await auditOnly((audit) => { audit.evidence.extra = audit.evidence.tap; }, /coverage audit evidence is incomplete/);
  await auditOnly((audit) => { audit.evidence.tap.bytes = 'bad'; }, /coverage audit evidence is incomplete/);
  await mutationCase(paths, [auditPath, resultPath], async () => {
    await writeFile(resultPath, '{'); const audit = JSON.parse(await readFile(auditPath)); Object.assign(audit.evidence.coverage_result, digest(Buffer.from('{'))); await writeFile(auditPath, json(audit));
  }, /coverage JSON evidence is invalid/);
  await mutationCase(paths, [auditPath, previousPath], async () => {
    await writeFile(previousPath, '{'); const audit = JSON.parse(await readFile(auditPath)); Object.assign(audit.evidence.previous, digest(Buffer.from('{'))); await writeFile(auditPath, json(audit));
  }, /coverage JSON evidence is invalid/);
  await mutationCase(paths, [auditPath, resultPath], () => rewriteCoverage(paths, (result) => { result.artifacts.tap = 'wrong.txt'; }), /coverage supervisor artifacts do not match audit evidence/);
  await mutationCase(paths, [auditPath, resultPath], () => rewriteCoverage(paths, (result) => { result.coverage.artifact_digests.tap.sha256 = '0'.repeat(64); }), /coverage supervisor artifacts do not match audit evidence/);
  await mutationCase(paths, [auditPath, resultPath, failuresPath], () => rewriteCoverage(paths, null, '{\n'), /coverage failures evidence is invalid/);
  await mutationCase(paths, [auditPath, resultPath, failuresPath], () => rewriteCoverage(paths, null, `${JSON.stringify({ type: 'test:summary', data: {} })}\n`), /coverage failures evidence lacks the final raw queue/);
  await auditOnly((audit) => {
    audit.status = 'unclassified'; audit.classifications = []; audit.classification_counts.observable_contract_already_owned = 0;
    audit.unclassified = [...audit.zero_counters]; audit.totals.classified = 0; audit.totals.unclassified = 1;
  }, /coverage audit is incomplete/);
  await mutationCase(paths, [paths.freeze], async () => {
    const freeze = JSON.parse(await readFile(paths.freeze)); freeze.verification.coverage_audit = 'coverage/result.json'; await writeFile(paths.freeze, json(freeze));
  }, /coverage audit does not match frozen verification reference/);
});

test('closeout validates freeze, documents, local refs, snapshots, and publication destinations', async (t) => {
  const { bundle, paths } = await fixture(t);
  const mutateFile = (path, mutate, error) => mutationCase(paths, [path], async () => {
    const value = JSON.parse(await readFile(path)); mutate(value); await writeFile(path, json(value));
  }, error);
  await mutationCase(paths, [paths.report], () => writeFile(paths.report, `${START}\nfirst\n${START}\nsecond\n${END}\n`), /report closeout block is malformed/);
  await mutationCase(paths, [paths.report], () => writeFile(paths.report, `${START}\nmissing end\n`), /report closeout block is malformed/);
  await mutationCase(paths, [paths.report], () => writeFile(paths.report, `${START}\nfirst\n${END}\n${END}\n`), /report closeout block is malformed/);
  await mutationCase(paths, [paths.tasks], async () => {
    const value = (await readFile(paths.tasks, 'utf8')).replace('- [ ] 5.8 diagnostic\n', ''); await writeFile(paths.tasks, value);
  }, /task 5.8 anchor is missing or duplicated/);
  await mutationCase(paths, [paths.tasks], async () => {
    const value = await readFile(paths.tasks, 'utf8'); await writeFile(paths.tasks, `${value}- [ ] 5.8 duplicate\n`);
  }, /task 5.8 anchor is missing or duplicated/);
  await mutateFile(paths.freeze, (freeze) => { freeze.schema_version = 2; }, /invalid frozen inputs/);
  await mutateFile(paths.freeze, (freeze) => { delete freeze.verification; }, /invalid frozen inputs/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.files[0].bytes = 0; }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.files.push(freeze.evaluator.files[0]); }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.selected_runner = 'missing.mjs'; }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.files.reverse(); }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.digest.sha256 = '0'.repeat(64); }, /frozen evaluator digest mismatch/);
  await mutateFile(paths.freeze, (freeze) => { freeze.corpus.sha256 = '0'.repeat(64); }, /current corpus differs from freeze/);
  await mutateFile(paths.freeze, (freeze) => { freeze.verification.local_gate = '../escape'; }, /invalid frozen verification reference/);
  await mutateFile(paths.freeze, (freeze) => { freeze.verification.local_gate = 'verification/missing.json'; }, /not a regular file/);

  await mkdir(paths.output);
  try { await assert.rejects(buildCloseout(paths), /--output must be a regular proof file/); }
  finally { await rm(paths.output, { recursive: true }); }
  const outputTarget = join(bundle, 'output-target'); await writeFile(outputTarget, 'target'); await symlink(outputTarget, paths.output);
  try { await assert.rejects(buildCloseout(paths), /--output must be a regular proof file/); }
  finally { await rm(paths.output); }
  const localPath = join(bundle, 'verification', 'local-gate.json'); const parkedLocal = `${localPath}.real`; await rename(localPath, parkedLocal); await symlink(parkedLocal, localPath);
  try { await assert.rejects(buildCloseout(paths), /not a regular file/); }
  finally { await rm(localPath); await rename(parkedLocal, localPath); }

  await mutationCase(paths, [paths.high], async () => {
    const matrix = JSON.parse(await readFile(paths.high)); matrix.concurrency = 5; for (const run of matrix.runs) run.concurrency = 5; await writeFile(paths.high, json(matrix));
  }, /acceptance matrices do not share one candidate and concurrency/);
  const highMatrix = JSON.parse(await readFile(paths.high)); const highBase = dirname(paths.high);
  const highCandidatePath = join(highBase, highMatrix.candidate_ref);
  const highEvidencePaths = highMatrix.results.map(({ evidence_ref: ref }) => join(highBase, ref));
  await mutationCase(paths, [paths.high, highCandidatePath, ...highEvidencePaths], async () => {
    const matrix = JSON.parse(await readFile(paths.high)); const candidate = JSON.parse(await readFile(highCandidatePath));
    candidate.payload.adapter.sha256 = 'a'.repeat(64); const payloadBytes = Buffer.from(canonicalJson(candidate.payload)); candidate.digest = digest(payloadBytes);
    const candidateBytes = Buffer.from(json(candidate)); await writeFile(highCandidatePath, candidateBytes);
    Object.assign(matrix.artifacts.find(({ path }) => path === matrix.candidate_ref), digest(candidateBytes));
    matrix.candidate_digest = candidate.digest; for (const run of matrix.runs) run.candidate_digest = candidate.digest;
    for (const result of matrix.results) {
      const evidencePath = join(highBase, result.evidence_ref); const evidence = JSON.parse(await readFile(evidencePath)); evidence.manifest.adapter = candidate.payload.adapter;
      const evidenceBytes = Buffer.from(json(evidence)); await writeFile(evidencePath, evidenceBytes);
      Object.assign(matrix.artifacts.find(({ path }) => path === result.evidence_ref), digest(evidenceBytes));
    }
    await writeFile(paths.high, json(matrix));
  }, /acceptance matrices do not share one candidate and concurrency/);
  const snapshotRoot = join(bundle, 'closeout-proof.json.inputs'); await writeFile(snapshotRoot, 'file');
  try { await assert.rejects(buildCloseout(paths), /closeout snapshot root is invalid/); }
  finally { await rm(snapshotRoot); }
  const colliding = { ...paths, baseline: join(snapshotRoot, 'baseline.json') };
  await mkdir(snapshotRoot, { recursive: true }); await writeFile(colliding.baseline, await readFile(paths.baseline));
  try { await assert.rejects(buildCloseout(colliding), /closeout publication destinations collide/); }
  finally { await rm(snapshotRoot, { recursive: true }); }
});

test('per-file publisher leaves a recoverable prefix and an idempotent rerun repairs it', async (t) => {
  const { paths } = await fixture(t); const staged = await buildCloseout(paths); let calls = 0;
  await assert.rejects(publishCloseout(staged, { rename: async (from, to) => {
    calls += 1; if (calls === 9) throw new Error('interrupted'); return rename(from, to);
  } }), /interrupted/);
  assert.match(await readFile(paths.report, 'utf8'), /Current acceptance/);
  await assert.rejects(readFile(paths.output), { code: 'ENOENT' });
  assert.match(await readFile(paths.tasks, 'utf8'), /- \[ \] 5\.8/);
  const repaired = await buildCloseout(paths); await publishCloseout(repaired);
  const first = await readFile(paths.output, 'utf8'); const repeated = await buildCloseout(paths); await publishCloseout(repeated);
  assert.equal(repeated.proof, repaired.proof); assert.equal(await readFile(paths.output, 'utf8'), first);
  assert.match(await readFile(paths.tasks, 'utf8'), /- \[x\] 5\.11/);
  let cleanupCalls = 0;
  await assert.rejects(publishCloseout(await buildCloseout(paths), {
    rename: async () => { throw new Error('publication failed'); },
    rm: async () => { cleanupCalls += 1; throw new Error('cleanup failed'); },
  }), /publication failed/);
  assert.ok(cleanupCalls > 0);
});

test('closeout preserves historical high without claiming acceptance of the current candidate', async (t) => {
  const { paths } = await historicalReferenceFixture(t);
  const historical = await readFile(paths.high); const matrix = JSON.parse(historical);
  const artifactBytes = await Promise.all(matrix.artifacts.map(({ path }) => readFile(join(dirname(paths.high), path))));
  const proof = await finalizeCloseout(paths);
  assert.equal(proof.current_acceptance.high.execution, 'preserved-reference');
  assert.equal(proof.current_acceptance.high.applies_to_current_candidate, false);
  assert.deepEqual(proof.current_acceptance.high.reference, JSON.parse(await readFile(paths.freeze)).high_reference);
  assert.notDeepEqual(matrix.candidate_digest, JSON.parse(await readFile(paths.medium)).candidate_digest);
  assert.equal(proof.current_acceptance.high.counts.pass, scenarios.length * 3);
  assert.equal(proof.current_acceptance.high.concurrency, 4);
  assert.equal(proof.current_acceptance.medium.concurrency, 12);
  const report = await readFile(paths.report, 'utf8');
  assert.match(report, /preserved-reference/); assert.match(report, /different candidate|not.*current candidate/i);
  assert.deepEqual(await readFile(paths.high), historical);
  assert.deepEqual(await Promise.all(matrix.artifacts.map(({ path }) => readFile(join(dirname(paths.high), path)))), artifactBytes);
  const published = await snapshot(paths); await finalizeCloseout(paths); assert.deepEqual(await snapshot(paths), published);
});

test('historical high rejects missing authorization and broken or ambiguous references before publishing', async (t) => {
  const { paths, sourceFreezePath, sourceCorpusPath, authorizationPath } = await historicalReferenceFixture(t);
  for (const kind of ['missing-source', 'hash-mismatch', 'invalid-source-json', 'invalid-source-freeze', 'invalid-corpus',
    'source-corpus-binding', 'unknown-reference-key', 'malformed-reference', 'nested-reference', 'nested-carry',
    'legacy-carry', 'both-fields', 'missing-authorization', 'missing-authorization-file']) {
    await mutationCase(paths, [paths.freeze, sourceFreezePath, sourceCorpusPath, authorizationPath], async () => {
      const freeze = JSON.parse(await readFile(paths.freeze)); const source = JSON.parse(await readFile(sourceFreezePath));
      if (kind === 'missing-source') await rm(sourceFreezePath);
      else if (kind === 'hash-mismatch') freeze.high_reference.source_freeze.sha256 = 'b'.repeat(64);
      else if (kind === 'unknown-reference-key') freeze.high_reference.unexpected = true;
      else if (kind === 'malformed-reference') freeze.high_reference.source_freeze.sha256 = 'bad';
      else if (kind === 'missing-authorization') delete freeze.verification.high_reference_authorization;
      else if (kind === 'missing-authorization-file') await rm(authorizationPath);
      else if (kind === 'legacy-carry' || kind === 'both-fields') {
        freeze.high_carry_forward = freeze.high_reference;
        if (kind === 'legacy-carry') delete freeze.high_reference;
      } else {
        if (kind === 'nested-reference') source.high_reference = freeze.high_reference;
        else if (kind === 'nested-carry') source.high_carry_forward = freeze.high_reference;
        else if (kind === 'invalid-source-freeze') source.evaluator.digest = fixed('b');
        else if (kind === 'source-corpus-binding') source.corpus = fixed('b');
        else if (kind === 'invalid-corpus') {
          const bytes = Buffer.from('{}'); await writeFile(sourceCorpusPath, bytes);
          Object.assign(freeze.high_reference.source_corpus, digest(bytes)); source.corpus = digest(bytes);
        }
        const bytes = Buffer.from(kind === 'invalid-source-json' ? '{' : json(source)); await writeFile(sourceFreezePath, bytes);
        Object.assign(freeze.high_reference.source_freeze, digest(bytes));
      }
      await writeFile(paths.freeze, json(freeze));
    }, /reference|source|corpus|digest|freeze|carry|authorization|regular|JSON/i);
  }
});

test('historical high retains full evidence validation and current diagnostic and medium remain strict', async (t) => {
  const { paths } = await historicalReferenceFixture(t);
  for (const [lane, kind] of [['high', 'nonpass'], ['diagnostic', 'candidate'], ['medium', 'candidate'], ['medium', 'concurrency']]) {
    await mutationCase(paths, [paths[lane]], async () => {
      const matrix = JSON.parse(await readFile(paths[lane]));
      if (kind === 'nonpass') matrix.results[0].process.code = 1;
      else if (kind === 'candidate') matrix.candidate_digest = fixed('a');
      else { matrix.concurrency = 4; for (const run of matrix.runs) run.concurrency = 4; }
      await writeFile(paths[lane], json(matrix));
    }, kind === 'concurrency' ? /acceptance matrices do not share one candidate and concurrency/ : /matrix|candidate|concurrency|run/i);
  }
  const matrix = JSON.parse(await readFile(paths.high));
  const evidencePath = join(dirname(paths.high), matrix.results[0].evidence_ref);
  for (const kind of ['capture', 'cleanup']) {
    await mutationCase(paths, [paths.high, evidencePath], () => mutateIndexedEvidence(paths.high, (evidence) => {
      if (kind === 'capture') evidence.captured_finals[0].completeness = 'incomplete';
      else evidence.final_result.cleanup_status = 'failed';
    }), /evidence|final|capture/i);
  }
});
