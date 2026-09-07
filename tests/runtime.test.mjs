import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ADAPTER, CURSOR_ADAPTER_VERSION, LIMITS, MANIFEST_VERSION, Runtime } from '../scripts/cursor-subagent-mcp.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const server = fileURLToPath(new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url));
const cursorAgentGolden = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/cursor-agent-v20260825.golden.json', import.meta.url)), 'utf8'));
const cwd = process.cwd();
const fakeEnvNames = ['CURSOR_AGENT_COMMAND', 'CURSOR_SUBAGENT_ADAPTER_ARGS', 'CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH', 'FAKE_ACP_PENDING', 'FAKE_ACP_CALLBACK_VARIANT', 'FAKE_ACP_FS_VARIANT', 'FAKE_ACP_LOG', 'FAKE_ACP_SAFE_EVIDENCE', 'FAKE_ACP_FOLLOWUP_RELEASE_PATH', 'FAKE_ACP_PATH', 'FAKE_ACP_CONTENT', 'FAKE_ACP_LINE', 'FAKE_ACP_LIMIT', 'FAKE_ACP_RESULT', 'FAKE_ACP_BAD_ADMISSION', 'FAKE_ACP_BAD_CAPABILITIES', 'FAKE_ACP_BAD_PROMPT_RESULT', 'FAKE_ACP_STOP_REASON', 'FAKE_ACP_VERSION', 'FAKE_ACP_VERSION_MODE', 'FAKE_ACP_UNLINK_COMMAND_ON_VERSION', 'FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_EXIT_AFTER_RESULT', 'FAKE_ACP_STDOUT_EOF_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8', 'FAKE_ACP_INVALID_FRAME', 'FAKE_ACP_INIT_FRAME', 'FAKE_ACP_INIT_RESPONSE_VARIANT', 'FAKE_ACP_INIT_ERROR_MESSAGE', 'FAKE_ACP_SESSION_VARIANT', 'FAKE_ACP_PROMPT_RESPONSE_VARIANT', 'FAKE_ACP_FRAME_VARIANT', 'FAKE_ACP_DELAY_INIT_MS', 'FAKE_ACP_DELAY_RESULT_MS', 'FAKE_ACP_DELAY_SET_MODE_MS', 'FAKE_ACP_IGNORE_CANCEL', 'FAKE_ACP_CRLF', 'FAKE_ACP_REQUIRE_POLICY', 'FAKE_ACP_EXPECT_DEFAULT_ARGV', 'FAKE_ACP_REJECT_PROMPT', 'FAKE_ACP_PROMPT_ERROR_MESSAGE', 'FAKE_ACP_EXPECT_MODEL_ARGV', 'FAKE_ACP_EXPECT_PLUGIN_DIRS', 'FAKE_ACP_ARGV_LOG', 'FAKE_ACP_LOAD_VARIANT', 'FAKE_ACP_PROGRESS_TEXT', 'FAKE_ACP_NOISE_UPDATES', 'FAKE_ACP_SECOND_PROGRESS_TEXT', 'FAKE_ACP_SECOND_PROGRESS_MS', 'FAKE_ACP_HOLD_PROMPT', 'FAKE_ACP_SET_MODE_LOG', 'FAKE_ACP_SET_MODE_VARIANT', 'FAKE_ACP_COLLAB'];

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

function withInjectedFake(t, extra = {}) {
  const env = isolatedFakeEnvironment({
    ...(extra.pending ? { FAKE_ACP_PENDING: extra.pending } : {}),
    ...extra.env,
  });
  const runtime = new Runtime({ env, roots: Object.hasOwn(extra, 'roots') ? extra.roots : [cwd] });
  t.after(async () => {
    for (const id of [...runtime.live]) {
      try { await runtime.call('cursor_close_session', { session_id: id }); } catch { /* already closed or transport gone */ }
    }
  });
  return runtime;
}

function isolatedFakeEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of fakeEnvNames) delete env[name];
  return { ...env, CURSOR_AGENT_COMMAND: process.execPath, FAKE_ACP_PENDING: '', FAKE_ACP_REQUIRE_POLICY: '1',
    CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fake]), ...overrides };
}

function withDefaultFake(t) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-default-argv-'));
  const executable = join(root, 'agent');
  symlinkSync(fake, executable);
  const env = isolatedFakeEnvironment({ PATH: `${root}:${process.env.PATH || ''}`, FAKE_ACP_REQUIRE_POLICY: '1', FAKE_ACP_EXPECT_DEFAULT_ARGV: '1' });
  delete env.CURSOR_AGENT_COMMAND;
  delete env.CURSOR_SUBAGENT_ADAPTER_ARGS;
  delete env.FAKE_ACP_PENDING;
  const runtime = new Runtime({ env, roots: [cwd] });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return runtime;
}

async function fireInitBudgetDeadline(operation) {
  const originalSetTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === LIMITS.initMs) { expire = () => callback(...args); return { deadlineFixture: true }; }
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    const pending = operation();
    assert.equal(typeof expire, 'function');
    expire();
    globalThis.setTimeout = originalSetTimeout;
    return await pending;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

async function waitTerminal(runtime, sessionId, turnId, afterEventId = 0) {
  let envelope;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    envelope = await runtime.call('cursor_wait', { session_id: sessionId, turn_id: turnId, after_event_id: afterEventId, timeout_ms: 1_000 });
    afterEventId = envelope.last_event_id;
    if (!['running', 'waiting_for_input'].includes(envelope.turn_status)) {
      return envelope;
    }
  }
  assert.equal(envelope?.turn_status, 'completed', `turn ${turnId} did not terminate`);
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
function lastLogged(path) {
  return readJsonLines(path).at(-1);
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
  symlinkSync(fake, executable);
  const env = isolatedFakeEnvironment({
    CURSOR_AGENT_COMMAND: executable,
    FAKE_ACP_UNLINK_COMMAND_ON_VERSION: executable,
  });
  delete env.CURSOR_SUBAGENT_ADAPTER_ARGS;
  const runtime = new Runtime({ env, roots: [cwd] });
  const envelope = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(envelope.session_state, 'tombstone');
  assert.equal(envelope.failure_kind, 'spawn');
});

test('runtime tombstones initialization when the admitted ACP process exits before replying', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-exiting-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = join(root, 'exiting-agent.mjs');
  writeFileSync(program, `
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) {
  process.stdout.write('2026.08.25-3e8eec8\\n');
  process.exit(0);
}
const stdoutKeeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], {
  stdio: ['ignore', 'inherit', 'ignore'],
});
stdoutKeeper.unref();
process.exit(7);
`, 'utf8');

  const runtime = withInjectedFake(t, {
    env: { CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([program]) },
  });
  const envelope = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(envelope.session_state, 'tombstone');
  assert.equal(envelope.failure_kind, 'init');
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

test('actual initialize deadline produces an init_timeout tombstone', async (t) => {
  const runtime = withInjectedFake(t);
  const failed = await fireInitBudgetDeadline(
    () => runtime.call('cursor_start_session', { cwd, mode: 'ask' }),
  );
  assert.equal(failed.session_state, 'tombstone');
  assert.equal(failed.failure_kind, 'init_timeout');
  assert.deepEqual(failed.terminal_reason, { text: 'init_timeout', truncated: false });
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
  for (const variant of ['missing-id', 'missing-modes', 'incomplete-modes', 'invalid-current-mode']) {
    const runtime = withFake(t, { env: { FAKE_ACP_SESSION_VARIANT: variant } });
    const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone', variant);
    assert.equal(failed.failure_kind, 'init', variant);
  }
  for (const variant of ['missing-payload', 'error-no-message', 'provider-error']) {
    const runtime = withFake(t, { env: { FAKE_ACP_INIT_RESPONSE_VARIANT: variant } });
    const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone', variant);
    assert.equal(failed.failure_kind, 'init', variant);
    if (variant === 'provider-error') assert.deepEqual(failed.provider_error, {
      code: -32001, message: { text: 'authentication required', truncated: false },
    });
  }
  const runtime = withFake(t, { env: { FAKE_ACP_INIT_RESPONSE_VARIANT: 'unknown-id-first' } });
  const admitted = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(admitted.session_state, 'live');
  await runtime.call('cursor_close_session', { session_id: admitted.session_id });

  const unadmittedMode = withInjectedFake(t, { env: { FAKE_ACP_SET_MODE_VARIANT: 'unexpected' } });
  const failedMode = await unadmittedMode.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failedMode.session_state, 'tombstone');
  assert.equal(failedMode.failure_kind, 'init');
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

test('runtime rejects an unsupported session mode before start or resume', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'review' }), {
    error_code: 'invalid_args',
  });
  await assert.rejects(runtime.call('cursor_resume_session', { cwd, cursor_session_id: 'cursor-resume', mode: 'review' }), {
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
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-unknown-turn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'wire.jsonl');
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1', FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'hold' });
  const providerMessages = readJsonLines(log).length;
  await assert.rejects(runtime.call('cursor_cancel', { session_id: session.session_id, turn_id: 'missing' }), {
    error_code: 'unknown_turn',
  });
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.turn_id, turn.turn_id);
  assert.equal(readJsonLines(log).length, providerMessages);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('runtime rejects a wait cursor beyond the published event stream', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-invalid-wait-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'wire.jsonl');
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1', FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'hold' });
  const providerMessages = readJsonLines(log).length;

  for (const args of [
    {},
    { turn_id: turn.turn_id },
    { session_id: session.session_id },
  ]) await assert.rejects(runtime.call('cursor_wait', args), { error_code: 'invalid_args' });
  await assert.rejects(runtime.call('cursor_wait', {
    session_id: 'missing', turn_id: turn.turn_id,
  }), { error_code: 'unknown_session' });
  await assert.rejects(runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: 'missing',
  }), { error_code: 'unknown_turn' });
  for (const after_event_id of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(runtime.call('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      after_event_id,
      timeout_ms: 1_000,
    }), { error_code: 'invalid_args' });
  }
  for (const after_progress_revision of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(runtime.call('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      after_progress_revision,
      timeout_ms: 1_000,
    }), { error_code: 'invalid_args' });
  }

  const status = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(status.active_turn.turn_id, turn.turn_id);
  assert.equal(status.active_turn.turn_status, 'running');
  assert.equal(readJsonLines(log).length, providerMessages);

  const waited = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id, after_event_id: 0, timeout_ms: 1_000,
  });
  assert.equal(waited.turn_status, 'running');
  assert.equal(waited.wait_timeout, false);
  assert.equal(readJsonLines(log).length, providerMessages);
  const closed = await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.equal(closed.session_state, 'tombstone');
  assert.equal(closed.turn_status, 'cancelled');
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
  assert.equal(completed.result.text, 'from session update');
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
  assert.match(terminal.terminal_reason.text, /prompt response is not admitted/);
});

test('active turn normalizes malformed, failed and unrelated ACP responses', async (t) => {
  for (const variant of ['missing-payload', 'error-no-message', 'dual-result-error']) {
    const runtime = withFake(t, { env: { FAKE_ACP_PROMPT_RESPONSE_VARIANT: variant } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: variant });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'failed', variant);
    assert.equal(Object.hasOwn(terminal, 'failure_kind'), false, variant);
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).failure_kind, null, variant);
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
  assert.match(terminal.terminal_reason.text, /prompt response is not admitted/);
});

