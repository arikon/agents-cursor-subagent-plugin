#!/usr/bin/env node

// Test-only loopback responder. Incoming model context is consumed in memory
// solely to recover opaque public IDs from tool output; it is never logged,
// persisted, returned, or included in an error message.
import { createServer } from 'node:http';
import { rename, writeFile } from 'node:fs/promises';

const port = Number(process.env.CURSOR_EVAL_PROVIDER_PORT || '0');
const state = { requests: 0, tool_sequence: [], declared_tool_names: [], declared_tool_types: [], request_trace: [], rejected_requests: [], skill_context_seen: false, terminal_result_matched: false };

async function publishSafeState() {
  if (process.env.CURSOR_EVAL_PROVIDER_EVIDENCE) {
    const destination = process.env.CURSOR_EVAL_PROVIDER_EVIDENCE;
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({
      provider_request_seen: state.requests > 0, requests: state.requests, tool_sequence: state.tool_sequence, declared_tool_names: state.declared_tool_names,
      declared_tool_types: state.declared_tool_types,
      request_trace: state.request_trace, rejected_requests: state.rejected_requests,
      skill_context_seen: state.skill_context_seen, terminal_result_matched: state.terminal_result_matched,
    }), 'utf8');
    await rename(temporary, destination);
  }
}

function sendJson(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function findOpaqueIds(value) {
  if (typeof value === 'string') {
    try { return findOpaqueIds(JSON.parse(value)); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.session_id === 'string' && typeof value.turn_id === 'string') {
    return { session_id: value.session_id, turn_id: value.turn_id };
  }
  for (const child of Object.values(value)) {
    const found = findOpaqueIds(child);
    if (found) return found;
  }
  return null;
}

function findOpaqueIdsInText(value) {
  if (typeof value === 'string') {
    const session = /["\\]session_id["\\]\s*:\s*["\\]([^"\\]+)["\\]/.exec(value);
    const turn = /["\\]turn_id["\\]\s*:\s*["\\]([^"\\]+)["\\]/.exec(value);
    return session && turn ? { session_id: session[1], turn_id: turn[1] } : null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const child of Object.values(value)) {
    const found = findOpaqueIdsInText(child);
    if (found) return found;
  }
  return null;
}

function findExposedToolName(value, suffix) {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findExposedToolName(item, suffix); if (found) return found; }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.name === 'string' && (value.name === suffix || value.name.endsWith(`__${suffix}`))) return value.name;
  for (const child of Object.values(value)) { const found = findExposedToolName(child, suffix); if (found) return found; }
  return null;
}

function findExposedToolNamespace(value, suffix) {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findExposedToolNamespace(item, suffix); if (found) return found; }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'namespace' && typeof value.name === 'string' && Array.isArray(value.tools)
    && value.tools.some((tool) => typeof tool?.name === 'string' && (tool.name === suffix || tool.name.endsWith(`__${suffix}`)))) return value.name;
  for (const child of Object.values(value)) { const found = findExposedToolNamespace(child, suffix); if (found) return found; }
  return null;
}

function declaredToolNames(value) {
  if (!Array.isArray(value?.tools)) return [];
  return value.tools.filter((tool) => tool?.type === 'function' && typeof tool.name === 'string').map(({ name }) => name);
}

function toolCall(name, args, index) {
  const item = { type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name,
    arguments: JSON.stringify(args), status: 'completed' };
  const response = { id: `resp_${index}`, object: 'response', created_at: 0, status: 'completed',
    model: 'qwen2.5-coder:7b', output: [item], error: null, incomplete_details: null };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments, sequence_number: 1 },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, name, arguments: item.arguments, sequence_number: 2 },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
}

function namespacedToolCall(namespace, name, args, index) {
  const events = toolCall(name, args, index);
  for (const event of events) {
    if (event.item) event.item.namespace = namespace;
    if (event.response?.output?.[0]) event.response.output[0].namespace = namespace;
    // Codex resolves an MCP tool namespace from the completed argument event.
    // Keeping it only on the output item loses that binding on app-server 0.152.
    if (event.type === 'response.function_call_arguments.done') event.namespace = namespace;
  }
  return events;
}

function toolSearchCall(query, index) {
  const item = { type: 'tool_search_call', id: `tsc_${index}`, call_id: `call_${index}`,
    status: 'completed', execution: 'client', arguments: { query, limit: 10 } };
  const response = { id: `resp_${index}`, object: 'response', created_at: 0, status: 'completed',
    model: 'qwen2.5-coder:7b', output: [item], error: null, incomplete_details: null };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
}

