import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LIMITS, Runtime } from '../scripts/cursor-subagent-mcp.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const server = fileURLToPath(new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url));
const cwd = process.cwd();

function withFake(t, extra = {}) {
  const names = ['CURSOR_AGENT_COMMAND', 'CURSOR_SUBAGENT_ADAPTER_ARGS', 'FAKE_ACP_PENDING', 'FAKE_ACP_LOG', 'FAKE_ACP_PATH', 'FAKE_ACP_CONTENT', 'FAKE_ACP_LINE', 'FAKE_ACP_RESULT', 'FAKE_ACP_BAD_ADMISSION', 'FAKE_ACP_BAD_CAPABILITIES', 'FAKE_ACP_BAD_PROMPT_RESULT', 'FAKE_ACP_STOP_REASON', 'FAKE_ACP_VERSION', 'FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_EXIT_AFTER_RESULT', 'FAKE_ACP_STDOUT_EOF_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8', 'FAKE_ACP_INVALID_FRAME', 'FAKE_ACP_INIT_FRAME', 'FAKE_ACP_DELAY_INIT_MS', 'FAKE_ACP_REQUIRE_POLICY', 'FAKE_ACP_EXPECT_DEFAULT_ARGV', 'FAKE_ACP_REJECT_PROMPT'];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.CURSOR_AGENT_COMMAND = process.execPath;
  process.env.FAKE_ACP_PENDING = extra.pending || '';
  process.env.FAKE_ACP_REQUIRE_POLICY = '1';
  process.env.CURSOR_SUBAGENT_ADAPTER_ARGS = JSON.stringify([fake]);
  for (const [name, value] of Object.entries(extra.env || {})) process.env[name] = value;
  const runtime = new Runtime({ roots: Object.hasOwn(extra, 'roots') ? extra.roots : [cwd] });
  t.after(() => { for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name]; });
  return runtime;
}

function withDefaultFake(t) {
  const names = ['CURSOR_AGENT_COMMAND', 'CURSOR_SUBAGENT_ADAPTER_ARGS', 'FAKE_ACP_PENDING', 'FAKE_ACP_REQUIRE_POLICY', 'FAKE_ACP_EXPECT_DEFAULT_ARGV'];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  const root = mkdtempSync(join(tmpdir(), 'cursor-default-argv-'));
  const executable = join(root, 'agent');
  copyFileSync(fake, executable);
  chmodSync(executable, 0o755);
  process.env.CURSOR_AGENT_COMMAND = executable;
  process.env.FAKE_ACP_REQUIRE_POLICY = '1';
  process.env.FAKE_ACP_EXPECT_DEFAULT_ARGV = '1';
  const runtime = new Runtime({ roots: [cwd] });
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name]; });
  return runtime;
}

async function waitTerminal(runtime, sessionId, turnId, afterEventId = 0) {
  let envelope;
  do { envelope = await runtime.call('cursor_wait', { session_id: sessionId, turn_id: turnId, after_event_id: afterEventId, timeout_ms: 1_000 }); afterEventId = envelope.last_event_id; } while (['running', 'waiting_for_input'].includes(envelope.turn_status));
  return envelope;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolve(buffered.slice(0, newline));
    };
    const onEnd = () => { cleanup(); reject(new Error('stream ended before a line')); };
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); };
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}

test('runtime rejects scope before session allocation', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: '/definitely-missing', mode: 'ask' }), { error_code: 'scope_rejected' });
});

test('runtime exposes normalized init tombstone when ACP cannot spawn', async () => {
  const old = process.env.CURSOR_AGENT_COMMAND; process.env.CURSOR_AGENT_COMMAND = '/definitely-missing-agent';
  try {
    const runtime = new Runtime({ roots: [cwd] });
    const envelope = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(envelope.session_state, 'tombstone');
    assert.equal(envelope.failure_kind, 'spawn');
  } finally { process.env.CURSOR_AGENT_COMMAND = old; }
});

test('adapter admission failure is an allocated init tombstone and releases capacity', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_BAD_ADMISSION: '1' } });
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.session_state, 'tombstone'); assert.equal(failed.failure_kind, 'init'); assert.equal(runtime.live.size, 0);
});

test('actual initialize deadline produces an init_timeout tombstone', { timeout: LIMITS.initMs + 5_000 }, async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_DELAY_INIT_MS: String(LIMITS.initMs + 2_000) } });
  const started = Date.now();
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.session_state, 'tombstone');
  assert.equal(failed.failure_kind, 'init_timeout');
  assert.ok(Date.now() - started >= LIMITS.initMs - 250);
  assert.equal(runtime.live.size, 0);
});

