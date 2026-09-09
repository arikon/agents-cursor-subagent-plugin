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
    return { ...entry, ...(entry.kind === 'turn.wait-response-recovered' ? { lost_call_index: 2, repeated_call_index: 3 } : {}), ...(entry.kind === 'session.start-rejected' ? {} : { session_id: currentSessionId }), ...(!entry.kind.startsWith('session.') ? { turn_id: `T${turnIndex || 1}` } : {}),
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
    { tool: 'cursor_wait', request: lossWaitRequest, response: { ok: false, error_code: 'eval_wait_response_lost', message: 'cursor_wait response unavailable' }, withheld_response: lossWaitResponse },
    { tool: 'cursor_wait', request: lossWaitRequest, response: lossWaitResponse },
  ], dropped_calls: 0, unexpected_input_requests: 0, turn_call_ranges: [{ start: 0, end: 3 }],
};
const lossWaitRequest = { session_id: 'S', turn_id: 'T', arguments_without_session_turn_sha256: createHash('sha256').update('{}').digest('hex') };
const lossResultDigest = createHash('sha256').update('WAIT_RECOVERED_OK').digest('hex');
const lossWaitResponse = { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed',
  wait_timeout: false, pending: [], session_state: 'live',
  result: { text_bytes: 17, text_sha256: lossResultDigest, truncated: false },
  terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 1, result_sha256: lossResultDigest, result_truncated: false } };
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

const supervisorResult = ({ verdict = 'passed', terminal_cause = 'close_0', code = 0, signal = null, failureDetails = [] } = {}) => ({
  verdict, terminal_cause, child: { code, signal }, failureDetails,
});


export {
  assert, execFile, createHash, EventEmitter, mkdtemp, readFile, rm, writeFile, tmpdir, join, promisify, fileURLToPath,
  admitScenarioCorpus, evaluateScenario, materializeScenario, parseScenarioCorpus, assertEvalResultV1, cli, parseChildResult, publishFinalEvidence, runEval, runHarness,
  run, execute, transcript, toolSequence, requestTrace, rawCorpus, admittedCorpus, corpusDigest, scenarioById, fixedDigest, evaluatorDigest,
  observedTraceFor, observedCallbacksFor, transcriptFor, reportChecksFor, capturedFinalsFor, observationsFor, childResult, passHarness, published, removed, inertFixture, encodedChildResult, supervisorResult,
};