test('pending request is turn-addressed and answer restores running state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-question-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'question', env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ask' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.turn_status, 'waiting_for_input');
  const pending = waiting.pending[0];
  const answered = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: pending.request_id,
    outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }],
  });
  assert.equal(answered.turn_status, 'running');
  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  assert.equal(completed.turn_status, 'completed');
  assert.deepEqual(lastLogged(log).result, { outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['yes'] }] } });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('explicit fake-ACP program mode sequences pending, effect and terminal steps', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-program-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json');
  const evidencePath = join(root, 'observations.jsonl');
  const outputPath = join(root, 'result.txt');
  writeFileSync(programPath, JSON.stringify({
    kind: 'fake-acp',
    steps: [
      {
        type: 'pending', request_kind: 'question', step_id: 'question-1', callback_id: 'q-1',
        question_id: 'q', prompt: 'Continue?', options: [{ id: 'choice-1', label: 'Yes' }],
        expected_callback: { kind: 'answer', option_ids: ['choice-1'] },
      },
      {
        type: 'pending', request_kind: 'plan', step_id: 'plan-1', callback_id: 'plan-1', plan_text: 'Do it',
        expected_callback: { kind: 'decision', decision: 'accept' },
      },
      {
        type: 'pending', request_kind: 'permission', step_id: 'permission-1', callback_id: 'permission-1',
        action: { operation: 'write', path: 'result.txt' }, choices: ['allow-once', 'reject-once'],
        expected_callback: { kind: 'decision', decision: 'allow-once' },
      },
      {
        type: 'effect', step_id: 'effect-1', callback_id: 'write-1', operation: 'write',
        path: 'result.txt', text: 'written', expected_callback: { kind: 'write-result', outcome: 'succeeded' },
      },
      { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'CURSOR_EVAL_OK' },
    ],
  }));
  const runtime = withInjectedFake(t, { roots: [realpathSync(root)], env: {
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    FAKE_ACP_SAFE_EVIDENCE: evidencePath,
  } });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'agent' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'run program' });

  let state = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(state.pending[0].kind, 'question');
  state = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q-1', outcome: 'answered',
    answers: [{ question_id: 'q', selected_option_ids: ['choice-1'] }],
  });
  state = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: state.last_event_id, timeout_ms: 1_000 });
  assert.equal(state.pending[0].kind, 'plan');
  state = await runtime.call('cursor_answer_plan', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan-1', decision: 'accept',
  });
  state = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: state.last_event_id, timeout_ms: 1_000 });
  assert.equal(state.pending[0].kind, 'permission');
  state = await runtime.call('cursor_answer_permission', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'permission-1', decision: 'allow-once',
  });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, state.last_event_id);

  assert.equal(terminal.turn_status, 'completed');
  assert.equal(terminal.result.text, 'CURSOR_EVAL_OK');
  assert.equal(readFileSync(outputPath, 'utf8'), 'written');
  assert.deepEqual(readJsonLines(evidencePath).filter((entry) => entry.kind), [
    { kind: 'answer', step_id: 'question-1', callback_id: 'q-1', option_ids: ['choice-1'] },
    { kind: 'decision', step_id: 'plan-1', callback_id: 'plan-1', decision: 'accept' },
    { kind: 'decision', step_id: 'permission-1', callback_id: 'permission-1', decision: 'allow-once' },
    { kind: 'write-result', step_id: 'effect-1', callback_id: 'write-1', outcome: 'succeeded' },
    { kind: 'effect.file-written', step_id: 'effect-1', callback_id: 'write-1' },
  ]);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('programmed fake-ACP holds terminality until the separate follow-up gate is released', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-followup-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json'); const evidencePath = join(root, 'observations.jsonl');
  const releasePath = join(root, 'followup-release');
  writeFileSync(programPath, JSON.stringify({ kind: 'fake-acp', steps: [
    { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'HELD_OK', progress_text: 'still active' },
  ] }));
  const runtime = withInjectedFake(t, { roots: [realpathSync(root)], env: {
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    FAKE_ACP_SAFE_EVIDENCE: evidencePath,
    FAKE_ACP_FOLLOWUP_RELEASE_PATH: releasePath,
  } });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'hold until follow-up' });
  const waiting = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000,
  });
  assert.equal(waiting.wait_timeout, true);
  assert.equal(readJsonLines(evidencePath).some(({ event }) => event === 'prompt_result'), false);
  writeFileSync(releasePath, 'follow-up started');
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, waiting.resume_after_event_id);
  assert.equal(terminal.result.text, 'still activeHELD_OK');
  let events = [];
  for (let attempt = 0; attempt < 100 && events.length < 3; attempt += 1) {
    events = readJsonLines(evidencePath).filter(({ event }) => event);
    if (events.length < 3) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.equal(events.length, 3);
  assert.equal(typeof events[2].request_id, 'number');
  delete events[2].request_id;
  assert.deepEqual(events, [
    { event: 'terminal_armed', step_id: 'terminal-1', turn_status: 'completed' },
    { event: 'followup_received_active', step_id: 'terminal-1' },
    { event: 'prompt_result', step_id: 'terminal-1',
      result_sha256: createHash('sha256').update('still activeHELD_OK').digest('hex') },
  ]);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('programmed event burst waits for every distinct runtime acknowledgement before terminality', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-event-burst-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json'); const evidencePath = join(root, 'observations.jsonl');
  writeFileSync(programPath, JSON.stringify({ kind: 'fake-acp', steps: [
    { type: 'event-burst', step_id: 'burst-1', count: 257 },
    { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'BURST_OK' },
  ] }));
  const runtime = withInjectedFake(t, { roots: [realpathSync(root)], env: {
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    FAKE_ACP_SAFE_EVIDENCE: evidencePath,
  } });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'acknowledge burst' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.result.text, 'BURST_OK');
  const acknowledgements = readJsonLines(evidencePath).filter(({ kind }) => kind === 'burst.ack');
  assert.equal(acknowledgements.length, 257);
  assert.equal(new Set(acknowledgements.map(({ callback_id: callbackId }) => callbackId)).size, 257);
  assert.equal(readJsonLines(evidencePath).some(({ kind }) => kind === 'callback.failure'), false);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('programmed event burst records missing, mismatched and duplicate acknowledgements', async (t) => {
  for (const [name, responses, reason] of [
    ['missing result', [{ jsonrpc: '2.0', id: 'burst:0' }], 'missing'],
    ['wrong id', [{ jsonrpc: '2.0', id: 'burst:wrong', result: {} }], 'id-mismatch'],
    ['duplicate id', [
      { jsonrpc: '2.0', id: 'burst:0', result: {} },
      { jsonrpc: '2.0', id: 'burst:0', result: {} },
    ], 'duplicate'],
  ]) {
    await t.test(name, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-event-burst-failure-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const programPath = join(root, 'program.json'); const evidencePath = join(root, 'observations.jsonl');
      writeFileSync(programPath, JSON.stringify({ kind: 'fake-acp', steps: [
        { type: 'event-burst', step_id: 'burst-1', count: 257 },
        { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'MUST_NOT_COMPLETE' },
      ] }));
      const child = spawn(process.execPath, [fake], { cwd: root,
        env: isolatedFakeEnvironment({ FAKE_ACP_REQUIRE_POLICY: '', CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, FAKE_ACP_SAFE_EVIDENCE: evidencePath }),
        stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.resume();
      const frames = [
        { jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'burst' }] } },
        ...responses,
      ];
      child.stdin.end(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`);
      await waitForExit(child);
      const failures = readJsonLines(evidencePath).filter(({ kind }) => kind === 'callback.failure');
      assert.ok(failures.some((failure) => failure.reason === reason), JSON.stringify(failures));
      assert.equal(readJsonLines(evidencePath).some(({ event }) => event === 'prompt_result'), false);
    });
  }
});

test('fake-ACP program mode records callback failures without shared environment mutation', async (t) => {
  for (const [name, response, reason] of [
    ['error', { jsonrpc: '2.0', id: 'q-1', error: { code: -1, message: 'rejected' } }, 'error'],
    ['missing result', { jsonrpc: '2.0', id: 'q-1' }, 'missing'],
    ['wrong callback id', { jsonrpc: '2.0', id: 'other', result: {} }, 'id-mismatch'],
  ]) {
    await t.test(name, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-program-failure-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const programPath = join(root, 'program.json'); const evidencePath = join(root, 'observations.jsonl');
      writeFileSync(programPath, JSON.stringify({ kind: 'fake-acp', steps: [
        { type: 'pending', request_kind: 'question', step_id: 'question-1', callback_id: 'q-1', question_id: 'q', prompt: 'Continue?', options: [{ id: 'choice-1', label: 'Yes' }], expected_callback: { kind: 'answer', option_ids: ['choice-1'] } },
        { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: null },
      ] }));
      const child = spawn(process.execPath, [fake], { cwd: root, env: isolatedFakeEnvironment({ FAKE_ACP_REQUIRE_POLICY: '', CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, FAKE_ACP_SAFE_EVIDENCE: evidencePath }), stdio: ['pipe', 'pipe', 'pipe'] });
      t.after(() => { child.kill('SIGKILL'); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: {} })}\n`);
      const pending = JSON.parse(await waitForLine(child.stdout));
      assert.deepEqual({ id: pending.id, method: pending.method }, { id: 'q-1', method: 'cursor/ask_question' });
      child.stdin.write(`${JSON.stringify(response)}\n`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const evidence = (() => { try { return readJsonLines(evidencePath); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } })();
        const failure = evidence.find(({ kind }) => kind === 'callback.failure');
        if (failure) {
          assert.deepEqual(failure, { kind: 'callback.failure', step_id: 'question-1', callback_id: 'q-1', reason });
          child.kill('SIGKILL');
          await waitForExit(child);
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      assert.fail('fake-ACP did not record callback failure');
    });
  }
});

test('fake-ACP program mode rejects malformed write success results without recording an effect', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-write-result-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json'); const evidencePath = join(root, 'observations.jsonl');
  writeFileSync(programPath, JSON.stringify({ kind: 'fake-acp', steps: [
    { type: 'effect', step_id: 'effect-1', callback_id: 'write-1', operation: 'write', path: 'result.txt', text: 'written', expected_callback: { kind: 'write-result', outcome: 'succeeded' } },
    { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'MUST_NOT_PASS_ORACLE' },
  ] }));
  const child = spawn(process.execPath, [fake], { cwd: root,
    env: isolatedFakeEnvironment({ FAKE_ACP_REQUIRE_POLICY: '', CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, FAKE_ACP_SAFE_EVIDENCE: evidencePath }),
    stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: {} })}\n`);
  const writeRequest = JSON.parse(await waitForLine(child.stdout));
  assert.deepEqual({ id: writeRequest.id, method: writeRequest.method }, { id: 'write-1', method: 'fs/write_text_file' });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'write-1', result: { unexpected: true } })}\n`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const evidence = (() => { try { return readJsonLines(evidencePath); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } })();
    if (evidence.some(({ kind }) => kind === 'callback.failure')) {
      assert.deepEqual(evidence.find(({ kind }) => kind === 'callback.failure'),
        { kind: 'callback.failure', step_id: 'effect-1', callback_id: 'write-1', reason: 'invalid-result' });
      assert.equal(evidence.some(({ kind }) => kind === 'effect.file-written'), false);
      child.kill('SIGKILL');
      await waitForExit(child);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail('fake-ACP accepted a malformed write result');
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
  assert.equal(retained.turn_status, 'completed'); assert.equal(Object.hasOwn(retained, 'active_turn'), false);
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id }); assert.equal(status.active_turn.turn_id, second.turn_id); assert.equal(status.last_terminal_turn.turn_id, terminal.turn_id);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('duplicate pending request ID is rejected without overwriting the accepted request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-duplicate-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'duplicate', env: { FAKE_ACP_LOG: log } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'duplicate' }); const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.pending.length, 1); assert.equal(waiting.pending[0].context.questions[0].prompt.text, 'First?');
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
  assert.equal(waiting.pending[0].context.title.text, 'Run?'); assert.equal(waiting.pending[0].context.tool_kind.text, 'execute'); assert.equal(waiting.pending[0].context.locations[0].line, 1);
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
  const response = lastLogged(log);
  assert.equal(response.result.outcome.optionId, 'opaque-allow');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('plan decisions use adapter-owned wire encoding and close settles pending once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-plan-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'plan', env: { FAKE_ACP_LOG: log } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'plan' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'plan' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  await assert.rejects(runtime.call('cursor_answer_plan', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan1', decision: 'defer' }), { error_code: 'invalid_args' });
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.length, 1);
  const answered = await runtime.call('cursor_answer_plan', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan1', decision: 'accept' }); await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id);
  assert.deepEqual(lastLogged(log).result, { outcome: { outcome: 'accepted' } }); await runtime.call('cursor_close_session', { session_id: session.session_id });

  for (const closedChannel of [false, true]) {
    const closeRoot = mkdtempSync(join(tmpdir(), 'cursor-runtime-close-pending-')); t.after(() => rmSync(closeRoot, { recursive: true, force: true })); const closeLog = join(closeRoot, 'wire.jsonl');
    const cancelledRuntime = withInjectedFake(t, { pending: 'question', env: { FAKE_ACP_LOG: closeLog } });
    const cancelledSession = await cancelledRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
    const cancelledTurn = await cancelledRuntime.call('cursor_send_prompt', { session_id: cancelledSession.session_id, prompt: 'ask' });
    const pending = await cancelledRuntime.call('cursor_wait', { session_id: cancelledSession.session_id, turn_id: cancelledTurn.turn_id, after_event_id: cancelledTurn.last_event_id, timeout_ms: 1_000 });
    assert.equal(pending.pending.length, 1);
    // Close the real request pipe while an interactive request is pending.
    // Public close must still settle the turn if its cancellation reply cannot be sent.
    if (closedChannel) cancelledRuntime.sessions.get(cancelledSession.session_id).child.stdin.destroy();
    const closed = await cancelledRuntime.call('cursor_close_session', { session_id: cancelledSession.session_id });
    assert.equal(closed.session_state, 'tombstone');
    const terminal = await cancelledRuntime.call('cursor_wait', { session_id: cancelledSession.session_id, turn_id: cancelledTurn.turn_id });
    assert.equal(terminal.turn_status, 'cancelled');
    assert.equal(terminal.pending?.length ?? 0, 0);
    if (!closedChannel) assert.deepEqual(readJsonLines(closeLog).filter((message) => message.id === 'q1'), [{ jsonrpc: '2.0', id: 'q1', result: { outcome: { outcome: 'cancelled' } } }]);
  }
});

test('ambiguous permission and unknown callbacks are rejected without pending publication', async (t) => {
  for (const pending of ['ambiguous-permission', 'unknown']) {
    const runtime = withFake(t, { pending });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: pending });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed'); assert.equal(Object.hasOwn(terminal, 'pending'), false);
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
    assert.equal(Object.hasOwn(terminal, 'pending'), false);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
});

