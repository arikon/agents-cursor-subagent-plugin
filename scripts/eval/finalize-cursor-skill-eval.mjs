#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPublishedAudit } from '../audit-node-coverage.mjs';
import { assertEvalResultV1, assertEvidenceManifestV1 } from '../cursor-skill-eval.mjs';
import { canonicalJson, parseScenarioCorpus, validRecoveryContext } from '../cursor-eval-scenario.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARGUMENTS = ['freeze', 'diagnostic', 'high', 'medium', 'coverage-audit', 'baseline', 'report', 'tasks', 'output'];
const PUBLIC_RESULT_KEYS = ['schema_version', 'error_code', 'message', 'evidence_ref', 'scenario_id', 'lane', 'eval_status',
  'actual_task_outcome', 'reported_task_outcome', 'fixture_assertion_outcome', 'evidence_publication_status', 'cleanup_status', 'failure_stage'];
const PROCESS_KEYS = ['code', 'signal', 'duration_ms', 'artifact_root'];
const START = '<!-- cursor-skill-eval-closeout:start -->';
const END = '<!-- cursor-skill-eval-closeout:end -->';

const fail = (message) => { throw Object.assign(new Error(message), { code: 'closeout_validation_failed' }); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const digest = (content) => { const bytes = Buffer.from(content); return { bytes: bytes.length, sha256: sha256(bytes) }; };
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const validDigest = (value) => exact(value, ['bytes', 'sha256']) && Number.isSafeInteger(value.bytes) && value.bytes >= 0
  && /^[a-f0-9]{64}$/.test(value.sha256);
const contained = (path, root) => { const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
const validRelative = (path) => typeof path === 'string' && path.length > 0 && path.replaceAll('\\', '/') === path
  && !isAbsolute(path) && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
const portableRef = (root, path, { bytes, sha256: hash }) => ({ path: relative(root, path).replaceAll('\\', '/'), bytes, sha256: hash });

async function assertBundlePath(bundleRoot, path, fs = {}) {
  if (!contained(path, bundleRoot)) fail('authoritative path escapes the output bundle');
  const rootInfo = await (fs.lstat || lstat)(bundleRoot).catch(() => null);
  if (!rootInfo?.isDirectory()) fail('output bundle root must be a real directory');
  const rootReal = await (fs.realpath || realpath)(bundleRoot);
  const pathParent = dirname(path);
  const parts = relative(bundleRoot, pathParent).split('/').filter(Boolean);
  let cursor = bundleRoot;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const info = await (fs.lstat || lstat)(cursor).catch(() => null);
    if (!info?.isDirectory()) fail('authoritative path has a symlink or invalid parent');
  }
  const parentReal = await (fs.realpath || realpath)(pathParent);
  if (parentReal !== rootReal && !contained(parentReal, rootReal)) fail('authoritative path escapes the real output bundle');
}

export function parseFinalizeArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || !ARGUMENTS.includes(flag.slice(2)) || values[flag.slice(2)]) fail('invalid closeout arguments');
    values[flag.slice(2)] = value;
  }
  if (argv.length !== ARGUMENTS.length * 2 || ARGUMENTS.some((name) => !values[name])) fail('all closeout paths are required');
  for (const [name, path] of Object.entries(values)) {
    if (!isAbsolute(path)) fail(`--${name} must be absolute`);
    values[name] = resolve(path);
  }
  if (new Set(Object.values(values)).size !== ARGUMENTS.length) fail('closeout paths must be distinct');
  return values;
}

async function loadRegular(path, fs = {}) {
  const info = await (fs.lstat || lstat)(path).catch(() => null);
  if (!info?.isFile()) fail(`not a regular file: ${path}`);
  const bytes = Buffer.from(await (fs.readFile || readFile)(path));
  return { bytes, digest: { bytes: bytes.length, sha256: sha256(bytes) } };
}

