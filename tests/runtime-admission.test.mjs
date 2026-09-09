import test from 'node:test';
import * as support from './runtime-test-support.mjs';

const { assert, spawn, createHash, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, tmpdir, join, fileURLToPath, ADAPTER, CURSOR_ADAPTER_VERSION, LIMITS, MANIFEST_VERSION, Runtime, fake, server, cursorAgentGolden, cwd, fakeEnvNames, offlineModelDependencies, withFake, withInjectedFake, isolatedFakeEnvironment, withDefaultFake, fireInitBudgetDeadline, waitTerminal, waitSessionState, readJsonLines, lastLogged, waitForExit, waitForLine } = support;

test('runtime rejects scope before session allocation', async () => {
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: '/definitely-missing', mode: 'ask' }), { error_code: 'scope_rejected' });
});

for (const phase of ['credentials', 'version']) test(`successful ${phase} completion after shutdown cannot revive or spawn a session`, async (t) => {
  const runtime = withInjectedFake(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const childEnvironment = runtime.childEnvironment.bind(runtime);
  runtime.childEnvironment = async (signal) => {
    const env = await childEnvironment(signal);
    const record = [...runtime.sessions.values()][0];
    if (phase === 'version') record.probeCursorVersion = async () => { entered(); await gate; return CURSOR_ADAPTER_VERSION; };
    else { entered(); await gate; }
    return env;
  };
  const pending = runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  await ready;
  await runtime.shutdown();
  release();
  const result = await pending;
  assert.equal(result.session_state, 'tombstone');
  assert.equal(result.failure_kind, null);
  assert.equal(runtime.live.size, 0);
  assert.equal([...runtime.sessions.values()][0].child, null);
  assert.equal((await runtime.call('cursor_session_status', { session_id: result.session_id })).session_state, 'tombstone');
});

test('runtime exposes normalized init tombstone when ACP cannot spawn', async () => {
  const old = process.env.CURSOR_AGENT_COMMAND; process.env.CURSOR_AGENT_COMMAND = '/definitely-missing-agent';
  try {
    const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
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
  const runtime = new Runtime({ ...offlineModelDependencies, env, roots: [cwd] });
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
const stdoutKeeper = spawn(process.execPath, ['-e', 'setTimeout(() => process.stderr.write("late startup diagnostic"), 100)'], {
  stdio: ['ignore', 'inherit', 'inherit'],
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
  assert.match(envelope.terminal_reason.text, /late startup diagnostic/);
});

for (const phase of ['startup', 'version']) test(`${phase} stderr drain expires with inherited pipes and keeps the terminal diagnostic stable`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-inherited-stderr-'));
  const release = join(root, 'release');
  const done = join(root, 'done');
  t.after(async () => {
    writeFileSync(release, '');
    for (let attempt = 0; attempt < 200 && !existsSync(done); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    rmSync(root, { recursive: true, force: true });
  });
  const keeper = join(root, 'keeper.mjs');
  writeFileSync(keeper, `
import { existsSync, writeFileSync } from 'node:fs';
process.stderr.on('error', () => {});
setTimeout(() => process.stderr.write('pre-deadline diagnostic'), 100);
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  process.stderr.write('late diagnostic after tombstone', (error) => writeFileSync(${JSON.stringify(done)}, error?.code || 'open'));
}, 10);
setTimeout(() => process.exit(0), 15000).unref();
`);
  const program = join(root, 'agent.mjs');
  writeFileSync(program, `
import { spawn } from 'node:child_process';
if (process.argv.includes('--version') && ${JSON.stringify(phase)} === 'startup') {
  process.stdout.write('2026.08.25-3e8eec8\\n');
} else {
  const child = spawn(process.execPath, [${JSON.stringify(keeper)}], { stdio: ['ignore', 'ignore', 'inherit'] });
  child.unref();
  process.stderr.write('initial startup diagnostic', () => process.exit(1));
}
`);
  const runtime = withInjectedFake(t, { env: { CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([program]) } });
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.session_state, 'tombstone');
  assert.match(failed.terminal_reason.text, /initial startup diagnostic/);
  assert.match(failed.terminal_reason.text, /pre-deadline diagnostic/);
  writeFileSync(release, '');
  for (let attempt = 0; attempt < 200 && !existsSync(done); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(done), 'inherited writer completed after the reader closed at the deadline');
  assert.equal(readFileSync(done, 'utf8'), 'EPIPE');
  const status = await runtime.call('cursor_session_status', { session_id: failed.session_id });
  assert.deepEqual(status.terminal_reason, failed.terminal_reason);
});

test('version probe stderr is diagnostic on failure and does not contaminate a successful version', async (t) => {
  for (const failed of [false, true]) {
    const runtime = withInjectedFake(t, { env: { FAKE_ACP_VERSION_STDERR: failed ? 'Version warning' : 'Warning '.repeat(10000), ...(failed ? { FAKE_ACP_VERSION_MODE: 'nonzero' } : {}) } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(session.session_state, failed ? 'tombstone' : 'live');
    if (failed) {
      assert.match(session.terminal_reason.text, /Cursor version probe failed\nCursor stderr: [\s\S]*Version warning/);
      assert.equal(session.terminal_reason.truncated, false);
    } else await runtime.call('cursor_close_session', { session_id: session.session_id });
  }
});

test('Cursor startup stderr survives init failure without creating a turn', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_STARTUP_STDERR: 'Cannot use this model: grok.\n' } });
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.session_state, 'tombstone');
  assert.equal(failed.failure_kind, 'init');
  assert.equal(failed.active_turn, null);
  assert.equal(failed.last_terminal_turn, null);
  assert.match(failed.terminal_reason.text, /Cursor stderr: [\s\S]*Cannot use this model: grok\./);
  assert.equal(failed.terminal_reason.truncated, false);
});

