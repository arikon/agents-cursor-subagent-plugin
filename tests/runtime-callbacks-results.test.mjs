import test from 'node:test';
import * as support from './runtime-test-support.mjs';

const { assert, spawn, createHash, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, tmpdir, join, fileURLToPath, ADAPTER, CURSOR_ADAPTER_VERSION, LIMITS, MANIFEST_VERSION, Runtime, fake, server, cursorAgentGolden, cwd, fakeEnvNames, offlineModelDependencies, withFake, withInjectedFake, isolatedFakeEnvironment, withDefaultFake, fireInitBudgetDeadline, waitTerminal, waitSessionState, readJsonLines, lastLogged, waitForExit, waitForLine } = support;

test('filesystem callbacks enforce mode, containment, UTF-8, cap and ranges', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-runtime-fs-')); t.after(() => rmSync(root, { recursive: true, force: true })); const source = join(root, 'source.txt'); const output = join(root, 'output.txt'); const log = join(root, 'wire.jsonl');
  writeFileSync(source, 'one\ntwo', 'utf8');
  const reader = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LINE: '2', FAKE_ACP_LOG: log } });
  const readSession = await reader.call('cursor_start_session', { cwd: root, mode: 'plan' }); const readTurn = await reader.call('cursor_send_prompt', { session_id: readSession.session_id, prompt: 'read' }); await waitTerminal(reader, readSession.session_id, readTurn.turn_id);
  assert.equal(lastLogged(log).result.content, 'two'); await reader.call('cursor_close_session', { session_id: readSession.session_id });

  const writer = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: { FAKE_ACP_PATH: output, FAKE_ACP_CONTENT: 'written' } });
  const writeSession = await writer.call('cursor_start_session', { cwd: root, mode: 'agent' }); const writeTurn = await writer.call('cursor_send_prompt', { session_id: writeSession.session_id, prompt: 'write' }); await waitTerminal(writer, writeSession.session_id, writeTurn.turn_id);
  assert.equal(readFileSync(output, 'utf8'), 'written');
  writeFileSync(output, 'replace me', 'utf8');
  const rewriteTurn = await writer.call('cursor_send_prompt', { session_id: writeSession.session_id, prompt: 'rewrite' }); await waitTerminal(writer, writeSession.session_id, rewriteTurn.turn_id);
  assert.equal(readFileSync(output, 'utf8'), 'written'); await writer.call('cursor_close_session', { session_id: writeSession.session_id });

  writeFileSync(source, Buffer.from([0xc3, 0x28])); writeFileSync(log, '');
  const malformed = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LOG: log } });
  const malformedSession = await malformed.call('cursor_start_session', { cwd: root, mode: 'plan' }); const malformedTurn = await malformed.call('cursor_send_prompt', { session_id: malformedSession.session_id, prompt: 'read' }); await waitTerminal(malformed, malformedSession.session_id, malformedTurn.turn_id);
  assert.equal(lastLogged(log).error.data.error_code, 'invalid_text_encoding'); await malformed.call('cursor_close_session', { session_id: malformedSession.session_id });

  writeFileSync(source, Buffer.alloc(LIMITS.fsBytes + 1, 0x61)); writeFileSync(log, '');
  const oversized = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LOG: log } }); const oversizedSession = await oversized.call('cursor_start_session', { cwd: root, mode: 'plan' }); const oversizedTurn = await oversized.call('cursor_send_prompt', { session_id: oversizedSession.session_id, prompt: 'read' }); await waitTerminal(oversized, oversizedSession.session_id, oversizedTurn.turn_id);
  assert.equal(lastLogged(log).error.data.error_code, 'resource_limit'); await oversized.call('cursor_close_session', { session_id: oversizedSession.session_id });

  writeFileSync(log, ''); const oversizedOutput = join(root, 'oversized-output.txt');
  const oversizedWriter = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: {
    FAKE_ACP_PATH: oversizedOutput, FAKE_ACP_FS_VARIANT: 'oversized-content', FAKE_ACP_LOG: log,
  } });
  const oversizedWriteSession = await oversizedWriter.call('cursor_start_session', { cwd: root, mode: 'agent' });
  const oversizedWriteTurn = await oversizedWriter.call('cursor_send_prompt', { session_id: oversizedWriteSession.session_id, prompt: 'write oversized' });
  const oversizedWriteTerminal = await waitTerminal(oversizedWriter, oversizedWriteSession.session_id, oversizedWriteTurn.turn_id);
  assert.equal(oversizedWriteTerminal.turn_status, 'failed');
  assert.match(oversizedWriteTerminal.terminal_reason.text, /frame limit/);
  assert.equal(Object.hasOwn(oversizedWriteTerminal, 'provider_error'), false);
  assert.equal(existsSync(oversizedOutput), false);
  await oversizedWriter.call('cursor_close_session', { session_id: oversizedWriteSession.session_id });

  writeFileSync(log, ''); const deniedOutput = join(root, 'denied.txt');
  const denied = withFake(t, { roots: [realpathSync(root)], pending: 'write', env: { FAKE_ACP_PATH: deniedOutput, FAKE_ACP_CONTENT: 'no', FAKE_ACP_LOG: log } }); const deniedSession = await denied.call('cursor_start_session', { cwd: root, mode: 'plan' }); const deniedTurn = await denied.call('cursor_send_prompt', { session_id: deniedSession.session_id, prompt: 'write' }); await waitTerminal(denied, deniedSession.session_id, deniedTurn.turn_id);
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
    await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(lastLogged(log).error.data.error_code, 'scope_rejected');
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  }

  writeFileSync(log, '');
  const runtime = withFake(t, { roots: [realpathSync(root)], pending: 'read', env: { FAKE_ACP_PATH: source, FAKE_ACP_LINE: '4', FAKE_ACP_LOG: log } });
  const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'plan' });
  const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'read after EOF' });
  await waitTerminal(runtime, session.session_id, turn.turn_id);
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
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.equal(lastLogged(log).error.data.error_code, scenario.error);
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });
  await t.test('read target deleted after validation returns an error without breaking the turn', async (caseT) => {
    const racedSource = join(root, 'deleted-after-validation.txt');
    const log = join(root, 'deleted-after-validation.jsonl');
    writeFileSync(racedSource, 'private file contents', 'utf8');
    const runtime = withInjectedFake(caseT, { roots: [realpathSync(root)], env: {
      FAKE_ACP_HOLD_PROMPT: '1', FAKE_ACP_LOG: log,
    } });
    const session = await runtime.call('cursor_start_session', { cwd: root, mode: 'plan' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'read a changing file' });
    const record = runtime.sessions.get(session.session_id);
    const checkedExistingFile = record.checkedExistingFile;
    record.checkedExistingFile = function (path) {
      const canonical = checkedExistingFile.call(this, path);
      rmSync(racedSource);
      return canonical;
    };
    try {
      record.receive(JSON.stringify({ jsonrpc: '2.0', id: 'read-deletion-race', method: 'fs/read_text_file',
        params: { sessionId: record.cursorSessionId, path: racedSource } }));
    } finally { record.checkedExistingFile = checkedExistingFile; }
    assert.equal(existsSync(racedSource), false);
    const status = await runtime.call('cursor_session_status', { session_id: session.session_id });
    assert.equal(status.session_state, 'live');
    assert.equal(status.active_turn.turn_id, turn.turn_id);
    assert.equal(status.active_turn.turn_status, 'running');
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
    const response = readJsonLines(log).find((entry) => entry.id === 'read-deletion-race');
    assert.equal(response.error.data.error_code, 'protocol_error');
    assert.equal(Object.hasOwn(response, 'result'), false);
    assert.doesNotMatch(JSON.stringify(response), /private file contents/);
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
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'completed');
    assert.deepEqual(terminal.pending, []);
    assert.throws(() => readFileSync(log, 'utf8'));
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('omitted read range returns the complete file', async (caseT) => {
    const { log, runtime, session } = await run(caseT, 'default-read');
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'default read' });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
    assert.deepEqual(readJsonLines(log)[0].result, { content: 'one\ntwo' });
    await runtime.call('cursor_close_session', { session_id: session.session_id });
  });

  await t.test('filesystem callback after turn completion is rejected', async (caseT) => {
    const { log, runtime, session } = await run(caseT, 'late-read');
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'late read' });
    assert.equal((await waitTerminal(runtime, session.session_id, turn.turn_id)).turn_status, 'completed');
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
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
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
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(terminal.turn_status, 'completed');
  assert.deepEqual(terminal.pending, []);
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
  let pendingEnvelope = await pendingRuntime.call('cursor_wait', { session_id: pendingSession.session_id, turn_id: pendingTurn.turn_id, timeout_ms: 1_000 });
  while (pendingEnvelope.pending.length < LIMITS.pending) {
    // A pending snapshot is immediately actionable; let the fixture publish its
    // next independent request rather than spinning on the same state.
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    pendingEnvelope = await pendingRuntime.call('cursor_wait', { session_id: pendingSession.session_id, turn_id: pendingTurn.turn_id, timeout_ms: 1_000 });
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

  const waiterRuntime = withInjectedFake(t, { env: { FAKE_ACP_HOLD_PROMPT: '1' } });
  const waiterSession = await waiterRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const waiterTurn = await waiterRuntime.call('cursor_send_prompt', { session_id: waiterSession.session_id, prompt: 'fill waiter capacity' });
  const waiters = Array.from({ length: LIMITS.waiters + 1 }, () => waiterRuntime.call('cursor_wait', {
    session_id: waiterSession.session_id,
    turn_id: waiterTurn.turn_id,
    timeout_ms: LIMITS.waitMaxMs,
  }).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  ));
  await new Promise((resolveWait) => setImmediate(resolveWait));
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
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let index = 0; index < LIMITS.tombstones + 1; index += 1) {
    if (index > 1) now += 1;
    const session = await tombstoneRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
    tombstones.push({ ...await tombstoneRuntime.call('cursor_close_session', { session_id: session.session_id }), closedAt: now });
  }
  const ordered = tombstones.sort((a, b) => a.closedAt - b.closedAt || a.session_id.localeCompare(b.session_id)).map((session) => session.session_id);
  await assert.rejects(tombstoneRuntime.call('cursor_session_status', { session_id: ordered[0] }), { error_code: 'unknown_session' });
  assert.equal(tombstoneRuntime.sessions.size, LIMITS.tombstones);
  for (const session_id of ordered.slice(1)) {
    assert.equal((await tombstoneRuntime.call('cursor_session_status', { session_id })).session_state, 'tombstone');
  }
});

