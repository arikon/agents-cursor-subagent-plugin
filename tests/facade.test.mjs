import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Runtime } from '../scripts/cursor-subagent-mcp.mjs';

const cwd = process.cwd();
const fakeAcp = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const skillPath = new URL('../skills/cursor-subagent/SKILL.md', import.meta.url);

function facadeHarness({ startResult, startError, promptResult, promptError } = {}) {
  const runtime = new Runtime({ roots: [cwd] });
  const transcript = [];

  runtime.start = async (args) => {
    transcript.push({ tool: 'cursor_start_session', args });
    if (startError) throw startError;
    return startResult;
  };

  runtime.call = async function call(name, args) {
    if (name === 'cursor_delegate') return Runtime.prototype.call.call(this, name, args);
    transcript.push({ tool: name, args });
    if (name === 'cursor_send_prompt') {
      if (promptError) throw promptError;
      return promptResult;
    }
    if (name === 'cursor_close_session') return { session_id: args.session_id, session_state: 'tombstone' };
    throw new Error(`unexpected facade operation: ${name}`);
  };

  return { runtime, transcript };
}

test('cursor_delegate performs exactly one start and one first prompt without wait or retry', async () => {
  const startResult = { session_id: 'session-full-id', session_state: 'live' };
  const promptResult = { ...startResult, turn_id: 'turn-full-id', turn_status: 'running' };
  const { runtime, transcript } = facadeHarness({ startResult, promptResult });

  const result = await runtime.call('cursor_delegate', { cwd, mode: 'agent', prompt: 'Implement the task' });

  assert.strictEqual(result, promptResult);
  assert.deepEqual(transcript, [
    { tool: 'cursor_start_session', args: { cwd, mode: 'agent' } },
    { tool: 'cursor_send_prompt', args: { session_id: 'session-full-id', prompt: 'Implement the task' } },
  ]);
});

test('cursor_delegate preserves start failures and allocated tombstones unchanged', async () => {
  const startError = new Error('scope rejected by runtime');
  const rejected = facadeHarness({ startError });
  await assert.rejects(
    rejected.runtime.call('cursor_delegate', { cwd, mode: 'ask', prompt: 'Inspect' }),
    (error) => error === startError,
  );
  assert.deepEqual(rejected.transcript, [
    { tool: 'cursor_start_session', args: { cwd, mode: 'ask' } },
  ]);

  const tombstone = { session_id: 'failed-session', session_state: 'tombstone', failure_kind: 'init' };
  const allocated = facadeHarness({ startResult: tombstone });
  const result = await allocated.runtime.call('cursor_delegate', { cwd, mode: 'plan', prompt: 'Plan' });
  assert.strictEqual(result, tombstone);
  assert.deepEqual(allocated.transcript, [
    { tool: 'cursor_start_session', args: { cwd, mode: 'plan' } },
  ]);
});

test('cursor_delegate preserves first-prompt error and closes the allocated session exactly once', async () => {
  const startResult = { session_id: 'session-full-id', session_state: 'live' };
  const promptError = new Error('prompt dispatch rejected by runtime');
  const { runtime, transcript } = facadeHarness({ startResult, promptError });

  await assert.rejects(
    runtime.call('cursor_delegate', { cwd, mode: 'ask', prompt: 'Inspect' }),
    (error) => error === promptError,
  );
  assert.deepEqual(transcript, [
    { tool: 'cursor_start_session', args: { cwd, mode: 'ask' } },
    { tool: 'cursor_send_prompt', args: { session_id: 'session-full-id', prompt: 'Inspect' } },
    { tool: 'cursor_close_session', args: { session_id: 'session-full-id' } },
  ]);
});

test('cursor_close_session is idempotent after a delegated turn', async (t) => {
  const previous = {
    command: process.env.CURSOR_AGENT_COMMAND,
    adapterArgs: process.env.CURSOR_SUBAGENT_ADAPTER_ARGS,
  };
  process.env.CURSOR_AGENT_COMMAND = process.execPath;
  process.env.CURSOR_SUBAGENT_ADAPTER_ARGS = JSON.stringify([fakeAcp]);
  t.after(() => {
    process.env.CURSOR_AGENT_COMMAND = previous.command;
    process.env.CURSOR_SUBAGENT_ADAPTER_ARGS = previous.adapterArgs;
  });

  const runtime = new Runtime({ roots: [cwd] });
  const delegated = await runtime.call('cursor_delegate', { cwd, mode: 'ask', prompt: 'Inspect' });
  const first = await runtime.call('cursor_close_session', { session_id: delegated.session_id });
  const second = await runtime.call('cursor_close_session', { session_id: delegated.session_id });

  assert.equal(first.session_state, 'tombstone');
  assert.deepEqual(second, first);
});

