import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { admitScenarioCorpus, evaluateScenario, materializeScenario, parseScenarioCorpus } from '../scripts/cursor-eval-scenario.mjs';
import { assertEvalResultV1 } from '../scripts/cursor-skill-eval.mjs';
import { cli, parseChildResult, publishFinalEvidence, runEval, runHarness } from '../scripts/run-cursor-skill-eval.mjs';

const run = fileURLToPath(new URL('../scripts/run-cursor-skill-eval.mjs', import.meta.url));
const execute = promisify(execFile);
const transcript = { calls: [
  { direction: 'request', tool: 'cursor_delegate', call_id: 1, request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
  { direction: 'request', tool: 'cursor_wait', call_id: 2, request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
  { direction: 'request', tool: 'cursor_close_session', call_id: 3, request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
], dropped_calls: 0 };
const toolSequence = ['tool_search', 'cursor_delegate', 'tool_search', 'cursor_wait', 'tool_search', 'cursor_close_session', 'final'];
const requestTrace = toolSequence.map((tool, index) => ({ step: index + 1, tool, call_id: tool === 'final' ? null : `call_${index + 2}` }));
const rawCorpus = await readFile(fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url)));
const admittedCorpus = parseScenarioCorpus(rawCorpus);
const corpusDigest = { sha256: createHash('sha256').update(rawCorpus).digest('hex'), bytes: rawCorpus.length };
const scenarioById = new Map(admittedCorpus.scenarios.map((scenario) => [scenario.scenario_id, scenario]));
const fixedDigest = (character, bytes = 123) => ({ sha256: character.repeat(64), bytes });
const observationsFor = (scenario, { actual = scenario.expected_actual_task_outcome || 'succeeded', reported = scenario.expected_reported_task_outcome || 'succeeded', status = 'pass' } = {}) => ({
  trace: scenario.scenario_kind === 'programmed' ? scenario.expected_trace.map((entry) => ({ ...entry,
    session_id: 'S', ...(entry.kind !== 'session.allocated' ? { turn_id: 'T' } : {}),
    ...(entry.kind.startsWith('pending.') || entry.kind.startsWith('answer.') ? { request_id: scenario.program.steps.find(({ step_id: stepId }) => stepId === entry.step_id)?.callback_id } : {}) })) : [],
  callbacks: scenario.scenario_kind === 'programmed' ? scenario.program.steps.filter(({ type }) => type === 'pending' || type === 'effect').map((step) => ({ step_id: step.step_id, callback_id: step.callback_id, ...step.expected_callback })) : [],
  effects: scenario.scenario_kind === 'programmed' ? scenario.program.steps.filter(({ type }) => type === 'effect').map((step) => ({ kind: 'effect.file-written', step_id: step.step_id, callback_id: step.callback_id, path: step.path, text: step.text })) : [],
  actual_task_outcome: actual, reported_task_outcome: reported,
  assertion_outcome: status === 'pass' ? 'pass' : status === 'integration_failure' ? 'not_observed' : 'fail', eval_status: status,
});
const childResult = (scenarioId = 'model-question', options = {}) => {
  const scenario = scenarioById.get(scenarioId);
  const scenarioDigest = options.scenarioDigest || materializeScenario(scenario, { workspace: '/tmp/fixture/workspace' }).digest;
  const skillDigest = fixedDigest('a');
  const provenance = {
    consumed_scenario: scenarioDigest, consumed_corpus: options.corpusDigest || corpusDigest, adapter: fixedDigest('b', 456),
    managed_installed_skill: skillDigest, cache_loaded_skill: scenario.scenario_kind === 'programmed' ? skillDigest : null,
    installed_payload: { marker_format: 1, payload_hash: 'c'.repeat(64), artifact_hash: 'd'.repeat(64), manifest_version: '0.1.0+codex.fixture' },
    client: { name: 'codex-app-server', version: '0.152.1' }, model: { provider: null, name: null }, cleanup_status: options.cleanup || 'succeeded',
  };
  return {
    provenance,
    manifest: { schema_version: 1, hash_algorithm: 'sha256', hash_encoding: 'lowercase-hex', installed_skill: skillDigest,
      corpus: provenance.consumed_corpus, materialized_scenario: provenance.consumed_scenario, adapter: provenance.adapter,
      installed_payload: provenance.installed_payload, client: provenance.client, model: provenance.model },
    observations: observationsFor(scenario, options), transcript,
    provider_oracle: { request_count: 8, skill_context_seen: true, terminal_result_matched: true, tool_sequence: toolSequence, request_trace: requestTrace },
  };
};
const passHarness = async (config, env) => ({ code: 0, signal: null, failure: null,
  childResult: childResult(config.scenario.scenario_id, {
    scenarioDigest: { sha256: env.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(env.CURSOR_EVAL_SCENARIO_BYTES) },
    corpusDigest: { sha256: env.CURSOR_EVAL_CORPUS_SHA256, bytes: Number(env.CURSOR_EVAL_CORPUS_BYTES) },
  }), diagnostics: '' });
const published = async ({ makeEvidence }) => { makeEvidence('/tmp/evidence.json'); return '/tmp/evidence.json'; };
const removed = async () => {};
const inertFixture = { mkdtemp: async () => '/tmp/fixture', mkdir: async () => {}, rm: removed };
const encodedChildResult = (scenarioId, options = {}, overrides = {}) => JSON.stringify({ schema_version: 1, scenario_id: scenarioId, ...childResult(scenarioId, options), ...overrides });

test('exact-seven corpus admission, materialization and pure oracle stay in one process', { timeout: 2_000 }, async (t) => {
  const corpus = parseScenarioCorpus(rawCorpus);
  const counts = { admission: corpus.scenarios.length, materialization: 0, oracle: 0, packageReference: 0 };
  const byId = new Map(corpus.scenarios.map((scenario) => [scenario.scenario_id, scenario]));
  const observed = (scenario) => ({
    trace: scenario.expected_trace.map((entry) => ({
      ...entry,
      session_id: 'session-1',
      ...(entry.kind !== 'session.allocated' ? { turn_id: 'turn-1' } : {}),
      ...(entry.kind.startsWith('pending.') || entry.kind.startsWith('answer.') ? { request_id: scenario.program.steps.find(({ step_id: stepId }) => stepId === entry.step_id)?.callback_id } : {}),
    })),
    callbacks: scenario.program.steps.filter(({ type }) => type === 'pending' || type === 'effect').map((step) => ({
      step_id: step.step_id, callback_id: step.callback_id, ...step.expected_callback,
    })),
    effects: scenario.program.steps.filter(({ type }) => type === 'effect').map((step) => ({
      kind: 'effect.file-written', step_id: step.step_id, callback_id: step.callback_id, path: step.path, text: step.text,
    })),
    actual_task_outcome: scenario.expected_actual_task_outcome,
    reported_task_outcome: scenario.expected_reported_task_outcome,
  });

  for (const scenario of corpus.scenarios) {
    const materialized = materializeScenario(scenario, { workspace: '/tmp/cursor-eval-workspace' });
    counts.materialization += 1;
    assert.equal(materialized.digest.bytes, Buffer.byteLength(materialized.canonicalPayload, 'utf8'));
    assert.match(materialized.digest.sha256, /^[a-f0-9]{64}$/);
    if (scenario.scenario_kind === 'package-canary-reference') {
      counts.packageReference += 1;
      continue;
    }
    counts.oracle += 1;
    assert.deepEqual(evaluateScenario(materialized.materializedScenario, observed(materialized.materializedScenario)), {
      assertion_outcome: 'pass',
      actual_task_outcome: scenario.expected_actual_task_outcome,
      reported_task_outcome: scenario.expected_reported_task_outcome,
      eval_status: 'pass',
      mismatches: [],
    });
  }
  assert.deepEqual(counts, { admission: 7, materialization: 7, oracle: 6, packageReference: 1 });

  const question = byId.get('model-question');
  assert.throws(() => evaluateScenario({ scenario_kind: 'package-canary-reference' }), /only programmed scenarios/);
  const questionObserved = observed(question);
  const answerIndex = questionObserved.trace.findIndex(({ kind }) => kind === 'answer.question');
  const pendingIndex = questionObserved.trace.findIndex(({ kind }) => kind === 'pending.question');
  const answerBeforePending = structuredClone(questionObserved);
  [answerBeforePending.trace[pendingIndex], answerBeforePending.trace[answerIndex]] = [answerBeforePending.trace[answerIndex], answerBeforePending.trace[pendingIndex]];
  assert.ok(evaluateScenario(question, answerBeforePending).mismatches.includes('answer-before-pending'));
  const wrongId = structuredClone(questionObserved);
  wrongId.trace[answerIndex].request_id = 'other-request';
  assert.ok(evaluateScenario(question, wrongId).mismatches.includes('id-mismatch'));
  const afterClose = structuredClone(questionObserved);
  afterClose.trace.push({ kind: 'turn.completed', step_id: 'terminal-1' });
  assert.ok(evaluateScenario(question, afterClose).mismatches.includes('operation-after-close'));
  const unexpectedEffect = structuredClone(questionObserved);
  unexpectedEffect.effects.push({ kind: 'effect.file-written', step_id: 'not-planned', callback_id: 'write-x' });
  assert.ok(evaluateScenario(question, unexpectedEffect).mismatches.includes('unexpected-effect'));
  const missingClose = structuredClone(questionObserved);
  missingClose.trace.pop();
  assert.ok(evaluateScenario(question, missingClose).mismatches.includes('missing-close-attempt'));
  const missingIds = structuredClone(questionObserved);
  for (const entry of missingIds.trace) {
    delete entry.session_id;
    delete entry.turn_id;
    delete entry.request_id;
  }
  assert.ok(evaluateScenario(question, missingIds).mismatches.includes('id-mismatch'));
  const answerBeforePendingContract = structuredClone(question);
  const pendingTraceIndex = answerBeforePendingContract.expected_trace.findIndex(({ kind }) => kind === 'pending.question');
  const answerTraceIndex = answerBeforePendingContract.expected_trace.findIndex(({ kind }) => kind === 'answer.question');
  [answerBeforePendingContract.expected_trace[pendingTraceIndex], answerBeforePendingContract.expected_trace[answerTraceIndex]] =
    [answerBeforePendingContract.expected_trace[answerTraceIndex], answerBeforePendingContract.expected_trace[pendingTraceIndex]];
  assert.throws(() => admitScenarioCorpus({ ...corpus, scenarios: corpus.scenarios.map((scenario) => scenario.scenario_id === question.scenario_id ? answerBeforePendingContract : scenario) }),
    (error) => error.evalCode === 'adapter_admission');

  const effectScenario = byId.get('model-permission-covered');
  const effectObserved = observed(effectScenario);
  const effectStep = effectScenario.program.steps.find(({ type }) => type === 'effect');
  const withoutEffectCallback = structuredClone(effectObserved);
  withoutEffectCallback.callbacks = withoutEffectCallback.callbacks.filter(({ step_id: stepId }) => stepId !== effectStep.step_id);
  assert.ok(evaluateScenario(effectScenario, withoutEffectCallback).mismatches.includes('missing-effect-callback'));
  const wrongEffectCallback = structuredClone(effectObserved);
  wrongEffectCallback.callbacks.find(({ step_id: stepId }) => stepId === effectStep.step_id).callback_id = 'other-write';
  assert.ok(evaluateScenario(effectScenario, wrongEffectCallback).mismatches.includes('effect-callback-id-mismatch'));
  const failedEffectCallback = structuredClone(effectObserved);
  failedEffectCallback.callbacks.find(({ step_id: stepId }) => stepId === effectStep.step_id).outcome = 'failed';
  assert.ok(evaluateScenario(effectScenario, failedEffectCallback).mismatches.includes('effect-callback-error'));
  const withoutEffect = structuredClone(effectObserved);
  withoutEffect.effects = [];
  assert.ok(evaluateScenario(effectScenario, withoutEffect).mismatches.includes('missing-effect'));

  const invalidPathCases = ['', '/absolute', '.', '..', 'dir\\file', 'nul\0file', 'x'.repeat(4_097)];
  for (const path of invalidPathCases) {
    const invalid = structuredClone(corpus);
    invalid.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').prior_authority.allowed_actions[0].path = path;
    assert.throws(() => admitScenarioCorpus(invalid), (error) => error.evalCode === 'adapter_admission');
  }
  const invalidPlaceholder = structuredClone(corpus);
  const invalidQuestion = invalidPlaceholder.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question');
  invalidQuestion.initial_input += ' ${RESULT_FILE}';
  assert.throws(() => admitScenarioCorpus(invalidPlaceholder), (error) => error.evalCode === 'adapter_admission');
  const unknownPlaceholder = structuredClone(corpus);
  unknownPlaceholder.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question').initial_input += ' ${UNKNOWN}';
  assert.throws(() => admitScenarioCorpus(unknownPlaceholder), (error) => error.evalCode === 'adapter_admission');
  const duplicate = structuredClone(corpus);
  duplicate.scenarios[1].scenario_id = duplicate.scenarios[0].scenario_id;
  duplicate.scenarios[1].lane = duplicate.scenarios[0].lane;
  assert.throws(() => admitScenarioCorpus(duplicate), (error) => error.evalCode === 'adapter_admission');

  const assertInvalid = (mutate) => {
    const candidate = structuredClone(corpus);
    mutate(candidate, candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question'));
    assert.throws(() => admitScenarioCorpus(candidate), (error) => error.evalCode === 'adapter_admission');
  };
  const invalidCorpusMutations = [
    (candidate) => { candidate.extra = true; },
    (candidate) => { candidate.schema_version = 2; },
    (candidate) => { candidate.scenarios.pop(); },
    (_candidate, scenario) => { scenario.scenario_id = 'Model-Question'; },
    (_candidate, scenario) => { scenario.scenario_id = 'new-scenario'; },
    (_candidate, scenario) => { scenario.lane = 'full-live'; },
    (_candidate, scenario) => { scenario.scenario_kind = 'other'; },
    (_candidate, scenario) => { scenario.owner_requirements = []; },
    (_candidate, scenario) => { scenario.owner_requirements.push(structuredClone(scenario.owner_requirements[0])); },
    (_candidate, scenario) => { scenario.owner_requirements[0].extra = true; },
    (_candidate, scenario) => { scenario.owner_requirements[0].capability = ''; },
    (_candidate, scenario) => { scenario.initial_input = ''; },
    (_candidate, scenario) => { scenario.initial_input = '\ud800'; },
    (_candidate, scenario) => { scenario.prior_authority = { kind: 'other' }; },
    (_candidate, scenario) => { scenario.prior_authority = { kind: 'none', extra: true }; },
    (_candidate, scenario) => { scenario.prior_authority = { kind: 'delegated', allowed_actions: [] }; },
    (_candidate, scenario) => { scenario.prior_authority = { kind: 'delegated', allowed_actions: [{ operation: 'delete', path: 'result.txt' }] }; },
    (_candidate, scenario) => { scenario.program.kind = 'other'; },
    (_candidate, scenario) => { scenario.program.steps = []; },
    (_candidate, scenario) => { scenario.program.steps[0].request_kind = 'other'; },
    (_candidate, scenario) => { scenario.program.steps[0].expected_callback.kind = 'decision'; },
    (_candidate, scenario) => { scenario.program.steps[0].options = []; },
    (_candidate, scenario) => { scenario.program.steps[0].options.push(structuredClone(scenario.program.steps[0].options[0])); },
    (_candidate, scenario) => { scenario.program.steps[0].expected_callback.option_ids = ['missing']; },
    (_candidate, scenario) => { scenario.program.steps[1].type = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').program.steps[0].expected_callback.decision = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps[0].choices.reverse(); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps[0].expected_callback.kind = 'answer'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps[1].operation = 'read'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps[1].expected_callback.outcome = 'failed'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'client-happy').program.steps[0].turn_status = 'failed'; },
    (_candidate, scenario) => { scenario.followups[0].after_pending_step = 'missing'; },
    (_candidate, scenario) => { scenario.followups.push(structuredClone(scenario.followups[0])); },
    (_candidate, scenario) => { scenario.expected_trace[0].kind = 'other'; },
    (_candidate, scenario) => { scenario.expected_trace[2].step_id = 'missing'; },
    (_candidate, scenario) => { scenario.expected_trace[2].kind = 'turn.completed'; },
    (_candidate, scenario) => { scenario.expected_trace[3].option_ids = ['missing']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').expected_trace[3].decision = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').expected_trace[3].decision = 'reject'; },
    (_candidate, scenario) => { scenario.expected_trace.splice(2, 0, { kind: 'turn.completed', step_id: 'terminal-1' }); },
    (_candidate, scenario) => { scenario.forbidden_observations[0] = 'other'; },
    (_candidate, scenario) => { scenario.forbidden_observations[1] = scenario.forbidden_observations[0]; },
    (_candidate, scenario) => { scenario.fixture_predicate = { kind: 'other' }; },
    (_candidate, scenario) => { scenario.expected_actual_task_outcome = 'not_observed'; },
    (candidate) => {
      const scenario = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan');
      scenario.program.steps[0].expected_callback.decision = 'reject';
      scenario.expected_trace[3].decision = 'reject';
    },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'live-marker').expected_enabled_eval_status = 'fail'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'live-marker').owner_requirements[0].requirement = 'other'; },
  ];
  invalidCorpusMutations.forEach(assertInvalid);
  for (const invalidCorpus of [null, [], 'corpus']) {
    assert.throws(() => admitScenarioCorpus(invalidCorpus), (error) => error.evalCode === 'adapter_admission');
  }

  const variantCorpus = structuredClone(corpus);
  variantCorpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'client-happy').fixture_predicate = { kind: 'none' };
  variantCorpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-semantic-failure').fixture_predicate = { kind: 'file-absent', path: 'result.txt' };
  admitScenarioCorpus(variantCorpus);
  assert.throws(() => parseScenarioCorpus('{'), (error) => error.evalCode === 'adapter_admission');
  assert.throws(() => materializeScenario(byId.get('model-semantic-failure'), { workspace: 'relative' }), (error) => error.evalCode === 'adapter_admission');

  const oversized = structuredClone(byId.get('model-permission-expansion'));
  oversized.initial_input = 'i'.repeat(8_000);
  oversized.followups[0].input = 'f'.repeat(8_000);
  oversized.program.steps.find(({ type }) => type === 'effect').text = 'e'.repeat(8_000);
  oversized.program.steps.find(({ type }) => type === 'terminal').result_text = 't'.repeat(8_000);
  oversized.fixture_predicate.text = 'p'.repeat(8_000);
  oversized.prior_authority.allowed_actions = Array.from({ length: 8 }, (_value, index) => ({ operation: 'read', path: `${index}${'x'.repeat(4_095)}` }));
  assert.throws(() => materializeScenario(oversized, { workspace: '/tmp/cursor-eval-workspace' }), (error) => error.evalCode === 'adapter_admission');

  for (const field of ['trace', 'callbacks', 'effects']) {
    assert.throws(() => evaluateScenario(question, { ...questionObserved, [field]: {} }), /must be arrays/);
  }
  const sessionMismatch = structuredClone(questionObserved);
  sessionMismatch.trace[1].session_id = 'other-session';
  assert.ok(evaluateScenario(question, sessionMismatch).mismatches.includes('id-mismatch'));
  const turnMismatch = structuredClone(questionObserved);
  turnMismatch.trace[2].turn_id = 'other-turn';
  assert.ok(evaluateScenario(question, turnMismatch).mismatches.includes('id-mismatch'));
  const wrongTraceEffect = structuredClone(questionObserved);
  wrongTraceEffect.trace.splice(-1, 0, { kind: 'effect.file-written', step_id: 'terminal-1' });
  assert.ok(evaluateScenario(question, wrongTraceEffect).mismatches.includes('unexpected-effect'));
  const forbiddenTrace = structuredClone(questionObserved);
  forbiddenTrace.trace.splice(-1, 0, { kind: 'raw-provider-payload' });
  assert.ok(evaluateScenario(question, forbiddenTrace).mismatches.includes('raw-provider-payload'));

  const missingPendingCallback = structuredClone(questionObserved);
  missingPendingCallback.callbacks = [];
  assert.ok(evaluateScenario(question, missingPendingCallback).mismatches.includes('missing-callback'));
  const wrongPendingCallback = structuredClone(questionObserved);
  wrongPendingCallback.callbacks[0].option_ids = ['other'];
  assert.ok(evaluateScenario(question, wrongPendingCallback).mismatches.includes('callback-mismatch'));
  const wrongPendingCallbackId = structuredClone(questionObserved);
  wrongPendingCallbackId.callbacks[0].callback_id = 'other-question';
  assert.ok(evaluateScenario(question, wrongPendingCallbackId).mismatches.includes('id-mismatch'));
  const omittedOutcomes = structuredClone(questionObserved);
  delete omittedOutcomes.actual_task_outcome;
  delete omittedOutcomes.reported_task_outcome;
  assert.deepEqual(
    evaluateScenario(question, omittedOutcomes),
    {
      assertion_outcome: 'fail',
      actual_task_outcome: 'not_observed',
      reported_task_outcome: 'not_reported',
      eval_status: 'agent_behavior_mismatch',
      mismatches: ['actual-outcome-mismatch', 'reported-outcome-mismatch'],
    },
  );
  const wrongOutcomes = structuredClone(questionObserved);
  wrongOutcomes.actual_task_outcome = 'failed';
  wrongOutcomes.reported_task_outcome = 'failed';
  assert.deepEqual(evaluateScenario(question, wrongOutcomes).mismatches.slice(-2), ['actual-outcome-mismatch', 'reported-outcome-mismatch']);
  t.diagnostic(`scenario counts ${JSON.stringify(counts)}`);
});

