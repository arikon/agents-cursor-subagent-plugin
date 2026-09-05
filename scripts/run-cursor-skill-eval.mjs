#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateScenario, materializeScenario, parseScenarioCorpus } from './cursor-eval-scenario.mjs';
import { EVAL_LIMITS, evalResult, writeEvalResult } from './cursor-skill-eval.mjs';

const integrationTest = fileURLToPath(new URL('../tests/codex-client-integration.test.mjs', import.meta.url));
const releaseTest = fileURLToPath(new URL('../tests/release-e2e.test.mjs', import.meta.url));
const corpusPath = fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url));
const LANES = Object.freeze({
  'client-integration': { enable: 'CURSOR_EVAL_REAL_CODEX', test: integrationTest, pattern: 'credential-free client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } },
  'model-behavior': { enable: 'CURSOR_EVAL_HOSTED_CODEX', test: integrationTest, pattern: 'hosted Codex', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } },
  'full-live': { enable: 'CURSOR_SUBAGENT_LIVE_E2E', test: releaseTest, pattern: 'live release canary', env: { CURSOR_SUBAGENT_LIVE_E2E: '1' } },
});
const DIGEST_KEYS = Object.freeze(['bytes', 'sha256']);
const PROVENANCE_KEYS = Object.freeze(['adapter', 'cache_loaded_skill', 'cleanup_status', 'client', 'consumed_corpus', 'consumed_scenario', 'installed_payload', 'managed_installed_skill', 'model']);

function bounded(value, limit = 8_000) {
  const content = String(value || '');
  return Buffer.byteLength(content, 'utf8') <= limit ? content : `${Buffer.from(content, 'utf8').subarray(0, limit - 3).toString('utf8')}...`;
}

function contained(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && path !== '..' && !isAbsolute(path));
}

function exactObject(value, keys) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function digest(value) {
  return exactObject(value, DIGEST_KEYS) && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= EVAL_LIMITS.evidenceBytes;
}

function boundedNullable(value) {
  return value === null || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= 256);
}

function sameDigest(left, right) {
  return left?.sha256 === right?.sha256 && left?.bytes === right?.bytes;
}

function manifestFrom(provenance) {
  if (!digest(provenance.managed_installed_skill) || !digest(provenance.adapter) || !provenance.installed_payload || !provenance.client || !provenance.model) return null;
  return {
    schema_version: 1,
    hash_algorithm: 'sha256',
    hash_encoding: 'lowercase-hex',
    installed_skill: provenance.managed_installed_skill,
    corpus: provenance.consumed_corpus,
    materialized_scenario: provenance.consumed_scenario,
    adapter: provenance.adapter,
    installed_payload: provenance.installed_payload,
    client: provenance.client,
    model: provenance.model,
  };
}