test('programmed ACP question normalizes empty prompt and option label', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-empty-derived-fields-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json');
  writeFileSync(programPath, JSON.stringify({
    kind: 'fake-acp',
    steps: [
      {
        type: 'pending', request_kind: 'question', step_id: 'question-1', callback_id: 'q-1',
        question_id: 'q', prompt: '', options: [{ id: 'yes', label: '' }],
      },
      { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'done' },
    ],
  }));
  const runtime = withInjectedFake(t, {
    roots: [realpathSync(root)],
    env: { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath },
  });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'normalize empty fields' });
  const waiting = await runtime.call('cursor_wait', {
    session_id: session.session_id,
    turn_id: turn.turn_id,
    after_event_id: turn.last_event_id,
    timeout_ms: 1_000,
  });
  assert.equal(waiting.pending[0].context.questions[0].prompt.text, '');
  assert.equal(waiting.pending[0].context.questions[0].options[0].label.text, '');
  const answered = await runtime.call('cursor_answer_question', {
    session_id: session.session_id,
    turn_id: turn.turn_id,
    request_id: 'q-1',
    outcome: 'cancelled',
  });
  assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id)).turn_status, 'completed');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('ACP question callbacks reject duplicates and normalize explicit multiplicity', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-question-shape-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const emitter = join(root, 'question-emitter.mjs');
  writeFileSync(emitter, `
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  process.stdout.write('2026.08.25-3e8eec8\\n');
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const input = createInterface({ input: process.stdin });
let promptId = null;
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.method && request.id !== undefined) {
    if (promptId !== null) {
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      promptId = null;
    }
    return;
  }
  if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1,
    authMethods: [{ id: 'cursor_login' }],
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { audio: false, embeddedContext: false, image: true },
      sessionCapabilities: { list: {} },
    },
  } });
  if (request.method === 'session/new') return send({ jsonrpc: '2.0', id: request.id, result: {
    sessionId: 'fake',
    modes: { currentModeId: 'agent', availableModes: ['ask', 'plan', 'agent'].map((id) => ({ id })) },
  } });
  if (request.method === 'session/prompt') {
    promptId = request.id;
    return send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: JSON.parse(process.env.FAKE_QUESTION_PARAMS) });
  }
  if (request.method === 'session/cancel') process.exit(0);
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: {} });
});
`);

  const run = async (caseT, params) => {
    const runtime = withInjectedFake(caseT, {
      roots: [realpathSync(root)],
      env: {
        CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([emitter]),
        FAKE_QUESTION_PARAMS: JSON.stringify(params),
      },
    });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'validate question shape' });
    return { runtime, session, turn };
  };

  await t.test('duplicate question IDs', async (caseT) => {
    const question = { id: 'q', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] };
    const { runtime, session, turn } = await run(caseT, { questions: [question, { ...question }] });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.equal(Object.hasOwn(terminal, 'pending'), false);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('invalid multiplicity', async (caseT) => {
    const { runtime, session, turn } = await run(caseT, { questions: [{
      id: 'q', question: 'Continue?', allowMultiple: 'sometimes', options: [{ id: 'yes', label: 'Yes' }],
    }] });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.equal(Object.hasOwn(terminal, 'pending'), false);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('explicit single selection', async (caseT) => {
    const { runtime, session, turn } = await run(caseT, { questions: [{
      id: 'q', question: 'Continue?', allowMultiple: false, options: [{ id: 'yes', label: 'Yes' }],
    }] });
    const waiting = await runtime.call('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      after_event_id: turn.last_event_id,
      timeout_ms: 1_000,
    });
    assert.equal(waiting.pending[0].context.questions[0].allow_multiple, false);
    const answered = await runtime.call('cursor_answer_question', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      request_id: 'q1',
      outcome: 'cancelled',
    });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, answered.last_event_id)).turn_status, 'completed');
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
});

test('optional ACP callback fields are normalized into stable public pending forms', async (t) => {
  const questionRuntime = withFake(t, { pending: 'question-optional' });
  const questionSession = await questionRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const questionTurn = await questionRuntime.call('cursor_send_prompt', { session_id: questionSession.session_id, prompt: 'optional question' });
  const questionWaiting = await questionRuntime.call('cursor_wait', { session_id: questionSession.session_id, turn_id: questionTurn.turn_id, after_event_id: questionTurn.last_event_id, timeout_ms: 1_000 });
  assert.equal(questionWaiting.pending[0].context.title.text, 'Continue');
  assert.equal(questionWaiting.pending[0].context.questions[0].prompt.text, 'Continue?');
  assert.equal(questionWaiting.pending[0].context.questions[0].allow_multiple, true);
  const questionAnswered = await questionRuntime.call('cursor_answer_question', { session_id: questionSession.session_id, turn_id: questionTurn.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes', 'no'] }] });
  assert.equal((await waitTerminal(questionRuntime, questionSession.session_id, questionTurn.turn_id, questionAnswered.last_event_id)).turn_status, 'completed');
  await questionRuntime.call('cursor_close_session', { session_id: questionSession.session_id });

  const permissionRuntime = withFake(t, { pending: 'permission-optional' });
  const permissionSession = await permissionRuntime.call('cursor_start_session', { cwd, mode: 'agent' });
  const permissionTurn = await permissionRuntime.call('cursor_send_prompt', { session_id: permissionSession.session_id, prompt: 'optional permission' });
  const permissionWaiting = await permissionRuntime.call('cursor_wait', { session_id: permissionSession.session_id, turn_id: permissionTurn.turn_id, after_event_id: permissionTurn.last_event_id, timeout_ms: 1_000 });
  assert.equal(permissionWaiting.pending[0].context.title.text, 'Permission request');
  assert.equal(permissionWaiting.pending[0].context.tool_kind, null);
  assert.equal(Object.hasOwn(permissionWaiting.pending[0].context, 'locations'), false);
  const permissionAnswered = await permissionRuntime.call('cursor_answer_permission', { session_id: permissionSession.session_id, turn_id: permissionTurn.turn_id, request_id: 'p1', decision: 'reject-once' });
  assert.equal((await waitTerminal(permissionRuntime, permissionSession.session_id, permissionTurn.turn_id, permissionAnswered.last_event_id)).turn_status, 'completed');
  await permissionRuntime.call('cursor_close_session', { session_id: permissionSession.session_id });

  const planRuntime = withFake(t, { pending: 'plan-optional' });
  const planSession = await planRuntime.call('cursor_start_session', { cwd, mode: 'plan' });
  const planTurn = await planRuntime.call('cursor_send_prompt', { session_id: planSession.session_id, prompt: 'optional plan' });
  const planWaiting = await planRuntime.call('cursor_wait', { session_id: planSession.session_id, turn_id: planTurn.turn_id, after_event_id: planTurn.last_event_id, timeout_ms: 1_000 });
  assert.equal(planWaiting.pending[0].context.title, null);
  assert.equal(planWaiting.pending[0].context.body.text, 'Fallback body');
  const planAnswered = await planRuntime.call('cursor_answer_plan', { session_id: planSession.session_id, turn_id: planTurn.turn_id, request_id: 'plan1', decision: 'accept' });
  assert.equal((await waitTerminal(planRuntime, planSession.session_id, planTurn.turn_id, planAnswered.last_event_id)).turn_status, 'completed');
  await planRuntime.call('cursor_close_session', { session_id: planSession.session_id });
});

test('filesystem callbacks enforce mode, containment, UTF-8, cap and ranges', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-')); t.after(() => rmSync(root, { recursive: true, force: true })); const source = join(root, 'source.txt'); const output = join(root, 'output.txt'); const log = join(root, 'wire.jsonl');
  writeFileSync(source, 'one\ntwo', 'utf8');
  const reader = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LINE: '2', FAKE_ACP_LOG: log } });
  const readSession = await reader.call('cursor_start_session', { cwd: root, mode: 'plan' }); const readTurn = await reader.call('cursor_send_prompt', { session_id: readSession.session_id, prompt: 'read' }); await waitTerminal(reader, readSession.session_id, readTurn.turn_id, readTurn.last_event_id);
  assert.equal(lastLogged(log).result.content, 'two'); await reader.call('cursor_close_session', { session_id: readSession.session_id });

  const writer = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: { FAKE_ACP_PATH: output, FAKE_ACP_CONTENT: 'written' } });
  const writeSession = await writer.call('cursor_start_session', { cwd: root, mode: 'agent' }); const writeTurn = await writer.call('cursor_send_prompt', { session_id: writeSession.session_id, prompt: 'write' }); await waitTerminal(writer, writeSession.session_id, writeTurn.turn_id, writeTurn.last_event_id);
  assert.equal(readFileSync(output, 'utf8'), 'written');
  writeFileSync(output, 'replace me', 'utf8');
  const rewriteTurn = await writer.call('cursor_send_prompt', { session_id: writeSession.session_id, prompt: 'rewrite' }); await waitTerminal(writer, writeSession.session_id, rewriteTurn.turn_id, rewriteTurn.last_event_id);
  assert.equal(readFileSync(output, 'utf8'), 'written'); await writer.call('cursor_close_session', { session_id: writeSession.session_id });

  writeFileSync(source, Buffer.from([0xc3, 0x28])); writeFileSync(log, '');
  const malformed = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LOG: log } });
  const malformedSession = await malformed.call('cursor_start_session', { cwd: root, mode: 'plan' }); const malformedTurn = await malformed.call('cursor_send_prompt', { session_id: malformedSession.session_id, prompt: 'read' }); await waitTerminal(malformed, malformedSession.session_id, malformedTurn.turn_id, malformedTurn.last_event_id);
  assert.equal(lastLogged(log).error.data.error_code, 'invalid_text_encoding'); await malformed.call('cursor_close_session', { session_id: malformedSession.session_id });

  writeFileSync(source, Buffer.alloc(LIMITS.fsBytes + 1, 0x61)); writeFileSync(log, '');
  const oversized = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LOG: log } }); const oversizedSession = await oversized.call('cursor_start_session', { cwd: root, mode: 'plan' }); const oversizedTurn = await oversized.call('cursor_send_prompt', { session_id: oversizedSession.session_id, prompt: 'read' }); await waitTerminal(oversized, oversizedSession.session_id, oversizedTurn.turn_id, oversizedTurn.last_event_id);
  assert.equal(lastLogged(log).error.data.error_code, 'resource_limit'); await oversized.call('cursor_close_session', { session_id: oversizedSession.session_id });

  writeFileSync(log, ''); const oversizedOutput = join(root, 'oversized-output.txt');
  const oversizedWriter = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: {
    FAKE_ACP_PATH: oversizedOutput, FAKE_ACP_FS_VARIANT: 'oversized-content', FAKE_ACP_LOG: log,
  } });
  const oversizedWriteSession = await oversizedWriter.call('cursor_start_session', { cwd: root, mode: 'agent' });
  const oversizedWriteTurn = await oversizedWriter.call('cursor_send_prompt', { session_id: oversizedWriteSession.session_id, prompt: 'write oversized' });
  const oversizedWriteTerminal = await waitTerminal(oversizedWriter, oversizedWriteSession.session_id, oversizedWriteTurn.turn_id, oversizedWriteTurn.last_event_id);
  assert.equal(oversizedWriteTerminal.turn_status, 'failed');
  assert.match(oversizedWriteTerminal.terminal_reason.text, /frame limit/);
  assert.equal(Object.hasOwn(oversizedWriteTerminal, 'provider_error'), false);
  assert.equal(existsSync(oversizedOutput), false);
  await oversizedWriter.call('cursor_close_session', { session_id: oversizedWriteSession.session_id });

  writeFileSync(log, ''); const deniedOutput = join(root, 'denied.txt');
  const denied = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: { FAKE_ACP_PATH: deniedOutput, FAKE_ACP_CONTENT: 'no', FAKE_ACP_LOG: log } }); const deniedSession = await denied.call('cursor_start_session', { cwd: root, mode: 'plan' }); const deniedTurn = await denied.call('cursor_send_prompt', { session_id: deniedSession.session_id, prompt: 'write' }); await waitTerminal(denied, deniedSession.session_id, deniedTurn.turn_id, deniedTurn.last_event_id);
  assert.equal(lastLogged(log).error.data.error_code, 'scope_rejected'); assert.throws(() => readFileSync(deniedOutput)); await denied.call('cursor_close_session', { session_id: deniedSession.session_id });
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
    assert.equal(lastLogged(log).error.data.error_code, 'scope_rejected');
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }

  writeFileSync(log, '');
  const runtime = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LINE: '4', FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'plan' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'read after EOF' });
  await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.deepEqual(lastLogged(log).result, { content: '' });
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
    assert.equal(lastLogged(log).error.data.error_code, scenario.error);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
});

