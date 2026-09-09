import test from 'node:test';
import * as support from './runtime-test-support.mjs';

const { assert, spawn, createHash, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, tmpdir, join, fileURLToPath, ADAPTER, CURSOR_ADAPTER_VERSION, LIMITS, MANIFEST_VERSION, Runtime, fake, server, cursorAgentGolden, cwd, fakeEnvNames, offlineModelDependencies, withFake, withInjectedFake, isolatedFakeEnvironment, withDefaultFake, fireInitBudgetDeadline, waitTerminal, waitSessionState, readJsonLines, lastLogged, waitForExit, waitForLine } = support;

async function assertRepeatableTerminal(runtime, session_id, turn_id) {
  const args = { session_id, turn_id, timeout_ms: 1_000 };
  const first = await runtime.call('cursor_wait', args);
  assert.equal(Object.hasOwn(first, 'result'), true);
  assert.equal(Object.hasOwn(first, 'terminal_reason'), true);
  assert.equal(first.wait_timeout, false);
  assert.deepEqual(first.pending, []);
  assert.deepEqual(await runtime.call('cursor_wait', args), first);
  return first;
}

test('fixed resource limits remain the frozen v1 public values', () => {
  assert.deepEqual(LIMITS, {
    discoveryMs: 15_000, discoveryBytes: 1_048_576, initMs: 15_000, turnMs: 3_600_000, idleMs: 900_000, waitDefaultMs: 30_000,
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
  const terminal = await waitTerminal(runtime, session.session_id, allocated.turn_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.deepEqual(terminal.terminal_reason, { text: 'ACP provider error', truncated: false });
  assert.deepEqual({ ...terminal.terminal_receipt, last_event_id: null }, {
    session_id: session.session_id, turn_id: allocated.turn_id, turn_status: 'failed',
    last_event_id: null, result_sha256: null, result_truncated: false,
  });
  assert.ok(Number.isSafeInteger(terminal.terminal_receipt.last_event_id));
  assert.equal(terminal.provider_error.code, -32000);
  assert.equal(terminal.provider_error.message.truncated, true);
  assert.equal(Buffer.from(terminal.provider_error.message.text, 'utf8').toString('utf8'), terminal.provider_error.message.text);
  assert.ok(Buffer.byteLength(terminal.provider_error.message.text, 'utf8') <= LIMITS.textBytes);
  await waitSessionState(runtime, session.session_id, 'tombstone');
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).session_state, 'tombstone');
  assert.equal((await assertRepeatableTerminal(runtime, session.session_id, allocated.turn_id)).result, null);
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
  const terminal = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(terminal.turn_status, 'timed_out');
  assert.equal(terminal.terminal_reason.text, 'turn deadline exceeded');
  await waitSessionState(runtime, session.session_id, 'tombstone');
  assert.equal((await assertRepeatableTerminal(runtime, session.session_id, turn.turn_id)).result, null);
});

test('warning scenarios: allowed roots distinguish absent, empty and malformed configuration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-roots-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const unrestricted = withFake(t, { roots: null }); const admitted = await unrestricted.call('cursor_start_session', { cwd: root, mode: 'ask' }); assert.equal(admitted.session_state, 'live'); await unrestricted.call('cursor_close_session', { session_id: admitted.session_id });
  const denied = new Runtime({ ...offlineModelDependencies, roots: [] }); await assert.rejects(denied.call('cursor_start_session', { cwd: root, mode: 'ask' }), { error_code: 'scope_rejected' });
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
  assert.equal((await assertRepeatableTerminal(runtime, session.session_id, turn.turn_id)).result, null);
});

