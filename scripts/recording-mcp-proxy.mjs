#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { canonicalJson } from './cursor-subagent-bootstrap.mjs';

const MAX_CALLS = 128;
const MAX_ID_BYTES = 256;
const MAX_TEXT_BYTES = 8_000;
const MAX_LIST_ITEMS = 16;
const MAX_EVIDENCE_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 1_048_576;
const [target, ...args] = process.argv.slice(2);
if (!target) throw new Error('MCP proxy target is required');
const transcript = [];
const pendingCalls = new Map();
const resultReads = new Map();
let droppedCalls = 0;
const child = spawn(process.execPath, [target, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
const ownerPid = process.ppid;
let input = Buffer.alloc(0);
let output = Buffer.alloc(0);
const decoder = new TextDecoder('utf-8', { fatal: true });
let publication = Promise.resolve();
let publicationFailure = null;
let stopping = false;
let staleQuestionInjected = false;
let modeProtocolErrorInjected = false;
let terminalWaitResponseWithheld = false;
let proxyFailed = false;
let pendingOutputWrites = 0;
const outputWriteWaiters = [];

function boundedId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || Buffer.byteLength(String(value), 'utf8') > MAX_ID_BYTES) return null;
  return value;
}
function callKey(value) { return `${typeof value}:${String(value)}`; }
function isPlainObject(value) {
  // Requests come from JSON.parse; non-array objects have the JSON object prototype.
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}
function compactIds(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return Object.fromEntries(['session_id', 'turn_id', 'request_id'].flatMap((key) => {
    const id = boundedId(value[key]); return id === null ? [] : [[key, id]];
  }));
}
function compactPending(value) {
  return value.slice(0, MAX_LIST_ITEMS).map((pending) => ({
    ...compactIds(pending),
    ...(boundedId(pending?.kind) === null ? {} : { kind: pending.kind }),
  }));
}
function compactResult(value) {
  const bytes = Buffer.byteLength(value.text, 'utf8');
  return { text_bytes: bytes, text_sha256: createHash('sha256').update(value.text).digest('hex'),
    ...(typeof value.truncated === 'boolean' ? { truncated: value.truncated } : {}) };
}
function compactBoundedText(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES
    || Buffer.from(value.text, 'utf8').toString('utf8') !== value.text
    || typeof value.truncated !== 'boolean') return null;
  return { text: value.text, truncated: value.truncated };
}
function compactValidationReason(message) {
  // Project the runtime's returned diagnosis, never infer it from arguments.
  // Dynamic unknown argument/tool names can contain user text and are omitted.
  if (typeof message !== 'string') return { source: 'tool_error', violation: 'unrecognized' };
  const field = /^(missing argument: |invalid )(cwd|mode|cursor_session_id|session_id|turn_id|request_id|prompt|model|effort|fast|optimize_for|timeout_ms|question_id|selected_option_id)$/.exec(message);
  if (field) return { source: 'tool_error', violation: field[1] === 'missing argument: ' ? 'missing_argument' : 'invalid_field', field: field[2] };
  if (message.startsWith('unknown argument: ')) return { source: 'tool_error', violation: 'unknown_argument' };
  if (message.startsWith('unknown tool: ')) return { source: 'tool_error', violation: 'unknown_tool' };
  const known = {
    'arguments must be an object': ['invalid_arguments_object'],
    'arguments must be JSON-serializable': ['non_json_arguments'],
    'aggregate arguments limit exceeded': ['arguments_limit'],
    'invalid mode: ask|plan|agent': ['invalid_field', 'mode'],
    'cwd must be an absolute string': ['absolute_path_required', 'cwd'],
    'plugin_dir must be an absolute string': ['absolute_path_required', 'plugin_dirs'],
    'plugin_dirs must be a nonempty array': ['nonempty_array_required', 'plugin_dirs'],
    'invalid effort token': ['invalid_token', 'effort'],
    'model must not contain parameter brackets': ['parameter_brackets', 'model'],
    'auto-smart requires explicit optimize_for; other models forbid it': ['model_optimization_constraint'],
    'default model policy does not accept model parameters': ['default_model_parameters'],
  };
  const reason = Object.hasOwn(known, message) ? known[message] : null;
  return { source: 'tool_error', violation: reason?.[0] || 'unrecognized', ...(reason?.[1] ? { field: reason[1] } : {}) };
}
function compactRequest(tool, args) {
  let argumentsDigest = null;
  if (isPlainObject(args)) {
    const nonIdArguments = Object.fromEntries(Object.entries(args)
      .filter(([key]) => key !== 'session_id' && key !== 'turn_id'));
    argumentsDigest = createHash('sha256').update(canonicalJson(nonIdArguments)).digest('hex');
  }
  const request = compactIds(args);
  if (argumentsDigest !== null) request.arguments_without_session_turn_sha256 = argumentsDigest;
  if ((tool === 'cursor_delegate' || tool === 'cursor_set_mode') && boundedId(args?.mode) !== null) request.mode = args.mode;
  if (tool === 'cursor_delegate' && typeof args?.cwd === 'string') {
    request.cwd_sha256 = createHash('sha256').update(args.cwd).digest('hex');
  }
  if (tool === 'cursor_resume_session' && ['ask', 'plan', 'agent'].includes(args?.mode)) request.mode = args.mode;
  if (tool === 'cursor_delegate' || tool === 'cursor_resume_session') {
    if (boundedId(args?.model) !== null) request.model = args.model;
    if (boundedId(args?.effort) !== null) request.effort = args.effort;
    if (typeof args?.fast === 'boolean') request.fast = args.fast;
    if (Array.isArray(args?.plugin_dirs)) {
      request.plugin_dirs_count = Math.min(args.plugin_dirs.length, MAX_LIST_ITEMS);
      if (/^[a-f0-9]{64}$/.test(process.env.CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256 || '')) {
        request.plugin_dirs_matched = createHash('sha256').update(JSON.stringify(args.plugin_dirs)).digest('hex')
          === process.env.CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256;
      }
    }
  }
  if (tool === 'cursor_resume_session' && boundedId(args?.cursor_session_id) !== null) request.cursor_session_id = args.cursor_session_id;
  if (tool === 'cursor_wait') {
    if (Number.isSafeInteger(args?.timeout_ms)) request.timeout_ms = args.timeout_ms;
  }
  if (tool === 'cursor_read_result' && Number.isSafeInteger(args?.offset)) request.offset = args.offset;
  if (tool === 'cursor_answer_question') {
    if (boundedId(args?.outcome) !== null) request.outcome = args.outcome;
    if (Array.isArray(args?.answers)) request.answers = args.answers.slice(0, MAX_LIST_ITEMS).map((answer) => ({
      ...(boundedId(answer?.question_id) === null ? {} : { question_id: answer.question_id }),
      selected_option_ids: Array.isArray(answer?.selected_option_ids) ? answer.selected_option_ids.slice(0, MAX_LIST_ITEMS).map(boundedId).filter((id) => id !== null) : [],
    }));
  } else if ((tool === 'cursor_answer_plan' || tool === 'cursor_answer_permission') && boundedId(args?.decision) !== null) request.decision = args.decision;
  return request;
}
function toolPayload(message) {
  const text = message?.result?.content?.find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try { const value = JSON.parse(text); return value && !Array.isArray(value) && typeof value === 'object' ? value : null; } catch { return null; }
}
function compactResultRead(payload, entry, delivered = true, envelope = payload) {
  if (!['cursor_wait', 'cursor_read_result'].includes(entry?.tool) || typeof payload?.text !== 'string') return null;
  if (!delivered) return null;
  const { session_id: sessionId, turn_id: turnId } = entry.request;
  const requestedOffset = entry.tool === 'cursor_wait' ? 0 : entry.request.offset ?? 0;
  const textBytes = Buffer.from(payload.text, 'utf8');
  const key = `${sessionId}\0${turnId}`;
  const prior = resultReads.get(key);
  const state = requestedOffset === 0 ? { nextOffset: 0, hash: createHash('sha256'), bytes: 0,
    totalBytes: payload.total_bytes, sha256: payload.sha256 } : prior;
  const shapeMatched = state && requestedOffset === state.nextOffset && payload.offset === requestedOffset
    && payload.session_id === sessionId && payload.turn_id === turnId
    && envelope?.session_id === sessionId && envelope?.turn_id === turnId
    && Number.isSafeInteger(payload.total_bytes) && payload.total_bytes >= 0
    && typeof payload.sha256 === 'string' && /^[a-f0-9]{64}$/.test(payload.sha256)
    && payload.total_bytes === state.totalBytes && payload.sha256 === state.sha256
    && typeof payload.eof === 'boolean'
    && textBytes.length <= payload.total_bytes - requestedOffset
    && (payload.eof ? payload.next_offset === null && requestedOffset + textBytes.length === payload.total_bytes
      : textBytes.length > 0 && payload.next_offset === requestedOffset + textBytes.length);
  if (!shapeMatched) {
    resultReads.delete(key);
    return { complete: false, eof: payload.eof === true };
  }
  resultReads.set(key, state);
  state.hash.update(textBytes); state.bytes += textBytes.length; state.nextOffset = requestedOffset + textBytes.length;
  if (!payload.eof) return { complete: false, eof: false };
  const digest = state.hash.digest('hex');
  const complete = state.bytes === payload.total_bytes && state.nextOffset === payload.total_bytes && digest === payload.sha256;
  resultReads.delete(key);
  return { complete, eof: true, total_bytes: payload.total_bytes, sha256: payload.sha256 };
}
function compactResponse(message, entry, delivered = true) {
  const payload = toolPayload(message);
  const response = { ok: message?.result?.isError === false && payload !== null };
  if (payload) {
    Object.assign(response, compactIds(payload));
    if (boundedId(payload.cursor_session_id) !== null) response.cursor_session_id = payload.cursor_session_id;
    if (boundedId(payload.model) !== null) response.model = payload.model;
    if (boundedId(payload.effort) !== null) response.effort = payload.effort;
    if (typeof payload.fast === 'boolean') response.fast = payload.fast;
    for (const key of ['session_state', 'turn_status', 'error_code', 'failure_kind']) if (boundedId(payload[key]) !== null) response[key] = payload[key];
    if (message.result?.isError === true && payload.error_code === 'invalid_args') response.validation_reason = compactValidationReason(payload.message);
    if (payload.error_code === 'eval_wait_response_lost' && payload.message === 'cursor_wait response unavailable') response.message = payload.message;
    const providerMessage = compactBoundedText(payload.provider_error?.message);
    if (Number.isSafeInteger(payload.provider_error?.code) && providerMessage) {
      response.provider_error = { code: payload.provider_error.code, message: providerMessage };
    }
    const terminalReason = compactBoundedText(payload.terminal_reason);
    if (terminalReason) response.terminal_reason = terminalReason;
    if (Number.isSafeInteger(payload.last_event_id)) response.last_event_id = payload.last_event_id;
    if (typeof payload.wait_timeout === 'boolean') response.wait_timeout = payload.wait_timeout;
    const progress = compactBoundedText(payload.progress_excerpt);
    if (progress) response.progress_excerpt = { ...progress, ...compactResult(progress) };
    if (Object.hasOwn(payload, 'active_turn')) response.active_turn_present = payload.active_turn !== null;
    if (Array.isArray(payload.pending)) response.pending = compactPending(payload.pending);
    if (typeof payload.result?.text === 'string') response.result = compactResult(payload.result);
    const resultPage = payload.result_page;
    if (resultPage && !Array.isArray(resultPage) && typeof resultPage === 'object' && typeof resultPage.text === 'string') {
      response.result_page = { ...compactResult(resultPage),
        ...(Number.isSafeInteger(resultPage.offset) ? { offset: resultPage.offset } : {}),
        ...(Number.isSafeInteger(resultPage.next_offset) ? { next_offset: resultPage.next_offset } : {}),
        ...(resultPage.next_offset === null ? { next_offset: null } : {}),
        ...(typeof resultPage.eof === 'boolean' ? { eof: resultPage.eof } : {}),
        ...(Number.isSafeInteger(resultPage.total_bytes) ? { total_bytes: resultPage.total_bytes } : {}),
        ...(typeof resultPage.sha256 === 'string' && /^[a-f0-9]{64}$/.test(resultPage.sha256) ? { sha256: resultPage.sha256 } : {}),
      };
    } else if (resultPage === null) response.result_page = null;
    const resultRead = compactResultRead(entry?.tool === 'cursor_wait' ? resultPage : payload, entry, delivered, payload);
    if (resultRead) response.result_read = resultRead;
    if (payload.terminal_receipt && !Array.isArray(payload.terminal_receipt) && typeof payload.terminal_receipt === 'object') {
      const receipt = payload.terminal_receipt;
      response.terminal_receipt = {
        ...compactIds(receipt),
        ...(boundedId(receipt.turn_status) === null ? {} : { turn_status: receipt.turn_status }),
        ...(Number.isSafeInteger(receipt.last_event_id) ? { last_event_id: receipt.last_event_id } : {}),
        ...(typeof receipt.result_sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.result_sha256) ? { result_sha256: receipt.result_sha256 } : {}),
        ...(receipt.result_sha256 === null ? { result_sha256: null } : {}),
        ...(typeof receipt.result_truncated === 'boolean' ? { result_truncated: receipt.result_truncated } : {}),
      };
    }
  } else if (message?.error && Number.isSafeInteger(message.error.code)) response.rpc_error_code = message.error.code;
  return response;
}
function observeRequest(message) {
  if (message?.method !== 'tools/call') return;
  const callId = boundedId(message.id); const tool = boundedId(message.params?.name);
  if (transcript.length >= MAX_CALLS) { droppedCalls += 1; return; }
  const entry = { direction: 'request', tool, call_id: callId, request: compactRequest(tool, message.params?.arguments) };
  transcript.push(entry);
  if (callId !== null) pendingCalls.set(callKey(message.id), entry);
}
function schedulePublication() {
  publication = publication.then(publish).catch((error) => {
    publicationFailure ??= error;
    failProxy(error.message);
  });
}
function observeResponse(message) {
  if (!message || !Object.hasOwn(message, 'id')) return;
  const key = callKey(message.id); const entry = pendingCalls.get(key);
  if (!entry) return;
  pendingCalls.delete(key); entry.response = compactResponse(message, entry);
  schedulePublication();
}
function evalFaultHandshake() {
  return isAbsolute(process.env.CURSOR_EVAL_MCP_EVIDENCE || '')
    && typeof process.env.CURSOR_EVAL_SCENARIO_ID === 'string' && process.env.CURSOR_EVAL_SCENARIO_ID.length > 0
    && isAbsolute(process.env.CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH || '');
}
function forwardedRequest(message) {
  if (!evalFaultHandshake() || process.env.CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE !== '1' || staleQuestionInjected
    || message?.method !== 'tools/call' || message.params?.name !== 'cursor_answer_question') return message;
  staleQuestionInjected = true;
  return { ...message, params: { ...message.params, arguments: {
    ...message.params?.arguments, request_id: `eval-stale-${String(message.id).slice(0, 64)}`,
  } } };
}
function parseFrame(frame) { return JSON.parse(decoder.decode(frame)); }
function completeOutputWrite() {
  pendingOutputWrites -= 1;
  if (pendingOutputWrites === 0) for (const resolveWait of outputWriteWaiters.splice(0)) resolveWait();
}
function forwardOutputBytes(bytes) {
  pendingOutputWrites += 1;
  const accepted = process.stdout.write(bytes, completeOutputWrite);
  if (!accepted) {
    child.stdout.pause();
    process.stdout.once('drain', () => child.stdout.resume());
  }
}
function waitForOutputWrites() {
  return pendingOutputWrites === 0 ? Promise.resolve() : new Promise((resolveWait) => outputWriteWaiters.push(resolveWait));
}
function failProxy(message) {
  if (proxyFailed) return;
  proxyFailed = true;
  process.stderr.write(`recording MCP proxy failed: ${message}\n`);
  child.stdin.destroy();
  stopChild();
}
function consumeFrames(buffer, incoming, onFrame) {
  let combined = Buffer.concat([buffer, Buffer.from(incoming)]);
  for (;;) {
    const newline = combined.indexOf(0x0a);
    if (newline < 0) break;
    const frame = combined.subarray(0, newline);
    combined = combined.subarray(newline + 1);
    if (frame.length > MAX_FRAME_BYTES) throw new Error('frame exceeded 1 MiB limit');
    onFrame(frame, true);
  }
  if (combined.length > MAX_FRAME_BYTES) throw new Error('frame exceeded 1 MiB limit');
  return combined;
}
function stopChild() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1_000).unref();
}
async function publish() {
  const destination = process.env.CURSOR_EVAL_MCP_EVIDENCE;
  if (!destination) return;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  const serialized = JSON.stringify({ schema_version: 1, transcript, dropped_calls: droppedCalls });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) throw new Error('bounded MCP evidence exceeded its publication limit');
  await writeFile(temporary, serialized, 'utf8');
  await rename(temporary, destination);
}
function forwardInputFrame(frame, terminated) {
  let forwarded = frame;
  try {
    const message = parseFrame(frame);
    const changed = forwardedRequest(message);
    observeRequest(changed);
    if (evalFaultHandshake() && process.env.CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE === '1'
      && !modeProtocolErrorInjected && changed?.method === 'tools/call' && changed.params?.name === 'cursor_set_mode') {
      modeProtocolErrorInjected = true;
      const response = { jsonrpc: '2.0', id: changed.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({
        error_code: 'protocol_error', message: 'session mode transition is already in progress',
      }) }] } };
      observeResponse(response);
      forwardOutputBytes(Buffer.from(`${JSON.stringify(response)}\n`));
      return;
    }
    if (changed !== message) forwarded = Buffer.from(JSON.stringify(changed));
  } catch {}
  child.stdin.write(forwarded);
  if (terminated) child.stdin.write('\n');
}
function observeOutputFrame(frame) {
  try {
    observeResponse(parseFrame(frame));
    if (transcript.length === 0) schedulePublication();
  } catch {}
}
function withholdTerminalWaitResponse(frame) {
  if (!evalFaultHandshake() || process.env.CURSOR_EVAL_LOSE_TERMINAL_WAIT_RESPONSE_ONCE !== '1'
    || terminalWaitResponseWithheld) return null;
  let message;
  try { message = parseFrame(frame); } catch { return null; }
  const entry = pendingCalls.get(callKey(message?.id));
  const payload = toolPayload(message);
  if (entry?.tool !== 'cursor_wait' || !payload
    || message.result?.isError !== false || payload.turn_status !== 'completed'
    || typeof payload.result_page?.text !== 'string' || payload.result_page.text.length === 0) return null;
  terminalWaitResponseWithheld = true;
  entry.withheld_response = compactResponse(message, entry, false);
  return { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({
    error_code: 'eval_wait_response_lost', message: 'cursor_wait response unavailable',
  }) }] } };
}
function forwardOutputFrame(frame, terminated) {
  const withheld = withholdTerminalWaitResponse(frame);
  const outputFrame = withheld === null ? frame : Buffer.from(JSON.stringify(withheld));
  observeOutputFrame(outputFrame);
  forwardOutputBytes(terminated ? Buffer.concat([outputFrame, Buffer.from('\n')]) : outputFrame);
}
process.stdin.on('data', (chunk) => {
  if (proxyFailed) return;
  try { input = consumeFrames(input, chunk, forwardInputFrame); }
  catch (error) { input = Buffer.alloc(0); failProxy(error.message); }
});
process.stdin.once('end', () => {
  if (!proxyFailed && input.length > 0) forwardInputFrame(input, false);
  input = Buffer.alloc(0);
  if (!child.stdin.destroyed) child.stdin.end();
});
const ownerWatch = setInterval(() => { if (process.ppid !== ownerPid) stopChild(); }, 250);
ownerWatch.unref();
child.stdout.on('data', (chunk) => {
  if (proxyFailed) return;
  try { output = consumeFrames(output, chunk, forwardOutputFrame); }
  catch (error) { output = Buffer.alloc(0); failProxy(error.message); }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.once('close', async (code) => {
  if (!proxyFailed && output.length > 0) forwardOutputFrame(output, false);
  output = Buffer.alloc(0);
  try {
    await publication;
    if (!publicationFailure) await publish();
  } catch (error) {
    publicationFailure ??= error;
    failProxy(error.message);
  }
  await waitForOutputWrites();
  process.stdin.destroy();
  process.exitCode = proxyFailed ? 1 : code ?? 1;
});
process.once('SIGTERM', stopChild);