function makeHarnessChild({ stdout = '', stderr = '', code = 0, signal = null, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = [];
  child.kill = (requestedSignal) => child.killedWith.push(requestedSignal);
  queueMicrotask(() => {
    if (error) child.emit('error', error);
    else {
      child.stdout.write(stdout);
      child.stderr.write(stderr);
      child.emit('close', code, signal);
    }
  });
  return child;
}

test('eval runner emits exactly one bounded lane-specific skipped EvalResultV1', async () => {
  for (const [scenario, lane] of [['client-happy', 'client-integration'], ['model-question', 'model-behavior'], ['live-marker', 'full-live']]) {
    const { stdout, stderr } = await execute(process.execPath, [run, scenario], { env: { ...process.env, CURSOR_EVAL_REAL_CODEX: '', CURSOR_EVAL_HOSTED_CODEX: '', CURSOR_SUBAGENT_LIVE_E2E: '' } });
    assert.equal(stderr, ''); assert.equal(stdout.trim().split('\n').length, 1);
    const result = assertEvalResultV1(JSON.parse(stdout));
    assert.deepEqual({ scenario: result.scenario_id, lane: result.lane, status: result.eval_status, cleanup: result.cleanup_status }, { scenario, lane, status: 'skipped', cleanup: 'not_required' });
  }
});

test('eval runner returns a bounded machine-readable integration failure for an unknown scenario', async () => {
  const failure = await execute(process.execPath, [run, 'unknown'], { env: process.env }).then(() => assert.fail('unknown scenario must fail the process'), (error) => error);
  const { stdout, stderr } = failure;
  assert.equal(failure.code, 1);
  assert.equal(stderr, '');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code }, { status: 'integration_failure', stage: 'runner', code: 'unknown_scenario' });
});