test('answering one of multiple pending requests keeps the turn waiting', async (t) => {
  const runtime = withFake(t, { pending: 'two-questions' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'two questions' });
  let waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  while (waiting.pending.length < 2) {
    // The first pending request is already actionable; yield so the fixture
    // can publish the second independent request before observing again.
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
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
  const immediate = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
  });
  assert.equal(immediate.wait_timeout, false);
  assert.deepEqual(immediate.pending.map(({ request_id }) => request_id), ['q2']);

  const resumed = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q2', outcome: 'answered',
    answers: [{ question_id: 'second', selected_option_ids: ['yes'] }],
  });
  assert.equal(resumed.turn_status, 'running');
  assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('remaining permission is immediately observable without another event or clock advance', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
  const started = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: started.session_id, prompt: 'two permissions' });
  const record = runtime.sessions.get(started.session_id);
  // Drive the admitted callback boundary synchronously: no provider scheduling
  // can insert an event between answering the first and observing the second.
  for (const id of ['first', 'second']) record.callback({
    id, method: 'session/request_permission', params: {
      sessionId: record.cursorSessionId,
      toolCall: { toolCallId: id, title: `Execute ${id}?`, kind: 'execute', locations: [{ path: cwd, line: 1 }] },
      options: [{ optionId: `${id}-allow`, kind: 'allow_once', name: 'Yes' }, { optionId: `${id}-reject`, kind: 'reject_once', name: 'No' }],
    },
  });
  const args = { session_id: started.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 };
  const before = await runtime.call('cursor_wait', args);
  assert.deepEqual(before.pending.map(({ request_id }) => request_id), ['first', 'second']);
  const sendConfirmed = record.sendConfirmed;
  const responses = [];
  record.sendConfirmed = async (frame) => { responses.push(frame); };
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const now = originalNow();
  try {
    Date.now = () => now;
    await runtime.call('cursor_answer_permission', {
      session_id: started.session_id, turn_id: turn.turn_id, request_id: 'first', decision: 'allow-once',
    });
    const eventId = record.nextEvent;
    globalThis.setTimeout = () => assert.fail('actionable pending must not register a timeout');
    const remaining = await runtime.call('cursor_wait', args);
    assert.equal(remaining.wait_timeout, false);
    assert.equal(remaining.turn_status, 'waiting_for_input');
    assert.deepEqual(remaining.pending, [before.pending[1]]);
    assert.equal(record.nextEvent, eventId, 'observation creates no new event');
    assert.equal(Date.now(), now);
    assert.deepEqual(responses, [{ jsonrpc: '2.0', id: 'first', result: ADAPTER.permissionResponse('first-allow') }]);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    record.sendConfirmed = sendConfirmed;
  }
  await runtime.call('cursor_close_session', { session_id: started.session_id });
});

test('wait rechecks registration and timeout races before returning its target snapshot', async (t) => {
  for (const boundary of ['registration', 'timeout']) {
    const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
    const started = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: started.session_id, prompt: boundary });
    const record = runtime.sessions.get(started.session_id);
    const originalSetTimeout = globalThis.setTimeout;
    const originalNow = Date.now;
    let now = originalNow();
    let expire;
    try {
      Date.now = () => now;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay !== 1_000) return originalSetTimeout(callback, delay, ...args);
        expire = () => callback(...args);
        if (boundary === 'registration') record.complete(record.active, { stopReason: 'end_turn' });
        return { controlledWait: true };
      };
      const waiting = runtime.call('cursor_wait', { session_id: started.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
      assert.equal(typeof expire, 'function');
      if (boundary === 'timeout') {
        assert.equal(record.waiters.size, 1);
        now += 1_000;
        expire();
        // Deadline fires first; completion wins before the waiting continuation.
        record.complete(record.active, { stopReason: 'end_turn' });
      }
      const result = await waiting;
      assert.equal(result.turn_id, turn.turn_id);
      assert.equal(result.turn_status, 'completed');
      assert.equal(result.wait_timeout, false);
      assert.equal(record.waiters.size, 0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      Date.now = originalNow;
    }
    await runtime.call('cursor_close_session', { session_id: started.session_id });
  }
});

