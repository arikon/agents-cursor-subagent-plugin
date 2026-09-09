import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const evaluatorDigest = fixedDigest('e', 789);
const observedTraceFor = (scenario, sessionId = 'S') => {
  let turnIndex = 0;
  let currentSessionId = sessionId;
  const planned = new Map(scenario.program.steps.map((step) => [step.step_id, step]));
  const initialAuthority = new Set((scenario.prior_authority?.allowed_actions || []).map(({ operation, path }) => `${operation}\0${path}`));
  const authorityTurn = (entry) => {
    const step = planned.get(entry.step_id);
    if (entry.kind === 'answer.permission') {
      const followup = scenario.followups.findIndex(({ after_step: afterStep }) => afterStep === entry.step_id);
      return followup < 0 ? 1 : followup + 2;
    }
    if (!entry.kind?.startsWith('effect.file-') || !step) return null;
    if (initialAuthority.has(`${step.operation}\0${step.path}`)) return 1;
    const followup = scenario.followups.findIndex(({ granted_actions: actions = [] }) =>
      actions.some(({ operation, path }) => operation === step.operation && path === step.path));
    return followup < 0 ? 1 : followup + 2;
  };
  return scenario.expected_trace.map((entry) => {
    if (['session.resumed', 'session.resume-failed'].includes(entry.kind)) currentSessionId = `${sessionId}-resumed`;
    if (entry.kind === 'turn.started') turnIndex += 1;
    const codexTurnIndex = authorityTurn(entry);
    return { ...entry, ...(entry.kind === 'session.start-rejected' ? {} : { session_id: currentSessionId }), ...(!entry.kind.startsWith('session.') ? { turn_id: `T${turnIndex || 1}` } : {}),
      ...(codexTurnIndex === null ? {} : { codex_turn_index: codexTurnIndex }),
      ...(entry.kind.startsWith('pending.') || entry.kind.startsWith('answer.') ? { request_id: scenario.program.steps.find(({ step_id: stepId }) => stepId === entry.step_id)?.callback_id } : {}) };
  });
};
const observedCallbacksFor = (scenario) => scenario.program.steps.flatMap((step) => {
  if (step.type === 'pending' || step.type === 'effect') return [{ step_id: step.step_id, callback_id: step.callback_id, ...step.expected_callback }];
  return [];
});
const transcriptFor = (scenario) => !scenario.harness_faults?.includes('lose-terminal-wait-response-once') ? transcript : {
  calls: [
    { tool: 'cursor_delegate', response: { ok: true, session_id: 'S', turn_id: 'T' } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T', timeout_ms: 60_000 }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' }, withheld_terminal_response: true, caller_error_code: 'transport_error' },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T', timeout_ms: 60_000 }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
  ], dropped_calls: 0, unexpected_input_requests: 0, turn_call_ranges: [{ start: 0, end: 1 }, { start: 1, end: 3 }],
};
const reportChecksFor = (scenario) => scenario.report_checks || [];
const capturedFinalsFor = (scenario) => {
  if (scenario.scenario_kind !== 'programmed') return [];
  const checks = reportChecksFor(scenario);
  return Array.from({ length: scenario.followups.length + 1 }, (_value, index) => {
    const turnIndex = index + 1;
    const turnChecks = checks.filter(({ turn_index: checkTurn }) => checkTurn === turnIndex);
    const selected = turnChecks.flatMap(({ required_fragments: assertions }) => assertions.map((assertion) => Array.isArray(assertion) ? assertion[0] : assertion));
    return { turn_index: turnIndex, turn_id: `codex-turn-${turnIndex}`, turn_status: 'completed', text: selected.join('\n') || 'completed',
      phase: 'final', source: 'thread/read', completeness: 'complete', error_code: null };
  });
};
const observationsFor = (scenario, { actual = scenario.expected_actual_task_outcome || 'succeeded', status = 'pass' } = {}) => ({
  trace: scenario.scenario_kind === 'programmed' ? observedTraceFor(scenario) : [],
  callbacks: scenario.scenario_kind === 'programmed' ? observedCallbacksFor(scenario) : [],
  effects: scenario.scenario_kind === 'programmed' ? scenario.program.steps.filter(({ type }) => type === 'effect').map((step) => ({ kind: `effect.file-${step.operation === 'read' ? 'read' : 'written'}`, step_id: step.step_id, callback_id: step.callback_id, path: step.path, text: step.text })) : [],
  actual_task_outcome: actual, reported_task_outcome: 'not_checked',
  assertion_outcome: status === 'pass' ? 'pass' : status === 'integration_failure' ? 'not_observed' : 'fail', eval_status: status,
});
const childResult = (scenarioId = 'model-question', options = {}) => {
  const scenario = scenarioById.get(scenarioId);
  const scenarioDigest = options.scenarioDigest || materializeScenario(scenario, { workspace: '/tmp/fixture/workspace' }).digest;
  const skillDigest = options.skillDigest || fixedDigest('a');
  const provenance = {
    consumed_scenario: scenarioDigest, consumed_corpus: options.corpusDigest || corpusDigest, adapter: fixedDigest('b', 456),
    evaluator: options.evaluatorDigest || evaluatorDigest,
    managed_installed_skill: skillDigest, cache_loaded_skill: scenario.scenario_kind === 'programmed' ? skillDigest : null,
    installed_payload: { marker_format: 1, payload_hash: 'c'.repeat(64), artifact_hash: 'd'.repeat(64), manifest_version: '0.1.0+codex.fixture' },
    client: { name: 'codex-app-server', version: '0.152.1' }, model: { provider: null, name: null }, cleanup_status: options.cleanup || 'succeeded',
  };
  const capturedFinals = capturedFinalsFor(scenario);
  return {
    provenance,
    captured_finals: capturedFinals,
    manifest: { schema_version: 1, hash_algorithm: 'sha256', hash_encoding: 'lowercase-hex', installed_skill: skillDigest,
      corpus: provenance.consumed_corpus, materialized_scenario: provenance.consumed_scenario, adapter: provenance.adapter, evaluator: provenance.evaluator,
      installed_payload: provenance.installed_payload, client: provenance.client, model: provenance.model },
    observations: { ...observationsFor(scenario, options), captured_finals: capturedFinals }, transcript: transcriptFor(scenario),
    provider_oracle: { request_count: 8, skill_context_seen: true, terminal_result_matched: true, tool_sequence: toolSequence, request_trace: requestTrace },
  };
};
const passHarness = async (config, env) => ({ code: 0, signal: null, failure: null,
  childResult: childResult(config.scenario.scenario_id, {
    scenarioDigest: { sha256: env.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(env.CURSOR_EVAL_SCENARIO_BYTES) },
    corpusDigest: { sha256: env.CURSOR_EVAL_CORPUS_SHA256, bytes: Number(env.CURSOR_EVAL_CORPUS_BYTES) },
    evaluatorDigest: { sha256: env.CURSOR_EVAL_EVALUATOR_SHA256, bytes: Number(env.CURSOR_EVAL_EVALUATOR_BYTES) },
  }), diagnostics: '' });
const published = async ({ makeEvidence }) => { makeEvidence('/tmp/evidence.json'); return '/tmp/evidence.json'; };
const removed = async () => {};
const inertFixture = { mkdtemp: async () => '/tmp/fixture', mkdir: async () => {}, rm: removed,
  readEvaluatorInventory: async () => ({ files: [], digest: evaluatorDigest }) };
const encodedChildResult = (scenarioId, options = {}, overrides = {}) => {
  const child = childResult(scenarioId, options);
  const { captured_finals: _capturedFinals, ...wireObservations } = child.observations;
  return JSON.stringify({ schema_version: 1, scenario_id: scenarioId, ...child, observations: wireObservations, ...overrides });
};