test('adapter admission is bound to installed Cursor version and required capabilities', async (t) => {
  for (const env of [{ FAKE_ACP_VERSION: '2026.08.24-old' }, { FAKE_ACP_BAD_CAPABILITIES: '1' }]) {
    const runtime = withFake(t, { env }); const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone'); assert.equal(failed.failure_kind, 'init'); assert.equal(runtime.live.size, 0);
  }
});

test('admitted adapter applies immutable auto-review and enabled-sandbox argv', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(session.session_state, 'live');
  assert.equal(session.run_mode, 'auto_review');
  assert.equal(session.sandbox, 'enabled');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('runtime dispatch accepts exactly the three advertised answer tool names', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  for (const name of ['cursor_answer_', 'cursor_answer_unknown', 'cursor_answer_question_extra']) {
    await assert.rejects(runtime.call(name, {}), { error_code: 'invalid_args', message: `unknown tool: ${name}` });
  }
  assert.equal(runtime.sessions.size, 0);
});

test('fake ACP completes and preserves retained T1 while T2 is active', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(session.session_state, 'live');
  const first = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const completed = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: first.turn_id, after_event_id: first.last_event_id, timeout_ms: 1_000 });
  assert.equal(completed.turn_status, 'completed');
  const second = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'two' });
  const retained = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: first.turn_id, timeout_ms: 1_000 });
  assert.equal(retained.turn_status, 'completed');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.ok(second.turn_id);
});

test('agent message chunks produce the result before terminal session lifecycle events', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_RESULT: 'from session update' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const completed = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(completed.last_terminal_turn.result.text, 'from session update');
  assert.deepEqual(completed.events.map((event) => [event.kind, event.payload]), [['result', { turn_status: 'completed' }]]);
  const closed = await runtime.call('cursor_close_session', { session_id: session.session_id });
  const terminalEvents = runtime.sessions.get(session.session_id).events.filter((event) => event.event_id > completed.last_event_id);
  assert.equal(closed.session_state, 'tombstone');
  assert.deepEqual(terminalEvents.map((event) => [event.kind, event.payload.scope, event.payload.to]), [
    ['lifecycle', 'session', 'closing'],
    ['lifecycle', 'session', 'tombstone'],
  ]);
});

test('malformed prompt result fails after bounded update aggregation', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_BAD_PROMPT_RESULT: '1' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.match(terminal.last_terminal_turn.terminal_reason.text, /prompt response is not admitted/);
});

test('prompt result admits exactly the pinned stopReason table', async (t) => {
  for (const stopReason of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) {
    const runtime = withFake(t, { env: { FAKE_ACP_STOP_REASON: stopReason } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: stopReason });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed', stopReason);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }

  const runtime = withFake(t, { env: { FAKE_ACP_STOP_REASON: 'not-admitted' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'unknown' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.match(terminal.last_terminal_turn.terminal_reason.text, /prompt response is not admitted/);
});

test('synchronous prompt transport failure removes its RPC waiter without unhandled rejection', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const record = runtime.sessions.get(session.session_id);
  const originalSend = record.send.bind(record);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  record.send = () => { throw new Error('synchronous write failure'); };
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  await record.shutdownPromise;
  await new Promise((resolveDone) => setImmediate(resolveDone));
  assert.equal(turn.turn_status, 'failed');
  assert.equal(record.rpc.size, 0);
  assert.deepEqual(unhandled, []);
  record.send = originalSend;
});

test('live answer transport failure terminalizes instead of returning a false running turn', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const record = runtime.sessions.get(session.session_id);
  record.child.stdin.write = () => { throw new Error('answer transport closed'); };
  const answered = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: waiting.active_turn.pending[0].request_id,
    outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }],
  });
  assert.equal(answered.turn_status, 'failed');
  assert.match(answered.last_terminal_turn.terminal_reason.text, /answer transport closed/);
});

test('live answer preserves pending state until the stdin write callback succeeds', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const record = runtime.sessions.get(session.session_id);
  const originalWrite = record.child.stdin.write.bind(record.child.stdin);
  let confirmWrite;
  record.child.stdin.write = (_chunk, callback) => { confirmWrite = callback; return true; };
  const answerPromise = runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1',
    outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }],
  });
  await new Promise((resolveDone) => setImmediate(resolveDone));
  assert.equal(record.active.turn_status, 'waiting_for_input');
  assert.deepEqual([...record.active.pending.keys()], ['q1']);
  confirmWrite();
  const answered = await answerPromise;
  assert.equal(answered.turn_status, 'running');
  assert.deepEqual(answered.active_turn.pending, []);
  record.child.stdin.write = originalWrite;
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('stdin write callback EPIPE makes the answer and turn fail', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const record = runtime.sessions.get(session.session_id);
  const originalWrite = record.child.stdin.write.bind(record.child.stdin);
  record.child.stdin.write = (_chunk, callback) => {
    setImmediate(() => {
      record.child.stdin.write = originalWrite;
      const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
      callback(error);
    });
    return true;
  };
  const answered = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1',
    outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }],
  });
  assert.equal(answered.turn_status, 'failed');
  assert.equal(answered.last_terminal_turn.turn_status, 'failed');
  assert.match(answered.last_terminal_turn.terminal_reason.text, /stdin EPIPE/);
});

