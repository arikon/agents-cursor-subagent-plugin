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
const fakeEnvNames = ['CURSOR_AGENT_COMMAND', 'CURSOR_SUBAGENT_ADAPTER_ARGS', 'FAKE_ACP_PENDING', 'FAKE_ACP_CALLBACK_VARIANT', 'FAKE_ACP_FS_VARIANT', 'FAKE_ACP_LOG', 'FAKE_ACP_SAFE_EVIDENCE', 'FAKE_ACP_PATH', 'FAKE_ACP_CONTENT', 'FAKE_ACP_LINE', 'FAKE_ACP_LIMIT', 'FAKE_ACP_RESULT', 'FAKE_ACP_BAD_ADMISSION', 'FAKE_ACP_BAD_CAPABILITIES', 'FAKE_ACP_BAD_PROMPT_RESULT', 'FAKE_ACP_STOP_REASON', 'FAKE_ACP_VERSION', 'FAKE_ACP_VERSION_MODE', 'FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_EXIT_AFTER_RESULT', 'FAKE_ACP_STDOUT_EOF_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8', 'FAKE_ACP_INVALID_FRAME', 'FAKE_ACP_INIT_FRAME', 'FAKE_ACP_INIT_RESPONSE_VARIANT', 'FAKE_ACP_SESSION_VARIANT', 'FAKE_ACP_PROMPT_RESPONSE_VARIANT', 'FAKE_ACP_FRAME_VARIANT', 'FAKE_ACP_DELAY_INIT_MS', 'FAKE_ACP_DELAY_RESULT_MS', 'FAKE_ACP_IGNORE_CANCEL', 'FAKE_ACP_CRLF', 'FAKE_ACP_REQUIRE_POLICY', 'FAKE_ACP_EXPECT_DEFAULT_ARGV', 'FAKE_ACP_REJECT_PROMPT'];

function withFake(t, extra = {}) {
  const old = Object.fromEntries(fakeEnvNames.map((name) => [name, process.env[name]]));
  for (const name of fakeEnvNames) delete process.env[name];
  process.env.CURSOR_AGENT_COMMAND = process.execPath;
  process.env.FAKE_ACP_PENDING = extra.pending || '';
  process.env.FAKE_ACP_REQUIRE_POLICY = '1';
  process.env.CURSOR_SUBAGENT_ADAPTER_ARGS = JSON.stringify([fake]);
  for (const [name, value] of Object.entries(extra.env || {})) process.env[name] = value;
  const runtime = new Runtime({ roots: Object.hasOwn(extra, 'roots') ? extra.roots : [cwd] });
  t.after(() => { for (const name of fakeEnvNames) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name]; });
  return runtime;
}

function withDefaultFake(t) {
  const names = ['PATH', 'CURSOR_AGENT_COMMAND', 'CURSOR_SUBAGENT_ADAPTER_ARGS', 'FAKE_ACP_PENDING', 'FAKE_ACP_REQUIRE_POLICY', 'FAKE_ACP_EXPECT_DEFAULT_ARGV'];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  const root = mkdtempSync(join(tmpdir(), 'cursor-default-argv-'));
  const executable = join(root, 'agent');
  copyFileSync(fake, executable);
  chmodSync(executable, 0o755);
  process.env.PATH = `${root}:${old.PATH || ''}`;
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

async function waitSessionState(runtime, sessionId, expected) {
  let status;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    status = await runtime.call('cursor_session_status', { session_id: sessionId });
    if (status.session_state === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(status?.session_state, expected);
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
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

test('runtime reports spawn failure when ACP disappears after its admitted version probe', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-vanishing-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'agent');
  writeFileSync(executable, `#!${process.execPath}\nconst { unlinkSync } = require('node:fs');\nif (process.argv.includes('--version')) { unlinkSync(__filename); process.stdout.write('2026.08.25-3e8eec8\\n'); }\n`, 'utf8');
  chmodSync(executable, 0o755);

  const runtime = withFake(t);
  process.env.CURSOR_AGENT_COMMAND = executable;
  const envelope = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(envelope.session_state, 'tombstone');
  assert.equal(envelope.failure_kind, 'spawn');
});

test('adapter admission failure is an allocated init tombstone and releases capacity', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_BAD_ADMISSION: '1' } });
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.session_state, 'tombstone'); assert.equal(failed.failure_kind, 'init');
  delete process.env.FAKE_ACP_BAD_ADMISSION;
  const admitted = [];
  for (let index = 0; index < LIMITS.live; index += 1) admitted.push(await runtime.call('cursor_start_session', { cwd, mode: 'ask' }));
  assert.ok(admitted.every((session) => session.session_state === 'live'));
  for (const session of admitted) await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('actual initialize deadline produces an init_timeout tombstone', { timeout: LIMITS.initMs + 5_000 }, async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_DELAY_INIT_MS: String(LIMITS.initMs + 2_000) } });
  const started = Date.now();
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.session_state, 'tombstone');
  assert.equal(failed.failure_kind, 'init_timeout');
  assert.ok(Date.now() - started >= LIMITS.initMs - 250);
});

