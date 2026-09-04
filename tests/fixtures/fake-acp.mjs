#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_ACP_VERSION || '2026.08.25-3e8eec8'}\n`);
  process.exit(0);
}

const expectedPolicyArgv = process.env.FAKE_ACP_EXPECT_DEFAULT_ARGV
  ? ['--auto-review', '--sandbox', 'enabled', 'acp']
  : ['--auto-review', '--sandbox', 'enabled'];
if (process.env.FAKE_ACP_REQUIRE_POLICY
  && JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedPolicyArgv)) {
  process.stderr.write('missing required adapter policy argv\n');
  process.exit(9);
}

const input = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let promptId = null;
let pendingResponsesRemaining = 0;
const log = (message) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(message)}\n`); };
// This is deliberately narrower than FAKE_ACP_LOG.  Hosted evals may retain it
// outside their disposable fixture, so it records only fixture-defined outcome
// tags rather than ACP prompts, model text, or arbitrary tool arguments.
const safeEvidence = (message) => {
  if (process.env.FAKE_ACP_SAFE_EVIDENCE) appendFileSync(process.env.FAKE_ACP_SAFE_EVIDENCE, `${JSON.stringify(message)}\n`);
};
const finishPrompt = (id, text) => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text } } } });
  send({ jsonrpc: '2.0', id, result: { stopReason: process.env.FAKE_ACP_BAD_PROMPT_RESULT ? 'unknown' : (process.env.FAKE_ACP_STOP_REASON || 'end_turn') } });
};
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.method && request.id !== undefined) {
    log(request);
    if (process.env.FAKE_ACP_PENDING === 'question') {
      const answer = request.result?.outcome;
      safeEvidence({ callback: 'question', request_id: request.id, outcome: answer?.outcome || null,
        selected_option_ids: answer?.answers?.flatMap((item) => item.selectedOptionIds || []) || [] });
    }
    if (process.env.FAKE_ACP_PENDING === 'plan') safeEvidence({ callback: 'plan', request_id: request.id, outcome: request.result?.outcome?.outcome || null });
    if (process.env.FAKE_ACP_PENDING === 'permission') safeEvidence({ callback: 'permission', request_id: request.id, option_id: request.result?.outcome?.optionId || null });
    if (process.env.FAKE_ACP_PENDING === 'duplicate' && request.error) return;
    if (pendingResponsesRemaining > 0) pendingResponsesRemaining -= 1;
    if (pendingResponsesRemaining > 0) return;
    if (promptId !== null) { finishPrompt(promptId, 'done'); promptId = null; }
    return;
  }
  if (request.method === 'initialize') {
    if (process.env.FAKE_ACP_INIT_FRAME) return process.stdout.write(`${process.env.FAKE_ACP_INIT_FRAME}\n`);
    const reply = () => send({ jsonrpc: '2.0', id: request.id, result: process.env.FAKE_ACP_BAD_ADMISSION ? {} : { protocolVersion: 1, authMethods: [{ id: 'cursor_login' }], agentCapabilities: process.env.FAKE_ACP_BAD_CAPABILITIES ? {} : { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { audio: false, embeddedContext: false, image: true }, sessionCapabilities: { list: {} } } } });
    return process.env.FAKE_ACP_DELAY_INIT_MS ? setTimeout(reply, Number(process.env.FAKE_ACP_DELAY_INIT_MS)) : reply();
  }
  if (request.method === 'authenticate') return send({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'session/new') return send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fake', modes: { currentModeId: 'agent', availableModes: ['ask', 'plan', 'agent'].map((id) => ({ id })) } } });
  if (request.method === 'session/set_mode') return send({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'session/prompt') {
    promptId = request.id;
    if (process.env.FAKE_ACP_REJECT_PROMPT) {
      promptId = null;
      return send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'prompt rejected' } });
    }
    if (process.env.FAKE_ACP_EXIT_ON_PROMPT) return process.exit(7);
    if (process.env.FAKE_ACP_STDOUT_EOF_ON_PROMPT) {
      process.stdout.end();
      setInterval(() => {}, 1_000);
      return;
    }
    if (process.env.FAKE_ACP_INVALID_UTF8) { process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a])); return; }
    if (process.env.FAKE_ACP_INVALID_FRAME) { process.stdout.write(`${process.env.FAKE_ACP_INVALID_FRAME}\n`); return; }
    if (process.env.FAKE_ACP_PENDING === 'question') {
      send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [{ id: 'q', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }] } });
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'two-questions') {
      pendingResponsesRemaining = 2;
      send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [{ id: 'first', question: 'First?', options: [{ id: 'yes', label: 'Yes' }] }] } });
      send({ jsonrpc: '2.0', id: 'q2', method: 'cursor/ask_question', params: { questions: [{ id: 'second', question: 'Second?', options: [{ id: 'yes', label: 'Yes' }] }] } });
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'oversized-question') {
      const questions = Array.from({ length: 9 }, (_, index) => ({ id: `q-${index}`, question: 'q'.repeat(9_000), options: [{ id: 'yes', label: 'Yes' }] }));
      send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions } });
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'result-with-pending') {
      send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [{ id: 'q', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }] } });
      finishPrompt(request.id, 'premature');
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'duplicate') {
      const callback = { jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [{ id: 'q', question: 'First?', options: [{ id: 'yes', label: 'Yes' }] }] } };
      const duplicate = { ...callback, params: { questions: [{ id: 'q2', question: 'Second?', options: [{ id: 'no', label: 'No' }] }] } };
      process.stdout.write(`${JSON.stringify(callback)}\n${JSON.stringify(duplicate)}\n`); return;
    }
    if (process.env.FAKE_ACP_PENDING === 'permission') return send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: 'fake', toolCall: { toolCallId: 'tool-1', title: 'Run?', kind: 'execute', locations: [{ path: process.cwd(), line: 1 }] }, options: [{ optionId: 'opaque-reject', kind: 'reject_once', name: 'No' }, { optionId: 'opaque-allow', kind: 'allow_once', name: 'Yes' }] } });
    if (process.env.FAKE_ACP_PENDING === 'ambiguous-permission') return send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: 'fake', toolCall: { toolCallId: 'tool-1' }, options: [{ optionId: 'one', kind: 'allow_once' }] } });
    if (process.env.FAKE_ACP_PENDING === 'plan') return send({ jsonrpc: '2.0', id: 'plan1', method: 'cursor/create_plan', params: { name: 'Plan', plan: 'Do it' } });
    if (process.env.FAKE_ACP_PENDING === 'read') return send({ jsonrpc: '2.0', id: 'fs1', method: 'fs/read_text_file', params: { sessionId: 'fake', path: process.env.FAKE_ACP_PATH, line: Number(process.env.FAKE_ACP_LINE || 1), limit: 20 } });
    if (process.env.FAKE_ACP_PENDING === 'write') return send({ jsonrpc: '2.0', id: 'fs1', method: 'fs/write_text_file', params: { sessionId: 'fake', path: process.env.FAKE_ACP_PATH, content: process.env.FAKE_ACP_CONTENT || '' } });
    if (process.env.FAKE_ACP_PENDING === 'unknown') return send({ jsonrpc: '2.0', id: 'unknown1', method: 'cursor/not_admitted', params: {} });
    promptId = null;
    finishPrompt(request.id, process.env.FAKE_ACP_RESULT || 'done');
    if (process.env.FAKE_ACP_EXIT_AFTER_RESULT) setImmediate(() => process.exit(0));
    return;
  }
  if (request.method === 'session/cancel') return process.exit(0);
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: {} });
});
