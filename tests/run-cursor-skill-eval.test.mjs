import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertEvalResultV1 } from '../scripts/cursor-skill-eval.mjs';
import { cli, parseChildResult, publishFinalEvidence, runEval, runHarness, transcriptIsCorrelated } from '../scripts/run-cursor-skill-eval.mjs';

const run = fileURLToPath(new URL('../scripts/run-cursor-skill-eval.mjs', import.meta.url));
const execute = promisify(execFile);
const transcript = [
  { direction: 'request', tool: 'cursor_delegate', call_id: 1, request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
  { direction: 'request', tool: 'cursor_wait', call_id: 2, request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
  { direction: 'request', tool: 'cursor_close_session', call_id: 3, request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
];
const toolSequence = ['tool_search', 'cursor_delegate', 'tool_search', 'cursor_wait', 'tool_search', 'cursor_close_session', 'final'];
const requestTrace = toolSequence.map((tool, index) => ({ step: index + 1, tool, call_id: tool === 'final' ? null : `call_${index + 2}` }));
const childResult = (actual = 'succeeded', reported = 'succeeded', status = 'pass') => ({
  skill: { sha256: 'a'.repeat(64), bytes: 123 }, transcript,
  provider_oracle: { request_count: 8, skill_context_seen: true, terminal_result_matched: true, tool_sequence: toolSequence, request_trace: requestTrace },
  fixture_oracle: { actual_task_outcome: actual, reported_task_outcome: reported, assertion_outcome: status === 'pass' ? 'pass' : 'fail' }, eval_status: status,
});
const passHarness = async () => ({ code: 0, signal: null, failure: null, childResult: childResult(), semantic: null, diagnostics: '' });
const published = async ({ makeEvidence }) => { makeEvidence('/tmp/evidence.json'); return '/tmp/evidence.json'; };
const removed = async () => {};
const encodedChildResult = (scenarioId, overrides = {}) => JSON.stringify({ schema_version: 1, scenario_id: scenarioId, ...childResult(), ...overrides });

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
  const { stdout, stderr } = await execute(process.execPath, [run, 'unknown'], { env: process.env });
  assert.equal(stderr, '');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code }, { status: 'integration_failure', stage: 'runner', code: 'unknown_scenario' });
});

test('runner selects each lane and propagates the scenario environment expected by its harness', async () => {
  const cases = [
    ['client-happy', { CURSOR_EVAL_REAL_CODEX: '1' }, 'client-integration', 'credential-free client-happy', { CURSOR_EVAL_REAL_CODEX: '1' }],
    ['model-plan', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_FAKE_ACP_PENDING: 'plan' }],
    ['model-permission-covered', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_FAKE_ACP_PENDING: 'permission', CURSOR_EVAL_MODEL_SCENARIO: 'permission-covered' }],
    ['live-marker', { CURSOR_SUBAGENT_LIVE_E2E: '1' }, 'full-live', 'live release canary', { CURSOR_SUBAGENT_LIVE_E2E: '1' }],
  ];
  for (const [scenarioId, env, lane, pattern, expectedEnv] of cases) {
    let observed;
    const result = await runEval({ scenarioId, env }, { mkdtemp: async () => '/tmp/fixture', rm: removed, publishEvidence: published,
      runHarness: async (config, harnessEnv) => { observed = { pattern: config.pattern, env: harnessEnv }; return passHarness(); } });
    assert.equal(assertEvalResultV1(result).eval_status, 'pass'); assert.equal(result.lane, lane); assert.equal(observed.pattern, pattern);
    for (const [name, value] of Object.entries(expectedEnv)) assert.equal(observed.env[name], value);
  }
});