test('adapter admission rejects incompatible and unusable Cursor probes', async (t) => {
  const scenarios = [
    { FAKE_ACP_VERSION: '2026.08.24-old' },
    { FAKE_ACP_BAD_CAPABILITIES: '1' },
    { FAKE_ACP_VERSION_MODE: 'overflow' },
    { FAKE_ACP_VERSION_MODE: 'nonzero' },
    { FAKE_ACP_VERSION_MODE: 'invalid-utf8' },
  ];
  for (const env of scenarios) {
    const runtime = withFake(t, { env });
    const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone');
    assert.equal(failed.failure_kind, 'init');
  }
});

test('adapter admission validates session creation and ignores unrelated RPC responses', async (t) => {
  for (const variant of ['missing-id', 'missing-modes', 'incomplete-modes']) {
    const runtime = withFake(t, { env: { FAKE_ACP_SESSION_VARIANT: variant } });
    const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone', variant);
    assert.equal(failed.failure_kind, 'init', variant);
  }
  for (const variant of ['missing-payload', 'error-no-message']) {
    const runtime = withFake(t, { env: { FAKE_ACP_INIT_RESPONSE_VARIANT: variant } });
    const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone', variant);
    assert.equal(failed.failure_kind, 'init', variant);
  }
  const runtime = withFake(t, { env: { FAKE_ACP_INIT_RESPONSE_VARIANT: 'unknown-id-first' } });
  const admitted = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(admitted.session_state, 'live');
  await runtime.call('cursor_close_session', { session_id: admitted.session_id });
});

test('adapter fixture arguments fail closed before ACP admission', async (t) => {
  for (const adapterArgs of ['{malformed', '{}', '[1]']) {
    const runtime = withFake(t, { env: { CURSOR_SUBAGENT_ADAPTER_ARGS: adapterArgs } });
    const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone');
    assert.equal(failed.failure_kind, 'init');
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
});

test('runtime rejects a non-object tool argument envelope', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', null), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects an undocumented tool argument', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'ask', extra: true }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects a missing required tool argument', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects a tool argument envelope that cannot be serialized', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  const circular = {};
  circular.self = circular;
  const args = { cwd: circular, mode: 'ask' };
  await assert.rejects(runtime.call('cursor_start_session', args), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects oversized and malformed UTF-8 prompts before turn allocation', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  for (const [prompt, error_code] of [['x'.repeat(LIMITS.inputBytes + 1), 'invalid_args'], ['\ud800', 'invalid_text_encoding']]) {
    await assert.rejects(runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt }), { error_code });
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn, null);
  }
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('runtime rejects a relative working directory', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: '.', mode: 'ask' }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects a working directory that resolves to a file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-file-cwd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'content', 'utf8');
  const runtime = new Runtime({ roots: [root] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: file, mode: 'ask' }), {
    error_code: 'scope_rejected',
  });
});

test('runtime rejects a working directory outside its admitted roots', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-admitted-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'cursor-runtime-outside-root-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const runtime = new Runtime({ roots: [root] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: outside, mode: 'ask' }), {
    error_code: 'scope_rejected',
  });
});

test('runtime rejects an unsupported session mode', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'review' }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects lookup of an unknown session', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_session_status', { session_id: 'missing' }), {
    error_code: 'unknown_session',
  });
});