test('event eviction does not prevent retained turn observation', async (t) => {
  const runtime = withFake(t);
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  let turn;
  for (let index = 0; index < LIMITS.events + 1; index += 1) {
    turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: `turn ${index}` });
    await waitTerminal(runtime, session.session_id, turn.turn_id);
  }
  const envelope = await runtime.call('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
  assert.equal(envelope.turn_status, 'completed');
  assert.deepEqual(envelope.pending, []);
  await runtime.call('cursor_close_session', { session_id: session.session_id });
});

test('bounded result text preserves UTF-8 code points', async (t) => {
  const boundary = `${'a'.repeat(7_994)}😀xyz`;
  const resultRuntime = withFake(t, { env: { FAKE_ACP_RESULT: boundary } }); const resultSession = await resultRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const resultTurn = await resultRuntime.call('cursor_send_prompt', { session_id: resultSession.session_id, prompt: 'result' }); const terminal = await waitTerminal(resultRuntime, resultSession.session_id, resultTurn.turn_id);
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
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(terminal.result.truncated, true);
  assert.equal(terminal.result.text.includes('TAIL_MARKER'), false);
  assert.equal(terminal.terminal_receipt.result_sha256, createHash('sha256').update(terminal.result.text).digest('hex'));

  const record = runtime.sessions.get(session.session_id);
  const before = {
    eventId: record.nextEvent,
    idleTimer: record.idleTimer,
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
  await waitTerminal(emptyRuntime, emptySession.session_id, emptyTurn.turn_id);
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
  await waitTerminal(failedRuntime, failedSession.session_id, failedTurn.turn_id);
  await assert.rejects(failedRuntime.call('cursor_read_result', {
    session_id: failedSession.session_id, turn_id: failedTurn.turn_id,
  }), { error_code: 'protocol_error' });

  const runtime = withInjectedFake(t, { env: { FAKE_ACP_RESULT: 'retained' } });
  const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
  const first = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'first' });
  await waitTerminal(runtime, session.session_id, first.turn_id);
  const second = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'second' });
  assert.equal((await runtime.call('cursor_read_result', { session_id: session.session_id, turn_id: first.turn_id })).text, 'retained');
  await waitTerminal(runtime, session.session_id, second.turn_id);
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
  const exactTerminal = await waitTerminal(exactRuntime, exactSession.session_id, exactTurn.turn_id);
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
  const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
  assert.equal(terminal.turn_status, 'failed');
  assert.deepEqual(terminal.terminal_reason, { text: 'terminal_result_limit', truncated: false });
  assert.equal(terminal.result, null);
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
      session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
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
    session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
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
    session_id: session.session_id, turn_id: exact.turn_id, timeout_ms: 1_000,
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
    session_id: session.session_id, turn_id: overflow.turn_id, timeout_ms: 1_000,
  });
  assert.equal(failed.turn_status, 'failed');
  assert.deepEqual(failed.terminal_reason, { text: 'terminal_result_limit', truncated: false });
  assert.equal(record.events.filter((event) => event.kind === 'result' && event.turn_id === overflow.turn_id).length, 1);
});

