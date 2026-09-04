import { createInterface } from 'node:readline';

const mode = process.env.FAKE_APP_SERVER_MODE;
if (mode === 'hang-close') process.on('SIGTERM', () => {});
let pendingServerRequest = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') return;
  if (pendingServerRequest && request.id === 'server-0') {
    pendingServerRequest = false;
    return process.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { item: { type: 'mcpToolCall', tool: 'cursor_delegate' } } })}\n${JSON.stringify({ id: 'client-2', result: { turn: { id: 'turn' } } })}\n`);
  }
  if (mode === 'timeout' && request.method === 'skills/list') return;
  if (mode === 'overflow') return process.stdout.write('x'.repeat(2_048));
  if (request.method === 'initialize') return process.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'fake' } })}\n`);
  if (request.method === 'thread/archive') return process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  if (request.method === 'skills/list') return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ cwd: request.params.cwds[0], skills: [{ name: 'codex-cursor-subagent-plugin:cursor-subagent', path: '/installed/skills/cursor-subagent/SKILL.md', enabled: true, pluginId: 'codex-cursor-subagent-plugin@personal' }] }] } })}\n`);
  if (request.method === 'turn/start' && mode === 'elicitation') {
    pendingServerRequest = true;
    return process.stdout.write(`${JSON.stringify({ method: 'item/started', params: { item: { type: 'mcpToolCall', tool: 'cursor_delegate' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 'server-0', method: 'mcpServer/elicitation/request', params: { serverName: 'cursor-subagent', _meta: { codex_approval_kind: 'mcp_tool_call' } } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'unknown method' } })}\n`);
});
