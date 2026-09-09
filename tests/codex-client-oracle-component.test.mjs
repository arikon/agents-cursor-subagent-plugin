import assert from 'node:assert/strict';
import test from 'node:test';
import { observationsFromEvidence, scoreWithCapturedFinals } from './codex-client-oracle-support.mjs';

test('observed MCP transcript drives oracle order, IDs, call outcomes and dropped-call evidence', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [
      { type: 'pending', request_kind: 'question', step_id: 'question-1', callback_id: 'request-1', expected_callback: { kind: 'answer', option_ids: ['yes'] } },
      { type: 'terminal', step_id: 'terminal-1' },
    ] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' }, { kind: 'pending.question', step_id: 'question-1' },
      { kind: 'answer.question', step_id: 'question-1', option_ids: ['yes'] }, { kind: 'turn.completed', step_id: 'terminal-1' },
      { kind: 'session.close-attempted' },
    ],
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  let callId = 0;
  const call = (tool, request, response) => ({ direction: 'request', tool, call_id: ++callId, request, response });
  const delegate = call('cursor_delegate', { mode: 'ask' }, { ok: true, session_id: 'session-1', turn_id: 'turn-1' });
  const pending = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, pending: [{ request_id: 'request-1', kind: 'question' }] });
  const answer = call('cursor_answer_question', { session_id: 'session-1', turn_id: 'turn-1', request_id: 'request-1', answers: [{ selected_option_ids: ['yes'] }] }, { ok: true });
  const terminal = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, turn_status: 'completed' });
  const close = call('cursor_close_session', { session_id: 'session-1' }, { ok: true });
  const safe = [{ kind: 'answer', step_id: 'question-1', callback_id: 'request-1', option_ids: ['yes'] }, { event: 'prompt_result', step_id: 'terminal-1' }];
  const outcomes = { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' };
  const observe = (calls, safeEvidence = safe, droppedCalls = 0) => observationsFromEvidence(scenario, { calls, dropped_calls: droppedCalls }, safeEvidence, outcomes);
  assert.equal(scoreWithCapturedFinals(scenario, observe([delegate, pending, answer, terminal, close])).eval_status, 'pass');

  const watermarkedPending = structuredClone(pending); watermarkedPending.response.last_event_id = 4;
  const watermarkedAnswer = structuredClone(answer); watermarkedAnswer.response.last_event_id = 6;
  for (const afterEventId of [4, 6, 0, undefined]) {
    const nextWait = structuredClone(terminal);
    if (afterEventId === undefined) delete nextWait.request.after_event_id;
    else nextWait.request.after_event_id = afterEventId;
    assert.equal(scoreWithCapturedFinals(scenario,
      observe([delegate, watermarkedPending, watermarkedAnswer, nextWait, close])).eval_status, 'pass');
  }
  const repeatedCursorScenario = structuredClone(scenario);
  repeatedCursorScenario.expected_trace.splice(4, 0,
    { kind: 'turn.wait-timeout', timeout_ms: 1000, timeout_omitted: false, progress_revision_matched: true },
    { kind: 'turn.wait-recovered', timeout_ms: 2000, timeout_omitted: false, progress_revision_matched: true });
  const repeatedCursorWait = structuredClone(terminal);
  repeatedCursorWait.request = { ...repeatedCursorWait.request, after_event_id: 4, timeout_ms: 1000 };
  repeatedCursorWait.response = { ok: true, session_id: 'session-1', turn_id: 'turn-1', turn_status: 'running', wait_timeout: true };
  const repeatedCursorTerminal = structuredClone(terminal);
  repeatedCursorTerminal.request = { ...repeatedCursorTerminal.request, after_event_id: 4, timeout_ms: 2000 };
  const repeatedCursorObservations = observationsFromEvidence(repeatedCursorScenario,
    { calls: [delegate, watermarkedPending, watermarkedAnswer, repeatedCursorWait, repeatedCursorTerminal, close], dropped_calls: 0 }, safe, outcomes);
  assert.equal(scoreWithCapturedFinals(repeatedCursorScenario, repeatedCursorObservations).eval_status, 'pass');
  const futureWait = structuredClone(terminal); futureWait.request.after_event_id = 7;
  futureWait.response = { ok: false, error_code: 'invalid_args' };
  assert.equal(scoreWithCapturedFinals(scenario,
    observe([delegate, watermarkedPending, watermarkedAnswer, futureWait, close])).eval_status, 'agent_behavior_mismatch');

  const answerBeforePending = scoreWithCapturedFinals(scenario, observe([delegate, answer, pending, terminal, close]));
  assert.ok(answerBeforePending.mismatches.includes('answer-before-pending'));
  const wrongIdAnswer = structuredClone(answer); wrongIdAnswer.request.request_id = 'wrong-request';
  const wrongId = scoreWithCapturedFinals(scenario, observe([delegate, pending, wrongIdAnswer, terminal, close,
  ], [{ kind: 'callback.failure', step_id: 'question-1', callback_id: 'request-1', reason: 'id-mismatch' }, ...safe.slice(1)]));
  assert.ok(wrongId.mismatches.includes('id-mismatch'));
  const staleRecoveryScenario = structuredClone(scenario);
  staleRecoveryScenario.expected_trace.splice(3, 0,
    { kind: 'answer.rejected-stale', step_id: 'question-1', error_code: 'unknown_request' },
    { kind: 'pending.question', step_id: 'question-1' });
  const staleAnswer = call('cursor_answer_question', {
    session_id: 'session-1', turn_id: 'turn-1', request_id: 'stale-request', answers: [{ selected_option_ids: ['yes'] }],
  }, { ok: false, session_id: 'session-1', turn_id: 'turn-1', error_code: 'unknown_request' });
  assert.equal(scoreWithCapturedFinals(staleRecoveryScenario, observe([delegate, pending, staleAnswer, pending, answer, terminal, close])).eval_status, 'pass');
  const failedAnswer = structuredClone(answer); failedAnswer.response.ok = false;
  assert.ok(scoreWithCapturedFinals(scenario, observe([delegate, pending, failedAnswer, terminal, close])).mismatches.includes('trace-mismatch'));
  assert.ok(scoreWithCapturedFinals(scenario, observe([delegate, pending, answer, terminal, close,
    call('cursor_session_status', { session_id: 'session-1' }, { ok: true })])).mismatches.includes('operation-after-close'));
  const failedResumeCleanup = {
    ...scenario,
    program: { steps: [] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' },
      { kind: 'session.tombstoned', session_state: 'tombstone' },
      { kind: 'session.resume-failed', matched: true },
      { kind: 'session.close-attempted' },
    ],
  };
  const failedResumeCleanupResult = scoreWithCapturedFinals(failedResumeCleanup, {
    trace: [
      { kind: 'session.allocated', mode: 'ask', session_id: 'session-old', call_outcome: 'succeeded' },
      { kind: 'session.tombstoned', session_state: 'tombstone', session_id: 'session-old', call_outcome: 'succeeded' },
      { kind: 'session.resume-failed', matched: true, session_id: 'session-failed', call_outcome: 'succeeded' },
      { kind: 'session.close-attempted', session_id: 'session-failed', call_outcome: 'succeeded' },
    ], callbacks: [], effects: [], actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked', dropped_calls: 0,
  });
  assert.equal(failedResumeCleanupResult.eval_status, 'pass', JSON.stringify(failedResumeCleanupResult));
  const overflow = observe([delegate, pending, answer, terminal, close], safe, 3);
  assert.equal(overflow.trace.at(-1).dropped_calls, 3);
  assert.equal(scoreWithCapturedFinals(scenario, overflow).eval_status, 'agent_behavior_mismatch');
});