test('ACP callback transport handles notifications, default read ranges and a closed request channel', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-callback-transport-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const emitter = join(root, 'callback-transport-emitter.mjs');
  writeFileSync(emitter, `
import { appendFileSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  process.stdout.write('2026.08.25-3e8eec8\\n');
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const record = (message) => appendFileSync(process.env.CALLBACK_LOG, JSON.stringify(message) + '\\n');
const finish = (id) => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'done' } } } });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
};
const input = createInterface({ input: process.stdin });
let promptId = null;
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.method) {
    record(request);
    if (process.env.CALLBACK_SCENARIO === 'default-read' && request.id === 'fs-default') finish(promptId);
    return;
  }
  if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1,
    authMethods: [{ id: 'cursor_login' }],
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { audio: false, embeddedContext: false, image: true },
      sessionCapabilities: { list: {} },
    },
  } });
  if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      sessionId: 'fake',
      modes: { currentModeId: 'ask', availableModes: ['ask', 'plan', 'agent'].map((id) => ({ id })) },
    } });
    return;
  }
  if (request.method === 'session/prompt') {
    promptId = request.id;
    if (process.env.CALLBACK_SCENARIO === 'notifications') {
      send({ jsonrpc: '2.0', method: 'cursor/ask_question', params: { questions: [{ id: 'q', question: 'Ignored?', options: [{ id: 'yes', label: 'Yes' }] }] } });
      send({ jsonrpc: '2.0', method: 'fs/read_text_file', params: { sessionId: 'fake', path: process.env.CALLBACK_PATH } });
      return finish(request.id);
    }
    if (process.env.CALLBACK_SCENARIO === 'default-read') {
      return send({ jsonrpc: '2.0', id: 'fs-default', method: 'fs/read_text_file', params: { sessionId: 'fake', path: process.env.CALLBACK_PATH } });
    }
    if (process.env.CALLBACK_SCENARIO === 'late-read') {
      finish(request.id);
      return setTimeout(() => send({ jsonrpc: '2.0', id: 'fs-late', method: 'fs/read_text_file', params: { sessionId: 'fake', path: process.env.CALLBACK_PATH } }), 20);
    }
    if (process.env.CALLBACK_SCENARIO === 'closed-channel') {
      closeSync(0);
      return setTimeout(() => {
        send({ jsonrpc: '2.0', id: 'fs-closed', method: 'fs/read_text_file', params: { sessionId: 'fake', path: process.env.CALLBACK_PATH } });
        setTimeout(() => process.exit(7), 100);
      }, 20);
    }
    return;
  }
  if (request.method === 'session/cancel') process.exit(0);
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: {} });
});
`, 'utf8');

  const source = join(root, 'source.txt');
  writeFileSync(source, 'one\ntwo', 'utf8');
  const run = async (caseT, scenario) => {
    const log = join(root, `${scenario}.jsonl`);
    const runtime = withInjectedFake(caseT, { roots: [realpathSync(root)], env: {
      CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([emitter]),
      CALLBACK_SCENARIO: scenario,
      CALLBACK_PATH: source,
      CALLBACK_LOG: log,
    } });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
    return { log, runtime, session };
  };

  await t.test('callback notifications do not publish pending work or responses', async (caseT) => {
    const { log, runtime, session } = await run(caseT, 'notifications');
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'notifications' });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.equal(Object.hasOwn(terminal, 'pending'), false);
    assert.throws(() => readFileSync(log, 'utf8'));
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('omitted read range returns the complete file', async (caseT) => {
    const { log, runtime, session } = await run(caseT, 'default-read');
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'default read' });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id)).turn_status, 'completed');
    assert.deepEqual(readJsonLines(log)[0].result, { content: 'one\ntwo' });
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('filesystem callback after turn completion is rejected', async (caseT) => {
    const { log, runtime, session } = await run(caseT, 'late-read');
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'late read' });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id)).turn_status, 'completed');
    let response;
    for (let attempts = 0; attempts < 100 && !response; attempts += 1) {
      try { response = readJsonLines(log).find(({ id }) => id === 'fs-late'); } catch {}
      if (!response) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(response.error.data.error_code, 'protocol_error');
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).session_state, 'live');
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('closed ACP request channel fails an allocated turn', async (caseT) => {
    const { runtime, session } = await run(caseT, 'closed-channel');
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'closed channel' });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'failed');
    assert.match(terminal.terminal_reason.text, /stdin EPIPE/);
    assert.equal((await waitSessionState(runtime, session.session_id, 'tombstone')).session_state, 'tombstone');
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
  assert.equal(Object.hasOwn(terminal, 'pending'), false);
  assert.equal(lastLogged(log).error.data.error_code, 'resource_limit');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('public pending and waiter capacity limits reject only excess work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-pending-capacity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'wire.jsonl');
  const pendingRuntime = withFake(t, { pending: 'pending-capacity', env: { FAKE_ACP_LOG: log } });
  const pendingSession = await pendingRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const pendingTurn = await pendingRuntime.call('cursor_send_prompt', { session_id: pendingSession.session_id, prompt: 'fill pending capacity' });
  let pendingEnvelope = await pendingRuntime.call('cursor_wait', { session_id: pendingSession.session_id, turn_id: pendingTurn.turn_id, after_event_id: pendingTurn.last_event_id, timeout_ms: 1_000 });
  while (pendingEnvelope.pending.length < LIMITS.pending) {
    pendingEnvelope = await pendingRuntime.call('cursor_wait', { session_id: pendingSession.session_id, turn_id: pendingTurn.turn_id, after_event_id: pendingEnvelope.last_event_id, timeout_ms: 1_000 });
  }
  let excessResponse;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    excessResponse = readJsonLines(log).find(({ id, error }) => id === `q${LIMITS.pending}` && error);
    if (excessResponse) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.equal(excessResponse?.error.data.error_code, 'resource_limit');
  assert.equal(pendingEnvelope.pending.length, LIMITS.pending);
  assert.deepEqual(pendingEnvelope.pending.map(({ request_id }) => request_id), Array.from({ length: LIMITS.pending }, (_, index) => `q${index}`));
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
  await assert.rejects(liveRuntime.call('cursor_resume_session', {
    cwd, cursor_session_id: 'cursor-resume-at-capacity', mode: 'ask',
  }), { error_code: 'resource_limit' });
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
  const boundary = `${'a'.repeat(7_994)}😀xyz`;
  const resultRuntime = withFake(t, { env: { FAKE_ACP_RESULT: boundary } }); const resultSession = await resultRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const resultTurn = await resultRuntime.call('cursor_send_prompt', { session_id: resultSession.session_id, prompt: 'result' }); const terminal = await waitTerminal(resultRuntime, resultSession.session_id, resultTurn.turn_id, resultTurn.last_event_id);
  assert.equal(terminal.result.truncated, true); assert.equal(Buffer.from(terminal.result.text, 'utf8').toString('utf8'), terminal.result.text); assert.ok(Buffer.byteLength(terminal.result.text, 'utf8') <= LIMITS.textBytes);
  await resultRuntime.call('cursor_close_session', { session_id: resultSession.session_id });

  const providerRuntime = withFake(t, { env: { FAKE_ACP_INIT_RESPONSE_VARIANT: 'provider-error', FAKE_ACP_INIT_ERROR_MESSAGE: boundary } });
  const failed = await providerRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.provider_error.message.truncated, true);
  assert.equal(Buffer.from(failed.provider_error.message.text, 'utf8').toString('utf8'), failed.provider_error.message.text);
  assert.ok(Buffer.byteLength(failed.provider_error.message.text, 'utf8') <= LIMITS.textBytes);
});

test('full terminal result is paged without losing its Unicode tail or mutating runtime state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-full-result-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json');
  const providerLog = join(root, 'provider.jsonl');
  const full = `${'a'.repeat(7_998)}😀${'b'.repeat(8_003)}TAIL_MARKER`;
  writeFileSync(programPath, JSON.stringify({
    kind: 'fake-acp',
    steps: [{ type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: full }],
  }));
  const runtime = withInjectedFake(t, { env: {
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    FAKE_ACP_LOG: providerLog,
  } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'long result' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.result.truncated, true);
  assert.equal(terminal.result.text.includes('TAIL_MARKER'), false);
  assert.equal(terminal.terminal_receipt.result_sha256, createHash('sha256').update(terminal.result.text).digest('hex'));

  const record = runtime.sessions.get(session.session_id);
  const before = {
    eventId: record.nextEvent,
    idleTimer: record.idleTimer,
    delivered: record.terminalWaitDelivered,
    providerMessages: readJsonLines(providerLog).length,
  };
  const pages = [];
  let offset = 0;
  do {
    const page = await runtime.call('cursor_read_result', { session_id: session.session_id, turn_id: turn.turn_id, offset });
    pages.push(page);
    if (page.eof) break;
    offset = page.next_offset;
  } while (true);
  assert.equal(pages.map((page) => page.text).join(''), full);
  assert.equal(pages[0].next_offset, 7_998);
  assert.equal(pages.at(-1).text.endsWith('TAIL_MARKER'), true);
  assert.equal(pages.at(-1).total_bytes, Buffer.byteLength(full));
  assert.equal(pages.at(-1).sha256, createHash('sha256').update(full).digest('hex'));
  assert.deepEqual(await runtime.call('cursor_read_result', {
    session_id: session.session_id, turn_id: turn.turn_id, offset: pages[0].next_offset,
  }), pages[1]);
  assert.deepEqual(await runtime.call('cursor_read_result', {
    session_id: session.session_id, turn_id: turn.turn_id, offset: Buffer.byteLength(full),
  }), {
    session_id: session.session_id, turn_id: turn.turn_id, offset: Buffer.byteLength(full),
    next_offset: null, eof: true, text: '', total_bytes: Buffer.byteLength(full),
    sha256: createHash('sha256').update(full).digest('hex'),
  });
  for (const invalidOffset of [-1, 1.5, 7_999, Buffer.byteLength(full) + 1]) {
    await assert.rejects(runtime.call('cursor_read_result', {
      session_id: session.session_id, turn_id: turn.turn_id, offset: invalidOffset,
    }), { error_code: 'invalid_args' });
  }
  assert.deepEqual({
    eventId: record.nextEvent,
    idleTimer: record.idleTimer,
    delivered: record.terminalWaitDelivered,
    providerMessages: readJsonLines(providerLog).length,
  }, before);
});

test('full result read handles empty, active, null, replaced and retained closed turns', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-result-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json');
  writeFileSync(programPath, JSON.stringify({
    kind: 'fake-acp',
    steps: [{ type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: '' }],
  }));
  const emptyRuntime = withInjectedFake(t, { env: { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath } });
  const emptySession = await emptyRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const emptyTurn = await emptyRuntime.call('cursor_send_prompt', { session_id: emptySession.session_id, prompt: 'empty' });
  await waitTerminal(emptyRuntime, emptySession.session_id, emptyTurn.turn_id, emptyTurn.last_event_id);
  assert.deepEqual(await emptyRuntime.call('cursor_read_result', {
    session_id: emptySession.session_id, turn_id: emptyTurn.turn_id,
  }), {
    session_id: emptySession.session_id, turn_id: emptyTurn.turn_id, offset: 0,
    next_offset: null, eof: true, text: '', total_bytes: 0,
    sha256: createHash('sha256').update('').digest('hex'),
  });

  const activeRuntime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
  const activeSession = await activeRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const activeTurn = await activeRuntime.call('cursor_send_prompt', { session_id: activeSession.session_id, prompt: 'active' });
  await assert.rejects(activeRuntime.call('cursor_read_result', {
    session_id: activeSession.session_id, turn_id: activeTurn.turn_id,
  }), { error_code: 'protocol_error' });
  await assert.rejects(activeRuntime.call('cursor_read_result', {
    session_id: activeSession.session_id, turn_id: 'unknown-turn',
  }), { error_code: 'unknown_turn' });
  await assert.rejects(activeRuntime.call('cursor_read_result', {
    session_id: 'unknown-session', turn_id: activeTurn.turn_id,
  }), { error_code: 'unknown_session' });

  const failedRuntime = withInjectedFake(t, { env: { FAKE_ACP_REJECT_PROMPT: '1' } });
  const failedSession = await failedRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const failedTurn = await failedRuntime.call('cursor_send_prompt', { session_id: failedSession.session_id, prompt: 'fail' });
  await waitTerminal(failedRuntime, failedSession.session_id, failedTurn.turn_id, failedTurn.last_event_id);
  await assert.rejects(failedRuntime.call('cursor_read_result', {
    session_id: failedSession.session_id, turn_id: failedTurn.turn_id,
  }), { error_code: 'protocol_error' });

  const runtime = withInjectedFake(t, { env: { FAKE_ACP_RESULT: 'retained' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const first = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'first' });
  await waitTerminal(runtime, session.session_id, first.turn_id, first.last_event_id);
  const second = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'second' });
  assert.equal((await runtime.call('cursor_read_result', { session_id: session.session_id, turn_id: first.turn_id })).text, 'retained');
  await waitTerminal(runtime, session.session_id, second.turn_id, second.last_event_id);
  await assert.rejects(runtime.call('cursor_read_result', {
    session_id: session.session_id, turn_id: first.turn_id,
  }), { error_code: 'unknown_turn' });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.equal((await runtime.call('cursor_read_result', { session_id: session.session_id, turn_id: second.turn_id })).text, 'retained');
  runtime.sessions.get(session.session_id).tombstonedAt = Date.now() - LIMITS.retentionMs;
  await assert.rejects(runtime.call('cursor_read_result', {
    session_id: session.session_id, turn_id: second.turn_id,
  }), { error_code: 'unknown_session' });
});