test('pending request is turn-addressed and answer restores running state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-question-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'question', env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ask' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.turn_status, 'waiting_for_input');
  const pending = waiting.active_turn.pending[0];
  const answered = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: pending.request_id,
    outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }],
  });
  assert.equal(answered.turn_status, 'running');
  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  assert.equal(completed.turn_status, 'completed');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()).result, { outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['yes'] }] } });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('question answers reject unadvertised IDs without mutating pending state', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ask' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  await assert.rejects(runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['not-advertised'] }] }), { error_code: 'invalid_args' });
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.length, 1);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('late answer to a retained terminal turn is rejected without affecting a newer turn', async (t) => {
  const runtime = withFake(t, { pending: 'question' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const first = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'first' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: first.turn_id, after_event_id: first.last_event_id, timeout_ms: 1_000 }); const firstAnswered = await runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: first.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }] }); const terminal = await waitTerminal(runtime, session.session_id, first.turn_id, firstAnswered.last_event_id); const second = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'second' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: second.turn_id, after_event_id: second.last_event_id, timeout_ms: 1_000 });
  await assert.rejects(runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: first.turn_id, request_id: 'late', outcome: 'cancelled' }), { error_code: 'unknown_request' });
  const retained = await runtime.call('cursor_cancel', { session_id: session.session_id, turn_id: first.turn_id });
  assert.equal(retained.turn_status, 'completed'); assert.equal(retained.active_turn.turn_id, second.turn_id); assert.equal(retained.active_turn.turn_status, 'waiting_for_input');
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id }); assert.equal(status.active_turn.turn_id, second.turn_id); assert.equal(status.last_terminal_turn.turn_id, terminal.turn_id);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('duplicate pending request ID is rejected without overwriting the accepted request', async (t) => {
  const runtime = withFake(t, { pending: 'duplicate' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const record = runtime.sessions.get(session.session_id); const originalRespondError = record.respondError.bind(record); const errors = []; record.respondError = (id, code, message) => { errors.push({ id, code }); originalRespondError(id, code, message); }; const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'duplicate' }); const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.active_turn.pending.length, 1); assert.equal(waiting.active_turn.pending[0].context.questions[0].prompt.text, 'First?');
  const answered = await runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }] }); await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  assert.deepEqual(errors, [{ id: 'q1', code: 'duplicate_request' }]); await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('permission decisions map to their advertised opaque IDs, not option order', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-permission-')); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'permission', env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'run' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.active_turn.pending[0].context.title.text, 'Run?'); assert.equal(waiting.active_turn.pending[0].context.tool_kind.text, 'execute'); assert.equal(waiting.active_turn.pending[0].context.locations[0].line, 1);
  const answered = await runtime.call('cursor_answer_permission', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'p1', decision: 'allow-once' });
  await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  const response = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.equal(response.result.outcome.optionId, 'opaque-allow');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('plan decisions use adapter-owned wire encoding and close settles pending once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-plan-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'plan', env: { FAKE_ACP_LOG: log } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'plan' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'plan' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const answered = await runtime.call('cursor_answer_plan', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan1', decision: 'accept' }); await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()).result, { outcome: { outcome: 'accepted' } }); await runtime.call('cursor_close_session', { session_id: session.session_id });

  const cancelledRuntime = withFake(t, { pending: 'question' }); const cancelledSession = await cancelledRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const cancelledTurn = await cancelledRuntime.call('cursor_send_prompt', { session_id: cancelledSession.session_id, prompt: 'ask' }); await cancelledRuntime.call('cursor_wait', { session_id: cancelledSession.session_id, turn_id: cancelledTurn.turn_id, after_event_id: cancelledTurn.last_event_id, timeout_ms: 1_000 });
  const record = cancelledRuntime.sessions.get(cancelledSession.session_id); const originalRespond = record.respond.bind(record); const responses = []; record.respond = (id, result) => { responses.push({ id, result }); originalRespond(id, result); };
  await cancelledRuntime.call('cursor_close_session', { session_id: cancelledSession.session_id }); assert.deepEqual(responses, [{ id: 'q1', result: { outcome: { outcome: 'cancelled' } } }]);
});

test('ambiguous permission and unknown callbacks are rejected without pending publication', async (t) => {
  for (const pending of ['ambiguous-permission', 'unknown']) {
    const runtime = withFake(t, { pending });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: pending });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed'); assert.deepEqual(terminal.last_terminal_turn.pending, []);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }
});