function finalText(index) {
  const item = { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'CURSOR_EVAL_OK', annotations: [] }] };
  const response = { id: `resp_${index}`, object: 'response', created_at: 0, status: 'completed',
    model: 'qwen2.5-coder:7b', output: [item], error: null, incomplete_details: null };
  return [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'CURSOR_EVAL_OK', sequence_number: 1 },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'CURSOR_EVAL_OK', sequence_number: 2 },
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') return sendJson(response, { object: 'list', data: [{ id: 'qwen2.5-coder:7b', object: 'model', created: 0, owned_by: 'local' }] });
  if (request.method === 'GET' && request.url === '/api/version') return sendJson(response, { version: '0.13.4' });
  if (request.method === 'GET' && request.url === '/api/tags') return sendJson(response, { models: [{ name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b' }] });
  if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404); return response.end(); }
  let body;
  try { body = await readBody(request); } catch { response.writeHead(400); return response.end(); }
  state.requests += 1;
  if (state.requests === 1 && Number.isInteger(Number(process.env.CURSOR_EVAL_FIRST_RESPONSE_DELAY_MS))) {
    await wait(Number(process.env.CURSOR_EVAL_FIRST_RESPONSE_DELAY_MS));
  }
  const serialized = JSON.stringify(body);
  state.declared_tool_names = declaredToolNames(body);
  state.declared_tool_types = Array.isArray(body?.tools) ? body.tools.map(({ type }) => type) : [];
  const warmup = process.env.CURSOR_EVAL_WARMUP === '1';
  if (warmup && state.requests === 1) {
    state.skill_context_seen = Boolean(process.env.CURSOR_EVAL_SKILL_SENTINEL && serialized.includes(process.env.CURSOR_EVAL_SKILL_SENTINEL));
    state.tool_sequence.push('warmup');
    await publishSafeState();
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of finalText(state.requests)) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return response.end();
  }
  const protocolStep = state.requests - (warmup ? 1 : 0);
  const deferred = process.env.CURSOR_EVAL_DEFERRED_TOOL_SEARCH === '1';
  // The warmup turn is the only request guaranteed to include the explicit
  // skill text on app-server 0.152. Preserve that observed proof for the
  // following model turn instead of treating its compacted context as absent.
  if (protocolStep === 1) state.skill_context_seen ||= Boolean(process.env.CURSOR_EVAL_SKILL_SENTINEL && serialized.includes(process.env.CURSOR_EVAL_SKILL_SENTINEL));
  if (protocolStep === (deferred ? 5 : 3)) state.terminal_result_matched = serialized.includes('CURSOR_EVAL_OK');
  const ids = findOpaqueIds(body) || findOpaqueIdsInText(body);
  const delegate = findExposedToolName(body, 'cursor_delegate');
  const wait = findExposedToolName(body, 'cursor_wait');
  const close = findExposedToolName(body, 'cursor_close_session');
  const delegateNamespace = findExposedToolNamespace(body, 'cursor_delegate');
  const waitNamespace = findExposedToolNamespace(body, 'cursor_wait');
  const closeNamespace = findExposedToolNamespace(body, 'cursor_close_session');
  let events;
  if (deferred && protocolStep === 1 && state.skill_context_seen && body.tools?.some(({ type }) => type === 'tool_search')) {
    events = toolSearchCall('delegate task to Cursor', state.requests);
  } else if (protocolStep === (deferred ? 2 : 1) && delegate) {
    const args = { cwd: process.env.CURSOR_EVAL_WORKSPACE, mode: 'ask', prompt: 'Return CURSOR_EVAL_OK.' };
    events = delegateNamespace ? namespacedToolCall(delegateNamespace, delegate, args, state.requests) : toolCall(delegate, args, state.requests);
  } else if (deferred && protocolStep === 3 && ids && body.tools?.some(({ type }) => type === 'tool_search')) {
    events = toolSearchCall('wait for delegated Cursor turn terminal result', state.requests);
  } else if (protocolStep === (deferred ? 4 : 2) && ids && wait) {
    const args = { ...ids, after_event_id: 0, timeout_ms: 1000 };
    events = waitNamespace ? namespacedToolCall(waitNamespace, wait, args, state.requests) : toolCall(wait, args, state.requests);
  } else if (deferred && protocolStep === 5 && ids && body.tools?.some(({ type }) => type === 'tool_search')) {
    events = toolSearchCall('close Cursor session', state.requests);
  } else if (protocolStep === (deferred ? 6 : 3) && ids && close) {
    const args = { session_id: ids.session_id };
    events = closeNamespace ? namespacedToolCall(closeNamespace, close, args, state.requests) : toolCall(close, args, state.requests);
  } else if (protocolStep === (deferred ? 7 : 4) && state.terminal_result_matched) events = finalText(state.requests);
  else {
    state.rejected_requests.push({ step: protocolStep, has_ids: Boolean(ids), has_tool_search: Boolean(body.tools?.some(({ type }) => type === 'tool_search')),
      has_delegate: Boolean(delegate), has_wait: Boolean(wait), has_close: Boolean(close), skill_context_seen: state.skill_context_seen });
    await publishSafeState(); response.writeHead(422); return response.end();
  }
  const emitted = events[1].item;
  const emittedTool = emitted?.type === 'tool_search_call' ? 'tool_search' : emitted?.name || 'final';
  state.tool_sequence.push(emittedTool);
  state.request_trace.push({ step: protocolStep, tool: emittedTool, call_id: emitted?.call_id ?? null });
  await publishSafeState();
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port, provider_request_seen: true })}\n`));
const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop); process.once('SIGINT', stop);
