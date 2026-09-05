import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertEvalResultV1, classifyEval, classifyScenario, evalResult, publishEvidence, writeEvalResult } from '../scripts/cursor-skill-eval.mjs';

const recorder = fileURLToPath(new URL('../scripts/recording-mcp-proxy.mjs', import.meta.url));

test('recording MCP proxy rejects an omitted target before opening a child transport', async () => {
  const child = spawn(process.execPath, [recorder], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(stderr).toString('utf8'), /MCP proxy target is required/);
});

test('EvalResultV1 enforces its exact bounded public contract', () => {
  const result = evalResult({ scenario_id: 'client-happy', lane: 'client-integration', eval_status: 'pass', actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded', fixture_assertion_outcome: 'pass', evidence_publication_status: 'published', evidence_ref: '/evidence/run.json', cleanup_status: 'succeeded', failure_stage: null });
  assert.equal(result.schema_version, 1);
  assert.throws(() => assertEvalResultV1({ ...result, extra: true }), /unexpected properties/);
  assert.throws(() => evalResult({ ...result, evidence_publication_status: 'failed' }), /evidence_ref/);
  assert.throws(() => evalResult({ ...result, lane: 'unknown' }), /invalid enum/);
  assert.throws(() => evalResult({ ...result, cleanup_status: 'failed' }), /passing EvalResultV1/);
  assert.throws(() => evalResult({ ...result, eval_status: 'integration_failure' }), /failure_stage/);
  assert.throws(() => evalResult({ ...result, eval_status: 'skipped' }), /skipped EvalResultV1 must be pre-run/);
  assert.throws(() => evalResult({ ...result, scenario_id: 'x'.repeat(129) }), /scenario_id/);
  assert.throws(() => assertEvalResultV1(null), /unexpected properties/);
  assert.throws(() => assertEvalResultV1([]), /unexpected properties/);
});

test('eval classifier preserves skipped, mismatch, and pass outcomes', () => {
  assert.equal(classifyEval({ enabled: false, integrationFailure: 'cleanup', behaviorMatches: true }), 'skipped');
  assert.equal(classifyEval({ enabled: true, behaviorMatches: false }), 'agent_behavior_mismatch');
  assert.equal(classifyEval({ enabled: true, behaviorMatches: true }), 'pass');
});

test('cleanup, evidence publication, and runner collisions dominate behavior verdicts', () => {
  for (const failure of ['cleanup', 'publication', 'runner_spawn', 'runner_timeout', 'runner_output_limit', 'runner_hung_close']) {
    assert.equal(classifyEval({ enabled: true, integrationFailure: failure, behaviorMatches: false }), 'integration_failure', failure);
  }
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
  const child = spawn(process.execPath, [recorder, '-e', `process.stderr.write('adapter diagnostic');${fake}`], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = [];
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
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
  assert.equal(Buffer.concat(diagnostics).toString('utf8'), 'adapter diagnostic');
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

test('stdio recording proxy rejects oversized bounded-field evidence without a partial artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-evidence-limit-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const id = 'x'.repeat(256);
  const answers = Array.from({ length: 16 }, () => ({ question_id: id, selected_option_ids: Array(16).fill(id) }));
  const calls = Array.from({ length: 16 }, (_, index) => JSON.stringify({
    jsonrpc: '2.0', id: index, method: 'tools/call',
    params: { name: 'cursor_answer_question', arguments: { session_id: id, turn_id: id, request_id: id, outcome: id, answers } },
  }));
  child.stdin.end(`${calls.join('\n')}\n`);
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /evidence exceeded its publication limit/);
  assert.deepEqual(await readdir(root), []);
});

test('stdio recording proxy bounds public question answers and option IDs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-question-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '{}' }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const answers = Array.from({ length: 18 }, (_, index) => ({
    question_id: index === 1 ? { private: true } : `Q${index}`,
    selected_option_ids: index === 0 ? ['A', { private: true }, 2] : [`A${index}`],
  }));
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'cursor_answer_question', arguments: { session_id: 'S', turn_id: 'T', request_id: 'R', outcome: 'answered', answers } } })}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const published = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(published.transcript[0].request, {
    session_id: 'S', turn_id: 'T', request_id: 'R', outcome: 'answered',
    answers: [
      { question_id: 'Q0', selected_option_ids: ['A', 2] },
      { selected_option_ids: ['A1'] },
      ...Array.from({ length: 14 }, (_, index) => ({ question_id: `Q${index + 2}`, selected_option_ids: [`A${index + 2}`] })),
    ],
  });
  assert.equal(published.transcript[0].response.ok, true);
});

