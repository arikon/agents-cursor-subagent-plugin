import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertEvalResultV1, assertEvidenceManifestV1, classifyEval, classifyScenario, evalResult, publishEvidence, readEvaluatorInventory, writeEvalResult } from '../scripts/cursor-skill-eval.mjs';
import { evaluateScenario, findRecoveredCalls, parseScenarioCorpus, validRecoveryContext } from '../scripts/cursor-eval-scenario.mjs';
import { canonicalJson } from '../scripts/cursor-subagent-bootstrap.mjs';

const recorder = fileURLToPath(new URL('../scripts/recording-mcp-proxy.mjs', import.meta.url));

function lookupRecoveryEvidence(tool = 'cursor_close_session', field = 'session_id') {
  const request = { session_id: 'S', ...(field === 'turn_id' ? { turn_id: 'T' } : {}),
    arguments_without_session_turn_sha256: 'a'.repeat(64) };
  return { calls: [
    { tool: 'cursor_delegate', response: { ok: true, session_id: 'S', turn_id: 'T' } },
    { tool, request: { ...request, [field]: 'typo' }, response: { ok: false,
      error_code: field === 'session_id' ? 'unknown_session' : 'unknown_turn' } },
    { tool, request, response: { ok: true, session_id: 'S', ...(field === 'turn_id' ? { turn_id: 'T' } : {}) } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 3 }], unexpected_input_requests: 0 };
}

test('recovery proof admits grounded address correction without losing its rejected call', () => {
  for (const [tool, field] of [['cursor_close_session', 'session_id'], ['cursor_cancel', 'turn_id'],
    ['cursor_send_prompt', 'session_id']]) {
    const transcript = lookupRecoveryEvidence(tool, field);
    const original = structuredClone(transcript);
    assert.deepEqual(findRecoveredCalls(transcript, 1), [{ failed_call_index: 2, successful_call_index: 3,
      codex_turn_index: 1, tool, error_code: field === 'session_id' ? 'unknown_session' : 'unknown_turn',
      correction_kind: 'address' }]);
    assert.deepEqual(transcript, original);
  }
  const afterResume = lookupRecoveryEvidence();
  afterResume.calls.unshift({ tool: 'cursor_delegate', response: { ok: true, session_id: 'OLD', turn_id: 'OLD-T' } });
  afterResume.calls[1] = { tool: 'cursor_resume_session', response: { ok: true, session_id: 'S' } };
  afterResume.turn_call_ranges[0].end = 4;
  assert.equal(findRecoveredCalls(afterResume, 1)[0].failed_call_index, 3);
  afterResume.calls[3].request.session_id = 'OLD';
  assert.deepEqual(findRecoveredCalls(afterResume, 1), []);
});

test('recovery proof fails closed for ambiguous rejection, changed intent, missing evidence or another user turn', () => {
  const cases = [
    ['missing transcript', () => null],
    ['missing ranges', (t) => { delete t.turn_call_ranges; }],
    ['partial ranges', (t) => { t.turn_call_ranges[0].end = 2; }],
    ['malformed ranges', (t) => { t.turn_call_ranges[0].start = 1; }],
    ['extra range field', (t) => { t.turn_call_ranges[0].extra = true; }],
    ['negative input count', (t) => { t.unexpected_input_requests = -1; }],
    ['extra user input', (t) => { t.unexpected_input_requests = 1; }],
    ['lost calls', (t) => { t.dropped_calls = 1; }],
    ['missing response', (t) => { delete t.calls[1].response; }],
    ['successful wrong call', (t) => { t.calls[1].response.ok = true; }],
    ['failed correction', (t) => { t.calls[2].response.ok = false; }],
    ['ambiguous success', (t) => { t.calls[2].response.error_code = 'protocol_error'; }],
    ['provider failure', (t) => { t.calls[1].response.provider_error = { code: 1 }; }],
    ['scope rejection', (t) => { t.calls[1].response.error_code = 'scope_rejected'; }],
    ['protocol failure', (t) => { t.calls[1].response.error_code = 'protocol_error'; }],
    ['different tool', (t) => { t.calls[2].tool = 'cursor_cancel'; }],
    ['launch fallback', (t) => { t.calls[1].tool = t.calls[2].tool = 'cursor_delegate'; }],
    ['invalid turn lookup tool', (t) => { t.calls[1].response.error_code = 'unknown_turn'; }],
    ['missing digest', (t) => { delete t.calls[1].request.arguments_without_session_turn_sha256; }],
    ['malformed digest', (t) => { t.calls[1].request.arguments_without_session_turn_sha256 = 'invalid'; }],
    ['changed non-ID arguments', (t) => { t.calls[2].request.arguments_without_session_turn_sha256 = 'b'.repeat(64); }],
    ['unknown target', (t) => { t.calls[2].request.session_id = 'UNKNOWN'; }],
    ['unchanged ID', (t) => { t.calls[1].request.session_id = 'S'; }],
    ['no causal allocation', (t) => { t.calls[0].response.ok = false; }],
    ['intervening call', (t) => { t.calls.splice(2, 0, { tool: 'cursor_session_status' }); t.turn_call_ranges[0].end = 4; }],
  ];
  for (const [label, mutate] of cases) {
    const transcript = lookupRecoveryEvidence(); const result = mutate(transcript);
    assert.deepEqual(findRecoveredCalls(result === null ? null : transcript, 1), [], label);
  }
  const anotherTurn = lookupRecoveryEvidence();
  anotherTurn.turn_call_ranges = [{ start: 0, end: 2 }, { start: 2, end: 3 }];
  assert.equal(validRecoveryContext(anotherTurn, 2), true);
  assert.deepEqual(findRecoveredCalls(anotherTurn, 2), []);
  const wrongTurn = lookupRecoveryEvidence('cursor_cancel', 'turn_id');
  wrongTurn.calls[1].request.session_id = wrongTurn.calls[2].request.session_id = 'OLD';
  assert.deepEqual(findRecoveredCalls(wrongTurn, 1), []);
});