test('filesystem callbacks enforce mode, containment, UTF-8, cap and ranges', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-')); t.after(() => rmSync(root, { recursive: true, force: true })); const source = join(root, 'source.txt'); const output = join(root, 'output.txt'); const log = join(root, 'wire.jsonl');
  writeFileSync(source, 'one\ntwo', 'utf8');
  const reader = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LINE: '2', FAKE_ACP_LOG: log } });
  const readSession = await reader.call('cursor_start_session', { cwd: root, mode: 'plan' }); const readTurn = await reader.call('cursor_send_prompt', { session_id: readSession.session_id, prompt: 'read' }); await waitTerminal(reader, readSession.session_id, readTurn.turn_id, readTurn.last_event_id);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).result.content, 'two'); await reader.call('cursor_close_session', { session_id: readSession.session_id });

  const writer = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: { FAKE_ACP_PATH: output, FAKE_ACP_CONTENT: 'written' } });
  const writeSession = await writer.call('cursor_start_session', { cwd: root, mode: 'agent' }); const writeTurn = await writer.call('cursor_send_prompt', { session_id: writeSession.session_id, prompt: 'write' }); await waitTerminal(writer, writeSession.session_id, writeTurn.turn_id, writeTurn.last_event_id);
  assert.equal(readFileSync(output, 'utf8'), 'written'); await writer.call('cursor_close_session', { session_id: writeSession.session_id });

  writeFileSync(source, Buffer.from([0xc3, 0x28])); writeFileSync(log, '');
  const malformed = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LOG: log } });
  const malformedSession = await malformed.call('cursor_start_session', { cwd: root, mode: 'plan' }); const malformedTurn = await malformed.call('cursor_send_prompt', { session_id: malformedSession.session_id, prompt: 'read' }); await waitTerminal(malformed, malformedSession.session_id, malformedTurn.turn_id, malformedTurn.last_event_id);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).error.data.error_code, 'invalid_text_encoding'); await malformed.call('cursor_close_session', { session_id: malformedSession.session_id });

  writeFileSync(source, Buffer.alloc(LIMITS.fsBytes + 1, 0x61)); writeFileSync(log, '');
  const oversized = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LOG: log } }); const oversizedSession = await oversized.call('cursor_start_session', { cwd: root, mode: 'plan' }); const oversizedTurn = await oversized.call('cursor_send_prompt', { session_id: oversizedSession.session_id, prompt: 'read' }); await waitTerminal(oversized, oversizedSession.session_id, oversizedTurn.turn_id, oversizedTurn.last_event_id);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).error.data.error_code, 'resource_limit'); await oversized.call('cursor_close_session', { session_id: oversizedSession.session_id });

  writeFileSync(log, ''); const deniedOutput = join(root, 'denied.txt');
  const denied = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: { FAKE_ACP_PATH: deniedOutput, FAKE_ACP_CONTENT: 'no', FAKE_ACP_LOG: log } }); const deniedSession = await denied.call('cursor_start_session', { cwd: root, mode: 'plan' }); const deniedTurn = await denied.call('cursor_send_prompt', { session_id: deniedSession.session_id, prompt: 'write' }); await waitTerminal(denied, deniedSession.session_id, deniedTurn.turn_id, deniedTurn.last_event_id);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).error.data.error_code, 'scope_rejected'); assert.throws(() => readFileSync(deniedOutput)); await denied.call('cursor_close_session', { session_id: deniedSession.session_id });
});

test('filesystem callbacks reject outside and symlink paths and return empty content after EOF', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-negative-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outsideRoot, { recursive: true, force: true }); });
  const source = join(root, 'source.txt');
  const symlink = join(root, 'source-link.txt');
  const outside = join(outsideRoot, 'outside.txt');
  const log = join(root, 'wire.jsonl');
  writeFileSync(source, 'one\ntwo', 'utf8');
  writeFileSync(outside, 'outside', 'utf8');
  symlinkSync(source, symlink);

  for (const path of [outside, symlink]) {
    writeFileSync(log, '');
    const runtime = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: path, FAKE_ACP_LOG: log } });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'plan' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'read denied path' });
    await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).error.data.error_code, 'scope_rejected');
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }

  writeFileSync(log, '');
  const runtime = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LINE: '4', FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'plan' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'read after EOF' });
  await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()).result, { content: '' });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('oversized normalized pending context is rejected without publication', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-pending-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'oversized-question', env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'oversized pending' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.turn_status, 'completed');
  assert.deepEqual(terminal.last_terminal_turn.pending, []);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).error.data.error_code, 'resource_limit');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('event eviction reports loss from cursor zero and bounded text preserves UTF-8', async (t) => {
  const runtime = withFake(t, { pending: 'question' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ask' });
  const record = runtime.sessions.get(session.session_id); for (let index = 0; index < LIMITS.events + 5; index += 1) record.emit('lifecycle', null, { scope: 'session', from: 'live', to: 'live' });
  const envelope = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: 0, timeout_ms: 1_000 });
  assert.equal(envelope.events_lost, true); assert.ok(envelope.earliest_event_id > 1);
  await runtime.call('cursor_close_session', { session_id: session.session_id });

  const resultRuntime = withFake(t, { env: { FAKE_ACP_RESULT: '😀'.repeat(3_000) } }); const resultSession = await resultRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const resultTurn = await resultRuntime.call('cursor_send_prompt', { session_id: resultSession.session_id, prompt: 'result' }); const terminal = await waitTerminal(resultRuntime, resultSession.session_id, resultTurn.turn_id, resultTurn.last_event_id);
  assert.equal(terminal.last_terminal_turn.result.truncated, true); assert.equal(terminal.last_terminal_turn.result.text.includes('�'), false); assert.ok(Buffer.byteLength(terminal.last_terminal_turn.result.text, 'utf8') <= LIMITS.textBytes);
  await resultRuntime.call('cursor_close_session', { session_id: resultSession.session_id });
});