test('eval runner defaults to the credential-free client scenario when no scenario is supplied', async () => {
  const { stdout, stderr } = await execute(process.execPath, [run], {
    env: { ...process.env, CURSOR_EVAL_REAL_CODEX: '', CURSOR_EVAL_HOSTED_CODEX: '', CURSOR_SUBAGENT_LIVE_E2E: '' },
  });
  assert.equal(stderr, '');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.deepEqual(
    { scenario: result.scenario_id, lane: result.lane, status: result.eval_status },
    { scenario: 'client-happy', lane: 'client-integration', status: 'skipped' },
  );
});

test('eval runner bounds an untrusted unknown scenario name in its public result', async () => {
  const failure = await execute(process.execPath, [run, 'x'.repeat(4_096)], { env: process.env }).then(() => assert.fail('unknown scenario must fail the process'), (error) => error);
  const { stdout, stderr } = failure;
  assert.equal(failure.code, 1);
  assert.equal(stderr, '');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.equal(result.eval_status, 'integration_failure');
  assert.ok(Buffer.byteLength(result.scenario_id, 'utf8') <= 128);
  assert.match(result.scenario_id, /\.\.\.$/);
});

test('runner selects each lane and propagates the scenario environment expected by its harness', async () => {
  const cases = [
    ['client-happy', { CURSOR_EVAL_REAL_CODEX: '1' }, 'client-integration', 'credential-free client-happy', { CURSOR_EVAL_REAL_CODEX: '1' }],
    ['model-plan', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_HOSTED_CODEX: '1' }],
    ['model-permission-covered', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_HOSTED_CODEX: '1' }],
    ['live-marker', { CURSOR_SUBAGENT_LIVE_E2E: '1' }, 'full-live', 'live release canary', { CURSOR_SUBAGENT_LIVE_E2E: '1' }],
  ];
  for (const [scenarioId, env, lane, pattern, expectedEnv] of cases) {
    let observed;
    const result = await runEval({ scenarioId, env }, { ...inertFixture, publishEvidence: published,
      runHarness: async (config, harnessEnv) => { observed = { pattern: config.pattern, env: harnessEnv }; return passHarness(config, harnessEnv); } });
    assert.equal(assertEvalResultV1(result).eval_status, 'pass'); assert.equal(result.lane, lane); assert.equal(observed.pattern, pattern);
    for (const [name, value] of Object.entries(expectedEnv)) assert.equal(observed.env[name], value);
    assert.equal(observed.env.CURSOR_EVAL_WORKSPACE, '/tmp/fixture/workspace');
    assert.deepEqual(JSON.parse(observed.env.CURSOR_EVAL_SCENARIO_PAYLOAD).scenario_id, scenarioId);
    assert.match(observed.env.CURSOR_EVAL_SCENARIO_SHA256, /^[a-f0-9]{64}$/);
    assert.equal(Number.isSafeInteger(Number(observed.env.CURSOR_EVAL_SCENARIO_BYTES)), true);
    assert.equal(observed.env.CURSOR_EVAL_CORPUS_SHA256, corpusDigest.sha256);
    assert.equal(Number(observed.env.CURSOR_EVAL_CORPUS_BYTES), corpusDigest.bytes);
  }
});