test('runtime rejects lookup of an unknown turn in a live session', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  await assert.rejects(runtime.call('cursor_cancel', { session_id: session.session_id, turn_id: 'missing' }), {
    error_code: 'unknown_turn',
  });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('runtime rejects a wait cursor beyond the published event stream', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  for (const after_event_id of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(runtime.call('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      after_event_id,
      timeout_ms: 1_000,
    }), { error_code: 'invalid_args' });
  }
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('runtime rejects a wait interval outside the public range', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  for (const timeout_ms of [0, 1.5, LIMITS.waitMaxMs + 1]) {
    await assert.rejects(runtime.call('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      timeout_ms,
    }), { error_code: 'invalid_args' });
  }
  await runtime.call('cursor_close_session', { session_id: session.session_id });
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
  const afterClose = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: completed.last_event_id, timeout_ms: 1_000 });
  assert.equal(closed.session_state, 'tombstone');
  assert.deepEqual(afterClose.events.map((event) => [event.kind, event.payload.scope, event.payload.to]), [
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

test('active turn normalizes malformed, failed and unrelated ACP responses', async (t) => {
  for (const variant of ['missing-payload', 'error-no-message']) {
    const runtime = withFake(t, { env: { FAKE_ACP_PROMPT_RESPONSE_VARIANT: variant } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: variant });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'failed', variant);
    assert.equal(terminal.failure_kind, null, variant);
  }
  const runtime = withFake(t, { env: { FAKE_ACP_PROMPT_RESPONSE_VARIANT: 'unknown-id-first' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ignore unrelated response' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.turn_status, 'completed');
  await runtime.call('cursor_close_session', { session_id: session.session_id });

  const crlfRuntime = withFake(t, { env: { FAKE_ACP_CRLF: '1' } });
  const crlfSession = await crlfRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const crlfTurn = await crlfRuntime.call('cursor_send_prompt', { session_id: crlfSession.session_id, prompt: 'CRLF framing' });
  assert.equal((await waitTerminal(crlfRuntime, crlfSession.session_id, crlfTurn.turn_id, crlfTurn.last_event_id)).turn_status, 'completed');
  await crlfRuntime.call('cursor_close_session', { session_id: crlfSession.session_id });
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

test('question answers reject malformed or unadvertised inputs without mutating pending state', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ask' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const cases = [
    { outcome: 'skipped', answers: [] },
    { outcome: 'not-admitted' },
    { outcome: 'answered', answers: null },
    { outcome: 'answered', answers: [null] },
    { outcome: 'answered', answers: [{ question_id: 'unknown', selected_option_ids: ['yes'] }] },
    { outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: [] }] },
    { outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes', 'no'] }] },
    { outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes', 'yes'] }] },
    { outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['not-advertised'] }] },
  ];
  for (const args of cases) {
    await assert.rejects(runtime.call('cursor_answer_question', {
      session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', ...args,
    }), { error_code: 'invalid_args' });
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.length, 1);
  }
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
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-duplicate-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'duplicate', env: { FAKE_ACP_LOG: log } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'duplicate' }); const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.active_turn.pending.length, 1); assert.equal(waiting.active_turn.pending[0].context.questions[0].prompt.text, 'First?');
  const answered = await runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }] }); await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  const duplicateError = readJsonLines(log).find((message) => message.error?.data?.error_code === 'duplicate_request');
  assert.deepEqual({ id: duplicateError.id, error_code: duplicateError.error.data.error_code }, { id: 'q1', error_code: 'duplicate_request' });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('permission decisions map to their advertised opaque IDs, not option order', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-permission-')); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'permission', env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'run' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.active_turn.pending[0].context.title.text, 'Run?'); assert.equal(waiting.active_turn.pending[0].context.tool_kind.text, 'execute'); assert.equal(waiting.active_turn.pending[0].context.locations[0].line, 1);
  for (const [name, args] of [
    ['wrong permission decision', { name: 'cursor_answer_permission', decision: 'not-admitted' }],
    ['wrong answer tool', { name: 'cursor_answer_plan', decision: 'accept' }],
  ]) {
    await assert.rejects(runtime.call(args.name, {
      session_id: session.session_id, turn_id: turn.turn_id, request_id: 'p1', decision: args.decision,
    }), { error_code: 'invalid_args' }, name);
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.length, 1);
  }
  const answered = await runtime.call('cursor_answer_permission', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'p1', decision: 'allow-once' });
  await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  const response = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.equal(response.result.outcome.optionId, 'opaque-allow');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('plan decisions use adapter-owned wire encoding and close settles pending once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-plan-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'plan', env: { FAKE_ACP_LOG: log } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'plan' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'plan' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  await assert.rejects(runtime.call('cursor_answer_plan', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan1', decision: 'defer' }), { error_code: 'invalid_args' });
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.length, 1);
  const answered = await runtime.call('cursor_answer_plan', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan1', decision: 'accept' }); await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()).result, { outcome: { outcome: 'accepted' } }); await runtime.call('cursor_close_session', { session_id: session.session_id });

  const closeRoot = mkdtempSync(join(tmpdir(), 'cursor-runtime-close-pending-')); t.after(() => rmSync(closeRoot, { recursive: true, force: true })); const closeLog = join(closeRoot, 'wire.jsonl');
  const cancelledRuntime = withFake(t, { pending: 'question', env: { FAKE_ACP_LOG: closeLog } }); const cancelledSession = await cancelledRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const cancelledTurn = await cancelledRuntime.call('cursor_send_prompt', { session_id: cancelledSession.session_id, prompt: 'ask' }); await cancelledRuntime.call('cursor_wait', { session_id: cancelledSession.session_id, turn_id: cancelledTurn.turn_id, after_event_id: cancelledTurn.last_event_id, timeout_ms: 1_000 });
  await cancelledRuntime.call('cursor_close_session', { session_id: cancelledSession.session_id });
  assert.deepEqual(readJsonLines(closeLog).filter((message) => message.id === 'q1'), [{ jsonrpc: '2.0', id: 'q1', result: { outcome: { outcome: 'cancelled' } } }]);
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

test('malformed ACP callbacks are rejected before a pending request is published', async (t) => {
  const scenarios = [
    ['invalid-question', 'missing-questions'],
    ['invalid-question', 'null-question'],
    ['invalid-question', 'empty-question-id'],
    ['invalid-question', 'empty-options'],
    ['invalid-question', 'duplicate-question'],
    ['invalid-question', 'duplicate-option'],
    ['invalid-question', 'empty-option-id'],
    ['invalid-question', 'invalid-question-text'],
    ['invalid-question', 'invalid-option-label'],
    ['invalid-question', 'null-option'],
    ['invalid-question', 'invalid-multiplicity'],
    ['invalid-permission', 'session-mismatch'],
    ['invalid-permission', 'missing-tool-call'],
    ['invalid-permission', 'empty-tool-call-id'],
    ['invalid-permission', 'duplicate-semantic-option'],
    ['invalid-permission', 'missing-options'],
    ['invalid-permission', 'empty-option-id'],
    ['invalid-permission', 'invalid-option-label'],
    ['invalid-permission', 'missing-semantic-option'],
    ['invalid-permission', 'unsupported-option-kind'],
    ['invalid-permission', 'invalid-locations'],
    ['invalid-permission', 'invalid-location-path'],
    ['invalid-permission', 'invalid-location'],
  ];
  for (const [pending, variant] of scenarios) await t.test(`${pending}:${variant}`, async (t) => {
    const runtime = withFake(t, { pending, env: { FAKE_ACP_CALLBACK_VARIANT: variant } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'reject malformed callback' });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.deepEqual(terminal.last_terminal_turn.pending, []);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
});

test('optional ACP callback fields are normalized into stable public pending forms', async (t) => {
  const questionRuntime = withFake(t, { pending: 'question-optional' });
  const questionSession = await questionRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const questionTurn = await questionRuntime.call('cursor_send_prompt', { session_id: questionSession.session_id, prompt: 'optional question' });
  const questionWaiting = await questionRuntime.call('cursor_wait', { session_id: questionSession.session_id, turn_id: questionTurn.turn_id, after_event_id: questionTurn.last_event_id, timeout_ms: 1_000 });
  assert.equal(questionWaiting.active_turn.pending[0].context.title.text, 'Continue');
  assert.equal(questionWaiting.active_turn.pending[0].context.questions[0].prompt.text, 'Continue?');
  assert.equal(questionWaiting.active_turn.pending[0].context.questions[0].allow_multiple, true);
  const questionAnswered = await questionRuntime.call('cursor_answer_question', { session_id: questionSession.session_id, turn_id: questionTurn.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes', 'no'] }] });
  assert.equal((await waitTerminal(questionRuntime, questionSession.session_id, questionTurn.turn_id, questionAnswered.last_event_id)).turn_status, 'completed');
  await questionRuntime.call('cursor_close_session', { session_id: questionSession.session_id });

  const permissionRuntime = withFake(t, { pending: 'permission-optional' });
  const permissionSession = await permissionRuntime.call('cursor_start_session', { cwd, mode: 'agent' });
  const permissionTurn = await permissionRuntime.call('cursor_send_prompt', { session_id: permissionSession.session_id, prompt: 'optional permission' });
  const permissionWaiting = await permissionRuntime.call('cursor_wait', { session_id: permissionSession.session_id, turn_id: permissionTurn.turn_id, after_event_id: permissionTurn.last_event_id, timeout_ms: 1_000 });
  assert.equal(permissionWaiting.active_turn.pending[0].context.title.text, 'Permission request');
  assert.equal(permissionWaiting.active_turn.pending[0].context.tool_kind, null);
  assert.equal(Object.hasOwn(permissionWaiting.active_turn.pending[0].context, 'locations'), false);
  const permissionAnswered = await permissionRuntime.call('cursor_answer_permission', { session_id: permissionSession.session_id, turn_id: permissionTurn.turn_id, request_id: 'p1', decision: 'reject-once' });
  assert.equal((await waitTerminal(permissionRuntime, permissionSession.session_id, permissionTurn.turn_id, permissionAnswered.last_event_id)).turn_status, 'completed');
  await permissionRuntime.call('cursor_close_session', { session_id: permissionSession.session_id });

  const planRuntime = withFake(t, { pending: 'plan-optional' });
  const planSession = await planRuntime.call('cursor_start_session', { cwd, mode: 'plan' });
  const planTurn = await planRuntime.call('cursor_send_prompt', { session_id: planSession.session_id, prompt: 'optional plan' });
  const planWaiting = await planRuntime.call('cursor_wait', { session_id: planSession.session_id, turn_id: planTurn.turn_id, after_event_id: planTurn.last_event_id, timeout_ms: 1_000 });
  assert.equal(planWaiting.active_turn.pending[0].context.title, null);
  assert.equal(planWaiting.active_turn.pending[0].context.body.text, 'Fallback body');
  const planAnswered = await planRuntime.call('cursor_answer_plan', { session_id: planSession.session_id, turn_id: planTurn.turn_id, request_id: 'plan1', decision: 'accept' });
  assert.equal((await waitTerminal(planRuntime, planSession.session_id, planTurn.turn_id, planAnswered.last_event_id)).turn_status, 'completed');
  await planRuntime.call('cursor_close_session', { session_id: planSession.session_id });
});

test('filesystem callbacks enforce mode, containment, UTF-8, cap and ranges', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-')); t.after(() => rmSync(root, { recursive: true, force: true })); const source = join(root, 'source.txt'); const output = join(root, 'output.txt'); const log = join(root, 'wire.jsonl');
  writeFileSync(source, 'one\ntwo', 'utf8');
  const reader = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LINE: '2', FAKE_ACP_LOG: log } });
  const readSession = await reader.call('cursor_start_session', { cwd: root, mode: 'plan' }); const readTurn = await reader.call('cursor_send_prompt', { session_id: readSession.session_id, prompt: 'read' }); await waitTerminal(reader, readSession.session_id, readTurn.turn_id, readTurn.last_event_id);
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).result.content, 'two'); await reader.call('cursor_close_session', { session_id: readSession.session_id });

  const writer = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: { FAKE_ACP_PATH: output, FAKE_ACP_CONTENT: 'written' } });
  const writeSession = await writer.call('cursor_start_session', { cwd: root, mode: 'agent' }); const writeTurn = await writer.call('cursor_send_prompt', { session_id: writeSession.session_id, prompt: 'write' }); await waitTerminal(writer, writeSession.session_id, writeTurn.turn_id, writeTurn.last_event_id);
  assert.equal(readFileSync(output, 'utf8'), 'written');
  writeFileSync(output, 'replace me', 'utf8');
  const rewriteTurn = await writer.call('cursor_send_prompt', { session_id: writeSession.session_id, prompt: 'rewrite' }); await waitTerminal(writer, writeSession.session_id, rewriteTurn.turn_id, rewriteTurn.last_event_id);
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