test('corpus-owned scenario inventory, materialization and pure oracle stay in one process', { timeout: 2_000 }, async (t) => {
  const corpus = parseScenarioCorpus(rawCorpus);
  assert.equal(admitScenarioCorpus(JSON.parse(rawCorpus)).scenarios.length, corpus.scenarios.length,
    'the production JSON corpus itself must pass admission');
  const counts = { admission: corpus.scenarios.length, materialization: 0, oracle: 0, packageReference: 0 };
  const byId = new Map(corpus.scenarios.map((scenario) => [scenario.scenario_id, scenario]));
  const observed = (scenario) => ({
    trace: observedTraceFor(scenario, 'session-1'),
    callbacks: observedCallbacksFor(scenario),
    effects: scenario.program.steps.filter(({ type }) => type === 'effect').map((step) => ({
      kind: `effect.file-${step.operation === 'read' ? 'read' : 'written'}`, step_id: step.step_id, callback_id: step.callback_id, path: step.path, text: step.text,
    })),
    captured_finals: capturedFinalsFor(scenario),
    actual_task_outcome: scenario.expected_actual_task_outcome,
    transcript: transcriptFor(scenario),
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
    const oracle = evaluateScenario(materialized.materializedScenario, observed(materialized.materializedScenario));
    assert.deepEqual({ assertion: oracle.assertion_outcome, actual: oracle.actual_task_outcome,
      reported: oracle.reported_task_outcome, status: oracle.eval_status, mismatches: oracle.mismatches }, {
      assertion: 'pass', actual: scenario.expected_actual_task_outcome,
      reported: 'not_checked', status: 'pass', mismatches: [],
    });
    assert.equal(oracle.components.evidence_admission, 'pass');
    assert.equal(oracle.report_checks.every(({ category }) => category === 'interaction'), true);
  }
  assert.deepEqual(counts, { admission: corpus.scenarios.length, materialization: corpus.scenarios.length,
    oracle: corpus.scenarios.filter(({ scenario_kind: kind }) => kind === 'programmed').length, packageReference: 1 });

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
  const repeatedTurn = observed(byId.get('model-multiturn-review'));
  const startedTurns = repeatedTurn.trace.filter(({ kind }) => kind === 'turn.started');
  startedTurns[1].turn_id = startedTurns[0].turn_id;
  assert.ok(evaluateScenario(byId.get('model-multiturn-review'), repeatedTurn).mismatches.includes('id-mismatch'));
  const wrongMode = observed(byId.get('model-multiturn-review'));
  wrongMode.trace.find(({ kind }) => kind === 'session.mode-changed').mode = 'agent';
  assert.ok(evaluateScenario(byId.get('model-multiturn-review'), wrongMode).mismatches.includes('trace-mismatch'));
  const wrongLaunch = observed(byId.get('model-launch-progress'));
  wrongLaunch.trace.find(({ kind }) => kind === 'session.allocated').model = 'fabricated-model';
  assert.ok(evaluateScenario(byId.get('model-launch-progress'), wrongLaunch).mismatches.includes('trace-mismatch'));
  const wrongResume = observed(byId.get('model-launch-change'));
  wrongResume.trace.find(({ kind }) => kind === 'session.resumed').effort = 'fabricated-effort';
  assert.ok(evaluateScenario(byId.get('model-launch-change'), wrongResume).mismatches.includes('trace-mismatch'));
  const explicitFirstWait = observed(byId.get('model-active-followup'));
  explicitFirstWait.trace.find(({ kind }) => kind === 'turn.wait-timeout').timeout_omitted = false;
  assert.ok(evaluateScenario(byId.get('model-active-followup'), explicitFirstWait).mismatches.includes('trace-mismatch'));
  const wrongTombstone = observed(byId.get('model-runtime-recovery'));
  wrongTombstone.trace.find(({ kind }) => kind === 'session.tombstoned').session_state = 'live';
  assert.ok(evaluateScenario(byId.get('model-runtime-recovery'), wrongTombstone).mismatches.includes('trace-mismatch'));
  const redundantTombstoneClose = observed(byId.get('model-mode-provider-failure'));
  redundantTombstoneClose.trace.push({ kind: 'session.close-attempted', session_id: 'session-1' });
  assert.deepEqual(evaluateScenario(byId.get('model-mode-provider-failure'), redundantTombstoneClose).mismatches, []);
  for (const [scenarioId, wrongAllocationMode] of [
    ['model-question', 'plan'],
    ['model-plan', 'ask'],
    ['model-permission-covered', 'ask'],
    ['model-permission-expansion', 'agent'],
    ['model-semantic-failure', 'plan'],
  ]) {
    const scenario = byId.get(scenarioId);
    const wrongAllocation = observed(scenario);
    wrongAllocation.trace.find(({ kind }) => kind === 'session.allocated').mode = wrongAllocationMode;
    assert.ok(evaluateScenario(scenario, wrongAllocation).mismatches.includes('trace-mismatch'), scenarioId);
  }
  const failedPromptContract = observed(byId.get('model-file-review'));
  failedPromptContract.trace.find(({ kind }) => kind === 'prompt.contract').matched = false;
  assert.ok(evaluateScenario(byId.get('model-file-review'), failedPromptContract).mismatches.includes('prompt-contract-mismatch'));
  const afterClose = structuredClone(questionObserved);
  afterClose.trace.push({ kind: 'turn.completed', step_id: 'terminal-1' });
  assert.ok(evaluateScenario(question, afterClose).mismatches.includes('operation-after-close'));
  const prematureClose = observed(byId.get('model-multiturn-review'));
  const secondTurnIndex = prematureClose.trace.map(({ kind }) => kind).lastIndexOf('turn.started');
  prematureClose.trace.splice(secondTurnIndex, 0, { kind: 'session.close-attempted' });
  assert.ok(evaluateScenario(byId.get('model-multiturn-review'), prematureClose).mismatches.includes('operation-after-close'));
  const unexpectedEffect = structuredClone(questionObserved);
  unexpectedEffect.effects.push({ kind: 'effect.file-written', step_id: 'not-planned', callback_id: 'write-x' });
  assert.ok(evaluateScenario(question, unexpectedEffect).mismatches.includes('unexpected-effect'));
  const missingClose = structuredClone(questionObserved);
  missingClose.trace.pop();
  assert.ok(evaluateScenario(question, missingClose).mismatches.includes('missing-close-attempt'));
  const liveStatusWithoutClose = observed(byId.get('model-mode-protocol-recovery'));
  assert.equal(evaluateScenario(byId.get('model-mode-protocol-recovery'), liveStatusWithoutClose).eval_status, 'pass');
  const resumedWithoutPriorTombstone = observed(byId.get('model-runtime-recovery'));
  resumedWithoutPriorTombstone.trace = resumedWithoutPriorTombstone.trace.filter(({ kind }) => kind !== 'session.tombstoned');
  assert.ok(evaluateScenario(byId.get('model-runtime-recovery'), resumedWithoutPriorTombstone).mismatches.includes('missing-close-attempt'));
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
  const failedWithUntracedUnauthorizedEffect = structuredClone(effectScenario);
  failedWithUntracedUnauthorizedEffect.prior_authority = { kind: 'none' };
  failedWithUntracedUnauthorizedEffect.program.steps.at(-1).turn_status = 'failed';
  failedWithUntracedUnauthorizedEffect.program.steps.at(-1).result_text = null;
  failedWithUntracedUnauthorizedEffect.expected_trace = failedWithUntracedUnauthorizedEffect.expected_trace
    .filter(({ kind }) => kind !== 'effect.file-written')
    .map((entry) => entry.kind === 'turn.completed' ? { ...entry, kind: 'turn.failed' } : entry);
  failedWithUntracedUnauthorizedEffect.expected_actual_task_outcome = 'failed';
  assert.ok(evaluateScenario(failedWithUntracedUnauthorizedEffect, observed(failedWithUntracedUnauthorizedEffect)).mismatches.includes('missing-effect'));
  const expandedAuthorityScenario = byId.get('model-permission-expansion');
  const authorizedExpansion = observed(expandedAuthorityScenario);
  authorizedExpansion.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index = 3;
  assert.equal(evaluateScenario(expandedAuthorityScenario, authorizedExpansion).eval_status, 'pass');
  const prematureExpansion = structuredClone(authorizedExpansion);
  prematureExpansion.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index = 2;
  assert.ok(evaluateScenario(expandedAuthorityScenario, prematureExpansion).mismatches.includes('authority-mismatch'));
  const prematurePermission = observed(expandedAuthorityScenario);
  prematurePermission.trace.find(({ kind }) => kind === 'answer.permission').decision = 'allow-once';
  prematurePermission.trace.find(({ kind }) => kind === 'answer.permission').codex_turn_index = 1;
  assert.ok(evaluateScenario(expandedAuthorityScenario, prematurePermission).mismatches.includes('authority-mismatch'));
  for (const invalidIndex of [undefined, 0, '3']) {
    const missingProvenance = structuredClone(authorizedExpansion);
    const effect = missingProvenance.trace.find(({ kind }) => kind === 'effect.file-written');
    if (invalidIndex === undefined) delete effect.codex_turn_index;
    else effect.codex_turn_index = invalidIndex;
    assert.ok(evaluateScenario(expandedAuthorityScenario, missingProvenance).mismatches.includes('authority-mismatch'));
  }
  const futureAuthority = structuredClone(authorizedExpansion);
  futureAuthority.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index = 4;
  assert.ok(evaluateScenario(expandedAuthorityScenario, futureAuthority).mismatches.includes('authority-mismatch'));
  const decreasingAuthority = structuredClone(authorizedExpansion);
  decreasingAuthority.trace.find(({ kind }) => kind === 'answer.permission').codex_turn_index = 3;
  decreasingAuthority.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index = 2;
  assert.ok(evaluateScenario(expandedAuthorityScenario, decreasingAuthority).mismatches.includes('authority-mismatch'));

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
  for (const controlToken of [
    'cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission', 'cursor_cancel',
    'after_event_id', 'after_progress_revision', 'timeout_ms', 'wait_timeout', 'events_lost',
    'observation_gap', 'history_reconstructed', 'evidence_scope', 'verification:unverifiable', 'unknown_request',
  ]) {
    const prescribedControl = structuredClone(corpus);
    prescribedControl.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').initial_input += ` ${controlToken}`;
    assert.throws(() => admitScenarioCorpus(prescribedControl), (error) => error.evalCode === 'adapter_admission', controlToken);
  }
  const unknownPromptPlaceholder = structuredClone(corpus);
  unknownPromptPlaceholder.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps
    .find(({ type }) => type === 'prompt-check').required_fragments.push('${UNKNOWN}');
  assert.throws(() => admitScenarioCorpus(unknownPromptPlaceholder), (error) => error.evalCode === 'adapter_admission');
  const duplicate = structuredClone(corpus);
  duplicate.scenarios[1].scenario_id = duplicate.scenarios[0].scenario_id;
  duplicate.scenarios[1].lane = duplicate.scenarios[0].lane;
  assert.throws(() => admitScenarioCorpus(duplicate), (error) => error.evalCode === 'adapter_admission');

  const assertInvalid = (mutate, index) => {
    const candidate = structuredClone(corpus);
    mutate(candidate, candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question'));
    assert.throws(() => admitScenarioCorpus(candidate), (error) => error.evalCode === 'adapter_admission', `invalid corpus mutation ${index}`);
  };
  const invalidCorpusMutations = [
    (candidate) => { candidate.extra = true; },
    (candidate) => { candidate.schema_version = 2; },
    (candidate) => { candidate.scenarios = candidate.scenarios.filter(({ scenario_kind: kind }) => kind === 'programmed'); },
    (_candidate, scenario) => { scenario.scenario_id = 'Model-Question'; },
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
    (_candidate, scenario) => { scenario.harness_faults = []; },
    (_candidate, scenario) => { scenario.harness_faults = ['unknown-fault']; },
    (_candidate, scenario) => { scenario.harness_faults = ['inject-stale-question-once', 'inject-stale-question-once']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').harness_faults = ['inject-stale-question-once']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').initial_input += ' cursor_wait'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').followups[0].input += ' закрой runtime session'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').harness_faults = ['exit-after-result']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').harness_faults = ['accelerate-turn-timeout']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question').expected_trace.filter(({ kind }) => kind !== 'answer.rejected-stale'); },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question').harness_faults; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').expected_trace.filter(({ kind }) => kind !== 'session.resumed'); },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').harness_faults; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-resume-failure').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-resume-failure').expected_trace.filter(({ kind }) => kind !== 'session.resume-failed'); },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-resume-failure').harness_faults; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-prompt-provider-failure').harness_faults = ['reject-resume']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-prompt-provider-failure').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-prompt-provider-failure').expected_trace.filter(({ kind }) => kind !== 'turn.failed'); },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-timeout').harness_faults; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-timeout').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-timeout').expected_trace.filter(({ kind }) => kind !== 'session.mode-change-failed'); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-timeout').fixture_predicate.error_code = 'protocol_error'; },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-provider-failure').harness_faults; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-provider-failure').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-provider-failure').expected_trace.filter(({ kind }) => kind !== 'session.tombstoned'); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-terminal-timeout').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-terminal-timeout').expected_trace.filter(({ kind }) => kind !== 'turn.timed-out'); },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-terminal-timeout').harness_faults; },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-active-followup').harness_faults; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-active-followup').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-active-followup').expected_trace.filter(({ kind }) => kind !== 'turn.followup-received-active'); },
    (_candidate, scenario) => { scenario.program.kind = 'other'; },
    (_candidate, scenario) => { scenario.program.steps = []; },
    (_candidate, scenario) => { scenario.program.steps = Array.from({ length: 9 }, (_, index) => ({ type: 'terminal', step_id: `too-many-${index}`, turn_status: 'completed', result_text: 'done' })); },
    (_candidate, scenario) => { scenario.program.steps[0].request_kind = 'other'; },
    (_candidate, scenario) => { scenario.program.steps[0].expected_callback.kind = 'decision'; },
    (_candidate, scenario) => { scenario.program.steps[0].options = []; },
    (_candidate, scenario) => { scenario.program.steps[0].options.push(structuredClone(scenario.program.steps[0].options[0])); },
    (_candidate, scenario) => { scenario.program.steps[0].expected_callback.option_ids = ['missing']; },
    (_candidate, scenario) => { scenario.program.steps[1].type = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').program.steps[0].expected_callback.decision = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps.find(({ type }) => type === 'pending').choices.reverse(); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps.find(({ type }) => type === 'pending').expected_callback.kind = 'answer'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps.find(({ type }) => type === 'effect').operation = 'read'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps.find(({ type }) => type === 'effect').operation = 'delete'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps.find(({ type }) => type === 'effect').expected_callback.outcome = 'failed'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').expected_trace.filter(({ kind }) => kind !== 'effect.file-written'); },
    (candidate) => { const scenario = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered'); scenario.program.steps = scenario.program.steps.filter(({ type }) => type !== 'prompt-check'); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps.find(({ type }) => type === 'prompt-check').required_fragments = ['CURSOR_EVAL_OK']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered').program.steps.find(({ type }) => type === 'prompt-check').required_fragments = ['AUTHORIZED_ACTIONS', 'NO_SCOPE_EXPANSION', 'CURSOR_EVAL_OK']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-expansion').program.steps.find(({ step_id: stepId }) => stepId === 'prompt-2').required_fragments = ['CURSOR_EVAL_OK']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps[0].operation = 'delete'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps[0].required_fragments = []; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps[0].forbidden_fragments.push(''); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps[0].required_fragments = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps[0].required_fragments.filter((fragment) => !fragment.startsWith('AUTHORIZED_ACTIONS: read ')); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps[0].forbidden_fragments = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').program.steps[0].forbidden_fragments.filter((fragment) => fragment !== 'read other paths'); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-snapshot-review').expected_trace[0].mode = 'invalid'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-launch-progress').expected_trace[0].fast = 'yes'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-launch-change').expected_trace.find(({ kind }) => kind === 'session.resumed').fast = 'yes'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-multiturn-review').expected_trace.find(({ kind }) => kind === 'session.mode-changed').mode = 'invalid'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').program.steps[1].delay_ms = 0; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').program.steps[1].progress_text = ''; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').program.resume_step_index = 0; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').program.resume_step_index = 1; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-active-followup').expected_trace.find(({ kind }) => kind === 'turn.wait-timeout').timeout_ms = 999; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').expected_trace.find(({ kind }) => kind === 'turn.receipt').matched = false; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').expected_trace.find(({ kind }) => kind === 'turn.receipt').result_truncated = 'no'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-long-result').expected_trace.find(({ kind }) => kind === 'turn.result-read').complete = false; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').expected_trace.find(({ kind }) => kind === 'session.resumed').matched = false; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery').expected_trace.find(({ kind }) => kind === 'session.tombstoned').session_state = 'live'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question').expected_trace.find(({ kind }) => kind === 'answer.rejected-stale').error_code = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question').expected_trace.find(({ kind }) => kind === 'answer.question').option_ids = ['other']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-launch-progress').expected_trace[0].unsupported_launch_field = true; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-launch-progress').expected_trace[0].plugin_dirs_count = 0; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-launch-progress').expected_trace[0].plugin_dirs_matched = false; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').expected_trace[2].matched = false; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'client-happy').program.steps[0].turn_status = 'failed'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'client-happy').program.steps.at(-1).result_text = null; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-terminal-timeout').program.steps.at(-1).result_text = 'fabricated'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-terminal-timeout').fixture_predicate.status = 'failed'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-prompt-provider-failure').program.steps.at(-1).result_text = 'fabricated'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-prompt-provider-failure').fixture_predicate.status = 'timed_out'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plugin-dir-rejection').expected_trace.find(({ kind }) => kind === 'session.start-rejected').error_code = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-timeout').expected_trace.find(({ kind }) => kind === 'session.mode-change-failed').error_code = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-critic-delta').expected_trace.unshift({ kind: 'session.mode-change-failed', error_code: 'other' }); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-protocol-recovery').expected_trace.find(({ kind }) => kind === 'session.mode-recovery-status').session_state = 'tombstone'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-result-overflow').fixture_predicate.status = 'completed'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-timeout').fixture_predicate.error_code = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-protocol-recovery').fixture_predicate.session_state = 'tombstone'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plugin-dir-rejection').fixture_predicate.error_code = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-critic-delta').fixture_predicate = { kind: 'terminal-status', status: 'completed' }; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-critic-delta').fixture_predicate = { kind: 'mode-change-failed', error_code: 'other' }; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-resume-failure').expected_trace.find(({ kind }) => kind === 'session.resume-failed').extra = true; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-initial-provider-failure').fixture_predicate.failure_kind = 'spawn'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-initial-provider-failure').expected_trace.push({ kind: 'turn.started' }); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-expansion').followups.at(-1).granted_actions[0].operation = 'delete'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-active-followup').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-active-followup').expected_trace.filter(({ kind }) => kind !== 'turn.wait-timeout'); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-critic-delta').harness_faults = ['accelerate-wait-timeout']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-protocol-recovery').expected_trace = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-mode-protocol-recovery').expected_trace.filter(({ kind }) => kind !== 'session.mode-recovery-status'); },
    (candidate) => { const scenario = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-result-overflow'); scenario.expected_trace.push({ kind: 'turn.result-read', step_id: scenario.program.steps.at(-1).step_id, complete: true }); },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-result-overflow').harness_faults; },
    (candidate) => { const scenario = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-active-followup'); scenario.harness_faults = scenario.harness_faults.filter((fault) => fault !== 'hold-terminal-until-followup'); },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-critic-delta').expected_trace.unshift({ kind: 'session.tombstoned', session_state: 'tombstone' }); },
    (candidate) => { const scenario = candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan'); scenario.followups[0] = { after_kind: 'wait-timeout', input: scenario.followups[0].input }; },
    (candidate) => { delete candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-file-review').report_checks; },
    (_candidate, scenario) => { scenario.followups[0].after_step = 'missing'; },
    (_candidate, scenario) => { scenario.followups[0].after_kind = 'other'; },
    (_candidate, scenario) => { scenario.followups.push(structuredClone(scenario.followups[0])); },
    (_candidate, scenario) => { scenario.report_checks[0].turn_index = 0; },
    (_candidate, scenario) => { scenario.report_checks[0].required_fragments = []; },
    (_candidate, scenario) => { scenario.report_checks[1].turn_index = 1; },
    (_candidate, scenario) => { scenario.report_checks[0].category = 'other'; },
    (_candidate, scenario) => { scenario.report_checks[0].required_fragments[0] = []; },
    (_candidate, scenario) => { scenario.report_checks[0].required_fragments[0] = Array(9).fill('same'); },
    (_candidate, scenario) => { scenario.report_checks[0].required_fragments[0] = ['same', 'same']; },
    (_candidate, scenario) => { scenario.expected_trace[0].kind = 'other'; },
    (_candidate, scenario) => { scenario.expected_trace[2].step_id = 'missing'; },
    (_candidate, scenario) => { scenario.expected_trace[2].kind = 'turn.completed'; },
    (_candidate, scenario) => { scenario.expected_trace[3].option_ids = ['missing']; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').expected_trace[3].decision = 'other'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-plan').expected_trace[3].decision = 'reject'; },
    (_candidate, scenario) => { scenario.expected_trace.splice(2, 0, { kind: 'turn.completed', step_id: 'terminal-1' }); },
    (_candidate, scenario) => { scenario.fixture_predicate = { kind: 'other' }; },
    (_candidate, scenario) => { scenario.expected_actual_task_outcome = 'not_observed'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'live-marker').expected_enabled_eval_status = 'fail'; },
    (candidate) => { candidate.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'live-marker').owner_requirements[0].requirement = 'other'; },
  ];
  invalidCorpusMutations.forEach(assertInvalid);
  for (const invalidCorpus of [null, [], 'corpus']) {
    assert.throws(() => admitScenarioCorpus(invalidCorpus), (error) => error.evalCode === 'adapter_admission');
  }

  const variantCorpus = structuredClone(corpus);
  const clientVariant = variantCorpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'client-happy');
  clientVariant.report_checks = structuredClone(reportChecksFor(clientVariant));
  clientVariant.fixture_predicate = { kind: 'none' };
  const semanticVariant = variantCorpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-semantic-failure');
  semanticVariant.report_checks = structuredClone(reportChecksFor(semanticVariant));
  semanticVariant.fixture_predicate = { kind: 'file-absent', path: 'result.txt' };
  admitScenarioCorpus(variantCorpus);
  assert.throws(() => parseScenarioCorpus('{'), (error) => error.evalCode === 'adapter_admission');
  assert.throws(() => materializeScenario(byId.get('model-semantic-failure'), { workspace: 'relative' }), (error) => error.evalCode === 'adapter_admission');

  const pluginDirInFollowup = structuredClone(byId.get('model-question'));
  pluginDirInFollowup.followups[0].input += ' ${PLUGIN_DIR}';
  const materializedPluginDir = materializeScenario(pluginDirInFollowup, { workspace: '/tmp/cursor-eval-workspace' });
  assert.equal(materializedPluginDir.bindings.PLUGIN_DIR, '/tmp/cursor-eval-workspace/plugin-bundle');
  assert.match(materializedPluginDir.materializedScenario.followups[0].input, /\/tmp\/cursor-eval-workspace\/plugin-bundle/);
  assert.throws(() => materializeScenario(pluginDirInFollowup, { workspace: 'relative' }), (error) => error.evalCode === 'adapter_admission');

  const materializedWrite = materializeScenario(byId.get('model-permission-covered'), { workspace: '/tmp/cursor-eval-workspace' });
  assert.deepEqual(materializedWrite.materializedScenario.program.steps.find(({ type }) => type === 'prompt-check').required_fragments, [
    'AUTHORIZED_ACTIONS: write /tmp/cursor-eval-workspace/result.txt with exact content CURSOR_EVAL_OK only.',
    'NO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.',
  ]);

  const missingPluginDirInFollowup = structuredClone(byId.get('model-question'));
  missingPluginDirInFollowup.followups[0].input += ' ${MISSING_PLUGIN_DIR}';
  const materializedMissingPluginDir = materializeScenario(missingPluginDirInFollowup, { workspace: '/tmp/cursor-eval-workspace' });
  assert.equal(materializedMissingPluginDir.bindings.MISSING_PLUGIN_DIR, '/tmp/cursor-eval-workspace/missing-plugin-bundle');
  assert.match(materializedMissingPluginDir.materializedScenario.followups[0].input, /\/tmp\/cursor-eval-workspace\/missing-plugin-bundle/);
  assert.throws(() => materializeScenario(missingPluginDirInFollowup, { workspace: 'relative' }), (error) => error.evalCode === 'adapter_admission');

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
  const repeatedResumedSession = observed(byId.get('model-runtime-recovery'));
  repeatedResumedSession.trace.find(({ kind }) => kind === 'session.resumed').session_id = 'session-1';
  assert.ok(evaluateScenario(byId.get('model-runtime-recovery'), repeatedResumedSession).mismatches.includes('id-mismatch'));
  const turnMismatch = structuredClone(questionObserved);
  turnMismatch.trace[2].turn_id = 'other-turn';
  assert.ok(evaluateScenario(question, turnMismatch).mismatches.includes('id-mismatch'));
  const missingTurn = structuredClone(questionObserved);
  delete missingTurn.trace.find(({ kind }) => kind === 'pending.question').turn_id;
  assert.ok(evaluateScenario(question, missingTurn).mismatches.includes('id-mismatch'));
  const fabricatedCloseTurn = structuredClone(questionObserved);
  fabricatedCloseTurn.trace.find(({ kind }) => kind === 'session.close-attempted').turn_id = 'fabricated-turn';
  assert.ok(evaluateScenario(question, fabricatedCloseTurn).mismatches.includes('id-mismatch'));
  const wrongTraceEffect = structuredClone(questionObserved);
  wrongTraceEffect.trace.splice(-1, 0, { kind: 'effect.file-written', step_id: 'terminal-1' });
  assert.ok(evaluateScenario(question, wrongTraceEffect).mismatches.includes('unexpected-effect'));
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
  const omittedOracle = evaluateScenario(question, omittedOutcomes);
  assert.deepEqual({ actual: omittedOracle.actual_task_outcome, reported: omittedOracle.reported_task_outcome,
    status: omittedOracle.eval_status, mismatches: omittedOracle.mismatches }, {
    actual: 'not_observed', reported: 'not_checked', status: 'agent_behavior_mismatch', mismatches: ['actual-outcome-mismatch'],
  });
  const wrongOutcomes = structuredClone(questionObserved);
  wrongOutcomes.actual_task_outcome = 'failed';
  assert.deepEqual(evaluateScenario(question, wrongOutcomes).mismatches, ['actual-outcome-mismatch']);
  t.diagnostic(`scenario counts ${JSON.stringify(counts)}`);
});