test('child exit and malformed ACP UTF-8 fail an allocated active turn', async (t) => {
  for (const variable of ['FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8']) {
    const runtime = withFake(t, { env: { [variable]: '1' } }); const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'fail' });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id); const tombstone = await waitSessionState(runtime, session.session_id, 'tombstone'); assert.equal(tombstone.session_state, 'tombstone'); assert.equal(terminal.turn_status, 'failed'); assert.equal(Object.hasOwn(terminal, 'failure_kind'), false); assert.equal(tombstone.failure_kind, null);
  }
});

test('oversized ACP frames and invalid agent text fail the allocated active turn', async (t) => {
  for (const variant of ['overflow-line', 'overflow-buffer', 'invalid-agent-message']) {
    const runtime = withFake(t, { env: { FAKE_ACP_FRAME_VARIANT: variant } });
    const session = await runtime.call('cursor_start_session', { cwd, mode: 'ask' });
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: variant });
    const terminal = await waitTerminal(runtime, session.session_id, turn.turn_id);
    assert.equal(terminal.turn_status, 'failed', variant);
    assert.equal(Object.hasOwn(terminal, 'failure_kind'), false, variant);
    assert.equal((await runtime.call('cursor_session_status', { session_id: session.session_id })).failure_kind, null, variant);
  }
});

