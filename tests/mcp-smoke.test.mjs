import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const serverPath = new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url);
const pluginMcpConfigPath = new URL('../.mcp.json', import.meta.url);

test('personal plugin configuration uses the confirmed ChatGPT Node and Cursor file credentials', () => {
  const config = JSON.parse(readFileSync(pluginMcpConfigPath, 'utf8'));
  const server = config.mcpServers['cursor-subagent'];
  assert.equal(server.command, '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node');
  assert.equal(server.env.AGENT_CLI_CREDENTIAL_STORE, 'file');
  assert.equal(server.env.CURSOR_AGENT_COMMAND, '/Users/arikon/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/cursor-agent');
});

test('MCP server advertises Cursor session tools without starting Cursor', async (t) => {
  const child = spawn(process.execPath, [serverPath.pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const next = () => once(lines, 'line').then(([line]) => JSON.parse(line));

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  const initialise = await next();
  assert.equal(initialise.result.serverInfo.name, 'cursor-subagent');

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await next();
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'cursor_delegate',
    'cursor_start_session', 'cursor_send_prompt', 'cursor_session_status', 'cursor_wait',
    'cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission',
    'cursor_cancel', 'cursor_close_session',
  ]);
  const waitTool = listed.result.tools.find((tool) => tool.name === 'cursor_wait');
  assert.deepEqual(waitTool.inputSchema.required, ['session_id', 'turn_id']);
  assert.deepEqual(Object.keys(waitTool.inputSchema.properties), ['session_id', 'turn_id', 'after_event_id', 'timeout_ms']);
  assert.deepEqual(waitTool.inputSchema.properties.timeout_ms, { type: 'integer', minimum: 1_000, maximum: 60_000 });
  const questionTool = listed.result.tools.find((tool) => tool.name === 'cursor_answer_question');
  assert.deepEqual(questionTool.inputSchema.properties.outcome.enum, ['answered', 'skipped', 'cancelled']);
  assert.equal(questionTool.inputSchema.properties.answers.items.additionalProperties, false);
  const permissionTool = listed.result.tools.find((tool) => tool.name === 'cursor_answer_permission');
  assert.deepEqual(permissionTool.inputSchema.properties.decision.enum, ['allow-once', 'reject-once']);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/templates/list', params: {} })}\n`);
  const templates = await next();
  assert.deepEqual(templates.result, { resourceTemplates: [] });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} })}\n`);
  const resources = await next();
  assert.deepEqual(resources.result, { resources: [] });
});

test('MCP server fails loudly when its packaged manifest is absent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-no-manifest-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts'); mkdirSync(scripts); const copy = join(scripts, 'cursor-subagent-mcp.mjs'); copyFileSync(serverPath, copy);
  const child = spawn(process.execPath, [copy], { stdio: ['ignore', 'ignore', 'pipe'] }); const stderr = []; child.stderr.on('data', (chunk) => stderr.push(chunk)); const [code] = await once(child, 'exit');
  assert.notEqual(code, 0); assert.match(Buffer.concat(stderr).toString('utf8'), /plugin\.json|manifest/i);
});

test('MCP stdin rejects malformed UTF-8, oversized frames and aggregate arguments, then keeps serving', async (t) => {
  const child = spawn(process.execPath, [serverPath.pathname], { stdio: ['pipe', 'pipe', 'pipe'] }); t.after(() => child.kill()); const lines = createInterface({ input: child.stdout }); const next = () => once(lines, 'line').then(([line]) => JSON.parse(line));
  child.stdin.write(Buffer.from([0xc3, 0x28, 0x0a])); assert.equal((await next()).error.code, -32700);
  child.stdin.write(Buffer.concat([Buffer.alloc(1_048_577, 0x61), Buffer.from('\n')])); assert.equal((await next()).error.code, -32700);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cursor_answer_question', arguments: { session_id: 's', turn_id: 't', request_id: 'r', outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['x'.repeat(70_000)] }] } } })}\n`);
  const aggregate = await next(); assert.equal(aggregate.result.isError, true); assert.equal(JSON.parse(aggregate.result.content[0].text).error_code, 'invalid_args');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`); assert.ok((await next()).result.tools.length > 0);
});