test('child exit and malformed ACP UTF-8 fail an allocated active turn', async (t) => {
  for (const variable of ['FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8']) {
    const runtime = withFake(t, { env: { [variable]: '1' } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'fail' });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id); await runtime.sessions.get(session.session_id).shutdownPromise; const tombstone = await runtime.call('cursor_session_status', { session_id: session.session_id }); assert.equal(tombstone.session_state, 'tombstone'); assert.equal(terminal.turn_status, 'failed'); assert.equal(terminal.failure_kind, null);
  }
});

test('ACP stdout EOF and stdin EPIPE fail the allocated active turn', async (t) => {
  const eofRuntime = withFake(t, { env: { FAKE_ACP_STDOUT_EOF_ON_PROMPT: '1' } });
  const eofSession = await eofRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const eofTurn = await eofRuntime.call('cursor_send_prompt', { session_id: eofSession.session_id, prompt: 'stdout EOF' });
  const eofTerminal = await waitTerminal(eofRuntime, eofSession.session_id, eofTurn.turn_id, eofTurn.last_event_id);
  assert.equal(eofTerminal.turn_status, 'failed');
  assert.match(eofTerminal.last_terminal_turn.terminal_reason.text, /stdout EOF/);
  await eofRuntime.sessions.get(eofSession.session_id).shutdownPromise;

  const epipeRuntime = withFake(t, { pending: 'question' });
  const epipeSession = await epipeRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const epipeTurn = await epipeRuntime.call('cursor_send_prompt', { session_id: epipeSession.session_id, prompt: 'stdin EPIPE' });
  await epipeRuntime.call('cursor_wait', { session_id: epipeSession.session_id, turn_id: epipeTurn.turn_id, after_event_id: epipeTurn.last_event_id, timeout_ms: 1_000 });
  const epipeRecord = epipeRuntime.sessions.get(epipeSession.session_id);
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  epipeRecord.child.stdin.emit('error', error);
  const epipeTerminal = await waitTerminal(epipeRuntime, epipeSession.session_id, epipeTurn.turn_id, epipeTurn.last_event_id);
  assert.equal(epipeTerminal.turn_status, 'failed');
  assert.match(epipeTerminal.last_terminal_turn.terminal_reason.text, /stdin EPIPE/);
  await epipeRecord.shutdownPromise;
});

test('null and nonobject ACP frames follow init and active-turn failure lifecycles', async (t) => {
  for (const frame of ['null', '[]', '"text"']) {
    const initRuntime = withFake(t, { env: { FAKE_ACP_INIT_FRAME: frame } }); const init = await initRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); assert.equal(init.session_state, 'tombstone'); assert.equal(init.failure_kind, 'init');
    const activeRuntime = withFake(t, { env: { FAKE_ACP_INVALID_FRAME: frame } }); const session = await activeRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await activeRuntime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'bad frame' }); const terminal = await waitTerminal(activeRuntime, session.session_id, turn.turn_id, turn.last_event_id); await activeRuntime.sessions.get(session.session_id).shutdownPromise; assert.equal(terminal.turn_status, 'failed'); assert.equal(terminal.failure_kind, null);
  }
});

