import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertEvalResultV1, assertEvidenceManifestV1, classifyEval, classifyScenario, evalResult, publishEvidence, readEvaluatorInventory, writeEvalResult } from '../scripts/cursor-skill-eval.mjs';
import { evaluateScenario, findRecoveredCalls, parseScenarioCorpus, validRecoveryContext } from '../scripts/cursor-eval-scenario.mjs';
import { canonicalJson } from '../scripts/cursor-subagent-bootstrap.mjs';

const recorder = fileURLToPath(new URL('../scripts/recording-mcp-proxy.mjs', import.meta.url));

function recordedRequest(args, projection = {}) {
  if (!args || Array.isArray(args) || typeof args !== 'object') return projection;
  const withoutSessionTurn = Object.fromEntries(Object.entries(args)
    .filter(([key]) => key !== 'session_id' && key !== 'turn_id'));
  return { ...projection,
    arguments_without_session_turn_sha256: createHash('sha256').update(canonicalJson(withoutSessionTurn)).digest('hex') };
}

test('stdio recording proxy atomically publishes bounded lifecycle evidence with exact opaque IDs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line); const tool = call.params.name;
      const payload = tool === 'cursor_delegate'
        ? { session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 3,
            cursor_session_id: 'C', model: 'auto', effort: 'high', fast: false }
        : tool === 'cursor_answer_permission'
          ? { session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 7 }
          : tool === 'cursor_close_session'
            ? { session_id: 'S', session_state: 'tombstone', last_event_id: 11 }
            : call.id === 2
              ? { session_id: 'S', turn_id: 'T', turn_status: 'waiting_for_input', last_event_id: 6, resume_after_event_id: 6, wait_timeout: false,
                  pending: [{ request_id: 'R', kind: 'permission', context: { secret: 'not-recorded' } },
                    { request_id: 'R2' }, { request_id: 'R3', kind: { secret: true } }] }
              : { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, resume_after_event_id: 10, wait_timeout: false,
                  events_lost: true, earliest_event_id: 8, progress_revision: 2,
                  events: [{ kind: 'task', payload: { secret: true } }, { kind: { private: true } }],
                  terminal_reason: { text: 'provider stopped', truncated: false },
                  terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, result_sha256: 'a'.repeat(64), result_truncated: false, secret: true },
                  result: { text: 'CURSOR_EVAL_OK', truncated: false } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', `process.stderr.write('adapter diagnostic');${fake}`], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = [];
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const calls = [
    { id: 1, name: 'cursor_delegate', arguments: { cwd: '/secret/workspace', mode: 'agent', prompt: 'secret prompt' } },
    { id: 2, name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T', timeout_ms: 1_000 } },
    { id: 3, name: 'cursor_answer_permission', arguments: { session_id: 'S', turn_id: 'T', request_id: 'R', decision: 'allow-once', secret: 'not-recorded' } },
    { id: 4, name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T', timeout_ms: 1_000 } },
    { id: 5, name: 'cursor_close_session', arguments: { session_id: 'S' } },
  ];
  child.stdin.end(calls.map(({ id, name, arguments: args }) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).join('\n') + '\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8'); const published = JSON.parse(raw);
  assert.equal(Buffer.byteLength(raw), raw.length);
  assert.deepEqual(published, { schema_version: 1, dropped_calls: 0, transcript: [
    { direction: 'request', tool: 'cursor_delegate', call_id: 1, request: recordedRequest(calls[0].arguments, { mode: 'agent' }), response: { ok: true, session_id: 'S', turn_id: 'T', cursor_session_id: 'C', model: 'auto', effort: 'high', fast: false, turn_status: 'running', last_event_id: 3 } },
    { direction: 'request', tool: 'cursor_wait', call_id: 2, request: recordedRequest(calls[1].arguments, { session_id: 'S', turn_id: 'T', timeout_ms: 1_000 }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'waiting_for_input', last_event_id: 6, wait_timeout: false, pending: [{ request_id: 'R', kind: 'permission' }, { request_id: 'R2' }, { request_id: 'R3' }] } },
    { direction: 'request', tool: 'cursor_answer_permission', call_id: 3, request: recordedRequest(calls[2].arguments, { session_id: 'S', turn_id: 'T', request_id: 'R', decision: 'allow-once' }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'running', last_event_id: 7 } },
    { direction: 'request', tool: 'cursor_wait', call_id: 4, request: recordedRequest(calls[3].arguments, { session_id: 'S', turn_id: 'T', timeout_ms: 1_000 }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, wait_timeout: false, terminal_reason: { text: 'provider stopped', truncated: false }, terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 10, result_sha256: 'a'.repeat(64), result_truncated: false }, result: { text_bytes: 14, text_sha256: '65eb05dc0fa59c8ac6150c3fe6d3d7634471290d68fa38ae770b18c2ec2cc4cf', truncated: false } } },
    { direction: 'request', tool: 'cursor_close_session', call_id: 5, request: recordedRequest(calls[4].arguments, { session_id: 'S' }), response: { ok: true, session_id: 'S', session_state: 'tombstone', last_event_id: 11 } },
  ] });
  assert.doesNotMatch(raw, /secret|workspace|prompt|context/);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /adapter diagnostic/);
  assert.deepEqual((await readdir(root)).sort(), ['mcp.json']);
});