test('recovery oracle audits raw lookup errors even when normalized trace looks successful', () => {
  const expectedTrace = [{ kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
    { kind: 'turn.completed', step_id: 'done' }, { kind: 'session.close-attempted' }];
  const scenario = { scenario_kind: 'programmed', followups: [], report_checks: [],
    program: { steps: [{ type: 'terminal', step_id: 'done' }] }, expected_trace: expectedTrace,
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass' };
  const observation = { trace: expectedTrace.map((entry) => ({ ...entry, session_id: 'S',
    ...(!entry.kind.startsWith('session.') ? { turn_id: 'T' } : {}) })),
    actual_task_outcome: 'succeeded', captured_finals: [{ turn_index: 1, completeness: 'complete', text: 'Done.' }] };
  const transcript = lookupRecoveryEvidence();
  const recovered = evaluateScenario(scenario, { ...observation, transcript });
  assert.equal(recovered.eval_status, 'pass', JSON.stringify(recovered));
  assert.deepEqual(recovered.recovered_calls, findRecoveredCalls(transcript, 1));
  const legacy = evaluateScenario(scenario, { ...observation,
    transcript: { calls: transcript.calls, dropped_calls: 0 } });
  assert.deepEqual(legacy.mismatches, ['unrecovered-call']);
  assert.equal(legacy.eval_status, 'agent_behavior_mismatch');
  assert.deepEqual(legacy.recovered_calls, []);
  const unprovedValidationRepair = structuredClone(transcript);
  unprovedValidationRepair.calls[1].response.error_code = 'invalid_args';
  unprovedValidationRepair.calls[2].request.arguments_without_session_turn_sha256 = 'b'.repeat(64);
  assert.ok(evaluateScenario(scenario, { ...observation, transcript: unprovedValidationRepair })
    .mismatches.includes('unrecovered-call'));
  const waitRepair = lookupRecoveryEvidence('cursor_wait', 'turn_id');
  const independentRepairs = structuredClone(transcript);
  independentRepairs.calls.splice(1, 0, ...waitRepair.calls.slice(1));
  independentRepairs.turn_call_ranges[0].end = independentRepairs.calls.length;
  const twoOperations = evaluateScenario(scenario, { ...observation, transcript: independentRepairs });
  assert.equal(twoOperations.eval_status, 'pass');
  assert.equal(twoOperations.recovered_calls.length, 2);
  independentRepairs.turn_call_ranges = [{ start: 0, end: 3 }, { start: 3, end: 5 }];
  assert.deepEqual(findRecoveredCalls(independentRepairs, 2).map(({ codex_turn_index }) => codex_turn_index), [1, 2]);
  const secondGuess = structuredClone(transcript);
  secondGuess.calls.splice(1, 0, structuredClone(secondGuess.calls[1]));
  secondGuess.turn_call_ranges[0].end += 1;
  assert.ok(evaluateScenario(scenario, { ...observation, transcript: secondGuess }).mismatches.includes('unrecovered-call'));
});

test('recovery variation table distinguishes grounded repairs from changed intent and missing proof', () => {
  const request = (args) => ({ ...args, arguments_without_session_turn_sha256: createHash('sha256')
    .update(canonicalJson(Object.fromEntries(Object.entries(args)
      .filter(([key]) => !['session_id', 'turn_id'].includes(key))))).digest('hex') });
  const evidence = (tool, before, after, error = 'invalid_args', interleave = []) => ({
    calls: [
      { tool: 'cursor_delegate', response: { ok: true, session_id: 'S', turn_id: 'T', last_event_id: 2, progress_revision: 1 } },
      { tool, request: request(before), response: { ok: false, error_code: error } },
      ...interleave,
      { tool, request: request(after), response: { ok: true, session_id: 'S', turn_id: 'T' } },
    ], dropped_calls: 0, unexpected_input_requests: 0, turn_call_ranges: [{ start: 0, end: 3 + interleave.length }],
  });
  const wait = { session_id: 'S', turn_id: 'T', after_event_id: 2 };
  const status = { tool: 'cursor_session_status', request: request({ session_id: 'S' }),
    response: { ok: true, session_id: 'S', session_state: 'live' } };
  // Verdicts are specified before replay; no inference from a hosted pass/fail.
  const variations = [
    ['empty wait address and published cursor', true, evidence('cursor_wait', {}, wait)],
    ['missing session ID', true, evidence('cursor_wait', { turn_id: 'T' }, { session_id: 'S', turn_id: 'T' })],
    ['missing turn ID', true, evidence('cursor_wait', { session_id: 'S' }, { session_id: 'S', turn_id: 'T' })],
    ['wrong ID', true, evidence('cursor_wait', { ...wait, turn_id: 'typo' }, wait, 'unknown_turn')],
    ['both wrong IDs', true, evidence('cursor_wait', { ...wait, session_id: 'typo', turn_id: 'typo' }, wait, 'unknown_session')],
    ['malformed address encoding', true, evidence('cursor_wait', { ...wait, session_id: '\ud800' }, wait, 'invalid_text_encoding')],
    ['diagnostic between rejection and repair', true, evidence('cursor_wait', {}, wait, 'invalid_args', [status])],
    ['cursor learned from intervening status', true, evidence('cursor_wait', {}, { ...wait, after_event_id: 3 }, 'invalid_args', [
      { ...status, response: { ...status.response, last_event_id: 3 } }])],
    ['repeated read-only diagnostics', true, evidence('cursor_wait', {}, wait, 'invalid_args', [status, status])],
    ['bad event cursor', true, evidence('cursor_wait', { ...wait, after_event_id: -1 }, wait)],
    ['both bad cursors', true, evidence('cursor_wait', { ...wait, after_event_id: -1, after_progress_revision: -1 },
      { ...wait, after_progress_revision: 1 })],
    ['wrong address and bad cursor together', true, evidence('cursor_wait', { session_id: 'typo', turn_id: 'typo', after_event_id: -1 },
      wait, 'unknown_session')],
    ['missing mode', true, evidence('cursor_set_mode', { session_id: 'S' }, { session_id: 'S', mode: 'plan' })],
    ['malformed mode', true, evidence('cursor_set_mode', { session_id: 'S', mode: 'plna' }, { session_id: 'S', mode: 'plan' })],
    ['changed valid mode intent', false, evidence('cursor_set_mode', { session_id: 'S', mode: 'ask' }, { session_id: 'S', mode: 'plan' })],
    ['mode provider failure', false, evidence('cursor_set_mode', { session_id: 'S', mode: 'plna' }, { session_id: 'S', mode: 'plan' }, 'protocol_error')],
    ['changed timeout', false, evidence('cursor_wait', { ...wait, timeout_ms: 0 }, { ...wait, timeout_ms: 1000 })],
    ['invented event cursor', false, evidence('cursor_wait', {}, { ...wait, after_event_id: 3 })],
    ['unknown extra argument', false, evidence('cursor_wait', { extra: true }, wait)],
    ['uncaptured malformed cursor', false, evidence('cursor_wait', { after_event_id: 'bad' }, wait)],
    ['changed read offset', false, evidence('cursor_read_result', { ...wait, offset: -1 }, { ...wait, offset: 0 })],
    ['changed answer choice', false, evidence('cursor_answer_plan', { ...wait, request_id: 'P', decision: 'bad' },
      { ...wait, request_id: 'P', decision: 'accept' })],
    ['launch repair', false, evidence('cursor_delegate', {}, { mode: 'plan' })],
    ['effectful interleave', false, evidence('cursor_wait', {}, wait, 'invalid_args', [
      { tool: 'cursor_send_prompt', request: request({ session_id: 'S', prompt: 'another operation' }), response: { ok: true } }])],
    ['wrong-session diagnostic', false, evidence('cursor_wait', {}, wait, 'invalid_args', [
      { ...status, request: request({ session_id: 'OTHER' }) }])],
    ['failed diagnostic', false, evidence('cursor_wait', {}, wait, 'invalid_args', [
      { ...status, response: { ok: false, error_code: 'unknown_session' } }])],
  ];
  // The recorder deliberately drops malformed scalar fields, but hashes raw args.
  delete variations.find(([label]) => label === 'uncaptured malformed cursor')[2].calls[1].request.after_event_id;
  for (const [label, expected, transcript] of variations) {
    const original = structuredClone(transcript);
    const recovered = findRecoveredCalls(transcript, 1);
    assert.equal(recovered.some(({ failed_call_index }) => failed_call_index === 2), expected, label);
    assert.deepEqual(transcript, original, `${label}: original evidence preserved`);
  }
});

test('candidate inventory detects oracle drift independently of skill and excludes host roots', async () => {
  const load = async (path) => Buffer.from(path.endsWith('/cursor-eval-scenario.mjs') ? 'oracle-v1' : 'unchanged');
  const first = await readEvaluatorInventory('/first-checkout', load);
  assert.deepEqual(await readEvaluatorInventory('/another-checkout', load), first);
  const changed = await readEvaluatorInventory('/first-checkout', async (path) =>
    path.endsWith('/cursor-eval-scenario.mjs') ? Buffer.from('oracle-v2') : load(path));
  assert.notDeepEqual(changed.digest, first.digest);
  assert.deepEqual(changed.files.find(({ path }) => path.endsWith('/SKILL.md')),
    first.files.find(({ path }) => path.endsWith('/SKILL.md')));
  const alternate = await readEvaluatorInventory('/first-checkout', load, 'tests/fixtures/alternate-runner.mjs');
  assert.notDeepEqual(alternate.digest, first.digest);
  assert.equal(alternate.selected_runner, 'tests/fixtures/alternate-runner.mjs');
  assert.ok(alternate.files.some(({ path }) => path === alternate.selected_runner));
  await assert.rejects(readEvaluatorInventory('/first-checkout', load, '../external.mjs'), /repository-relative/);
  await assert.rejects(readEvaluatorInventory('/missing-checkout', async () => { throw new Error('missing input'); }), /missing input/);
});

test('recording MCP proxy rejects an omitted target before opening a child transport', async () => {
  const child = spawn(process.execPath, [recorder], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(stderr).toString('utf8'), /MCP proxy target is required/);
});

test('EvalResultV1 enforces its exact bounded public contract', () => {
  const result = evalResult({ scenario_id: 'client-happy', lane: 'client-integration', eval_status: 'pass', actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked', fixture_assertion_outcome: 'pass', evidence_publication_status: 'published', evidence_ref: '/evidence/run.json', cleanup_status: 'succeeded', failure_stage: null });
  assert.equal(result.schema_version, 1);
  assert.throws(() => assertEvalResultV1({ ...result, extra: true }), /unexpected properties/);
  assert.throws(() => evalResult({ ...result, evidence_publication_status: 'failed' }), /evidence_ref/);
  assert.throws(() => evalResult({ ...result, lane: 'unknown' }), /invalid enum/);
  assert.throws(() => evalResult({ ...result, cleanup_status: 'failed' }), /passing EvalResultV1/);
  assert.throws(() => evalResult({ ...result, eval_status: 'integration_failure' }), /failure_stage/);
  assert.throws(() => evalResult({ ...result, eval_status: 'skipped' }), /skipped EvalResultV1 must be pre-run/);
  assert.throws(() => evalResult({ ...result, scenario_id: 'x'.repeat(129) }), /scenario_id/);
  assert.throws(() => evalResult({ ...result, scenario_id: '\ud800' }), /scenario_id/);
  assert.throws(() => assertEvalResultV1(null), /unexpected properties/);
  assert.throws(() => assertEvalResultV1([]), /unexpected properties/);
});

test('EvidenceManifestV1 accepts one complete closed proof and rejects drifted shapes and digests', () => {
  const digest = (character, length = 123) => ({ sha256: character.repeat(64), bytes: length });
  const manifest = {
    schema_version: 1,
    hash_algorithm: 'sha256',
    hash_encoding: 'lowercase-hex',
    installed_skill: digest('a'),
    corpus: digest('b'),
    materialized_scenario: digest('c'),
    adapter: digest('d'),
    evaluator: digest('e'),
    installed_payload: { marker_format: 1, payload_hash: 'f'.repeat(64), artifact_hash: '0'.repeat(64), manifest_version: '0.1.0' },
    client: { name: 'codex-app-server', version: '0.152.1' },
    model: { provider: null, name: null },
  };
  assert.equal(assertEvidenceManifestV1(manifest), manifest);
  assert.throws(() => assertEvidenceManifestV1({ ...manifest, extra: true }), /invalid contract/);
  assert.throws(() => assertEvidenceManifestV1({ ...manifest, evaluator: { sha256: 'not-a-digest', bytes: 1 } }), /invalid contract/);

  for (const candidate of [
    { ...manifest, installed_skill: { ...manifest.installed_skill, extra: true } },
    { ...manifest, installed_payload: { ...manifest.installed_payload, extra: true } },
    { ...manifest, client: { ...manifest.client, extra: true } },
    { ...manifest, model: { ...manifest.model, extra: true } },
    { ...manifest, corpus: digest('b', 0) },
    { ...manifest, adapter: digest('d', 1_048_577) },
    { ...manifest, installed_payload: { ...manifest.installed_payload, manifest_version: '\ud800' } },
    { ...manifest, client: { ...manifest.client, name: '' } },
    { ...manifest, model: { ...manifest.model, provider: '' } },
  ]) assert.throws(() => assertEvidenceManifestV1(candidate), /invalid contract/);
});

test('eval classifier preserves skipped, mismatch, and pass outcomes', () => {
  assert.equal(classifyEval({ enabled: false, integrationFailure: 'cleanup', behaviorMatches: true }), 'skipped');
  assert.equal(classifyEval({ enabled: true, behaviorMatches: false }), 'agent_behavior_mismatch');
  assert.equal(classifyEval({ enabled: true, behaviorMatches: true }), 'pass');
});

test('cleanup, evidence publication, and runner collisions dominate behavior verdicts', () => {
  for (const failure of ['cleanup', 'publication', 'runner_spawn', 'runner_timeout', 'runner_output_limit', 'runner_hung_close']) {
    assert.equal(classifyEval({ enabled: true, integrationFailure: failure, behaviorMatches: false }), 'integration_failure', failure);
  }
});

test('EvalResultV1 is the sole bounded stdout artifact', () => {
  const output = { value: '', write(chunk) { this.value += chunk; } };
  const result = evalResult({ scenario_id: 'client-happy', lane: 'client-integration', eval_status: 'integration_failure', actual_task_outcome: 'not_observed', reported_task_outcome: 'not_checked', fixture_assertion_outcome: 'not_observed', evidence_publication_status: 'not_attempted', cleanup_status: 'succeeded', failure_stage: 'transport', error_code: 'unsupported_mcp_tool' });
  writeEvalResult(result, output);
  assert.equal(output.value.split('\n').filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(output.value), result);
  const before = output.value;
  assert.throws(() => writeEvalResult({ ...result, message: '\u0000'.repeat(8_000),
    evidence_publication_status: 'published', evidence_ref: '/'.repeat(4_096) }, output), /serialized stdout limit/);
  assert.equal(output.value, before, 'invalid oversized result must not partially reach stdout');
});

test('scenario classification depends on observed task outcome rather than reported prose semantics', () => {
  const expected = { enabled: true, expectedActual: 'failed', actual: 'failed', expectedReported: 'failed', reported: 'succeeded' };
  assert.equal(classifyScenario(expected), 'pass');
  assert.equal(classifyScenario({ ...expected, actual: 'succeeded' }), 'agent_behavior_mismatch');
});

test('scenario wait observations reject obsolete cursor equality fields', async () => {
  const source = JSON.parse(await readFile(fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url))));
  assert.doesNotThrow(() => parseScenarioCorpus(JSON.stringify(source)));
  for (const kind of ['turn.wait-timeout', 'turn.wait-recovered', 'turn.events-lost']) {
    const corpus = structuredClone(source);
    const scenario = corpus.scenarios.find((entry) => entry.expected_trace.some((observation) => observation.kind === kind));
    scenario.expected_trace.find((observation) => observation.kind === kind).cursor_matched = true;
    assert.throws(() => parseScenarioCorpus(JSON.stringify(corpus)), /invalid shape/, kind);
  }
});

test('captured free prose remains evidence while its reported semantics stay unchecked', async () => {
  const corpus = parseScenarioCorpus(await readFile(fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url))));
  const scenario = corpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-result-overflow');
  const trace = scenario.expected_trace.map((entry) => ({
    ...entry,
    session_id: 'session-1',
    ...(!entry.kind.startsWith('session.') ? { turn_id: 'turn-1' } : {}),
  }));
  const result = evaluateScenario(scenario, {
    trace, callbacks: [], effects: [], actual_task_outcome: 'failed',
    captured_finals: [{ turn_index: 1, completeness: 'complete',
      text: 'Arbitrary complete user-visible prose is retained as evidence.' }],
  });
  assert.deepEqual({ reported: result.reported_task_outcome, outcome: result.components.outcome_report,
    interaction: result.components.interaction_report, safety: result.components.safety_disclosure,
    status: result.eval_status, mismatches: result.mismatches, checks: result.report_checks }, {
    reported: 'not_checked', outcome: 'not_checked', interaction: 'pass', safety: 'not_checked',
    status: 'pass', mismatches: [], checks: [],
  });
  for (const capturedFinal of [
    { turn_index: 1, completeness: 'complete', text: '   ' },
    { turn_index: 1, completeness: 'confirmed_missing', text: null },
  ]) {
    const missing = evaluateScenario(scenario, {
      trace, callbacks: [], effects: [], actual_task_outcome: 'failed', captured_finals: [capturedFinal],
    });
    assert.equal(missing.components.interaction_report, 'fail');
    assert.deepEqual(missing.mismatches, ['interaction-report-mismatch']);
  }
});