test('filesystem callbacks normalize public failures without escaping the session root', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-errors-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-errors-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outsideRoot, { recursive: true, force: true }); });
  const source = join(root, 'source.txt');
  const symlink = join(root, 'source-link.txt');
  const outside = join(outsideRoot, 'outside.txt');
  writeFileSync(source, 'content', 'utf8');
  writeFileSync(outside, 'outside', 'utf8');
  symlinkSync(source, symlink);

  const scenarios = [
    { name: 'missing read target', pending: 'read', mode: 'plan', path: join(root, 'missing.txt'), error: 'scope_rejected' },
    { name: 'directory read target', pending: 'read', mode: 'plan', path: root, error: 'scope_rejected' },
    { name: 'relative read target', pending: 'read', mode: 'plan', path: source, variant: 'relative-path', error: 'scope_rejected' },
    { name: 'foreign callback session', pending: 'read', mode: 'plan', path: source, variant: 'session-mismatch', error: 'protocol_error' },
    { name: 'missing callback params', pending: 'read', mode: 'plan', path: source, variant: 'missing-params', error: 'protocol_error' },
    { name: 'zero line', pending: 'read', mode: 'plan', path: source, variant: 'line-zero', error: 'protocol_error' },
    { name: 'negative limit', pending: 'read', mode: 'plan', path: source, variant: 'limit-negative', error: 'protocol_error' },
    { name: 'directory write target', pending: 'write', mode: 'agent', path: root, error: 'scope_rejected' },
    { name: 'symlink write target', pending: 'write', mode: 'agent', path: symlink, error: 'scope_rejected' },
    { name: 'outside write target', pending: 'write', mode: 'agent', path: outside, error: 'scope_rejected' },
    { name: 'outside write parent', pending: 'write', mode: 'agent', path: join(outsideRoot, 'new.txt'), error: 'scope_rejected' },
    { name: 'missing write parent', pending: 'write', mode: 'agent', path: join(root, 'missing', 'output.txt'), error: 'scope_rejected' },
    { name: 'uninspectable write target', pending: 'write', mode: 'agent', path: source, variant: 'nul-path', error: 'protocol_error' },
    { name: 'invalid write text', pending: 'write', mode: 'agent', path: join(root, 'invalid.txt'), variant: 'invalid-content', error: 'invalid_text_encoding' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async (caseT) => {
    const log = join(root, `${scenario.name.replaceAll(' ', '-')}.jsonl`);
    const env = { FAKE_ACP_PATH: scenario.path, FAKE_ACP_LOG: log, ...(scenario.variant ? { FAKE_ACP_FS_VARIANT: scenario.variant } : {}) };
    const runtime = withFake(caseT, { roots: [realpathSync(root)], pending: scenario.pending, env });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: scenario.mode });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: scenario.name });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).error.data.error_code, scenario.error);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
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