test('session-level observations do not inherit a prior turn ID', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-1', turn_status: 'completed' }] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
      { kind: 'turn.completed', step_id: 'terminal-1' }, { kind: 'session.mode-changed', mode: 'plan' },
      { kind: 'session.close-attempted' },
    ],
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
    { tool: 'cursor_set_mode', request: { session_id: 'S', mode: 'plan' }, response: { ok: true, session_id: 'S', mode: 'plan' } },
    { tool: 'cursor_close_session', request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
  ];
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1' }],
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  for (const entry of observations.trace.filter(({ kind }) => ['session.mode-changed', 'session.close-attempted'].includes(kind))) {
    assert.equal(Object.hasOwn(entry, 'turn_id'), false);
  }
  assert.deepEqual(scoreWithCapturedFinals(scenario, observations).mismatches, []);

});

test('runtime recovery trace proves the old wrapper tombstone without duplicating terminal evidence', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-1' }, { type: 'terminal', step_id: 'terminal-2' }] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' }, { kind: 'turn.completed', step_id: 'terminal-1' },
      { kind: 'turn.receipt', step_id: 'terminal-1', matched: true, result_truncated: false },
      { kind: 'session.tombstoned', session_state: 'tombstone' },
      { kind: 'session.resumed', matched: true }, { kind: 'turn.started' }, { kind: 'turn.completed', step_id: 'terminal-2' },
      { kind: 'turn.receipt', step_id: 'terminal-2', matched: true, result_truncated: false }, { kind: 'session.close-attempted' },
    ],
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  const digest1 = 'a'.repeat(64); const digest2 = 'b'.repeat(64);
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'session-1', turn_id: 'turn-1', cursor_session_id: 'cursor-1' } },
    { tool: 'cursor_wait', request: { session_id: 'session-1', turn_id: 'turn-1' }, response: { ok: true, session_id: 'session-1', turn_id: 'turn-1', turn_status: 'completed', terminal_receipt: { result_sha256: digest1, result_truncated: false } } },
    { tool: 'cursor_wait', request: { session_id: 'session-1', turn_id: 'turn-1' }, response: { ok: true, session_id: 'session-1', turn_id: 'turn-1', turn_status: 'completed', session_state: 'tombstone' } },
    { tool: 'cursor_resume_session', request: { cursor_session_id: 'cursor-1' }, response: { ok: true, session_id: 'session-2', cursor_session_id: 'cursor-1' } },
    { tool: 'cursor_send_prompt', request: { session_id: 'session-2' }, response: { ok: true, session_id: 'session-2', turn_id: 'turn-2' } },
    { tool: 'cursor_wait', request: { session_id: 'session-2', turn_id: 'turn-2' }, response: { ok: true, session_id: 'session-2', turn_id: 'turn-2', turn_status: 'completed', terminal_receipt: { result_sha256: digest2, result_truncated: false } } },
    { tool: 'cursor_close_session', request: { session_id: 'session-2' }, response: { ok: true, session_id: 'session-2' } },
  ];
  const safe = [
    { event: 'prompt_result', step_id: 'terminal-1', result_sha256: digest1 },
    { event: 'prompt_result', step_id: 'terminal-2', result_sha256: digest2 },
  ];
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.equal(observations.trace.filter(({ kind }) => kind === 'turn.completed').length, 2);
  assert.equal(scoreWithCapturedFinals(scenario, observations).eval_status, 'pass');
  const directTombstoneCalls = structuredClone(calls);
  directTombstoneCalls[1].response.session_state = 'tombstone';
  directTombstoneCalls.splice(2, 1);
  const directTombstone = observationsFromEvidence(scenario, { calls: directTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  const firstTerminal = directTombstone.trace.findIndex(({ kind }) => kind === 'turn.completed');
  assert.deepEqual(directTombstone.trace.slice(firstTerminal, firstTerminal + 3).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned']);
  assert.equal(scoreWithCapturedFinals(scenario, directTombstone).eval_status, 'pass');
  const idempotentCloseCalls = structuredClone(directTombstoneCalls);
  idempotentCloseCalls.splice(2, 0, {
    tool: 'cursor_close_session', request: { session_id: 'session-1' },
    response: { ok: true, session_id: 'session-1', session_state: 'tombstone' },
  });
  const idempotentClose = observationsFromEvidence(scenario, { calls: idempotentCloseCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.deepEqual(idempotentClose.trace.slice(firstTerminal, firstTerminal + 4).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned', 'session.close-attempted']);
  assert.equal(scoreWithCapturedFinals(scenario, idempotentClose).eval_status, 'pass');
  const repeatedTombstoneCalls = structuredClone(directTombstoneCalls);
  repeatedTombstoneCalls.splice(2, 0, structuredClone(repeatedTombstoneCalls[1]));
  const repeatedTombstone = observationsFromEvidence(scenario, { calls: repeatedTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.ok(scoreWithCapturedFinals(scenario, repeatedTombstone).mismatches.includes('operation-after-close'));
  const postCloseDelegateCalls = structuredClone(idempotentCloseCalls);
  postCloseDelegateCalls.splice(3, 0, {
    tool: 'cursor_delegate', request: { mode: 'ask' },
    response: { ok: true, session_id: 'session-replacement', turn_id: 'turn-replacement', cursor_session_id: 'cursor-replacement' },
  });
  const postCloseDelegate = observationsFromEvidence(scenario, { calls: postCloseDelegateCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.ok(scoreWithCapturedFinals(scenario, postCloseDelegate).mismatches.includes('operation-after-close'));
  const closeTombstoneCalls = structuredClone(calls);
  closeTombstoneCalls[2] = {
    tool: 'cursor_close_session', request: { session_id: 'session-1' },
    response: { ok: true, session_id: 'session-1', session_state: 'tombstone' },
  };
  const closeTombstone = observationsFromEvidence(scenario, { calls: closeTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.deepEqual(closeTombstone.trace.slice(firstTerminal, firstTerminal + 3).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned']);
  assert.equal(scoreWithCapturedFinals(scenario, closeTombstone).eval_status, 'pass');
});