test('question delivery requires its visible option label rather than the internal option ID', async () => {
  const corpus = parseScenarioCorpus(await readFile(fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url))));
  const scenario = corpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-question');
  const trace = scenario.expected_trace.map((entry) => ({
    ...entry,
    session_id: 'session-1',
    ...(!entry.kind.startsWith('session.') ? { turn_id: 'turn-1' } : {}),
    ...(entry.kind.startsWith('pending.') || entry.kind.startsWith('answer.') ? { request_id: 'q-1' } : {}),
  }));
  const callbacks = [{ step_id: 'question-1', callback_id: 'q-1', kind: 'answer', option_ids: ['choice-1'] }];
  const evaluate = (firstTurn) => evaluateScenario(scenario, {
    trace, callbacks, effects: [], actual_task_outcome: 'succeeded',
    captured_finals: [
      { turn_index: 1, completeness: 'complete', text: firstTurn },
      { turn_index: 2, completeness: 'complete', text: 'CURSOR_EVAL_OK' },
    ],
  });
  const visible = evaluate('Continue?\nYes');
  assert.deepEqual({ reported: visible.reported_task_outcome, interaction: visible.components.interaction_report,
    outcome: visible.components.outcome_report, status: visible.eval_status }, {
    reported: 'not_checked', interaction: 'pass', outcome: 'not_checked', status: 'pass',
  });
  const internalOnly = evaluate('Continue?\nchoice-1');
  assert.equal(internalOnly.components.interaction_report, 'fail');
  assert.deepEqual(internalOnly.mismatches, ['interaction-report-mismatch']);
});

