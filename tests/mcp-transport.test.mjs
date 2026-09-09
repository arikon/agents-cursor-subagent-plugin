import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADAPTER } from '../scripts/cursor-subagent-mcp.mjs';

const server = fileURLToPath(new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const modelPreload = fileURLToPath(new URL('./fixtures/release-model-discovery-preload.mjs', import.meta.url));

async function transport(t, env = {}) {
  const child = spawn(process.execPath, ['--import', modelPreload, server], {
    env: {
      ...process.env,
      CURSOR_AGENT_COMMAND: process.execPath,
      CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
      CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify([process.cwd()]),
      FAKE_ACP_REQUIRE_POLICY: '1',
      RELEASE_MODEL_CATALOG: fileURLToPath(new URL('./fixtures/cursor-model-catalog-1.0.31.json', import.meta.url)),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));

  const waitFor = async (predicate) => {
    for (;;) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await once(lines, 'line');
    }
  };
  const sendRaw = (line) => child.stdin.write(`${line}\n`);
  let nextId = 1;
  const request = async (method, params = {}) => {
    const id = nextId++;
    sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return waitFor((message) => message.id === id);
  };
  const tool = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.result?.isError, false, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };

  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return { child, messages, request, sendRaw, tool, waitFor };
}

test('MCP startup negotiates the public protocol and exposes no resources or prompts', async (t) => {
  const client = await transport(t);
  const initialized = await client.request('initialize');
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  assert.equal(initialized.result.serverInfo.name, 'cursor-subagent');
  assert.equal(initialized.result.serverInfo.version, ADAPTER.initialize().clientInfo.version);
  assert.deepEqual((await client.request('resources/list')).result, { resources: [] });
  assert.deepEqual((await client.request('resources/templates/list')).result, { resourceTemplates: [] });
  assert.deepEqual((await client.request('prompts/list')).result, { prompts: [] });
});

test('MCP tools/list publishes the stable tool names and answer schemas', async (t) => {
  const client = await transport(t);
  await client.request('initialize', { protocolVersion: '2024-11-05' });
  const tools = (await client.request('tools/list')).result.tools;
  assert.deepEqual(tools.map((item) => item.name), [
    'cursor_list_models',
    'cursor_delegate',
    'cursor_start_session',
    'cursor_resume_session',
    'cursor_send_prompt',
    'cursor_set_mode',
    'cursor_session_status',
    'cursor_read_result',
    'cursor_wait',
    'cursor_answer_question',
    'cursor_answer_plan',
    'cursor_answer_permission',
    'cursor_cancel',
    'cursor_close_session',
  ]);
  const byName = Object.fromEntries(tools.map((item) => [item.name, item.inputSchema]));
  assert.deepEqual(byName.cursor_list_models, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(byName.cursor_wait.required, ['session_id', 'turn_id']);
  assert.deepEqual(byName.cursor_wait.properties.timeout_ms, { type: 'integer', minimum: 1_000, maximum: 180_000 });
  assert.deepEqual(byName.cursor_wait.properties.after_progress_revision, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(byName.cursor_read_result.required, ['session_id', 'turn_id']);
  assert.deepEqual(byName.cursor_read_result.properties.offset, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
  for (const name of ['cursor_delegate', 'cursor_start_session', 'cursor_resume_session']) {
    assert.equal(byName[name].additionalProperties, false);
    assert.deepEqual(byName[name].properties.optimize_for, { type: 'string', enum: ['cost', 'balanced', 'intelligence'] });
    assert.equal(byName[name].properties.model.pattern, '^[^\\[\\]]+$');
    assert.equal(byName[name].properties.effort.pattern, '^[A-Za-z0-9._-]+$');
  }
  assert.deepEqual(byName.cursor_start_session.properties.plugin_dirs, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, maxLength: 64_000 } });
  assert.deepEqual(byName.cursor_set_mode.required, ['session_id', 'mode']);
  assert.deepEqual(byName.cursor_set_mode.properties.mode, { type: 'string', enum: ['ask', 'plan', 'agent'] });
  assert.equal(byName.cursor_resume_session.required.includes('cursor_session_id'), true);
  assert.deepEqual(byName.cursor_answer_question.properties.outcome.enum, ['answered', 'skipped', 'cancelled']);
  assert.deepEqual(byName.cursor_answer_plan.properties.decision.enum, ['accept', 'reject']);
  assert.deepEqual(byName.cursor_answer_permission.properties.decision.enum, ['allow-once', 'reject-once']);
});

test('MCP maps requests and notifications to standard JSON-RPC outcomes', async (t) => {
  const client = await transport(t);
  await client.request('initialize', { protocolVersion: '2024-11-05' });

  client.sendRaw(JSON.stringify({ jsonrpc: '1.0', id: 'bad-version', method: 'tools/list' }));
  assert.deepEqual((await client.waitFor((message) => message.id === 'bad-version')).error, {
    code: -32600,
    message: 'Invalid Request',
  });
  assert.deepEqual((await client.request('not/admitted')).error, {
    code: -32601,
    message: 'Method not found',
  });

  const invalidTool = await client.request('tools/call', {
    name: 'cursor_start_session',
    arguments: { cwd: '.', mode: 'ask' },
  });
  assert.equal(invalidTool.result.isError, true);
  assert.equal(JSON.parse(invalidTool.result.content[0].text).error_code, 'invalid_args');
  for (const argumentsValue of [null, { cwd: '.', mode: 'ask', unexpected: true }]) {
    const rejected = await client.request('tools/call', { name: 'cursor_start_session', arguments: argumentsValue });
    assert.equal(rejected.result.isError, true);
    assert.equal(JSON.parse(rejected.result.content[0].text).error_code, 'invalid_args');
  }

  client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  client.sendRaw(JSON.stringify({ jsonrpc: '1.0', method: 'tools/list' }));
  assert.equal((await client.request('tools/list')).result.tools.length, 14);
  assert.deepEqual(client.messages, []);
});

test('MCP keeps notifications silent and bounds untrusted tool errors', async (t) => {
  const client = await transport(t);
  await client.request('initialize');

  client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'not/admitted' }));
  client.sendRaw(JSON.stringify({ jsonrpc: '1.0', method: 'tools/list' }));
  client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: '\ud800' }));
  assert.equal((await client.request('tools/list')).result.tools.length, 14);
  assert.deepEqual(client.messages, []);

  const response = await client.request('tools/call', {
    name: `unknown-${'x'.repeat(9_000)}`,
    arguments: {},
  });
  assert.equal(response.result.isError, true);
  const failure = JSON.parse(response.result.content[0].text);
  assert.equal(failure.error_code, 'invalid_args');
  assert.ok(Buffer.byteLength(failure.message, 'utf8') <= 8_000);
  assert.match(failure.message, /…$/);
});