test('ACP result received with a pending request fails the turn and clears public pending state', async (t) => {
  const runtime = withFake(t, { pending: 'result-with-pending' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'premature result' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.match(terminal.terminal_reason.text, /ACP result with pending request/);
  assert.deepEqual(terminal.pending, []);
});

test('child exit after a completed turn tombstones the session without rewriting the turn', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_EXIT_AFTER_RESULT: '1' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'complete then exit' });
  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id);
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
      const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/release-model-discovery-preload.mjs', import.meta.url)), server], {
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

test('wait returns an already pending request without consuming its timeout', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'wait timeout' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  const repeated = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(repeated.wait_timeout, false);
  assert.equal(repeated.turn_status, 'waiting_for_input');
  assert.deepEqual(repeated.pending, waiting.pending);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('question skipped and cancelled outcomes preserve their adapter wire forms', async (t) => {
  for (const outcome of ['skipped', 'cancelled']) {
    const root = mkdtempSync(join(tmpdir(), `cursor-question-${outcome}-`)); t.after(() => rmSync(root, { recursive: true, force: true }));
    const log = join(root, 'wire.jsonl');
    const runtime = withFake(t, { pending: 'question', env: { FAKE_ACP_LOG: log } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: outcome });
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
    const answered = await runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
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
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
    const answered = await runtime.call(item.tool, { session_id: session.session_id, turn_id: turn.turn_id, request_id: item.request_id, decision: item.decision });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
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
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
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

test('terminal receipt is repeatable per retained turn across a long live conversation', async (t) => {
  const runtime = withInjectedFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  for (let index = 0; index < 25; index += 1) {
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: `turn ${index}` });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.ok(terminal.terminal_receipt);
    const repeated = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
    assert.equal(Object.hasOwn(repeated, 'terminal_receipt'), true);
    assert.deepEqual(repeated.terminal_receipt, terminal.terminal_receipt);
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
    protocolVersion: 1, clientInfo: { name: 'agents-cursor-subagent-plugin', version: '0.1.0' },
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
  assert.equal(ADAPTER.admitLoadResult(null), false);
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
  for (const project of Object.values(projectionByMethod)) {
    for (const root of [null, [], 'invalid', 1]) assert.equal(project(root), null);
  }
  const todos = cursorAgentGolden.collaboration_requests.find(({ method }) => method === ADAPTER.methods.todos).input;
  for (const item of [null, [], 'invalid', { ...todos.todos[0], id: '' },
    { ...todos.todos[0], content: 1 }, { ...todos.todos[0], content: '\ud800' },
    { ...todos.todos[0], status: 'unknown' }]) {
    assert.equal(ADAPTER.admitTodos({ ...todos, todos: [item] }), null);
  }
  assert.equal(ADAPTER.admitTodos({ ...todos, todos: [todos.todos[0], todos.todos[0]] }), null);
  const task = { ...taskTemplate, subagentType: 'explore' };
  for (const patch of [{ subagentType: { custom: '' } }, { subagentType: { custom: 1 } },
    { subagentType: [] }, { description: 1 }, { prompt: 1 }, { model: 1 },
    { model: '\ud800' }, { agentId: 1 }, { agentId: '\ud800' }, { durationMs: -1 }, { durationMs: '10' }]) {
    assert.equal(ADAPTER.admitTask({ ...task, ...patch }), null);
  }
  const image = { toolCallId: 'image', description: 'Preview' };
  assert.deepEqual(ADAPTER.admitImage(image), { description: { text: 'Preview', truncated: false } });
  for (const patch of [{ description: '' }, { description: 1 }, { filePath: '' },
    { filePath: 1 }, { filePath: '\ud800' }, { referenceImagePaths: 'image.png' },
    { referenceImagePaths: [1] }, { referenceImagePaths: ['\ud800'] }]) {
    assert.equal(ADAPTER.admitImage({ ...image, ...patch }), null);
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

});

test('per-session model argv stays isolated from other sessions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-launch-argv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selectedLog = join(root, 'selected.jsonl');
  const plainLog = join(root, 'plain.jsonl');
  const selected = withInjectedFake(t, { runtime: {
    readModelAuth: async () => '{"apiKey":"fixture-secret"}',
    fetchModels: async () => new Response(JSON.stringify(JSON.parse(readFileSync(new URL('./fixtures/cursor-model-catalog-1.0.31.json', import.meta.url), 'utf8')).response)),
  }, env: {
    FAKE_ACP_PICKER_FROM_ARGV: '1',
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
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
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
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [cwd] });
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
    await waitTerminal(runtime, session.session_id, turn.turn_id);
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
    await waitTerminal(runtime, session.session_id, turn.turn_id);
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
    await waitTerminal(runtime, session.session_id, turn.turn_id);
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
  } });
  const session = await runtime.call('cursor_resume_session', { cwd, cursor_session_id: 'cursor-resume-1', mode: 'agent' });
  assert.equal(session.session_state, 'live');
  assert.equal(session.cursor_session_id, 'cursor-resume-1');
  assert.notEqual(session.session_id, 'cursor-resume-1');
  const methods = readJsonLines(log).map((message) => message.method);
  assert.equal(methods.includes('session/load'), true);
  assert.equal(methods.includes('session/new'), false);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('resume unexpected ID, mode-shape drift and reject stay recoverable init failures', async (t) => {
  const nullRuntime = withInjectedFake(t);
  const resuming = nullRuntime.call('cursor_resume_session', { cwd, cursor_session_id: 'null-load', mode: 'ask' });
  await Promise.resolve();
  const allocated = [...nullRuntime.sessions.values()][0];
  assert.ok(allocated, 'wrapper is allocated before provider initialization');
  const request = allocated.request;
  const methods = [];
  allocated.request = function (method, ...args) {
    methods.push(method);
    return method === ADAPTER.methods.sessionLoad ? Promise.resolve(null) : request.call(this, method, ...args);
  };
  const nullLoad = await resuming;
  assert.equal(nullLoad.session_state, 'tombstone');
  assert.equal(nullLoad.failure_kind, 'init');
  assert.equal(nullLoad.cursor_session_id, 'null-load');
  assert.equal(methods.includes(ADAPTER.methods.sessionNew), false, 'failed load must not replace the conversation');
  assert.equal(nullRuntime.sessions.size, 1);
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
    await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
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

test('terminal wait is repeatable while later action acknowledgements omit the snapshot', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_RESULT: 'done' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(completed.turn_status, 'completed');
  assert.equal(completed.result.text, 'done');
  assert.equal(Object.keys(completed).includes('last_terminal_turn'), false);
  assert.equal(completed.terminal_receipt.turn_id, turn.turn_id);
  assert.equal(completed.terminal_receipt.result_truncated, false);
  assert.equal(completed.terminal_receipt.result_sha256, createHash('sha256').update('done', 'utf8').digest('hex'));
  assert.equal((await assertRepeatableTerminal(runtime, session.session_id, turn.turn_id)).terminal_reason, null);
  const next = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'two' });
  assert.equal(Object.hasOwn(next, 'last_terminal_turn'), false);
  assert.equal(Object.hasOwn(next, 'terminal_receipt'), false);
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

test('wait returns a complete state snapshot with pending context', async (t) => {
  const runtime = withFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'compact wait' });
  const delta = await runtime.call('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
  });
  assert.deepEqual(Object.keys(delta).sort(), [
    'pending', 'session_id', 'session_state', 'turn_id', 'turn_status', 'wait_timeout',
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
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
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

test('wait timeout exposes the retained accepted agent-text excerpt', async (t) => {
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_HOLD_PROMPT: '1',
    FAKE_ACP_PROGRESS_TEXT: 'visible progress',
    FAKE_ACP_NOISE_UPDATES: '1',
  } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'progress' });
  const first = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(first.wait_timeout, true);
  assert.equal(first.progress_excerpt.text, 'visible progress');
  assert.equal(first.progress_excerpt.truncated, false);
  assert.equal(JSON.stringify(first).includes('secret thinking'), false);
  assert.equal(JSON.stringify(first).includes('raw tool payload'), false);
  assert.equal(JSON.stringify(first).includes('acp-sessions'), false);

  const repeat = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(repeat.wait_timeout, true);
  assert.deepEqual(repeat.progress_excerpt, first.progress_excerpt);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('wait timeout progress excerpt truncates and retains the latest accepted text', async (t) => {
  const long = `${'p'.repeat(LIMITS.progressBytes - 6)}😀xyz`;
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_HOLD_PROMPT: '1',
    FAKE_ACP_PROGRESS_TEXT: long,
    FAKE_ACP_SECOND_PROGRESS_TEXT: ' later',
    FAKE_ACP_SECOND_PROGRESS_MS: '1200',
  } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'long progress' });
  const first = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(first.progress_excerpt.truncated, true);
  assert.ok(Buffer.byteLength(first.progress_excerpt.text, 'utf8') <= LIMITS.progressBytes);
  assert.equal(Buffer.from(first.progress_excerpt.text, 'utf8').toString('utf8'), first.progress_excerpt.text);
  const retained = runtime.sessions.get(session.session_id).active;
  assert.equal(Object.hasOwn(retained, 'progress_parts'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(retained.progress_excerpt), 'utf8') <= LIMITS.progressBytes + 64);

  const later = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(Object.hasOwn(later, 'progress_excerpt'), true);
  assert.match(later.progress_excerpt.text, /later/);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('repeated pending observation omits the progress excerpt', async (t) => {
  const runtime = withInjectedFake(t, { pending: 'question' });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'wait timeout' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  const repeated = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(repeated.wait_timeout, false);
  assert.equal(Object.hasOwn(repeated, 'progress_excerpt'), false);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('cursor_set_mode transitions a live idle session and rejects active or tombstone work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-set-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modeLog = join(root, 'set-mode.jsonl');
  const runtime = withInjectedFake(t, { env: {
    FAKE_ACP_SET_MODE_LOG: modeLog,
  } });
  await assert.rejects(runtime.call('cursor_set_mode', { session_id: 'missing', mode: 'review' }), {
    error_code: 'invalid_args',
    message: 'invalid mode: ask|plan|agent',
  });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
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
  assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
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
  assert.equal((await waitTerminal(runtime, session.session_id, deniedTurn.turn_id)).turn_status, 'completed');
  assert.equal(existsSync(target), false);

  const changed = await runtime.call('cursor_set_mode', { session_id: session.session_id, mode: 'agent' });
  assert.equal(changed.mode, 'agent');
  const allowedTurn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'authorized implementation phase' });
  assert.equal((await waitTerminal(runtime, session.session_id, allowedTurn.turn_id)).turn_status, 'completed');
  assert.equal(readFileSync(target, 'utf8'), 'agent-write');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('cursor_wait ignores collaboration-event bursts while runtime acknowledges them', async (t) => {
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
    session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
  });
  assert.equal(progress.turn_status, 'running');
  assert.equal(['completed', 'failed', 'timed_out', 'cancelled'].includes(progress.turn_status), false);
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

  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id);
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

test('nonblocking collaboration notifications and idle callbacks do not publish work', async (t) => {
  const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
  const started = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const record = runtime.sessions.get(started.session_id);
  const originalWrite = record.child.stdin.write;
  const replies = [];
  record.child.stdin.write = (frame, callback) => { replies.push(JSON.parse(frame)); callback?.(); return true; };
  try {
    const input = cursorAgentGolden.collaboration_requests.find(({ method }) => method === ADAPTER.methods.todos).input;
    const eventId = record.nextEvent;
    record.receive(JSON.stringify({ jsonrpc: '2.0', id: 'idle', method: ADAPTER.methods.todos, params: input }));
    assert.equal(record.nextEvent, eventId);
    assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 'idle', result: {} }]);
    record.child.stdin.write = originalWrite;
    await runtime.call('cursor_send_prompt', { session_id: started.session_id, prompt: 'active' });
    record.child.stdin.write = (frame, callback) => { replies.push(JSON.parse(frame)); callback?.(); return true; };
    const activeEvent = record.nextEvent;
    record.receive(JSON.stringify({ jsonrpc: '2.0', method: ADAPTER.methods.todos, params: input }));
    assert.equal(record.nextEvent, activeEvent);
    assert.equal(replies.length, 1, 'idless notification has no acknowledgement');
    record.child.stdin.destroy();
    assert.doesNotThrow(() => record.receive(JSON.stringify({ jsonrpc: '2.0', id: 'invalid', method: 'unsupported' })));
    assert.equal(replies.length, 1, 'closed response pipe is abandoned without a write');
  } finally { record.child.stdin.write = originalWrite; }
  await runtime.call('cursor_close_session', { session_id: started.session_id });
});