test('retained result overflow fails explicitly without publishing a partial result', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-result-overflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exactProgramPath = join(root, 'exact-program.json');
  writeFileSync(exactProgramPath, JSON.stringify({
    kind: 'fake-acp',
    steps: [{
      type: 'terminal', step_id: 'terminal-exact', turn_status: 'completed',
      progress_text: 'a'.repeat(LIMITS.resultBytes / 2), result_text: 'b'.repeat(LIMITS.resultBytes / 2),
    }],
  }));
  const exactRuntime = withInjectedFake(t, { env: { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: exactProgramPath } });
  const exactSession = await exactRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const exactTurn = await exactRuntime.call('cursor_send_prompt', { session_id: exactSession.session_id, prompt: 'exact cap' });
  const exactTerminal = await waitTerminal(exactRuntime, exactSession.session_id, exactTurn.turn_id, exactTurn.last_event_id);
  assert.equal(exactTerminal.turn_status, 'completed');
  const exactTail = await exactRuntime.call('cursor_read_result', {
    session_id: exactSession.session_id, turn_id: exactTurn.turn_id, offset: LIMITS.resultBytes - 1,
  });
  assert.deepEqual({ text: exactTail.text, total_bytes: exactTail.total_bytes, eof: exactTail.eof }, {
    text: 'b', total_bytes: LIMITS.resultBytes, eof: true,
  });

  const programPath = join(root, 'program.json');
  writeFileSync(programPath, JSON.stringify({
    kind: 'fake-acp',
    steps: [{
      type: 'terminal', step_id: 'terminal-1', turn_status: 'completed',
      progress_text: 'a'.repeat(600_000), result_text: 'b'.repeat(500_000),
    }],
  }));
  const runtime = withInjectedFake(t, { env: { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'overflow' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.deepEqual(terminal.terminal_reason, { text: 'terminal_result_limit', truncated: false });
  assert.equal(Object.hasOwn(terminal, 'result'), false);
  assert.equal(terminal.terminal_receipt.result_sha256, null);
  assert.equal(terminal.terminal_receipt.result_truncated, false);
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(status.last_terminal_turn.result, null);
  await assert.rejects(runtime.call('cursor_read_result', {
    session_id: session.session_id, turn_id: turn.turn_id,
  }), { error_code: 'protocol_error' });
});

test('prompt response seals one immutable terminal before later same-batch updates', async (t) => {
  for (const lateText of ['late', 'x'.repeat(LIMITS.resultBytes + 1)]) {
    const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'wire order' });
    const record = runtime.sessions.get(session.session_id);
    const [promptId] = record.rpc.keys();
    assert.ok(promptId);
    record.receive(JSON.stringify({ jsonrpc: '2.0', id: Number(promptId), result: { stopReason: 'end_turn' } }));
    const receipt = structuredClone(record.last.terminal_receipt);
    record.sessionUpdate({
      params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text: lateText } } },
    });
    const terminal = await runtime.call('cursor_wait', {
      session_id: session.session_id, turn_id: turn.turn_id,
      after_event_id: turn.last_event_id, timeout_ms: 1_000,
    });
    assert.equal(terminal.turn_status, 'completed');
    assert.deepEqual(terminal.result, { text: '', truncated: false });
    assert.equal((await runtime.call('cursor_read_result', {
      session_id: session.session_id, turn_id: turn.turn_id,
    })).text, '');
    assert.equal(record.events.filter((event) => event.kind === 'result' && event.turn_id === turn.turn_id).length, 1);
    assert.deepEqual(record.last.terminal_receipt, receipt);
  }
});

test('provider error without a message seals the turn before a same-batch update', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'provider error order' });
  const record = runtime.sessions.get(session.session_id);
  const [promptId] = record.rpc.keys();
  record.receive(JSON.stringify({ jsonrpc: '2.0', id: Number(promptId), error: { code: -32000 } }));
  record.sessionUpdate({
    params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'late' } } },
  });
  const terminal = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id,
    after_event_id: turn.last_event_id, timeout_ms: 1_000,
  });
  assert.equal(terminal.turn_status, 'failed');
  assert.deepEqual(terminal.provider_error, {
    code: -32000, message: { text: 'ACP provider error', truncated: false },
  });
  assert.equal(record.events.filter((event) => event.kind === 'result' && event.turn_id === turn.turn_id).length, 1);
});

test('many small result chunks use one bounded accumulator through exact cap and overflow', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const chunk = 'x'.repeat(256);
  const update = { params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text: chunk } } } };

  const exact = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'exact small chunks' });
  const record = runtime.sessions.get(session.session_id);
  for (let index = 0; index < LIMITS.resultBytes / 256; index += 1) record.sessionUpdate(update);
  const [exactPromptId] = record.rpc.keys();
  record.receive(JSON.stringify({ jsonrpc: '2.0', id: Number(exactPromptId), result: { stopReason: 'end_turn' } }));
  const exactTerminal = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: exact.turn_id,
    after_event_id: exact.last_event_id, timeout_ms: 1_000,
  });
  assert.equal(exactTerminal.turn_status, 'completed');
  const exactTail = await runtime.call('cursor_read_result', {
    session_id: session.session_id, turn_id: exact.turn_id, offset: LIMITS.resultBytes - 1,
  });
  assert.deepEqual({ text: exactTail.text, total_bytes: exactTail.total_bytes, eof: exactTail.eof }, {
    text: 'x', total_bytes: LIMITS.resultBytes, eof: true,
  });

  const overflow = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'overflow small chunks' });
  for (let index = 0; index < LIMITS.resultBytes / 256; index += 1) record.sessionUpdate(update);
  record.sessionUpdate({ params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'y' } } } });
  const failed = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: overflow.turn_id,
    after_event_id: overflow.last_event_id, timeout_ms: 1_000,
  });
  assert.equal(failed.turn_status, 'failed');
  assert.deepEqual(failed.terminal_reason, { text: 'terminal_result_limit', truncated: false });
  assert.equal(record.events.filter((event) => event.kind === 'result' && event.turn_id === overflow.turn_id).length, 1);
});

test('child exit and malformed ACP UTF-8 fail an allocated active turn', async (t) => {
  for (const variable of ['FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8']) {
    const runtime = withFake(t, { env: { [variable]: '1' } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'fail' });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id); const tombstone = await waitSessionState(runtime, session.session_id, 'tombstone'); assert.equal(tombstone.session_state, 'tombstone'); assert.equal(terminal.turn_status, 'failed'); assert.equal(Object.hasOwn(terminal, 'failure_kind'), false); assert.equal(tombstone.failure_kind, null);
  }
});

test('oversized ACP frames and invalid agent text fail the allocated active turn', async (t) => {
  for (const variant of ['overflow-line', 'overflow-buffer', 'invalid-agent-message']) {
    const runtime = withFake(t, { env: { FAKE_ACP_FRAME_VARIANT: variant } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: variant });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.equal(terminal.turn_status, 'failed', variant);
    assert.equal(Object.hasOwn(terminal, 'failure_kind'), false, variant);
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).failure_kind, null, variant);
  }
});

test('ACP stdout EOF fails the allocated active turn', async (t) => {
  const eofRuntime = withFake(t, { env: { FAKE_ACP_STDOUT_EOF_ON_PROMPT: '1' } });
  const eofSession = await eofRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const eofTurn = await eofRuntime.call('cursor_send_prompt', { session_id: eofSession.session_id, prompt: 'stdout EOF' });
  const eofTerminal = await waitTerminal(eofRuntime, eofSession.session_id, eofTurn.turn_id, eofTurn.last_event_id);
  assert.equal(eofTerminal.turn_status, 'failed');
  assert.match(eofTerminal.terminal_reason.text, /stdout EOF/);
  assert.equal((await waitSessionState(eofRuntime, eofSession.session_id, 'tombstone')).session_state, 'tombstone');
});

test('malformed and nonobject ACP frames follow init and active-turn failure lifecycles', async (t) => {
  for (const frame of ['{', 'null', '[]', '"text"', '{"jsonrpc":"2.0"}']) {
    const initRuntime = withFake(t, { env: { FAKE_ACP_INIT_FRAME: frame } }); const init = await initRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); assert.equal(init.session_state, 'tombstone'); assert.equal(init.failure_kind, 'init');
    const activeRuntime = withFake(t, { env: { FAKE_ACP_INVALID_FRAME: frame } }); const session = await activeRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await activeRuntime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'bad frame' }); const terminal = await waitTerminal(activeRuntime, session.session_id, turn.turn_id, turn.last_event_id); const tombstone = await waitSessionState(activeRuntime, session.session_id, 'tombstone'); assert.equal(terminal.turn_status, 'failed'); assert.equal(Object.hasOwn(terminal, 'failure_kind'), false); assert.equal(tombstone.failure_kind, null);
  }
});

test('fixed resource limits remain the frozen v1 public values', () => {
  assert.deepEqual(LIMITS, {
    initMs: 15_000, turnMs: 3_600_000, idleMs: 900_000, waitDefaultMs: 30_000,
    waitMinMs: 1_000, waitMaxMs: 180_000, live: 8, pending: 8, waiters: 8,
    tombstones: 64, events: 256, graceMs: 5_000, retentionMs: 300_000,
    inputBytes: 64_000, textBytes: 8_000, progressBytes: 512, fsBytes: 1_048_576,
    resultBytes: 1_048_576, resultPageBytes: 8_000, frameBytes: 1_048_576,
  });
});

test('warning scenarios: prompt rejection preserves allocation boundary', async (t) => {
  const boundary = `${'a'.repeat(7_994)}😀xyz`;
  const runtime = withFake(t, { env: { FAKE_ACP_REJECT_PROMPT: '1', FAKE_ACP_PROMPT_ERROR_MESSAGE: boundary } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  await assert.rejects(runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: '' }), { error_code: 'invalid_args' }); assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn, null);
  const allocated = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'rejected upstream' }); assert.ok(allocated.turn_id);
  const terminal = await waitTerminal(runtime, session.session_id, allocated.turn_id, allocated.last_event_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.deepEqual(terminal.terminal_reason, { text: 'ACP provider error', truncated: false });
  assert.deepEqual({ ...terminal.terminal_receipt, last_event_id: null }, {
    session_id: session.session_id, turn_id: allocated.turn_id, turn_status: 'failed',
    last_event_id: null, result_sha256: null, result_truncated: false,
  });
  assert.ok(Number.isSafeInteger(terminal.terminal_receipt.last_event_id));
  assert.ok(terminal.terminal_receipt.last_event_id <= terminal.last_event_id);
  assert.equal(terminal.provider_error.code, -32000);
  assert.equal(terminal.provider_error.message.truncated, true);
  assert.equal(Buffer.from(terminal.provider_error.message.text, 'utf8').toString('utf8'), terminal.provider_error.message.text);
  assert.ok(Buffer.byteLength(terminal.provider_error.message.text, 'utf8') <= LIMITS.textBytes);
  await waitSessionState(runtime, session.session_id, 'tombstone');
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
  assert.equal(terminal.terminal_reason.text, 'turn deadline exceeded');
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
  assert.ok(cancelled.terminal_receipt);
  const retained = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(retained.last_terminal_turn.turn_status, 'cancelled');
  assert.equal(retained.last_terminal_turn.result, null);
});

test('answering one of multiple pending requests keeps the turn waiting', async (t) => {
  const runtime = withFake(t, { pending: 'two-questions' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'two questions' });
  let waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  while (waiting.pending.length < 2) {
    waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: waiting.last_event_id, timeout_ms: 1_000 });
  }
  assert.deepEqual(waiting.pending.map(({ request_id }) => request_id), ['q1', 'q2']);

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
  assert.deepEqual((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.map(({ request_id }) => request_id), ['q2']);

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
  assert.match(terminal.terminal_reason.text, /ACP result with pending request/);
  assert.equal(Object.hasOwn(terminal, 'pending'), false);
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
  assert.deepEqual(status.last_terminal_turn.result, completed.result);
});

test('unknown close preserves a live wrapper and valid close remains repeatable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-unknown-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'wire.jsonl');
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const providerMessages = readJsonLines(log).length;
  await assert.rejects(runtime.call('cursor_close_session', { session_id: 'missing' }), { error_code: 'unknown_session' });
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).session_state, 'live');
  assert.equal(readJsonLines(log).length, providerMessages);
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
    assert.deepEqual(lastLogged(log).result, { outcome: { outcome } });
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
    assert.deepEqual(lastLogged(log).result, item.expected);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }
});