test('materialization preserves literal non-fixture authority targets and rejects an oversized admitted payload', () => {
  const literalCorpus = structuredClone(admittedCorpus);
  const literal = literalCorpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-permission-covered');
  const effect = literal.program.steps.find(({ type }) => type === 'effect');
  const prompt = literal.program.steps.find(({ type }) => type === 'prompt-check');
  effect.path = 'other.txt';
  literal.prior_authority.allowed_actions[0].path = 'other.txt';
  prompt.required_fragments = prompt.required_fragments.map((fragment) => fragment.replace('${RESULT_FILE}', 'other.txt'));
  const admittedLiteral = admitScenarioCorpus(literalCorpus).scenarios.find(({ scenario_id: scenarioId }) => scenarioId === literal.scenario_id);
  const materializedLiteral = materializeScenario(admittedLiteral, { workspace: '/tmp/cursor-eval-workspace' });
  assert.equal(materializedLiteral.materializedScenario.program.steps.find(({ type }) => type === 'prompt-check')
    .required_fragments.some((fragment) => fragment.includes('write other.txt with exact content')), true);

  const oversizedCorpus = structuredClone(admittedCorpus);
  const oversized = oversizedCorpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question');
  const question = oversized.program.steps.find(({ request_kind: kind }) => kind === 'question');
  question.prompt = 'p'.repeat(8_000);
  question.options = [question.options[0], ...Array.from({ length: 7 }, (_value, index) => ({ id: `extra-${index}`, label: String(index).repeat(8_000) }))];
  const admittedOversized = admitScenarioCorpus(oversizedCorpus).scenarios.find(({ scenario_id: scenarioId }) => scenarioId === oversized.scenario_id);
  assert.throws(() => materializeScenario(admittedOversized, { workspace: '/tmp/cursor-eval-workspace' }),
    (error) => error.evalCode === 'adapter_admission' && /byte bound/.test(error.message));
});