test('launch trace constrains declared effort and fast fields without inventing omission requirements', async () => {
  const corpus = parseScenarioCorpus(await readFile(fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url))));
  const observedTrace = (scenario) => {
    let sessionId = 'session-1';
    let turnIndex = 0;
    return scenario.expected_trace.map((entry) => {
      if (entry.kind === 'session.resumed') sessionId = 'session-2';
      if (entry.kind === 'turn.started') turnIndex += 1;
      return { ...entry, session_id: sessionId,
        ...(!entry.kind.startsWith('session.') ? { turn_id: `turn-${turnIndex || 1}` } : {}) };
    });
  };
  const evaluate = (scenario, trace, texts) => evaluateScenario(scenario, {
    trace, callbacks: [], effects: [], actual_task_outcome: scenario.expected_actual_task_outcome,
    captured_finals: texts.map((text, index) => ({ turn_index: index + 1, completeness: 'complete', text })),
  });

  const unspecified = corpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-long-result');
  const withOptionalFields = observedTrace(unspecified);
  Object.assign(withOptionalFields[0], { effort: 'high', fast: false });
  assert.equal(evaluate(unspecified, withOptionalFields, ['LONG_REVIEW_OK']).eval_status, 'pass');
  for (const extra of [{ model: 'auto' }, { plugin_dirs_count: 1, plugin_dirs_matched: true }]) {
    const trace = structuredClone(withOptionalFields);
    Object.assign(trace[0], extra);
    assert.deepEqual(evaluate(unspecified, trace, ['LONG_REVIEW_OK']).mismatches, ['trace-mismatch']);
  }

  const resumedUnspecified = structuredClone(corpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-runtime-recovery'));
  const resumedExpectation = resumedUnspecified.expected_trace.find(({ kind }) => kind === 'session.resumed');
  delete resumedExpectation.effort;
  delete resumedExpectation.fast;
  const resumedWithOptionalFields = observedTrace(resumedUnspecified);
  Object.assign(resumedWithOptionalFields.find(({ kind }) => kind === 'session.resumed'), { effort: 'medium', fast: false });
  assert.equal(evaluate(resumedUnspecified, resumedWithOptionalFields,
    ['RECOVERY_STAGE_OK', 'RECOVERY_RESUME_OK']).eval_status, 'pass');

  const declared = corpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-launch-change');
  const base = observedTrace(declared);
  assert.equal(evaluate(declared, base, ['FIRST_CONFIG_OK', 'SECOND_CONFIG_OK']).eval_status, 'pass');
  for (const mutate of [
    (trace) => { delete trace[0].effort; },
    (trace) => { trace[0].effort = 'low'; },
    (trace) => { delete trace[6].fast; },
    (trace) => { trace[6].fast = false; },
  ]) {
    const trace = structuredClone(base);
    mutate(trace);
    assert.deepEqual(evaluate(declared, trace, ['FIRST_CONFIG_OK', 'SECOND_CONFIG_OK']).mismatches, ['trace-mismatch']);
  }
});

function recordedRequest(args, projection = {}) {
  if (!args || Array.isArray(args) || typeof args !== 'object') return projection;
  const withoutSessionTurn = Object.fromEntries(Object.entries(args)
    .filter(([key]) => key !== 'session_id' && key !== 'turn_id'));
  return { ...projection,
    arguments_without_session_turn_sha256: createHash('sha256').update(canonicalJson(withoutSessionTurn)).digest('hex') };
}