test('recording proxy hashes complete non-ID arguments before bounded projection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-arguments-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
        isError: false, content: [{ type: 'text', text: '{}' }],
      } }) + '\\n');
    });`;
  const answers = Array.from({ length: 17 }, (_, index) => ({
    question_id: `Q${index}`, selected_option_ids: [`A${index}`],
  }));
  answers[16].selected_option_ids = ['PRIVATE_TAIL_ALPHA'];
  const base = {
    session_id: 'S1', turn_id: 'T1', request_id: 'R1', prompt: 'PRIVATE_PROMPT_ALPHA',
    unknown_key: 'PRIVATE_UNKNOWN_ALPHA', answers,
  };
  const reordered = {
    answers: structuredClone(answers), unknown_key: 'PRIVATE_UNKNOWN_ALPHA',
    prompt: 'PRIVATE_PROMPT_ALPHA', request_id: 'R1', turn_id: 'T2', session_id: 'S2',
  };
  const changed = [
    { ...base, request_id: 'R2' },
    { ...base, prompt: 'PRIVATE_PROMPT_BETA' },
    { ...base, unknown_key: 'PRIVATE_UNKNOWN_BETA' },
    { ...base, answers: [...answers.slice(0, 16), { question_id: 'Q16', selected_option_ids: ['PRIVATE_TAIL_BETA'] }] },
  ];
  const requestArguments = [base, reordered, ...changed, ['non-plain']];
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(`${requestArguments.map((arguments_, id) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cursor_answer_question', arguments: arguments_ },
  })).join('\n')}\n`);
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8');
  const requests = JSON.parse(raw).transcript.map(({ request }) => request);
  const digests = requests.map(({ arguments_without_session_turn_sha256: digest }) => digest);
  assert.equal(digests[0], digests[1]);
  for (const digest of digests.slice(2, 6)) assert.notEqual(digest, digests[0]);
  assert.equal(Object.hasOwn(requests[6], 'arguments_without_session_turn_sha256'), false);
  assert.doesNotMatch(raw, /PRIVATE_(?:PROMPT|UNKNOWN|TAIL)/);
});

test('recording proxy proves only an exact sequential full-result read through EOF', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-result-read-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  const payloads = [
    { text: 'alpha', offset: 0, next_offset: 5, eof: false, total_bytes: 9, sha256: digest('alphabeta') },
    { text: 'beta', offset: 5, next_offset: null, eof: true, total_bytes: 9, sha256: digest('alphabeta') },
    { error_code: 'invalid_args' },
    { text: 'tail', offset: 4, next_offset: null, eof: true, total_bytes: 8, sha256: digest('headtail') },
    { text: 'old', offset: 0, next_offset: 3, eof: false, total_bytes: 6, sha256: digest('oldend') },
    { text: 'new', offset: 0, next_offset: 3, eof: false, total_bytes: 6, sha256: digest('newend') },
    { text: 'end', offset: 3, next_offset: null, eof: true, total_bytes: 6, sha256: digest('newend') },
    { text: 'same', offset: 0, next_offset: null, eof: true, total_bytes: 4, sha256: digest('else') },
    { text: 'x', offset: 1, next_offset: null, eof: true, total_bytes: 1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: -1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: 1.5, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: 1, sha256: 'not-a-digest' },
    { text: 'x', offset: 0, next_offset: null, eof: true, total_bytes: 1, sha256: null },
    { text: 'x', offset: 0, next_offset: null, eof: 'yes', total_bytes: 1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: 1, eof: true, total_bytes: 1, sha256: digest('x') },
    { text: 'x', offset: 0, next_offset: 2, eof: false, total_bytes: 1, sha256: digest('x') },
    { text: 'short', offset: 0, next_offset: null, eof: true, total_bytes: 6, sha256: digest('short') },
  ];
  const fake = `
    const readline = require('node:readline');
    const payloads = JSON.parse(process.env.RESULT_READ_PAYLOADS);
    let index = 0;
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line); const payload = payloads[index++];
      const isError = payload.error_code !== undefined;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
        isError, content: [{ type: 'text', text: JSON.stringify(payload) }],
      } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, RESULT_READ_PAYLOADS: JSON.stringify(payloads) },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const offsets = [-1, 5, -1, 4, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  child.stdin.end(offsets.map((offset, id) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'cursor_read_result', arguments: {
        session_id: 'S', turn_id: 'T', ...(offset < 0 ? {} : { offset }),
      },
    },
  })).join('\n') + '\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(diagnostics).toString('utf8'));
  const responses = JSON.parse(await readFile(evidence, 'utf8')).transcript.map(({ response }) => response);
  assert.deepEqual(responses.slice(0, 8), [
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: true, eof: true, total_bytes: 9, sha256: digest('alphabeta') } },
    { ok: false, error_code: 'invalid_args' },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: true, eof: true, total_bytes: 6, sha256: digest('newend') } },
    { ok: true, result_read: { complete: false, eof: true, total_bytes: 4, sha256: digest('else') } },
  ]);
  assert.deepEqual(responses.slice(8), [
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: false, eof: true } },
    { ok: true, result_read: { complete: false, eof: false } },
    { ok: true, result_read: { complete: false, eof: true, total_bytes: 6, sha256: digest('short') } },
  ]);
});