test('MCP wires cursor_read_result through the public tool boundary', async (t) => {
  const client = await transport(t, { FAKE_ACP_RESULT: 'wire-result' });
  await client.request('initialize');
  const session = await client.tool('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
  const turn = await client.tool('cursor_send_prompt', { session_id: session.session_id, prompt: 'Complete.' });
  await client.tool('cursor_wait', {
    session_id: session.session_id, turn_id: turn.turn_id,
    after_event_id: turn.last_event_id, timeout_ms: 1_000,
  });
  const page = await client.tool('cursor_read_result', {
    session_id: session.session_id, turn_id: turn.turn_id,
  });
  assert.equal(page.text, 'wire-result');
  await client.tool('cursor_close_session', { session_id: session.session_id });
});

test('MCP tools/call wires interactive answers, status and cancellation', async (t) => {
  for (const scenario of [
    {
      pending: 'question-optional', mode: 'ask', answer: 'cursor_answer_question',
      args: { request_id: 'q1', outcome: 'cancelled' }, kind: 'question',
    },
    {
      pending: 'plan-optional', mode: 'plan', answer: 'cursor_answer_plan',
      args: { request_id: 'plan1', decision: 'reject' }, kind: 'plan',
    },
    {
      pending: 'permission-optional', mode: 'agent', answer: 'cursor_answer_permission',
      args: { request_id: 'p1', decision: 'allow-once' }, kind: 'permission',
    },
  ]) await t.test(scenario.kind, async (caseT) => {
    const client = await transport(caseT, { FAKE_ACP_PENDING: scenario.pending });
    await client.request('initialize');
    const session = await client.tool('cursor_start_session', { cwd: process.cwd(), mode: scenario.mode });
    assert.equal((await client.tool('cursor_session_status', { session_id: session.session_id })).session_state, 'live');
    const turn = await client.tool('cursor_send_prompt', { session_id: session.session_id, prompt: `Handle ${scenario.kind}.` });
    const waiting = await client.tool('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      after_event_id: turn.last_event_id,
      timeout_ms: 1_000,
    });
    assert.equal(waiting.turn_status, 'waiting_for_input');
    assert.equal(waiting.pending[0].kind, scenario.kind);
    assert.ok(waiting.pending[0].context, 'primary wait result must include normalized pending context');
    const unknownPending = await client.request('tools/call', {
      name: scenario.answer,
      arguments: {
        session_id: session.session_id,
        turn_id: turn.turn_id,
        ...scenario.args,
        request_id: 'not-advertised',
      },
    });
    assert.equal(unknownPending.result.isError, true);
    assert.equal(JSON.parse(unknownPending.result.content[0].text).error_code, 'unknown_request');
    const answered = await client.tool(scenario.answer, {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      ...scenario.args,
    });
    const completed = await client.tool('cursor_wait', {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      after_event_id: answered.last_event_id,
      timeout_ms: 1_000,
    });
    assert.equal(completed.turn_status, 'completed');
    assert.equal((await client.tool('cursor_close_session', { session_id: session.session_id })).session_state, 'tombstone');
  });

  const cancelClient = await transport(t, { FAKE_ACP_DELAY_RESULT_MS: '250' });
  await cancelClient.request('initialize');
  const session = await cancelClient.tool('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
  const turn = await cancelClient.tool('cursor_send_prompt', { session_id: session.session_id, prompt: 'Wait for cancellation.' });
  const cancelled = await cancelClient.tool('cursor_cancel', { session_id: session.session_id, turn_id: turn.turn_id });
  assert.equal(cancelled.turn_status, 'cancelled');
  assert.equal(cancelled.session_state, 'tombstone');
});

test('MCP exposes adapter bootstrap failures as terminal session state', async (t) => {
  for (const adapterArgs of ['not-json', JSON.stringify([42])]) await t.test(adapterArgs, async (caseT) => {
    const client = await transport(caseT, { CURSOR_SUBAGENT_ADAPTER_ARGS: adapterArgs });
    await client.request('initialize');
    const session = await client.tool('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
    assert.equal(session.session_state, 'tombstone');
    assert.equal(session.failure_kind, 'init');
  });
});

test('MCP framing rejects malformed and oversized input, then resumes at frame boundaries', async (t) => {
  const client = await transport(t);
  await client.request('initialize', { protocolVersion: '2024-11-05' });

  client.child.stdin.write(Buffer.from([0xc3, 0x28, 0x0a]));
  assert.equal((await client.waitFor((message) => message.id === null)).error.code, -32700);
  client.child.stdin.write(Buffer.from('{\n'));
  assert.equal((await client.waitFor((message) => message.id === null)).error.code, -32700);

  client.child.stdin.write(Buffer.from(`${'x'.repeat(1_048_577)}\n${JSON.stringify({ jsonrpc: '2.0', id: 'after-complete-limit', method: 'tools/list' })}\n`));
  assert.equal((await client.waitFor((message) => message.id === null)).error.code, -32700);
  assert.equal((await client.waitFor((message) => message.id === 'after-complete-limit')).result.tools.length, 14);

  client.child.stdin.write(Buffer.alloc(1_048_577, 0x61));
  assert.equal((await client.waitFor((message) => message.id === null)).error.code, -32700);
  client.child.stdin.write(Buffer.from(`discarded remainder\n${JSON.stringify({ jsonrpc: '2.0', id: 'after-limit', method: 'tools/list' })}\r\n`));
  assert.equal((await client.waitFor((message) => message.id === 'after-limit')).result.tools.length, 14);
});

test('MCP server fails closed when its packaged manifest version is corrupted', async (t) => {
  for (const manifest of ['{"version":"corrupt"}\n', '{"version":1}\n', '{}\n']) await t.test(manifest.trim(), async (caseT) => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-corrupt-manifest-'));
    caseT.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, '.codex-plugin'));
    const copiedServer = join(root, 'scripts', 'cursor-subagent-mcp.mjs');
    copyFileSync(server, copiedServer);
    copyFileSync(new URL('../scripts/cursor-model-adapter.mjs', import.meta.url), join(root, 'scripts', 'cursor-model-adapter.mjs'));
    writeFileSync(join(root, '.codex-plugin', 'plugin.json'), manifest, 'utf8');

    const child = spawn(process.execPath, [copiedServer], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0);
    assert.match(stderr, /plugin manifest has no valid version/);
  });
});

