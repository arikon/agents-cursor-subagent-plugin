import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const serverPath = new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url);

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
    'cursor_start_session', 'cursor_send_prompt', 'cursor_session_status',
    'cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission',
    'cursor_cancel', 'cursor_close_session',
  ]);
  const statusTool = listed.result.tools.find((tool) => tool.name === 'cursor_session_status');
  assert.deepEqual(statusTool.inputSchema.properties.detail.enum, ['summary', 'full']);
  assert.equal(statusTool.inputSchema.properties.max_chars.maximum, 8_000);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/templates/list', params: {} })}\n`);
  const templates = await next();
  assert.deepEqual(templates.result, { resourceTemplates: [] });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} })}\n`);
  const resources = await next();
  assert.deepEqual(resources.result, { resources: [] });
});