test('terminalization settles pending before adapter cancel and shutdown escalation is TERM then KILL', async (t) => {
  const runtime = withFake(t, { pending: 'question' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'order' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 }); const record = runtime.sessions.get(session.session_id);
  const order = []; record.respond = () => order.push('settle'); record.requestAdapterCancel = () => { order.push('cancel'); record.adapterCancelSent = true; }; record.shutdown = async () => { order.push('shutdown'); };
  await record.terminalize(record.active, 'cancelled', 'test'); assert.deepEqual(order, ['settle', 'cancel', 'shutdown']); record.child.kill('SIGKILL');

  const killRuntime = withFake(t); const killSession = await killRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const killRecord = killRuntime.sessions.get(killSession.session_id); const originalKill = killRecord.child.kill.bind(killRecord.child); const signals = []; killRecord.child.kill = (signal) => { signals.push(signal); return true; }; killRecord.adapterCancelSent = false;
  await killRecord.shutdown(null, 'test'); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); originalKill('SIGKILL');
});

test('warning scenarios: deadlines and caps are enforced at their owning boundaries', async (t) => {
  await t.test('fixed limits remain the frozen v1 values', () => {
    assert.deepEqual(LIMITS, {
      initMs: 15_000, turnMs: 600_000, idleMs: 900_000, waitDefaultMs: 30_000,
      waitMinMs: 1_000, waitMaxMs: 60_000, live: 8, pending: 8, waiters: 8,
      tombstones: 64, events: 256, graceMs: 5_000, retentionMs: 300_000,
      inputBytes: 64_000, textBytes: 8_000, fsBytes: 1_048_576, frameBytes: 1_048_576,
    });
  });
  await t.test('turn deadline terminalizes the allocated turn', async () => {
    const runtime = withFake(t, { pending: 'question' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'deadline' });
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 }); const record = runtime.sessions.get(session.session_id);
    await record.terminalize(record.active, 'timed_out', 'turn deadline exceeded'); const terminal = await runtime.call('cursor_session_status', { session_id: session.session_id });
    assert.equal(terminal.session_state, 'tombstone'); assert.equal(terminal.last_terminal_turn.turn_status, 'timed_out');
  });
  await t.test('live, pending and waiter caps reject without extra allocation', async () => {
    const capacity = new Runtime({ roots: [cwd] }); for (let index = 0; index < LIMITS.live; index += 1) capacity.live.add(`live-${index}`);
    await assert.rejects(capacity.call('cursor_start_session', { cwd, mode: 'ask' }), { error_code: 'resource_limit' }); assert.equal(capacity.sessions.size, 0);

    const runtime = withFake(t, { pending: 'question' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'caps' }); const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 }); const record = runtime.sessions.get(session.session_id);
    for (let index = record.active.pending.size; index < LIMITS.pending; index += 1) record.active.pending.set(`held-${index}`, { request_id: `held-${index}` });
    const errors = []; record.respondError = (_id, code) => errors.push(code); record.callback({ jsonrpc: '2.0', id: 'overflow', method: 'cursor/ask_question', params: { questions: [] } }); assert.deepEqual(errors, ['resource_limit']); assert.equal(record.active.pending.size, LIMITS.pending);
    record.waiters = new Set(Array.from({ length: LIMITS.waiters }, () => () => {}));
    await assert.rejects(runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: waiting.last_event_id, timeout_ms: 1_000 }), { error_code: 'resource_limit' });
    record.waiters.clear(); await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
});

test('warning scenarios: prompt rejection preserves allocation boundary', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_REJECT_PROMPT: '1' } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  await assert.rejects(runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: '' }), { error_code: 'invalid_args' }); assert.equal(runtime.sessions.get(session.session_id).active, null);
  const allocated = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'rejected upstream' }); assert.ok(allocated.turn_id);
  const terminal = await waitTerminal(runtime, session.session_id, allocated.turn_id, allocated.last_event_id); assert.equal(terminal.turn_status, 'failed'); await runtime.sessions.get(session.session_id).shutdownPromise;
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).session_state, 'tombstone');
});

test('warning scenarios: future and stale event cursors are distinguished', async (t) => {
  const runtime = withFake(t, { pending: 'question' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'cursor' }); const record = runtime.sessions.get(session.session_id);
  await assert.rejects(runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: record.nextEvent, timeout_ms: 1_000 }), { error_code: 'invalid_args' });
  for (let index = 0; index < LIMITS.events + 1; index += 1) record.emit('lifecycle', null, { scope: 'session', from: 'live', to: 'live' });
  const stale = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: 0, timeout_ms: 1_000 }); assert.equal(stale.events_lost, true); assert.ok(stale.earliest_event_id > 1);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('warning scenarios: a late ACP result cannot rewrite a cancelled turn', async (t) => {
  const runtime = withFake(t); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const record = runtime.sessions.get(session.session_id); const originalRequest = record.request.bind(record); let resolvePrompt;
  record.request = (method, params) => method === 'session/prompt' ? new Promise((resolve) => { resolvePrompt = resolve; }) : originalRequest(method, params);
  const allocated = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'late' }); const active = record.active; await record.terminalize(active, 'cancelled', 'cancelled'); const before = record.snapshot(record.last);
  resolvePrompt({ text: 'too late' }); await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(record.snapshot(record.last), before); assert.equal(record.last.turn_status, 'cancelled'); assert.equal(allocated.turn_id, record.last.turn_id);
});

