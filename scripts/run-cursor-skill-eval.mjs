#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, evaluateScenario, materializeScenario, parseScenarioCorpus } from './cursor-eval-scenario.mjs';
import { applySkillSensitivity, EVAL_LIMITS, evalResult, writeEvalResult } from './cursor-skill-eval.mjs';
import { runSupervisor as runNodeTestSupervisor } from './run-node-tests.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const integrationTest = fileURLToPath(new URL('../tests/codex-client-integration.test.mjs', import.meta.url));
const releaseTest = fileURLToPath(new URL('../tests/release-e2e.test.mjs', import.meta.url));
const corpusPath = fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url));
const skillPath = fileURLToPath(new URL('../skills/cursor-subagent/SKILL.md', import.meta.url));
const LANES = Object.freeze({
  'client-integration': { enable: 'CURSOR_EVAL_REAL_CODEX', test: integrationTest, pattern: 'credential-free client integration', env: { CURSOR_EVAL_REAL_CODEX: '1' } },
  'model-behavior': { enable: 'CURSOR_EVAL_HOSTED_CODEX', test: integrationTest, pattern: 'hosted Codex', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } },
  'full-live': { enable: 'CURSOR_SUBAGENT_LIVE_E2E', test: releaseTest, pattern: 'live release canary', env: { CURSOR_SUBAGENT_LIVE_E2E: '1' } },
});
const DIGEST_KEYS = Object.freeze(['bytes', 'sha256']);
const PROVENANCE_KEYS = Object.freeze(['adapter', 'cache_loaded_skill', 'cleanup_status', 'client', 'consumed_corpus', 'consumed_scenario', 'installed_payload', 'managed_installed_skill', 'model']);

function bounded(value, limit = 8_000) {
  const content = Buffer.from(String(value || ''), 'utf8').toString('utf8');
  if (Buffer.byteLength(content, 'utf8') <= limit) return content;
  const suffix = '...';
  const contentLimit = limit - Buffer.byteLength(suffix, 'utf8');
  let truncated = '';
  let bytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > contentLimit) break;
    truncated += character;
    bytes += characterBytes;
  }
  return `${truncated}${suffix}`;
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

function bytesDigest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function expectedDigest(env, prefix) {
  if (env[`${prefix}_SHA256`] === undefined && env[`${prefix}_BYTES`] === undefined) return null;
  const value = { sha256: env[`${prefix}_SHA256`], bytes: Number(env[`${prefix}_BYTES`]) };
  if (!digest(value)) throw Object.assign(new Error(`${prefix} is invalid`), { evalCode: 'adapter_admission' });
  return value;
}