export function parseChildResult(encoded, scenarioId, expected = {}) {
  if (Buffer.byteLength(encoded, 'utf8') > EVAL_LIMITS.evidenceBytes) throw Object.assign(new Error('child result exceeds evidence limit'), { evalCode: 'child_result_invalid' });
  let result;
  try { result = JSON.parse(encoded); } catch { throw Object.assign(new Error('child result is not JSON'), { evalCode: 'child_result_invalid' }); }
  const provenance = result?.provenance;
  const observations = result?.observations;
  const payload = provenance?.installed_payload;
  const client = provenance?.client;
  const model = provenance?.model;
  const validProjection = exactObject(payload, ['artifact_hash', 'manifest_version', 'marker_format', 'payload_hash'])
    && payload.marker_format === 1 && /^[a-f0-9]{64}$/.test(payload.payload_hash) && /^[a-f0-9]{64}$/.test(payload.artifact_hash)
    && boundedNullable(payload.manifest_version) && payload.manifest_version !== null;
  const validClient = exactObject(client, ['name', 'version']) && boundedNullable(client.name) && client.name !== null && boundedNullable(client.version) && client.version !== null;
  const validModel = exactObject(model, ['name', 'provider']) && boundedNullable(model.name) && boundedNullable(model.provider);
  const childStatus = result?.eval_status || observations?.eval_status;
  const normalizedTranscript = result?.transcript || [];
  const normalizedObservations = observations && {
    ...observations,
    assertion_outcome: observations.assertion_outcome || (childStatus === 'pass' ? 'pass' : childStatus === 'agent_behavior_mismatch' ? 'fail' : 'not_observed'),
    eval_status: observations.eval_status || childStatus,
  };
  const validObservations = exactObject(normalizedObservations, ['actual_task_outcome', 'assertion_outcome', 'callbacks', 'effects', 'eval_status', 'reported_task_outcome', 'trace'])
    && Array.isArray(observations.trace) && Array.isArray(observations.callbacks) && Array.isArray(observations.effects)
    && ['succeeded', 'failed', 'not_observed'].includes(normalizedObservations.actual_task_outcome)
    && ['succeeded', 'failed', 'not_reported'].includes(normalizedObservations.reported_task_outcome)
    && ['pass', 'fail', 'not_observed'].includes(normalizedObservations.assertion_outcome)
    && ['pass', 'agent_behavior_mismatch', 'integration_failure'].includes(normalizedObservations.eval_status);
  const programmed = expected.scenario ? expected.scenario.scenario_kind === 'programmed' : provenance?.cache_loaded_skill !== null;
  const validSkillProof = digest(provenance?.managed_installed_skill)
    && (programmed ? digest(provenance.cache_loaded_skill) && sameDigest(provenance.cache_loaded_skill, provenance.managed_installed_skill) : provenance?.cache_loaded_skill === null);
  const expectedDigestsMatch = (!expected.scenarioDigest || sameDigest(provenance?.consumed_scenario, expected.scenarioDigest))
    && (!expected.corpusDigest || sameDigest(provenance?.consumed_corpus, expected.corpusDigest));
  if (result?.schema_version !== 1 || result.scenario_id !== scenarioId || !exactObject(provenance, PROVENANCE_KEYS)
    || !digest(provenance?.consumed_scenario) || !digest(provenance?.consumed_corpus)
    || !digest(provenance?.adapter) || !validSkillProof || !validProjection || !validClient || !validModel
    || !['succeeded', 'failed', 'not_required'].includes(provenance?.cleanup_status)
    || !expectedDigestsMatch || !validObservations || !Array.isArray(normalizedTranscript)
    || (programmed && (!result.provider_oracle || Array.isArray(result.provider_oracle) || typeof result.provider_oracle !== 'object'))
    || (!programmed && result.provider_oracle !== undefined && result.provider_oracle !== null && (Array.isArray(result.provider_oracle) || typeof result.provider_oracle !== 'object'))) {
    throw Object.assign(new Error('child result has an invalid evidence contract'), { evalCode: 'child_result_invalid' });
  }
  return { provenance, manifest: manifestFrom(provenance), observations: normalizedObservations, transcript: normalizedTranscript, provider_oracle: result.provider_oracle || null };
}

export async function publishFinalEvidence({ evidenceRoot, fixtureRoot, makeEvidence }) {
  const destination = resolve(evidenceRoot); const fixture = resolve(fixtureRoot);
  if (contained(destination, fixture)) throw new Error('evidence root must be outside fixture root');
  await mkdir(destination, { recursive: true });
  const finalPath = resolve(destination, `${randomUUID()}.json`); const temporaryPath = `${finalPath}.tmp`;
  const encoded = JSON.stringify(makeEvidence(finalPath));
  if (Buffer.byteLength(encoded, 'utf8') > EVAL_LIMITS.evidenceBytes) throw new Error('evidence exceeds output limit');
  await writeFile(temporaryPath, encoded, { encoding: 'utf8', flag: 'wx' }); await rename(temporaryPath, finalPath);
  return finalPath;
}