test('recording MCP proxy preserves UTF-8 split across transport chunks in both directions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-utf8-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      const exact = call.params.arguments.prompt === 'проверка-🙂';
      const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify({ session_id: exact ? 'сессия-🙂' : 'corrupted', turn_id: 'T' }) }] } }) + '\\n');
      const marker = Buffer.from('🙂'); const split = frame.indexOf(marker) + 1;
      process.stdout.write(frame.subarray(0, split));
      setImmediate(() => process.stdout.write(frame.subarray(split)));
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
  const request = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { mode: 'agent', prompt: 'проверка-🙂' },
  } })}\n`);
  const marker = Buffer.from('🙂'); const split = request.indexOf(marker) + 1;
  child.stdin.write(request.subarray(0, split)); child.stdin.end(request.subarray(split));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const response = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  assert.equal(JSON.parse(response.result.content[0].text).session_id, 'сессия-🙂');
  assert.equal(JSON.parse(await readFile(evidence, 'utf8')).transcript[0].response.session_id, 'сессия-🙂');
});

test('recording MCP proxy observes final request and response frames without trailing newlines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-final-frame-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      const call = JSON.parse(input);
      process.stdout.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', session_state: 'tombstone' }) }] } }));
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_close_session', arguments: { session_id: 'S' },
  } }));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  assert.equal(JSON.parse(Buffer.concat(stdout).toString('utf8')).id, 1);
  assert.deepEqual(JSON.parse(await readFile(evidence, 'utf8')).transcript, [
    { direction: 'request', tool: 'cursor_close_session', call_id: 1,
      request: recordedRequest({ session_id: 'S' }, { session_id: 'S' }),
      response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
  ]);
});

test('recording MCP proxy drains accepted output before exiting under stdout backpressure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-backpressure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).once('line', (line) => {
      const call = JSON.parse(line);
      const payload = { session_id: 'S', padding: 'x'.repeat(800000) };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
      process.stderr.write('writer-ready\\n');
      process.stdout.end();
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  const writerReady = once(child.stderr, 'data');
  child.stdout.pause();
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { mode: 'ask', prompt: 'bounded' },
  } })}\n`);
  await writerReady;
  assert.equal(child.exitCode, null, 'proxy exited before its backpressured output could be consumed');
  let outputBytes = 0;
  child.stdout.resume();
  child.stdout.on('data', (chunk) => { outputBytes += chunk.length; });
  const [code] = await closed;
  assert.equal(code, 0);
  assert.ok(outputBytes > 750_000);
  assert.equal(JSON.parse(await readFile(evidence, 'utf8')).transcript[0].response.session_id, 'S');
});