test('public pending and waiter capacity limits reject only excess work', async (t) => {
  const pendingRuntime = withFake(t, { pending: 'pending-capacity' });
  const pendingSession = await pendingRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const pendingTurn = await pendingRuntime.call('cursor_send_prompt', { session_id: pendingSession.session_id, prompt: 'fill pending capacity' });
  let pendingEnvelope = await pendingRuntime.call('cursor_wait', { session_id: pendingSession.session_id, turn_id: pendingTurn.turn_id, after_event_id: pendingTurn.last_event_id, timeout_ms: 1_000 });
  while (pendingEnvelope.active_turn.pending.length < LIMITS.pending) {
    pendingEnvelope = await pendingRuntime.call('cursor_wait', { session_id: pendingSession.session_id, turn_id: pendingTurn.turn_id, after_event_id: pendingEnvelope.last_event_id, timeout_ms: 1_000 });
  }
  assert.equal(pendingEnvelope.active_turn.pending.length, LIMITS.pending);
  assert.deepEqual(pendingEnvelope.active_turn.pending.map(({ request_id }) => request_id), Array.from({ length: LIMITS.pending }, (_, index) => `q${index}`));
  await pendingRuntime.call('cursor_close_session', { session_id: pendingSession.session_id });

  const waiterRuntime = withFake(t, { pending: 'question' });
  const waiterSession = await waiterRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const waiterTurn = await waiterRuntime.call('cursor_send_prompt', { session_id: waiterSession.session_id, prompt: 'fill waiter capacity' });
  const waiting = await waiterRuntime.call('cursor_wait', { session_id: waiterSession.session_id, turn_id: waiterTurn.turn_id, after_event_id: waiterTurn.last_event_id, timeout_ms: 1_000 });
  const waiters = Array.from({ length: LIMITS.waiters + 1 }, () => waiterRuntime.call('cursor_wait', {
    session_id: waiterSession.session_id,
    turn_id: waiterTurn.turn_id,
    after_event_id: waiting.last_event_id,
    timeout_ms: LIMITS.waitMaxMs,
  }).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  ));
  await waiterRuntime.call('cursor_close_session', { session_id: waiterSession.session_id });
  const settled = await Promise.all(waiters);
  assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, LIMITS.waiters);
  const rejected = settled.filter(({ status }) => status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.error_code, 'resource_limit');
});

