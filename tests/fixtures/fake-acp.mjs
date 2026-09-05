#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.argv.includes('--version')) {
  if (process.env.FAKE_ACP_VERSION_MODE === 'overflow') {
    await new Promise((resolve) => process.stdout.write('v'.repeat(64_001), resolve));
  } else if (process.env.FAKE_ACP_VERSION_MODE === 'invalid-utf8') {
    await new Promise((resolve) => process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]), resolve));
  } else {
    process.stdout.write(`${process.env.FAKE_ACP_VERSION || '2026.08.25-3e8eec8'}\n`);
  }
  process.exit(process.env.FAKE_ACP_VERSION_MODE === 'nonzero' ? 9 : 0);
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
const send = (message) => process.stdout.write(`${JSON.stringify(message)}${process.env.FAKE_ACP_CRLF ? '\r\n' : '\n'}`);
const program = process.env.CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH
  ? JSON.parse(readFileSync(process.env.CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH, 'utf8'))
  : null;
if (program && (program.kind !== 'fake-acp' || !Array.isArray(program.steps))) throw new Error('invalid materialized fake-ACP program');
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
  safeEvidence({ event: 'prompt_result', request_id: id });
};
let programStepIndex = 0;
let awaitedProgramStep = null;
const permissionOptionIds = new Map();
const recordProgramFailure = (step, reason) => safeEvidence({
  kind: 'callback.failure', step_id: step.step_id, callback_id: step.callback_id, reason,
});
const advanceProgram = () => {
  if (!program || promptId === null || awaitedProgramStep) return;
  const step = program.steps[programStepIndex];
  if (!step) throw new Error('fake-ACP program ended without terminal step');
  programStepIndex += 1;
  if (step.type === 'terminal') {
    if (step.result_text !== null) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text: step.result_text } } } });
    }
    const id = promptId;
    promptId = null;
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    safeEvidence({ event: 'prompt_result', request_id: id, step_id: step.step_id });
    return;
  }
  awaitedProgramStep = step;
  if (step.type === 'effect') {
    send({ jsonrpc: '2.0', id: step.callback_id, method: 'fs/write_text_file', params: {
      sessionId: 'fake', path: resolve(process.cwd(), step.path), content: step.text,
    } });
    return;
  }
  if (step.type !== 'pending') throw new Error(`unsupported fake-ACP program step: ${step.type}`);
  if (step.request_kind === 'question') {
    send({ jsonrpc: '2.0', id: step.callback_id, method: 'cursor/ask_question', params: {
      questions: [{ id: step.question_id, question: step.prompt, options: step.options }],
    } });
    return;
  }
  if (step.request_kind === 'plan') {
    send({ jsonrpc: '2.0', id: step.callback_id, method: 'cursor/create_plan', params: { plan: step.plan_text } });
    return;
  }
  if (step.request_kind === 'permission') {
    const allowId = `${step.callback_id}:allow`;
    const rejectId = `${step.callback_id}:reject`;
    permissionOptionIds.set(allowId, 'allow-once');
    permissionOptionIds.set(rejectId, 'reject-once');
    send({ jsonrpc: '2.0', id: step.callback_id, method: 'session/request_permission', params: {
      sessionId: 'fake',
      toolCall: {
        toolCallId: step.callback_id,
        title: `${step.action.operation} ${step.action.path}`,
        kind: step.action.operation,
        locations: [{ path: resolve(process.cwd(), step.action.path) }],
      },
      options: [
        { optionId: allowId, kind: 'allow_once', name: 'Allow once' },
        { optionId: rejectId, kind: 'reject_once', name: 'Reject once' },
      ],
    } });
    return;
  }
  throw new Error(`unsupported fake-ACP pending kind: ${step.request_kind}`);
};
const handleProgramResponse = (response) => {
  const step = awaitedProgramStep;
  if (!step) return false;
  const actualId = String(response.id);
  if (actualId !== step.callback_id) {
    recordProgramFailure(step, 'id-mismatch');
    return true;
  }
  awaitedProgramStep = null;
  if (response.error) {
    recordProgramFailure(step, 'error');
  } else if (!Object.hasOwn(response, 'result')) {
    recordProgramFailure(step, 'missing');
  } else if (step.type === 'effect') {
    safeEvidence({
      step_id: step.step_id, callback_id: actualId, kind: 'write-result', outcome: 'succeeded',
    });
    safeEvidence({ kind: 'effect.file-written', step_id: step.step_id, callback_id: actualId });
  } else if (step.request_kind === 'question') {
    const outcome = response.result?.outcome;
    safeEvidence({
      kind: 'answer', step_id: step.step_id, callback_id: actualId,
      option_ids: outcome?.answers?.flatMap((answer) => answer.selectedOptionIds || []) || [],
    });
  } else if (step.request_kind === 'plan') {
    const outcome = response.result?.outcome?.outcome;
    safeEvidence({
      kind: 'decision', step_id: step.step_id, callback_id: actualId,
      decision: outcome === 'accepted' ? 'accept' : outcome === 'rejected' ? 'reject' : null,
    });
  } else {
    const optionId = response.result?.outcome?.optionId;
    safeEvidence({
      kind: 'decision', step_id: step.step_id, callback_id: actualId,
      decision: permissionOptionIds.get(optionId) || null,
    });
  }
  advanceProgram();
  return true;
};
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.method && request.id !== undefined) {
    log(request);
    if (program && handleProgramResponse(request)) return;
    if (process.env.FAKE_ACP_PENDING === 'invalid-question') {
      const question = { id: 'q', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] };
      switch (process.env.FAKE_ACP_CALLBACK_VARIANT) {
        case 'missing-questions':
          return send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: {} });
        case 'null-question': return send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [null] } });
        case 'empty-question-id': question.id = ''; break;
        case 'empty-options': question.options = []; break;
        case 'duplicate-question': return send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [question, { ...question }] } });
        case 'duplicate-option': question.options = [{ id: 'yes', label: 'Yes' }, { id: 'yes', label: 'Again' }]; break;
        case 'empty-option-id': question.options[0].id = ''; break;
        case 'invalid-question-text': question.question = '\ud800'; break;
        case 'invalid-option-label': question.options[0].label = '\ud800'; break;
        case 'null-option': question.options[0] = null; break;
        case 'invalid-multiplicity': question.allowMultiple = 'sometimes'; break;
        default: throw new Error(`unknown invalid question fixture: ${process.env.FAKE_ACP_CALLBACK_VARIANT}`);
      }
      return send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [question] } });
    }
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
    if (process.env.FAKE_ACP_INIT_RESPONSE_VARIANT === 'missing-payload') return send({ jsonrpc: '2.0', id: request.id });
    if (process.env.FAKE_ACP_INIT_RESPONSE_VARIANT === 'error-no-message') return send({ jsonrpc: '2.0', id: request.id, error: {} });
    if (process.env.FAKE_ACP_INIT_RESPONSE_VARIANT === 'unknown-id-first') send({ jsonrpc: '2.0', id: 'unknown', result: {} });
    const reply = () => send({ jsonrpc: '2.0', id: request.id, result: process.env.FAKE_ACP_BAD_ADMISSION ? {} : { protocolVersion: 1, authMethods: [{ id: 'cursor_login' }], agentCapabilities: process.env.FAKE_ACP_BAD_CAPABILITIES ? {} : { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { audio: false, embeddedContext: false, image: true }, sessionCapabilities: { list: {} } } } });
    return process.env.FAKE_ACP_DELAY_INIT_MS ? setTimeout(reply, Number(process.env.FAKE_ACP_DELAY_INIT_MS)) : reply();
  }
  if (request.method === 'authenticate') return send({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'session/new') {
    const result = { sessionId: 'fake', modes: { currentModeId: 'agent', availableModes: ['ask', 'plan', 'agent'].map((id) => ({ id })) } };
    if (process.env.FAKE_ACP_SESSION_VARIANT === 'missing-id') delete result.sessionId;
    if (process.env.FAKE_ACP_SESSION_VARIANT === 'missing-modes') delete result.modes;
    if (process.env.FAKE_ACP_SESSION_VARIANT === 'incomplete-modes') result.modes.availableModes = [{ id: 'ask' }];
    return send({ jsonrpc: '2.0', id: request.id, result });
  }
  if (request.method === 'session/set_mode') return send({ jsonrpc: '2.0', id: request.id, result: {} });
  if (request.method === 'session/prompt') {
    promptId = request.id;
    if (program) { advanceProgram(); return; }
    if (process.env.FAKE_ACP_PROMPT_RESPONSE_VARIANT === 'missing-payload') return send({ jsonrpc: '2.0', id: request.id });
    if (process.env.FAKE_ACP_PROMPT_RESPONSE_VARIANT === 'error-no-message') return send({ jsonrpc: '2.0', id: request.id, error: {} });
    if (process.env.FAKE_ACP_PROMPT_RESPONSE_VARIANT === 'unknown-id-first') send({ jsonrpc: '2.0', id: 'unknown', result: {} });
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
    if (process.env.FAKE_ACP_FRAME_VARIANT === 'overflow-line') { process.stdout.write(`${'x'.repeat(1_048_577)}\n`); return; }
    if (process.env.FAKE_ACP_FRAME_VARIANT === 'overflow-buffer') { process.stdout.write('x'.repeat(1_048_577)); return; }
    if (process.env.FAKE_ACP_FRAME_VARIANT === 'invalid-agent-message') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake', update: { sessionUpdate: 'agent_message_chunk', content: { text: '\ud800' } } } });
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'question') {
      send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [{ id: 'q', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }] } });
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'question-optional') {
      send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { title: 'Continue', questions: [{ id: 'q', prompt: 'Continue?', allowMultiple: true, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }] } });
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'two-questions') {
      pendingResponsesRemaining = 2;
      send({ jsonrpc: '2.0', id: 'q1', method: 'cursor/ask_question', params: { questions: [{ id: 'first', question: 'First?', options: [{ id: 'yes', label: 'Yes' }] }] } });
      send({ jsonrpc: '2.0', id: 'q2', method: 'cursor/ask_question', params: { questions: [{ id: 'second', question: 'Second?', options: [{ id: 'yes', label: 'Yes' }] }] } });
      return;
    }
    if (process.env.FAKE_ACP_PENDING === 'pending-capacity') {
      pendingResponsesRemaining = 8;
      for (let index = 0; index < 9; index += 1) {
        send({ jsonrpc: '2.0', id: `q${index}`, method: 'cursor/ask_question', params: { questions: [{ id: `question-${index}`, question: `Question ${index}?`, options: [{ id: 'yes', label: 'Yes' }] }] } });
      }
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
    if (process.env.FAKE_ACP_PENDING === 'invalid-permission') {
      const params = { sessionId: 'fake', toolCall: { toolCallId: 'tool-1', title: 'Run?', kind: 'execute', locations: [{ path: process.cwd(), line: 1 }] }, options: [{ optionId: 'opaque-reject', kind: 'reject_once', name: 'No' }, { optionId: 'opaque-allow', kind: 'allow_once', name: 'Yes' }] };
      switch (process.env.FAKE_ACP_CALLBACK_VARIANT) {
        case 'session-mismatch': params.sessionId = 'other'; break;
        case 'missing-tool-call': delete params.toolCall; break;
        case 'empty-tool-call-id': params.toolCall.toolCallId = ''; break;
        case 'duplicate-semantic-option': params.options.push({ optionId: 'another-allow', kind: 'allow_once', name: 'Again' }); break;
        case 'missing-options': delete params.options; break;
        case 'empty-option-id': params.options[0].optionId = ''; break;
        case 'invalid-option-label': params.options[0].name = '\ud800'; break;
        case 'missing-semantic-option': params.options = [params.options[0]]; break;
        case 'unsupported-option-kind': params.options[0].kind = 'allow_always'; break;
        case 'invalid-locations': params.toolCall.locations = {}; break;
        case 'invalid-location-path': params.toolCall.locations = [{ path: 42 }]; break;
        case 'invalid-location': params.toolCall.locations = [{ path: process.cwd(), line: 0 }]; break;
        default: throw new Error(`unknown invalid permission fixture: ${process.env.FAKE_ACP_CALLBACK_VARIANT}`);
      }
      return send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params });
    }
    if (process.env.FAKE_ACP_PENDING === 'permission') return send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: 'fake', toolCall: { toolCallId: 'tool-1', title: 'Run?', kind: 'execute', locations: [{ path: process.cwd(), line: 1 }] }, options: [{ optionId: 'opaque-reject', kind: 'reject_once', name: 'No' }, { optionId: 'opaque-allow', kind: 'allow_once', name: 'Yes' }] } });
    if (process.env.FAKE_ACP_PENDING === 'permission-optional') return send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: 'fake', toolCall: { toolCallId: 'tool-1' }, options: [{ optionId: 'opaque-reject', kind: 'reject_once', label: 'No' }, { optionId: 'opaque-allow', kind: 'allow_once', label: 'Yes' }] } });
    if (process.env.FAKE_ACP_PENDING === 'plan-optional') return send({ jsonrpc: '2.0', id: 'plan1', method: 'cursor/create_plan', params: { body: 'Fallback body' } });
    if (process.env.FAKE_ACP_PENDING === 'ambiguous-permission') return send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: { sessionId: 'fake', toolCall: { toolCallId: 'tool-1' }, options: [{ optionId: 'one', kind: 'allow_once' }] } });
    if (process.env.FAKE_ACP_PENDING === 'plan') return send({ jsonrpc: '2.0', id: 'plan1', method: 'cursor/create_plan', params: { name: 'Plan', plan: 'Do it' } });
    if (process.env.FAKE_ACP_PENDING === 'read') {
      const params = { sessionId: 'fake', path: process.env.FAKE_ACP_PATH, line: Number(process.env.FAKE_ACP_LINE || 1), limit: Number(process.env.FAKE_ACP_LIMIT || 20) };
      if (process.env.FAKE_ACP_FS_VARIANT === 'session-mismatch') params.sessionId = 'other';
      if (process.env.FAKE_ACP_FS_VARIANT === 'relative-path') params.path = 'relative.txt';
      if (process.env.FAKE_ACP_FS_VARIANT === 'nul-path') params.path = `${process.cwd()}\0invalid`;
      if (process.env.FAKE_ACP_FS_VARIANT === 'line-zero') params.line = 0;
      if (process.env.FAKE_ACP_FS_VARIANT === 'limit-negative') params.limit = -1;
      return send({ jsonrpc: '2.0', id: 'fs1', method: 'fs/read_text_file', params: process.env.FAKE_ACP_FS_VARIANT === 'missing-params' ? null : params });
    }
    if (process.env.FAKE_ACP_PENDING === 'write') {
      let content = process.env.FAKE_ACP_CONTENT || '';
      const path = process.env.FAKE_ACP_FS_VARIANT === 'nul-path' ? `${process.cwd()}\0invalid` : process.env.FAKE_ACP_PATH;
      if (process.env.FAKE_ACP_FS_VARIANT === 'invalid-content') content = '\ud800';
      return send({ jsonrpc: '2.0', id: 'fs1', method: 'fs/write_text_file', params: { sessionId: 'fake', path, content } });
    }
    if (process.env.FAKE_ACP_PENDING === 'unknown') return send({ jsonrpc: '2.0', id: 'unknown1', method: 'cursor/not_admitted', params: {} });
    promptId = null;
    if (process.env.FAKE_ACP_DELAY_RESULT_MS) setTimeout(() => finishPrompt(request.id, process.env.FAKE_ACP_RESULT || 'done'), Number(process.env.FAKE_ACP_DELAY_RESULT_MS));
    else finishPrompt(request.id, process.env.FAKE_ACP_RESULT || 'done');
    if (process.env.FAKE_ACP_EXIT_AFTER_RESULT) setImmediate(() => process.exit(0));
    return;
  }
  if (request.method === 'session/cancel') {
    if (program && awaitedProgramStep) recordProgramFailure(awaitedProgramStep, 'missing');
    if (process.env.FAKE_ACP_IGNORE_CANCEL) return;
    return process.exit(0);
  }
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: {} });
});
input.on('close', () => {
  if (program && awaitedProgramStep) recordProgramFailure(awaitedProgramStep, 'missing');
});