test('recording proxy preserves only bounded public provider error fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-provider-error-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      const payload = { session_id: 'S', session_state: 'tombstone', failure_kind: 'init',
        provider_error: { code: -32001, message: { text: 'authentication required', truncated: false }, data: { secret: 'private' } } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false,
        content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { cwd: '/secret/workspace', mode: 'ask', prompt: 'private prompt' },
  } })}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8');
  const published = JSON.parse(raw);
  assert.deepEqual(published.transcript[0].response, {
    ok: true, session_id: 'S', session_state: 'tombstone', failure_kind: 'init',
    provider_error: { code: -32001, message: { text: 'authentication required', truncated: false } },
  });
  assert.doesNotMatch(raw, /private|secret|workspace|prompt/);
});

test('recording MCP proxy proves the exact plugin roots by digest without retaining paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-plugin-roots-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const expectedRoots = ['/private/expected/plugin'];
  const expectedDigest = createHash('sha256').update(JSON.stringify(expectedRoots)).digest('hex');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', turn_id: 'T' }) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256: expectedDigest },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end([
    { id: 1, name: 'cursor_delegate', roots: expectedRoots, launch: { model: 'sonnet-4.0', effort: 'high', fast: false } },
    { id: 2, name: 'cursor_delegate', roots: ['/private/wrong/plugin'], launch: {} },
    { id: 3, name: 'cursor_resume_session', roots: expectedRoots, launch: { cursor_session_id: 'cursor-session', model: 'grok-4.6', effort: 'low', fast: true } },
  ].map(({ id, name, roots, launch }) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name, arguments: { mode: 'agent', plugin_dirs: roots, ...launch },
  } })).join('\n') + '\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const raw = await readFile(evidence, 'utf8');
  assert.deepEqual(JSON.parse(raw).transcript.map(({ request }) => request), [
    recordedRequest({ mode: 'agent', plugin_dirs: expectedRoots, model: 'sonnet-4.0', effort: 'high', fast: false },
      { mode: 'agent', model: 'sonnet-4.0', effort: 'high', fast: false, plugin_dirs_count: 1, plugin_dirs_matched: true }),
    recordedRequest({ mode: 'agent', plugin_dirs: ['/private/wrong/plugin'] },
      { mode: 'agent', plugin_dirs_count: 1, plugin_dirs_matched: false }),
    recordedRequest({ mode: 'agent', plugin_dirs: expectedRoots, cursor_session_id: 'cursor-session', model: 'grok-4.6', effort: 'low', fast: true },
      { cursor_session_id: 'cursor-session', model: 'grok-4.6', effort: 'low', fast: true, plugin_dirs_count: 1, plugin_dirs_matched: true }),
  ]);
  assert.doesNotMatch(raw, /\/private\/|expected|wrong/);

  const noDigestEvidence = join(root, 'mcp-no-digest.json');
  const noDigestChild = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: noDigestEvidence, CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256: '' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  noDigestChild.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'cursor_delegate', arguments: { mode: 'ask', plugin_dirs: ['/private/first', '/private/second'] },
  } })}\n`);
  const [noDigestCode] = await once(noDigestChild, 'close');
  assert.equal(noDigestCode, 0);
  const noDigestRaw = await readFile(noDigestEvidence, 'utf8');
  assert.deepEqual(JSON.parse(noDigestRaw).transcript[0].request,
    recordedRequest({ mode: 'ask', plugin_dirs: ['/private/first', '/private/second'] }, { mode: 'ask', plugin_dirs_count: 2 }));
  assert.doesNotMatch(noDigestRaw, /\/private\/|first|second|plugin_dirs_matched/);
});

test('recording proxy injects one stale question ID as fixture behavior, not user instruction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-stale-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', turn_id: 'T' }) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, CURSOR_EVAL_SCENARIO_ID: 'stale-fixture',
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: join(root, 'program.json'), CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const calls = [1, 2].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'cursor_answer_question', arguments: { session_id: 'S', turn_id: 'T', request_id: 'current-request', outcome: 'answered', answers: [] },
  } }));
  child.stdin.end(`${calls.join('\n')}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const requests = JSON.parse(await readFile(evidence, 'utf8')).transcript.map(({ request }) => request.request_id);
  assert.deepEqual(requests, ['eval-stale-1', 'current-request']);

  const ambientEvidence = join(root, 'ambient-mcp.json');
  const ambient = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: ambientEvidence, CURSOR_EVAL_SCENARIO_ID: 'partial-handshake',
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: 'relative-program.json', CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  ambient.stdin.end(`${calls.join('\n')}\n`);
  const [ambientCode] = await once(ambient, 'close'); assert.equal(ambientCode, 0);
  const ambientRequests = JSON.parse(await readFile(ambientEvidence, 'utf8')).transcript.map(({ request }) => request.request_id);
  assert.deepEqual(ambientRequests, ['current-request', 'current-request']);
});

