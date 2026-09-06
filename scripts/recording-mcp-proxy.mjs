#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

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
let proxyFailed = false;
let pendingOutputWrites = 0;
const outputWriteWaiters = [];

function boundedId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || Buffer.byteLength(String(value), 'utf8') > MAX_ID_BYTES) return null;
  return value;
}
function callKey(value) { return `${typeof value}:${String(value)}`; }
function compactIds(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return Object.fromEntries(['session_id', 'turn_id', 'request_id'].flatMap((key) => {
    const id = boundedId(value[key]); return id === null ? [] : [[key, id]];
  }));
}
function compactPending(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_LIST_ITEMS).map((pending) => ({
    ...compactIds(pending),
    ...(boundedId(pending?.kind) === null ? {} : { kind: pending.kind }),
  }));
}
function compactResult(value) {
  const bytes = Buffer.byteLength(value.text, 'utf8');
  return { text_bytes: bytes, text_sha256: createHash('sha256').update(value.text).digest('hex'), truncated: value.truncated === true };
}
function compactBoundedText(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES
    || Buffer.from(value.text, 'utf8').toString('utf8') !== value.text
    || typeof value.truncated !== 'boolean') return null;
  return { text: value.text, truncated: value.truncated };
}
function compactRequest(tool, args) {
  const request = compactIds(args);
  if ((tool === 'cursor_delegate' || tool === 'cursor_set_mode') && boundedId(args?.mode) !== null) request.mode = args.mode;
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
    if (Number.isSafeInteger(args?.after_event_id)) request.after_event_id = args.after_event_id;
    if (Number.isSafeInteger(args?.after_progress_revision)) request.after_progress_revision = args.after_progress_revision;
    if (Number.isSafeInteger(args?.timeout_ms)) request.timeout_ms = args.timeout_ms;
  }
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
function compactResponse(message) {
  const payload = toolPayload(message);
  const response = { ok: message?.result?.isError === false && payload !== null };
  if (payload) {
    Object.assign(response, compactIds(payload));
    if (boundedId(payload.cursor_session_id) !== null) response.cursor_session_id = payload.cursor_session_id;
    if (boundedId(payload.model) !== null) response.model = payload.model;
    if (boundedId(payload.effort) !== null) response.effort = payload.effort;
    if (typeof payload.fast === 'boolean') response.fast = payload.fast;
    for (const key of ['session_state', 'turn_status', 'error_code', 'failure_kind']) if (boundedId(payload[key]) !== null) response[key] = payload[key];
    const providerMessage = compactBoundedText(payload.provider_error?.message);
    if (Number.isSafeInteger(payload.provider_error?.code) && providerMessage) {
      response.provider_error = { code: payload.provider_error.code, message: providerMessage };
    }
    const terminalReason = compactBoundedText(payload.terminal_reason);
    if (terminalReason) response.terminal_reason = terminalReason;
    if (Number.isSafeInteger(payload.last_event_id)) response.last_event_id = payload.last_event_id;
    if (Number.isSafeInteger(payload.resume_after_event_id)) response.resume_after_event_id = payload.resume_after_event_id;
    if (typeof payload.wait_timeout === 'boolean') response.wait_timeout = payload.wait_timeout;
    if (Object.hasOwn(payload, 'active_turn')) response.active_turn_present = payload.active_turn !== null;
    if (typeof payload.events_lost === 'boolean') response.events_lost = payload.events_lost;
    if (Number.isSafeInteger(payload.earliest_event_id)) response.earliest_event_id = payload.earliest_event_id;
    if (Number.isSafeInteger(payload.progress_revision)) response.progress_revision = payload.progress_revision;
    if (Array.isArray(payload.events)) response.events = payload.events.slice(0, MAX_LIST_ITEMS).flatMap((event) => {
      const kind = boundedId(event?.kind); return kind === null ? [] : [{ kind }];
    });
    if (Array.isArray(payload.pending)) response.pending = compactPending(payload.pending);
    if (typeof payload.result?.text === 'string') response.result = compactResult(payload.result);
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
function observeResponse(message) {
  if (!message || !Object.hasOwn(message, 'id')) return;
  const key = callKey(message.id); const entry = pendingCalls.get(key);
  if (!entry) return;
  pendingCalls.delete(key); entry.response = compactResponse(message);
  publication = publication.then(publish).catch((error) => {
    publicationFailure ??= error;
    failProxy(error.message);
  });
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
  if (!destination || transcript.length === 0) return;
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
  try { observeResponse(parseFrame(frame)); } catch {}
}
function forwardOutputFrame(frame, terminated) {
  observeOutputFrame(frame);
  forwardOutputBytes(terminated ? Buffer.concat([frame, Buffer.from('\n')]) : frame);
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