test('public live-session and tombstone capacity limits retain only admitted records', async (t) => {
  const liveRuntime = withFake(t);
  const live = [];
  for (let index = 0; index < LIMITS.live; index += 1) {
    live.push(await liveRuntime.call('cursor_start_session', { cwd, mode: 'ask' }));
  }
  await assert.rejects(liveRuntime.call('cursor_start_session', { cwd, mode: 'ask' }), { error_code: 'resource_limit' });
  for (const session of live) await liveRuntime.call('cursor_close_session', { session_id: session.session_id });

  const tombstoneRuntime = withFake(t);
  const tombstones = [];
  for (let index = 0; index < LIMITS.tombstones + 1; index += 1) {
    const session = await tombstoneRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
    tombstones.push(await tombstoneRuntime.call('cursor_close_session', { session_id: session.session_id }));
  }
  await assert.rejects(tombstoneRuntime.call('cursor_session_status', { session_id: tombstones[0].session_id }), { error_code: 'unknown_session' });
  assert.equal((await tombstoneRuntime.call('cursor_session_status', { session_id: tombstones.at(-1).session_id })).session_state, 'tombstone');
});

test('event eviction reports loss from cursor zero after public turns overflow retention', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  let turn;
  for (let index = 0; index < LIMITS.events + 1; index += 1) {
    turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: `turn ${index}` });
    await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  }
  const envelope = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: 0, timeout_ms: 1_000 });
  assert.equal(envelope.events_lost, true); assert.ok(envelope.earliest_event_id > 1);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('bounded result text preserves UTF-8 code points', async (t) => {
  const resultRuntime = withFake(t, { env: { FAKE_ACP_RESULT: '😀'.repeat(3_000) } }); const resultSession = await resultRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const resultTurn = await resultRuntime.call('cursor_send_prompt', { session_id: resultSession.session_id, prompt: 'result' }); const terminal = await waitTerminal(resultRuntime, resultSession.session_id, resultTurn.turn_id, resultTurn.last_event_id);
  assert.equal(terminal.last_terminal_turn.result.truncated, true); assert.equal(terminal.last_terminal_turn.result.text.includes('�'), false); assert.ok(Buffer.byteLength(terminal.last_terminal_turn.result.text, 'utf8') <= LIMITS.textBytes);
  await resultRuntime.call('cursor_close_session', { session_id: resultSession.session_id });
});