test('parallel answer calls claim each pending request exactly once', async (t) => {
  const cases = [
    { pending: 'question', mode: 'ask', tool: 'cursor_answer_question', request_id: 'q1', args: { outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }] }, callback: 'question' },
    { pending: 'plan', mode: 'plan', tool: 'cursor_answer_plan', request_id: 'plan1', args: { decision: 'accept' }, callback: 'plan' },
    { pending: 'permission', mode: 'agent', tool: 'cursor_answer_permission', request_id: 'p1', args: { decision: 'reject-once' }, callback: 'permission' },
  ];
  for (const item of cases) await t.test(item.pending, async (caseT) => {
    const root = mkdtempSync(join(tmpdir(), `cursor-answer-race-${item.pending}-`));
    caseT.after(() => rmSync(root, { recursive: true, force: true }));
    const evidence = join(root, 'safe.jsonl');
    const runtime = withInjectedFake(caseT, { pending: item.pending, env: { FAKE_ACP_SAFE_EVIDENCE: evidence } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: item.mode });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'answer once' });
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
    const answer = { session_id: session.session_id, turn_id: turn.turn_id, request_id: item.request_id, ...item.args };
    const results = await Promise.allSettled([
      runtime.call(item.tool, answer),
      runtime.call(item.tool, answer),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason.error_code, 'unknown_request');
    await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(readJsonLines(evidence).filter(({ callback, request_id: requestId }) => callback === item.callback && requestId === item.request_id).length, 1);
  });
});

test('terminal receipt delivery stays per retained turn across a long live conversation', async (t) => {
  const runtime = withInjectedFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  for (let index = 0; index < 25; index += 1) {
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: `turn ${index}` });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    assert.ok(terminal.terminal_receipt);
    const repeated = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: terminal.last_event_id, timeout_ms: 1_000 });
    assert.equal(Object.hasOwn(repeated, 'terminal_receipt'), false);
  }
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('default non-override launch uses the admitted production argv', async (t) => {
  const runtime = withDefaultFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(session.session_state, 'live', session.terminal_reason?.text);
  assert.equal(session.model, 'auto');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('Cursor Agent versioned golden owns the admitted model argv contract', () => {
  assert.equal(CURSOR_ADAPTER_VERSION, cursorAgentGolden.cursor_version);
  assert.deepEqual(Object.keys(cursorAgentGolden.provenance).sort(), [
    'absent_method_literals', 'bundle_artifacts', 'method_literal_source', 'source_commands',
  ]);
  assert.deepEqual(cursorAgentGolden.provenance.source_commands, ['agent --version', 'agent --help']);
  assert.match(cursorAgentGolden.provenance.method_literal_source, /4943\.index\.js.*sendToolExtensionNotification/);
  for (const artifact of cursorAgentGolden.provenance.bundle_artifacts) {
    assert.match(artifact.path, /^\d+\.index\.js$/);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(cursorAgentGolden.provenance.absent_method_literals, ['_session/steering', 'prompt-blocks']);
  assert.equal(cursorAgentGolden.help_contract.model_option, '--model <model>');
  assert.equal(cursorAgentGolden.help_contract.standalone_effort_option, false);
  assert.equal(cursorAgentGolden.help_contract.standalone_fast_option, false);
  assert.match(cursorAgentGolden.help_contract.force_option, /not admitted/);
  assert.deepEqual(cursorAgentGolden.acp_contract.initialize, {
    protocolVersion: 1, clientInfo: { name: 'codex-cursor-subagent-plugin', version: '0.1.0' },
    authMethodIds: ['cursor_login'], loadSession: true, steeringAdvertised: false,
  });
  assert.equal(MANIFEST_VERSION, cursorAgentGolden.acp_contract.initialize.clientInfo.version);
  assert.deepEqual(ADAPTER.initialize().clientInfo, cursorAgentGolden.acp_contract.initialize.clientInfo);
  assert.equal(ADAPTER.admitModeState({ modes: {
    currentModeId: cursorAgentGolden.acp_contract.sessionNew.currentModeId,
    availableModes: cursorAgentGolden.acp_contract.sessionNew.availableModeIds.map((id) => ({ id })),
  } }), true);
  assert.equal(ADAPTER.admitSetModeResult(cursorAgentGolden.acp_contract.sessionSetModeResult), true);
  assert.equal(cursorAgentGolden.acp_contract.sessionLoadAfterTerminal.sessionIdOmitted, true);
  assert.equal(ADAPTER.admitLoadResult({ modes: {
    currentModeId: cursorAgentGolden.acp_contract.sessionLoadAfterTerminal.currentModeId,
    availableModes: cursorAgentGolden.acp_contract.sessionLoadAfterTerminal.availableModeIds.map((id) => ({ id })),
  } }), true);
  assert.equal(ADAPTER.admitLoadResult({ sessionId: 'unexpected', modes: {
    currentModeId: 'ask', availableModes: ['agent', 'plan', 'ask'].map((id) => ({ id })),
  } }), false);
  assert.deepEqual(
    [ADAPTER.methods.todos, ADAPTER.methods.task, ADAPTER.methods.image, ADAPTER.methods.sessionLoad, ADAPTER.methods.setMode],
    cursorAgentGolden.method_literals,
  );
  assert.equal(Object.hasOwn(ADAPTER.methods, 'steer'), false);
  const taskTemplate = { toolCallId: 'type-fixture', description: 'Review', prompt: 'private prompt' };
  for (const type of cursorAgentGolden.subagent_type_contract.known) {
    assert.equal(ADAPTER.admitTask({ ...taskTemplate, subagentType: type }).type.text, type);
  }
  assert.equal(
    ADAPTER.admitTask({ ...taskTemplate, subagentType: cursorAgentGolden.subagent_type_contract.custom_example }).type.text,
    cursorAgentGolden.subagent_type_contract.custom_example.custom,
  );
  assert.equal(ADAPTER.admitTask({ ...taskTemplate, subagentType: 'critic' }), null);
  const projectionByMethod = {
    'cursor/update_todos': ADAPTER.admitTodos,
    'cursor/task': ADAPTER.admitTask,
    'cursor/generate_image': ADAPTER.admitImage,
  };
  for (const notification of cursorAgentGolden.collaboration_requests) {
    assert.deepEqual(projectionByMethod[notification.method](notification.input), notification.projection);
    assert.equal(projectionByMethod[notification.method]({ ...notification.input, secret: { nested: true } }), null);
    for (const requiredKey of notification.required_keys) {
      const missing = structuredClone(notification.input);
      delete missing[requiredKey];
      assert.equal(projectionByMethod[notification.method](missing), null, `${notification.method} accepted missing ${requiredKey}`);
    }
    if (notification.method === 'cursor/update_todos') {
      const nestedExtra = structuredClone(notification.input);
      nestedExtra.todos[0].secret = { nested: true };
      assert.equal(projectionByMethod[notification.method](nestedExtra), null);
      assert.equal(projectionByMethod[notification.method]({ ...notification.input, todos: [] }), null);
    }
  }
  for (const unconfirmedAlias of [
    () => ADAPTER.admitTask({ title: 'Subreview' }),
    () => ADAPTER.admitTask({ description: 'Subreview', taskType: 'review' }),
    () => ADAPTER.admitTask({ description: 'Subreview', prompt: '', type: 'review' }),
    () => ADAPTER.admitTask({ description: 'Subreview', prompt: '', duration: 1 }),
    () => ADAPTER.admitTask({ description: 'Subreview', prompt: '', duration_ms: 1 }),
    () => ADAPTER.admitImage({ title: 'Preview' }),
    () => ADAPTER.admitImage({ description: 'Preview', path: 'preview.png' }),
    () => ADAPTER.admitImage({ suggestedPath: 'preview.png' }),
  ]) assert.equal(unconfirmedAlias(), null);
  for (const fixture of cursorAgentGolden.argv_cases) {
    assert.deepEqual(ADAPTER.modelArgv(fixture.input), fixture.expected);
  }
  for (const fixture of cursorAgentGolden.launch_argv_cases) {
    assert.deepEqual(ADAPTER.sessionArgv(
      ADAPTER.modelArgv(fixture.input),
      ADAPTER.pluginArgv(fixture.input.plugin_dirs),
    ), fixture.expected);
  }
});

test('per-session model argv stays isolated from other sessions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-launch-argv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selectedLog = join(root, 'selected.jsonl');
  const plainLog = join(root, 'plain.jsonl');
  const selected = withInjectedFake(t, { env: {
    FAKE_ACP_EXPECT_MODEL_ARGV: JSON.stringify(['--model', 'grok-4.6[effort=high,fast=true]']),
    FAKE_ACP_ARGV_LOG: selectedLog,
  } });
  const session = await selected.call('cursor_start_session', {
    cwd, mode: 'agent', model: 'grok-4.6', effort: 'high', fast: true,
  });
  assert.equal(session.session_state, 'live');
  assert.equal(session.model, 'grok-4.6');
  assert.equal(session.effort, 'high');
  assert.equal(session.fast, true);
  assert.deepEqual(JSON.parse(readFileSync(selectedLog, 'utf8').trim().split('\n').at(-1)), [
    '--auto-review', '--sandbox', 'enabled', '--model', 'grok-4.6[effort=high,fast=true]',
  ]);
  await selected.call('cursor_close_session', { session_id: session.session_id });

  const plain = withInjectedFake(t, { env: { FAKE_ACP_ARGV_LOG: plainLog } });
  const other = await plain.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.deepEqual(JSON.parse(readFileSync(plainLog, 'utf8').trim().split('\n').at(-1)), [
    '--auto-review', '--sandbox', 'enabled', '--model', 'auto',
  ]);
  await plain.call('cursor_close_session', { session_id: other.session_id });
});

test('unknown launch properties are rejected before allocation on every public entrypoint', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'ask', unsupported_launch_option: true }), { error_code: 'invalid_args' });
  await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'agent', unsupported_launch_option: true }), { error_code: 'invalid_args' });
  await assert.rejects(runtime.call('cursor_delegate', { cwd, mode: 'agent', prompt: 'Implement', unsupported_launch_option: true }), { error_code: 'invalid_args' });
  await assert.rejects(runtime.call('cursor_resume_session', { cwd, cursor_session_id: 'cursor-1', mode: 'plan', unsupported_launch_option: true }), { error_code: 'invalid_args' });
});

test('plugin directories are canonical per-session argv without ACP mutation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-plugin-'));
  const first = join(root, 'first'); const second = join(root, 'second');
  for (const pluginRoot of [first, second]) {
    mkdirSync(join(pluginRoot, 'skills', 'fixture'), { recursive: true });
    writeFileSync(join(pluginRoot, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
    writeFileSync(join(pluginRoot, 'mcp.json'), '{"mcpServers":{}}\n');
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = withInjectedFake(t, { roots: [realpathSync(root)], env: {
    FAKE_ACP_EXPECT_PLUGIN_DIRS: JSON.stringify([realpathSync(first), realpathSync(second)]),
  } });
  const session = await runtime.call('cursor_start_session', {
    cwd: root, mode: 'ask', plugin_dirs: [first, second, first],
  });
  assert.deepEqual(session.plugin_dirs, [realpathSync(first), realpathSync(second)]);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
  const resumed = await runtime.call('cursor_resume_session', {
    cwd: root, cursor_session_id: 'cursor-plugin-resume', mode: 'ask', plugin_dirs: [first, second, first],
  });
  assert.deepEqual(resumed.plugin_dirs, [realpathSync(first), realpathSync(second)]);
  assert.equal(resumed.cursor_session_id, 'cursor-plugin-resume');
  await runtime.call('cursor_close_session', { session_id: resumed.session_id });
  for (const pluginRoot of [first, second]) {
    assert.equal(readFileSync(join(pluginRoot, 'skills', 'fixture', 'SKILL.md'), 'utf8'), '---\nname: fixture\ndescription: fixture\n---\n');
    assert.equal(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8'), '{"mcpServers":{}}\n');
  }
  assert.equal(existsSync(join(root, '.cursor', 'mcp.json')), false);
  await assert.rejects(runtime.call('cursor_start_session', { cwd: root, mode: 'ask', plugin_dirs: [] }), { error_code: 'invalid_args' });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: root, mode: 'ask', plugin_dirs: [join(root, 'missing')] }), { error_code: 'scope_rejected' });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: root, mode: 'ask', plugin_dirs: [tmpdir()] }), { error_code: 'scope_rejected' });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: root, mode: 'ask', plugin_dirs: [join(first, 'mcp.json')] }), { error_code: 'scope_rejected' });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: root, mode: 'ask', plugin_dirs: [''] }), { error_code: 'invalid_args' });
});

test('adapter rejects ambiguous nested model parameters before allocation', async () => {
  const runtime = new Runtime({ roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', {
    cwd, mode: 'ask', model: 'grok-4.6[effort=medium]', effort: 'high',
  }), { error_code: 'invalid_args' });
  await assert.rejects(runtime.call('cursor_start_session', {
    cwd, mode: 'ask', model: 'grok-4.6[fast=false]', fast: true,
  }), { error_code: 'invalid_args' });
  for (const effort of ['high,fast=true', 'high]other[', 'high=value', 'high effort']) {
    await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'ask', effort }), { error_code: 'invalid_args' });
  }
  await assert.rejects(runtime.call('cursor_start_session', {
    cwd, mode: 'ask', model: 'grok-4.6[context=1m]',
  }), { error_code: 'invalid_args' });
});