test('allocated prompt dispatch failures terminalize once without retrying transport', async (t) => {
  for (const failure of ['closed-pipe', 'asynchronous-EPIPE']) {
    const runtime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
    const started = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const record = runtime.sessions.get(started.session_id);
    const originalWrite = record.child.stdin.write;
    let attempts = 0;
    record.child.stdin.write = function (frame, callback) {
      if (JSON.parse(frame).method !== ADAPTER.methods.prompt) return originalWrite.call(this, frame, callback);
      attempts++;
      queueMicrotask(() => callback(new Error('EPIPE')));
      return true;
    };
    try {
      if (failure === 'closed-pipe') record.child.stdin.destroy();
      const turn = await runtime.call('cursor_send_prompt', { session_id: started.session_id, prompt: failure });
      assert.ok(turn.turn_id);
      await waitSessionState(runtime, started.session_id, 'tombstone');
      const terminal = await runtime.call('cursor_wait', { session_id: started.session_id, turn_id: turn.turn_id });
      assert.equal(terminal.turn_status, 'failed');
      assert.match(terminal.terminal_reason.text, /stdin is closed|stdin EPIPE/);
      assert.equal(attempts, failure === 'closed-pipe' ? 0 : 1);
    } finally { record.child.stdin.write = originalWrite; }
  }
});