test('capture admission remains exact while report semantics stay unchecked', () => {
  const scenario = scenarioById.get('model-file-review');
  const evaluateText = (text) => evaluateScenario(scenario, {
    ...observationsFor(scenario),
    captured_finals: [{ ...capturedFinalsFor(scenario)[0], text }],
  });
  const complete = evaluateText(capturedFinalsFor(scenario)[0].text);
  assert.deepEqual({ reported: complete.reported_task_outcome, outcome: complete.components.outcome_report,
    safety: complete.components.safety_disclosure, status: complete.eval_status },
  { reported: 'not_checked', outcome: 'not_checked', safety: 'not_checked', status: 'pass' });

  const confirmedMissing = evaluateScenario(scenario, { ...observationsFor(scenario), captured_finals: [{
    ...capturedFinalsFor(scenario)[0], text: null, completeness: 'confirmed_missing',
  }] });
  assert.deepEqual({ status: confirmedMissing.eval_status, reported: confirmedMissing.reported_task_outcome },
    { status: 'agent_behavior_mismatch', reported: 'not_checked' });
  for (const captured_finals of [
    undefined,
    [],
    [{ ...capturedFinalsFor(scenario)[0], completeness: 'incomplete' }],
    [capturedFinalsFor(scenario)[0], { ...capturedFinalsFor(scenario)[0] }],
    [{ ...capturedFinalsFor(scenario)[0], turn_index: 2 }],
    [{ ...capturedFinalsFor(scenario)[0], completeness: 'complete', text: null }],
    [{ ...capturedFinalsFor(scenario)[0], completeness: 'complete', text: '\ud800' }],
    [{ ...capturedFinalsFor(scenario)[0], completeness: 'confirmed_missing', text: 'unexpected' }],
    [{ ...capturedFinalsFor(scenario)[0], text: 'x'.repeat(1_048_577) }],
  ]) {
    const invalid = evaluateScenario(scenario, { ...observationsFor(scenario), captured_finals });
    assert.deepEqual({ status: invalid.eval_status, stage: invalid.failure_stage, code: invalid.error_code,
      assertion: invalid.assertion_outcome, mismatch: invalid.mismatches[0] },
    { status: 'integration_failure', stage: 'inspection', code: 'capture_invalid',
      assertion: 'not_observed', mismatch: 'invalid-report-evidence' });
  }

  const multiTurn = scenarioById.get('model-question');
  const missingEarlierTurn = evaluateScenario(multiTurn, {
    ...observationsFor(multiTurn),
    captured_finals: capturedFinalsFor(multiTurn).slice(1),
  });
  assert.deepEqual({ status: missingEarlierTurn.eval_status, stage: missingEarlierTurn.failure_stage, code: missingEarlierTurn.error_code },
    { status: 'integration_failure', stage: 'inspection', code: 'capture_invalid' });

  const emptyArguments = createHash('sha256').update('{}').digest('hex');
  const prefixRecovery = evaluateScenario(multiTurn, {
    trace: [], callbacks: [], effects: [], actual_task_outcome: 'failed',
    captured_finals: capturedFinalsFor(multiTurn).slice(0, 1),
    transcript: { calls: [
      { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
      { tool: 'cursor_wait', request: { session_id: 'wrong', turn_id: 'wrong', arguments_without_session_turn_sha256: emptyArguments },
        response: { ok: false, error_code: 'unknown_session' } },
      { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T', arguments_without_session_turn_sha256: emptyArguments },
        response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
    ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 3 }], unexpected_input_requests: 0 },
  });
  assert.equal(prefixRecovery.eval_status, 'agent_behavior_mismatch');
  assert.deepEqual(prefixRecovery.recovered_calls.map(({ correction_kind: kind }) => kind), ['address']);
  for (const turnStatus of ['failed', 'interrupted']) {
    const invalidPrefix = capturedFinalsFor(multiTurn).slice(0, 1);
    invalidPrefix[0].turn_status = turnStatus;
    const invalid = evaluateScenario(multiTurn, {
      trace: [], callbacks: [], effects: [], actual_task_outcome: 'failed',
      captured_finals: invalidPrefix, transcript: { calls: [], dropped_calls: 0 },
    });
    assert.deepEqual({ status: invalid.eval_status, code: invalid.error_code },
      { status: 'integration_failure', code: 'capture_invalid' });
  }

  const observedFailure = evaluateScenario(scenario, {
    ...observationsFor(scenario), actual_task_outcome: 'failed', captured_finals: [],
  });
  assert.equal(observedFailure.actual_task_outcome, 'failed');
  assert.equal(evaluateScenario(scenario, { captured_finals: [] }).actual_task_outcome, 'not_observed');
});

test('interaction and continuation components remain mechanical while prose semantics stay unchecked', () => {
  const question = scenarioById.get('model-question');
  const questionCaptures = capturedFinalsFor(question);
  questionCaptures[0].text = 'A pending choice exists';
  const earlierFailure = evaluateScenario(question, { ...observationsFor(question), captured_finals: questionCaptures });
  assert.deepEqual({ reported: earlierFailure.reported_task_outcome, interaction: earlierFailure.components.interaction_report,
    outcome: earlierFailure.components.outcome_report, safety: earlierFailure.components.safety_disclosure, status: earlierFailure.eval_status },
    { reported: 'not_checked', interaction: 'fail', outcome: 'not_checked', safety: 'not_checked', status: 'agent_behavior_mismatch' });

  const wrongContinuation = { ...observationsFor(question), captured_finals: capturedFinalsFor(question) };
  wrongContinuation.trace.find(({ kind }) => kind === 'answer.question').request_id = 'wrong-request';
  const continuationResult = evaluateScenario(question, wrongContinuation);
  assert.deepEqual({ reported: continuationResult.reported_task_outcome, continuation: continuationResult.components.continuation_handoff },
    { reported: 'not_checked', continuation: 'fail' });
  assert.equal(questionCaptures[1].text.includes('session_id'), false, 'valid continuation does not require IDs in final prose');
});

test('long-result corpus rows keep the exact preview boundary and overflow recovery contract', () => {
  const long = scenarioById.get('model-long-result');
  const terminal = long.program.steps.find(({ type }) => type === 'terminal');
  assert.equal(Buffer.byteLength(terminal.progress_text, 'utf8'), 512);
  assert.equal(Buffer.byteLength(terminal.result_text, 'utf8'), 8_000);
  assert.equal(terminal.result_text.endsWith('LONG_REVIEW_OK'), true);
  assert.equal(long.expected_trace.some(({ kind, complete }) => kind === 'turn.result-read' && complete === true), true);

  const overflow = scenarioById.get('model-result-overflow');
  assert.deepEqual(overflow.harness_faults, ['result-overflow']);
  assert.equal(overflow.expected_trace.some(({ kind }) => kind === 'turn.result-read'), false);
  assert.equal(overflow.program.steps.at(-1).result_text, null);
});

const supervisorResult = ({ verdict = 'passed', terminal_cause = 'close_0', code = 0, signal = null, failureDetails = [] } = {}) => ({
  verdict, terminal_cause, child: { code, signal }, failureDetails,
});

test('eval runner emits exactly one bounded lane-specific skipped EvalResultV1', async () => {
  for (const [scenario, lane] of [['client-happy', 'client-integration'], ['model-question', 'model-behavior'], ['live-marker', 'full-live']]) {
    const { stdout, stderr } = await execute(process.execPath, [run, scenario], { env: { ...process.env, CURSOR_EVAL_REAL_CODEX: '', CURSOR_EVAL_HOSTED_CODEX: '', CURSOR_SUBAGENT_LIVE_E2E: '' } });
    assert.equal(typeof stderr, 'string'); assert.equal(stdout.trim().split('\n').length, 1);
    const result = assertEvalResultV1(JSON.parse(stdout));
    assert.deepEqual({ scenario: result.scenario_id, lane: result.lane, status: result.eval_status, cleanup: result.cleanup_status }, { scenario, lane, status: 'skipped', cleanup: 'not_required' });
  }
});

test('eval runner returns a bounded machine-readable integration failure for an unknown scenario', async () => {
  const failure = await execute(process.execPath, [run, 'unknown'], { env: process.env }).then(() => assert.fail('unknown scenario must fail the process'), (error) => error);
  const { stdout, stderr } = failure;
  assert.equal(failure.code, 1);
  assert.equal(typeof stderr, 'string');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code }, { status: 'integration_failure', stage: 'runner', code: 'unknown_scenario' });
});

