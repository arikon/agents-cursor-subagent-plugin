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
import { observationsFromEvidence } from './codex-client-oracle-support.mjs';

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
      { tool: 'cursor_delegate', response: { ok: true, session_id: 'S', turn_id: 'T' } },
      { tool, request: request(before), response: { ok: false, error_code: error } },
      ...interleave,
      { tool, request: request(after), response: { ok: true, session_id: 'S', turn_id: 'T' } },
    ], dropped_calls: 0, unexpected_input_requests: 0, turn_call_ranges: [{ start: 0, end: 3 + interleave.length }],
  });
  const wait = { session_id: 'S', turn_id: 'T' };
  const status = { tool: 'cursor_session_status', request: request({ session_id: 'S' }),
    response: { ok: true, session_id: 'S', session_state: 'live' } };
  // Verdicts are specified before replay; no inference from a hosted pass/fail.
  const variations = [
    ['empty wait address', true, evidence('cursor_wait', {}, wait)],
    ['missing session ID', true, evidence('cursor_wait', { turn_id: 'T' }, { session_id: 'S', turn_id: 'T' })],
    ['missing turn ID', true, evidence('cursor_wait', { session_id: 'S' }, { session_id: 'S', turn_id: 'T' })],
    ['wrong ID', true, evidence('cursor_wait', { ...wait, turn_id: 'typo' }, wait, 'unknown_turn')],
    ['both wrong IDs', true, evidence('cursor_wait', { ...wait, session_id: 'typo', turn_id: 'typo' }, wait, 'unknown_session')],
    ['malformed address encoding', true, evidence('cursor_wait', { ...wait, session_id: '\ud800' }, wait, 'invalid_text_encoding')],
    ['diagnostic between rejection and repair', true, evidence('cursor_wait', {}, wait, 'invalid_args', [status])],
    ['repeated read-only diagnostics', true, evidence('cursor_wait', {}, wait, 'invalid_args', [status, status])],
    ['missing mode', true, evidence('cursor_set_mode', { session_id: 'S' }, { session_id: 'S', mode: 'plan' })],
    ['malformed mode', true, evidence('cursor_set_mode', { session_id: 'S', mode: 'plna' }, { session_id: 'S', mode: 'plan' })],
    ['changed valid mode intent', false, evidence('cursor_set_mode', { session_id: 'S', mode: 'ask' }, { session_id: 'S', mode: 'plan' })],
    ['mode provider failure', false, evidence('cursor_set_mode', { session_id: 'S', mode: 'plna' }, { session_id: 'S', mode: 'plan' }, 'protocol_error')],
    ['changed timeout', false, evidence('cursor_wait', { ...wait, timeout_ms: 0 }, { ...wait, timeout_ms: 1000 })],
    ['unknown extra argument', false, evidence('cursor_wait', { extra: true }, wait)],
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
  const missingRequest = evidence('cursor_set_mode', {}, { session_id: 'S', mode: 'plan' });
  delete missingRequest.calls[1].request;
  variations.push(['missing captured mode request', false, missingRequest]);
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
  for (const input of ['scripts/cursor-eval-scenario.mjs', 'scripts/cursor-model-adapter.mjs',
    'tests/fixtures/release-model-discovery-preload.mjs', 'tests/fixtures/cursor-eval-model-catalog.json',
    'tests/fixtures/cursor-model-catalog-1.0.31.json', 'tests/fixtures/fake-codex-cli-v01521.mjs',
    'tests/codex-client-oracle-support.mjs', 'tests/release-e2e-oracle-support.mjs', 'tests/fixtures/release-generation-acp.mjs']) {
    const changed = await readEvaluatorInventory('/first-checkout', async (path) =>
      path === `/first-checkout/${input}` ? Buffer.from('changed evaluator input') : load(path));
    assert.notDeepEqual(changed.digest, first.digest, input);
    assert.deepEqual(changed.files.find(({ path }) => path.endsWith('/SKILL.md')),
      first.files.find(({ path }) => path.endsWith('/SKILL.md')));
  }
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
  for (const kind of ['turn.wait-timeout', 'turn.wait-recovered']) {
    const corpus = structuredClone(source);
    const scenario = corpus.scenarios.find((entry) => entry.expected_trace.some((observation) => observation.kind === kind));
    scenario.expected_trace.find((observation) => observation.kind === kind).cursor_matched = true;
    assert.throws(() => parseScenarioCorpus(JSON.stringify(corpus)), /invalid shape/, kind);
    delete scenario.expected_trace.find((observation) => observation.kind === kind).cursor_matched;
    Object.assign(scenario.expected_trace.find((observation) => observation.kind === kind), { timeout_omitted: true, timeout_ms: 60_000 });
    assert.throws(() => parseScenarioCorpus(JSON.stringify(corpus)), /invalid wait contract|omitted-default wait timeout/, kind);
  }
});