function transcriptEvidence(value) {
  return exactObject(value, ['calls', 'dropped_calls']) && Array.isArray(value.calls)
    && Number.isSafeInteger(value.dropped_calls) && value.dropped_calls >= 0;
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
  const normalizedTranscript = result?.transcript;
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
    || !expectedDigestsMatch || !validObservations || !transcriptEvidence(normalizedTranscript)
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
  const loadFile = dependencies.readFile || readFile;
  const supervise = dependencies.runSupervisor || runNodeTestSupervisor;
  const test = relative(repository, config.test);
  const supervised = await supervise({ laneName: 'eval', tests: [test], testNamePattern: config.pattern, env,
    ...(dependencies.artifactRoot ? { artifactRoot: dependencies.artifactRoot } : {}) });
  let childResult = null; let childResultFailure = null;
  try {
    childResult = parseChildResult(await loadFile(env.CURSOR_EVAL_CHILD_RESULT, 'utf8'), env.CURSOR_EVAL_SCENARIO_ID, {
      scenario: config.scenario,
      ...(env.CURSOR_EVAL_SCENARIO_SHA256 ? { scenarioDigest: { sha256: env.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(env.CURSOR_EVAL_SCENARIO_BYTES) } } : {}),
      ...(env.CURSOR_EVAL_CORPUS_SHA256 ? { corpusDigest: { sha256: env.CURSOR_EVAL_CORPUS_SHA256, bytes: Number(env.CURSOR_EVAL_CORPUS_BYTES) } } : {}),
    });
  }
  catch (error) { childResultFailure = error.evalCode || 'child_result_missing'; }
  const code = supervised.child?.code ?? null;
  const signal = supervised.child?.signal ?? null;
  const behaviorMismatch = childResult?.observations.eval_status === 'agent_behavior_mismatch';
  const supervisorFailure = supervised.verdict === 'passed' ? null
    : supervised.terminal_cause === 'deadline' ? 'harness_timeout'
      : supervised.terminal_cause === 'spawn_error' ? 'harness_spawn_failure'
        : supervised.verdict === 'runner_error' || supervised.infrastructure ? 'harness_infrastructure_failure'
          : behaviorMismatch && supervised.terminal_cause === 'exit_nonzero' ? 'scenario_contract_mismatch'
            : 'harness_failure';
  const infrastructureFailure = ['harness_timeout', 'harness_spawn_failure', 'harness_infrastructure_failure'].includes(supervisorFailure) ? supervisorFailure : null;
  return { code, signal, failure: infrastructureFailure || childResultFailure || supervisorFailure, childResult,
    diagnostics: bounded((supervised.failureDetails || []).join('\n')) };
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

export async function runEval({ scenarioId = null, env = process.env } = {}, dependencies = {}) {
  const loadFile = dependencies.readFile || readFile;
  const loadSkillFile = dependencies.readSkillFile || readFile;
  let rawCorpus; let corpus; let corpusDigest; let scenario;
  try {
    rawCorpus = await loadFile(corpusPath);
    const rawCorpusBytes = Buffer.isBuffer(rawCorpus) ? rawCorpus : Buffer.from(rawCorpus);
    if (rawCorpusBytes.length < 1 || rawCorpusBytes.length > EVAL_LIMITS.evidenceBytes) throw Object.assign(new Error('corpus is outside its byte bound'), { evalCode: 'adapter_admission' });
    corpus = parseScenarioCorpus(rawCorpus);
    corpusDigest = { sha256: createHash('sha256').update(rawCorpusBytes).digest('hex'), bytes: rawCorpusBytes.length };
    scenarioId ||= corpus.scenarios.find(({ lane }) => lane === 'client-integration')?.scenario_id || null;
    scenario = corpus.scenarios.find(({ scenario_id: id }) => id === scenarioId);
  } catch (error) {
    return evalResult(failureFields(bounded(scenarioId || 'corpus-default', 128), 'model-behavior', 'adapter_admission', 'adapter_admission', error.message));
  }
  if (!scenario) return evalResult(failureFields(bounded(scenarioId || 'corpus-default', 128), 'model-behavior', 'runner', 'unknown_scenario', 'unknown scenario'));
  const sensitivity = env.CURSOR_EVAL_SKILL_SENSITIVITY || null;
  if (sensitivity !== null && sensitivity !== scenario.skill_sensitivity?.mutation) {
    return evalResult(failureFields(scenarioId, scenario.lane, 'adapter_admission', 'adapter_admission', 'invalid skill sensitivity check'));
  }
  const lane = LANES[scenario.lane];
  if (env[lane.enable] !== '1') return skippedResult(scenarioId, scenario.lane);

  let sensitivityBaseline = null;
  let sensitivityPair = null;
  if (sensitivity !== null) {
    let sourceSkill;
    try { sourceSkill = await loadSkillFile(skillPath); }
    catch (error) { return evalResult(failureFields(scenarioId, scenario.lane, 'inspection', 'sensitivity_source_unavailable', error.message)); }
    const sourceSkillDigest = bytesDigest(sourceSkill);
    let mutatedSkill;
    try { mutatedSkill = applySkillSensitivity(Buffer.from(sourceSkill).toString('utf8'), sensitivity); }
    catch (error) { return evalResult(failureFields(scenarioId, scenario.lane, 'adapter_admission', error.evalCode || 'adapter_admission', error.message)); }
    const mutatedSkillDigest = bytesDigest(mutatedSkill);
    sensitivityPair = {
      corpus: corpusDigest,
      scenario_definition: bytesDigest(canonicalJson(scenario)),
      source_skill: sourceSkillDigest,
      baseline_loaded_skill: sourceSkillDigest,
      mutated_loaded_skill: mutatedSkillDigest,
    };
    const pairEnvironment = {
      CURSOR_EVAL_EXPECTED_SOURCE_SKILL_SHA256: sourceSkillDigest.sha256,
      CURSOR_EVAL_EXPECTED_SOURCE_SKILL_BYTES: String(sourceSkillDigest.bytes),
    };
    sensitivityBaseline = await runEval({ scenarioId, env: {
      ...env, ...pairEnvironment,
      CURSOR_EVAL_EXPECTED_LOADED_SKILL_SHA256: sourceSkillDigest.sha256,
      CURSOR_EVAL_EXPECTED_LOADED_SKILL_BYTES: String(sourceSkillDigest.bytes),
      CURSOR_EVAL_SKILL_SENSITIVITY: '',
    } }, { ...dependencies, readFile: async () => rawCorpus });
    if (sensitivityBaseline.eval_status !== 'pass') {
      if (sensitivityBaseline.eval_status === 'integration_failure') return sensitivityBaseline;
      return evalResult(failureFields(scenarioId, scenario.lane, 'scenario', 'sensitivity_baseline_failed',
        'skill sensitivity requires a fresh passing baseline', {
          actual_task_outcome: sensitivityBaseline.actual_task_outcome,
          reported_task_outcome: sensitivityBaseline.reported_task_outcome,
          fixture_assertion_outcome: sensitivityBaseline.fixture_assertion_outcome,
          cleanup_status: sensitivityBaseline.cleanup_status,
          evidence_publication_status: sensitivityBaseline.evidence_publication_status,
          evidence_ref: sensitivityBaseline.evidence_ref,
        }));
    }
    let currentSourceSkill;
    try { currentSourceSkill = bytesDigest(await loadSkillFile(skillPath)); }
    catch (error) {
      return evalResult(failureFields(scenarioId, scenario.lane, 'inspection', 'sensitivity_source_unavailable', error.message, {
        cleanup_status: sensitivityBaseline.cleanup_status,
        evidence_publication_status: sensitivityBaseline.evidence_publication_status,
        evidence_ref: sensitivityBaseline.evidence_ref,
      }));
    }
    if (!sameDigest(currentSourceSkill, sourceSkillDigest)) {
      return evalResult(failureFields(scenarioId, scenario.lane, 'inspection', 'sensitivity_source_drift',
        'skill source changed between sensitivity baseline and mutation', {
          cleanup_status: sensitivityBaseline.cleanup_status,
          evidence_publication_status: sensitivityBaseline.evidence_publication_status,
          evidence_ref: sensitivityBaseline.evidence_ref,
        }));
    }
    env = {
      ...env, ...pairEnvironment,
      CURSOR_EVAL_EXPECTED_LOADED_SKILL_SHA256: mutatedSkillDigest.sha256,
      CURSOR_EVAL_EXPECTED_LOADED_SKILL_BYTES: String(mutatedSkillDigest.bytes),
    };
  }

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
  let fixtureOracle = null;
  try {
    await makeDirectory(workspace, { recursive: true });
    const materialized = materializeScenario(scenario, { workspace });
    const expectedPluginDirsSha256 = materialized.bindings.PLUGIN_DIR
      ? createHash('sha256').update(JSON.stringify([materialized.bindings.PLUGIN_DIR])).digest('hex')
      : null;
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
      ...(scenario.harness_faults?.includes('inject-stale-question-once') ? { CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' } : {}),
      ...(scenario.harness_faults?.includes('inject-mode-protocol-error-once') ? { CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE: '1' } : {}),
      ...(scenario.harness_faults?.includes('accelerate-wait-timeout') ? { FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1' } : {}),
      ...(expectedPluginDirsSha256 ? { CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256: expectedPluginDirsSha256 } : {}),
    };
    const harness = await executeHarness(config, harnessEnv);
    childResult = harness.childResult || null;
    harnessEvidence = { exit_code: harness.code, signal: harness.signal, failure: harness.failure, diagnostics_sha256: createHash('sha256').update(harness.diagnostics || '').digest('hex') };
    const oracle = childResult && scenario.scenario_kind === 'programmed'
      ? evaluateScenario(materialized.materializedScenario, childResult.observations)
      : childResult?.observations || null;
    fixtureOracle = oracle;
    const actual = oracle?.actual_task_outcome || 'not_observed';
    const reported = oracle?.reported_task_outcome || 'not_reported';
    const childCleanupFailed = childResult?.provenance.cleanup_status === 'failed';
    const expectedLoadedSkill = expectedDigest(env, 'CURSOR_EVAL_EXPECTED_LOADED_SKILL');
    const sensitivityPayloadMismatch = expectedLoadedSkill !== null && !sameDigest(childResult?.provenance.managed_installed_skill, expectedLoadedSkill);
    const integrationFailure = !childResult || (harness.failure && harness.failure !== 'scenario_contract_mismatch') || oracle?.eval_status === 'integration_failure' || childCleanupFailed || sensitivityPayloadMismatch;
    const behaviorMatches = !integrationFailure && (sensitivity !== null
      ? oracle?.eval_status === 'agent_behavior_mismatch' && oracle.assertion_outcome === 'fail'
        && oracle.mismatches?.length === 1 && oracle.mismatches[0] === scenario.skill_sensitivity.expected_mismatch
      : oracle?.eval_status === scenario.expected_enabled_eval_status && oracle.assertion_outcome === 'pass');
    fields = {
      scenario_id: scenarioId, lane: scenario.lane,
      eval_status: integrationFailure ? 'integration_failure' : behaviorMatches ? 'pass' : 'agent_behavior_mismatch',
      actual_task_outcome: actual, reported_task_outcome: reported,
      fixture_assertion_outcome: behaviorMatches ? 'pass' : oracle?.assertion_outcome || (integrationFailure ? 'not_observed' : 'fail'),
      evidence_publication_status: 'not_attempted', cleanup_status: childCleanupFailed ? 'failed' : 'succeeded',
      failure_stage: childCleanupFailed ? 'cleanup' : sensitivityPayloadMismatch ? 'skill_load' : integrationFailure ? 'runner' : behaviorMatches ? null : 'scenario',
      error_code: childCleanupFailed ? 'cleanup_failed' : sensitivityPayloadMismatch ? 'sensitivity_payload_mismatch' : integrationFailure ? (harness.failure || 'child_integration_failure') : behaviorMatches ? null : 'scenario_contract_mismatch',
      message: childCleanupFailed ? 'child cleanup failed' : sensitivityPayloadMismatch ? 'loaded skill does not match the paired sensitivity payload' : integrationFailure ? 'eval harness failed' : behaviorMatches ? null : 'eval harness did not satisfy the scenario contract',
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
        skill: childResult?.provenance.managed_installed_skill || null,
        transcript: childResult?.transcript || { calls: [], dropped_calls: 0 }, provider_oracle: childResult?.provider_oracle || null,
        fixture_oracle: fixtureOracle,
        harness: { ...harnessEvidence, skill_sensitivity: sensitivity,
          sensitivity_baseline: sensitivityBaseline ? {
            scenario_id: sensitivityBaseline.scenario_id,
            eval_status: sensitivityBaseline.eval_status,
            evidence_ref: sensitivityBaseline.evidence_ref,
          } : null,
          sensitivity_pair: sensitivityPair }, final_result: publishedResult,
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
  const scenarioId = argv[2] || null;
  let emitted = false;
  const emit = (result) => {
    if (emitted) return false;
    emitted = true;
    write(result);
    return true;
  };
  processLike.once('SIGTERM', () => {
    emit(evalResult(failureFields(bounded(scenarioId || 'corpus-default', 128), 'model-behavior', 'runner', 'runner_terminated', 'runner received SIGTERM before completing the scenario', { cleanup_status: 'failed' })));
    processLike.exitCode = 143;
  });
  try {
    const result = await evaluate({ scenarioId });
    if (emit(result) && result.eval_status !== 'pass' && result.eval_status !== 'skipped') processLike.exitCode = 1;
  }
  catch (error) {
    let lane = 'model-behavior';
    try {
      const corpus = parseScenarioCorpus(await readFile(corpusPath));
      const selected = scenarioId === null ? corpus.scenarios.find(({ lane: candidateLane }) => candidateLane === 'client-integration')
        : corpus.scenarios.find(({ scenario_id: id }) => id === scenarioId);
      lane = selected?.lane || lane;
    } catch {}
    if (emit(evalResult(failureFields(bounded(scenarioId || 'corpus-default', 128), lane, 'runner', 'unhandled_runner_failure', error.message, { cleanup_status: 'failed' })))) processLike.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await cli();