async function runSkillWorkflow(call) {
  let turn;
  try {
    turn = await call('cursor_delegate', { cwd: '/isolated/worktree', mode: 'agent', prompt: 'Implement' });
    while (!['completed', 'failed', 'cancelled', 'timed_out'].includes(turn.turn_status)) {
      turn = await call('cursor_wait', {
        session_id: turn.session_id,
        turn_id: turn.turn_id,
        after_event_id: turn.last_event_id,
        timeout_ms: 1_000,
      });
      const pending = turn.active_turn?.pending?.[0];
      if (pending?.kind === 'question') {
        turn = await call('cursor_answer_question', {
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          request_id: pending.request_id,
          outcome: 'answered',
          answers: [{ question_id: 'question-full-id', selected_option_ids: ['option-full-id'] }],
        });
      }
    }
    return turn;
  } finally {
    if (turn?.session_id) {
      await call('cursor_close_session', { session_id: turn.session_id });
      await call('cursor_close_session', { session_id: turn.session_id });
    }
  }
}

test('skill workflow transcript is delegate, wait, full-ID answer, terminal wait, and idempotent finally close', async () => {
  const skill = await readFile(skillPath, 'utf8');
  assert.match(skill, /Начни с `cursor_delegate/);
  assert.match(skill, /наблюдай ход только через `cursor_wait/);
  assert.match(skill, /Не опрашивай `cursor_session_status`/);
  assert.match(skill, /полными `session_id`, `turn_id`, `request_id`/);
  assert.match(skill, /В `finally` всегда вызови `cursor_close_session/);
  assert.match(skill, /повторный close безопасен/);
  assert.match(skill, /Answer-tools — часть основного interactive workflow/);
  assert.doesNotMatch(skill, /answer-tools и `cursor_cancel` предназначены только/);

  const transcript = [];
  const responses = [
    { session_id: 'session-full-id', turn_id: 'turn-full-id', turn_status: 'running', last_event_id: 3 },
    {
      session_id: 'session-full-id', turn_id: 'turn-full-id', turn_status: 'waiting_for_input', last_event_id: 5,
      active_turn: { pending: [{ kind: 'question', request_id: 'request-full-id' }] },
    },
    { session_id: 'session-full-id', turn_id: 'turn-full-id', turn_status: 'running', last_event_id: 6 },
    { session_id: 'session-full-id', turn_id: 'turn-full-id', turn_status: 'completed', last_event_id: 8 },
    { session_id: 'session-full-id', session_state: 'tombstone' },
    { session_id: 'session-full-id', session_state: 'tombstone' },
  ];
  const call = async (tool, args) => {
    transcript.push({ tool, args });
    return responses.shift();
  };

  const result = await runSkillWorkflow(call);

  assert.equal(result.turn_status, 'completed');
  assert.equal(responses.length, 0);
  assert.deepEqual(transcript, [
    { tool: 'cursor_delegate', args: { cwd: '/isolated/worktree', mode: 'agent', prompt: 'Implement' } },
    { tool: 'cursor_wait', args: { session_id: 'session-full-id', turn_id: 'turn-full-id', after_event_id: 3, timeout_ms: 1_000 } },
    {
      tool: 'cursor_answer_question',
      args: {
        session_id: 'session-full-id', turn_id: 'turn-full-id', request_id: 'request-full-id', outcome: 'answered',
        answers: [{ question_id: 'question-full-id', selected_option_ids: ['option-full-id'] }],
      },
    },
    { tool: 'cursor_wait', args: { session_id: 'session-full-id', turn_id: 'turn-full-id', after_event_id: 6, timeout_ms: 1_000 } },
    { tool: 'cursor_close_session', args: { session_id: 'session-full-id' } },
    { tool: 'cursor_close_session', args: { session_id: 'session-full-id' } },
  ]);
  assert.equal(transcript.some(({ tool }) => tool === 'cursor_session_status'), false);
});