test('terminal wait loss proof rejects missing evidence, wrong addresses, interleaving, and repeated provider work', async () => {
  const corpus = parseScenarioCorpus(await readFile(fileURLToPath(new URL('../evals/cursor-subagent-scenarios.v1.json', import.meta.url))));
  const scenario = corpus.scenarios.find(({ scenario_id: scenarioId }) => scenarioId === 'model-terminal-wait-response-loss');
  const request = { session_id: 'S', turn_id: 'T', arguments_without_session_turn_sha256: createHash('sha256').update('{}').digest('hex') };
  const terminal = { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', wait_timeout: false,
    pending: [], session_state: 'live',
    result: { text_bytes: 17, text_sha256: 'a'.repeat(64), truncated: false },
    terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 1, result_sha256: 'a'.repeat(64), result_truncated: false } };
  const loss = { tool: 'cursor_wait', request, response: { ok: false, error_code: 'eval_wait_response_lost', message: 'cursor_wait response unavailable' }, withheld_response: terminal };
  const retry = { tool: 'cursor_wait', request: structuredClone(request), response: structuredClone(terminal) };
  const input = {
    trace: scenario.expected_trace.map((entry) => ({ ...entry, ...(entry.kind === 'turn.wait-response-recovered' ? { lost_call_index: 2, repeated_call_index: 3 } : {}) })), callbacks: [], effects: [], actual_task_outcome: 'succeeded',
    captured_finals: [
      { turn_index: 1, completeness: 'complete', text: 'WAIT_RECOVERED_OK' },
    ],
    transcript: { calls: [{ tool: 'cursor_delegate', response: { ok: true, session_id: 'S', turn_id: 'T' } }, loss, retry],
      dropped_calls: 0, unexpected_input_requests: 0, turn_call_ranges: [{ start: 0, end: 3 }] },
  };
  assert.equal(evaluateScenario(scenario, input).mismatches.includes('terminal-wait-loss-recovery-mismatch'), false);
  const changedTimeout = structuredClone(input);
  changedTimeout.transcript.calls[2].request.timeout_ms = 60_000;
  changedTimeout.transcript.calls[2].request.arguments_without_session_turn_sha256 = createHash('sha256').update('{"timeout_ms":60000}').digest('hex');
  assert.equal(evaluateScenario(scenario, changedTimeout).mismatches.includes('terminal-wait-loss-recovery-mismatch'), false);
  const laterTurn = structuredClone(input);
  laterTurn.transcript.calls.splice(1, 0,
    { tool: 'cursor_wait', response: { ok: false, error_code: 'unknown_turn' } },
    { tool: 'cursor_send_prompt', request: { session_id: 'S' }, response: { ok: true, session_id: 'S', turn_id: 'T' } });
  laterTurn.transcript.turn_call_ranges[0].end += 2;
  Object.assign(laterTurn.trace.find(({ kind }) => kind === 'turn.wait-response-recovered'), { lost_call_index: 4, repeated_call_index: 5 });
  assert.equal(evaluateScenario(scenario, laterTurn).mismatches.includes('terminal-wait-loss-recovery-mismatch'), false);
  const safeEvidence = [{ event: 'prompt_result', step_id: 'terminal-1', result_sha256: 'a'.repeat(64) }];
  const projected = observationsFromEvidence(scenario, input.transcript, safeEvidence, []);
  assert.deepEqual(projected.trace.filter(({ kind }) => kind.startsWith('turn.')).map(({ kind }) => kind),
    ['turn.started', 'turn.wait-response-recovered', 'turn.completed', 'turn.receipt']);
  const corruptDelivery = structuredClone(input.transcript);
  for (const response of [corruptDelivery.calls[1].withheld_response, corruptDelivery.calls[2].response]) {
    response.result.text_sha256 = 'b'.repeat(64); response.terminal_receipt.result_sha256 = 'b'.repeat(64);
  }
  assert.equal(observationsFromEvidence(scenario, corruptDelivery, safeEvidence, []).trace.find(({ kind }) => kind === 'turn.receipt').matched, false);
  for (const result_sha256 of [undefined, 'malformed']) {
    const missingDigest = [{ event: 'prompt_result', step_id: 'terminal-1', ...(result_sha256 === undefined ? {} : { result_sha256 }) }];
    for (const evidence of [input.transcript, corruptDelivery]) {
      assert.equal(observationsFromEvidence(scenario, evidence, missingDigest, []).trace.find(({ kind }) => kind === 'turn.receipt').matched, false);
    }
  }
  const missingRetry = structuredClone(input.transcript);
  missingRetry.calls.pop(); missingRetry.turn_call_ranges[0].end = 2;
  assert.equal(observationsFromEvidence(scenario, missingRetry, safeEvidence, []).trace.some(({ kind }) => ['turn.completed', 'turn.receipt'].includes(kind)), false);
  const noFault = { ...scenario, harness_faults: [] };
  assert.ok(evaluateScenario(noFault, input).mismatches.includes('terminal-wait-loss-recovery-mismatch'));
  for (const mutate of [
    (value) => delete value.transcript.calls[1].withheld_response,
    (value) => delete value.transcript.calls[2].response.terminal_receipt,
    (value) => delete value.transcript.calls[2].response.terminal_receipt.last_event_id,
    (value) => { value.transcript.calls[2].response.wait_timeout = true; },
    (value) => { value.transcript.calls[2].response.pending = [{ request_id: 'P' }]; },
    (value) => { value.transcript.calls[2].response.result.text_bytes = 0.5; },
    (value) => { delete value.transcript.calls[1].withheld_response.result.truncated; delete value.transcript.calls[2].response.result.truncated; },
    (value) => { value.transcript.calls[1].withheld_response.result.truncated = 'false'; value.transcript.calls[2].response.result.truncated = 'false'; },
    (value) => { value.transcript.calls[2].response.session_state = 'unknown'; },
    (value) => { value.trace.find(({ kind }) => kind === 'turn.wait-response-recovered').lost_call_index = 1; },
    (value) => { value.transcript.calls[2].response.result.text_sha256 = 'b'.repeat(64); },
    (value) => { value.transcript.calls[2].response.terminal_receipt.result_sha256 = 'b'.repeat(64); },
    (value) => { value.transcript.calls[2].withheld_response = terminal; },
    (value) => { value.transcript.calls[1].response.message = 'other'; },
    (value) => { value.transcript.calls[1].request.timeout_ms = 999; },
    (value) => { value.transcript.calls[1].request.extra = true; },
    (value) => { value.transcript.calls[1].request.arguments_without_session_turn_sha256 = 'a'.repeat(64); },
    (value) => { value.transcript.calls[0].response.turn_id = 'OTHER'; },
    (value) => { value.transcript.calls[2].response.session_id = 'OTHER'; },
    (value) => { value.transcript.dropped_calls = 1; },
    (value) => { value.transcript.unexpected_input_requests = 1; },
    (value) => delete value.transcript.turn_call_ranges,
    (value) => { value.transcript.turn_call_ranges[0].end = 2; },
    (value) => { value.transcript.calls[2].request.turn_id = 'WRONG'; },
    (value) => value.transcript.calls.splice(2, 0, { tool: 'cursor_session_status', request: { session_id: 'S' }, response: { ok: true, session_id: 'S' } }),
    (value) => value.transcript.calls.splice(2, 0, { tool: 'cursor_send_prompt', request: { session_id: 'S' }, response: { ok: true, session_id: 'S', turn_id: 'NEXT' } }),
  ]) {
    const variation = structuredClone(input); mutate(variation);
    assert.equal(evaluateScenario(scenario, variation).mismatches.includes('terminal-wait-loss-recovery-mismatch'), true);
  }
  for (const mutate of [
    (row) => row.harness_faults.push('exit-after-result'),
    (row) => { row.program.steps[0].result_text = ''; },
    (row) => { row.program.steps[0].turn_status = 'failed'; },
    (row) => { row.expected_trace = row.expected_trace.filter(({ kind }) => kind !== 'turn.wait-response-recovered'); },
    (row) => { row.harness_faults = []; },
    (row) => { row.expected_trace.find(({ kind }) => kind === 'turn.wait-response-recovered').matched = false; },
    (row) => { row.expected_trace.splice(2, 0, { ...row.expected_trace[2] }); },
  ]) {
    const candidate = structuredClone(corpus); mutate(candidate.scenarios.find(({ scenario_id: id }) => id === scenario.scenario_id));
    assert.throws(() => parseScenarioCorpus(JSON.stringify(candidate)));
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