test('cleanup failure overrides a behavior mismatch after evidence publication', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 1, signal: null, failure: 'scenario_contract_mismatch',
      childResult: childResult(config.scenario.scenario_id, { actual: 'succeeded', reported: 'failed', status: 'agent_behavior_mismatch',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
    rm: async () => { throw new Error('fixture remains'); },
  });
  assert.deepEqual(assertEvalResultV1(result), {
    schema_version: 1, scenario_id: 'model-question', lane: 'model-behavior', eval_status: 'integration_failure',
    actual_task_outcome: 'succeeded', reported_task_outcome: 'failed', fixture_assertion_outcome: 'fail',
    evidence_publication_status: 'published', evidence_ref: '/tmp/evidence.json', cleanup_status: 'failed', failure_stage: 'cleanup',
    error_code: 'cleanup_failed', message: 'fixture remains',
  });
});

test('publication failure has integration precedence and still performs cleanup', async () => {
  let cleanupCalled = false;
  const result = await runEval({ scenarioId: 'model-plan', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: passHarness,
    publishEvidence: async () => { throw new Error('disk full'); },
    rm: async () => { cleanupCalled = true; },
  });
  assert.equal(cleanupCalled, true); assert.deepEqual({ status: result.eval_status, publication: result.evidence_publication_status, ref: result.evidence_ref, cleanup: result.cleanup_status, stage: result.failure_stage, code: result.error_code },
    { status: 'integration_failure', publication: 'failed', ref: null, cleanup: 'succeeded', stage: 'publication', code: 'evidence_publication_failed' });
  assertEvalResultV1(result);
});