async function loadJson(path, fs) {
  const file = await loadRegular(path, fs);
  try { return { ...file, value: JSON.parse(file.bytes.toString('utf8')) }; }
  catch { fail(`invalid JSON: ${path}`); }
}

async function listRegularFiles(root, fs = {}) {
  const rootInfo = await (fs.lstat || lstat)(root).catch(() => null);
  if (!rootInfo?.isDirectory()) fail(`invalid artifact root: ${root}`);
  const output = [];
  const walk = async (directory) => {
    for (const entry of await (fs.readdir || readdir)(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(path);
      else fail(`unsupported artifact entry: ${path}`);
    }
  };
  await walk(root);
  return output.sort();
}

async function verifiedReference(base, ref, expected, fs) {
  if (!validRelative(ref)) fail('authoritative references must be relative and normalized');
  const path = resolve(base, ref);
  const file = await loadRegular(path, fs);
  if (expected && !same(file.digest, expected)) fail(`reference digest mismatch: ${ref}`);
  return { path: ref, ...file.digest };
}

function publicResult(result) {
  return Object.fromEntries(PUBLIC_RESULT_KEYS.map((key) => [key, result[key]]));
}

function recomputeCounts(results) {
  const counts = { total: results.length, pass: 0, agent_behavior_mismatch: 0, integration_failure: 0, skipped: 0 };
  for (const result of results) counts[result.eval_status] += 1;
  return counts;
}

async function validateMatrix(path, expected, corpus, freeze, bundleRoot, fs) {
  const loaded = await loadJson(path, fs); const matrix = loaded.value; const base = dirname(path);
  if (matrix.schema_version !== 1 || matrix.model !== 'gpt-5.6-terra' || matrix.effort !== expected.effort
    || matrix.serial !== expected.serial || !Number.isSafeInteger(matrix.concurrency) || matrix.concurrency < 1
    || matrix.attempt_policy !== 'one-attempt-per-scenario-run' || matrix.digest_stable !== true) fail(`invalid matrix contract: ${path}`);
  const frozen = { corpus: freeze.corpus, skill: freeze.skill, evaluator: freeze.evaluator.digest };
  if (!same(matrix.initial, frozen) || !same(matrix.final, frozen)) fail(`matrix input drift: ${path}`);
  const scenarioIds = corpus.scenarios.filter(({ lane }) => lane === 'model-behavior').map(({ scenario_id }) => scenario_id).sort();
  if (!Array.isArray(matrix.results) || matrix.results.length !== scenarioIds.length * expected.serial) fail(`matrix result count mismatch: ${path}`);
  if (!Array.isArray(matrix.runs) || matrix.runs.length !== expected.serial) fail(`matrix serial count mismatch: ${path}`);
  const artifactRoot = `${path}.artifacts`;
  const entries = new Map();
  if (!Array.isArray(matrix.artifacts)) fail(`matrix artifact index missing: ${path}`);
  for (const entry of matrix.artifacts) {
    if (!exact(entry, ['path', 'bytes', 'sha256']) || entries.has(entry.path) || !validDigest({ bytes: entry.bytes, sha256: entry.sha256 })) fail(`invalid matrix artifact index: ${path}`);
    const verified = await verifiedReference(base, entry.path, { bytes: entry.bytes, sha256: entry.sha256 }, fs);
    if (!contained(resolve(base, verified.path), artifactRoot)) fail(`artifact outside matrix root: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  const actualFiles = await listRegularFiles(artifactRoot, fs);
  const actualRefs = actualFiles.map((file) => relative(base, file)).sort();
  if (!same(actualRefs, [...entries.keys()].sort())) fail(`unindexed matrix artifacts: ${path}`);
  if (!entries.has(matrix.candidate_ref)) fail(`candidate reference is not indexed: ${path}`);
  const candidate = (await loadJson(resolve(base, matrix.candidate_ref), fs)).value;
  if (candidate.schema_version !== 1 || !validDigest(candidate.digest) || !same(candidate.digest, matrix.candidate_digest)
    || !same(candidate.inputs, freeze.evaluator.files) || candidate.selected_runner !== freeze.evaluator.selected_runner
    || !same(candidate.payload?.evaluator, freeze.evaluator.digest) || !same(candidate.payload?.corpus, freeze.corpus)
    || !same(candidate.payload?.skill, freeze.skill)) fail(`candidate differs from freeze: ${path}`);
  const payloadBytes = Buffer.from(canonicalJson(candidate.payload));
  if (!same(candidate.digest, { bytes: payloadBytes.length, sha256: sha256(payloadBytes) })) fail(`candidate digest mismatch: ${path}`);
  const bySerial = new Map(Array.from({ length: expected.serial }, (_, index) => [index + 1, []]));
  for (const result of matrix.results) {
    if (!exact(result, [...PUBLIC_RESULT_KEYS, 'process', 'artifact_root', 'attempts', 'serial_index'])
      || !exact(result.process, PROCESS_KEYS) || !Number.isSafeInteger(result.process.duration_ms) || result.process.duration_ms < 0
      || !validRelative(result.process.artifact_root) || !Number.isSafeInteger(result.serial_index)
      || !Array.isArray(result.attempts) || result.attempts.length !== 1
      || !exact(result.attempts[0], ['eval_status', 'error_code', 'process']) || !exact(result.attempts[0].process, PROCESS_KEYS)) {
      fail(`invalid matrix result shape: ${result?.scenario_id || 'unknown'}`);
    }
    assertEvalResultV1(publicResult(result));
    if (result.lane !== 'model-behavior' || result.eval_status !== 'pass' || result.evidence_publication_status !== 'published'
      || result.cleanup_status !== 'succeeded' || result.process?.code !== 0 || result.process?.signal !== null
      || !Array.isArray(result.attempts) || result.attempts.length !== 1 || result.attempts[0].eval_status !== 'pass'
      || result.attempts[0].error_code !== null || result.artifact_root !== result.process?.artifact_root
      || !same(result.attempts[0].process, result.process) || !bySerial.has(result.serial_index)) fail(`non-passing matrix result: ${result.scenario_id}`);
    bySerial.get(result.serial_index).push(result.scenario_id);
    if (!entries.has(result.evidence_ref) || !entries.has(result.artifact_root ? `${result.artifact_root}/driver-stdout.txt` : '')
      || !entries.has(result.artifact_root ? `${result.artifact_root}/driver-stderr.txt` : '')
      || !contained(resolve(base, result.evidence_ref), resolve(base, result.artifact_root))) fail(`unindexed result evidence: ${result.scenario_id}`);
    const supervisorRoots = [...entries.keys()].filter((ref) => ref.startsWith(`${result.artifact_root}/`) && ref.endsWith('/result.json'))
      .map((ref) => dirname(ref)).filter((ref) => relative(result.artifact_root, ref).split('/').length === 1
        && ['result.json', 'failures.jsonl', 'tap.txt', 'stderr.txt'].every((name) => entries.has(`${ref}/${name}`)));
    if (supervisorRoots.length !== 1) fail(`missing supervisor artifacts: ${result.scenario_id}`);
    const supervisorRoot = supervisorRoots[0];
    const supervisor = (await loadJson(resolve(base, supervisorRoot, 'result.json'), fs)).value;
    if (supervisor.schema_version !== 1 || supervisor.lane !== 'eval' || supervisor.verdict !== 'passed'
      || supervisor.terminal_cause !== 'close_0' || supervisor.child?.code !== 0 || supervisor.child?.signal !== null
      || supervisor.tests?.success !== true || supervisor.tests?.counts?.failed !== 0 || supervisor.tests?.counts?.cancelled !== 0
      || !Number.isSafeInteger(supervisor.tests?.counts?.tests) || supervisor.tests.counts.tests < 1 || supervisor.infrastructure !== null
      || !exact(supervisor.artifacts, ['result', 'failures', 'tap', 'stderr'])
      || !same(supervisor.artifacts, { result: 'result.json', failures: 'failures.jsonl', tap: 'tap.txt', stderr: 'stderr.txt' })) {
      fail(`non-passing supervisor artifacts: ${result.scenario_id}`);
    }
    const scenario = corpus.scenarios.find(({ scenario_id: id }) => id === result.scenario_id);
    const evidence = (await loadJson(resolve(base, result.evidence_ref), fs)).value;
    assertEvidenceManifestV1(evidence.manifest); assertEvalResultV1(evidence.final_result);
    const expectedFinal = { ...publicResult(result), evidence_ref: basename(result.evidence_ref) };
    if (evidence.scenario_id !== result.scenario_id || evidence.lane !== 'model-behavior' || evidence.failure_artifact !== false
      || !same(evidence.skill, freeze.skill) || !same(evidence.final_result, expectedFinal)
      || !same(evidence.manifest.installed_skill, freeze.skill) || !same(evidence.manifest.corpus, freeze.corpus)
      || !same(evidence.manifest.evaluator, freeze.evaluator.digest) || evidence.manifest.model?.name !== 'gpt-5.6-terra'
      || !same(evidence.manifest.adapter, candidate.payload.adapter) || !same(evidence.manifest.client, candidate.payload.client)
      || evidence.manifest.installed_payload?.payload_hash !== candidate.payload.package_payload
      || evidence.fixture_oracle?.eval_status !== 'pass' || evidence.fixture_oracle?.assertion_outcome !== 'pass'
      || evidence.fixture_oracle?.reported_task_outcome !== 'not_checked'
      || evidence.fixture_oracle?.components?.outcome_report !== 'not_checked'
      || evidence.fixture_oracle?.components?.safety_disclosure !== 'not_checked'
      || !validRecoveryContext(evidence.transcript, scenario.followups.length + 1) || evidence.transcript?.dropped_calls !== 0
      || evidence.transcript.unexpected_input_requests !== 0) fail(`invalid scenario evidence: ${result.scenario_id}`);
    const captures = evidence.captured_finals;
    const capturedTurnIds = new Set(Array.isArray(captures) ? captures.map(({ turn_id: turnId }) => turnId) : []);
    if (!Array.isArray(captures) || captures.length !== scenario.followups.length + 1
      || capturedTurnIds.size !== captures.length
      || captures.reduce((total, capture) => total + (typeof capture.text === 'string' ? Buffer.byteLength(capture.text) : 0), 0) > 1_048_576
      || captures.some((capture, index) => !exact(capture, ['turn_index', 'text', 'turn_id', 'turn_status', 'phase', 'source', 'completeness', 'error_code'])
        || capture.turn_index !== index + 1 || capture.completeness !== 'complete' || capture.error_code !== null
        || typeof capture.text !== 'string' || capture.text.trim() === '' || typeof capture.turn_id !== 'string' || !capture.turn_id
        || !['completed', 'failed', 'interrupted'].includes(capture.turn_status) || !['final_answer', null].includes(capture.phase)
        || !['thread/items/list', 'thread/turns/list'].includes(capture.source))) fail(`incomplete final capture: ${result.scenario_id}`);
  }
  for (const [serialIndex, ids] of bySerial) {
    if (!same([...ids].sort(), scenarioIds)) fail(`scenario set mismatch in serial ${serialIndex}: ${path}`);
  }
  const counts = recomputeCounts(matrix.results);
  if (!same(counts, matrix.counts) || matrix.attempted_runs !== matrix.results.length || matrix.pass_rate !== 1) fail(`matrix aggregate mismatch: ${path}`);
  for (const [index, run] of matrix.runs.entries()) {
    const runResults = matrix.results.filter(({ serial_index: serialIndex }) => serialIndex === index + 1);
    if (run.schema_version !== 1 || run.serial_index !== index + 1 || run.model !== matrix.model || run.effort !== matrix.effort || run.concurrency !== matrix.concurrency
      || !same(run.candidate_digest, matrix.candidate_digest) || !same(run.counts, recomputeCounts(runResults))
      || run.attempted_runs !== runResults.length || run.pass_rate !== 1 || run.digest_stable !== true
      || !same(run.initial, frozen) || !same(run.final, frozen)) fail(`matrix run summary mismatch: ${path}`);
  }
  return { ref: portableRef(bundleRoot, path, loaded.digest), serial: expected.serial, counts, concurrency: matrix.concurrency,
    candidate: { digest: candidate.digest, payload: candidate.payload,
      ref: portableRef(bundleRoot, resolve(base, matrix.candidate_ref), entries.get(matrix.candidate_ref)) }, scenario_ids: scenarioIds };
}

async function validateCoverage(path, freeze, bundleRoot, fs) {
  const loaded = await loadJson(path, fs); const audit = loaded.value; const base = dirname(path);
  const evidence = {}; const evidenceFiles = {};
  const evidenceKeys = Object.keys(audit.evidence || {});
  const requiredEvidence = ['coverage_result', 'failures', 'tap', 'stderr'];
  const allowedEvidence = new Set([...requiredEvidence, 'previous', 'classifications']);
  if (requiredEvidence.some((name) => !evidenceKeys.includes(name)) || evidenceKeys.some((name) => !allowedEvidence.has(name))) fail('coverage audit evidence is incomplete');
  for (const [name, ref] of Object.entries(audit.evidence)) {
    if (!exact(ref, ['path', 'bytes', 'sha256']) || !validDigest({ bytes: ref.bytes, sha256: ref.sha256 })) fail('coverage audit evidence is incomplete');
    await assertBundlePath(bundleRoot, resolve(base, ref.path), fs);
    const file = await loadRegular(resolve(base, ref.path), fs);
    if (!same(file.digest, { bytes: ref.bytes, sha256: ref.sha256 })) fail(`reference digest mismatch: ${ref.path}`);
    evidenceFiles[name] = file;
    evidence[name] = portableRef(bundleRoot, resolve(base, ref.path), file.digest);
  }
  let coverageResult; let previous = null;
  try {
    coverageResult = JSON.parse(evidenceFiles.coverage_result.bytes.toString('utf8'));
    if (evidenceFiles.previous) previous = JSON.parse(evidenceFiles.previous.bytes.toString('utf8'));
  } catch { fail('coverage JSON evidence is invalid'); }
  const expectedArtifactRefs = { result: audit.evidence.coverage_result.path, failures: audit.evidence.failures.path,
    tap: audit.evidence.tap.path, stderr: audit.evidence.stderr.path };
  if (!same(coverageResult.artifacts, expectedArtifactRefs)
    || !['failures', 'tap', 'stderr'].every((name) => same(coverageResult.coverage?.artifact_digests?.[name],
      { bytes: audit.evidence[name].bytes, sha256: audit.evidence[name].sha256 }))) fail('coverage supervisor artifacts do not match audit evidence');
  let rawCoverage;
  try {
    const failures = evidenceFiles.failures.bytes.toString('utf8');
    rawCoverage = failures.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event?.type === 'test:coverage').at(-1)?.data?.summary;
  } catch { fail('coverage failures evidence is invalid'); }
  if (!rawCoverage) fail('coverage failures evidence lacks the final raw queue');
  verifyPublishedAudit({ audit, result: coverageResult, rawCoverage, previous });
  if (audit.status !== 'passed') fail('coverage audit is incomplete');
  const sources = coverageResult.coverage.sources;
  if (!same(freeze.coverage_sources_digest, sources.digest)) fail('coverage source digest does not match freeze');
  const evaluatorFiles = new Map(freeze.evaluator.files.map((entry) => [entry.path, entry]));
  const overlappingSources = sources.files.filter((entry) => evaluatorFiles.has(entry.path));
  if (!overlappingSources.length || overlappingSources.some((entry) => {
    const frozen = evaluatorFiles.get(entry.path); return frozen.bytes !== entry.bytes || frozen.sha256 !== entry.sha256;
  })) fail('coverage sources do not match overlapping frozen inputs');
  const frozenRef = freeze.verification?.coverage_audit;
  if (!validRelative(frozenRef)) fail('frozen coverage audit reference is invalid');
  const frozenPath = resolve(bundleRoot, frozenRef);
  if (resolve(frozenPath) !== resolve(path)) fail('coverage audit does not match frozen verification reference');
  return { ref: portableRef(bundleRoot, path, loaded.digest), source_digest: audit.source_digest, evidence,
    totals: audit.totals, classification_counts: audit.classification_counts };
}

function reportSeed(original) {
  if (!original.includes(START) && !original.includes(END)) return `${original.replace(/\s*$/, '')}\n`;
  const start = original.indexOf(START); const end = original.indexOf(END, start);
  if (start < 0 || end < 0 || original.indexOf(START, start + 1) >= 0 || original.indexOf(END, end + 1) >= 0) fail('report closeout block is malformed');
  return `${`${original.slice(0, start)}${original.slice(end + END.length)}`.replace(/\s*$/, '')}\n`;
}

function renderReport(seed, acceptance) {
  const block = `${START}\n## Current acceptance\n\n- Candidate: \`${acceptance.candidate.digest.sha256}\`\n- Diagnostic: ${acceptance.diagnostic.counts.pass}/${acceptance.diagnostic.counts.total}\n- High: ${acceptance.high.counts.pass}/${acceptance.high.counts.total}\n- Medium: ${acceptance.medium.counts.pass}/${acceptance.medium.counts.total}\n- Coverage audit: passed, ${acceptance.coverage.totals.classified} classified, 0 unclassified\n- Functional acceptance: 100% for mechanics, evidence, and exact delivery.\n- Free-form prose truth and completeness disclosure: \`not_checked\`.\n- Reported task outcome, outcome report, and safety disclosure: \`not_checked\`.\n${END}`;
  return `${seed.replace(/\s*$/, '')}\n\n${block}\n`;
}

function taskSeed(original) {
  let output = original;
  for (const task of ['5.8', '5.9', '5.10', '5.11']) {
    const checked = new RegExp(`^- \\[x\\] ${task.replace('.', '\\.')}(?=\\s)`, 'gm');
    output = output.replace(checked, `- [ ] ${task}`);
  }
  return output;
}

function completeTasks(seed) {
  let output = seed;
  for (const task of ['5.8', '5.9', '5.10', '5.11']) {
    const pattern = new RegExp(`^- \\[ \\] ${task.replace('.', '\\.')}(?=\\s)`, 'gm');
    const matches = output.match(pattern) || [];
    if (matches.length === 1) output = output.replace(pattern, `- [x] ${task}`);
    else fail(`task ${task} anchor is missing or duplicated`);
  }
  return output;
}

export async function buildCloseout(paths, fs = {}) {
  const bundleRoot = dirname(paths.output);
  const outputInfo = await (fs.lstat || lstat)(paths.output).catch(() => null);
  if (outputInfo && !outputInfo.isFile()) fail('--output must be a regular proof file');
  for (const name of ['freeze', 'diagnostic', 'high', 'medium', 'coverage-audit']) {
    await assertBundlePath(bundleRoot, paths[name], fs);
  }
  const freezeLoaded = await loadJson(paths.freeze, fs); const freeze = { ...freezeLoaded.value, __path: paths.freeze };
  if (freeze.schema_version !== 1 || !Array.isArray(freeze.evaluator?.files) || !validDigest(freeze.evaluator?.digest)
    || !freeze.verification || Array.isArray(freeze.verification) || typeof freeze.verification !== 'object'
    || !validDigest(freeze.corpus) || !validDigest(freeze.skill) || !validDigest(freeze.coverage_sources_digest)) fail('invalid frozen inputs');
  const inventoryPaths = new Set();
  for (const entry of freeze.evaluator.files) {
    if (!exact(entry, ['path', 'bytes', 'sha256']) || !validRelative(entry.path) || !validDigest({ bytes: entry.bytes, sha256: entry.sha256 })
      || entry.bytes === 0 || inventoryPaths.has(entry.path)) fail('invalid frozen evaluator inventory');
    inventoryPaths.add(entry.path);
  }
  const inventoryOrder = freeze.evaluator.files.map(({ path }) => path);
  if (!validRelative(freeze.evaluator.selected_runner) || !inventoryPaths.has(freeze.evaluator.selected_runner)
    || !same([...inventoryOrder].sort(), inventoryOrder)) fail('invalid frozen evaluator inventory');
  const inventoryBytes = Buffer.from(JSON.stringify({ files: freeze.evaluator.files, selected_runner: freeze.evaluator.selected_runner }));
  if (!same(freeze.evaluator.digest, { bytes: inventoryBytes.length, sha256: sha256(inventoryBytes) })) fail('frozen evaluator digest mismatch');
  const corpusPath = resolve(repository, 'evals/cursor-subagent-scenarios.v1.json');
  const corpusLoaded = await loadRegular(corpusPath, fs);
  if (!same(corpusLoaded.digest, freeze.corpus)) fail('current corpus differs from freeze');
  const corpus = parseScenarioCorpus(corpusLoaded.bytes);
  const coverage = await validateCoverage(paths['coverage-audit'], freeze, bundleRoot, fs);
  const diagnostic = await validateMatrix(paths.diagnostic, { effort: 'high', serial: 1 }, corpus, freeze, bundleRoot, fs);
  const high = await validateMatrix(paths.high, { effort: 'high', serial: 3 }, corpus, freeze, bundleRoot, fs);
  const medium = await validateMatrix(paths.medium, { effort: 'medium', serial: 3 }, corpus, freeze, bundleRoot, fs);
  const candidateIdentity = ({ digest: candidateDigest, payload }) => ({ digest: candidateDigest, payload });
  if (diagnostic.concurrency !== high.concurrency || high.concurrency !== medium.concurrency
    || !same(candidateIdentity(diagnostic.candidate), candidateIdentity(high.candidate))
    || !same(candidateIdentity(high.candidate), candidateIdentity(medium.candidate))) fail('acceptance matrices do not share one candidate and concurrency');
  const localVerification = {};
  for (const [name, ref] of Object.entries(freeze.verification)) {
    if (name === 'coverage_audit') continue;
    if (!validRelative(ref)) fail(`invalid frozen verification reference: ${name}`);
    await assertBundlePath(bundleRoot, resolve(bundleRoot, ref), fs);
    const file = await loadRegular(resolve(bundleRoot, ref), fs);
    localVerification[name] = { path: ref, ...file.digest };
  }
  const baselineLoaded = await loadJson(paths.baseline, fs);
  const reportLoaded = await loadRegular(paths.report, fs); const tasksLoaded = await loadRegular(paths.tasks, fs);
  const baselineSeedValue = { ...baselineLoaded.value }; delete baselineSeedValue.current_acceptance;
  const baselineSeed = `${JSON.stringify(baselineSeedValue, null, 2)}\n`;
  const reportSeedText = reportSeed(reportLoaded.bytes.toString('utf8'));
  const taskSeedText = taskSeed(tasksLoaded.bytes.toString('utf8'));
  const snapshotRoot = resolve(bundleRoot, `${basename(paths.output)}.inputs`);
  const snapshotInfo = await (fs.lstat || lstat)(snapshotRoot).catch(() => null);
  if (snapshotInfo && !snapshotInfo.isDirectory()) fail('closeout snapshot root is invalid');
  const seedSnapshots = [
    { role: 'baseline_normalized_seed', path: resolve(snapshotRoot, 'baseline.json'), content: baselineSeed },
    { role: 'report_normalized_seed', path: resolve(snapshotRoot, 'report.md'), content: reportSeedText },
    { role: 'tasks_normalized_seed', path: resolve(snapshotRoot, 'tasks.md'), content: taskSeedText },
  ].map((entry) => ({ ...entry, ref: portableRef(bundleRoot, entry.path, digest(entry.content)) }));
  const acceptance = { candidate: diagnostic.candidate, concurrency: diagnostic.concurrency, scenario_ids: diagnostic.scenario_ids,
    diagnostic, high, medium, coverage, local_verification: localVerification };
  const baseline = `${JSON.stringify({ ...baselineSeedValue, current_acceptance: acceptance }, null, 2)}\n`;
  const report = renderReport(reportSeedText, acceptance);
  const tasks = completeTasks(taskSeedText);
  const publishedSnapshots = [
    { role: 'baseline_published', path: resolve(snapshotRoot, 'published-baseline.json'), content: baseline },
    { role: 'report_published', path: resolve(snapshotRoot, 'published-report.md'), content: report },
    { role: 'tasks_published', path: resolve(snapshotRoot, 'published-tasks.md'), content: tasks },
  ].map((entry) => ({ ...entry, ref: portableRef(bundleRoot, entry.path, digest(entry.content)) }));
  const snapshots = [...seedSnapshots, ...publishedSnapshots];
  const publicationPaths = [...snapshots.map(({ path }) => path), paths.baseline, paths.report, paths.output, paths.tasks];
  if (new Set(publicationPaths).size !== publicationPaths.length) fail('closeout publication destinations collide');
  const proof = { schema_version: 1, kind: 'CloseoutProofV1', status: 'passed',
    inputs: { freeze: portableRef(bundleRoot, paths.freeze, freezeLoaded.digest),
      normalized_seeds: Object.fromEntries(seedSnapshots.map(({ role, ref }) => [role, ref])) },
    published_documents: Object.fromEntries(publishedSnapshots.map(({ role, ref }) => [role, ref])),
    current_acceptance: acceptance, completed_tasks: ['5.8', '5.9', '5.10', '5.11'], semantic_checks: 'not_checked' };
  return { paths, proof: `${JSON.stringify(proof, null, 2)}\n`, baseline, report, tasks, snapshots };
}

export async function publishCloseout(staged, fs = {}) {
  const entries = [
    ...staged.snapshots.map(({ path, content }) => [path, content]),
    [staged.paths.baseline, staged.baseline], [staged.paths.report, staged.report],
    [staged.paths.output, staged.proof], [staged.paths.tasks, staged.tasks],
  ];
  const temporary = [];
  try {
    for (const [path, content] of entries) {
      await (fs.mkdir || mkdir)(dirname(path), { recursive: true });
      const candidate = `${path}.tmp-${randomUUID()}`;
      await (fs.writeFile || writeFile)(candidate, content, { flag: 'wx' });
      temporary.push([candidate, path]);
    }
    for (const [candidate, path] of temporary) await (fs.rename || rename)(candidate, path);
  } finally {
    await Promise.all(temporary.map(([candidate]) => (fs.rm || rm)(candidate, { force: true }).catch(() => {})));
  }
  return JSON.parse(staged.proof);
}

export async function finalizeCloseout(paths, fs = {}) {
  return publishCloseout(await buildCloseout(paths, fs), fs);
}

async function main(argv = process.argv.slice(2), io = process) {
  try {
    const paths = parseFinalizeArgs(argv);
    const proof = await finalizeCloseout(paths);
    io.stdout.write(`${JSON.stringify(proof)}\n`);
  } catch (error) {
    io.stderr.write(`${error.message}\n`); io.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
