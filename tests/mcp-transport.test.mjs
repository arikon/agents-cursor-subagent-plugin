import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));

async function transport(t, pending = '') {
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      CURSOR_AGENT_COMMAND: process.execPath,
      CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
      CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify([process.cwd()]),
      FAKE_ACP_PENDING: pending,
      FAKE_ACP_REQUIRE_POLICY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  let nextId = 1;
  const request = async (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (;;) {
      const index = messages.findIndex((message) => message.id === id);
      if (index >= 0) return messages.splice(index, 1)[0];
      await once(lines, 'line');
    }
  };
  const tool = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.result?.isError, false, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  t.after(async () => {
    child.stdin.end();
    await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const initialized = await request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result?.serverInfo?.name, 'cursor-subagent');
  return { request, tool };
}

async function pendingTurn(client, mode) {
  const session = await client.tool('cursor_start_session', { cwd: process.cwd(), mode });
  const turn = await client.tool('cursor_send_prompt', { session_id: session.session_id, prompt: 'Need an explicit response.' });
  const waiting = await client.tool('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 1_000 });
  return { session, turn, waiting };
}

test('MCP tools/call transports the delegate, advanced session, wait, cancel, and close tools', async (t) => {
  const client = await transport(t, 'question');
  const session = await client.tool('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
  const status = await client.tool('cursor_session_status', { session_id: session.session_id });
  assert.equal(status.session_state, 'live');
  const first = await client.tool('cursor_send_prompt', { session_id: session.session_id, prompt: 'Cancel this pending turn.' });
  const waiting = await client.tool('cursor_wait', { session_id: session.session_id, turn_id: first.turn_id, after_event_id: first.last_event_id, timeout_ms: 1_000 });
  assert.equal(waiting.turn_status, 'waiting_for_input');
  const cancelled = await client.tool('cursor_cancel', { session_id: session.session_id, turn_id: first.turn_id });
  assert.equal(cancelled.turn_status, 'cancelled');
  const closed = await client.tool('cursor_close_session', { session_id: session.session_id });
  assert.equal(closed.session_state, 'tombstone');
  const delegated = await client.tool('cursor_delegate', { cwd: process.cwd(), mode: 'ask', prompt: 'Delegate normally.' });
  const delegatedWaiting = await client.tool('cursor_wait', { session_id: delegated.session_id, turn_id: delegated.turn_id, after_event_id: delegated.last_event_id, timeout_ms: 1_000 });
  assert.equal(delegatedWaiting.turn_status, 'waiting_for_input');
  await client.tool('cursor_close_session', { session_id: delegated.session_id });
});

for (const scenario of [
  { pending: 'question', mode: 'ask', tool: 'cursor_answer_question', answer: (turn) => ({ outcome: 'answered', answers: [{ question_id: 'q', selected_option_ids: ['yes'] }] }) },
  { pending: 'plan', mode: 'plan', tool: 'cursor_answer_plan', answer: () => ({ decision: 'accept' }) },
  { pending: 'permission', mode: 'agent', tool: 'cursor_answer_permission', answer: () => ({ decision: 'allow-once' }) },
]) {
  test(`MCP tools/call transports ${scenario.tool}`, async (t) => {
    const client = await transport(t, scenario.pending);
    const { session, turn, waiting } = await pendingTurn(client, scenario.mode);
    const pending = waiting.active_turn.pending[0];
    const answered = await client.tool(scenario.tool, {
      session_id: session.session_id,
      turn_id: turn.turn_id,
      request_id: pending.request_id,
      ...scenario.answer(turn),
    });
    assert.equal(answered.session_id, session.session_id);
    const completed = await client.tool('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, after_event_id: answered.last_event_id, timeout_ms: 1_000 });
    assert.equal(completed.turn_status, 'completed');
    await client.tool('cursor_close_session', { session_id: session.session_id });
  });
}