test('ACP stdout EOF fails the allocated active turn', async (t) => {
  const eofRuntime = withFake(t, { env: { FAKE_ACP_STDOUT_EOF_ON_PROMPT: '1' } });
  const eofSession = await eofRuntime.call('cursor_start_session', { cwd, mode: 'ask' });
  const eofTurn = await eofRuntime.call('cursor_send_prompt', { session_id: eofSession.session_id, prompt: 'stdout EOF' });
  const eofTerminal = await waitTerminal(eofRuntime, eofSession.session_id, eofTurn.turn_id);
  assert.equal(eofTerminal.turn_status, 'failed');
  assert.match(eofTerminal.terminal_reason.text, /stdout EOF/);
  assert.equal((await waitSessionState(eofRuntime, eofSession.session_id, 'tombstone')).session_state, 'tombstone');
});

test('malformed and nonobject ACP frames follow init and active-turn failure lifecycles', async (t) => {
  for (const frame of ['{', 'null', '[]', '"text"', '{"jsonrpc":"2.0"}']) {
    const initRuntime = withFake(t, { env: { FAKE_ACP_INIT_FRAME: frame } }); const init = await initRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); assert.equal(init.session_state, 'tombstone'); assert.equal(init.failure_kind, 'init');
    const activeRuntime = withFake(t, { env: { FAKE_ACP_INVALID_FRAME: frame } }); const session = await activeRuntime.call('cursor_start_session', { cwd, mode: 'ask' }); const turn = await activeRuntime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'bad frame' }); const terminal = await waitTerminal(activeRuntime, session.session_id, turn.turn_id); const tombstone = await waitSessionState(activeRuntime, session.session_id, 'tombstone'); assert.equal(terminal.turn_status, 'failed'); assert.equal(Object.hasOwn(terminal, 'failure_kind'), false); assert.equal(tombstone.failure_kind, null);
  }
});
