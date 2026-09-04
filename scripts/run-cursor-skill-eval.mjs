#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EVAL_LIMITS, evalResult, writeEvalResult } from './cursor-skill-eval.mjs';

const integrationTest = fileURLToPath(new URL('../tests/codex-client-integration.test.mjs', import.meta.url));
const releaseTest = fileURLToPath(new URL('../tests/release-e2e.test.mjs', import.meta.url));
const SCENARIOS = Object.freeze({
  'client-happy': { lane: 'client-integration', enable: 'CURSOR_EVAL_REAL_CODEX', test: integrationTest, pattern: 'credential-free client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } },
  'model-question': { lane: 'model-behavior', enable: 'CURSOR_EVAL_HOSTED_CODEX', test: integrationTest, pattern: 'hosted Codex', env: { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_FAKE_ACP_PENDING: 'question' } },
  'model-plan': { lane: 'model-behavior', enable: 'CURSOR_EVAL_HOSTED_CODEX', test: integrationTest, pattern: 'hosted Codex', env: { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_FAKE_ACP_PENDING: 'plan' } },
  'model-permission-covered': { lane: 'model-behavior', enable: 'CURSOR_EVAL_HOSTED_CODEX', test: integrationTest, pattern: 'hosted Codex', env: { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_FAKE_ACP_PENDING: 'permission', CURSOR_EVAL_MODEL_SCENARIO: 'permission-covered' } },
  'model-permission-expansion': { lane: 'model-behavior', enable: 'CURSOR_EVAL_HOSTED_CODEX', test: integrationTest, pattern: 'hosted Codex', env: { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_FAKE_ACP_PENDING: 'permission', CURSOR_EVAL_MODEL_SCENARIO: 'permission-expansion' } },
  'model-semantic-failure': { lane: 'model-behavior', enable: 'CURSOR_EVAL_HOSTED_CODEX', test: integrationTest, pattern: 'hosted Codex', env: { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_MODEL_SCENARIO: 'semantic-failure' } },
  'live-marker': { lane: 'full-live', enable: 'CURSOR_SUBAGENT_LIVE_E2E', test: releaseTest, pattern: 'live release canary', env: { CURSOR_SUBAGENT_LIVE_E2E: '1' } },
});
const DEFERRED_TOOL_SEQUENCE = Object.freeze(['tool_search', 'cursor_delegate', 'tool_search', 'cursor_wait', 'tool_search', 'cursor_close_session', 'final']);
const PROVIDER_TRACE_LIMIT = 16;

function bounded(value, limit = 8_000) {
  const content = String(value || '');
  return Buffer.byteLength(content, 'utf8') <= limit ? content : `${Buffer.from(content, 'utf8').subarray(0, limit - 3).toString('utf8')}...`;
}

function contained(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && path !== '..' && !isAbsolute(path));
}

export function transcriptIsCorrelated(transcript) {
  if (!Array.isArray(transcript) || transcript.length < 3 || transcript[0]?.tool !== 'cursor_delegate' || transcript.at(-1)?.tool !== 'cursor_close_session') return false;
  if (transcript.some((entry) => entry?.direction !== 'request' || !['string', 'number'].includes(typeof entry.call_id) || typeof entry.tool !== 'string' || entry.response?.ok !== true)) return false;
  const sessionId = transcript[0].response?.session_id; const turnId = transcript[0].response?.turn_id;
  if (!sessionId || !turnId) return false;
  const pendingIds = new Set();
  for (const entry of transcript) {
    if (entry.request?.session_id !== undefined && entry.request.session_id !== sessionId) return false;
    if (entry.request?.turn_id !== undefined && entry.request.turn_id !== turnId) return false;
    if (entry.response?.session_id !== undefined && entry.response.session_id !== sessionId) return false;
    if (entry.response?.turn_id !== undefined && entry.response.turn_id !== turnId) return false;
    for (const pending of entry.response?.active_turn?.pending || []) if (pending?.request_id) pendingIds.add(pending.request_id);
    if (entry.tool.startsWith('cursor_answer_') && !pendingIds.has(entry.request?.request_id)) return false;
  }
  return transcript.at(-1).request?.session_id === sessionId;
}