test('runner and fixture setup catches always return valid stage-specific EvalResultV1 objects', async () => {
  let spawned = false;
  const corpus = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    readFile: async () => { throw Object.assign(new Error('malformed corpus'), { evalCode: 'adapter_admission' }); },
    runHarness: async () => { spawned = true; throw new Error('must not spawn'); },
  });
  assert.deepEqual(
    { status: corpus.eval_status, stage: corpus.failure_stage, code: corpus.error_code, cleanup: corpus.cleanup_status },
    { status: 'integration_failure', stage: 'adapter_admission', code: 'adapter_admission', cleanup: 'not_required' },
  );
  assert.equal(spawned, false);
  assertEvalResultV1(corpus);
  const setup = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, { mkdtemp: async () => { throw new Error('no temp'); } });
  assert.deepEqual({ status: setup.eval_status, stage: setup.failure_stage, code: setup.error_code, cleanup: setup.cleanup_status }, { status: 'integration_failure', stage: 'runner', code: 'fixture_setup_failed', cleanup: 'not_required' });
  assertEvalResultV1(setup);
  const harness = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: async () => { throw Object.assign(new Error('spawn failed'), { evalCode: 'harness_spawn_failure' }); },
  });
  assert.deepEqual({ status: harness.eval_status, stage: harness.failure_stage, code: harness.error_code, assertion: harness.fixture_assertion_outcome, cleanup: harness.cleanup_status },
    { status: 'integration_failure', stage: 'runner', code: 'harness_spawn_failure', assertion: 'not_observed', cleanup: 'succeeded' });
  assertEvalResultV1(harness);
  const generic = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: async () => { throw new Error('runner failed'); },
  });
  assert.deepEqual(
    { status: generic.eval_status, stage: generic.failure_stage, code: generic.error_code, cleanup: generic.cleanup_status },
    { status: 'integration_failure', stage: 'runner', code: 'runner_failure', cleanup: 'succeeded' },
  );
  assertEvalResultV1(generic);
});

test('runner admits string corpus input and rejects empty or oversized corpus bytes before fixture setup', async () => {
  const admitted = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    ...inertFixture,
    readFile: async () => rawCorpus.toString('utf8'),
    runHarness: passHarness,
    publishEvidence: published,
  });
  assert.equal(assertEvalResultV1(admitted).eval_status, 'pass');

  for (const contents of ['', 'x'.repeat(1_048_577)]) {
    let fixtureCreated = false;
    const rejected = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
      readFile: async () => contents,
      mkdtemp: async () => { fixtureCreated = true; return '/tmp/unexpected-fixture'; },
    });
    assert.deepEqual(
      { status: rejected.eval_status, stage: rejected.failure_stage, code: rejected.error_code },
      { status: 'integration_failure', stage: 'adapter_admission', code: 'adapter_admission' },
    );
    assert.equal(fixtureCreated, false);
    assertEvalResultV1(rejected);
  }
});

test('runner preserves adapter-admission classification from an enabled harness boundary', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    runHarness: async () => { throw Object.assign(new Error('unsupported adapter payload'), { evalCode: 'adapter_admission' }); },
  });
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, cleanup: result.cleanup_status },
    { status: 'integration_failure', stage: 'adapter_admission', code: 'adapter_admission', cleanup: 'succeeded' },
  );
  assertEvalResultV1(result);
});

test('runner owns the disposable fixture lifecycle by default', async () => {
  let fixtureRoot;
  const result = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    runHarness: async (_config, harnessEnv) => {
      fixtureRoot = harnessEnv.CURSOR_EVAL_CHILD_RESULT.slice(0, -'/child-result.json'.length);
      return passHarness(_config, harnessEnv);
    },
    publishEvidence: published,
  });
  assert.equal(result.eval_status, 'pass');
  await assert.rejects(readFile(fixtureRoot), /ENOENT/);
});

test('runner normalizes a harness infrastructure failure without child evidence', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async () => ({ code: 9, signal: null, failure: 'harness_failure', childResult: null, semantic: null, diagnostics: 'failed' }),
  });
  assert.deepEqual(
    {
      status: result.eval_status,
      actual: result.actual_task_outcome,
      reported: result.reported_task_outcome,
      assertion: result.fixture_assertion_outcome,
      stage: result.failure_stage,
      code: result.error_code,
    },
    {
      status: 'integration_failure',
      actual: 'not_observed',
      reported: 'not_reported',
      assertion: 'not_observed',
      stage: 'runner',
      code: 'harness_failure',
    },
  );
  assertEvalResultV1(result);
});

test('runner does not publish durable evidence before complete programmed or package proof', async () => {
  const packageFailure = childResult('live-marker');
  packageFailure.manifest = null;
  packageFailure.observations = { ...packageFailure.observations, assertion_outcome: 'not_observed', eval_status: 'integration_failure' };
  for (const [scenarioId, env, harness] of [
    ['model-question', { CURSOR_EVAL_HOSTED_CODEX: '1' }, { code: 9, signal: null, failure: 'harness_failure', childResult: null, diagnostics: 'failed' }],
    ['live-marker', { CURSOR_SUBAGENT_LIVE_E2E: '1' }, { code: 1, signal: null, failure: 'child_integration_failure', childResult: packageFailure, diagnostics: 'failed' }],
  ]) {
    let published = false;
    const result = await runEval({ scenarioId, env }, {
      ...inertFixture,
      runHarness: async () => harness,
      publishEvidence: async () => { published = true; },
    });
    assert.deepEqual(
      { status: result.eval_status, publication: result.evidence_publication_status, ref: result.evidence_ref },
      { status: 'integration_failure', publication: 'not_attempted', ref: null },
    );
    assert.equal(published, false);
    assertEvalResultV1(result);
  }
});

test('runner treats missing child evidence as an integration failure before behavior classification', async () => {
  const result = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async () => ({
      code: 1,
      signal: null,
      failure: 'scenario_contract_mismatch',
      childResult: null,
      diagnostics: '',
    }),
  });
  assert.deepEqual(
    {
      status: result.eval_status,
      actual: result.actual_task_outcome,
      reported: result.reported_task_outcome,
      assertion: result.fixture_assertion_outcome,
      stage: result.failure_stage,
    },
    {
      status: 'integration_failure',
      actual: 'not_observed',
      reported: 'not_reported',
      assertion: 'not_observed',
      stage: 'runner',
    },
  );
  assertEvalResultV1(result);
});

