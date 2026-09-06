import assert from 'node:assert/strict';
import test from 'node:test';
import { Runtime } from '../scripts/cursor-subagent-mcp.mjs';

const cwd = process.cwd();

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

test('cursor_delegate forwards optional launch parameters exactly once', async () => {
  const startResult = { session_id: 'session-full-id', session_state: 'live', cursor_session_id: 'cursor-full-id', model: 'grok-4.6', effort: 'high', fast: true };
  const promptResult = { ...startResult, turn_id: 'turn-full-id', turn_status: 'running' };
  const { runtime, transcript } = facadeHarness({ startResult, promptResult });

  const result = await runtime.call('cursor_delegate', {
    cwd, mode: 'agent', prompt: 'Implement the task', model: 'grok-4.6', effort: 'high', fast: true,
    plugin_dirs: [cwd],
  });

  assert.deepEqual(result, {
    ...promptResult,
    cursor_session_id: 'cursor-full-id',
    model: 'grok-4.6',
    effort: 'high',
    fast: true,
  });
  assert.deepEqual(transcript, [
    { tool: 'cursor_start_session', args: { cwd, mode: 'agent', model: 'grok-4.6', effort: 'high', fast: true, plugin_dirs: [cwd] } },
    { tool: 'cursor_send_prompt', args: { session_id: 'session-full-id', prompt: 'Implement the task' } },
  ]);
});

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