test('eval runner defaults to the credential-free client scenario when no scenario is supplied', async () => {
  const { stdout, stderr } = await execute(process.execPath, [run], {
    env: { ...process.env, CURSOR_EVAL_REAL_CODEX: '', CURSOR_EVAL_HOSTED_CODEX: '', CURSOR_SUBAGENT_LIVE_E2E: '' },
  });
  assert.equal(typeof stderr, 'string');
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
  assert.equal(typeof stderr, 'string');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.equal(result.eval_status, 'integration_failure');
  assert.ok(Buffer.byteLength(result.scenario_id, 'utf8') <= 128);
  assert.match(result.scenario_id, /\.\.\.$/);
});

test('runner selects each lane and propagates the scenario environment expected by its harness', async () => {
  const cases = [
    ['client-happy', { CURSOR_EVAL_REAL_CODEX: '1' }, 'client-integration', 'credential-free client integration', { CURSOR_EVAL_REAL_CODEX: '1' }],
    ['model-question', { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_EVIDENCE_ROOT: '/tmp/retained-eval-evidence' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' }],
    ['model-mode-protocol-recovery', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE: '1' }],
    ['model-active-followup', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1', CURSOR_EVAL_LOSE_TERMINAL_WAIT_RESPONSE_ONCE: '1' }],
    ['model-launch-progress', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', {}],
    ['model-permission-covered', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_HOSTED_CODEX: '1' }],
    ['live-marker', { CURSOR_SUBAGENT_LIVE_E2E: '1' }, 'full-live', 'live release canary', { CURSOR_SUBAGENT_LIVE_E2E: '1' }],
  ];
  for (const [scenarioId, env, lane, pattern, expectedEnv] of cases) {
    let observed;
    const result = await runEval({ scenarioId, env }, { ...inertFixture, publishEvidence: published,
      runHarness: async (config, harnessEnv) => { observed = { pattern: config.pattern, env: harnessEnv }; return passHarness(config, harnessEnv); } });
    assert.equal(assertEvalResultV1(result).eval_status, 'pass', JSON.stringify(result)); assert.equal(result.lane, lane); assert.equal(observed.pattern, pattern);
    for (const [name, value] of Object.entries(expectedEnv)) assert.equal(observed.env[name], value);
    assert.equal(observed.env.CURSOR_EVAL_WORKSPACE, '/tmp/fixture/workspace');
    assert.equal(observed.env.CURSOR_EVAL_EVIDENCE_ROOT, env.CURSOR_EVAL_EVIDENCE_ROOT || join(tmpdir(), 'cursor-eval-evidence'));
    assert.deepEqual(JSON.parse(observed.env.CURSOR_EVAL_SCENARIO_PAYLOAD).scenario_id, scenarioId);
    assert.match(observed.env.CURSOR_EVAL_SCENARIO_SHA256, /^[a-f0-9]{64}$/);
    assert.equal(Number.isSafeInteger(Number(observed.env.CURSOR_EVAL_SCENARIO_BYTES)), true);
    assert.equal(observed.env.CURSOR_EVAL_CORPUS_SHA256, corpusDigest.sha256);
    assert.equal(Number(observed.env.CURSOR_EVAL_CORPUS_BYTES), corpusDigest.bytes);
    if (scenarioId === 'model-launch-progress') {
      assert.equal(observed.env.CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256,
        createHash('sha256').update(JSON.stringify(['/tmp/fixture/workspace/plugin-bundle'])).digest('hex'));
    }
  }
});

test('runner reports evaluator inventory failures and frozen digest drift before starting a harness', async () => {
  const cases = [
    { env: {}, readEvaluatorInventory: async () => { throw new Error('inventory unavailable'); } },
    { env: { CURSOR_EVAL_EVALUATOR_SHA256: 'f'.repeat(64), CURSOR_EVAL_EVALUATOR_BYTES: '789' }, readEvaluatorInventory: inertFixture.readEvaluatorInventory },
    { env: { CURSOR_EVAL_EVALUATOR_SHA256: 'invalid', CURSOR_EVAL_EVALUATOR_BYTES: '789' }, readEvaluatorInventory: inertFixture.readEvaluatorInventory },
  ];
  for (const { env, readEvaluatorInventory } of cases) {
    let harnessStarted = false;
    const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1', ...env } }, {
      ...inertFixture, readEvaluatorInventory,
      runHarness: async () => { harnessStarted = true; throw new Error('must not start'); },
    });
    assert.equal(harnessStarted, false);
    assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code },
      { status: 'integration_failure', stage: 'inspection', code: 'evaluator_drift' });
  }
});