test('cleanup failure overrides a behavior mismatch after evidence publication', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    mkdtemp: async () => '/tmp/fixture', publishEvidence: published,
    runHarness: async () => ({ code: 1, signal: null, failure: 'scenario_contract_mismatch', childResult: childResult('succeeded', 'failed', 'agent_behavior_mismatch'), semantic: null, diagnostics: '' }),
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
    mkdtemp: async () => '/tmp/fixture', runHarness: passHarness,
    publishEvidence: async () => { throw new Error('disk full'); },
    rm: async () => { cleanupCalled = true; },
  });
  assert.equal(cleanupCalled, true); assert.deepEqual({ status: result.eval_status, publication: result.evidence_publication_status, ref: result.evidence_ref, cleanup: result.cleanup_status, stage: result.failure_stage, code: result.error_code },
    { status: 'integration_failure', publication: 'failed', ref: null, cleanup: 'succeeded', stage: 'publication', code: 'evidence_publication_failed' });
  assertEvalResultV1(result);
});

test('runner and fixture setup catches always return valid stage-specific EvalResultV1 objects', async () => {
  const setup = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, { mkdtemp: async () => { throw new Error('no temp'); } });
  assert.deepEqual({ status: setup.eval_status, stage: setup.failure_stage, code: setup.error_code, cleanup: setup.cleanup_status }, { status: 'integration_failure', stage: 'runner', code: 'fixture_setup_failed', cleanup: 'not_required' });
  assertEvalResultV1(setup);
  const harness = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    mkdtemp: async () => '/tmp/fixture', runHarness: async () => { throw Object.assign(new Error('spawn failed'), { evalCode: 'harness_spawn_failure' }); }, rm: removed,
  });
  assert.deepEqual({ status: harness.eval_status, stage: harness.failure_stage, code: harness.error_code, assertion: harness.fixture_assertion_outcome, cleanup: harness.cleanup_status },
    { status: 'integration_failure', stage: 'runner', code: 'harness_spawn_failure', assertion: 'not_observed', cleanup: 'succeeded' });
  assertEvalResultV1(harness);
});

test('published evidence is emitted after cleanup with correlated child proof and the final EvalResultV1', async () => {
  const order = []; let evidence;
  const result = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    mkdtemp: async () => '/tmp/fixture', runHarness: passHarness,
    rm: async () => { order.push('cleanup'); },
    publishEvidence: async ({ makeEvidence }) => { order.push('publication'); evidence = makeEvidence('/tmp/final-evidence.json'); return '/tmp/final-evidence.json'; },
  });
  assert.deepEqual(order, ['cleanup', 'publication']); assert.equal(result.eval_status, 'pass');
  assert.deepEqual(evidence.skill, { sha256: 'a'.repeat(64), bytes: 123 });
  assert.deepEqual(evidence.transcript, transcript); assert.deepEqual(evidence.provider_oracle, childResult().provider_oracle);
  assert.deepEqual(evidence.fixture_oracle, childResult().fixture_oracle); assert.deepEqual(evidence.final_result, result);
  assert.equal(Buffer.byteLength(JSON.stringify(evidence), 'utf8') < 1_048_576, true);
});

test('semantic failure outcomes are classified independently of successful TAP exit', async () => {
  const result = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    mkdtemp: async () => '/tmp/fixture', rm: removed, publishEvidence: published,
    runHarness: async () => ({ code: 0, signal: null, failure: null, childResult: childResult('failed', 'failed'), semantic: null, diagnostics: '' }),
  });
  assert.deepEqual({ status: result.eval_status, actual: result.actual_task_outcome, reported: result.reported_task_outcome, assertion: result.fixture_assertion_outcome },
    { status: 'pass', actual: 'failed', reported: 'failed', assertion: 'pass' });

  const dishonest = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    mkdtemp: async () => '/tmp/fixture', rm: removed, publishEvidence: published,
    runHarness: async () => ({ code: 0, signal: null, failure: null, childResult: childResult('failed', 'succeeded', 'agent_behavior_mismatch'), semantic: null, diagnostics: '' }),
  });
  assert.deepEqual({ status: dishonest.eval_status, actual: dishonest.actual_task_outcome, reported: dishonest.reported_task_outcome },
    { status: 'agent_behavior_mismatch', actual: 'failed', reported: 'succeeded' });
});

