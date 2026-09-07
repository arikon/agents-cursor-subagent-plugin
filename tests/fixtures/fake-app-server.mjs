import { createInterface } from 'node:readline';

const mode = process.env.FAKE_APP_SERVER_MODE;
if (mode === 'hang-close') process.on('SIGTERM', () => {});
let pendingTurn = null;
let lateCaptureReads = 0;
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
  if (request.method === 'thread/turns/list' && mode?.startsWith('capture-')) {
    if (mode === 'capture-slow') return setTimeout(() => process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: 'evaluated-turn', status: 'completed' }], nextCursor: null } })}\n`), 500);
    if (mode === 'capture-invalid-turn-entry') return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: 'evaluated-turn', status: 'future' }], nextCursor: null } })}\n`);
    if (mode === 'capture-turn-error') return process.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'turn page failed' } })}\n`);
    if (mode === 'capture-turn-absent') return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
    if (mode === 'capture-turn-cycle' || mode === 'capture-turn-page-limit') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: 'other-turn', status: 'completed' }], nextCursor: 'same-turn-page' } })}\n`);
    }
    if (mode === 'capture-corrupt') return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: null, nextCursor: null } })}\n`);
    if (mode === 'capture-paginated' && request.params.cursor === null) {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: 'other-turn', status: 'completed' }], nextCursor: 'turn-page-2' } })}\n`);
    }
    const status = mode === 'capture-incomplete' ? 'inProgress' : 'completed';
    return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: 'evaluated-turn', status }], nextCursor: null } })}\n`);
  }
  if (request.method === 'thread/items/list' && mode?.startsWith('capture-')) {
    if (mode === 'capture-slow-items') return setTimeout(() => process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`), 500);
    if (mode === 'capture-item-error') return process.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'item page failed' } })}\n`);
    if (mode === 'capture-item-page-limit') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: 'next-item-page' } })}\n`);
    }
    if (mode === 'capture-cycle') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: 'same-page' } })}\n`);
    }
    if (mode === 'capture-paginated' && request.params.cursor === null) {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [
        { turnId: 'evaluated-turn', item: { type: 'reasoning', id: 'reasoning-before-final', summary: [] } },
        { turnId: 'evaluated-turn', item: { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: 'not final' } },
      ], nextCursor: 'item-page-2' } })}\n`);
    }
    if (mode === 'capture-paginated') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ turnId: 'evaluated-turn', item: { type: 'agentMessage', id: 'paginated-final', phase: 'final_answer', text: 'PAGINATED FINAL' } }], nextCursor: null } })}\n`);
    }
    if (mode === 'capture-late') {
      lateCaptureReads += 1;
      const data = lateCaptureReads === 1 ? [] : [{ turnId: 'evaluated-turn', item: { type: 'agentMessage', id: 'late-final', phase: 'final_answer', text: 'LATE FINAL' } }];
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data, nextCursor: null } })}\n`);
    }
    if (mode === 'capture-empty') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ turnId: 'evaluated-turn', item: { type: 'agentMessage', id: 'empty-final', phase: 'final_answer', text: '' } }], nextCursor: null } })}\n`);
    }
    if (mode === 'capture-legacy') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ turnId: 'evaluated-turn', item: { type: 'agentMessage', id: 'legacy-final', phase: null, text: 'LEGACY FINAL' } }], nextCursor: null } })}\n`);
    }
    if (mode === 'capture-corrupt-items') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: null, nextCursor: null } })}\n`);
    }
    if (mode === 'capture-long') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ turnId: 'evaluated-turn', item: { type: 'agentMessage', id: 'long-final', phase: 'final_answer', text: 'x'.repeat(100_000) } }], nextCursor: null } })}\n`);
    }
    if (mode === 'capture-limit' || mode === 'capture-oversized') {
      const bytes = mode === 'capture-limit' ? 1_000_000 : 1_000_001;
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ turnId: 'evaluated-turn', item: { type: 'agentMessage', id: 'bounded-final', phase: 'final_answer', text: 'x'.repeat(bytes) } }], nextCursor: null } })}\n`);
    }
    if (mode === 'capture-missing-id') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ turnId: 'evaluated-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'INVALID FINAL' } }], nextCursor: null } })}\n`);
    }
    if (mode === 'capture-wrong-item-turn') {
      return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ turnId: 'other-turn', item: { type: 'agentMessage', id: 'wrong-turn-final', phase: 'final_answer', text: 'INVALID FINAL' } }], nextCursor: null } })}\n`);
    }
    return process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
  }
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
