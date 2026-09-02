#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sessions = new Map();
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MAX_EVENTS = 100;
const DEFAULT_STATUS_CHARS = 1_500;
const MAX_STATUS_CHARS = 8_000;
function cursorAgentCommand() {
  if (process.env.CURSOR_AGENT_COMMAND) return process.env.CURSOR_AGENT_COMMAND;
  const userInstall = join(homedir(), '.local', 'bin', 'agent');
  return existsSync(userInstall) ? userInstall : 'agent';
}

function json(value) {
  return JSON.stringify(value);
}

function write(message) {
  process.stdout.write(`${json(message)}\n`);
}

function toolResult(value, isError = false) {
  return { content: [{ type: 'text', text: json(value) }], isError };
}

function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}…`, truncated: true };
}

function compactValue(value, maxChars) {
  if (value === null || value === undefined) return value;
  const encoded = json(value);
  if (encoded.length <= maxChars) return value;
  return { preview: truncateText(encoded, maxChars).text, truncated: true };
}

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const tools = [
  {
    name: 'cursor_start_session',
    description: 'Запускает cursor-agent в ACP-режиме и создаёт интерактивную сессию.',
    inputSchema: schema({
      cwd: { type: 'string', description: 'Рабочая директория Cursor; по умолчанию текущая.' },
      mode: { type: 'string', enum: ['agent', 'plan', 'ask'], description: 'Режим Cursor; по умолчанию ask, без записи и команд.' },
    }),
  },
  {
    name: 'cursor_send_prompt',
    description: 'Асинхронно передаёт задачу Cursor. Статус, вопросы и итог читаются cursor_session_status.',
    inputSchema: schema({
      session_id: { type: 'string' },
      prompt: { type: 'string', minLength: 1 },
    }, ['session_id', 'prompt']),
  },
  {
    name: 'cursor_session_status',
    description: 'Возвращает компактную сводку сессии. Полный trace запрашивай только с detail=full.',
    inputSchema: schema({
      session_id: { type: 'string' },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'По умолчанию summary.' },
      max_chars: { type: 'integer', minimum: 100, maximum: MAX_STATUS_CHARS, description: `Лимит текста ответа в summary; по умолчанию ${DEFAULT_STATUS_CHARS}.` },
    }, ['session_id']),
  },
  {
    name: 'cursor_answer_question',
    description: 'Отвечает на cursor/ask_question. selected_option_ids берутся из cursor_session_status.',
    inputSchema: schema({
      session_id: { type: 'string' },
      request_id: { type: 'string' },
      answers: { type: 'array', items: schema({ question_id: { type: 'string' }, selected_option_ids: { type: 'array', items: { type: 'string' } } }, ['question_id', 'selected_option_ids']) },
      outcome: { type: 'string', enum: ['answered', 'skipped', 'cancelled'], description: 'По умолчанию answered.' },
      reason: { type: 'string' },
    }, ['session_id', 'request_id']),
  },
  {
    name: 'cursor_answer_plan',
    description: 'Принимает или отклоняет план, запрошенный Cursor.',
    inputSchema: schema({
      session_id: { type: 'string' },
      request_id: { type: 'string' },
      accept: { type: 'boolean' },
      reason: { type: 'string' },
    }, ['session_id', 'request_id', 'accept']),
  },
  {
    name: 'cursor_answer_permission',
    description: 'Разрешает или отклоняет один запрос Cursor на выполнение инструмента.',
    inputSchema: schema({
      session_id: { type: 'string' },
      request_id: { type: 'string' },
      decision: { type: 'string', enum: ['allow-once', 'allow-always', 'reject-once'] },
    }, ['session_id', 'request_id', 'decision']),
  },
  {
    name: 'cursor_cancel',
    description: 'Запрашивает остановку текущего хода Cursor.',
    inputSchema: schema({ session_id: { type: 'string' } }, ['session_id']),
  },
  {
    name: 'cursor_close_session',
    description: 'Завершает процесс Cursor ACP и освобождает сессию.',
    inputSchema: schema({ session_id: { type: 'string' } }, ['session_id']),
  },
];

class CursorSession {
  constructor({ cwd, mode }) {
    this.id = randomUUID();
    this.cwd = cwd || process.cwd();
    this.mode = mode || 'ask';
    this.nextId = 1;
    this.waiters = new Map();
    this.pending = { questions: new Map(), plans: new Map(), permissions: new Map() };
    this.events = [];
    this.state = 'starting';
    this.activeTurn = null;
    this.lastResult = null;
    this.agentText = '';
    this.ready = null;
    this.child = spawn(cursorAgentCommand(), ['acp'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => this.event('stderr', line));
    this.child.once('exit', (code, signal) => {
      this.state = 'closed';
      this.event('exit', { code, signal });
      for (const { reject } of this.waiters.values()) reject(new Error(`Cursor ACP завершился: code=${code}, signal=${signal}`));
      this.waiters.clear();
    });
  }

  event(type, payload) {
    this.events.push({ at: new Date().toISOString(), type, payload });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.event('invalid_stdout', line); return; }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const waiter = this.waiters.get(String(message.id));
      if (!waiter) { this.event('unmatched_response', message); return; }
      this.waiters.delete(String(message.id));
      if (message.error) waiter.reject(new Error(message.error.message || json(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) this.handleServerMessage(message);
  }

  handleServerMessage(message) {
    const requestId = String(message.id ?? randomUUID());
    if (message.method === 'session/update') {
      const update = message.params?.update;
      const content = update?.content?.text ?? message.params?.content?.text;
      if (typeof content === 'string') this.agentText = `${this.agentText}${content}`.slice(-MAX_STATUS_CHARS);
      this.event('update', content ? { ...update, text: content } : update ?? message.params);
      return;
    }
    if (message.method === 'cursor/ask_question') {
      this.pending.questions.set(requestId, message);
      this.state = 'waiting_for_question';
      this.event('question', { request_id: requestId, ...message.params });
      return;
    }
    if (message.method === 'cursor/create_plan') {
      this.pending.plans.set(requestId, message);
      this.state = 'waiting_for_plan';
      this.event('plan', { request_id: requestId, ...message.params });
      return;
    }
    if (message.method === 'session/request_permission') {
      this.pending.permissions.set(requestId, message);
      this.state = 'waiting_for_permission';
      this.event('permission', { request_id: requestId, ...message.params });
      return;
    }
    this.event('notification', { method: message.method, params: message.params });
    if (message.id !== undefined) this.respond(message.id, {});
  }

  send(message) {
    if (this.child.killed || this.state === 'closed') throw new Error('Сессия Cursor закрыта.');
    this.child.stdin.write(`${json(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.waiters.set(String(id), { resolve, reject }));
    this.send({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    this.send({ jsonrpc: '2.0', id: Number.isNaN(Number(id)) ? id : Number(id), result });
  }

  async initialise() {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'codex-cursor-subagent-plugin', version: '0.1.0' },
    });
    await this.request('authenticate', { methodId: 'cursor_login' });
    const created = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.cursorSessionId = created.sessionId;
    this.configOptions = created.configOptions || [];
    const currentMode = this.configOptions.find((option) => option.id === 'mode')?.currentValue;
    if (currentMode && currentMode !== this.mode) {
      const configured = await this.request('session/set_config_option', {
        sessionId: this.cursorSessionId,
        configId: 'mode',
        value: this.mode,
      });
      this.configOptions = configured.configOptions || this.configOptions;
    }
    this.state = 'idle';
    this.event('ready', { cursor_session_id: this.cursorSessionId });
  }

  start() {
    if (this.ready) return;
    this.ready = this.initialise().catch((error) => {
      this.lastResult = { error: error.message };
      this.state = 'failed';
      this.event('initialisation_failed', { message: error.message });
    });
  }

  prompt(text) {
    if (this.state === 'starting') throw new Error('Cursor ACP ещё инициализируется; опросите cursor_session_status и дождитесь состояния idle.');
    if (this.state === 'failed') throw new Error(this.lastResult?.error || 'Инициализация Cursor ACP завершилась ошибкой.');
    if (this.activeTurn) throw new Error('Cursor уже выполняет ход; получите статус или отмените его.');
    this.state = 'running';
    const turnId = randomUUID();
    this.activeTurn = this.request('session/prompt', { sessionId: this.cursorSessionId, prompt: [{ type: 'text', text }] });
    this.activeTurn.then((result) => {
      this.lastResult = result;
      if (!this.state.startsWith('waiting_')) this.state = 'idle';
      this.event('turn_finished', result);
    }).catch((error) => {
      this.lastResult = { error: error.message };
      this.state = 'failed';
      this.event('turn_failed', { message: error.message });
    }).finally(() => { this.activeTurn = null; });
    return turnId;
  }

  status({ detail = 'summary', max_chars: requestedMaxChars } = {}) {
    const serialise = (pending) => [...pending.entries()].map(([request_id, request]) => ({ request_id, ...request.params }));
    const pending = {
      questions: serialise(this.pending.questions),
      plans: serialise(this.pending.plans),
      permissions: serialise(this.pending.permissions),
    };
    if (detail === 'full') return {
      session_id: this.id,
      cursor_session_id: this.cursorSessionId,
      state: this.state,
      cwd: this.cwd,
      mode: this.mode,
      config_options: this.configOptions,
      pending,
      last_result: this.lastResult,
      events: this.events,
    };
    const maxChars = Math.min(Math.max(requestedMaxChars ?? DEFAULT_STATUS_CHARS, 100), MAX_STATUS_CHARS);
    const response = truncateText(this.agentText, maxChars);
    return {
      session_id: this.id,
      state: this.state,
      mode: this.mode,
      pending,
      response: response.text || undefined,
      response_truncated: response.truncated || undefined,
      last_result: compactValue(this.lastResult, maxChars),
      detail: 'summary',
      hint: 'Для полного протокольного trace вызови cursor_session_status с detail="full".',
    };
  }

  answer(kind, requestId, result) {
    const pending = this.pending[kind];
    const request = pending.get(requestId);
    if (!request) throw new Error(`Не найден ожидающий ${kind} запрос ${requestId}.`);
    pending.delete(requestId);
    this.respond(request.id, result);
    this.state = 'running';
  }

  async cancel() {
    this.notify('session/cancel', { sessionId: this.cursorSessionId });
    this.event('cancel_requested', {});
  }

  close() {
    this.child.kill('SIGTERM');
    this.state = 'closed';
  }
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Неизвестная сессия Cursor: ${id}`);
  return session;
}

async function callTool(name, args) {
  switch (name) {
    case 'cursor_start_session': {
      const session = new CursorSession(args);
      sessions.set(session.id, session);
      session.start();
      return { session_id: session.id, state: session.state, cwd: session.cwd, mode: session.mode };
    }
    case 'cursor_send_prompt': {
      const session = getSession(args.session_id);
      return { session_id: session.id, turn_id: session.prompt(args.prompt), state: session.state };
    }
    case 'cursor_session_status': return getSession(args.session_id).status(args);
    case 'cursor_answer_question': {
      const outcome = args.outcome || 'answered';
      const result = outcome === 'answered'
        ? { outcome, answers: (args.answers || []).map(({ question_id, selected_option_ids }) => ({ questionId: question_id, selectedOptionIds: selected_option_ids })) }
        : { outcome, ...(args.reason ? { reason: args.reason } : {}) };
      const session = getSession(args.session_id);
      session.answer('questions', args.request_id, result);
      return { session_id: session.id, state: session.state };
    }
    case 'cursor_answer_plan': {
      const session = getSession(args.session_id);
      session.answer('plans', args.request_id, args.accept ? { outcome: 'accepted' } : { outcome: 'rejected', ...(args.reason ? { reason: args.reason } : {}) });
      return { session_id: session.id, state: session.state };
    }
    case 'cursor_answer_permission': {
      const session = getSession(args.session_id);
      session.answer('permissions', args.request_id, { outcome: { outcome: 'selected', optionId: args.decision } });
      return { session_id: session.id, state: session.state };
    }
    case 'cursor_cancel': {
      const session = getSession(args.session_id);
      await session.cancel();
      return { session_id: session.id, state: session.state };
    }
    case 'cursor_close_session': {
      const session = getSession(args.session_id);
      session.close();
      sessions.delete(session.id);
      return { session_id: args.session_id, state: 'closed' };
    }
    default: throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request.method) return;
  if (request.method === 'notifications/initialized') return;
  try {
    let result;
    if (request.method === 'initialize') result = {
      protocolVersion: request.params?.protocolVersion || MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'cursor-subagent', version: '0.1.0' },
    };
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'resources/list') result = { resources: [] };
    else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else if (request.method === 'prompts/list') result = { prompts: [] };
    else if (request.method === 'tools/call') result = toolResult(await callTool(request.params?.name, request.params?.arguments || {}));
    else throw new Error(`Метод MCP не поддерживается: ${request.method}`);
    if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, result: toolResult({ error: error.message }, true) });
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const session of sessions.values()) session.close();
  process.exit(0);
});