test('stdio recording proxy ignores malformed and unrelated frames', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-malformed-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      if (line === 'not-json') return process.stdout.write('also-not-json\\n');
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'unmatched', result: { isError: false, content: [] } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '{}' }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(`not-json\n${JSON.stringify({ jsonrpc: '2.0', id: 'notification', method: 'notifications/initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cursor_close_session', arguments: { session_id: 'S' } } })}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const published = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(published.transcript, [
    { direction: 'request', tool: 'cursor_close_session', call_id: 1, request: { session_id: 'S' }, response: { ok: true } },
  ]);
});

test('stdio recording proxy publishes only bounded public fields from malformed lifecycle values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-untrusted-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      const result = call.id === 'rpc'
        ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'private detail' } }
        : call.id === 'bad-json'
          ? { jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '[' }] } }
          : ['null', 'array', 'scalar'].includes(call.id)
            ? { jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: call.id === 'null' ? 'null' : call.id === 'array' ? '[]' : '1' }] } }
          : { jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({
              session_id: { private: true }, turn_id: 'x'.repeat(300), request_id: 9,
              session_state: ['private'], turn_status: 'waiting_for_input', error_code: null,
              last_event_id: 4.5, timed_out: 'no',
              active_turn: { turn_id: 'T', pending: 'private' },
              last_terminal_turn: { turn_id: 'T', pending: [null, { request_id: 'R', kind: 'k'.repeat(300) }], result: { text: 7 } },
            }) }] } };
      process.stdout.write(JSON.stringify(result) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const calls = [
    { id: 'rpc', method: 'tools/call', params: { name: 'cursor_answer_plan', arguments: { session_id: {}, decision: 'approve' } } },
    { id: 'bad-json', method: 'tools/call', params: { name: 'cursor_answer_question', arguments: { answers: [{ question_id: 'Q', selected_option_ids: 'private' }] } } },
    { id: 'null', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
    { id: 'array', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
    { id: 'scalar', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
    { id: 'payload', method: 'tools/call', params: { name: 'cursor_wait', arguments: null } },
  ];
  child.stdin.end(calls.map((call) => JSON.stringify({ jsonrpc: '2.0', ...call })).join('\n') + '\n');
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const published = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(published.transcript, [
    { direction: 'request', tool: 'cursor_answer_plan', call_id: 'rpc', request: { decision: 'approve' }, response: { ok: false, rpc_error_code: -32601 } },
    { direction: 'request', tool: 'cursor_answer_question', call_id: 'bad-json', request: { answers: [{ question_id: 'Q', selected_option_ids: [] }] }, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'null', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'array', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'scalar', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'payload', request: {}, response: { ok: true, request_id: 9, turn_status: 'waiting_for_input', active_turn: { turn_id: 'T', pending: [] }, last_terminal_turn: { turn_id: 'T', pending: [{}, { request_id: 'R' }] } } },
  ]);
  assert.doesNotMatch(JSON.stringify(published), /private|x{100}|k{100}/);
});

test('stdio recording proxy does not publish evidence when no tool call was observed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-empty-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const child = spawn(process.execPath, [recorder, '-e', 'process.exit(0)'], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end();
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  assert.deepEqual(await readdir(root), []);
});

for (const [name, target, expectedCode] of [
  ['SIGTERM', `process.stdout.write(String(process.pid) + '\\n'); process.stdin.resume(); process.once('SIGTERM', () => process.exit(0));`, 0],
  ['SIGKILL fallback', `process.stdout.write(String(process.pid) + '\\n'); process.stdin.resume(); process.on('SIGTERM', () => {});`, 1],
]) {
  test(`stdio recording proxy stops its child with ${name}`, async (t) => {
    const proxy = spawn(process.execPath, [recorder, '-e', target], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill('SIGKILL'); });
    const lines = createInterface({ input: proxy.stdout });
    const [pidLine] = await once(lines, 'line'); const targetPid = Number(pidLine);
    assert.ok(Number.isSafeInteger(targetPid));
    proxy.kill('SIGTERM');
    // Repeated ownership-loss signals are a real parent/terminal race.
    proxy.kill('SIGTERM');
    const [code, signal] = await once(proxy, 'close');
    assert.equal(signal, null);
    assert.equal(code, expectedCode);
    assert.throws(() => process.kill(targetPid, 0), { code: 'ESRCH' });
  });
}

test('stdio recording proxy terminates its target when its owning process disappears', { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, 'target.pid');
  const target = `require('node:fs').writeFileSync(process.env.TARGET_PID_FILE, String(process.pid)); setInterval(() => {}, 1_000); process.once('SIGTERM', () => process.exit(0));`;
  const launcher = `const { spawn } = require('node:child_process'); const { existsSync } = require('node:fs'); spawn(process.execPath, [process.env.RECORDER, '-e', process.env.TARGET], { detached: true, stdio: 'ignore', env: process.env }).unref(); const ready = setInterval(() => { if (existsSync(process.env.TARGET_PID_FILE)) { clearInterval(ready); process.exit(0); } }, 10);`;
  const owner = spawn(process.execPath, ['-e', launcher], {
    env: { ...process.env, RECORDER: recorder, TARGET: target, TARGET_PID_FILE: pidFile },
    stdio: 'ignore',
  });
  assert.equal((await once(owner, 'close'))[0], 0);

  let targetPid;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { targetPid = Number(await readFile(pidFile, 'utf8')); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.ok(Number.isSafeInteger(targetPid));
  t.after(() => { try { process.kill(targetPid, 'SIGKILL'); } catch {} });

  let terminated = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { process.kill(targetPid, 0); }
    catch (error) { if (error.code === 'ESRCH') { terminated = true; break; } throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(terminated, true);
});

test('evidence is atomically published outside and survives fixture cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-evidence-')); const fixture = join(root, 'fixture'); const evidence = join(root, 'evidence');
  t.after(() => rm(root, { recursive: true, force: true }));
  const reference = await publishEvidence({ evidenceRoot: evidence, fixtureRoot: fixture, evidence: { transcript: [{ name: 'cursor_delegate' }], skill_load: { enabled: true } } });
  assert.deepEqual(await readdir(evidence), [reference.split('/').at(-1)]);
  assert.deepEqual(JSON.parse(await readFile(reference, 'utf8')), { transcript: [{ name: 'cursor_delegate' }], skill_load: { enabled: true } });
  await assert.rejects(publishEvidence({ evidenceRoot: join(fixture, 'evidence'), fixtureRoot: fixture, evidence: {} }), /outside fixture root/);
  await assert.rejects(
    publishEvidence({ evidenceRoot: evidence, fixtureRoot: fixture, evidence: { payload: 'x'.repeat(1_048_576) } }),
    /evidence exceeds output limit/,
  );
});