test('answer write failure and cancellation race retain the established terminal outcome', async (t) => {
  for (const failure of ['closed-pipe', 'asynchronous-EPIPE', 'cancel-before-write-settles']) {
    const runtime = withInjectedFake(t, { pending: 'question' });
    const started = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: started.session_id, prompt: failure });
    await runtime.call('cursor_wait', { session_id: started.session_id, turn_id: turn.turn_id });
    const record = runtime.sessions.get(started.session_id);
    const originalWrite = record.child.stdin.write;
    let attempts = 0;
    let settleWrite;
    record.child.stdin.write = function (frame, callback) {
      if (JSON.parse(frame).id !== 'q1') return originalWrite.call(this, frame, callback);
      attempts++;
      if (failure === 'asynchronous-EPIPE') queueMicrotask(() => callback(new Error('EPIPE')));
      else settleWrite = callback;
      return true;
    };
    try {
      if (failure === 'closed-pipe') record.child.stdin.destroy();
      const answering = runtime.call('cursor_answer_question', { session_id: started.session_id, turn_id: turn.turn_id,
        request_id: 'q1', outcome: 'skipped' });
      if (failure === 'cancel-before-write-settles') {
        assert.equal(typeof settleWrite, 'function', 'answer is in flight before cancellation');
        await runtime.call('cursor_cancel', { session_id: started.session_id, turn_id: turn.turn_id });
        settleWrite();
      }
      const answered = await answering;
      await waitSessionState(runtime, started.session_id, 'tombstone');
      const terminal = await runtime.call('cursor_wait', { session_id: started.session_id, turn_id: turn.turn_id });
      assert.equal(terminal.turn_status, failure === 'cancel-before-write-settles' ? 'cancelled' : 'failed');
      assert.equal(answered.turn_status, terminal.turn_status);
      assert.deepEqual(terminal.pending, []);
      assert.equal(attempts, failure === 'closed-pipe' ? 0 : 1);
    } finally { record.child.stdin.write = originalWrite; }
  }
});
