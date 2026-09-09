// Historical diagnostic only; not a deterministic-suite dependency or benchmark.
// Usage: node <this-file> <materialized-b8a1e5c-root> <current-root>
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const [baselineRoot, candidateRoot] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(baselineRoot && candidateRoot);
const { isolatedFakeEnvironment, offlineModelDependencies } = await import(pathToFileURL(join(candidateRoot, 'tests/runtime-test-support.mjs')));
const results = [];
for (const [variant, root] of [['baseline', baselineRoot], ['candidate', candidateRoot]]) {
  const { Runtime } = await import(pathToFileURL(join(root, 'scripts/cursor-subagent-mcp.mjs')));
  const runtime = new Runtime({ ...offlineModelDependencies, roots: [candidateRoot], env: isolatedFakeEnvironment({ FAKE_ACP_HOLD_PROMPT: '1' }) });
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let record;
  let sendConfirmed;
  try {
    const session = await runtime.call('cursor_start_session', { cwd: candidateRoot, mode: 'agent' });
    assert.equal(session.session_state, 'live');
    const turn = await runtime.call('cursor_send_prompt', { session_id: session.session_id, prompt: 'two permissions' });
    record = runtime.sessions.get(session.session_id);
    for (const id of ['first', 'second']) record.callback({
      id, method: 'session/request_permission', params: {
        sessionId: record.cursorSessionId,
        toolCall: { toolCallId: id, title: `Execute ${id}?`, kind: 'execute', locations: [{ path: candidateRoot, line: 1 }] },
        options: [{ optionId: `${id}-allow`, kind: 'allow_once', name: 'Yes' }, { optionId: `${id}-reject`, kind: 'reject_once', name: 'No' }],
      },
    });
    assert.equal(record.active.pending.size, 2);
    const expected = record.snapshot(record.active).pending[1];
    sendConfirmed = record.sendConfirmed;
    const responses = [];
    record.sendConfirmed = async (frame) => { responses.push(frame); };
    let now = 10_000;
    Date.now = () => now;
    await runtime.call('cursor_answer_permission', { session_id: session.session_id, turn_id: turn.turn_id, request_id: 'first', decision: 'allow-once' });
    const eventId = record.nextEvent;
    let expire;
    globalThis.setTimeout = (callback, delay) => {
      assert.equal(delay, 1_000);
      expire = callback;
      return { controlledWait: true };
    };
    const args = { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000,
      ...(variant === 'baseline' ? { after_event_id: record.nextEvent - 1 } : {}) };
    let settled = false;
    const waiting = runtime.call('cursor_wait', args).then((value) => { settled = true; return value; });
    // Drain only microtasks; no real clock or provider event is needed.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const settledBeforeDeadline = settled;
    if (variant === 'baseline') {
      assert.equal(settled, false);
      assert.equal(typeof expire, 'function');
      now += 1_000;
      expire();
    } else {
      assert.equal(settled, true);
      assert.equal(expire, undefined);
    }
    const response = await waiting;
    assert.equal(response.wait_timeout, variant === 'baseline');
    assert.deepEqual(response.pending.map(({ request_id }) => request_id), ['second']);
    if (variant === 'candidate') assert.deepEqual(response.pending, [expected]);
    assert.equal(record.nextEvent, eventId);
    assert.equal(responses.length, 1);
    results.push({ variant, settled_before_deadline: settledBeforeDeadline, controlled_elapsed_ms: now - 10_000,
      timeout_registered: Boolean(expire), cursor_supplied: Object.hasOwn(args, 'after_event_id'),
      new_events_after_answer: record.nextEvent - eventId, wait_timeout: response.wait_timeout,
      pending: response.pending, provider_answers: responses.length });
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    if (record && sendConfirmed) record.sendConfirmed = sendConfirmed;
    await runtime.shutdown();
  }
}
console.log(JSON.stringify({ baseline_revision: 'b8a1e5c90cc6bc82362a7c174e42ff49e649e40d', results }, null, 2));