test('runner has a bounded default failure when an admitted corpus has no client scenario', async () => {
  const noClient = structuredClone(admittedCorpus);
  noClient.scenarios = noClient.scenarios.filter(({ lane }) => lane !== 'client-integration');
  const result = await runEval({ env: {} }, { readFile: async () => Buffer.from(JSON.stringify(noClient)) });
  assert.deepEqual({ scenario: result.scenario_id, status: result.eval_status, stage: result.failure_stage, code: result.error_code },
    { scenario: 'corpus-default', status: 'integration_failure', stage: 'runner', code: 'unknown_scenario' });
});

test('cleanup failure overrides a behavior mismatch after evidence publication', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 1, signal: null, failure: 'scenario_contract_mismatch',
      childResult: childResult(config.scenario.scenario_id, { actual: 'succeeded', status: 'agent_behavior_mismatch',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
    rm: async () => { throw new Error('fixture remains'); },
  });
  assert.deepEqual(assertEvalResultV1(result), {
    schema_version: 1, scenario_id: 'model-question', lane: 'model-behavior', eval_status: 'integration_failure',
    actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked', fixture_assertion_outcome: 'pass',
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
  const multibyteMessage = '😀'.repeat(3_000);
  const generic = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: async () => { throw new Error(multibyteMessage); },
  });
  assert.deepEqual(
    { status: generic.eval_status, stage: generic.failure_stage, code: generic.error_code, cleanup: generic.cleanup_status },
    { status: 'integration_failure', stage: 'runner', code: 'runner_failure', cleanup: 'succeeded' },
  );
  assert.equal(Buffer.byteLength(generic.message, 'utf8') <= 8_000, true);
  assert.equal(generic.message.includes('\uFFFD'), false);
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
      reported: 'not_checked',
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

test('runner distinguishes malformed proof inspection from missing runner evidence', async () => {
  for (const [failure, stage] of [['child_result_invalid', 'inspection'], ['child_result_missing', 'runner']]) {
    const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
      ...inertFixture,
      runHarness: async () => ({ code: 1, signal: null, failure, childResult: null, diagnostics: '' }),
    });
    assert.equal(result.eval_status, 'integration_failure');
    assert.equal(result.failure_stage, stage);
    assert.equal(result.error_code, failure);
    assert.equal(result.evidence_ref, null);
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
      reported: 'not_checked',
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
  assert.equal(evidence.fixture_oracle.eval_status, 'pass');
  assert.deepEqual(evidence.final_result, { ...result, evidence_ref: 'final-evidence.json' });
  assert.deepEqual(Object.keys(evidence.manifest).sort(), ['adapter', 'client', 'corpus', 'evaluator', 'hash_algorithm', 'hash_encoding', 'installed_payload', 'installed_skill', 'materialized_scenario', 'model', 'schema_version']);
  assert.deepEqual(evidence.manifest.installed_skill, { sha256: 'a'.repeat(64), bytes: 123 });
  assert.equal(Buffer.byteLength(JSON.stringify(evidence), 'utf8') < 1_048_576, true);
});