test('fake behavior provider checks prompt constraint polarity without retaining prompt text', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-prompt-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = join(root, 'program.json');
  writeFileSync(program, JSON.stringify({ kind: 'fake-acp', steps: [
    { type: 'prompt-check', step_id: 'prompt-1', required_fragments: ['local read/search is allowed', 'writes, network access, credentials, and private transcript retrieval are forbidden'], forbidden_fragments: ['writes/network/credentials/transcript retrieval are permitted'] },
    { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'done' },
  ] }));

  for (const [label, prompt, expected] of [
    ['opposite', 'Local read/search is allowed; writes/network/credentials/transcript retrieval are permitted.', false],
    ['forbidden', 'Local read/search is allowed. Writes, network access, credentials, and private transcript retrieval are forbidden.', true],
  ]) {
    const evidence = join(root, `${label}.jsonl`);
    const runtime = withInjectedFake(t, { roots: [realpathSync(root)], env: {
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: program,
      FAKE_ACP_SAFE_EVIDENCE: evidence,
    } });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt });
    await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
    const contract = readJsonLines(evidence).find(({ kind }) => kind === 'prompt.contract');
    assert.deepEqual(contract, {
      kind: 'prompt.contract', step_id: 'prompt-1', matched: expected,
      missing_fragment_indexes: expected ? [] : [1],
      forbidden_fragment_indexes: expected ? [] : [0],
    });
    assert.doesNotMatch(readFileSync(evidence, 'utf8'), /read\/search|writes\/network|private transcript/);
  }

  writeFileSync(program, JSON.stringify({ kind: 'fake-acp', steps: [
    { type: 'prompt-check', step_id: 'snapshot-1',
      required_fragments: ['do not use tools', 'do not search the workspace', 'do not inspect files after the snapshot'],
      forbidden_fragments: ['you may use tools', 'you may search the workspace', 'you may inspect files after the snapshot'] },
    { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'done' },
  ] }));
  for (const [label, prompt, expected] of [
    ['snapshot-forbidden', 'Do not use tools. Do not search the workspace. Do not inspect files after the snapshot.', true],
    ['snapshot-allowed', 'You may use tools. You may search the workspace. You may inspect files after the snapshot.', false],
  ]) {
    const evidence = join(root, `${label}.jsonl`);
    const runtime = withInjectedFake(t, { roots: [realpathSync(root)], env: {
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: program,
      FAKE_ACP_SAFE_EVIDENCE: evidence,
    } });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt });
    await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
    assert.deepEqual(readJsonLines(evidence).find(({ kind }) => kind === 'prompt.contract'), {
      kind: 'prompt.contract', step_id: 'snapshot-1', matched: expected,
      missing_fragment_indexes: expected ? [] : [0, 1, 2],
      forbidden_fragment_indexes: expected ? [] : [0, 1, 2],
    });
  }

  writeFileSync(program, JSON.stringify({ kind: 'fake-acp', steps: [
    { type: 'prompt-check', step_id: 'write-boundary-1',
      required_fragments: ['AUTHORIZED_ACTIONS: write result.txt with exact content done only.', 'NO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.'],
      forbidden_fragments: ['you may make other changes', 'continue after a required expansion'] },
    { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'done' },
  ] }));
  for (const [label, prompt, expected] of [
    ['write-bounded', 'AUTHORIZED_ACTIONS: write result.txt with exact content done only. NO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.', true],
    ['write-opposite', 'AUTHORIZED_ACTIONS: write result.txt with exact content done only. You may make other changes and continue after a required expansion.', false],
  ]) {
    const evidence = join(root, `${label}.jsonl`);
    const runtime = withInjectedFake(t, { roots: [realpathSync(root)], env: {
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: program,
      FAKE_ACP_SAFE_EVIDENCE: evidence,
    } });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'agent' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt });
    await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
    assert.deepEqual(readJsonLines(evidence).find(({ kind }) => kind === 'prompt.contract'), {
      kind: 'prompt.contract', step_id: 'write-boundary-1', matched: expected,
      missing_fragment_indexes: expected ? [] : [1],
      forbidden_fragment_indexes: expected ? [] : [0, 1],
    });
  }
});

test('resume loads the retained Cursor conversation id without requiring it in the load result', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'wire.jsonl');
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_LOG: log,
    FAKE_ACP_EXPECT_MODEL_ARGV: JSON.stringify(['--model', 'grok-4.6']),
  } });
  const session = await runtime.call('cursor_resume_session', { cwd, cursor_session_id: 'cursor-resume-1', mode: 'agent', model: 'grok-4.6' });
  assert.equal(session.session_state, 'live');
  assert.equal(session.cursor_session_id, 'cursor-resume-1');
  assert.equal(session.model, 'grok-4.6');
  assert.notEqual(session.session_id, 'cursor-resume-1');
  const methods = readJsonLines(log).map((message) => message.method);
  assert.equal(methods.includes('session/load'), true);
  assert.equal(methods.includes('session/new'), false);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('resume unexpected ID, mode-shape drift and reject stay recoverable init failures', async (t) => {
  for (const variant of ['unexpected-session-id', 'missing-modes', 'incomplete-modes', 'invalid-current-mode', 'reject']) {
    const runtime = withInjectedFake(t, { env: { FAKE_ACP_LOAD_VARIANT: variant } });
    const failed = await runtime.call('cursor_resume_session', { cwd, cursor_session_id: 'missing-cursor', mode: 'ask' });
    assert.equal(failed.session_state, 'tombstone');
    assert.equal(failed.cursor_session_id, 'missing-cursor');
    if (variant === 'reject') assert.deepEqual(failed.provider_error, {
      code: -32000, message: { text: 'session not found', truncated: false },
    });
  }

  const unadmittedMode = withInjectedFake(t, { env: { FAKE_ACP_SET_MODE_VARIANT: 'unexpected' } });
  const failedMode = await unadmittedMode.call('cursor_resume_session', { cwd, cursor_session_id: 'cursor-resume-mode', mode: 'agent' });
  assert.equal(failedMode.session_state, 'tombstone');
  assert.equal(failedMode.failure_kind, 'init');
});