test('cleanup failure remains the primary stage when failure-artifact publication also fails', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    mkdtemp: async () => '/tmp/fixture', runHarness: passHarness,
    rm: async () => { throw new Error('cleanup broke'); }, publishEvidence: async () => { throw new Error('publication broke'); },
  });
  assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code, publication: result.evidence_publication_status, cleanup: result.cleanup_status },
    { status: 'integration_failure', stage: 'cleanup', code: 'cleanup_failed', publication: 'failed', cleanup: 'failed' });
  assertEvalResultV1(result);
});

test('child-result parser normalizes valid correlated evidence', () => {
  const parsed = parseChildResult(encodedChildResult('model-question'), 'model-question');
  assert.deepEqual(parsed, childResult());
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
    { ...valid, skill: { ...valid.skill, sha256: 'not-a-sha' } },
    { ...valid, skill: { ...valid.skill, bytes: 0 } },
    { ...valid, transcript: [] },
    { ...valid, provider_oracle: null },
    { ...valid, provider_oracle: [] },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_count: 0 } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, skill_context_seen: false } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, terminal_result_matched: 'yes' } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, tool_sequence: null } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, tool_sequence: [] } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, tool_sequence: Array(17).fill('tool_search'), request_trace: Array(17).fill(null) } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, tool_sequence: [...toolSequence.slice(0, -1), 'x'.repeat(129)] } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: null } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: requestTrace.slice(0, -1) } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: requestTrace.map((entry, index) => index === 0 ? { ...entry, extra: true } : entry) } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: requestTrace.map((entry, index) => index === 0 ? { ...entry, step: 2 } : entry) } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: requestTrace.map((entry, index) => index === 0 ? { ...entry, tool: 'cursor_wait' } : entry) } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: requestTrace.map((entry, index) => index === 0 ? { ...entry, call_id: '' } : entry) } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: requestTrace.map((entry, index) => index === 0 ? { ...entry, call_id: 'x'.repeat(129) } : entry) } },
    { ...valid, provider_oracle: { ...valid.provider_oracle, request_trace: requestTrace.map((entry, index) => index === requestTrace.length - 1 ? { ...entry, call_id: 'call_final' } : entry) } },
    { ...valid, fixture_oracle: null },
    { ...valid, fixture_oracle: { ...valid.fixture_oracle, actual_task_outcome: 'unknown' } },
    { ...valid, fixture_oracle: { ...valid.fixture_oracle, reported_task_outcome: 'unknown' } },
    { ...valid, fixture_oracle: { ...valid.fixture_oracle, assertion_outcome: 'unknown' } },
    { ...valid, eval_status: 'skipped' },
  ];
  for (const value of invalidResults) {
    assert.throws(() => parseChildResult(JSON.stringify(value), 'model-question'), (error) => error.evalCode === 'child_result_invalid');
  }
});

test('client-happy child evidence rejects any deviation from the exact deferred route', () => {
  const valid = JSON.parse(encodedChildResult('client-happy'));
  const wrongSequence = [...toolSequence]; wrongSequence[2] = 'cursor_wait';
  const duplicateCallIds = requestTrace.map((entry, index) => index === 1 ? { ...entry, call_id: requestTrace[0].call_id } : entry);
  for (const providerOracle of [
    { ...valid.provider_oracle, request_count: 7 },
    { ...valid.provider_oracle, tool_sequence: wrongSequence, request_trace: requestTrace.map((entry, index) => ({ ...entry, tool: wrongSequence[index] })) },
    { ...valid.provider_oracle, request_trace: duplicateCallIds },
  ]) {
    assert.throws(() => parseChildResult(JSON.stringify({ ...valid, provider_oracle: providerOracle }), 'client-happy'), (error) => error.evalCode === 'child_result_invalid');
  }
});

test('published evidence retains the normalized bounded provider route trace', async () => {
  let evidence;
  const result = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    mkdtemp: async () => '/tmp/fixture', runHarness: passHarness, rm: removed,
    publishEvidence: async ({ makeEvidence }) => { evidence = makeEvidence('/tmp/provider-route.json'); return '/tmp/provider-route.json'; },
  });
  assert.equal(result.eval_status, 'pass');
  assert.deepEqual(evidence.provider_oracle.tool_sequence, toolSequence);
  assert.deepEqual(evidence.provider_oracle.request_trace, requestTrace);
});