test('published evidence is emitted after cleanup with exact child provenance and the final EvalResultV1', async () => {
  const order = []; let evidence;
  const result = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    ...inertFixture, runHarness: passHarness,
    rm: async () => { order.push('cleanup'); },
    publishEvidence: async ({ makeEvidence }) => { order.push('publication'); evidence = makeEvidence('/tmp/final-evidence.json'); return '/tmp/final-evidence.json'; },
  });
  assert.deepEqual(order, ['cleanup', 'publication']); assert.equal(result.eval_status, 'pass');
  assert.deepEqual(evidence.skill, { sha256: 'a'.repeat(64), bytes: 123 });
  assert.deepEqual(evidence.transcript, transcript); assert.deepEqual(evidence.provider_oracle, childResult('client-happy').provider_oracle);
  assert.equal(evidence.fixture_oracle.eval_status, 'pass'); assert.deepEqual(evidence.final_result, result);
  assert.deepEqual(Object.keys(evidence.manifest).sort(), ['adapter', 'client', 'corpus', 'hash_algorithm', 'hash_encoding', 'installed_payload', 'installed_skill', 'materialized_scenario', 'model', 'schema_version']);
  assert.deepEqual(evidence.manifest.installed_skill, { sha256: 'a'.repeat(64), bytes: 123 });
  assert.equal(Buffer.byteLength(JSON.stringify(evidence), 'utf8') < 1_048_576, true);
});

test('semantic failure outcomes are classified independently of successful TAP exit', async () => {
  const result = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 0, signal: null, failure: null,
      childResult: childResult(config.scenario.scenario_id, { actual: 'failed', reported: 'failed',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
  });
  assert.deepEqual({ status: result.eval_status, actual: result.actual_task_outcome, reported: result.reported_task_outcome, assertion: result.fixture_assertion_outcome },
    { status: 'pass', actual: 'failed', reported: 'failed', assertion: 'pass' });

  const dishonest = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 0, signal: null, failure: null,
      childResult: childResult(config.scenario.scenario_id, { actual: 'failed', reported: 'succeeded', status: 'agent_behavior_mismatch',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
  });
  assert.deepEqual({ status: dishonest.eval_status, actual: dishonest.actual_task_outcome, reported: dishonest.reported_task_outcome },
    { status: 'agent_behavior_mismatch', actual: 'failed', reported: 'succeeded' });
});

test('cleanup failure remains the primary stage when failure-artifact publication also fails', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: passHarness,
    rm: async () => { throw new Error('cleanup broke'); }, publishEvidence: async () => { throw new Error('publication broke'); },
  });
  assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code, publication: result.evidence_publication_status, cleanup: result.cleanup_status },
    { status: 'integration_failure', stage: 'cleanup', code: 'cleanup_failed', publication: 'failed', cleanup: 'failed' });
  assertEvalResultV1(result);
});

test('child cleanup failure takes precedence over otherwise successful scenario evidence', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({
      code: 0,
      signal: null,
      failure: null,
      childResult: childResult(config.scenario.scenario_id, {
        cleanup: 'failed',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) },
        corpusDigest,
      }),
      diagnostics: '',
    }),
  });
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, message: result.message },
    { status: 'integration_failure', stage: 'cleanup', code: 'cleanup_failed', message: 'child cleanup failed' },
  );
  assertEvalResultV1(result);
});

test('package integration failure without a harness code uses the stable child failure fallback', async () => {
  const result = await runEval({ scenarioId: 'live-marker', env: { CURSOR_SUBAGENT_LIVE_E2E: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({
      code: 0,
      signal: null,
      failure: null,
      childResult: childResult(config.scenario.scenario_id, {
        status: 'integration_failure',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) },
        corpusDigest,
      }),
      diagnostics: '',
    }),
  });
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, message: result.message },
    { status: 'integration_failure', stage: 'runner', code: 'child_integration_failure', message: 'eval harness failed' },
  );
  assertEvalResultV1(result);
});

test('published evidence safely normalizes optional child sections from a partial harness result', async () => {
  let evidence;
  const partialChild = { manifest: { schema_version: 1 }, provenance: { cleanup_status: 'succeeded' } };
  const result = await runEval({ scenarioId: 'live-marker', env: { CURSOR_SUBAGENT_LIVE_E2E: '1' } }, {
    ...inertFixture,
    runHarness: async () => ({ code: 0, signal: null, failure: null, childResult: partialChild, diagnostics: '' }),
    publishEvidence: async ({ makeEvidence }) => {
      evidence = makeEvidence('/tmp/partial-evidence.json');
      return '/tmp/partial-evidence.json';
    },
  });
  assert.equal(result.eval_status, 'agent_behavior_mismatch');
  assert.deepEqual(
    {
      skill: evidence.skill,
      transcript: evidence.transcript,
      provider: evidence.provider_oracle,
      fixture: evidence.fixture_oracle,
      manifest: evidence.manifest,
    },
    {
      skill: null,
      transcript: { calls: [], dropped_calls: 0 },
      provider: null,
      fixture: null,
      manifest: partialChild.manifest,
    },
  );
  assertEvalResultV1(result);
});

test('child-result parser normalizes exact provenance and builds the closed private manifest', () => {
  const parsed = parseChildResult(encodedChildResult('model-question'), 'model-question', { scenario: scenarioById.get('model-question') });
  assert.deepEqual(parsed.manifest, {
    schema_version: 1, hash_algorithm: 'sha256', hash_encoding: 'lowercase-hex',
    installed_skill: fixedDigest('a'), corpus: corpusDigest,
    materialized_scenario: materializeScenario(scenarioById.get('model-question'), { workspace: '/tmp/fixture/workspace' }).digest,
    adapter: fixedDigest('b', 456),
    installed_payload: { marker_format: 1, payload_hash: 'c'.repeat(64), artifact_hash: 'd'.repeat(64), manifest_version: '0.1.0+codex.fixture' },
    client: { name: 'codex-app-server', version: '0.152.1' }, model: { provider: null, name: null },
  });
});