test('stdio recording proxy atomically publishes bounded lifecycle evidence with exact opaque IDs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line); const tool = call.params.name;
      const payload = tool === 'cursor_delegate'
        ? { session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 3,
            cursor_session_id: 'C', model: 'auto', effort: 'high', fast: false }
        : tool === 'cursor_answer_permission'
          ? { session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 7 }
          : tool === 'cursor_close_session'
            ? { session_id: 'S', session_state: 'tombstone', last_event_id: 11 }
            : call.params.arguments.after_event_id === 3
              ? { session_id: 'S', turn_id: 'T', turn_status: 'waiting_for_input', last_event_id: 6, resume_after_event_id: 6, wait_timeout: false,
                  pending: [{ request_id: 'R', kind: 'permission', context: { secret: 'not-recorded' } },
                    { request_id: 'R2' }, { request_id: 'R3', kind: { secret: true } }] }
              : { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, resume_after_event_id: 10, wait_timeout: false,
                  events_lost: true, earliest_event_id: 8, progress_revision: 2,
                  events: [{ kind: 'task', payload: { secret: true } }, { kind: { private: true } }],
                  terminal_reason: { text: 'provider stopped', truncated: false },
                  terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, result_sha256: 'a'.repeat(64), result_truncated: false, secret: true },
                  result: { text: 'CURSOR_EVAL_OK', truncated: false } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', `process.stderr.write('adapter diagnostic');${fake}`], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = [];
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const calls = [
    { id: 1, name: 'cursor_delegate', arguments: { cwd: '/secret/workspace', mode: 'agent', prompt: 'secret prompt' } },
    { id: 2, name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T', after_event_id: 3, timeout_ms: 1_000 } },
    { id: 3, name: 'cursor_answer_permission', arguments: { session_id: 'S', turn_id: 'T', request_id: 'R', decision: 'allow-once', secret: 'not-recorded' } },
    { id: 4, name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T', after_event_id: 7, timeout_ms: 1_000 } },
    { id: 5, name: 'cursor_close_session', arguments: { session_id: 'S' } },
  ];
  child.stdin.end(calls.map(({ id, name, arguments: args }) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).join('\n') + '\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8'); const published = JSON.parse(raw);
  assert.equal(Buffer.byteLength(raw), raw.length);
  assert.deepEqual(published, { schema_version: 1, dropped_calls: 0, transcript: [
    { direction: 'request', tool: 'cursor_delegate', call_id: 1, request: recordedRequest(calls[0].arguments, { mode: 'agent' }), response: { ok: true, session_id: 'S', turn_id: 'T', cursor_session_id: 'C', model: 'auto', effort: 'high', fast: false, turn_status: 'running', last_event_id: 3 } },
    { direction: 'request', tool: 'cursor_wait', call_id: 2, request: recordedRequest(calls[1].arguments, { session_id: 'S', turn_id: 'T', after_event_id: 3, timeout_ms: 1_000 }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'waiting_for_input', last_event_id: 6, resume_after_event_id: 6, wait_timeout: false, pending: [{ request_id: 'R', kind: 'permission' }, { request_id: 'R2' }, { request_id: 'R3' }] } },
    { direction: 'request', tool: 'cursor_answer_permission', call_id: 3, request: recordedRequest(calls[2].arguments, { session_id: 'S', turn_id: 'T', request_id: 'R', decision: 'allow-once' }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 7 } },
    { direction: 'request', tool: 'cursor_wait', call_id: 4, request: recordedRequest(calls[3].arguments, { session_id: 'S', turn_id: 'T', after_event_id: 7, timeout_ms: 1_000 }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, resume_after_event_id: 10, wait_timeout: false, events_lost: true, earliest_event_id: 8, progress_revision: 2, events: [{ kind: 'task' }], terminal_reason: { text: 'provider stopped', truncated: false }, terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, result_sha256: 'a'.repeat(64), result_truncated: false }, result: { text_bytes: 14, text_sha256: '65eb05dc0fa59c8ac6150c3fe6d3d7634471290d68fa38ae770b18c2ec2cc4cf', truncated: false } } },
    { direction: 'request', tool: 'cursor_close_session', call_id: 5, request: recordedRequest(calls[4].arguments, { session_id: 'S' }), response: { ok: true, session_id: 'S', session_state: 'tombstone', last_event_id: 11 } },
  ] });
  assert.doesNotMatch(raw, /secret|workspace|prompt|context/);
  assert.equal(Buffer.concat(diagnostics).toString('utf8'), 'adapter diagnostic');
  assert.deepEqual((await readdir(root)).sort(), ['mcp.json']);
});

test('recording proxy hashes complete non-ID arguments before bounded projection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-arguments-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
        isError: false, content: [{ type: 'text', text: '{}' }],
      } }) + '\\n');
    });`;
  const answers = Array.from({ length: 17 }, (_, index) => ({
    question_id: `Q${index}`, selected_option_ids: [`A${index}`],
  }));
  answers[16].selected_option_ids = ['PRIVATE_TAIL_ALPHA'];
  const base = {
    session_id: 'S1', turn_id: 'T1', request_id: 'R1', prompt: 'PRIVATE_PROMPT_ALPHA',
    unknown_key: 'PRIVATE_UNKNOWN_ALPHA', answers,
  };
  const reordered = {
    answers: structuredClone(answers), unknown_key: 'PRIVATE_UNKNOWN_ALPHA',
    prompt: 'PRIVATE_PROMPT_ALPHA', request_id: 'R1', turn_id: 'T2', session_id: 'S2',
  };
  const changed = [
    { ...base, request_id: 'R2' },
    { ...base, prompt: 'PRIVATE_PROMPT_BETA' },
    { ...base, unknown_key: 'PRIVATE_UNKNOWN_BETA' },
    { ...base, answers: [...answers.slice(0, 16), { question_id: 'Q16', selected_option_ids: ['PRIVATE_TAIL_BETA'] }] },
  ];
  const requestArguments = [base, reordered, ...changed, ['non-plain']];
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(`${requestArguments.map((arguments_, id) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cursor_answer_question', arguments: arguments_ },
  })).join('\n')}\n`);
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8');
  const requests = JSON.parse(raw).transcript.map(({ request }) => request);
  const digests = requests.map(({ arguments_without_session_turn_sha256: digest }) => digest);
  assert.equal(digests[0], digests[1]);
  for (const digest of digests.slice(2, 6)) assert.notEqual(digest, digests[0]);
  assert.equal(Object.hasOwn(requests[6], 'arguments_without_session_turn_sha256'), false);
  assert.doesNotMatch(raw, /PRIVATE_(?:PROMPT|UNKNOWN|TAIL)/);
});

test('recording proxy proves only an exact sequential full-result read through EOF', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-result-read-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  const payloads = [
    { text: 'alpha', offset: 0, next_offset: 5, eof: false, total_bytes: 9, sha256: digest('alphabeta') },
    { text: 'beta', offset: 5, next_offset: null, eof: true, total_bytes: 9, sha256: digest('alphabeta') },
    { error_code: 'invalid_args' },
    { text: 'tail', offset: 4, next_offset: null, eof: true, total_bytes: 8, sha256: digest('headtail') },
    { text: 'old', offset: 0, next_offset: 3, eof: false, total_bytes: 6, sha256: digest('oldend') },
    { text: 'new', offset: 0, next_offset: 3, eof: false, total_bytes: 6, sha256: digest('newend') },
    { text: 'end', offset: 3, next_offset: null, eof: true, total_bytes: 6, sha256: digest('newend') },
    { text: 'same', offset: 0, next_offset: null, eof: true, total_bytes: 4, sha256: digest('else') },
    { text: 'x', offset: 1, next_offset: null, eof: true, total_bytes: 1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: -1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: 1.5, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: 1, sha256: 'not-a-digest' },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: 1, sha256: null },
    { text: 'x', offset: 0, next_offset: null, eof: 'yes', total_bytes: 1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: 1, eof: true, total_bytes: 1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: 2, eof: false, total_bytes: 1, sha256: digest('x') },
    { text: 'short', offset: 0, next_offset: null, eof: true, total_bytes: 6, sha256: digest('short') },
  ];
  const fake = `
    const readline = require('node:readline');
    const payloads = JSON.parse(process.env.RESULT_READ_PAYLOADS);
    let index = 0;
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line); const payload = payloads[index++];
      const isError = payload.error_code !== undefined;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
        isError, content: [{ type: 'text', text: JSON.stringify(payload) }],
      } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, RESULT_READ_PAYLOADS: JSON.stringify(payloads) },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const offsets = [-1, 5, -1, 4, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  child.stdin.end(offsets.map((offset, id) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'cursor_read_result', arguments: {
        session_id: 'S', turn_id: 'T', ...(offset < 0 ? {} : { offset }),
      },
    },
  })).join('\n') + '\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(diagnostics).toString('utf8'));
  const responses = JSON.parse(await readFile(evidence, 'utf8')).transcript.map(({ response }) => response);
  assert.deepEqual(responses.slice(0, 8), [
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: true, eof: true, total_bytes: 9, sha256: digest('alphabeta') } },
    { ok: false, error_code: 'invalid_args' },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: true, eof: true, total_bytes: 6, sha256: digest('newend') } },
    { ok: true, result_read: { complete: false, eof: true, total_bytes: 4, sha256: digest('else') } },
  ]);
  assert.deepEqual(responses.slice(8), [
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: false, eof: true, total_bytes: 6, sha256: digest('short') } },
  ]);
});