test('MCP tools/call wires one complete session through stdio JSON-RPC', async (t) => {
  const client = await transport(t);
  await client.request('initialize', { protocolVersion: '2024-11-05' });

  const session = await client.tool('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
  const turn = await client.tool('cursor_send_prompt', {
    session_id: session.session_id,
    prompt: 'Complete this transport canary.',
  });
  const completed = await client.tool('cursor_wait', {
    session_id: session.session_id,
    turn_id: turn.turn_id,
    after_event_id: turn.last_event_id,
    timeout_ms: 1_000,
  });
  assert.equal(completed.turn_status, 'completed');
  const retained = await client.tool('cursor_wait', {
    session_id: session.session_id,
    turn_id: turn.turn_id,
  });
  assert.equal(retained.turn_status, 'completed');
  assert.equal(retained.wait_timeout, false);

  const staleAnswer = await client.request('tools/call', {
    name: 'cursor_answer_question',
    arguments: {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      request_id: 'not-live',
      outcome: 'cancelled',
    },
  });
  assert.equal(staleAnswer.result.isError, true);
  assert.equal(JSON.parse(staleAnswer.result.content[0].text).error_code, 'unknown_request');
  assert.equal((await client.tool('cursor_close_session', { session_id: session.session_id })).session_state, 'tombstone');
});
