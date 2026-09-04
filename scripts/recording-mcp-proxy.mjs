#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_CALLS = 128;
const MAX_ID_BYTES = 256;
const MAX_LIST_ITEMS = 16;
const MAX_EVIDENCE_BYTES = 1_048_576;
const [target, ...args] = process.argv.slice(2);
if (!target) throw new Error('MCP proxy target is required');
const transcript = [];
const pendingCalls = new Map();
let droppedCalls = 0;
const child = spawn(process.execPath, [target, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
const ownerPid = process.ppid;
let input = '';
let output = '';
let publication = Promise.resolve();
let stopping = false;

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
function compactTurn(value, includeResult = false) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const turn = {
    ...compactIds(value),
    ...(boundedId(value.turn_status) === null ? {} : { turn_status: value.turn_status }),
    pending: compactPending(value.pending),
  };
  if (includeResult && typeof value.result?.text === 'string') {
    const bytes = Buffer.byteLength(value.result.text, 'utf8');
    turn.result = { text_bytes: bytes, text_sha256: createHash('sha256').update(value.result.text).digest('hex'), truncated: value.result.truncated === true };
  }
  return turn;
}
function compactRequest(tool, args) {
  const request = compactIds(args);
  if (tool === 'cursor_delegate' && boundedId(args?.mode) !== null) request.mode = args.mode;
  if (tool === 'cursor_wait') {
    if (Number.isSafeInteger(args?.after_event_id)) request.after_event_id = args.after_event_id;
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
    for (const key of ['session_state', 'turn_status', 'error_code']) if (boundedId(payload[key]) !== null) response[key] = payload[key];
    if (Number.isSafeInteger(payload.last_event_id)) response.last_event_id = payload.last_event_id;
    if (typeof payload.timed_out === 'boolean') response.timed_out = payload.timed_out;
    const active = compactTurn(payload.active_turn); if (active) response.active_turn = active;
    const terminal = compactTurn(payload.last_terminal_turn, true); if (terminal) response.last_terminal_turn = terminal;
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
  pendingCalls.delete(key); entry.response = compactResponse(message); publication = publication.then(publish);
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
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    try { observeRequest(JSON.parse(line)); } catch {}
  }
  child.stdin.write(chunk);
});
process.stdin.once('end', () => child.stdin.end());
const ownerWatch = setInterval(() => { if (process.ppid !== ownerPid) stopChild(); }, 250);
ownerWatch.unref();
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk); output += chunk.toString('utf8');
  let newline;
  while ((newline = output.indexOf('\n')) !== -1) {
    const line = output.slice(0, newline); output = output.slice(newline + 1);
    try { observeResponse(JSON.parse(line)); } catch {}
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.once('close', async (code) => { await publication; await publish(); process.exitCode = code ?? 1; process.exit(); });
process.once('SIGTERM', stopChild);