export function parseChildResult(encoded, scenarioId) {
  if (Buffer.byteLength(encoded, 'utf8') > EVAL_LIMITS.evidenceBytes) throw Object.assign(new Error('child result exceeds evidence limit'), { evalCode: 'child_result_invalid' });
  let result;
  try { result = JSON.parse(encoded); } catch { throw Object.assign(new Error('child result is not JSON'), { evalCode: 'child_result_invalid' }); }
  const skillSha256 = result?.skill?.sha256 || result?.skill_sha256;
  const oracle = result?.fixture_oracle;
  const provider = result?.provider_oracle;
  const toolSequence = provider?.tool_sequence;
  const requestTrace = provider?.request_trace;
  const providerTraceIsBounded = Array.isArray(toolSequence) && toolSequence.length > 0 && toolSequence.length <= PROVIDER_TRACE_LIMIT
    && toolSequence.every((tool) => typeof tool === 'string' && Buffer.byteLength(tool, 'utf8') <= EVAL_LIMITS.fieldBytes)
    && Array.isArray(requestTrace) && requestTrace.length === toolSequence.length && requestTrace.length <= PROVIDER_TRACE_LIMIT
    && requestTrace.every((entry, index) => entry && !Array.isArray(entry) && typeof entry === 'object'
      && Object.keys(entry).sort().join('\0') === ['call_id', 'step', 'tool'].join('\0')
      && entry.step === index + 1 && entry.tool === toolSequence[index]
      && (entry.tool === 'final' ? entry.call_id === null : typeof entry.call_id === 'string' && Buffer.byteLength(entry.call_id, 'utf8') > 0 && Buffer.byteLength(entry.call_id, 'utf8') <= EVAL_LIMITS.fieldBytes));
  const deferredRouteMatches = scenarioId !== 'client-happy'
    || (provider?.request_count === DEFERRED_TOOL_SEQUENCE.length + 1 && toolSequence?.every((tool, index) => tool === DEFERRED_TOOL_SEQUENCE[index])
      && new Set(requestTrace?.slice(0, -1).map(({ call_id: callId }) => callId)).size === DEFERRED_TOOL_SEQUENCE.length - 1);
  if (result?.schema_version !== 1 || result.scenario_id !== scenarioId || !/^[a-f0-9]{64}$/.test(skillSha256 || '') || !Number.isSafeInteger(result?.skill?.bytes) || result.skill.bytes < 1
    || !transcriptIsCorrelated(result.transcript) || !provider || Array.isArray(provider) || typeof provider !== 'object'
    || !Number.isSafeInteger(provider.request_count) || provider.request_count < 1 || provider.skill_context_seen !== true || typeof provider.terminal_result_matched !== 'boolean'
    || !providerTraceIsBounded || !deferredRouteMatches
    || !oracle || !['succeeded', 'failed', 'not_observed'].includes(oracle.actual_task_outcome)
    || !['succeeded', 'failed', 'not_reported'].includes(oracle.reported_task_outcome) || !['pass', 'fail', 'not_observed'].includes(oracle.assertion_outcome)
    || !['pass', 'agent_behavior_mismatch', 'integration_failure'].includes(result.eval_status)) {
    throw Object.assign(new Error('child result has an invalid evidence contract'), { evalCode: 'child_result_invalid' });
  }
  return { skill: { sha256: skillSha256, bytes: result.skill.bytes }, transcript: result.transcript,
    provider_oracle: { request_count: provider.request_count, skill_context_seen: provider.skill_context_seen, terminal_result_matched: provider.terminal_result_matched,
      tool_sequence: [...toolSequence], request_trace: requestTrace.map(({ step, tool, call_id: callId }) => ({ step, tool, call_id: callId })) },
    fixture_oracle: oracle, eval_status: result.eval_status };
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
      finish(() => resolveRun({ code: null, signal: 'SIGKILL', failure: 'harness_timeout', semantic: null, diagnostics: 'eval harness timed out' }));
    }, 180_000);
    child.once('error', (error) => finish(() => reject(Object.assign(error, { evalCode: 'harness_spawn_failure' }))));
    child.once('close', async (code, signal) => {
      const stdout = Buffer.concat(output).toString('utf8'); const stderr = Buffer.concat(diagnostics).toString('utf8');
      const semantic = stdout.match(/semantic_failure actual=(succeeded|failed|not_observed) reported=(succeeded|failed|not_reported)/);
      const contractMismatch = stdout.includes('hosted MCP transcript missing') || stdout.includes('Expected values to be strictly deep-equal') || Boolean(semantic);
      let childResult = null; let childResultFailure = null;
      try { childResult = parseChildResult(await loadFile(env.CURSOR_EVAL_CHILD_RESULT, 'utf8'), env.CURSOR_EVAL_SCENARIO_ID); }
      catch (error) { childResultFailure = error.evalCode || 'child_result_missing'; }
      finish(() => resolveRun({ code, signal, failure: childResultFailure || (code === 0 ? null : contractMismatch ? 'scenario_contract_mismatch' : 'harness_failure'), childResult, semantic: semantic ? { actual: semantic[1], reported: semantic[2] } : null, diagnostics: bounded(stderr) }));
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
  const config = SCENARIOS[scenarioId];
  if (!config) return evalResult(failureFields(bounded(scenarioId, 128), 'model-behavior', 'runner', 'unknown_scenario', 'unknown scenario'));
  if (env[config.enable] !== '1') return skippedResult(scenarioId, config.lane);

  const makeFixture = dependencies.mkdtemp || mkdtemp;
  const removeFixture = dependencies.rm || rm;
  const executeHarness = dependencies.runHarness || runHarness;
  const publish = dependencies.publishEvidence || publishFinalEvidence;
  let fixtureRoot;
  try { fixtureRoot = await makeFixture(join(tmpdir(), 'cursor-eval-runner-')); }
  catch (error) { return evalResult(failureFields(scenarioId, config.lane, 'runner', 'fixture_setup_failed', error.message)); }

  const evidenceRoot = env.CURSOR_EVAL_EVIDENCE_ROOT || join(tmpdir(), 'cursor-eval-evidence');
  const childResultPath = join(fixtureRoot, 'child-result.json');
  let fields;
  let childResult = null;
  let harnessEvidence = null;
  try {
    const harness = await executeHarness(config, { ...env, ...config.env, CURSOR_EVAL_CHILD_RESULT: childResultPath, CURSOR_EVAL_SCENARIO_ID: scenarioId });
    childResult = harness.childResult || null;
    harnessEvidence = { exit_code: harness.code, signal: harness.signal, failure: harness.failure, diagnostics_sha256: createHash('sha256').update(harness.diagnostics || '').digest('hex') };
    const actual = childResult?.fixture_oracle.actual_task_outcome || harness.semantic?.actual || 'not_observed';
    const reported = childResult?.fixture_oracle.reported_task_outcome || harness.semantic?.reported || 'not_reported';
    const expected = scenarioId === 'model-semantic-failure' ? 'failed' : 'succeeded';
    const behaviorMatches = harness.code === 0 && childResult?.eval_status === 'pass' && childResult.fixture_oracle.assertion_outcome === 'pass' && actual === expected && reported === expected;
    const integrationFailure = harness.failure && harness.failure !== 'scenario_contract_mismatch';
    fields = {
      scenario_id: scenarioId, lane: config.lane,
      eval_status: integrationFailure ? 'integration_failure' : behaviorMatches ? 'pass' : 'agent_behavior_mismatch',
      actual_task_outcome: actual, reported_task_outcome: reported, fixture_assertion_outcome: childResult?.fixture_oracle.assertion_outcome || (integrationFailure ? 'not_observed' : 'fail'),
      evidence_publication_status: 'not_attempted', cleanup_status: 'succeeded',
      failure_stage: integrationFailure ? 'runner' : behaviorMatches ? null : 'scenario',
      error_code: integrationFailure ? harness.failure : behaviorMatches ? null : 'scenario_contract_mismatch',
      message: integrationFailure ? 'eval harness failed' : behaviorMatches ? null : 'eval harness did not satisfy the scenario contract',
    };
  } catch (error) {
    fields = failureFields(scenarioId, config.lane, 'runner', error.evalCode || 'runner_failure', error.message, { cleanup_status: 'succeeded' });
  }

  try { await removeFixture(fixtureRoot, { recursive: true, force: true }); }
  catch (error) {
    fields = { ...fields, eval_status: 'integration_failure', cleanup_status: 'failed', failure_stage: 'cleanup', error_code: 'cleanup_failed', message: bounded(error.message) };
  }
  try {
    let publishedResult;
    const evidenceRef = await publish({ evidenceRoot, fixtureRoot, makeEvidence: (ref) => {
      publishedResult = evalResult({ ...fields, evidence_publication_status: 'published', evidence_ref: ref });
      return { schema_version: 1, scenario_id: scenarioId, lane: config.lane, failure_artifact: !childResult,
        skill: childResult?.skill || null, transcript: childResult?.transcript || [], provider_oracle: childResult?.provider_oracle || null,
        fixture_oracle: childResult?.fixture_oracle || null, harness: harnessEvidence, final_result: publishedResult };
    } });
    return publishedResult || evalResult({ ...fields, evidence_publication_status: 'published', evidence_ref: evidenceRef });
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
    const config = SCENARIOS[scenarioId];
    emit(evalResult(failureFields(bounded(scenarioId, 128), config?.lane || 'model-behavior', 'runner', 'runner_terminated', 'runner received SIGTERM before completing the scenario', { cleanup_status: 'failed' })));
    processLike.exitCode = 143;
  });
  try { emit(await evaluate({ scenarioId })); }
  catch (error) { emit(evalResult(failureFields(bounded(scenarioId, 128), SCENARIOS[scenarioId]?.lane || 'model-behavior', 'runner', 'unhandled_runner_failure', error.message, { cleanup_status: 'failed' }))); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await cli();