test('recording MCP proxy preserves UTF-8 split across transport chunks in both directions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-utf8-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      const exact = call.params.arguments.prompt === 'проверка-🙂';
      const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify({ session_id: exact ? 'сессия-🙂' : 'corrupted', turn_id: 'T' }) }] } }) + '\\n');
      const marker = Buffer.from('🙂'); const split = frame.indexOf(marker) + 1;
      process.stdout.write(frame.subarray(0, split));
      setImmediate(() => process.stdout.write(frame.subarray(split)));
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
  const request = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { mode: 'agent', prompt: 'проверка-🙂' },
  } })}\n`);
  const marker = Buffer.from('🙂'); const split = request.indexOf(marker) + 1;
  child.stdin.write(request.subarray(0, split)); child.stdin.end(request.subarray(split));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const response = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  assert.equal(JSON.parse(response.result.content[0].text).session_id, 'сессия-🙂');
  assert.equal(JSON.parse(await readFile(evidence, 'utf8')).transcript[0].response.session_id, 'сессия-🙂');
});

test('recording MCP proxy observes final request and response frames without trailing newlines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-final-frame-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      const call = JSON.parse(input);
      process.stdout.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', session_state: 'tombstone' }) }] } }));
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_close_session', arguments: { session_id: 'S' },
  } }));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  assert.equal(JSON.parse(Buffer.concat(stdout).toString('utf8')).id, 1);
  assert.deepEqual(JSON.parse(await readFile(evidence, 'utf8')).transcript, [
    { direction: 'request', tool: 'cursor_close_session', call_id: 1,
      request: recordedRequest({ session_id: 'S' }, { session_id: 'S' }),
      response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
  ]);
});

test('recording MCP proxy drains accepted output before exiting under stdout backpressure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-backpressure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).once('line', (line) => {
      const call = JSON.parse(line);
      const payload = { session_id: 'S', padding: 'x'.repeat(800000) };
      process.stdout.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  child.stdout.pause();
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { mode: 'ask', prompt: 'bounded' },
  } })}\n`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(child.exitCode, null, 'proxy exited before its backpressured output could be consumed');
  let outputBytes = 0;
  child.stdout.resume();
  child.stdout.on('data', (chunk) => { outputBytes += chunk.length; });
  const [code] = await closed;
  assert.equal(code, 0);
  assert.ok(outputBytes > 750_000);
  assert.equal(JSON.parse(await readFile(evidence, 'utf8')).transcript[0].response.session_id, 'S');
});

test('recording proxy preserves only bounded public provider error fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-provider-error-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      const payload = { session_id: 'S', session_state: 'tombstone', failure_kind: 'init',
        provider_error: { code: -32001, message: { text: 'authentication required', truncated: false }, data: { secret: 'private' } } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { cwd: '/secret/workspace', mode: 'ask', prompt: 'private prompt' },
  } })}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8');
  const published = JSON.parse(raw);
  assert.deepEqual(published.transcript[0].response, {
    ok: true, session_id: 'S', session_state: 'tombstone', failure_kind: 'init',
    provider_error: { code: -32001, message: { text: 'authentication required', truncated: false } },
  });
  assert.doesNotMatch(raw, /private|secret|workspace|prompt/);
});

test('recording MCP proxy proves the exact plugin roots by digest without retaining paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-plugin-roots-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const expectedRoots = ['/private/expected/plugin'];
  const expectedDigest = createHash('sha256').update(JSON.stringify(expectedRoots)).digest('hex');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', turn_id: 'T' }) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256: expectedDigest },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end([
    { id: 1, name: 'cursor_delegate', roots: expectedRoots, launch: { model: 'sonnet-4.0', effort: 'high', fast: false } },
    { id: 2, name: 'cursor_delegate', roots: ['/private/wrong/plugin'], launch: {} },
    { id: 3, name: 'cursor_resume_session', roots: expectedRoots, launch: { cursor_session_id: 'cursor-session', model: 'grok-4.6', effort: 'low', fast: true } },
  ].map(({ id, name, roots, launch }) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name, arguments: { mode: 'agent', plugin_dirs: roots, ...launch },
  } })).join('\n') + '\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8');
  assert.deepEqual(JSON.parse(raw).transcript.map(({ request }) => request), [
    recordedRequest({ mode: 'agent', plugin_dirs: expectedRoots, model: 'sonnet-4.0', effort: 'high', fast: false },
      { mode: 'agent', model: 'sonnet-4.0', effort: 'high', fast: false, plugin_dirs_count: 1, plugin_dirs_matched: true }),
    recordedRequest({ mode: 'agent', plugin_dirs: ['/private/wrong/plugin'] },
      { mode: 'agent', plugin_dirs_count: 1, plugin_dirs_matched: false }),
    recordedRequest({ mode: 'agent', plugin_dirs: expectedRoots, cursor_session_id: 'cursor-session', model: 'grok-4.6', effort: 'low', fast: true },
      { cursor_session_id: 'cursor-session', model: 'grok-4.6', effort: 'low', fast: true, plugin_dirs_count: 1, plugin_dirs_matched: true }),
  ]);
  assert.doesNotMatch(raw, /\/private\/|expected|wrong/);

  const noDigestEvidence = join(root, 'mcp-no-digest.json');
  const noDigestChild = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: noDigestEvidence, CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256: '' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  noDigestChild.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { mode: 'ask', plugin_dirs: ['/private/first', '/private/second'] },
  } })}\n`);
  const [noDigestCode] = await once(noDigestChild, 'close');
  assert.equal(noDigestCode, 0);
  const noDigestRaw = await readFile(noDigestEvidence, 'utf8');
  assert.deepEqual(JSON.parse(noDigestRaw).transcript[0].request,
    recordedRequest({ mode: 'ask', plugin_dirs: ['/private/first', '/private/second'] }, { mode: 'ask', plugin_dirs_count: 2 }));
  assert.doesNotMatch(noDigestRaw, /\/private\/|first|second|plugin_dirs_matched/);
});

test('recording proxy injects one stale question ID as fixture behavior, not user instruction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-stale-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', turn_id: 'T' }) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, CURSOR_EVAL_SCENARIO_ID: 'stale-fixture',
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: join(root, 'program.json'), CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const calls = [1, 2].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'cursor_answer_question', arguments: { session_id: 'S', turn_id: 'T', request_id: 'current-request', outcome: 'answered', answers: [] },
  } }));
  child.stdin.end(`${calls.join('\n')}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const requests = JSON.parse(await readFile(evidence, 'utf8')).transcript.map(({ request }) => request.request_id);
  assert.deepEqual(requests, ['eval-stale-1', 'current-request']);

  const ambientEvidence = join(root, 'ambient-mcp.json');
  const ambient = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: ambientEvidence, CURSOR_EVAL_SCENARIO_ID: 'partial-handshake',
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: 'relative-program.json', CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  ambient.stdin.end(`${calls.join('\n')}\n`);
  const [ambientCode] = await once(ambient, 'close'); assert.equal(ambientCode, 0);
  const ambientRequests = JSON.parse(await readFile(ambientEvidence, 'utf8')).transcript.map(({ request }) => request.request_id);
  assert.deepEqual(ambientRequests, ['current-request', 'current-request']);
});

