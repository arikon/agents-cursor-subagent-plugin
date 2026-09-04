import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { RecordingMcpProxy, assertEvalResultV1, classifyEval, classifyScenario, evalResult, liveMarkerResult, publishEvidence, writeEvalResult } from '../scripts/cursor-skill-eval.mjs';

const recorder = fileURLToPath(new URL('../scripts/recording-mcp-proxy.mjs', import.meta.url));

test('EvalResultV1 enforces its exact bounded public contract', () => {
  const result = evalResult({ scenario_id: 'client-happy', lane: 'client-integration', eval_status: 'pass', actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded', fixture_assertion_outcome: 'pass', evidence_publication_status: 'published', evidence_ref: '/evidence/run.json', cleanup_status: 'succeeded', failure_stage: null });
  assert.equal(result.schema_version, 1);
  assert.throws(() => assertEvalResultV1({ ...result, extra: true }), /unexpected properties/);
  assert.throws(() => evalResult({ ...result, evidence_publication_status: 'failed' }), /evidence_ref/);
  assert.throws(() => evalResult({ ...result, lane: 'unknown' }), /invalid enum/);
  assert.throws(() => evalResult({ ...result, cleanup_status: 'failed' }), /passing EvalResultV1/);
  assert.throws(() => evalResult({ ...result, eval_status: 'integration_failure' }), /failure_stage/);
});

test('eval classifier preserves skipped, integration, mismatch, pass precedence', () => {
  assert.equal(classifyEval({ enabled: false, integrationFailure: 'cleanup', behaviorMatches: true }), 'skipped');
  assert.equal(classifyEval({ enabled: true, integrationFailure: 'cleanup', behaviorMatches: true }), 'integration_failure');
  assert.equal(classifyEval({ enabled: true, behaviorMatches: false }), 'agent_behavior_mismatch');
  assert.equal(classifyEval({ enabled: true, behaviorMatches: true }), 'pass');
  assert.equal(classifyEval({ enabled: true, integrationFailure: 'publication', behaviorMatches: false }), 'integration_failure');
});

test('cleanup, evidence publication, and runner collisions dominate behavior verdicts', () => {
  for (const failure of ['cleanup', 'publication', 'runner_spawn', 'runner_timeout', 'runner_output_limit', 'runner_hung_close']) {
    assert.equal(classifyEval({ enabled: true, integrationFailure: failure, behaviorMatches: true }), 'integration_failure', failure);
  }
  assert.equal(classifyScenario({ enabled: true, expectedActual: 'failed', actual: 'failed', expectedReported: 'failed', reported: 'succeeded' }), 'agent_behavior_mismatch');
});

test('EvalResultV1 is the sole bounded stdout artifact', () => {
  const output = { value: '', write(chunk) { this.value += chunk; } };
  const result = evalResult({ scenario_id: 'client-happy', lane: 'client-integration', eval_status: 'integration_failure', actual_task_outcome: 'not_observed', reported_task_outcome: 'not_reported', fixture_assertion_outcome: 'not_observed', evidence_publication_status: 'not_attempted', cleanup_status: 'succeeded', failure_stage: 'transport', error_code: 'unsupported_mcp_tool' });
  writeEvalResult(result, output);
  assert.equal(output.value.split('\n').filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(output.value), result);
});

test('expected semantic failure passes only when Codex reports that failure honestly', () => {
  const expected = { enabled: true, expectedActual: 'failed', actual: 'failed', expectedReported: 'failed', reported: 'failed' };
  assert.equal(classifyScenario(expected), 'pass');
  assert.equal(classifyScenario({ ...expected, reported: 'succeeded' }), 'agent_behavior_mismatch');
  assert.equal(classifyScenario({ ...expected, integrationFailure: 'cleanup' }), 'integration_failure');
});

test('live-marker is opt-in and never conceals cleanup failure', () => {
  assert.equal(liveMarkerResult({ enabled: false }).eval_status, 'skipped');
  const failed = liveMarkerResult({ enabled: true, cleanupFailure: true });
  assert.deepEqual({ status: failed.eval_status, stage: failed.failure_stage, cleanup: failed.cleanup_status }, { status: 'integration_failure', stage: 'cleanup', cleanup: 'failed' });
});

test('recording proxy preserves only public MCP observations', async () => {
  const proxy = new RecordingMcpProxy({ request: async () => ({ result: {} }), tool: async (_name, args) => ({ session_id: args.session_id }) });
  assert.deepEqual(await proxy.tool('cursor_close_session', { session_id: 'S' }), { session_id: 'S' });
  assert.deepEqual(proxy.snapshot(), [
    { direction: 'tool_request', name: 'cursor_close_session', args: { session_id: 'S' } },
    { direction: 'tool_response', name: 'cursor_close_session', response: { session_id: 'S' } },
  ]);
});

test('stdio recording proxy atomically publishes bounded lifecycle evidence with exact opaque IDs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    const terminal = { turn_id: 'T', turn_status: 'completed', pending: [], result: { text: 'CURSOR_EVAL_OK', truncated: false } };
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line); const tool = call.params.name;
      const payload = tool === 'cursor_delegate'
        ? { session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 3 }
        : tool === 'cursor_answer_permission'
          ? { session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 7, active_turn: { turn_id: 'T', turn_status: 'running', pending: [] } }
          : tool === 'cursor_close_session'
            ? { session_id: 'S', session_state: 'tombstone', last_event_id: 11, last_terminal_turn: terminal }
            : call.params.arguments.after_event_id === 3
              ? { session_id: 'S', turn_id: 'T', turn_status: 'waiting_for_input', last_event_id: 6, active_turn: { turn_id: 'T', turn_status: 'waiting_for_input', pending: [{ request_id: 'R', kind: 'permission', context: { secret: 'not-recorded' } }] } }
              : { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, timed_out: false, last_terminal_turn: terminal };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const calls = [
    { id: 1, name: 'cursor_delegate', arguments: { cwd: '/secret/workspace', mode: 'agent', prompt: 'secret prompt' } },
    { id: 2, name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T', after_event_id: 3, timeout_ms: 1_000 } },
    { id: 3, name: 'cursor_answer_permission', arguments: { session_id: 'S', turn_id: 'T', request_id: 'R', decision: 'allow-once', secret: 'not-recorded' } },
    { id: 4, name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T', after_event_id: 7, timeout_ms: 1_000 } },
    { id: 5, name: 'cursor_close_session', arguments: { session_id: 'S' } },
  ];
  child.stdin.end(calls.map(({ id, name, arguments: args }) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).join('\n') + '\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8'); const published = JSON.parse(raw);
  assert.equal(Buffer.byteLength(raw), raw.length);
  assert.deepEqual(published, { schema_version: 1, dropped_calls: 0, transcript: [
    { direction: 'request', tool: 'cursor_delegate', call_id: 1, request: { mode: 'agent' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 3 } },
    { direction: 'request', tool: 'cursor_wait', call_id: 2, request: { session_id: 'S', turn_id: 'T', after_event_id: 3, timeout_ms: 1_000 }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'waiting_for_input', last_event_id: 6, active_turn: { turn_id: 'T', turn_status: 'waiting_for_input', pending: [{ request_id: 'R', kind: 'permission' }] } } },
    { direction: 'request', tool: 'cursor_answer_permission', call_id: 3, request: { session_id: 'S', turn_id: 'T', request_id: 'R', decision: 'allow-once' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 7, active_turn: { turn_id: 'T', turn_status: 'running', pending: [] } } },
    { direction: 'request', tool: 'cursor_wait', call_id: 4, request: { session_id: 'S', turn_id: 'T', after_event_id: 7, timeout_ms: 1_000 }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, timed_out: false, last_terminal_turn: { turn_id: 'T', turn_status: 'completed', pending: [], result: { text_bytes: 14, text_sha256: '65eb05dc0fa59c8ac6150c3fe6d3d7634471290d68fa38ae770b18c2ec2cc4cf', truncated: false } } } },
    { direction: 'request', tool: 'cursor_close_session', call_id: 5, request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone', last_event_id: 11, last_terminal_turn: { turn_id: 'T', turn_status: 'completed', pending: [], result: { text_bytes: 14, text_sha256: '65eb05dc0fa59c8ac6150c3fe6d3d7634471290d68fa38ae770b18c2ec2cc4cf', truncated: false } } } },
  ] });
  assert.doesNotMatch(raw, /secret|workspace|prompt|context/);
  assert.deepEqual((await readdir(root)).sort(), ['mcp.json']);
});

test('stdio recording proxy caps call count and evidence bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-bounds-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const calls = Array.from({ length: 140 }, (_, index) => JSON.stringify({ jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: 'cursor_delegate', arguments: { mode: 'ask', prompt: 'x'.repeat(100_000) } } }));
  child.stdin.end(calls.join('\n') + '\n');
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8'); const published = JSON.parse(raw);
  assert.equal(published.transcript.length, 128);
  assert.equal(published.dropped_calls, 12);
  assert.ok(Buffer.byteLength(raw, 'utf8') < 1_048_576);
  assert.doesNotMatch(raw, /x{100}/);
  assert.deepEqual((await readdir(root)).sort(), ['mcp.json']);
});

test('evidence is atomically published outside and survives fixture cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-evidence-')); const fixture = join(root, 'fixture'); const evidence = join(root, 'evidence');
  t.after(() => rm(root, { recursive: true, force: true }));
  const reference = await publishEvidence({ evidenceRoot: evidence, fixtureRoot: fixture, evidence: { transcript: [{ name: 'cursor_delegate' }], skill_load: { enabled: true } } });
  assert.deepEqual(await readdir(evidence), [reference.split('/').at(-1)]);
  assert.deepEqual(JSON.parse(await readFile(reference, 'utf8')), { transcript: [{ name: 'cursor_delegate' }], skill_load: { enabled: true } });
  await assert.rejects(publishEvidence({ evidenceRoot: join(fixture, 'evidence'), fixtureRoot: fixture, evidence: {} }), /outside fixture root/);
});
