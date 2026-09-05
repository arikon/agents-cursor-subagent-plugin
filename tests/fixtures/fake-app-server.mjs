import { createInterface } from 'node:readline';

const mode = process.env.FAKE_APP_SERVER_MODE;
if (mode === 'hang-close') process.on('SIGTERM', () => {});
let pendingTurn = null;
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') return;
  if (pendingTurn && request.id === 'server-0') {
    const turn = pendingTurn;
    pendingTurn = null;
    const expected = turn.mode === 'elicitation-handler-error'
      ? { jsonrpc: '2.0', id: 'server-0', error: { code: -32601, message: 'denied by test' } }
      : { jsonrpc: '2.0', id: 'server-0', result: { action: 'accept' } };
    if (JSON.stringify(request) !== JSON.stringify(expected)) {
      return process.stdout.write(`${JSON.stringify({ id: turn.id, error: { message: `unexpected server response: ${JSON.stringify(request)}` } })}\n`);
    }
    return process.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { item: { type: 'mcpToolCall', tool: 'cursor_delegate' } } })}\n${JSON.stringify({ id: turn.id, result: { turn: { id: turn.mode === 'elicitation-handler-error' ? 'turn-error-confirmed' : 'turn' } } })}\n`);
  }
  if (mode === 'timeout' && request.method === 'skills/list') return;
  if (mode === 'overflow') return process.stdout.write('x'.repeat(2_048));
  if (request.method === 'initialize') {
    if (mode === 'empty-error') return process.stdout.write(`${JSON.stringify({ id: request.id, error: {} })}\n`);
    if (mode === 'protocol-noise') {
      return process.stdout.write(`not-json\n${JSON.stringify({ id: 'unknown-request', result: { ignored: true } })}\n${JSON.stringify({ method: 'server/ready', params: { ready: true } })}\n${JSON.stringify({ id: request.id, result: { userAgent: 'fake-after-noise' } })}\n`);
    }
    return process.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'fake' } })}\n`);
  }
  if (request.method === 'thread/start') {
    if (mode === 'exit-on-thread-start') return process.exit(7);
    return process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: 'isolated-thread' } } })}\n`);
  }
  if (request.method === 'thread/archive') return process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  if (request.method === 'skills/list') {
    if (mode === 'invalid-skills-list') return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: null } })}\n`);
    return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ cwd: request.params.cwds[0], skills: [{ name: 'codex-cursor-subagent-plugin:cursor-subagent', path: '/installed/skills/cursor-subagent/SKILL.md', enabled: true, pluginId: 'codex-cursor-subagent-plugin@personal' }] }] } })}\n`);
  }
  if (request.method === 'turn/start' && (mode === 'elicitation' || mode === 'elicitation-handler-error')) {
    pendingTurn = { id: request.id, mode };
    return process.stdout.write(`${JSON.stringify({ method: 'item/started', params: { item: { type: 'mcpToolCall', tool: 'cursor_delegate' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 'server-0', method: 'mcpServer/elicitation/request', params: { serverName: 'cursor-subagent', _meta: { codex_approval_kind: 'mcp_tool_call' } } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'unknown method' } })}\n`);
});