test('transcript correlation accepts an answer only for a previously observed pending request', () => {
  const correlated = [
    transcript[0],
    { direction: 'request', tool: 'cursor_wait', call_id: 'wait', request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', active_turn: { pending: [{ request_id: 'Q' }] } } },
    { direction: 'request', tool: 'cursor_answer_question', call_id: 'answer', request: { session_id: 'S', turn_id: 'T', request_id: 'Q' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
    transcript[2],
  ];
  assert.equal(transcriptIsCorrelated(correlated), true);
});

test('transcript correlation rejects malformed lifecycle shape and mismatched opaque IDs', () => {
  const variants = [
    null,
    transcript.slice(0, 2),
    [{ ...transcript[0], tool: 'cursor_wait' }, transcript[1], transcript[2]],
    [transcript[0], transcript[1], { ...transcript[2], tool: 'cursor_wait' }],
    [{ ...transcript[0], direction: 'response' }, transcript[1], transcript[2]],
    [{ ...transcript[0], call_id: null }, transcript[1], transcript[2]],
    [{ ...transcript[0], response: { ...transcript[0].response, ok: false } }, transcript[1], transcript[2]],
    [{ ...transcript[0], response: { ok: true, session_id: '', turn_id: 'T' } }, transcript[1], transcript[2]],
    [transcript[0], { ...transcript[1], request: { session_id: 'other', turn_id: 'T' } }, transcript[2]],
    [transcript[0], { ...transcript[1], request: { session_id: 'S', turn_id: 'other' } }, transcript[2]],
    [transcript[0], { ...transcript[1], response: { ok: true, session_id: 'other', turn_id: 'T' } }, transcript[2]],
    [transcript[0], { ...transcript[1], response: { ok: true, session_id: 'S', turn_id: 'other' } }, transcript[2]],
    [transcript[0], { direction: 'request', tool: 'cursor_answer_plan', call_id: 2, request: { session_id: 'S', turn_id: 'T', request_id: 'missing' }, response: { ok: true, session_id: 'S', turn_id: 'T' } }, transcript[2]],
    [transcript[0], transcript[1], { ...transcript[2], request: { session_id: 'other' } }],
  ];
  for (const variant of variants) assert.equal(transcriptIsCorrelated(variant), false);
});

test('harness returns validated child evidence and bounded diagnostics after a successful child exit', async () => {
  const child = makeHarnessChild({ stderr: `${'d'.repeat(9_000)}ignored` });
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    spawn: () => child,
    readFile: async () => encodedChildResult('client-happy'),
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult, childResult());
  assert.equal(Buffer.byteLength(result.diagnostics, 'utf8') <= 8_000, true);
});

test('harness maps a semantic marker to scenario-contract mismatch with parsed outcomes', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-semantic-failure' }, {
    spawn: () => makeHarnessChild({ stdout: 'semantic_failure actual=failed reported=succeeded', code: 1 }),
    readFile: async () => encodedChildResult('model-semantic-failure'),
  });
  assert.deepEqual({ failure: result.failure, semantic: result.semantic }, { failure: 'scenario_contract_mismatch', semantic: { actual: 'failed', reported: 'succeeded' } });
});

test('harness distinguishes generic child failure from a scenario-contract mismatch', async () => {
  const generic = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    spawn: () => makeHarnessChild({ code: 1 }), readFile: async () => encodedChildResult('client-happy'),
  });
  const mismatch = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    spawn: () => makeHarnessChild({ stdout: 'hosted MCP transcript missing', code: 1 }), readFile: async () => encodedChildResult('client-happy'),
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
});

test('CLI converts an unhandled evaluation rejection to EvalResultV1', async () => {
  const processLike = new EventEmitter();
  const written = [];
  await cli({ argv: ['node', 'runner', 'live-marker'], processLike, evaluate: async () => { throw new Error('unexpected'); }, write: (value) => written.push(value) });
  assert.deepEqual({ count: written.length, lane: written[0].lane, code: written[0].error_code }, { count: 1, lane: 'full-live', code: 'unhandled_runner_failure' });
  assertEvalResultV1(written[0]);
});
