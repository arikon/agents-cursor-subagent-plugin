import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));

async function transport(t) {
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      CURSOR_AGENT_COMMAND: process.execPath,
      CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
      CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify([process.cwd()]),
      FAKE_ACP_REQUIRE_POLICY: '1',
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
  assert.deepEqual((await client.request('resources/list')).result, { resources: [] });
  assert.deepEqual((await client.request('resources/templates/list')).result, { resourceTemplates: [] });
  assert.deepEqual((await client.request('prompts/list')).result, { prompts: [] });
});

test('MCP tools/list publishes the stable tool names and answer schemas', async (t) => {
  const client = await transport(t);
  await client.request('initialize', { protocolVersion: '2024-11-05' });
  const tools = (await client.request('tools/list')).result.tools;
  assert.deepEqual(tools.map((item) => item.name), [
    'cursor_delegate',
    'cursor_start_session',
    'cursor_send_prompt',
    'cursor_session_status',
    'cursor_wait',
    'cursor_answer_question',
    'cursor_answer_plan',
    'cursor_answer_permission',
    'cursor_cancel',
    'cursor_close_session',
  ]);
  const byName = Object.fromEntries(tools.map((item) => [item.name, item.inputSchema]));
  assert.deepEqual(byName.cursor_wait.required, ['session_id', 'turn_id']);
  assert.deepEqual(byName.cursor_wait.properties.timeout_ms, { type: 'integer', minimum: 1_000, maximum: 60_000 });
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

  client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  client.sendRaw(JSON.stringify({ jsonrpc: '1.0', method: 'tools/list' }));
  assert.equal((await client.request('tools/list')).result.tools.length, 10);
  assert.deepEqual(client.messages, []);
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
  assert.equal((await client.waitFor((message) => message.id === 'after-complete-limit')).result.tools.length, 10);

  client.child.stdin.write(Buffer.alloc(1_048_577, 0x61));
  assert.equal((await client.waitFor((message) => message.id === null)).error.code, -32700);
  client.child.stdin.write(Buffer.from(`discarded remainder\n${JSON.stringify({ jsonrpc: '2.0', id: 'after-limit', method: 'tools/list' })}\r\n`));
  assert.equal((await client.waitFor((message) => message.id === 'after-limit')).result.tools.length, 10);
});

test('MCP server fails closed when its packaged manifest version is corrupted', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-corrupt-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, '.codex-plugin'));
  const copiedServer = join(root, 'scripts', 'cursor-subagent-mcp.mjs');
  copyFileSync(server, copiedServer);
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), '{"version":"corrupt"}\n', 'utf8');

  const child = spawn(process.execPath, [copiedServer], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(stderr, /plugin manifest has no valid version/);
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
  assert.equal((await client.tool('cursor_close_session', { session_id: session.session_id })).session_state, 'tombstone');
});