test('child exit and malformed ACP UTF-8 fail an allocated active turn', async (t) => {
  for (const variable of ['FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8']) {
    const runtime = withFake(t, { env: { [variable]: '1' } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'fail' });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id); const tombstone = await waitSessionState(runtime, session.session_id, 'tombstone'); assert.equal(tombstone.session_state, 'tombstone'); assert.equal(terminal.turn_status, 'failed'); assert.equal(terminal.failure_kind, null);
  }
});

test('oversized ACP frames and invalid agent text fail the allocated active turn', async (t) => {
  for (const variant of ['overflow-line', 'overflow-buffer', 'invalid-agent-message']) {
    const runtime = withFake(t, { env: { FAKE_ACP_FRAME_VARIANT: variant } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: variant });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'failed', variant);
    assert.equal(terminal.failure_kind, null, variant);
  }
});

test('ACP stdout EOF fails the allocated active turn', async (t) => {
  const eofRuntime = withFake(t, { env: { FAKE_ACP_STDOUT_EOF_ON_PROMPT: '1' } });
  const eofSession = await eofRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const eofTurn = await eofRuntime.call('cursor_send_prompt', { session_id: eofSession.session_id, prompt: 'stdout EOF' });
  const eofTerminal = await waitTerminal(eofRuntime, eofSession.session_id, eofTurn.turn_id, eofTurn.last_event_id);
  assert.equal(eofTerminal.turn_status, 'failed');
  assert.match(eofTerminal.last_terminal_turn.terminal_reason.text, /stdout EOF/);
  assert.equal((await waitSessionState(eofRuntime, eofSession.session_id, 'tombstone')).session_state, 'tombstone');
});

test('malformed and nonobject ACP frames follow init and active-turn failure lifecycles', async (t) => {
  for (const frame of ['{', 'null', '[]', '"text"', '{"jsonrpc":"2.0"}']) {
    const initRuntime = withFake(t, { env: { FAKE_ACP_INIT_FRAME: frame } }); const init = await initRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); assert.equal(init.session_state, 'tombstone'); assert.equal(init.failure_kind, 'init');
    const activeRuntime = withFake(t, { env: { FAKE_ACP_INVALID_FRAME: frame } }); const session = await activeRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await activeRuntime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'bad frame' }); const terminal = await waitTerminal(activeRuntime, session.session_id, turn.turn_id, turn.last_event_id); await waitSessionState(activeRuntime, session.session_id, 'tombstone'); assert.equal(terminal.turn_status, 'failed'); assert.equal(terminal.failure_kind, null);
  }
});

test('fixed resource limits remain the frozen v1 public values', () => {
  assert.deepEqual(LIMITS, {
    initMs: 15_000, turnMs: 600_000, idleMs: 900_000, waitDefaultMs: 30_000,
    waitMinMs: 1_000, waitMaxMs: 60_000, live: 8, pending: 8, waiters: 8,
    tombstones: 64, events: 256, graceMs: 5_000, retentionMs: 300_000,
    inputBytes: 64_000, textBytes: 8_000, fsBytes: 1_048_576, frameBytes: 1_048_576,
  });
});

test('warning scenarios: prompt rejection preserves allocation boundary', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_REJECT_PROMPT: '1' } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  await assert.rejects(runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: '' }), { error_code: 'invalid_args' }); assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn, null);
  const allocated = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'rejected upstream' }); assert.ok(allocated.turn_id);
  const terminal = await waitTerminal(runtime, session.session_id, allocated.turn_id, allocated.last_event_id); assert.equal(terminal.turn_status, 'failed'); await waitSessionState(runtime, session.session_id, 'tombstone');
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).session_state, 'tombstone');
});

test('turn deadline publishes timed_out before releasing the session', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_DELAY_RESULT_MS: '250' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const originalSetTimeout = globalThis.setTimeout;
  let expireTurn;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === LIMITS.turnMs) { expireTurn = () => callback(...args); return { deadlineFixture: true }; }
    return originalSetTimeout(callback, delay, ...args);
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'deadline' });
  assert.equal(turn.turn_status, 'running');
  assert.equal(typeof expireTurn, 'function');
  expireTurn();
  globalThis.setTimeout = originalSetTimeout;
  const terminal = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(terminal.turn_status, 'timed_out');
  assert.equal(terminal.last_terminal_turn.terminal_reason.text, 'turn deadline exceeded');
});