test('recording proxy injects a handshaken mode protocol error while preserving live status', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-mode-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', session_state: 'live', active_turn: null }) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, CURSOR_EVAL_SCENARIO_ID: 'mode-recovery-fixture',
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: join(root, 'program.json'), CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = []; child.stdout.on('data', (chunk) => output.push(chunk));
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cursor_set_mode', arguments: { session_id: 'S', mode: 'agent' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cursor_session_status', arguments: { session_id: 'S' } } },
  ];
  child.stdin.end(`${calls.map(JSON.stringify).join('\n')}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const responses = Buffer.concat(output).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(JSON.parse(responses[0].result.content[0].text).error_code, 'protocol_error');
  assert.equal(JSON.parse(responses[1].result.content[0].text).session_state, 'live');
  const transcript = JSON.parse(await readFile(evidence, 'utf8')).transcript;
  assert.deepEqual(transcript.map(({ tool }) => tool), ['cursor_set_mode', 'cursor_session_status']);
  assert.deepEqual(transcript.map(({ response }) => response), [
    { ok: false, error_code: 'protocol_error' },
    { ok: true, session_id: 'S', session_state: 'live', active_turn_present: false },
  ]);
});

test('stdio recording proxy caps call count and evidence bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-bounds-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const calls = Array.from({ length: 140 }, (_, index) => JSON.stringify({ jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: 'cursor_delegate', arguments: { mode: 'ask', prompt: 'x'.repeat(100_000) } } }));
  child.stdin.end(calls.join('\n') + '\n');
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8'); const published = JSON.parse(raw);
  assert.equal(published.transcript.length, 128);
  assert.equal(published.dropped_calls, 12);
  assert.ok(Buffer.byteLength(raw, 'utf8') < 1_048_576);
  assert.doesNotMatch(raw, /x{100}/);
  assert.deepEqual((await readdir(root)).sort(), ['mcp.json']);
});

test('stdio recording proxy rejects oversized bounded-field evidence without a partial artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-evidence-limit-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const id = 'x'.repeat(256);
  const answers = Array.from({ length: 16 }, () => ({ question_id: id, selected_option_ids: Array(16).fill(id) }));
  const calls = Array.from({ length: 16 }, (_, index) => JSON.stringify({
    jsonrpc: '2.0', id: index, method: 'tools/call',
    params: { name: 'cursor_answer_question', arguments: { session_id: id, turn_id: id, request_id: id, outcome: id, answers } },
  }));
  child.stdin.end(`${calls.join('\n')}\n`);
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /evidence exceeded its publication limit/);
  assert.deepEqual(await readdir(root), []);
});

test('stdio recording proxy controls an immediate publication failure and closes a live child', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-publication-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const closedMarker = join(root, 'child-closed');
  const fake = `
    const { writeFileSync } = require('node:fs');
    const readline = require('node:readline');
    process.on('exit', () => writeFileSync(${JSON.stringify(closedMarker)}, 'closed'));
    process.on('SIGTERM', () => process.exit(0));
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '{}' }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: '/dev/null/mcp.json' }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T' } } })}\n`);
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  const stderr = Buffer.concat(diagnostics).toString('utf8');
  assert.match(stderr, /^recording MCP proxy failed: /);
  assert.doesNotMatch(stderr, /Unhandled|node:events|throw er/);
  assert.equal(await readFile(closedMarker, 'utf8'), 'closed');
  assert.deepEqual(await readdir(root), ['child-closed']);
});

test('stdio recording proxy bounds public question answers and option IDs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-question-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '{}' }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const answers = Array.from({ length: 18 }, (_, index) => ({
    question_id: index === 1 ? { private: true } : `Q${index}`,
    selected_option_ids: index === 0 ? ['A', { private: true }, 2] : [`A${index}`],
  }));
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'cursor_answer_question', arguments: { session_id: 'S', turn_id: 'T', request_id: 'R', outcome: 'answered', answers } } })}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const published = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(published.transcript[0].request, recordedRequest({
    session_id: 'S', turn_id: 'T', request_id: 'R', outcome: 'answered', answers,
  }, {
    session_id: 'S', turn_id: 'T', request_id: 'R', outcome: 'answered',
    answers: [
      { question_id: 'Q0', selected_option_ids: ['A', 2] },
      { selected_option_ids: ['A1'] },
      ...Array.from({ length: 14 }, (_, index) => ({ question_id: `Q${index + 2}`, selected_option_ids: [`A${index + 2}`] })),
    ],
  }));
  assert.equal(published.transcript[0].response.ok, true);
});