test('startup warnings allow live sessions and do not leak into later terminal diagnostics', async (t) => {
  const warning = 'nonfatal startup warning';
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_STARTUP_WARNING: warning } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(session.session_state, 'live');
  assert.equal(session.failure_kind, null);
  assert.equal(session.terminal_reason, null);
  const record = runtime.sessions.get(session.session_id);
  record.child.stderr.emit('data', Buffer.from('late live warning'));
  const closing = runtime.call('cursor_close_session', { session_id: session.session_id });
  record.child.stderr.emit('data', Buffer.from('late closing warning'));
  await closing;
  const closed = await runtime.call('cursor_session_status', { session_id: session.session_id });
  assert.equal(closed.session_state, 'tombstone');
  assert.doesNotMatch(closed.terminal_reason?.text || '', /nonfatal startup warning/);
  assert.doesNotMatch(closed.terminal_reason?.text || '', /late (live|closing) warning/);

  delete runtime.env.FAKE_ACP_STARTUP_WARNING;
  runtime.env.FAKE_ACP_STARTUP_STDERR = 'new startup failure';
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.failure_kind, 'init');
  assert.match(failed.terminal_reason.text, /new startup failure/);
  assert.doesNotMatch(failed.terminal_reason.text, /nonfatal startup warning/);
});

test('init failure diagnostics bound noisy stderr and preserve split UTF-8', async (t) => {
  for (const diagnostic of ['Ошибка модели', 'Ошибка модели '.repeat(2000), 'Ошибка модели' + ' '.repeat(20000)]) {
    const runtime = withInjectedFake(t, { env: { FAKE_ACP_STARTUP_STDERR: diagnostic } });
    const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(failed.failure_kind, 'init');
    assert.match(failed.terminal_reason.text, /Cursor stderr: [\s\S]*Ошибка модели/);
    assert.ok(Buffer.byteLength(failed.terminal_reason.text) <= LIMITS.textBytes);
    assert.ok(!failed.terminal_reason.text.includes('\uFFFD'));
    assert.equal(failed.terminal_reason.truncated, Buffer.byteLength(diagnostic) > LIMITS.textBytes);
  }
});

test('adapter admission failure is an allocated init tombstone and releases capacity', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_BAD_ADMISSION: '1' } });
  const failed = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(failed.session_state, 'tombstone'); assert.equal(failed.failure_kind, 'init');
  delete runtime.env.FAKE_ACP_BAD_ADMISSION;
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

test('runtime accepts other Cursor versions when the ACP interface is compatible', async (t) => {
  for (const version of ['2026.08.24-old', '2026.09.02-new']) {
    const runtime = withFake(t, { env: { FAKE_ACP_VERSION: version } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    assert.equal(session.session_state, 'live', version);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }
});

test('adapter admission rejects incompatible and unusable Cursor probes', async (t) => {
  const scenarios = [
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
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
  for (const name of ['cursor_answer_', 'cursor_answer_unknown', 'cursor_answer_question_extra']) {
    await assert.rejects(runtime.call(name, {}), { error_code: 'invalid_args', message: `unknown tool: ${name}` });
  }
});

test('runtime rejects a non-object tool argument envelope', async () => {
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', null), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects an undocumented tool argument', async () => {
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'ask', extra: true }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects a missing required tool argument', async () => {
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects a tool argument envelope that cannot be serialized', async () => {
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
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
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: '.', mode: 'ask' }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects a working directory that resolves to a file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-file-cwd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'content', 'utf8');
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [root] });
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
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [root] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: outside, mode: 'ask' }), {
    error_code: 'scope_rejected',
  });
});

test('runtime rejects an unsupported session mode before start or resume', async () => {
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
  await assert.rejects(runtime.call('cursor_start_session', { cwd, mode: 'review' }), {
    error_code: 'invalid_args',
  });
  await assert.rejects(runtime.call('cursor_resume_session', { cwd, cursor_session_id: 'cursor-resume', mode: 'review' }), {
    error_code: 'invalid_args',
  });
});

test('runtime rejects lookup of an unknown session', async () => {
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
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

test('runtime rejects legacy wait cursors before creating a waiter', async (t) => {
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
    session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
  });
  assert.equal(waited.turn_status, 'running');
  assert.equal(waited.wait_timeout, true);
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