test('warning scenarios: allowed roots distinguish absent, empty and malformed configuration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-roots-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const unrestricted = withFake(t, { roots: null }); const admitted = await unrestricted.call('cursor_start_session', { cwd: root, mode: 'ask' }); assert.equal(admitted.session_state, 'live'); await unrestricted.call('cursor_close_session', { session_id: admitted.session_id });
  const denied = new Runtime({ roots: [] }); await assert.rejects(denied.call('cursor_start_session', { cwd: root, mode: 'ask' }), { error_code: 'scope_rejected' });
  const file = join(root, 'not-a-root.txt'); writeFileSync(file, 'content', 'utf8');
  const previous = process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS;
  try {
    for (const [value, pattern] of [
      ['{malformed', /JSON array/],
      ['{}', /JSON array/],
      [JSON.stringify(['relative']), /absolute/],
      [JSON.stringify([file]), /directory/],
    ]) {
      process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS = value;
      assert.throws(() => new Runtime(), pattern);
    }
  } finally { previous === undefined ? delete process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS : process.env.CURSOR_SUBAGENT_ALLOWED_ROOTS = previous; }
});

test('session rejects overlapping turns and prompts after close', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'active' });
  await assert.rejects(runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'overlap' }), { error_code: 'protocol_error' });
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(status.active_turn.turn_id, turn.turn_id);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
  await assert.rejects(runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'after close' }), { error_code: 'protocol_error' });
});

test('late ACP result cannot rewrite a publicly cancelled turn', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-late-result-')); t.after(() => rmSync(root, { recursive: true, force: true })); const evidence = join(root, 'evidence.jsonl');
  const runtime = withFake(t, { env: { FAKE_ACP_DELAY_RESULT_MS: '20', FAKE_ACP_IGNORE_CANCEL: '1', FAKE_ACP_SAFE_EVIDENCE: evidence } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'cancel before result' });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => delay === LIMITS.graceMs
    ? originalSetTimeout(callback, 100, ...args)
    : originalSetTimeout(callback, delay, ...args);
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });
  const cancelled = await runtime.call('cursor_cancel', { session_id: session.session_id, turn_id: turn.turn_id });
  globalThis.setTimeout = originalSetTimeout;
  const delivered = readJsonLines(evidence);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event, 'prompt_result');
  assert.equal(cancelled.turn_status, 'cancelled');
  assert.equal(cancelled.session_state, 'tombstone');
  assert.equal(cancelled.last_terminal_turn.terminal_reason.text, 'cancelled');
  const retained = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(retained.last_terminal_turn.turn_status, 'cancelled');
  assert.equal(retained.last_terminal_turn.result, null);
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

  await assert.rejects(runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome: 'answered',
    answers: [
      { question_id: 'first', selected_option_ids: ['yes'] },
      { question_id: 'first', selected_option_ids: ['yes'] },
    ],
  }), { error_code: 'invalid_args' });
  assert.deepEqual((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.map(({ request_id }) => request_id), ['q1', 'q2']);

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

test('ACP result received with a pending request fails the turn and clears public pending state', async (t) => {
  const runtime = withFake(t, { pending: 'result-with-pending' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'premature result' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.match(terminal.last_terminal_turn.terminal_reason.text, /ACP result with pending request/);
  assert.deepEqual(terminal.last_terminal_turn.pending, []);
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
});

test('concurrent close calls publish the same retained tombstone', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const [first, second] = await Promise.all([
    runtime.call('cursor_close_session', { session_id: session.session_id }),
    runtime.call('cursor_close_session', { session_id: session.session_id }),
  ]);
  assert.equal(first.session_state, 'tombstone');
  assert.deepEqual(second, first);
});

test('MCP server settles an active turn and exits cleanly on stdin EOF, SIGINT and SIGTERM', async (t) => {
  for (const termination of ['eof', 'SIGINT', 'SIGTERM']) {
    await t.test(termination, async () => {
      const env = { ...process.env };
      for (const name of fakeEnvNames) delete env[name];
      Object.assign(env, {
        CURSOR_AGENT_COMMAND: process.execPath,
        CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fake]),
        FAKE_ACP_PENDING: 'question',
        FAKE_ACP_REQUIRE_POLICY: '1',
      });
      const child = spawn(process.execPath, [server], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      const exited = waitForExit(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
      const initialized = JSON.parse(await waitForLine(child.stdout));
      assert.equal(initialized.id, 1);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cursor_start_session', arguments: { cwd, mode: 'ask' } } })}\n`);
      const started = JSON.parse(JSON.parse(await waitForLine(child.stdout)).result.content[0].text);
      assert.equal(started.session_state, 'live');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cursor_send_prompt', arguments: { session_id: started.session_id, prompt: 'remain active' } } })}\n`);
      const active = JSON.parse(JSON.parse(await waitForLine(child.stdout)).result.content[0].text);
      assert.equal(active.turn_status, 'running');
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
  const status = await waitSessionState(runtime, session.session_id, 'tombstone');
  assert.equal(status.session_state, 'tombstone');
  assert.equal(status.terminal_reason.text, 'idle TTL expired');
});

test('tombstone TTL expires through the public status API', async (t) => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
  now += LIMITS.retentionMs + 1;
  await assert.rejects(runtime.call('cursor_session_status', { session_id: session.session_id }), { error_code: 'unknown_session' });
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