test('child-result parser preserves the explicit compatibility defaults for partial observations and package references', () => {
  const programmed = JSON.parse(encodedChildResult('model-question'));
  delete programmed.observations.assertion_outcome;
  delete programmed.observations.eval_status;
  programmed.eval_status = 'pass';
  const normalized = parseChildResult(JSON.stringify(programmed), 'model-question', { scenario: scenarioById.get('model-question') });
  assert.equal(normalized.observations.assertion_outcome, 'pass');
  assert.equal(normalized.observations.eval_status, 'pass');

  for (const [status, assertion] of [['agent_behavior_mismatch', 'fail'], ['integration_failure', 'not_observed']]) {
    const partial = JSON.parse(encodedChildResult('model-question'));
    delete partial.observations.assertion_outcome;
    delete partial.observations.eval_status;
    partial.eval_status = status;
    const parsed = parseChildResult(JSON.stringify(partial), 'model-question', { scenario: scenarioById.get('model-question') });
    assert.equal(parsed.observations.assertion_outcome, assertion);
    assert.equal(parsed.observations.eval_status, status);
  }

  const reference = JSON.parse(encodedChildResult('model-question'));
  reference.scenario_id = 'package-canary-reference';
  reference.provenance.cache_loaded_skill = null;
  reference.provider_oracle = null;
  const parsedReference = parseChildResult(JSON.stringify(reference), 'package-canary-reference', { scenario: { scenario_kind: 'package-canary-reference' } });
  assert.equal(parsedReference.provider_oracle, null);

  reference.provider_oracle = { release_canary: 'observed' };
  assert.deepEqual(
    parseChildResult(JSON.stringify(reference), 'package-canary-reference', { scenario: { scenario_kind: 'package-canary-reference' } }).provider_oracle,
    { release_canary: 'observed' },
  );
  reference.provider_oracle = [];
  assert.throws(
    () => parseChildResult(JSON.stringify(reference), 'package-canary-reference', { scenario: { scenario_kind: 'package-canary-reference' } }),
    (error) => error.evalCode === 'child_result_invalid',
  );
});

test('child-result parser rejects malformed JSON and oversized evidence', () => {
  for (const encoded of ['{', 'x'.repeat(1_048_577)]) {
    assert.throws(() => parseChildResult(encoded, 'model-question'), (error) => error.evalCode === 'child_result_invalid');
  }
});

test('child-result parser rejects every required evidence-contract violation', () => {
  const valid = JSON.parse(encodedChildResult('model-question'));
  const invalidResults = [
    { ...valid, schema_version: 2 },
    { ...valid, scenario_id: 'model-plan' },
    { ...valid, provenance: null },
    { ...valid, provenance: { ...valid.provenance, extra: true } },
    { ...valid, provenance: { ...valid.provenance, consumed_scenario: { ...valid.provenance.consumed_scenario, sha256: 'not-a-sha' } } },
    { ...valid, provenance: { ...valid.provenance, adapter: { ...valid.provenance.adapter, bytes: 0 } } },
    { ...valid, provenance: { ...valid.provenance, managed_installed_skill: null } },
    { ...valid, provenance: { ...valid.provenance, cache_loaded_skill: fixedDigest('e') } },
    { ...valid, provenance: { ...valid.provenance, installed_payload: { ...valid.provenance.installed_payload, extra: true } } },
    { ...valid, provenance: { ...valid.provenance, installed_payload: { ...valid.provenance.installed_payload, payload_hash: 'bad' } } },
    { ...valid, provenance: { ...valid.provenance, client: { name: '', version: '1' } } },
    { ...valid, provenance: { ...valid.provenance, model: { provider: null, name: null, raw: 'forbidden' } } },
    { ...valid, provenance: { ...valid.provenance, cleanup_status: 'unknown' } },
    { ...valid, observations: null },
    { ...valid, observations: { ...valid.observations, trace: null } },
    { ...valid, observations: { ...valid.observations, actual_task_outcome: 'unknown' } },
    { ...valid, observations: { ...valid.observations, reported_task_outcome: 'unknown' } },
    { ...valid, observations: { ...valid.observations, assertion_outcome: 'unknown' } },
    { ...valid, observations: { ...valid.observations, eval_status: 'skipped' } },
    { ...valid, transcript: undefined },
    { ...valid, transcript: [] },
    { ...valid, transcript: { calls: valid.transcript.calls, dropped_calls: -1 } },
    { ...valid, transcript: { ...valid.transcript, extra: true } },
    { ...valid, provider_oracle: null },
    { ...valid, provider_oracle: [] },
  ];
  for (const value of invalidResults) {
    assert.throws(() => parseChildResult(JSON.stringify(value), 'model-question', { scenario: scenarioById.get('model-question') }), (error) => error.evalCode === 'child_result_invalid');
  }
});

test('child-result parser rejects corpus and materialized payload digest mismatches before behavior verdict', () => {
  const scenario = scenarioById.get('client-happy');
  const expectedScenario = materializeScenario(scenario, { workspace: '/tmp/fixture/workspace' }).digest;
  for (const expected of [{ scenarioDigest: fixedDigest('f') }, { corpusDigest: fixedDigest('f') }]) {
    assert.throws(() => parseChildResult(encodedChildResult('client-happy'), 'client-happy', {
      scenario, scenarioDigest: expected.scenarioDigest || expectedScenario, corpusDigest: expected.corpusDigest || corpusDigest,
    }), (error) => error.evalCode === 'child_result_invalid');
  }
});

test('published evidence retains the normalized bounded provider route trace', async () => {
  let evidence;
  const result = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    ...inertFixture, runHarness: passHarness,
    publishEvidence: async ({ makeEvidence }) => { evidence = makeEvidence('/tmp/provider-route.json'); return '/tmp/provider-route.json'; },
  });
  assert.equal(result.eval_status, 'pass');
  assert.deepEqual(evidence.provider_oracle.tool_sequence, toolSequence);
  assert.deepEqual(evidence.provider_oracle.request_trace, requestTrace);
});

test('harness returns validated child evidence and bounded diagnostics after a successful child exit', async () => {
  const child = makeHarnessChild({ stderr: `${'d'.repeat(9_000)}ignored` });
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    spawn: () => child,
    readFile: async () => encodedChildResult('client-happy'),
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult, childResult('client-happy'));
  assert.equal(Buffer.byteLength(result.diagnostics, 'utf8') <= 8_000, true);
});

test('harness validates configured scenario and corpus digests at the process boundary', async () => {
  const scenario = scenarioById.get('client-happy');
  const scenarioDigest = materializeScenario(scenario, { workspace: '/tmp/fixture/workspace' }).digest;
  const result = await runHarness(
    { pattern: 'scenario', test: '/tmp/test.mjs', scenario },
    {
      CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json',
      CURSOR_EVAL_SCENARIO_ID: 'client-happy',
      CURSOR_EVAL_SCENARIO_SHA256: scenarioDigest.sha256,
      CURSOR_EVAL_SCENARIO_BYTES: String(scenarioDigest.bytes),
      CURSOR_EVAL_CORPUS_SHA256: corpusDigest.sha256,
      CURSOR_EVAL_CORPUS_BYTES: String(corpusDigest.bytes),
    },
    {
      spawn: () => makeHarnessChild(),
      readFile: async () => encodedChildResult('client-happy'),
    },
  );
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult.manifest.materialized_scenario, scenarioDigest);
  assert.deepEqual(result.childResult.manifest.corpus, corpusDigest);
});