export async function runHarness(config, env, dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn;
  const loadFile = dependencies.readFile || readFile;
  const scheduleTimeout = dependencies.setTimeout || setTimeout;
  const cancelTimeout = dependencies.clearTimeout || clearTimeout;
  const child = spawnProcess(process.execPath, ['--test', `--test-name-pattern=${config.pattern}`, config.test], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = []; const diagnostics = [];
  for (const [stream, target] of [[child.stdout, output], [child.stderr, diagnostics]]) stream.on('data', (chunk) => {
    if (Buffer.concat(target).length < 65_536) target.push(chunk);
  });
  return await new Promise((resolveRun, reject) => {
    let settled = false;
    const finish = (callback) => { if (settled) return; settled = true; cancelTimeout(timer); callback(); };
    const timer = scheduleTimeout(() => {
      child.kill('SIGKILL');
      finish(() => resolveRun({ code: null, signal: 'SIGKILL', failure: 'harness_timeout', diagnostics: 'eval harness timed out' }));
    }, 180_000);
    child.once('error', (error) => finish(() => reject(Object.assign(error, { evalCode: 'harness_spawn_failure' }))));
    child.once('close', async (code, signal) => {
      const stdout = Buffer.concat(output).toString('utf8'); const stderr = Buffer.concat(diagnostics).toString('utf8');
      let childResult = null; let childResultFailure = null;
      try {
        childResult = parseChildResult(await loadFile(env.CURSOR_EVAL_CHILD_RESULT, 'utf8'), env.CURSOR_EVAL_SCENARIO_ID, {
          scenario: config.scenario,
          ...(env.CURSOR_EVAL_SCENARIO_SHA256 ? { scenarioDigest: { sha256: env.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(env.CURSOR_EVAL_SCENARIO_BYTES) } } : {}),
          ...(env.CURSOR_EVAL_CORPUS_SHA256 ? { corpusDigest: { sha256: env.CURSOR_EVAL_CORPUS_SHA256, bytes: Number(env.CURSOR_EVAL_CORPUS_BYTES) } } : {}),
        });
      }
      catch (error) { childResultFailure = error.evalCode || 'child_result_missing'; }
      const behaviorMismatch = childResult?.observations.eval_status === 'agent_behavior_mismatch';
      finish(() => resolveRun({ code, signal, failure: childResultFailure || (code === 0 ? null : behaviorMismatch ? 'scenario_contract_mismatch' : 'harness_failure'), childResult, diagnostics: bounded(stderr || stdout) }));
    });
  });
}

const skippedResult = (scenarioId, lane) => evalResult({
  scenario_id: scenarioId, lane, eval_status: 'skipped', actual_task_outcome: 'not_observed', reported_task_outcome: 'not_reported',
  fixture_assertion_outcome: 'not_observed', evidence_publication_status: 'not_attempted', cleanup_status: 'not_required', failure_stage: null,
});

const failureFields = (scenarioId, lane, stage, code, message, overrides = {}) => ({
  scenario_id: scenarioId, lane, eval_status: 'integration_failure', actual_task_outcome: 'not_observed', reported_task_outcome: 'not_reported',
  fixture_assertion_outcome: 'not_observed', evidence_publication_status: 'not_attempted', cleanup_status: 'not_required', failure_stage: stage,
  error_code: code, message: bounded(message), ...overrides,
});

export async function runEval({ scenarioId = 'client-happy', env = process.env } = {}, dependencies = {}) {
  const loadFile = dependencies.readFile || readFile;
  let rawCorpus; let corpus; let corpusDigest; let scenario;
  try {
    rawCorpus = await loadFile(corpusPath);
    const rawCorpusBytes = Buffer.isBuffer(rawCorpus) ? rawCorpus : Buffer.from(rawCorpus);
    if (rawCorpusBytes.length < 1 || rawCorpusBytes.length > EVAL_LIMITS.evidenceBytes) throw Object.assign(new Error('corpus is outside its byte bound'), { evalCode: 'adapter_admission' });
    corpus = parseScenarioCorpus(rawCorpus);
    corpusDigest = { sha256: createHash('sha256').update(rawCorpusBytes).digest('hex'), bytes: rawCorpusBytes.length };
    scenario = corpus.scenarios.find(({ scenario_id: id }) => id === scenarioId);
  } catch (error) {
    return evalResult(failureFields(bounded(scenarioId, 128), 'model-behavior', 'adapter_admission', 'adapter_admission', error.message));
  }
  if (!scenario) return evalResult(failureFields(bounded(scenarioId, 128), 'model-behavior', 'runner', 'unknown_scenario', 'unknown scenario'));
  const lane = LANES[scenario.lane];
  if (env[lane.enable] !== '1') return skippedResult(scenarioId, scenario.lane);

  const makeFixture = dependencies.mkdtemp || mkdtemp;
  const makeDirectory = dependencies.mkdir || mkdir;
  const removeFixture = dependencies.rm || rm;
  const executeHarness = dependencies.runHarness || runHarness;
  const publish = dependencies.publishEvidence || publishFinalEvidence;
  let fixtureRoot;
  try { fixtureRoot = await makeFixture(join(tmpdir(), 'cursor-eval-runner-')); }
  catch (error) { return evalResult(failureFields(scenarioId, scenario.lane, 'runner', 'fixture_setup_failed', error.message)); }

  const evidenceRoot = env.CURSOR_EVAL_EVIDENCE_ROOT || join(tmpdir(), 'cursor-eval-evidence');
  const childResultPath = join(fixtureRoot, 'child-result.json');
  const workspace = join(fixtureRoot, 'workspace');
  let fields;
  let childResult = null;
  let harnessEvidence = null;
  try {
    await makeDirectory(workspace, { recursive: true });
    const materialized = materializeScenario(scenario, { workspace });
    const config = { ...lane, lane: scenario.lane, scenario, materializedScenario: materialized.materializedScenario };
    const harnessEnv = {
      ...env,
      ...lane.env,
      CURSOR_EVAL_CHILD_RESULT: childResultPath,
      CURSOR_EVAL_SCENARIO_ID: scenarioId,
      CURSOR_EVAL_WORKSPACE: workspace,
      CURSOR_EVAL_SCENARIO_PAYLOAD: materialized.canonicalPayload,
      CURSOR_EVAL_SCENARIO_SHA256: materialized.digest.sha256,
      CURSOR_EVAL_SCENARIO_BYTES: String(materialized.digest.bytes),
      CURSOR_EVAL_CORPUS_SHA256: corpusDigest.sha256,
      CURSOR_EVAL_CORPUS_BYTES: String(corpusDigest.bytes),
    };
    const harness = await executeHarness(config, harnessEnv);
    childResult = harness.childResult || null;
    harnessEvidence = { exit_code: harness.code, signal: harness.signal, failure: harness.failure, diagnostics_sha256: createHash('sha256').update(harness.diagnostics || '').digest('hex') };
    const oracle = childResult && scenario.scenario_kind === 'programmed'
      ? evaluateScenario(materialized.materializedScenario, childResult.observations)
      : childResult?.observations || null;
    const actual = oracle?.actual_task_outcome || 'not_observed';
    const reported = oracle?.reported_task_outcome || 'not_reported';
    const childCleanupFailed = childResult?.provenance.cleanup_status === 'failed';
    const integrationFailure = !childResult || (harness.failure && harness.failure !== 'scenario_contract_mismatch') || oracle?.eval_status === 'integration_failure' || childCleanupFailed;
    const behaviorMatches = !integrationFailure && oracle?.eval_status === scenario.expected_enabled_eval_status && oracle.assertion_outcome === 'pass';
    fields = {
      scenario_id: scenarioId, lane: scenario.lane,
      eval_status: integrationFailure ? 'integration_failure' : behaviorMatches ? 'pass' : 'agent_behavior_mismatch',
      actual_task_outcome: actual, reported_task_outcome: reported, fixture_assertion_outcome: oracle?.assertion_outcome || (integrationFailure ? 'not_observed' : 'fail'),
      evidence_publication_status: 'not_attempted', cleanup_status: 'succeeded',
      failure_stage: childCleanupFailed ? 'cleanup' : integrationFailure ? 'runner' : behaviorMatches ? null : 'scenario',
      error_code: childCleanupFailed ? 'cleanup_failed' : integrationFailure ? (harness.failure || 'child_integration_failure') : behaviorMatches ? null : 'scenario_contract_mismatch',
      message: childCleanupFailed ? 'child cleanup failed' : integrationFailure ? 'eval harness failed' : behaviorMatches ? null : 'eval harness did not satisfy the scenario contract',
    };
  } catch (error) {
    const stage = error.evalCode === 'adapter_admission' ? 'adapter_admission' : 'runner';
    fields = failureFields(scenarioId, scenario.lane, stage, error.evalCode || 'runner_failure', error.message, { cleanup_status: 'succeeded' });
  }

  try { await removeFixture(fixtureRoot, { recursive: true, force: true }); }
  catch (error) {
    fields = { ...fields, eval_status: 'integration_failure', cleanup_status: 'failed', failure_stage: 'cleanup', error_code: 'cleanup_failed', message: bounded(error.message) };
  }
  if (!childResult?.manifest) return evalResult({ ...fields, evidence_publication_status: 'not_attempted', evidence_ref: null });
  try {
    let publishedResult;
    await publish({ evidenceRoot, fixtureRoot, makeEvidence: (ref) => {
      publishedResult = evalResult({ ...fields, evidence_publication_status: 'published', evidence_ref: ref });
      return { schema_version: 1, scenario_id: scenarioId, lane: scenario.lane, failure_artifact: !childResult,
        skill: childResult?.provenance.managed_installed_skill || null, transcript: childResult?.transcript || [], provider_oracle: childResult?.provider_oracle || null,
        fixture_oracle: childResult?.observations || null, harness: harnessEvidence, final_result: publishedResult,
        manifest: childResult?.manifest || null };
    } });
    return publishedResult;
  } catch (error) {
    const cleanupFailed = fields.failure_stage === 'cleanup';
    return evalResult({ ...fields, eval_status: 'integration_failure', evidence_publication_status: 'failed', evidence_ref: null,
      failure_stage: cleanupFailed ? fields.failure_stage : 'publication', error_code: cleanupFailed ? fields.error_code : 'evidence_publication_failed', message: cleanupFailed ? fields.message : bounded(error.message) });
  }
}

export async function cli({ argv = process.argv, processLike = process, evaluate = runEval, write = writeEvalResult } = {}) {
  const scenarioId = argv[2] || 'client-happy';
  let emitted = false;
  const emit = (result) => { if (!emitted) { emitted = true; write(result); } };
  processLike.once('SIGTERM', () => {
    emit(evalResult(failureFields(bounded(scenarioId, 128), 'model-behavior', 'runner', 'runner_terminated', 'runner received SIGTERM before completing the scenario', { cleanup_status: 'failed' })));
    processLike.exitCode = 143;
  });
  try { emit(await evaluate({ scenarioId })); }
  catch (error) {
    let lane = 'model-behavior';
    try {
      const corpus = parseScenarioCorpus(await readFile(corpusPath));
      lane = corpus.scenarios.find(({ scenario_id: id }) => id === scenarioId)?.lane || lane;
    } catch {}
    emit(evalResult(failureFields(bounded(scenarioId, 128), lane, 'runner', 'unhandled_runner_failure', error.message, { cleanup_status: 'failed' })));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await cli();
