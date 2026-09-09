import test from 'node:test';
import * as support from './runtime-test-support.mjs';

const { assert, spawn, createHash, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, tmpdir, join, fileURLToPath, ADAPTER, CURSOR_ADAPTER_VERSION, LIMITS, MANIFEST_VERSION, Runtime, fake, server, cursorAgentGolden, cwd, fakeEnvNames, offlineModelDependencies, withFake, withInjectedFake, isolatedFakeEnvironment, withDefaultFake, fireInitBudgetDeadline, waitTerminal, waitSessionState, readJsonLines, lastLogged, waitForExit, waitForLine } = support;

test('fake ACP completes and preserves retained T1 while T2 is active', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  assert.equal(session.session_state, 'live');
  const first = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const completed = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: first.turn_id, timeout_ms: 1_000 });
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
  const completed = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(completed.result.text, 'from session update');
  assert.deepEqual(completed.pending, []);
  const closed = await runtime.call('cursor_close_session', { session_id: session.session_id });
  const afterClose = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(closed.session_state, 'tombstone');
  assert.deepEqual(afterClose.pending, []);
});

test('malformed prompt result fails after bounded update aggregation', async (t) => {
  const runtime = withFake(t, { env: { FAKE_ACP_BAD_PROMPT_RESULT: '1' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'one' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.match(terminal.terminal_reason.text, /prompt response is not admitted/);
});

test('active turn normalizes malformed, failed and unrelated ACP responses', async (t) => {
  for (const variant of ['missing-payload', 'error-no-message', 'dual-result-error']) {
    const runtime = withFake(t, { env: { FAKE_ACP_PROMPT_RESPONSE_VARIANT: variant } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: variant });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'failed', variant);
    assert.equal(Object.hasOwn(terminal, 'failure_kind'), false, variant);
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).failure_kind, null, variant);
  }
  const runtime = withFake(t, { env: { FAKE_ACP_PROMPT_RESPONSE_VARIANT: 'unknown-id-first' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ignore unrelated response' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(terminal.turn_status, 'completed');
  await runtime.call('cursor_close_session', { session_id: session.session_id });

  const crlfRuntime = withFake(t, { env: { FAKE_ACP_CRLF: '1' } });
  const crlfSession = await crlfRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const crlfTurn = await crlfRuntime.call('cursor_send_prompt', { session_id: crlfSession.session_id, prompt: 'CRLF framing' });
  assert.equal((await waitTerminal(crlfRuntime, crlfSession.session_id, crlfTurn.turn_id)).turn_status, 'completed');
  await crlfRuntime.call('cursor_close_session', { session_id: crlfSession.session_id });
});

test('prompt result admits exactly the pinned stopReason table', async (t) => {
  for (const stopReason of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) {
    const runtime = withFake(t, { env: { FAKE_ACP_STOP_REASON: stopReason } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: stopReason });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'completed', stopReason);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }

  const runtime = withFake(t, { env: { FAKE_ACP_STOP_REASON: 'not-admitted' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'unknown' });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.match(terminal.terminal_reason.text, /prompt response is not admitted/);
});

test('pending request is turn-addressed and answer restores running state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-question-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'question', env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'ask' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(waiting.turn_status, 'waiting_for_input');
  const pending = waiting.pending[0];
  const answered = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: pending.request_id,
    outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }],
  });
  assert.equal(answered.turn_status, 'running');
  const completed = await waitTerminal(runtime, session.session_id, turn.turn_id);
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

  let state = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(state.pending[0].kind, 'question');
  state = await runtime.call('cursor_answer_question', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q-1', outcome: 'answered',
    answers: [{ question_id: 'q', selected_option_ids: ['choice-1'] }],
  });
  state = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(state.pending[0].kind, 'plan');
  state = await runtime.call('cursor_answer_plan', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan-1', decision: 'accept',
  });
  state = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(state.pending[0].kind, 'permission');
  state = await runtime.call('cursor_answer_permission', {
    session_id: session.session_id, turn_id: turn.turn_id, request_id: 'permission-1', decision: 'allow-once',
  });
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);

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
    session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
  });
  assert.equal(waiting.wait_timeout, true);
  assert.equal(readJsonLines(evidencePath).some(({ event }) => event === 'prompt_result'), false);
  writeFileSync(releasePath, 'follow-up started');
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
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
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
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
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
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
  const runtime = withFake(t, { pending: 'question' }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const first = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'first' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: first.turn_id, timeout_ms: 1_000 }); const firstAnswered = await runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: first.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }] }); const terminal = await waitTerminal(runtime, session.session_id, first.turn_id); const second = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'second' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: second.turn_id, timeout_ms: 1_000 });
  await assert.rejects(runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: first.turn_id, request_id: 'late', outcome: 'cancelled' }), { error_code: 'unknown_request' });
  const retained = await runtime.call('cursor_cancel', { session_id: session.session_id, turn_id: first.turn_id });
  assert.equal(retained.turn_status, 'completed'); assert.equal(Object.hasOwn(retained, 'active_turn'), false);
  const status = await runtime.call('cursor_session_status', { session_id: session.session_id }); assert.equal(status.active_turn.turn_id, second.turn_id); assert.equal(status.last_terminal_turn.turn_id, terminal.turn_id);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('duplicate pending request ID is rejected without overwriting the accepted request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-duplicate-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'duplicate', env: { FAKE_ACP_LOG: log } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'duplicate' }); const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(waiting.pending.length, 1); assert.equal(waiting.pending[0].context.questions[0].prompt.text, 'First?');
  const answered = await runtime.call('cursor_answer_question', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }] }); await waitTerminal(runtime, session.session_id, turn.turn_id);
  const duplicateError = readJsonLines(log).find((message) => message.error?.data?.error_code === 'duplicate_request');
  assert.deepEqual({ id: duplicateError.id, error_code: duplicateError.error.data.error_code }, { id: 'q1', error_code: 'duplicate_request' });
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('permission decisions map to their advertised opaque IDs, not option order', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-permission-')); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'permission', env: { FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'agent' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'run' });
  const waiting = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
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
  await waitTerminal(runtime, session.session_id, turn.turn_id);
  const response = lastLogged(log);
  assert.equal(response.result.outcome.optionId, 'opaque-allow');
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('plan decisions use adapter-owned wire encoding and close settles pending once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-plan-')); t.after(() => rmSync(root, { recursive: true, force: true })); const log = join(root, 'wire.jsonl');
  const runtime = withFake(t, { pending: 'plan', env: { FAKE_ACP_LOG: log } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'plan' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'plan' }); await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  await assert.rejects(runtime.call('cursor_answer_plan', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan1', decision: 'defer' }), { error_code: 'invalid_args' });
  assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).active_turn.pending.length, 1);
  const answered = await runtime.call('cursor_answer_plan', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'plan1', decision: 'accept' }); await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.deepEqual(lastLogged(log).result, { outcome: { outcome: 'accepted' } }); await runtime.call('cursor_close_session', { session_id: session.session_id });

  for (const closedChannel of [false, true]) {
    const closeRoot = mkdtempSync(join(tmpdir(), 'cursor-runtime-close-pending-')); t.after(() => rmSync(closeRoot, { recursive: true, force: true })); const closeLog = join(closeRoot, 'wire.jsonl');
    const cancelledRuntime = withInjectedFake(t, { pending: 'question', env: { FAKE_ACP_LOG: closeLog } });
    const cancelledSession = await cancelledRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
    const cancelledTurn = await cancelledRuntime.call('cursor_send_prompt', { session_id: cancelledSession.session_id, prompt: 'ask' });
    const pending = await cancelledRuntime.call('cursor_wait', { session_id: cancelledSession.session_id, turn_id: cancelledTurn.turn_id, timeout_ms: 1_000 });
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
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'completed'); assert.deepEqual(terminal.pending, []);
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
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.deepEqual(terminal.pending, []);
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
  assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
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
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.deepEqual(terminal.pending, []);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('invalid multiplicity', async (caseT) => {
    const { runtime, session, turn } = await run(caseT, { questions: [{
      id: 'q', question: 'Continue?', allowMultiple: 'sometimes', options: [{ id: 'yes', label: 'Yes' }],
    }] });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.deepEqual(terminal.pending, []);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('explicit single selection', async (caseT) => {
    const { runtime, session, turn } = await run(caseT, { questions: [{
      id: 'q', question: 'Continue?', allowMultiple: false, options: [{ id: 'yes', label: 'Yes' }],
    }] });
    const waiting = await runtime.call('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      timeout_ms: 1_000,
    });
    assert.equal(waiting.pending[0].context.questions[0].allow_multiple, false);
    const answered = await runtime.call('cursor_answer_question', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      request_id: 'q1',
      outcome: 'cancelled',
    });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
});