test('recording proxy withholds one terminal wait response while retaining raw evidence for an immediate retry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-lost-terminal-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      const payload = { session_id: 'S', turn_id: 'T', turn_status: 'completed', wait_timeout: false,
        result: { text: 'DONE', truncated: false }, terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', result_sha256: 'a'.repeat(64), result_truncated: false } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, CURSOR_EVAL_SCENARIO_ID: 'lost-terminal-fixture',
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: join(root, 'program.json'), CURSOR_EVAL_LOSE_TERMINAL_WAIT_RESPONSE_ONCE: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const output = []; child.stdout.on('data', (chunk) => output.push(chunk));
  const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T', timeout_ms: 1_000 } } });
  child.stdin.end(`${JSON.stringify(call(1))}\n${JSON.stringify(call(2))}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const responses = Buffer.concat(output).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(JSON.parse(responses[0].result.content[0].text).error_code, 'transport_error');
  assert.equal(JSON.parse(responses[1].result.content[0].text).turn_status, 'completed');
  const transcript = JSON.parse(await readFile(evidence, 'utf8')).transcript;
  assert.deepEqual(transcript.map(({ tool, request, response, withheld_terminal_response, caller_error_code }) => ({ tool, request, response, withheld_terminal_response, caller_error_code })), [
    { tool: 'cursor_wait', request: recordedRequest(call(1).params.arguments, { session_id: 'S', turn_id: 'T', timeout_ms: 1_000 }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', wait_timeout: false, result: { text_bytes: 4, text_sha256: createHash('sha256').update('DONE').digest('hex'), truncated: false }, terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', result_sha256: 'a'.repeat(64), result_truncated: false } }, withheld_terminal_response: true, caller_error_code: 'transport_error' },
    { tool: 'cursor_wait', request: recordedRequest(call(2).params.arguments, { session_id: 'S', turn_id: 'T', timeout_ms: 1_000 }), response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', wait_timeout: false, result: { text_bytes: 4, text_sha256: createHash('sha256').update('DONE').digest('hex'), truncated: false }, terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', result_sha256: 'a'.repeat(64), result_truncated: false } }, withheld_terminal_response: undefined, caller_error_code: undefined },
  ]);
});

test('recording proxy injects a handshaken mode protocol error while preserving live status', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-mode-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const fake = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ session_id: 'S', session_state: 'live', active_turn: null }) }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence, CURSOR_EVAL_SCENARIO_ID: 'mode-recovery-fixture',
      CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: join(root, 'program.json'), CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = []; child.stdout.on('data', (chunk) => output.push(chunk));
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cursor_set_mode', arguments: { session_id: 'S', mode: 'agent' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cursor_session_status', arguments: { session_id: 'S' } } },
  ];
  child.stdin.end(`${calls.map(JSON.stringify).join('\n')}\n`);
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  const responses = Buffer.concat(output).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(JSON.parse(responses[0].result.content[0].text).error_code, 'protocol_error');
  assert.equal(JSON.parse(responses[1].result.content[0].text).session_state, 'live');
  const transcript = JSON.parse(await readFile(evidence, 'utf8')).transcript;
  assert.deepEqual(transcript.map(({ tool }) => tool), ['cursor_set_mode', 'cursor_session_status']);
  assert.deepEqual(transcript.map(({ response }) => response), [
    { ok: false, error_code: 'protocol_error' },
    { ok: true, session_id: 'S', session_state: 'live', active_turn_present: false },
  ]);
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

test('stdio recording proxy controls an immediate publication failure and closes a live child', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-publication-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const closedMarker = join(root, 'child-closed');
  const fake = `
    const { writeFileSync } = require('node:fs');
    const readline = require('node:readline');
    process.on('exit', () => writeFileSync(${JSON.stringify(closedMarker)}, 'closed'));
    process.on('SIGTERM', () => process.exit(0));
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const call = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: false, content: [{ type: 'text', text: '{}' }] } }) + '\\n');
    });`;
  const child = spawn(process.execPath, [recorder, '-e', fake], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: '/dev/null/mcp.json' }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T' } } })}\n`);
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  const stderr = Buffer.concat(diagnostics).toString('utf8');
  assert.match(stderr, /recording MCP proxy failed: /);
  assert.doesNotMatch(stderr, /Unhandled|node:events|throw er/);
  assert.equal(await readFile(closedMarker, 'utf8'), 'closed');
  assert.deepEqual(await readdir(root), ['child-closed']);
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
  assert.deepEqual(published.transcript[0].request, recordedRequest({
    session_id: 'S', turn_id: 'T', request_id: 'R', outcome: 'answered', answers,
  }, {
    session_id: 'S', turn_id: 'T', request_id: 'R', outcome: 'answered',
    answers: [
      { question_id: 'Q0', selected_option_ids: ['A', 2] },
      { selected_option_ids: ['A1'] },
      ...Array.from({ length: 14 }, (_, index) => ({ question_id: `Q${index + 2}`, selected_option_ids: [`A${index + 2}`] })),
    ],
  }));
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
    { direction: 'request', tool: 'cursor_close_session', call_id: 1,
      request: recordedRequest({ session_id: 'S' }, { session_id: 'S' }), response: { ok: true } },
  ]);
});