test('warning scenarios: allowed roots distinguish absent, empty and malformed configuration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-roots-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const unrestricted = withFake(t, { roots: null }); const admitted = await unrestricted.call('cursor_start_session', { cwd: root, mode: 'ask' }); assert.equal(admitted.session_state, 'live'); await unrestricted.call('cursor_close_session', { session_id: admitted.session_id });
  const denied = new Runtime({ roots: [] }); await assert.rejects(denied.call('cursor_start_session', { cwd: root, mode: 'ask' }), { error_code: 'scope_rejected' }); assert.equal(denied.sessions.size, 0);
  const previous = process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS; process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS = '{malformed';
  try { assert.throws(() => new Runtime(), /JSON array/); } finally { previous === undefined ? delete process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS : process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS = previous; }
});

test('warning scenarios: tombstone eviction is TTL-first then deterministic by timestamp and ID', () => {
  const expiredRuntime = new Runtime({ roots: null }); const now = Date.now(); expiredRuntime.sessions.set('expired', { id: 'expired', session_state: 'tombstone', tombstonedAt: now - LIMITS.retentionMs }); expiredRuntime.sessions.set('current', { id: 'current', session_state: 'tombstone', tombstonedAt: now }); expiredRuntime.evict(); assert.equal(expiredRuntime.sessions.has('expired'), false); assert.equal(expiredRuntime.sessions.has('current'), true);
  const capped = new Runtime({ roots: null }); for (let index = LIMITS.tombstones; index >= 0; index -= 1) { const id = `tomb-${String(index).padStart(2, '0')}`; capped.sessions.set(id, { id, session_state: 'tombstone', tombstonedAt: now }); }
  capped.evict(); assert.equal(capped.sessions.size, LIMITS.tombstones); assert.equal(capped.sessions.has('tomb-00'), false); assert.equal(capped.sessions.has('tomb-01'), true);
});

test('answering one of multiple pending requests keeps the turn waiting', async (t) => {
  const runtime = withFake(t, { pending: 'two-questions' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'two questions' });
  let waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  while (waiting.active_turn.pending.length < 2) {
    waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: waiting.last_event_id, timeout_ms: 1_000 });
  }
  assert.deepEqual(waiting.active_turn.pending.map(({ request_id }) => request_id), ['q1', 'q2']);

  const remaining = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome: 'answered',
    answers: [{ question_id: 'first', selected_option_ids: ['yes'] }],
  });
  assert.equal(remaining.turn_status, 'waiting_for_input');
  assert.deepEqual(remaining.active_turn.pending.map(({ request_id }) => request_id), ['q2']);

  const resumed = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q2', outcome: 'answered',
    answers: [{ question_id: 'second', selected_option_ids: ['yes'] }],
  });
  assert.equal(resumed.turn_status, 'running');
  assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, resumed.last_event_id)).turn_status, 'completed');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('ACP result received with a pending request fails the turn and settles the request', async (t) => {
  const runtime = withFake(t, { pending: 'result-with-pending' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const record = runtime.sessions.get(session.session_id);
  const originalRespond = record.respond.bind(record);
  const responses = [];
  record.respond = (id, result) => { responses.push({ id, result }); originalRespond(id, result); };
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'premature result' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.match(terminal.last_terminal_turn.terminal_reason.text, /ACP result with pending request/);
  assert.deepEqual(terminal.last_terminal_turn.pending, []);
  assert.deepEqual(responses, [{ id: 'q1', result: { outcome: { outcome: 'cancelled' } } }]);
});

test('close during starting wins over a late initialize result', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_DELAY_INIT_MS: '250' } });
  const startingPromise = runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  let record;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    record = [...runtime.sessions.values()][0];
    if (record?.rpc.size) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(record?.session_state, 'starting');
  const rpcId = [...record.rpc.keys()][0];
  const closed = await runtime.call('cursor_close_session', { session_id: record.id });
  assert.equal(closed.session_state, 'tombstone');
  const before = record.envelope();
  record.receive(JSON.stringify({ jsonrpc: '2.0', id: Number(rpcId), result: { protocolVersion: 1 } }));
  assert.deepEqual(record.envelope(), before);
  assert.equal((await startingPromise).session_state, 'tombstone');
});

test('child exit after a completed turn tombstones the session without rewriting the turn', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_EXIT_AFTER_RESULT: '1' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'complete then exit' });
  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(completed.turn_status, 'completed');
  let status = completed;
  for (let attempts = 0; attempts < 100 && status.session_state !== 'tombstone'; attempts += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    status = await runtime.call('cursor_session_status', { session_id: session.session_id });
  }
  assert.equal(status.session_state, 'tombstone');
  assert.equal(status.last_terminal_turn.turn_status, 'completed');
  assert.deepEqual(status.last_terminal_turn.result, completed.last_terminal_turn.result);
});