test('optional ACP callback fields are normalized into stable public pending forms', async (t) => {
  const questionRuntime = withFake(t, { pending: 'question-optional' });
  const questionSession = await questionRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const questionTurn = await questionRuntime.call('cursor_send_prompt', { session_id: questionSession.session_id, prompt: 'optional question' });
  const questionWaiting = await questionRuntime.call('cursor_wait', { session_id: questionSession.session_id, turn_id: questionTurn.turn_id, timeout_ms: 1_000 });
  assert.equal(questionWaiting.pending[0].context.title.text, 'Continue');
  assert.equal(questionWaiting.pending[0].context.questions[0].prompt.text, 'Continue?');
  assert.equal(questionWaiting.pending[0].context.questions[0].allow_multiple, true);
  const questionAnswered = await questionRuntime.call('cursor_answer_question', { session_id: questionSession.session_id, turn_id: questionTurn.turn_id, request_id: 'q1', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes', 'no'] }] });
  assert.equal((await waitTerminal(questionRuntime, questionSession.session_id, questionTurn.turn_id)).turn_status, 'completed');
  await questionRuntime.call('cursor_close_session', { session_id: questionSession.session_id });

  const permissionRuntime = withFake(t, { pending: 'permission-optional' });
  const permissionSession = await permissionRuntime.call('cursor_start_session', { cwd, mode: 'agent' });
  const permissionTurn = await permissionRuntime.call('cursor_send_prompt', { session_id: permissionSession.session_id, prompt: 'optional permission' });
  const permissionWaiting = await permissionRuntime.call('cursor_wait', { session_id: permissionSession.session_id, turn_id: permissionTurn.turn_id, timeout_ms: 1_000 });
  assert.equal(permissionWaiting.pending[0].context.title.text, 'Permission request');
  assert.equal(permissionWaiting.pending[0].context.tool_kind, null);
  assert.equal(Object.hasOwn(permissionWaiting.pending[0].context, 'locations'), false);
  const permissionAnswered = await permissionRuntime.call('cursor_answer_permission', { session_id: permissionSession.session_id, turn_id: permissionTurn.turn_id, request_id: 'p1', decision: 'reject-once' });
  assert.equal((await waitTerminal(permissionRuntime, permissionSession.session_id, permissionTurn.turn_id)).turn_status, 'completed');
  await permissionRuntime.call('cursor_close_session', { session_id: permissionSession.session_id });

  const planRuntime = withFake(t, { pending: 'plan-optional' });
  const planSession = await planRuntime.call('cursor_start_session', { cwd, mode: 'plan' });
  const planTurn = await planRuntime.call('cursor_send_prompt', { session_id: planSession.session_id, prompt: 'optional plan' });
  const planWaiting = await planRuntime.call('cursor_wait', { session_id: planSession.session_id, turn_id: planTurn.turn_id, timeout_ms: 1_000 });
  assert.equal(planWaiting.pending[0].context.title, null);
  assert.equal(planWaiting.pending[0].context.body.text, 'Fallback body');
  const planAnswered = await planRuntime.call('cursor_answer_plan', { session_id: planSession.session_id, turn_id: planTurn.turn_id, request_id: 'plan1', decision: 'accept' });
  assert.equal((await waitTerminal(planRuntime, planSession.session_id, planTurn.turn_id)).turn_status, 'completed');
  await planRuntime.call('cursor_close_session', { session_id: planSession.session_id });
});