test('stdio recording proxy preserves invalid UTF-8 and large numeric IDs byte-for-byte', async (t) => {
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const numeric = Buffer.from('{"jsonrpc":"2.0","id":9007199254740993123,"method":"notifications/initialized"}\n');
  const invalid = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const expected = Buffer.concat([numeric, invalid]);
  const chunks = []; child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stdin.end(expected);
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.deepEqual(Buffer.concat(chunks), expected);
});

test('stdio recording proxy fails closed on an oversized no-newline frame', async (t) => {
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.end(Buffer.alloc(1_048_577, 0x78));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /frame exceeded 1 MiB limit/);
});

test('stdio recording proxy fails closed on an oversized newline-terminated frame', async (t) => {
  const child = spawn(process.execPath, [recorder, '-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const diagnostics = []; child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  child.stdin.end(Buffer.concat([Buffer.alloc(1_048_577, 0x78), Buffer.from('\n')]));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /frame exceeded 1 MiB limit/);
});

test('stdio recording proxy publishes no partial oversized provider frame', async (t) => {
  const target = 'process.stdout.write(Buffer.alloc(1048577, 0x78));';
  const child = spawn(process.execPath, [recorder, '-e', target], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const output = []; const diagnostics = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.equal(Buffer.concat(output).length, 0);
  assert.match(Buffer.concat(diagnostics).toString('utf8'), /frame exceeded 1 MiB limit/);
});

test('stdio recording proxy flushes a backpressured final response before exit', { timeout: 10_000 }, async (t) => {
  const target = `process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'x'.repeat(900000)}]}})+'\\n');`;
  const child = spawn(process.execPath, [recorder, '-e', target], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const chunks = []; child.stdout.on('data', (chunk) => chunks.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(response.result.content[0].text.length, 900_000);
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
    { direction: 'request', tool: 'cursor_answer_plan', call_id: 'rpc',
      request: recordedRequest({ session_id: {}, decision: 'approve' }, { decision: 'approve' }), response: { ok: false, rpc_error_code: -32601 } },
    { direction: 'request', tool: 'cursor_answer_question', call_id: 'bad-json',
      request: recordedRequest({ answers: [{ question_id: 'Q', selected_option_ids: 'private' }] }, { answers: [{ question_id: 'Q', selected_option_ids: [] }] }), response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'null', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'array', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'scalar', request: {}, response: { ok: false } },
    { direction: 'request', tool: 'cursor_wait', call_id: 'payload', request: {}, response: { ok: true, request_id: 9, turn_status: 'waiting_for_input', active_turn_present: true } },
  ]);
  assert.doesNotMatch(JSON.stringify(published), /private|x{100}|k{100}/);
});

test('stdio recording proxy publishes an empty startup transcript and replaces it after the first tool call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-proxy-empty-')); t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, 'mcp.json');
  const target = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',(line)=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{isError:false,content:[{type:'text',text:'{}'}]}})+'\\n');});`;
  const child = spawn(process.execPath, [recorder, '-e', target], {
    env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'],
  });
  const publishedWithCalls = async (minimum) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await readFile(evidence, 'utf8'));
        if (value.transcript?.length >= minimum) return value;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`recording proxy did not publish ${minimum} calls`);
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: {} })}\n`);
  assert.deepEqual(await publishedWithCalls(0), { schema_version: 1, transcript: [], dropped_calls: 0 });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'call', method: 'tools/call',
    params: { name: 'cursor_wait', arguments: { session_id: 'S', turn_id: 'T' } } })}\n`);
  const replaced = await publishedWithCalls(1);
  assert.deepEqual(replaced.transcript.map(({ tool }) => tool), ['cursor_wait']);
  child.stdin.end();
  const [code] = await once(child, 'close'); assert.equal(code, 0);
  assert.deepEqual(await readdir(root), ['mcp.json']);
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
    // A repeated SIGTERM can win the proxy's terminal race. Both terminal
    // forms preserve the contract under test: its target is no longer alive.
    if (signal === null) assert.equal(code, expectedCode);
    else { assert.equal(signal, 'SIGTERM'); assert.equal(code, null); }
    let targetGone = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { process.kill(targetPid, 0); }
      catch (error) { if (error.code === 'ESRCH') { targetGone = true; break; } throw error; }
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(targetGone, true, 'proxy close must terminate its target process');
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