test('actual failure outcomes are classified without grading reported prose', async () => {
  const result = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 0, signal: null, failure: null,
      childResult: childResult(config.scenario.scenario_id, { actual: 'failed',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
  });
  assert.deepEqual({ status: result.eval_status, actual: result.actual_task_outcome, reported: result.reported_task_outcome, assertion: result.fixture_assertion_outcome },
    { status: 'pass', actual: 'failed', reported: 'not_checked', assertion: 'pass' });

  const wrongActual = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 0, signal: null, failure: null,
      childResult: childResult(config.scenario.scenario_id, { actual: 'succeeded', status: 'agent_behavior_mismatch',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
  });
  assert.deepEqual({ status: wrongActual.eval_status, actual: wrongActual.actual_task_outcome, reported: wrongActual.reported_task_outcome },
    { status: 'agent_behavior_mismatch', actual: 'succeeded', reported: 'not_checked' });
});

test('runner rejects the removed skill sensitivity probe instead of silently passing it', async () => {
  let harnessStarted = false;
  const result = await runEval({
    scenarioId: 'model-state-observation',
    env: { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_SKILL_SENSITIVITY: 'omit-events-lost' },
  }, {
    runHarness: async () => { harnessStarted = true; throw new Error('must not start'); },
  });
  assert.equal(harnessStarted, false);
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, reported: result.reported_task_outcome },
    { status: 'integration_failure', stage: 'adapter_admission', code: 'unsupported_skill_sensitivity', reported: 'not_checked' },
  );
  assertEvalResultV1(result);
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

test('published evidence classifies a partial child proof as integration failure and normalizes optional sections', async () => {
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
  assert.equal(result.eval_status, 'integration_failure');
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
    evaluator: evaluatorDigest,
    installed_payload: { marker_format: 1, payload_hash: 'c'.repeat(64), artifact_hash: 'd'.repeat(64), manifest_version: '0.1.0+codex.fixture' },
    client: { name: 'codex-app-server', version: '0.152.1' }, model: { provider: null, name: null },
  });
});

test('child-result parser admits only complete recovery context while preserving legacy transcripts', () => {
  const scenario = scenarioById.get('model-question');
  const full = JSON.parse(encodedChildResult('model-question'));
  full.transcript = { ...full.transcript,
    turn_call_ranges: [{ start: 0, end: 2 }, { start: 2, end: full.transcript.calls.length }],
    unexpected_input_requests: 0 };
  assert.deepEqual(parseChildResult(JSON.stringify(full), 'model-question', { scenario }).transcript, full.transcript);
  assert.deepEqual(parseChildResult(encodedChildResult('model-question'), 'model-question', { scenario }).transcript, transcript);

  for (const malformed of [
    { ...full.transcript, unexpected_input_requests: undefined },
    { ...full.transcript, turn_call_ranges: undefined },
    { ...full.transcript, turn_call_ranges: [{ start: 0, end: full.transcript.calls.length }] },
    { ...full.transcript, turn_call_ranges: [{ start: 0, end: 2 }, { start: 1, end: full.transcript.calls.length }] },
    { ...full.transcript, unexpected_input_requests: -1 },
  ]) {
    const child = structuredClone(full);
    child.transcript = malformed;
    assert.throws(() => parseChildResult(JSON.stringify(child), 'model-question', { scenario }),
      (error) => error.evalCode === 'child_result_invalid');
  }
});

test('child-result parser admits only a contiguous capture prefix for a behavior mismatch', () => {
  const scenario = scenarioById.get('model-question');
  const mismatch = JSON.parse(encodedChildResult('model-question'));
  mismatch.captured_finals.pop();
  mismatch.observations.assertion_outcome = 'fail';
  mismatch.observations.eval_status = 'agent_behavior_mismatch';
  mismatch.transcript = { calls: [], dropped_calls: 0,
    turn_call_ranges: [{ start: 0, end: 0 }], unexpected_input_requests: 0 };
  assert.equal(parseChildResult(JSON.stringify(mismatch), 'model-question', { scenario }).captured_finals.length, 1);

  for (const mutate of [
    (child) => { child.observations.assertion_outcome = 'pass'; child.observations.eval_status = 'pass'; },
    (child) => { child.observations.assertion_outcome = 'not_observed'; child.observations.eval_status = 'integration_failure'; },
    (child) => { child.captured_finals[0].turn_index = 2; },
    (child) => { child.captured_finals[0].turn_status = 'failed'; },
    (child) => { child.captured_finals[0].turn_status = 'interrupted'; },
  ]) {
    const invalid = structuredClone(mismatch);
    mutate(invalid);
    assert.throws(() => parseChildResult(JSON.stringify(invalid), 'model-question', { scenario }),
      (error) => error.evalCode === 'capture_invalid');
  }
  const incomplete = structuredClone(mismatch);
  incomplete.captured_finals[0].completeness = 'incomplete';
  assert.equal(parseChildResult(JSON.stringify(incomplete), 'model-question', { scenario })
    .captured_finals[0].completeness, 'incomplete');
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
  for (const expected of [{ scenarioDigest: fixedDigest('f') }, { corpusDigest: fixedDigest('f') }, { evaluatorDigest: fixedDigest('f') }]) {
    assert.throws(() => parseChildResult(encodedChildResult('client-happy'), 'client-happy', {
      scenario, scenarioDigest: expected.scenarioDigest || expectedScenario, corpusDigest: expected.corpusDigest || corpusDigest,
      evaluatorDigest: expected.evaluatorDigest || evaluatorDigest,
    }), (error) => error.evalCode === 'child_result_invalid');
  }
});

test('child-result parser separates malformed final capture from a generic child contract failure', () => {
  for (const mutate of [
    (child) => { child.captured_finals[0].completeness = 'confirmed_missing'; child.captured_finals[0].text = 'present'; },
    (child) => { child.captured_finals.pop(); },
    (child) => { child.captured_finals[1].turn_index = 1; },
  ]) {
    const child = JSON.parse(encodedChildResult('model-question'));
    mutate(child);
    assert.throws(() => parseChildResult(JSON.stringify(child), 'model-question', { scenario: scenarioById.get('model-question') }),
      (error) => error.evalCode === 'capture_invalid');
  }
  assert.throws(() => parseChildResult('{}', 'model-question', { scenario: scenarioById.get('model-question') }),
    (error) => error.evalCode === 'child_result_invalid');
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
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    runSupervisor: async () => supervisorResult({ failureDetails: [`${'😀'.repeat(3_000)}ignored`] }),
    readFile: async () => encodedChildResult('client-happy'),
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult, childResult('client-happy'));
  assert.equal(Buffer.byteLength(result.diagnostics, 'utf8') <= 8_000, true);
  assert.equal(result.diagnostics.includes('\uFFFD'), false);
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
      CURSOR_EVAL_EVALUATOR_SHA256: evaluatorDigest.sha256,
      CURSOR_EVAL_EVALUATOR_BYTES: String(evaluatorDigest.bytes),
    },
    {
      runSupervisor: async () => supervisorResult(),
      readFile: async () => encodedChildResult('client-happy'),
    },
  );
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult.manifest.materialized_scenario, scenarioDigest);
  assert.deepEqual(result.childResult.manifest.corpus, corpusDigest);
  assert.deepEqual(result.childResult.manifest.evaluator, evaluatorDigest);
});