test('stdio recording proxy ignores malformed and unrelated frames', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-malformed-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      if (line === 'not-json') return process.stdout.write('also-not-json\\n');
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'unmatched', result: { isError: false, content: [] } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '{}' }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(`not-json\n${JSON.stringify({ jsonrpc: '2.0', id: 'notification', method: 'notifications/initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cursor_close_session', arguments: { session_id: 'S' } } })}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const published = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(published.transcript, [
    { direction: 'request', tool: 'cursor_close_session', call_id: 1,
      request: recordedRequest({ session_id: 'S' }, { session_id: 'S' }), response: { ok: true } },
  ]);
});

test('stdio recording proxy preserves invalid UTF-8 and large numeric IDs byte-for-byte', async (t) => {
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const numeric = Buffer.from('{"jsonrpc":"2.0","id":9007199254740993123,"method":"notifications/initialized"}\n');
  const invalid = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const expected = Buffer.concat([numeric, invalid]);
  const chunks = []; child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stdin.end(expected);
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.deepEqual(Buffer.concat(chunks), expected);
});

test('stdio recording proxy fails closed on an oversized no-newline frame', async (t) => {
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.end(Buffer.alloc(1_048_577, 0x78));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /frame exceeded 1 MiB limit/);
});

test('stdio recording proxy fails closed on an oversized newline-terminated frame', async (t) => {
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.end(Buffer.concat([Buffer.alloc(1_048_577, 0x78), Buffer.from('\n')]));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /frame exceeded 1 MiB limit/);
});

test('stdio recording proxy publishes no partial oversized provider frame', async (t) => {
  const target = 'process.stdout.write(Buffer.alloc(1048577, 0x78));';
  const child = spawn(process.execPath, [recorder, '-e', target], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const output = []; const diagnostics = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.equal(Buffer.concat(output).length, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /frame exceeded 1 MiB limit/);
});

test('stdio recording proxy flushes a backpressured final response before exit', { timeout: 10_000 }, async (t) => {
  const target = `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'x'.repeat(900000)}]}})+'\\n');`;
  const child = spawn(process.execPath, [recorder, '-e', target], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const chunks = []; child.stdout.on('data', (chunk) => chunks.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(response.result.content[0].text.length, 900_000);
});

test('stdio recording proxy publishes only bounded public fields from malformed lifecycle values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-untrusted-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      const result = call.id === 'rpc'
        ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'private detail' } }
        : call.id === 'bad-json'
          ? { jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '[' }] } }
          : ['null', 'array', 'scalar'].includes(call.id)
            ? { jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: call.id === 'null' ? 'null' : call.id === 'array' ? '[]' : '1' }] } }
          : { jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({
              session_id: { private: true }, turn_id: 'x'.repeat(300), request_id: 9,
              session_state: ['private'], turn_status: 'waiting_for_input', error_code: null,
              last_event_id: 4.5, timed_out: 'no',
              active_turn: { turn_id: 'T', pending: 'private' },
              last_terminal_turn: { turn_id: 'T', pending: [null, { request_id: 'R', kind: 'k'.repeat(300) }], result: { text: 7 } },
            }) }] } };
      process.stdout.write(JSON.stringify(result) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const calls = [
    { id: 'rpc', method: 'tools/call', params: { name: 'cursor_answer_plan', arguments: { session_id: {}, decision: 'approve' } } },
    { id: 'bad-json', method: 'tools/call', params: { name: 'cursor_answer_question', arguments: { answers: [{ question_id: 'Q', selected_option_ids: 'private' }] } } },
    { id: 'null', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
    { id: 'array', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
    { id: 'scalar', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
    { id: 'payload', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
  ];
  child.stdin.end(calls.map((call) => JSON.stringify({ jsonrpc: '2.0', ...call })).join('\n') + '\n');
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const published = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(published.transcript, [
    { direction: 'request', tool: 'cursor_answer_plan', call_id: 'rpc',
      request: recordedRequest({ session_id: {}, decision: 'approve' }, { decision: 'approve' }), response: { ok: false, rpc_error_code: -32601 } },
    { direction: 'request', tool: 'cursor_answer_question', call_id: 'bad-json',
      request: recordedRequest({ answers: [{ question_id: 'Q', selected_option_ids: 'private' }] }, { answers: [{ question_id: 'Q', selected_option_ids: [] }] }), response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'null', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'array', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'scalar', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'payload', request: {}, response: { ok: true, request_id: 9, turn_status: 'waiting_for_input', active_turn_present: true } },
  ]);
  assert.doesNotMatch(JSON.stringify(published), /private|x{100}|k{100}/);
});

test('stdio recording proxy publishes an empty startup transcript and replaces it after the first tool call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-empty-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const target = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',(line)=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{isError:false,content:[{type:'text',text:'{}'}]}})+'\\n');});`;
  const child = spawn(process.execPath, [recorder, '-e', target], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const publishedWithCalls = async (minimum) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await readFile(evidence, 'utf8'));
        if (value.transcript?.length >= minimum) return value;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`recording proxy did not publish ${minimum} calls`);
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: {} })}\n`);
  assert.deepEqual(await publishedWithCalls(0), { schema_version: 1, transcript: [], dropped_calls: 0 });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'call', method: 'tools/call',
    params: { name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T' } } })}\n`);
  const replaced = await publishedWithCalls(1);
  assert.deepEqual(replaced.transcript.map(({ tool }) => tool), ['cursor_wait']);
  child.stdin.end();
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  assert.deepEqual(await readdir(root), ['mcp.json']);
});

for (const [name, target, expectedCode] of [
  ['SIGTERM', `process.stdout.write(String(process.pid) + '\\n'); process.stdin.resume(); process.once('SIGTERM', () => process.exit(0));`, 0],
  ['SIGKILL fallback', `process.stdout.write(String(process.pid) + '\\n'); process.stdin.resume(); process.on('SIGTERM', () => {});`, 1],
]) {
  test(`stdio recording proxy stops its child with ${name}`, async (t) => {
    const proxy = spawn(process.execPath, [recorder, '-e', target], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill('SIGKILL'); });
    const lines = createInterface({ input: proxy.stdout });
    const [pidLine] = await once(lines, 'line'); const targetPid = Number(pidLine);
    assert.ok(Number.isSafeInteger(targetPid));
    proxy.kill('SIGTERM');
    // Repeated ownership-loss signals are a real parent/terminal race.
    proxy.kill('SIGTERM');
    const [code, signal] = await once(proxy, 'close');
    assert.equal(signal, null);
    assert.equal(code, expectedCode);
    assert.throws(() => process.kill(targetPid, 0), { code: 'ESRCH' });
  });
}

test('stdio recording proxy terminates its target when its owning process disappears', { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, 'target.pid');
  const target = `require('node:fs').writeFileSync(process.env.TARGET_PID_FILE, String(process.pid)); setInterval(() => {}, 1_000); process.once('SIGTERM', () => process.exit(0));`;
  const launcher = `const { spawn } = require('node:child_process'); const { existsSync } = require('node:fs'); spawn(process.execPath, [process.env.RECORDER, '-e', process.env.TARGET], { detached: true, stdio: 'ignore', env: process.env }).unref(); const ready = setInterval(() => { if (existsSync(process.env.TARGET_PID_FILE)) { clearInterval(ready); process.exit(0); } }, 10);`;
  const owner = spawn(process.execPath, ['-e', launcher], {
    env: { ...process.env, RECORDER: recorder, TARGET: target, TARGET_PID_FILE: pidFile },
    stdio: 'ignore',
  });
  assert.equal((await once(owner, 'close'))[0], 0);

  let targetPid;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { targetPid = Number(await readFile(pidFile, 'utf8')); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.ok(Number.isSafeInteger(targetPid));
  t.after(() => { try { process.kill(targetPid, 'SIGKILL'); } catch {} });

  let terminated = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { process.kill(targetPid, 0); }
    catch (error) { if (error.code === 'ESRCH') { terminated = true; break; } throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(terminated, true);
});

test('evidence is atomically published outside and survives fixture cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-evidence-')); const fixture = join(root, 'fixture'); const evidence = join(root, 'evidence');
  t.after(() => rm(root, { recursive: true, force: true }));
  const reference = await publishEvidence({ evidenceRoot: evidence, fixtureRoot: fixture, evidence: { transcript: [{ name: 'cursor_delegate' }], skill_load: { enabled: true } } });
  assert.deepEqual(await readdir(evidence), [reference.split('/').at(-1)]);
  assert.deepEqual(JSON.parse(await readFile(reference, 'utf8')), { transcript: [{ name: 'cursor_delegate' }], skill_load: { enabled: true } });
  await assert.rejects(publishEvidence({ evidenceRoot: join(fixture, 'evidence'), fixtureRoot: fixture, evidence: {} }), /outside fixture root/);
  await assert.rejects(
    publishEvidence({ evidenceRoot: evidence, fixtureRoot: fixture, evidence: { payload: 'x'.repeat(1_048_576) } }),
    /evidence exceeds output limit/,
  );
});