test('harness executes its configured Node test through the default process boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-harness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childResultPath = join(root, 'child-result.json');
  const childTestPath = join(root, 'scenario.test.mjs');
  await writeFile(childResultPath, encodedChildResult('client-happy'));
  await writeFile(childTestPath, "import test from 'node:test';\ntest('scenario', () => {});\n");
  const result = await runHarness(
    { pattern: 'scenario', test: childTestPath },
    { ...process.env, CURSOR_EVAL_CHILD_RESULT: childResultPath, CURSOR_EVAL_SCENARIO_ID: 'client-happy' },
  );
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult, childResult('client-happy'));
});

test('harness maps child scenario evidence to a scenario-contract mismatch', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-semantic-failure' }, {
    spawn: () => makeHarnessChild({ code: 1 }),
    readFile: async () => encodedChildResult('model-semantic-failure', { actual: 'failed', reported: 'succeeded', status: 'agent_behavior_mismatch' }),
  });
  assert.equal(result.failure, 'scenario_contract_mismatch');
  assert.deepEqual({ actual: result.childResult.observations.actual_task_outcome, reported: result.childResult.observations.reported_task_outcome }, { actual: 'failed', reported: 'succeeded' });
});

test('harness distinguishes generic child failure from a scenario-contract mismatch', async () => {
  const generic = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    spawn: () => makeHarnessChild({ code: 1 }), readFile: async () => encodedChildResult('client-happy'),
  });
  const mismatch = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    spawn: () => makeHarnessChild({ code: 1 }), readFile: async () => encodedChildResult('client-happy', { actual: 'failed', status: 'agent_behavior_mismatch' }),
  });
  assert.deepEqual([generic.failure, mismatch.failure], ['harness_failure', 'scenario_contract_mismatch']);
});

test('harness reports missing or invalid child-result evidence before exit status', async () => {
  for (const [readFailure, expected] of [[new Error('missing'), 'child_result_missing'], [null, 'child_result_invalid']]) {
    const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
      spawn: () => makeHarnessChild(),
      readFile: async () => { if (readFailure) throw readFailure; return '{}'; },
    });
    assert.equal(result.failure, expected);
  }
});

test('harness classifies spawn errors with a stable eval code', async () => {
  await assert.rejects(runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {}, {
    spawn: () => makeHarnessChild({ error: new Error('spawn broke') }),
  }), (error) => error.evalCode === 'harness_spawn_failure');
});

test('harness kills and classifies a child that exceeds its deadline', async () => {
  const child = makeHarnessChild();
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {}, {
    spawn: () => child,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
    clearTimeout: () => {},
  });
  assert.deepEqual({ failure: result.failure, signal: result.signal, killedWith: child.killedWith }, { failure: 'harness_timeout', signal: 'SIGKILL', killedWith: ['SIGKILL'] });
});

test('evidence publisher writes one final document outside the fixture root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = join(root, 'fixture');
  const evidenceRoot = join(root, 'evidence');
  const finalPath = await publishFinalEvidence({ evidenceRoot, fixtureRoot, makeEvidence: (ref) => ({ schema_version: 1, evidence_ref: ref }) });
  assert.deepEqual(JSON.parse(await readFile(finalPath, 'utf8')), { schema_version: 1, evidence_ref: finalPath });
});

test('evidence publisher rejects a destination inside the disposable fixture', async () => {
  await assert.rejects(publishFinalEvidence({ evidenceRoot: '/tmp/fixture/evidence', fixtureRoot: '/tmp/fixture', makeEvidence: () => ({}) }), /outside fixture root/);
});

test('evidence publisher rejects a document beyond the public evidence limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-publisher-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(publishFinalEvidence({ evidenceRoot: join(root, 'evidence'), fixtureRoot: join(root, 'fixture'), makeEvidence: () => ({ payload: 'x'.repeat(1_048_576) }) }), /output limit/);
});

test('CLI emits a single runner-termination result when SIGTERM wins the race', async () => {
  const processLike = new EventEmitter();
  let resolveEvaluation;
  const evaluation = new Promise((resolve) => { resolveEvaluation = resolve; });
  const written = [];
  const running = cli({ argv: ['node', 'runner', 'model-question'], processLike, evaluate: async () => evaluation, write: (value) => written.push(value) });
  processLike.emit('SIGTERM');
  resolveEvaluation(await runEval({ scenarioId: 'model-question', env: {} }));
  await running;
  assert.equal(processLike.exitCode, 143);
  assert.deepEqual({ count: written.length, code: written[0].error_code, cleanup: written[0].cleanup_status }, { count: 1, code: 'runner_terminated', cleanup: 'failed' });
  assertEvalResultV1(written[0]);

  let resolveUnknown;
  const unknownEvaluation = new Promise((resolve) => { resolveUnknown = resolve; });
  const unknownProcess = new EventEmitter();
  const unknownWritten = [];
  const unknownRunning = cli({ argv: ['node', 'runner', 'unknown'], processLike: unknownProcess, evaluate: async () => unknownEvaluation, write: (value) => unknownWritten.push(value) });
  unknownProcess.emit('SIGTERM');
  resolveUnknown(await runEval({ scenarioId: 'unknown', env: {} }));
  await unknownRunning;
  assert.deepEqual({ count: unknownWritten.length, lane: unknownWritten[0].lane, code: unknownWritten[0].error_code }, { count: 1, lane: 'model-behavior', code: 'runner_terminated' });
  assertEvalResultV1(unknownWritten[0]);
});

test('CLI converts an unhandled evaluation rejection to EvalResultV1', async () => {
  const processLike = new EventEmitter();
  const written = [];
  await cli({ argv: ['node', 'runner', 'live-marker'], processLike, evaluate: async () => { throw new Error('unexpected'); }, write: (value) => written.push(value) });
  assert.deepEqual({ count: written.length, lane: written[0].lane, code: written[0].error_code }, { count: 1, lane: 'full-live', code: 'unhandled_runner_failure' });
  assert.equal(processLike.exitCode, 1);
  assertEvalResultV1(written[0]);

  const fallback = [];
  await cli({ argv: ['node', 'runner', 'unknown'], processLike: new EventEmitter(), evaluate: async () => { throw new Error('unexpected'); }, write: (value) => fallback.push(value) });
  assert.deepEqual({ count: fallback.length, lane: fallback[0].lane, code: fallback[0].error_code }, { count: 1, lane: 'model-behavior', code: 'unhandled_runner_failure' });
  assertEvalResultV1(fallback[0]);
});

test('CLI exit code reflects every enabled eval classifier while preserving one result', async () => {
  for (const [status, exitCode] of [['pass', undefined], ['skipped', undefined], ['agent_behavior_mismatch', 1], ['integration_failure', 1]]) {
    const processLike = new EventEmitter();
    const written = [];
    const result = childResult('client-happy').observations;
    await cli({ argv: ['node', 'runner', 'client-happy'], processLike,
      evaluate: async () => ({ ...result, eval_status: status }), write: (value) => written.push(value) });
    assert.equal(written.length, 1, status);
    assert.equal(processLike.exitCode, exitCode, status);
  }
});