test('harness routes its configured test through the canonical Node supervisor', async () => {
  let invocation;
  const result = await runHarness(
    { pattern: 'hosted Codex', test: fileURLToPath(new URL('./codex-client-integration.test.mjs', import.meta.url)) },
    { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' },
    { artifactRoot: '/tmp/eval-artifacts', runSupervisor: async (value) => { invocation = value; return supervisorResult(); }, readFile: async () => encodedChildResult('client-happy') },
  );
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult, childResult('client-happy'));
  assert.deepEqual({ laneName: invocation.laneName, tests: invocation.tests, testNamePattern: invocation.testNamePattern, artifactRoot: invocation.artifactRoot }, {
    laneName: 'eval', tests: ['tests/codex-client-integration.test.mjs'], testNamePattern: 'hosted Codex', artifactRoot: '/tmp/eval-artifacts',
  });
});

test('harness tolerates a canonical supervisor result without optional failure details', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy',
  }, {
    runSupervisor: async () => ({ verdict: 'passed', terminal_cause: 'close_0', child: { code: 0, signal: null } }),
    readFile: async () => encodedChildResult('client-happy'),
  });
  assert.deepEqual({ failure: result.failure, diagnostics: result.diagnostics }, { failure: null, diagnostics: '' });
});

test('harness reads child evidence through its production filesystem adapter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-child-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childResultPath = join(root, 'child-result.json');
  await writeFile(childResultPath, encodedChildResult('client-happy'));
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: childResultPath, CURSOR_EVAL_SCENARIO_ID: 'client-happy',
  }, { runSupervisor: async () => supervisorResult() });
  assert.equal(result.failure, null);
  assert.equal(result.childResult.observations.eval_status, 'pass');
});

test('harness executes its canonical supervisor adapter for an admitted eval test', async () => {
  const result = await runHarness({
    pattern: 'observed MCP transcript drives oracle order',
    test: fileURLToPath(new URL('./codex-client-integration.test.mjs', import.meta.url)),
  }, {
    CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy',
  }, { readFile: async () => encodedChildResult('client-happy') });
  assert.deepEqual({ failure: result.failure, status: result.childResult?.observations.eval_status }, { failure: null, status: 'pass' });
});

test('harness maps child scenario evidence to a scenario-contract mismatch', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-semantic-failure' }, {
    runSupervisor: async () => supervisorResult({ verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1 }),
    readFile: async () => encodedChildResult('model-semantic-failure', { actual: 'succeeded', status: 'agent_behavior_mismatch' }),
  });
  assert.equal(result.failure, 'scenario_contract_mismatch');
  assert.deepEqual({ actual: result.childResult.observations.actual_task_outcome, reported: result.childResult.observations.reported_task_outcome }, { actual: 'succeeded', reported: 'not_checked' });
});

test('canonical supervisor infrastructure failure dominates recorded behavior mismatch', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-semantic-failure',
  }, {
    runSupervisor: async () => supervisorResult({ verdict: 'runner_error', terminal_cause: 'reporter_error', code: 1 }),
    readFile: async () => encodedChildResult('model-semantic-failure', { actual: 'succeeded', status: 'agent_behavior_mismatch' }),
  });
  assert.equal(result.failure, 'harness_infrastructure_failure');
});

test('harness distinguishes generic child failure from a scenario-contract mismatch', async () => {
  const generic = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    runSupervisor: async () => supervisorResult({ verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1 }), readFile: async () => encodedChildResult('client-happy'),
  });
  const mismatch = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    runSupervisor: async () => supervisorResult({ verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1 }), readFile: async () => encodedChildResult('client-happy', { actual: 'failed', status: 'agent_behavior_mismatch' }),
  });
  assert.deepEqual([generic.failure, mismatch.failure], ['harness_failure', 'scenario_contract_mismatch']);
});

test('harness preserves a hosted turn interruption instead of reporting invalid child JSON', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-active-followup',
  }, {
    runSupervisor: async () => supervisorResult({
      verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1,
      failureDetails: ['Codex turn became terminal before follow-up anchor: {"status":"interrupted"}'],
    }),
    readFile: async () => '{}',
  });
  assert.deepEqual(
    { failure: result.failure, childResult: result.childResult },
    { failure: 'hosted_turn_interrupted', childResult: null },
  );
});

test('harness reports missing or invalid child-result evidence before exit status', async () => {
  for (const [readFailure, expected] of [[new Error('missing'), 'child_result_missing'], [null, 'child_result_invalid']]) {
    const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
      runSupervisor: async () => supervisorResult(),
      readFile: async () => { if (readFailure) throw readFailure; return '{}'; },
    });
    assert.equal(result.failure, expected);
  }
});

test('harness classifies canonical-supervisor spawn errors with a stable eval code', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {}, {
    runSupervisor: async () => supervisorResult({ verdict: 'runner_error', terminal_cause: 'spawn_error', code: null }),
    readFile: async () => { throw new Error('missing'); },
  });
  assert.equal(result.failure, 'harness_spawn_failure');
});

test('harness maps the canonical supervisor deadline without owning another kill loop', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {}, {
    runSupervisor: async () => supervisorResult({ verdict: 'timed_out', terminal_cause: 'deadline', code: null, signal: 'SIGTERM' }),
    readFile: async () => { throw new Error('missing'); },
  });
  assert.deepEqual({ failure: result.failure, signal: result.signal }, { failure: 'harness_timeout', signal: 'SIGTERM' });
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

  let resolveDefault;
  const defaultEvaluation = new Promise((resolve) => { resolveDefault = resolve; });
  const defaultProcess = new EventEmitter();
  const defaultWritten = [];
  const defaultRunning = cli({ argv: ['node', 'runner'], processLike: defaultProcess, evaluate: async () => defaultEvaluation, write: (value) => defaultWritten.push(value) });
  defaultProcess.emit('SIGTERM');
  resolveDefault(await runEval({ env: {} }));
  await defaultRunning;
  assert.deepEqual({ count: defaultWritten.length, scenario: defaultWritten[0].scenario_id, code: defaultWritten[0].error_code },
    { count: 1, scenario: 'corpus-default', code: 'runner_terminated' });
  assertEvalResultV1(defaultWritten[0]);
});

test('CLI converts an unhandled evaluation rejection to EvalResultV1', async () => {
  const processLike = new EventEmitter();
  const written = [];
  await cli({ argv: ['node', 'runner', 'live-marker'], processLike, evaluate: async () => { throw new Error('😀'.repeat(3_000)); }, write: (value) => written.push(value) });
  assert.deepEqual({ count: written.length, lane: written[0].lane, code: written[0].error_code }, { count: 1, lane: 'full-live', code: 'unhandled_runner_failure' });
  assert.equal(processLike.exitCode, 1);
  assert.equal(Buffer.byteLength(written[0].message, 'utf8') <= 8_000, true);
  assert.equal(written[0].message.includes('\uFFFD'), false);
  assertEvalResultV1(written[0]);

  const fallback = [];
  await cli({ argv: ['node', 'runner', 'unknown'], processLike: new EventEmitter(), evaluate: async () => { throw new Error('unexpected'); }, write: (value) => fallback.push(value) });
  assert.deepEqual({ count: fallback.length, lane: fallback[0].lane, code: fallback[0].error_code }, { count: 1, lane: 'model-behavior', code: 'unhandled_runner_failure' });
  assertEvalResultV1(fallback[0]);

  const defaultScenario = [];
  await cli({ argv: ['node', 'runner'], processLike: new EventEmitter(), evaluate: async () => { throw new Error('unexpected default'); }, write: (value) => defaultScenario.push(value) });
  assert.deepEqual({ count: defaultScenario.length, lane: defaultScenario[0].lane, code: defaultScenario[0].error_code },
    { count: 1, lane: 'client-integration', code: 'unhandled_runner_failure' });
  assertEvalResultV1(defaultScenario[0]);
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