test('unknown pending request returns recovery IDs without ACP answer', async (t) => {
  const cases = [
    { pending: 'question', tool: 'cursor_answer_question', liveId: 'q1', kind: 'question', args: { outcome: 'cancelled' } },
    { pending: 'plan', tool: 'cursor_answer_plan', liveId: 'plan1', kind: 'plan', args: { decision: 'accept' } },
    { pending: 'permission', tool: 'cursor_answer_permission', liveId: 'p1', kind: 'permission', args: { decision: 'allow-once' } },
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), `cursor-runtime-recovery-${scenario.kind}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const log = join(root, 'wire.jsonl');
    const runtime = withInjectedFake(t, { pending: scenario.pending, env: { FAKE_ACP_LOG: log } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: scenario.kind });
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
    await assert.rejects(runtime.call(scenario.tool, {
      session_id: session.session_id, turn_id: turn.turn_id, request_id: 'stale', ...scenario.args,
    }), (error) => {
      assert.equal(error.error_code, 'unknown_request');
      assert.deepEqual(error.recovery, {
        session_id: session.session_id, turn_id: turn.turn_id, last_event_id: error.recovery.last_event_id,
        pending: [{ request_id: scenario.liveId, kind: scenario.kind }],
      });
      assert.equal(Object.hasOwn(error.recovery.pending[0], 'context'), false);
      return true;
    });
    assert.equal(readJsonLines(log).some((message) => message.id === scenario.liveId && message.result), false);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }
});

test('terminal wait delivers a receipt once and later action acknowledgements omit the snapshot', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_RESULT: 'done' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id);
  assert.equal(completed.turn_status, 'completed');
  assert.equal(completed.result.text, 'done');
  assert.equal(Object.keys(completed).includes('last_terminal_turn'), false);
  assert.equal(completed.terminal_receipt.turn_id, turn.turn_id);
  assert.equal(completed.terminal_receipt.result_truncated, false);
  assert.equal(completed.terminal_receipt.result_sha256, createHash('sha256').update('done', 'utf8').digest('hex'));
  const firstReceipt = structuredClone(completed.terminal_receipt);

  const next = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'two' });
  assert.equal(Object.hasOwn(next, 'last_terminal_turn'), false);
  assert.deepEqual(next.terminal_receipt, firstReceipt);
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(status.last_terminal_turn.turn_id, turn.turn_id);
  assert.equal(Object.hasOwn(status, 'terminal_receipt'), false);

  const closed = await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.equal(Object.hasOwn(closed, 'last_terminal_turn'), false);
  assert.equal(closed.terminal_receipt.turn_id, next.turn_id);
  assert.equal(closed.terminal_receipt.turn_status, 'cancelled');
  await runtime.call('cursor_session_status', { session_id: session.session_id });
});

test('close preserves an undelivered retained terminal receipt and repeats it idempotently', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_RESULT: 'close-without-wait' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'complete before close' });
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await runtime.call('cursor_session_status', { session_id: session.session_id });
    if (status.last_terminal_turn?.turn_id === turn.turn_id) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(status.last_terminal_turn?.turn_status, 'completed');

  const closed = await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.equal(closed.session_state, 'tombstone');
  assert.equal(Object.hasOwn(closed, 'last_terminal_turn'), false);
  assert.equal(Object.hasOwn(closed, 'result'), false);
  assert.equal(closed.terminal_receipt.turn_id, turn.turn_id);
  assert.equal(closed.terminal_receipt.result_sha256, createHash('sha256').update('close-without-wait', 'utf8').digest('hex'));

  const repeated = await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.deepEqual(repeated.terminal_receipt, closed.terminal_receipt);
});

test('wait delta omits unchanged snapshots and empty optional fields', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'compact wait' });
  const delta = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000,
  });
  assert.deepEqual(Object.keys(delta).sort(), [
    'events', 'events_lost', 'last_event_id', 'pending', 'resume_after_event_id', 'session_id', 'session_state', 'turn_id', 'turn_status', 'wait_timeout',
  ]);
  assert.deepEqual(delta.pending, [{
    request_id: 'q1', kind: 'question', context: {
      title: null,
      questions: [{
        id: 'q', prompt: { text: 'Continue?', truncated: false },
        options: [
          { id: 'yes', label: { text: 'Yes', truncated: false } },
          { id: 'no', label: { text: 'No', truncated: false } },
        ],
        allow_multiple: false,
      }],
    },
  }]);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('mutation acknowledgements are sparse while explicit status retains the diagnostic snapshot', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'compact actions' });
  assert.deepEqual(Object.keys(turn).sort(), ['last_event_id', 'session_id', 'session_state', 'turn_id', 'turn_status']);
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const answered = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: waiting.pending[0].request_id, outcome: 'cancelled',
  });
  assert.deepEqual(Object.keys(answered).sort(), ['last_event_id', 'session_id', 'session_state', 'turn_id', 'turn_status']);
  assert.ok((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn);
  const closed = await runtime.call('cursor_close_session', { session_id: session.session_id });
  assert.equal(closed.turn_status, 'cancelled');
  assert.equal(closed.terminal_receipt.turn_id, turn.turn_id);
});

test('delegate returns one bootstrap without null launch fields', async (t) => {
  const runtime = withFake(t);
  const delegated = await runtime.call('cursor_delegate', { cwd, mode: 'ask', prompt: 'compact delegate' });
  assert.deepEqual(Object.keys(delegated).sort(), ['cursor_session_id', 'last_event_id', 'model', 'session_id', 'session_state', 'turn_id', 'turn_status']);
  await runtime.call('cursor_close_session', { session_id: delegated.session_id });
});

test('wait timeout progress excerpt advances only for accepted agent text', async (t) => {
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_HOLD_PROMPT: '1',
    FAKE_ACP_PROGRESS_TEXT: 'visible progress',
    FAKE_ACP_NOISE_UPDATES: '1',
  } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'progress' });
  const first = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(first.wait_timeout, true);
  assert.equal(first.progress_revision, 1);
  assert.equal(first.progress_excerpt.text, 'visible progress');
  assert.equal(first.progress_excerpt.truncated, false);
  assert.equal(JSON.stringify(first).includes('secret thinking'), false);
  assert.equal(JSON.stringify(first).includes('raw tool payload'), false);
  assert.equal(JSON.stringify(first).includes('acp-sessions'), false);

  const repeat = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id, after_event_id: first.resume_after_event_id,
    after_progress_revision: first.progress_revision, timeout_ms: 1_000,
  });
  assert.equal(repeat.wait_timeout, true);
  assert.equal(Object.hasOwn(repeat, 'progress_revision'), false);
  assert.equal(Object.hasOwn(repeat, 'progress_excerpt'), false);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('wait timeout progress excerpt truncates and reports a later accepted delta', async (t) => {
  const long = `${'p'.repeat(LIMITS.progressBytes - 6)}😀xyz`;
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_HOLD_PROMPT: '1',
    FAKE_ACP_PROGRESS_TEXT: long,
    FAKE_ACP_SECOND_PROGRESS_TEXT: ' later',
    FAKE_ACP_SECOND_PROGRESS_MS: '1200',
  } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'long progress' });
  const first = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  assert.equal(first.progress_excerpt.truncated, true);
  assert.ok(Buffer.byteLength(first.progress_excerpt.text, 'utf8') <= LIMITS.progressBytes);
  assert.equal(Buffer.from(first.progress_excerpt.text, 'utf8').toString('utf8'), first.progress_excerpt.text);
  const retained = runtime.sessions.get(session.session_id).active;
  assert.equal(Object.hasOwn(retained, 'progress_parts'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(retained.progress_excerpt), 'utf8') <= LIMITS.progressBytes + 64);

  let later;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    later = await runtime.call('cursor_wait', {
      session_id: session.session_id, turn_id: turn.turn_id, after_event_id: first.resume_after_event_id,
      after_progress_revision: first.progress_revision, timeout_ms: 1_000,
    });
    if (later.progress_revision > first.progress_revision) break;
  }
  assert.ok(later.progress_revision > first.progress_revision);
  assert.equal(Object.hasOwn(later, 'progress_excerpt'), true);
  assert.match(later.progress_excerpt.text, /later/);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('wait timeout without accepted agent text omits the progress excerpt', async (t) => {
  const runtime = withInjectedFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'wait timeout' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  const timedOut = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: waiting.last_event_id, timeout_ms: 1_000 });
  assert.equal(timedOut.wait_timeout, true);
  assert.equal(Object.hasOwn(timedOut, 'progress_revision'), false);
  assert.equal(Object.hasOwn(timedOut, 'progress_excerpt'), false);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('cursor_set_mode transitions a live idle session and rejects active or tombstone work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-set-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modeLog = join(root, 'set-mode.jsonl');
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_SET_MODE_LOG: modeLog,
    FAKE_ACP_EXPECT_MODEL_ARGV: JSON.stringify(['--model', 'grok-4.6']),
  } });
  await assert.rejects(runtime.call('cursor_set_mode', { session_id: 'missing', mode: 'review' }), {
    error_code: 'invalid_args',
    message: 'invalid mode: ask|plan|agent',
  });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent', model: 'grok-4.6' });
  const same = await runtime.call('cursor_set_mode', { session_id: session.session_id, mode: 'agent' });
  assert.equal(same.mode, 'agent');
  assert.equal(same.session_state, 'live');
  assert.equal(same.session_id, session.session_id);
  assert.equal(existsSync(modeLog), false);

  const planned = await runtime.call('cursor_set_mode', { session_id: session.session_id, mode: 'plan' });
  assert.equal(planned.mode, 'plan');
  assert.equal(planned.session_id, session.session_id);
  assert.deepEqual(readJsonLines(modeLog).map((message) => message.params), [{ sessionId: 'fake', modeId: 'plan' }]);

  const held = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1', FAKE_ACP_SET_MODE_LOG: join(root, 'active.jsonl') } });
  const heldSession = await held.call('cursor_start_session', { cwd, mode: 'agent' });
  const heldTurn = await held.call('cursor_send_prompt', { session_id: heldSession.session_id, prompt: 'hold' });
  await assert.rejects(held.call('cursor_set_mode', { session_id: heldSession.session_id, mode: 'ask' }), { error_code: 'protocol_error' });
  assert.equal((await held.call('cursor_session_status', { session_id: heldSession.session_id })).mode, 'agent');
  assert.equal((await held.call('cursor_session_status', { session_id: heldSession.session_id })).active_turn.turn_id, heldTurn.turn_id);
  assert.equal(existsSync(join(root, 'active.jsonl')), false);
  await held.call('cursor_close_session', { session_id: heldSession.session_id });
  await assert.rejects(held.call('cursor_set_mode', { session_id: heldSession.session_id, mode: 'ask' }), { error_code: 'protocol_error' });

  const failed = withInjectedFake(t, { env: { FAKE_ACP_SET_MODE_VARIANT: 'error' } });
  const failedSession = await failed.call('cursor_start_session', { cwd, mode: 'agent' });
  await assert.rejects(failed.call('cursor_set_mode', { session_id: failedSession.session_id, mode: 'ask' }), { error_code: 'protocol_error' });
  const afterError = await failed.call('cursor_session_status', { session_id: failedSession.session_id });
  assert.equal(afterError.session_state, 'tombstone');
  assert.equal(afterError.mode, 'agent');
  assert.deepEqual(afterError.provider_error, { code: -32000, message: { text: 'set_mode failed', truncated: false } });

  const unexpected = withInjectedFake(t, { env: { FAKE_ACP_SET_MODE_VARIANT: 'unexpected' } });
  const unexpectedSession = await unexpected.call('cursor_start_session', { cwd, mode: 'agent' });
  await assert.rejects(unexpected.call('cursor_set_mode', { session_id: unexpectedSession.session_id, mode: 'ask' }), { error_code: 'protocol_error' });
  assert.equal((await unexpected.call('cursor_session_status', { session_id: unexpectedSession.session_id })).session_state, 'tombstone');
  await unexpected.call('cursor_close_session', { session_id: unexpectedSession.session_id });

  const exited = withInjectedFake(t, { env: { FAKE_ACP_SET_MODE_VARIANT: 'exit' } });
  const exitedSession = await exited.call('cursor_start_session', { cwd, mode: 'agent' });
  await assert.rejects(exited.call('cursor_set_mode', { session_id: exitedSession.session_id, mode: 'ask' }), {
    error_code: 'protocol_error',
    message: 'ACP session/set_mode failed',
  });
  const afterExit = await exited.call('cursor_session_status', { session_id: exitedSession.session_id });
  assert.equal(afterExit.session_state, 'tombstone');
  assert.equal(afterExit.mode, 'agent');
  assert.deepEqual(afterExit.terminal_reason, { text: 'stdout EOF', truncated: false });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('mode transition excludes concurrent prompts and mode changes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-mode-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modeLog = join(root, 'set-mode.jsonl');
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_SET_MODE_LOG: modeLog, FAKE_ACP_DELAY_SET_MODE_MS: '100' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  writeFileSync(modeLog, '');
  const transition = runtime.call('cursor_set_mode', { session_id: session.session_id, mode: 'plan' });
  await Promise.resolve();
  await assert.rejects(runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'must not race' }), { error_code: 'protocol_error' });
  await assert.rejects(runtime.call('cursor_set_mode', { session_id: session.session_id, mode: 'agent' }), { error_code: 'protocol_error' });
  const changed = await transition;
  assert.equal(changed.mode, 'plan');
  assert.deepEqual(readJsonLines(modeLog).map(({ params }) => params), [{ sessionId: 'fake', modeId: 'plan' }]);
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'after transition' });
  assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id, turn.last_event_id)).turn_status, 'completed');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('cursor_set_mode terminalizes a session when the provider never replies', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_SET_MODE_VARIANT: 'no-response' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
  await assert.rejects(fireInitBudgetDeadline(
    () => runtime.call('cursor_set_mode', { session_id: session.session_id, mode: 'ask' }),
  ), { error_code: 'mode_timeout' });
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(status.session_state, 'tombstone');
  assert.equal(status.mode, 'agent');
  assert.equal(status.failure_kind, null);
  assert.deepEqual(status.terminal_reason, { text: 'mode_timeout', truncated: false });
});

test('one live session can move ask to agent while writes remain gated by current mode', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-mode-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'mode-write.txt');
  const runtime = withInjectedFake(t, { roots: [realpathSync(root)], pending: 'write', env: {
    FAKE_ACP_PATH: target,
    FAKE_ACP_CONTENT: 'agent-write',
  } });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'ask' });
  const deniedTurn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'read-only phase' });
  assert.equal((await waitTerminal(runtime, session.session_id, deniedTurn.turn_id, deniedTurn.last_event_id)).turn_status, 'completed');
  assert.equal(existsSync(target), false);

  const changed = await runtime.call('cursor_set_mode', { session_id: session.session_id, mode: 'agent' });
  assert.equal(changed.mode, 'agent');
  const allowedTurn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'authorized implementation phase' });
  assert.equal((await waitTerminal(runtime, session.session_id, allowedTurn.turn_id, allowedTurn.last_event_id)).turn_status, 'completed');
  assert.equal(readFileSync(target, 'utf8'), 'agent-write');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('cursor_wait surfaces compact collaboration events and ignores unadmitted notifications', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-collab-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'wire.jsonl');
  const long = 't'.repeat(9_000);
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_LOG: log,
    FAKE_ACP_DELAY_RESULT_MS: '2000',
    FAKE_ACP_RESULT: 'done',
    FAKE_ACP_COLLAB: JSON.stringify([
      { method: 'cursor/update_todos', id: 'todos-miss', params: { sessionId: 'other', toolCallId: 'todos-miss', merge: true, todos: [{ id: 'miss', content: 'no', status: 'pending' }] } },
      { method: 'cursor/update_todos', id: 'todos-1', params: { toolCallId: 'todos-1', merge: true, todos: [{ id: 'todo-1', content: 'Research', status: 'in_progress' }] } },
      { method: 'cursor/update_todos', id: 'todos-bad', params: { toolCallId: 'todos-bad', todos: 'nope' } },
      { method: 'cursor/update_todos', id: 'todos-empty', params: {} },
      { method: 'cursor/task', id: 'task-1', params: { toolCallId: 'task-1', description: 'Subagent finished', prompt: 'SECRET_TASK_PROMPT', subagentType: 'explore', model: 'grok-4.6', agentId: 'SECRET_AGENT_ID', durationMs: 42 } },
      { method: 'cursor/task', id: 'task-rejected', params: { toolCallId: 'task-rejected', description: 'Rejected', prompt: '', secret: { archive: '~/.cursor/acp-sessions' } } },
      { method: 'cursor/generate_image', id: 'image-1', params: { toolCallId: 'image-1', description: 'Diagram', filePath: '/tmp/diagram.png', referenceImagePaths: ['SECRET_IMAGE_PROMPT'] } },
      { method: 'cursor/generate_image', id: 'image-rejected', params: { toolCallId: 'image-rejected', description: 'Rejected', secret: 'iVBORw0KGgo=' } },
      { method: 'cursor/generate_image', id: 'image-2', params: { toolCallId: 'image-2', description: '', filePath: '/tmp/other.png', referenceImagePaths: [] } },
      { method: 'cursor/update_todos', id: 'todos-2', params: { toolCallId: 'todos-2', merge: false, todos: [{ id: 'todo-2', content: long, status: 'pending' }] } },
    ]),
  } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'plan' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'plan work' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const progress = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000,
  });
  assert.equal(progress.turn_status, 'running');
  assert.equal(['completed', 'failed', 'timed_out', 'cancelled'].includes(progress.turn_status), false);
  const typed = progress.events.filter((event) => ['todos', 'task', 'image'].includes(event.kind));
  assert.deepEqual(typed.map((event) => event.kind), ['todos', 'task', 'image', 'image', 'todos']);
  assert.deepEqual(typed[0].payload, { merge: true, todos: [{ id: 'todo-1', content: { text: 'Research', truncated: false }, status: 'in_progress' }] });
  assert.deepEqual(typed[1].payload, {
    description: { text: 'Subagent finished', truncated: false },
    type: { text: 'explore', truncated: false },
    model: { text: 'grok-4.6', truncated: false },
    duration: 42,
  });
  assert.deepEqual(typed[2].payload, {
    description: { text: 'Diagram', truncated: false },
    path: { text: '/tmp/diagram.png', truncated: false },
  });
  assert.deepEqual(typed[3].payload, { path: { text: '/tmp/other.png', truncated: false } });
  assert.equal(typed[4].payload.merge, false);
  assert.equal(typed[4].payload.todos[0].id, 'todo-2');
  assert.equal(typed[4].payload.todos[0].content.truncated, true);
  assert.ok(Buffer.byteLength(typed[4].payload.todos[0].content.text, 'utf8') <= LIMITS.textBytes);
  const serialized = JSON.stringify(progress);
  assert.equal(serialized.includes('SECRET_TASK_PROMPT'), false);
  assert.equal(serialized.includes('SECRET_AGENT_ID'), false);
  assert.equal(serialized.includes('SECRET_IMAGE_PROMPT'), false);
  assert.equal(serialized.includes('iVBORw0KGgo='), false);
  assert.equal(serialized.includes('acp-sessions'), false);
  assert.equal(serialized.includes('miss'), false);
  const collaborationResponses = readJsonLines(log).filter(({ id, result, method }) =>
    typeof id === 'string' && method === undefined && result && Object.keys(result).length === 0);
  assert.deepEqual(collaborationResponses.map(({ id }) => id), [
    'todos-miss', 'todos-1', 'todos-bad', 'todos-empty', 'task-1', 'task-rejected',
    'image-1', 'image-rejected', 'image-2', 'todos-2',
  ]);

  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id, progress.resume_after_event_id);
  assert.equal(completed.turn_status, 'completed');
  assert.equal(completed.result.text, 'done');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('collaboration acknowledgement is best-effort after the provider transport closes', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_DELAY_RESULT_MS: '2000' } });
  const started = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: started.session_id, prompt: 'keep active' });
  const session = runtime.sessions.get(started.session_id);
  const child = session.child;
  session.child = { stdin: { writable: false } };
  assert.doesNotThrow(() => session.receive(JSON.stringify({
    jsonrpc: '2.0', id: 'late-task', method: 'cursor/task',
    params: { toolCallId: 'late-task', description: 'Late', prompt: 'private', subagentType: 'explore' },
  })));
  session.child = child;
  assert.equal((await runtime.call('cursor_session_status', { session_id: started.session_id })).active_turn.turn_id, turn.turn_id);
  await runtime.call('cursor_close_session', { session_id: started.session_id });
});