test('close is repeatable for a retained tombstone', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const first = await runtime.call('cursor_close_session', { session_id: session.session_id });
  const second = await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.equal(first.session_state, 'tombstone');
  assert.deepEqual(second, first);
  assert.equal(runtime.live.size, 0);
});

test('concurrent shutdown callers join the same promise', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const record = runtime.sessions.get(session.session_id);
  const first = record.shutdown(null, 'concurrent close');
  const second = record.shutdown(null, 'ignored duplicate reason');
  assert.strictEqual(second, first);
  await Promise.all([first, second]);
  assert.equal(record.session_state, 'tombstone');
  assert.equal(record.terminal_reason.text, 'concurrent close');
});

test('MCP server exits cleanly on stdin EOF, SIGINT and SIGTERM', async (t) => {
  for (const termination of ['eof', 'SIGINT', 'SIGTERM']) {
    await t.test(termination, async () => {
      const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = waitForExit(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
      const initialized = JSON.parse(await waitForLine(child.stdout));
      assert.equal(initialized.id, 1);
      if (termination === 'eof') child.stdin.end();
      else child.kill(termination);
      assert.deepEqual(await exited, { code: 0, signal: null });
    });
  }
});

test('idle TTL tombstones an inactive live session', async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  let expireIdle;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === LIMITS.idleMs) { expireIdle = () => callback(...args); return { idleFixture: true }; }
    return originalSetTimeout(callback, delay, ...args);
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(typeof expireIdle, 'function');
  expireIdle();
  globalThis.setTimeout = originalSetTimeout;
  const record = runtime.sessions.get(session.session_id);
  await record.shutdownPromise;
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(status.session_state, 'tombstone');
  assert.equal(status.terminal_reason.text, 'idle TTL expired');
});

test('tombstone TTL expires through the public status API', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
  runtime.sessions.get(session.session_id).tombstonedAt = Date.now() - LIMITS.retentionMs;
  await assert.rejects(runtime.call('cursor_session_status', { session_id: session.session_id }), { error_code: 'unknown_session' });
  assert.equal(runtime.sessions.has(session.session_id), false);
});

test('wait reports a true timeout only after its requested interval elapses', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'wait timeout' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const started = Date.now();
  const timedOut = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: waiting.last_event_id, timeout_ms: 1_000 });
  assert.equal(timedOut.wait_timeout, true);
  assert.ok(Date.now() - started >= 900);
  assert.equal(timedOut.turn_status, 'waiting_for_input');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('question skipped and cancelled outcomes preserve their adapter wire forms', async (t) => {
  for (const outcome of ['skipped', 'cancelled']) {
    const root = mkdtempSync(join(tmpdir(), `cursor-question-${outcome}-`)); t.after(() => rmSync(root, { recursive: true, force: true }));
    const log = join(root, 'wire.jsonl');
    const runtime = withFake(t, { pending: 'question', env: { FAKE_ACP_LOG: log } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: outcome });
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
    const answered = await runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id)).turn_status, 'completed');
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()).result, { outcome: { outcome } });
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }
});

test('plan and permission rejection preserve adapter-owned wire forms', async (t) => {
  const cases = [
    { pending: 'plan', mode: 'plan', tool: 'cursor_answer_plan', request_id: 'plan1', decision: 'reject', expected: { outcome: { outcome: 'rejected' } } },
    { pending: 'permission', mode: 'agent', tool: 'cursor_answer_permission', request_id: 'p1', decision: 'reject-once', expected: { outcome: { outcome: 'selected', optionId: 'opaque-reject' } } },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), `cursor-${item.pending}-reject-`)); t.after(() => rmSync(root, { recursive: true, force: true }));
    const log = join(root, 'wire.jsonl');
    const runtime = withFake(t, { pending: item.pending, env: { FAKE_ACP_LOG: log } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: item.mode });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'reject' });
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
    const answered = await runtime.call(item.tool, { session_id: session.session_id, turn_id: turn.turn_id, request_id: item.request_id, decision: item.decision });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id)).turn_status, 'completed');
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()).result, item.expected);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }
});

test('default non-override launch uses the admitted production argv', async (t) => {
  const runtime = withDefaultFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(session.session_state, 'live');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('facade creates exactly one live session and first prompt', async (t) => {
  const runtime = withFake(t);
  const delegated = await runtime.call('cursor_delegate', { cwd, mode: 'ask', prompt: 'one' });
  assert.equal(delegated.session_state, 'live');
  assert.ok(delegated.turn_id);
  await runtime.call('cursor_close_session', { session_id: delegated.session_id });
});
