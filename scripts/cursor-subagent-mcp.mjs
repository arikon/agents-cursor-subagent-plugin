#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// Runtime-owned, fixed bounds. They deliberately are not operator settings.
export const LIMITS = Object.freeze({ initMs: 15_000, turnMs: 3_600_000, idleMs: 900_000,
  waitDefaultMs: 30_000, waitMinMs: 1_000, waitMaxMs: 180_000, live: 8, pending: 8,
  waiters: 8, tombstones: 64, events: 256, graceMs: 5_000, retentionMs: 300_000,
  inputBytes: 64_000, textBytes: 8_000, progressBytes: 512, fsBytes: 1_048_576,
  resultBytes: 1_048_576, resultPageBytes: 8_000, frameBytes: 1_048_576 });
const MCP_VERSION = '2024-11-05';
const ADMITTED_TASK_SUBAGENT_TYPES = new Set(['computer_use', 'explore', 'video_review', 'browser_use', 'shell', 'vm_setup_helper', 'unspecified']);
const opaqueId = () => randomBytes(16).toString('base64url');

export class DomainError extends Error {
  constructor(error_code, message, extras = {}) { super(message); this.error_code = error_code; Object.assign(this, extras); }
}
const fail = (code, message, extras = {}) => { throw new DomainError(code, message, extras); };
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const validText = (value) => typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value;
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const decoder = new TextDecoder('utf-8', { fatal: true });
function bounded(value, limit = LIMITS.textBytes) {
  const source = Buffer.from(String(value ?? ''), 'utf8').toString('utf8');
  if (bytes(source) <= limit) return { text: source, truncated: false };
  const suffix = '…';
  const contentLimit = limit - bytes(suffix);
  let text = '';
  let textBytes = 0;
  for (const character of source) {
    const characterBytes = bytes(character);
    if (textBytes + characterBytes > contentLimit) break;
    text += character;
    textBytes += characterBytes;
  }
  return { text: `${text}${suffix}`, truncated: true };
}
function providerError(error) {
  if (!error || Array.isArray(error) || typeof error !== 'object'
    || !Number.isSafeInteger(error.code)) return new DomainError('protocol_error', 'invalid ACP provider error');
  const message = typeof error.message === 'string' && validText(error.message) && error.message
    ? bounded(error.message) : bounded('ACP provider error');
  return new DomainError('protocol_error', 'ACP provider error', {
    provider_error: { code: error.code, message },
  });
}
const hasProviderError = (error) => error instanceof DomainError && Boolean(error.provider_error);
function assertObject(value, keys, required) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid_args', 'arguments must be an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('invalid_args', `unknown argument: ${key}`);
  for (const key of required) if (!(key in value)) fail('invalid_args', `missing argument: ${key}`);
}
function assertAggregate(value) {
  let encoded; try { encoded = JSON.stringify(value); } catch { fail('invalid_args', 'arguments must be JSON-serializable'); }
  if (encoded !== undefined && bytes(encoded) > LIMITS.inputBytes) fail('invalid_args', 'aggregate arguments limit exceeded');
}
function text(value, field) {
  if (typeof value !== 'string' || !value || bytes(value) > LIMITS.inputBytes) fail('invalid_args', `invalid ${field}`);
  if (!validText(value)) fail('invalid_text_encoding', `invalid UTF-8 ${field}`);
  return value;
}
function inside(path, root) { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }
function readRoots(env) {
  const raw = env.CURSOR_SUBAGENT_ALLOWED_ROOTS;
  if (raw === undefined || raw === '') return null;
  let roots; try { roots = JSON.parse(raw); } catch { throw new Error('CURSOR_SUBAGENT_ALLOWED_ROOTS must be a JSON array'); }
  if (!Array.isArray(roots)) throw new Error('CURSOR_SUBAGENT_ALLOWED_ROOTS must be a JSON array');
  return [...new Set(roots.map((root) => {
    if (!validText(root) || !root || !isAbsolute(root)) throw new Error('allowed root must be absolute');
    const canonical = realpathSync(root); if (!lstatSync(canonical).isDirectory()) throw new Error('allowed root must be a directory');
    return canonical;
  }))];
}
const cursorCommand = (env) => env.CURSOR_AGENT_COMMAND || 'cursor-agent';
function cursorArgs(env, launch = DEFAULT_LAUNCH) {
  const modelArgv = ADAPTER.modelArgv(launch);
  const pluginArgv = ADAPTER.pluginArgv(launch.plugin_dirs);
  if (!env.CURSOR_SUBAGENT_ADAPTER_ARGS) return ADAPTER.sessionArgv(modelArgv, pluginArgv);
  try {
    const args = JSON.parse(env.CURSOR_SUBAGENT_ADAPTER_ARGS);
    if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) throw new Error();
    return [...args, ...ADAPTER.fixturePolicyArgv, ...modelArgv, ...pluginArgv];
  } catch { throw new Error('invalid adapter fixture arguments'); }
}
function cursorVersionArgs(env) {
  if (!env.CURSOR_SUBAGENT_ADAPTER_ARGS) return ['--version'];
  try {
    const args = JSON.parse(env.CURSOR_SUBAGENT_ADAPTER_ARGS);
    if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) throw new Error();
    return [...args, '--version'];
  } catch { throw new Error('invalid adapter fixture arguments'); }
}

function manifestVersion() {
  const manifest = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  if (!validText(manifest?.version) || !/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('plugin manifest has no valid version');
  return manifest.version.replace(/\+codex\.[\da-f]+$/, '');
}
export const MANIFEST_VERSION = manifestVersion();

// Version-specific ACP wire adapter. Product tools never expose these forms.
export const CURSOR_ADAPTER_VERSION = '2026.08.25-3e8eec8';
const DEFAULT_MODEL = Object.freeze({ model: 'auto', effort: null, fast: null });
const DEFAULT_LAUNCH = Object.freeze({ ...DEFAULT_MODEL, plugin_dirs: [] });
const admittedModeState = (result) => {
  const current = result?.modes?.currentModeId;
  const available = result?.modes?.availableModes;
  return ['ask', 'plan', 'agent'].includes(current)
    && Array.isArray(available)
    && ['ask', 'plan', 'agent'].every((mode) => available.some((entry) => entry?.id === mode));
};
export const ADAPTER = Object.freeze({
  cursorVersion: CURSOR_ADAPTER_VERSION,
  fixturePolicyArgv: ['--auto-review', '--sandbox', 'enabled'],
  modelArgv: ({ model, effort, fast }) => {
    const parameters = [
      ...(effort == null ? [] : [`effort=${effort}`]),
      ...(fast == null ? [] : [`fast=${fast}`]),
    ];
    return ['--model', parameters.length ? `${model}[${parameters.join(',')}]` : model];
  },
  pluginArgv: (roots) => roots.flatMap((root) => ['--plugin-dir', root]),
  sessionArgv: (modelArgv, pluginArgv = []) => ['--auto-review', '--sandbox', 'enabled', ...modelArgv, ...pluginArgv, 'acp'],
  initialize: () => ({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'agents-cursor-subagent-plugin', version: MANIFEST_VERSION } }),
  methods: { auth: 'authenticate', sessionNew: 'session/new', sessionLoad: 'session/load', setMode: 'session/set_mode', prompt: 'session/prompt', cancel: 'session/cancel', todos: 'cursor/update_todos', task: 'cursor/task', image: 'cursor/generate_image', read: 'fs/read_text_file', write: 'fs/write_text_file' },
  loadParams: (sessionId, cwd) => ({ sessionId, cwd, mcpServers: [] }),
  admitModeState: admittedModeState,
  admitLoadResult: (result) => !Object.hasOwn(result || {}, 'sessionId') && admittedModeState(result),
  admitSetModeResult: (result) => result === undefined || (result && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0),
  admitTodos(params) {
    if (!params || Array.isArray(params) || typeof params !== 'object') return null;
    if (!exactKeys(params, ['toolCallId', 'todos', 'merge'])
      || !validText(params.toolCallId) || !params.toolCallId) return null;
    if (typeof params.merge !== 'boolean') return null;
    if (!Array.isArray(params.todos) || params.todos.length === 0) return null;
    const seen = new Set();
    const todos = [];
    for (const item of params.todos) {
      if (!item || Array.isArray(item) || typeof item !== 'object') return null;
      if (!exactKeys(item, ['id', 'content', 'status'])) return null;
      if (!validText(item.id) || !item.id || seen.has(item.id)) return null;
      seen.add(item.id);
      if (typeof item.content !== 'string' || !validText(item.content)) return null;
      if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status)) return null;
      todos.push({ id: item.id, content: bounded(item.content), status: item.status });
    }
    return { merge: params.merge === true, todos };
  },
  admitTask(params) {
    if (!params || Array.isArray(params) || typeof params !== 'object') return null;
    if (!exactKeys(params, ['toolCallId', 'description', 'prompt', 'subagentType', 'model', 'agentId', 'durationMs'])
      || !validText(params.toolCallId) || !params.toolCallId) return null;
    const description = params.description;
    if (typeof description !== 'string' || !validText(description)) return null;
    if (typeof params.prompt !== 'string' || !validText(params.prompt)) return null;
    const rawType = params.subagentType;
    const customType = rawType && !Array.isArray(rawType) && typeof rawType === 'object'
      && Object.keys(rawType).length === 1 ? rawType.custom : undefined;
    const type = typeof rawType === 'string' && ADMITTED_TASK_SUBAGENT_TYPES.has(rawType) ? rawType : customType;
    if (type !== undefined && (!validText(type) || !type)) return null;
    if (rawType === undefined || type === undefined) return null;
    const model = params.model;
    if (model !== undefined && (typeof model !== 'string' || !validText(model))) return null;
    if (params.agentId !== undefined && (typeof params.agentId !== 'string' || !validText(params.agentId))) return null;
    const duration = params.durationMs;
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) return null;
    return {
      description: bounded(description),
      ...(type !== undefined ? { type: bounded(type) } : {}),
      ...(model !== undefined ? { model: bounded(model) } : {}),
      ...(duration !== undefined ? { duration } : {}),
    };
  },
  admitImage(params) {
    if (!params || Array.isArray(params) || typeof params !== 'object') return null;
    if (!exactKeys(params, ['toolCallId', 'description', 'filePath', 'referenceImagePaths'])
      || !validText(params.toolCallId) || !params.toolCallId) return null;
    const description = params.description;
    const path = params.filePath;
    if (typeof description !== 'string' || !validText(description)) return null;
    if (path !== undefined && (typeof path !== 'string' || !validText(path) || !path)) return null;
    if (params.referenceImagePaths !== undefined && (!Array.isArray(params.referenceImagePaths)
      || !params.referenceImagePaths.every((value) => typeof value === 'string' && validText(value)))) return null;
    if (!description && path === undefined) return null;
    return {
      ...(description ? { description: bounded(description) } : {}),
      ...(path !== undefined ? { path: bounded(path) } : {}),
    };
  },
  admitInitialize: (result) => result?.protocolVersion === 1
    && Array.isArray(result.authMethods)
    && result.authMethods.some((method) => method?.id === 'cursor_login')
    && result.agentCapabilities?.loadSession === true,
  permissionChoices(options) {
    if (!Array.isArray(options)) return null;
    const bySemantic = new Map();
    for (const option of options) {
      if (!option || !validText(option.optionId) || !option.optionId || !validText(option.name ?? option.label ?? '')) return null;
      const semantic = option.kind === 'allow_once' ? 'allow-once' : option.kind === 'reject_once' ? 'reject-once' : null;
      if (semantic && bySemantic.has(semantic)) return null;
      if (semantic) bySemantic.set(semantic, { id: option.optionId, label: bounded(option.name ?? option.label ?? '') });
    }
    return bySemantic.size === 2 ? bySemantic : null;
  },
  questionResponse: (outcome, answers = []) => ({ outcome: {
    outcome,
    ...(outcome === 'answered' ? { answers: answers.map((answer) => ({ questionId: answer.question_id, selectedOptionIds: answer.selected_option_ids })) } : {}),
  } }),
  planResponse: (decision) => ({ outcome: { outcome: decision === 'accept' ? 'accepted' : 'rejected' } }),
  permissionResponse: (optionId) => ({ outcome: { outcome: 'selected', optionId } }),
  cancelResponse: () => ({ outcome: { outcome: 'cancelled' } }),
  admitPromptResult: (result) => result && !Array.isArray(result) && typeof result === 'object'
    && ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(result.stopReason),
});

function normalizePending(kind, params = {}) {
  if (kind === 'question') {
    if (!Array.isArray(params.questions) || !params.questions.length) throw new Error('questions required');
    const questionIds = new Set();
    const questions = params.questions.map((question) => {
      const id = derivedId(question?.id); if (questionIds.has(id)) throw new Error('duplicate question'); questionIds.add(id);
      if (!Array.isArray(question.options) || !question.options.length) throw new Error('options required');
      if (question.allowMultiple !== undefined && typeof question.allowMultiple !== 'boolean') throw new Error('invalid question multiplicity');
      const optionIds = new Set();
      const options = question.options.map((option) => { const optionId = derivedId(option?.id); if (optionIds.has(optionId)) throw new Error('duplicate option'); optionIds.add(optionId); return { id: optionId, label: derivedText(option.label || '') }; });
      return { id, prompt: derivedText(question.question || question.prompt || ''), options, allow_multiple: Boolean(question.allowMultiple) };
    });
    return { title: params.title ? derivedText(params.title) : null, questions };
  }
  if (kind === 'plan') return { title: params.name ? derivedText(params.name) : null, body: derivedText(params.plan || params.body || '') };
  const toolCall = params.toolCall;
  if (toolCall.locations !== undefined && !Array.isArray(toolCall.locations)) throw new Error('invalid locations');
  const locations = (toolCall.locations || []).map((location) => {
    if (!location || typeof location.path !== 'string' || (location.line !== undefined && (!Number.isSafeInteger(location.line) || location.line < 1))) throw new Error('invalid location');
    return { path: derivedText(location.path), ...(location.line !== undefined ? { line: location.line } : {}) };
  });
  return { title: derivedText(toolCall.title || 'Permission request'), tool_kind: toolCall.kind ? derivedText(toolCall.kind) : null, choices: ['allow-once', 'reject-once'], ...(locations.length ? { locations } : {}) };
}
function derivedId(value) { if (!validText(value) || !value || bytes(value) > LIMITS.inputBytes) throw new Error('invalid opaque id'); return value; }
function derivedText(value) { if (!validText(value)) throw new Error('invalid UTF-8 text'); return bounded(value); }
function admitModelParams(args) {
  const model = args.model === undefined ? 'auto' : text(args.model, 'model');
  const effort = args.effort === undefined ? null : text(args.effort, 'effort');
  const fast = args.fast === undefined ? null : typeof args.fast === 'boolean' ? args.fast : fail('invalid_args', 'invalid fast');
  if (effort !== null && !/^[A-Za-z0-9._-]+$/.test(effort)) fail('invalid_args', 'invalid effort token');
  if (/[\[\]]/.test(model)) fail('invalid_args', 'model must not contain parameter brackets');
  return { model, effort, fast };
}
function admitLaunchParams(args, canonicalPluginDir) {
  if (args.plugin_dirs === undefined) return { ...admitModelParams(args), plugin_dirs: [] };
  if (!Array.isArray(args.plugin_dirs) || !args.plugin_dirs.length) fail('invalid_args', 'plugin_dirs must be a nonempty array');
  const plugin_dirs = [];
  for (const root of args.plugin_dirs) {
    const canonical = canonicalPluginDir(root);
    if (!plugin_dirs.includes(canonical)) plugin_dirs.push(canonical);
  }
  return { ...admitModelParams(args), plugin_dirs };
}
function captureTerminalReceipt(session, turn) {
  turn.terminal_receipt = {
    session_id: session.id, turn_id: turn.turn_id, turn_status: turn.turn_status, last_event_id: session.nextEvent - 1,
    result_sha256: turn.result == null ? null : createHash('sha256').update(turn.result.text, 'utf8').digest('hex'),
    result_truncated: Boolean(turn.result?.truncated),
  };
  return turn.terminal_receipt;
}
function terminalReceipt(_session, turn) {
  return turn?.terminal_receipt ?? undefined;
}
const MODEL_KEYS = ['model', 'effort', 'fast'];
const LAUNCH_KEYS = [...MODEL_KEYS, 'plugin_dirs'];

class SessionRecord {
  constructor(runtime, cwd, mode, launch = DEFAULT_LAUNCH) {
    this.runtime = runtime; this.id = opaqueId(); this.cwd = cwd; this.mode = mode;
    this.model = launch.model; this.effort = launch.effort; this.fast = launch.fast;
    this.plugin_dirs = launch.plugin_dirs;
    this.run_mode = 'auto_review'; this.sandbox = 'enabled'; this.session_state = 'starting';
    this.failure_kind = null; this.terminal_reason = null; this.active = null; this.last = null;
    this.provider_error = null;
    this.events = []; this.nextEvent = 1; this.waiters = new Set(); this.rpc = new Map(); this.rpcId = 1;
    this.child = null; this.shutdownPromise = null; this.tombstonedAt = null; this.idleTimer = null;
    this.admissionOpen = false; this.adapterCancelSent = false; this.modeTransition = false;
    this.cursor_session_id = null; this.resumeCursorSessionId = null;
    this.terminalWaitDelivered = false;
  }
  emit(kind, turn_id, payload) {
    const event = { event_id: this.nextEvent++, kind, turn_id, payload };
    this.events.push(event); if (this.events.length > LIMITS.events) this.events.shift(); this.wake(); return event;
  }
  sessionState(to) { const from = this.session_state; if (from === to) return; this.session_state = to; this.emit('lifecycle', null, { scope: 'session', from, to }); }
  turnState(turn, to) { const from = turn.turn_status; if (from === to) return; turn.turn_status = to; this.emit('lifecycle', turn.turn_id, { scope: 'turn', from, to }); }
  snapshot(turn) { return !turn ? null : { turn_id: turn.turn_id, turn_status: turn.turn_status, result: turn.result, terminal_reason: turn.terminal_reason, pending: [...turn.pending.values()].map((pending) => ({ request_id: pending.request_id, kind: pending.kind, context: pending.context })) }; }
  deliveredReceipt() { return this.last && this.terminalWaitDelivered ? terminalReceipt(this, this.last) : undefined; }
  envelope() {
    return {
      session_id: this.id, session_state: this.session_state, cwd: this.cwd, mode: this.mode,
      model: this.model, effort: this.effort, fast: this.fast,
      plugin_dirs: this.plugin_dirs,
      cursor_session_id: this.cursor_session_id, run_mode: this.run_mode, sandbox: this.sandbox,
      failure_kind: this.failure_kind, terminal_reason: this.terminal_reason, last_event_id: this.nextEvent - 1,
      ...(this.provider_error ? { provider_error: this.provider_error } : {}),
      active_turn: this.snapshot(this.active), last_terminal_turn: this.snapshot(this.last),
    };
  }
  actionEnvelope(turn = null, extra = {}) {
    const terminal = turn && ['completed', 'failed', 'timed_out', 'cancelled'].includes(turn.turn_status) ? terminalReceipt(this, turn) : this.deliveredReceipt();
    return {
      session_id: this.id,
      session_state: this.session_state,
      last_event_id: this.nextEvent - 1,
      ...(turn ? { turn_id: turn.turn_id, turn_status: turn.turn_status } : {}),
      ...(terminal ? { terminal_receipt: terminal } : {}),
      ...extra,
    };
  }
  waitEnvelope(turn, after, wait_timeout, after_progress_revision = 0) {
    const earliest = this.events.length ? this.events[0].event_id : null;
    const events_lost = Boolean(earliest && after < earliest - 1);
    const events = this.events.filter((event) => event.event_id > after && (event.turn_id === turn.turn_id || event.turn_id === null));
    const last_event_id = this.nextEvent - 1;
    const terminal = ['completed', 'failed', 'timed_out', 'cancelled'].includes(turn.turn_status);
    const deliverTerminal = terminal && this.last === turn && !this.terminalWaitDelivered;
    if (deliverTerminal) this.terminalWaitDelivered = true;
    const envelope = {
      session_id: this.id, turn_id: turn.turn_id, turn_status: turn.turn_status,
      session_state: this.session_state, last_event_id, resume_after_event_id: last_event_id,
      wait_timeout, events_lost,
    };
    if (events.length) envelope.events = events;
    if (events_lost) envelope.earliest_event_id = earliest;
    if (turn.pending.size) {
      envelope.pending = [...turn.pending.values()].map(({ request_id, kind, context }) => ({ request_id, kind, context }));
    }
    if (deliverTerminal) {
      if (turn.result) envelope.result = turn.result;
      if (turn.terminal_reason) envelope.terminal_reason = turn.terminal_reason;
      envelope.terminal_receipt = terminalReceipt(this, turn);
      if (this.provider_error) envelope.provider_error = this.provider_error;
    }
    if (wait_timeout) {
      const revision = turn.progress_revision || 0;
      if (revision > after_progress_revision) {
        envelope.progress_revision = revision;
        if (turn.progress_excerpt) envelope.progress_excerpt = turn.progress_excerpt;
      }
    }
    return envelope;
  }
  async start() {
    const initStartedAt = Date.now();
    try {
      this.installedCursorVersion = await this.withTimeout(this.probeCursorVersion(), LIMITS.initMs, 'init_timeout');
      this.child = spawn(cursorCommand(this.runtime.env), cursorArgs(this.runtime.env, {
        model: this.model, effort: this.effort, fast: this.fast, plugin_dirs: this.plugin_dirs,
      }), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.runtime.env });
      this.child.stderr.resume();
      this.child.stdin.on('error', () => this.transportFailure('child stdin EPIPE'));
      this.attachStdout();
      this.child.stdout.on('end', () => { if (!['closing', 'tombstone'].includes(this.session_state)) this.transportFailure('stdout EOF'); });
      this.child.on('error', () => this.transportFailure('child error', 'spawn'));
      this.child.once('exit', () => { this.childExited = true; if (!['closing', 'tombstone'].includes(this.session_state)) this.transportFailure('child exit'); });
      const remaining = Math.max(1, LIMITS.initMs - (Date.now() - initStartedAt));
      await this.withTimeout(this.initialize(), remaining, 'init_timeout');
      if (this.session_state === 'starting') { this.admissionOpen = true; this.sessionState('live'); this.armIdle(); }
    } catch (error) {
      if (this.session_state === 'starting') await this.initFailure(error);
      else if (this.shutdownPromise) await this.shutdownPromise;
    }
  }
  probeCursorVersion() {
    return new Promise((resolveVersion, reject) => {
      const child = spawn(cursorCommand(this.runtime.env), cursorVersionArgs(this.runtime.env), { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: this.runtime.env }); this.child = child;
      const chunks = []; let size = 0; let overflow = false;
      const collect = (chunk) => { size += chunk.length; if (size > LIMITS.inputBytes) overflow = true; else chunks.push(chunk); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.once('error', () => reject(new DomainError('spawn', 'Cursor version probe failed to spawn')));
      child.once('exit', (code) => {
        this.childExited = true;
        if (overflow) reject(new DomainError('init', 'Cursor version output limit'));
        else if (code !== 0) reject(new DomainError('init', 'Cursor version probe failed'));
        else {
          let version; try { version = decoder.decode(Buffer.concat(chunks)).trim(); } catch { reject(new DomainError('init', 'Cursor version is not UTF-8')); return; }
          resolveVersion(version);
        }
      });
    }).finally(() => { this.child = null; this.childExited = false; });
  }
  attachStdout() {
    let buffered = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        let frame = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
        if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
        if (frame.length > LIMITS.frameBytes) { this.transportFailure('ACP frame limit'); return; }
        let line; try { line = decoder.decode(frame); } catch { this.transportFailure('invalid ACP UTF-8'); return; }
        this.receive(line);
      }
      if (buffered.length > LIMITS.frameBytes) this.transportFailure('ACP frame limit');
    });
  }
  withTimeout(promise, ms, kind) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new DomainError(kind, kind)), ms); })]).finally(() => clearTimeout(timer));
  }
  async initialize() {
    const initialized = await this.request('initialize', ADAPTER.initialize(this.mode));
    if (!ADAPTER.admitInitialize(initialized)) fail('protocol_error', 'ACP adapter admission failed');
    await this.request(ADAPTER.methods.auth, { methodId: 'cursor_login' });
    if (this.resumeCursorSessionId) {
      const loaded = await this.request(ADAPTER.methods.sessionLoad, ADAPTER.loadParams(this.resumeCursorSessionId, this.cwd));
      if (!ADAPTER.admitLoadResult(loaded, this.resumeCursorSessionId)) fail('protocol_error', 'ACP session/load result is not admitted');
      this.cursorSessionId = this.resumeCursorSessionId;
      this.cursor_session_id = this.resumeCursorSessionId;
      if (loaded.modes?.currentModeId && loaded.modes.currentModeId !== this.mode) {
        await this.applyProviderMode(this.mode);
      }
      return;
    }
    const created = await this.request(ADAPTER.methods.sessionNew, { cwd: this.cwd, mcpServers: [] });
    if (!validText(created?.sessionId) || !created.sessionId) fail('protocol_error', 'ACP session/new returned invalid session ID');
    if (!ADAPTER.admitModeState(created)) fail('protocol_error', 'ACP adapter mode admission failed');
    this.cursorSessionId = created.sessionId;
    this.cursor_session_id = created.sessionId;
    if (created.modes.currentModeId !== this.mode) await this.applyProviderMode(this.mode);
  }
  async applyProviderMode(mode) {
    const result = await this.withTimeout(
      this.request(ADAPTER.methods.setMode, { sessionId: this.cursorSessionId, modeId: mode }),
      LIMITS.initMs,
      'mode_timeout',
    );
    if (!ADAPTER.admitSetModeResult(result)) fail('protocol_error', 'ACP session/set_mode response is not admitted');
  }
  send(message) { if (!this.child?.stdin.writable) fail('protocol_error', 'ACP stdin is closed'); this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) this.transportFailure('child stdin EPIPE'); }); }
  sendConfirmed(message) {
    if (!this.child?.stdin.writable) return Promise.reject(new DomainError('protocol_error', 'ACP stdin is closed'));
    return new Promise((resolveWrite, reject) => {
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(new DomainError('protocol_error', 'child stdin EPIPE'));
          else resolveWrite();
        });
      } catch (error) { reject(error); }
    });
  }
  request(method, params, handlers = {}) {
    const id = this.rpcId++;
    const promise = new Promise((resolveRpc, reject) => this.rpc.set(String(id), { ...handlers, resolve: resolveRpc, reject }));
    try { this.send({ jsonrpc: '2.0', id, method, params }); }
    catch (error) { this.rpc.delete(String(id)); throw error; }
    return promise;
  }
  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  respondError(id, error_code, message) { try { this.send({ jsonrpc: '2.0', id, error: { code: -32602, message, data: { error_code } } }); } catch { /* shutdown abandons closed transport */ } }
  acknowledgeCollaboration(id) { try { this.respond(id, {}); } catch { /* shutdown abandons closed transport */ } }
  receive(line) {
    let message; try { message = JSON.parse(line); } catch { return this.transportFailure('invalid ACP JSON'); }
    if (!message || Array.isArray(message) || typeof message !== 'object' || message.jsonrpc !== '2.0') return this.transportFailure('invalid ACP JSON-RPC frame');
    if (Object.hasOwn(message, 'id') && !message.method) {
      const hasResult = Object.hasOwn(message, 'result'); const hasError = Object.hasOwn(message, 'error');
      if (hasResult === hasError) return this.transportFailure('invalid ACP response');
      const waiter = this.rpc.get(String(message.id)); if (!waiter) return; this.rpc.delete(String(message.id));
      if (hasError) {
        const error = providerError(message.error);
        try { waiter.onError?.(error); } finally { waiter.reject(error); }
      } else {
        try { waiter.onResult?.(message.result); waiter.resolve(message.result); }
        catch (error) { waiter.reject(error); }
      }
      return;
    }
    if (typeof message.method === 'string' && message.method) this.callback(message); else this.transportFailure('invalid ACP JSON-RPC frame');
  }
  callback(message) {
    if (message.method === 'session/update') return this.sessionUpdate(message);
    if (message.method === ADAPTER.methods.todos || message.method === ADAPTER.methods.task || message.method === ADAPTER.methods.image) {
      return this.collaborationRequest(message);
    }
    const mapping = { 'cursor/ask_question': 'question', 'cursor/create_plan': 'plan', 'session/request_permission': 'permission' };
    const kind = mapping[message.method];
    if (!kind) {
      if (message.method === ADAPTER.methods.read || message.method === ADAPTER.methods.write) return this.filesystemCallback(message);
      if (message.id !== undefined) this.respondError(message.id, 'unsupported_callback', 'callback is not admitted');
      return;
    }
    const turn = this.active; const request_id = String(message.id ?? '');
    if (!this.admissionOpen || !turn || !request_id) { if (message.id !== undefined) this.respondError(message.id, 'invalid_state', 'no active turn'); return; }
    if (message.params?.sessionId !== undefined && message.params.sessionId !== this.cursorSessionId) { this.respondError(message.id, 'invalid_state', 'callback session mismatch'); return; }
    if (turn.pending.size >= LIMITS.pending) { this.respondError(message.id, 'resource_limit', 'pending request limit'); return; }
    if (turn.pending.has(request_id)) { this.respondError(message.id, 'duplicate_request', 'pending request ID already exists'); return; }
    let context; let permissionChoices = null;
    try {
      if (kind === 'permission') {
        if (message.params?.sessionId !== this.cursorSessionId || !message.params?.toolCall || !validText(message.params.toolCall.toolCallId) || !message.params.toolCall.toolCallId) throw new Error('invalid permission request');
        permissionChoices = ADAPTER.permissionChoices(message.params.options); if (!permissionChoices) throw new Error('unsupported permission options');
      }
      context = normalizePending(kind, message.params); if (bytes(JSON.stringify(context)) > LIMITS.inputBytes) throw new DomainError('resource_limit', 'pending context limit');
    } catch (error) { this.respondError(message.id, error instanceof DomainError ? error.error_code : 'invalid_callback', error.message); return; }
    const pending = { request_id, kind, context, rawId: message.id, permissionChoices };
    turn.pending.set(request_id, pending); this.emit('pending', turn.turn_id, { action: 'added', request_id, request_kind: kind }); this.turnState(turn, 'waiting_for_input');
  }
  sessionUpdate(message) {
    const turn = this.active;
    const update = message.params?.update;
    if (!turn || message.params?.sessionId !== this.cursorSessionId || update?.sessionUpdate !== 'agent_message_chunk') return;
    const chunk = update.content?.text;
    if (!validText(chunk)) return this.transportFailure('invalid ACP agent message');
    // Retain only the admitted agent-text stream. Thinking/tool/archive payloads
    // remain excluded, while the public preview is derived at completion.
    const chunkBytes = bytes(chunk);
    if (turn.agent_text_bytes + chunkBytes > LIMITS.resultBytes) {
      void this.terminalize(turn, 'failed', 'terminal_result_limit');
      return;
    }
    if (chunk) {
      turn.progress_revision = (turn.progress_revision || 0) + 1;
      turn.progress_excerpt = bounded(chunk, LIMITS.progressBytes);
    }
    if (chunk) turn.agent_text_parts.push(chunk);
    turn.agent_text_bytes += chunkBytes;
  }
  collaborationRequest(message) {
    if (message.id === undefined) return;
    try {
      const turn = this.active;
      const params = message.params;
      if (!this.admissionOpen || !turn) return;
      let kind; let payload;
      if (message.method === ADAPTER.methods.todos) { kind = 'todos'; payload = ADAPTER.admitTodos(params); }
      else if (message.method === ADAPTER.methods.task) { kind = 'task'; payload = ADAPTER.admitTask(params); }
      else { kind = 'image'; payload = ADAPTER.admitImage(params); }
      if (!payload || bytes(JSON.stringify(payload)) > LIMITS.inputBytes) return;
      this.emit(kind, turn.turn_id, payload);
    } catch { /* malformed nonblocking extension data is ignored */ }
    finally { this.acknowledgeCollaboration(message.id); }
  }
  filesystemCallback(message) {
    if (message.id === undefined) return;
    try {
      if (!this.admissionOpen || this.session_state !== 'live' || !this.active) fail('protocol_error', 'filesystem callback requires an active turn');
      const params = message.params;
      if (!params || Array.isArray(params) || typeof params !== 'object' || params.sessionId !== this.cursorSessionId) fail('protocol_error', 'invalid filesystem callback session');
      const path = params.path;
      if (!validText(path) || !path || !isAbsolute(path)) fail('scope_rejected', 'filesystem path must be absolute');
      if (message.method === ADAPTER.methods.read) {
        const canonical = this.checkedExistingFile(path);
        const content = readFileSync(canonical); if (content.length > LIMITS.fsBytes) fail('resource_limit', 'filesystem file limit');
        let decoded; try { decoded = decoder.decode(content); } catch { fail('invalid_text_encoding', 'file is not valid UTF-8'); }
        const line = params.line ?? 1; const limit = params.limit ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(limit) || limit < 0) fail('protocol_error', 'invalid text range');
        const lines = decoded.split('\n'); const selected = line > lines.length ? '' : lines.slice(line - 1, line - 1 + limit).join('\n');
        this.respond(message.id, { content: selected }); return;
      }
      if (this.mode !== 'agent') fail('scope_rejected', 'write callback is disabled for this mode');
      if (!validText(params.content)) fail('invalid_text_encoding', 'write content is not valid UTF-8');
      // The admitted frame limit equals fsBytes, so JSON framing makes an
      // above-cap write unreachable today; retain this local defense if those
      // limits diverge. The transport-level no-mutation path is regression-tested.
      /* node:coverage ignore next */
      if (bytes(params.content) > LIMITS.fsBytes) fail('resource_limit', 'filesystem file limit');
      this.checkedWriteTarget(path); writeFileSync(path, params.content, 'utf8'); this.respond(message.id, {});
    } catch (error) { this.respondError(message.id, error instanceof DomainError ? error.error_code : 'protocol_error', error.message); }
  }
  checkedExistingFile(path) {
    let metadata; try { metadata = lstatSync(path); } catch { fail('scope_rejected', 'file does not exist'); }
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail('scope_rejected', 'path is not a regular file');
    const canonical = realpathSync(path); if (!inside(canonical, this.cwd)) fail('scope_rejected', 'path is outside session cwd'); return canonical;
  }
  checkedWriteTarget(path) {
    try { const metadata = lstatSync(path); if (metadata.isSymbolicLink() || !metadata.isFile()) fail('scope_rejected', 'path is not a regular file'); const canonical = realpathSync(path); if (!inside(canonical, this.cwd)) fail('scope_rejected', 'path is outside session cwd'); return; }
    catch (error) { if (error instanceof DomainError) throw error; if (error?.code !== 'ENOENT') fail('protocol_error', 'cannot inspect write target'); }
    let parent; try { parent = realpathSync(dirname(path)); } catch { fail('scope_rejected', 'write parent does not exist'); }
    if (!inside(parent, this.cwd)) fail('scope_rejected', 'write parent is outside session cwd');
  }
  async prompt(prompt) {
    if (this.session_state !== 'live') fail('protocol_error', 'session is not live');
    if (this.modeTransition) fail('protocol_error', 'session mode transition is in progress');
    if (this.active) fail('protocol_error', 'session already has an active turn');
    this.clearIdle(); const turn = { turn_id: opaqueId(), turn_status: 'running', result: null, full_result: null, full_result_sha256: null, terminal_reason: null, terminal_receipt: null, pending: new Map(), timer: null, agent_text_parts: [], agent_text_bytes: 0, progress_revision: 0, progress_excerpt: null };
    this.active = turn; this.emit('lifecycle', turn.turn_id, { scope: 'turn', from: null, to: 'running' });
    turn.timer = setTimeout(() => this.terminalize(turn, 'timed_out', 'turn deadline exceeded'), LIMITS.turnMs);
    let dispatched;
    try {
      dispatched = this.request(ADAPTER.methods.prompt, { sessionId: this.cursorSessionId, prompt: [{ type: 'text', text: prompt }] }, {
        onResult: (result) => {
          try {
            if (turn.pending.size) fail('protocol_error', 'ACP result with pending request');
            this.complete(turn, result);
          } catch (error) {
            void this.terminalize(turn, 'failed', error.message);
            throw error;
          }
        },
        onError: (error) => {
          if (hasProviderError(error)) this.provider_error = error.provider_error;
          void this.terminalize(turn, 'failed', error.message);
        },
      });
    }
    catch (error) { await this.terminalize(turn, 'failed', error.message); return turn; }
    void dispatched.catch(() => {});
    return turn;
  }
  complete(turn, result) {
    if (this.active !== turn || turn.turn_status !== 'running') return;
    if (!ADAPTER.admitPromptResult(result)) fail('protocol_error', 'ACP prompt response is not admitted');
    clearTimeout(turn.timer); turn.full_result = turn.agent_text_parts.join('');
    turn.agent_text_parts = null; turn.agent_text_bytes = null;
    turn.full_result_sha256 = createHash('sha256').update(turn.full_result, 'utf8').digest('hex');
    turn.result = bounded(turn.full_result); turn.turn_status = 'completed'; this.emit('result', turn.turn_id, { turn_status: 'completed' }); captureTerminalReceipt(this, turn); this.active = null; this.last = turn; this.terminalWaitDelivered = false; this.armIdle();
  }
  async answer(turn, requestId, response) {
    const pending = turn.pending.get(requestId); if (!pending) fail('unknown_request', 'unknown pending request');
    turn.pending.delete(requestId);
    this.emit('pending', turn.turn_id, { action: 'removed', request_id: requestId, request_kind: pending.kind });
    try { await this.sendConfirmed({ jsonrpc: '2.0', id: pending.rawId, result: response }); }
    catch (error) { await this.terminalize(turn, 'failed', error.message); return turn; }
    if (this.active !== turn) return turn;
    if (!turn.pending.size) this.turnState(turn, 'running'); return turn;
  }
  initFailure(error) {
    if (hasProviderError(error)) this.provider_error = error.provider_error;
    const kind = error instanceof DomainError ? error.error_code : error;
    this.failure_kind = ['spawn', 'init_timeout'].includes(kind) ? kind : 'init';
    return this.shutdown(null, error instanceof Error ? error.message : null);
  }
  transportFailure(reason, startingKind = 'init') {
    if (this.session_state === 'starting') void this.initFailure(startingKind);
    else if (this.active) void this.terminalize(this.active, 'failed', reason);
    else if (this.session_state === 'live') void this.shutdown(null, reason);
  }
  requestAdapterCancel() {
    if (this.adapterCancelSent || !this.cursorSessionId) return;
    this.adapterCancelSent = true;
    try { this.send({ jsonrpc: '2.0', method: ADAPTER.methods.cancel, params: { sessionId: this.cursorSessionId } }); } catch {}
  }
  async terminalize(turn, status, reason) {
    if (this.active !== turn || !['running', 'waiting_for_input'].includes(turn.turn_status)) return;
    this.admissionOpen = false; clearTimeout(turn.timer); const pendingRequests = [...turn.pending.values()]; turn.pending.clear();
    for (const pending of pendingRequests) {
      this.emit('pending', turn.turn_id, { action: 'removed', request_id: pending.request_id, request_kind: pending.kind });
      try { this.respond(pending.rawId, ADAPTER.cancelResponse(pending.kind)); } catch { /* shutdown abandons closed transport */ }
    }
    this.requestAdapterCancel(); turn.agent_text_parts = null; turn.agent_text_bytes = null;
    turn.terminal_reason = bounded(reason); turn.turn_status = status; this.emit('result', turn.turn_id, { turn_status: status }); captureTerminalReceipt(this, turn); this.active = null; this.last = turn; this.terminalWaitDelivered = false; await this.shutdown(turn, reason);
  }
  shutdown(_turn, reason) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.admissionOpen = false; this.clearIdle(); this.sessionState('closing'); this.shutdownPromise = (async () => {
      for (const waiter of this.rpc.values()) waiter.reject(new Error('session closing')); this.rpc.clear();
      if (this.child?.pid && !this.childExited) {
        const exited = new Promise((done) => this.child.once('exit', done));
        let graceTimer = null;
        if (this.adapterCancelSent) {
          await Promise.race([exited, new Promise((done) => { graceTimer = setTimeout(done, LIMITS.graceMs); })]);
          if (graceTimer) clearTimeout(graceTimer);
        }
        if (!this.childExited) try { this.child.kill('SIGTERM'); } catch {}
        if (!this.childExited) await Promise.race([exited, new Promise((done) => setImmediate(done))]);
        if (!this.childExited) try { this.child.kill('SIGKILL'); } catch {}
      }
      if (reason) this.terminal_reason = bounded(reason); this.sessionState('tombstone'); this.tombstonedAt = Date.now(); this.runtime.live.delete(this.id); this.runtime.evict(); this.wake();
    })(); return this.shutdownPromise;
  }
  armIdle() { this.clearIdle(); if (this.session_state === 'live' && !this.active) this.idleTimer = setTimeout(() => { void this.shutdown(null, 'idle TTL expired'); }, LIMITS.idleMs); }
  clearIdle() { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null; }
  wake() { for (const done of this.waiters) done(); this.waiters.clear(); }
}

export class Runtime {
  constructor({ env = process.env, roots = readRoots(env) } = {}) { this.env = env; this.roots = roots; this.sessions = new Map(); this.live = new Set(); }
  canonicalCwd(cwd) { if (!validText(cwd) || !isAbsolute(cwd)) fail('invalid_args', 'cwd must be an absolute string'); let canonical; try { canonical = realpathSync(cwd); } catch { fail('scope_rejected', 'cwd does not exist'); } if (!lstatSync(canonical).isDirectory()) fail('scope_rejected', 'cwd is not a directory'); if (this.roots && !this.roots.some((root) => inside(canonical, root))) fail('scope_rejected', 'cwd is outside allowed roots'); return canonical; }
  canonicalPluginDir(root) { if (!validText(root) || !isAbsolute(root)) fail('invalid_args', 'plugin_dir must be an absolute string'); let canonical; try { canonical = realpathSync(root); } catch { fail('scope_rejected', 'plugin_dir does not exist'); } if (!lstatSync(canonical).isDirectory()) fail('scope_rejected', 'plugin_dir is not a directory'); if (this.roots && !this.roots.some((allowed) => inside(canonical, allowed))) fail('scope_rejected', 'plugin_dir is outside allowed roots'); return canonical; }
  evict() { const now = Date.now(); for (const [id, session] of this.sessions) if (session.session_state === 'tombstone' && now - session.tombstonedAt >= LIMITS.retentionMs) this.sessions.delete(id); const tombs = [...this.sessions.values()].filter((session) => session.session_state === 'tombstone').sort((a, b) => a.tombstonedAt - b.tombstonedAt || a.id.localeCompare(b.id)); while (tombs.length > LIMITS.tombstones) this.sessions.delete(tombs.shift().id); }
  session(id) { this.evict(); const session = this.sessions.get(id); if (!session) fail('unknown_session', 'unknown session'); return session; }
  async start(args) {
    assertObject(args, ['cwd', 'mode', ...LAUNCH_KEYS], ['cwd', 'mode']);
    if (!['ask', 'plan', 'agent'].includes(args.mode)) fail('invalid_args', 'invalid mode: ask|plan|agent');
    const cwd = this.canonicalCwd(args.cwd);
    const launch = admitLaunchParams(args, (root) => this.canonicalPluginDir(root));
    if (this.live.size >= LIMITS.live) fail('resource_limit', 'live session limit');
    const session = new SessionRecord(this, cwd, args.mode, launch);
    this.sessions.set(session.id, session); this.live.add(session.id); await session.start(); return session.envelope();
  }
  async resume(args) {
    assertObject(args, ['cwd', 'cursor_session_id', 'mode', ...LAUNCH_KEYS], ['cwd', 'cursor_session_id', 'mode']);
    if (!['ask', 'plan', 'agent'].includes(args.mode)) fail('invalid_args', 'invalid mode: ask|plan|agent');
    const cwd = this.canonicalCwd(args.cwd);
    const launch = admitLaunchParams(args, (root) => this.canonicalPluginDir(root));
    if (this.live.size >= LIMITS.live) fail('resource_limit', 'live session limit');
    const session = new SessionRecord(this, cwd, args.mode, launch);
    session.resumeCursorSessionId = text(args.cursor_session_id, 'cursor_session_id');
    session.cursor_session_id = session.resumeCursorSessionId;
    this.sessions.set(session.id, session); this.live.add(session.id); await session.start(); return session.envelope();
  }
  turn(session, id) { if (session.active?.turn_id === id) return session.active; if (session.last?.turn_id === id) return session.last; fail('unknown_turn', 'unknown turn'); }
  readResult(args) {
    assertObject(args, ['session_id', 'turn_id', 'offset'], ['session_id', 'turn_id']);
    const session = this.session(text(args.session_id, 'session_id'));
    const turn = this.turn(session, text(args.turn_id, 'turn_id'));
    if (turn !== session.last || turn.result === null || turn.full_result === null) fail('protocol_error', 'turn has no retained terminal result');
    const offset = args.offset ?? 0;
    const encoded = Buffer.from(turn.full_result, 'utf8');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > encoded.length) fail('invalid_args', 'invalid result offset');
    try { decoder.decode(encoded.subarray(0, offset)); } catch { fail('invalid_args', 'result offset is not a UTF-8 boundary'); }
    let end = Math.min(encoded.length, offset + LIMITS.resultPageBytes);
    while (end > offset) {
      try { decoder.decode(encoded.subarray(offset, end)); break; } catch { end -= 1; }
    }
    const eof = end === encoded.length;
    return {
      session_id: session.id, turn_id: turn.turn_id, offset,
      next_offset: eof ? null : end, eof,
      text: encoded.subarray(offset, end).toString('utf8'), total_bytes: encoded.length,
      sha256: turn.full_result_sha256,
    };
  }
  async call(name, args) {
    assertAggregate(args);
    if (name === 'cursor_delegate') {
      assertObject(args, ['cwd', 'mode', 'prompt', ...LAUNCH_KEYS], ['cwd', 'mode', 'prompt']);
      const startArgs = { cwd: args.cwd, mode: args.mode };
      for (const key of LAUNCH_KEYS) if (key in args) startArgs[key] = args[key];
      const sessionEnvelope = await this.start(startArgs);
      if (sessionEnvelope.session_state !== 'live') return sessionEnvelope;
      try {
        const dispatched = await this.call('cursor_send_prompt', { session_id: sessionEnvelope.session_id, prompt: args.prompt });
        if (!Object.hasOwn(sessionEnvelope, 'cursor_session_id')) return dispatched;
        return {
          ...dispatched,
          cursor_session_id: sessionEnvelope.cursor_session_id,
          model: sessionEnvelope.model,
          ...(sessionEnvelope.effort != null ? { effort: sessionEnvelope.effort } : {}),
          ...(sessionEnvelope.fast != null ? { fast: sessionEnvelope.fast } : {}),
        };
      }
      catch (error) {
        // A live session with a rejected first prompt is the sole facade-owned
        // cleanup case. It does not reinterpret the runtime error.
        await this.call('cursor_close_session', { session_id: sessionEnvelope.session_id });
        throw error;
      }
    }
    if (name === 'cursor_start_session') return this.start(args);
    if (name === 'cursor_resume_session') return this.resume(args);
    if (name === 'cursor_send_prompt') { assertObject(args, ['session_id', 'prompt'], ['session_id', 'prompt']); const session = this.session(text(args.session_id, 'session_id')); const turn = await session.prompt(text(args.prompt, 'prompt')); return session.actionEnvelope(turn); }
    if (name === 'cursor_set_mode') return this.setMode(args);
    if (name === 'cursor_session_status') { assertObject(args, ['session_id'], ['session_id']); return this.session(text(args.session_id, 'session_id')).envelope(); }
    if (name === 'cursor_read_result') return this.readResult(args);
    if (name === 'cursor_wait') return this.wait(args);
    if (name === 'cursor_cancel') {
      assertObject(args, ['session_id', 'turn_id'], ['session_id', 'turn_id']);
      const session = this.session(text(args.session_id, 'session_id'));
      const turn = this.turn(session, text(args.turn_id, 'turn_id'));
      if (turn === session.active) await session.terminalize(turn, 'cancelled', 'cancelled');
      return session.actionEnvelope(turn);
    }
    if (name === 'cursor_close_session') {
      assertObject(args, ['session_id'], ['session_id']);
      const session = this.session(text(args.session_id, 'session_id'));
      const closedTurn = session.active;
      if (closedTurn) await session.terminalize(closedTurn, 'cancelled', 'closed');
      else { session.requestAdapterCancel(); await session.shutdown(null, null); }
      return session.actionEnvelope(closedTurn, !closedTurn && session.last
        ? { terminal_receipt: terminalReceipt(session, session.last) }
        : {});
    }
    if (ANSWER_TOOLS.has(name)) return this.answer(name, args);
    fail('invalid_args', `unknown tool: ${name}`);
  }
  async wait(args) {
    assertObject(args, ['session_id', 'turn_id', 'after_event_id', 'timeout_ms', 'after_progress_revision'], ['session_id', 'turn_id']); const session = this.session(text(args.session_id, 'session_id')); const turn = this.turn(session, text(args.turn_id, 'turn_id')); const after = args.after_event_id ?? 0; const timeout = args.timeout_ms ?? LIMITS.waitDefaultMs; const afterProgress = args.after_progress_revision ?? 0;
    if (!Number.isSafeInteger(after) || after < 0 || after > session.nextEvent - 1) fail('invalid_args', 'invalid after_event_id');
    if (!Number.isInteger(timeout) || timeout < LIMITS.waitMinMs || timeout > LIMITS.waitMaxMs) fail('invalid_args', 'invalid timeout_ms');
    if (!Number.isSafeInteger(afterProgress) || afterProgress < 0 || afterProgress > (turn.progress_revision || 0)) fail('invalid_args', 'invalid after_progress_revision');
    if (turn !== session.active || session.events.some((event) => event.event_id > after && (event.turn_id === turn.turn_id || event.turn_id === null))) return session.waitEnvelope(turn, after, false, afterProgress);
    if (session.waiters.size >= LIMITS.waiters) fail('resource_limit', 'waiter limit');
    const changed = await new Promise((resolveWait) => { const timer = setTimeout(() => { session.waiters.delete(done); resolveWait(false); }, timeout); const done = () => { clearTimeout(timer); resolveWait(true); }; session.waiters.add(done); });
    return session.waitEnvelope(turn, after, !changed, afterProgress);
  }
  async answer(name, args) {
    const question = name === 'cursor_answer_question'; const keys = question ? ['session_id', 'turn_id', 'request_id', 'outcome', 'answers'] : ['session_id', 'turn_id', 'request_id', 'decision']; const required = question ? ['session_id', 'turn_id', 'request_id', 'outcome'] : ['session_id', 'turn_id', 'request_id', 'decision'];
    assertObject(args, keys, required); const session = this.session(text(args.session_id, 'session_id')); const turn = this.turn(session, text(args.turn_id, 'turn_id')); if (turn !== session.active) fail('unknown_request', 'turn has no live pending requests'); const requestId = text(args.request_id, 'request_id'); const pending = turn.pending.get(requestId); if (!pending) this.unknownRequest(session, turn, 'unknown pending request'); let response;
    if (question) {
      if (pending.kind !== 'question' || !['answered', 'skipped', 'cancelled'].includes(args.outcome)) fail('invalid_args', 'invalid question answer');
      if (args.outcome !== 'answered') { if ('answers' in args) fail('invalid_args', 'answers are only valid for answered outcome'); response = ADAPTER.questionResponse(args.outcome); }
      else { response = ADAPTER.questionResponse('answered', this.validateAnswers(pending, args.answers)); }
    }
    else if (name === 'cursor_answer_plan') { if (pending.kind !== 'plan' || !['accept', 'reject'].includes(args.decision)) fail('invalid_args', 'invalid plan decision'); response = ADAPTER.planResponse(args.decision); }
    else {
      if (pending.kind !== 'permission' || !['allow-once', 'reject-once'].includes(args.decision)) fail('invalid_args', 'invalid permission decision');
      const option = pending.permissionChoices.get(args.decision); if (!option) fail('invalid_args', 'permission decision was not advertised'); response = ADAPTER.permissionResponse(option.id);
    }
    await session.answer(turn, requestId, response); return session.actionEnvelope(turn);
  }
  unknownRequest(session, turn, message) {
    fail('unknown_request', message, {
      recovery: {
        session_id: session.id, turn_id: turn.turn_id, last_event_id: session.nextEvent - 1,
        pending: [...turn.pending.values()].map((pending) => ({ request_id: pending.request_id, kind: pending.kind })),
      },
    });
  }
  async setMode(args) {
    assertObject(args, ['session_id', 'mode'], ['session_id', 'mode']);
    if (!['ask', 'plan', 'agent'].includes(args.mode)) fail('invalid_args', 'invalid mode: ask|plan|agent');
    const session = this.session(text(args.session_id, 'session_id'));
    if (session.session_state !== 'live') fail('protocol_error', 'session is not live');
    if (session.active) fail('protocol_error', 'session already has an active turn');
    if (session.modeTransition) fail('protocol_error', 'session mode transition is already in progress');
    if (session.mode === args.mode) return session.actionEnvelope(null, { mode: session.mode });
    session.clearIdle();
    session.modeTransition = true;
    try { await session.applyProviderMode(args.mode); }
    catch (error) {
      if (hasProviderError(error)) {
        session.provider_error = error.provider_error;
        await session.shutdown(null, error.message);
        throw error;
      }
      await session.shutdown(null, error.message);
      if (error instanceof DomainError) throw error;
      fail('protocol_error', 'ACP session/set_mode failed');
    }
    finally { session.modeTransition = false; }
    session.mode = args.mode;
    session.armIdle();
    return session.actionEnvelope(null, { mode: session.mode });
  }
  validateAnswers(pending, answers) {
    if (!Array.isArray(answers)) fail('invalid_args', 'answers must be an array');
    const questions = new Map(pending.context.questions.map((question) => [question.id, question])); const answered = new Set();
    return answers.map((answer) => {
      if (!answer || Array.isArray(answer) || typeof answer !== 'object' || Object.keys(answer).some((key) => !['question_id', 'selected_option_ids'].includes(key))) fail('invalid_args', 'invalid question answer entry');
      const questionId = text(answer.question_id, 'question_id'); if (answered.has(questionId)) fail('invalid_args', 'duplicate question answer'); answered.add(questionId);
      const question = questions.get(questionId); if (!question || !Array.isArray(answer.selected_option_ids) || !answer.selected_option_ids.length) fail('invalid_args', 'question or selections were not advertised');
      if (!question.allow_multiple && answer.selected_option_ids.length !== 1) fail('invalid_args', 'question does not allow multiple selections');
      const advertised = new Set(question.options.map((option) => option.id)); const selected = new Set();
      for (const optionId of answer.selected_option_ids) { text(optionId, 'selected_option_id'); if (!advertised.has(optionId) || selected.has(optionId)) fail('invalid_args', 'option was not advertised'); selected.add(optionId); }
      return { question_id: questionId, selected_option_ids: [...selected] };
    });
  }
}

const ANSWER_TOOLS = new Set(['cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission']);

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: LIMITS.inputBytes };
const modelString = { ...string, pattern: '^[^\\[\\]]+$' };
const effortString = { ...string, pattern: '^[A-Za-z0-9._-]+$' };
const idFields = (...keys) => Object.fromEntries(keys.map((key) => [key, string]));
const modeEnum = { type: 'string', enum: ['ask', 'plan', 'agent'] };
const modelFields = {
  model: modelString, effort: effortString, fast: { type: 'boolean' },
  plugin_dirs: { type: 'array', minItems: 1, items: string },
};
const answerItem = schema({ question_id: string, selected_option_ids: { type: 'array', minItems: 1, items: string } }, ['question_id', 'selected_option_ids']);
const tool = (name, properties, required) => ({ name, description: name, inputSchema: schema(properties, required) });
export const tools = [
  tool('cursor_delegate', { cwd: string, mode: modeEnum, prompt: string, ...modelFields }, ['cwd', 'mode', 'prompt']),
  tool('cursor_start_session', { cwd: string, mode: modeEnum, ...modelFields }, ['cwd', 'mode']),
  tool('cursor_resume_session', { cwd: string, cursor_session_id: string, mode: modeEnum, ...modelFields }, ['cwd', 'cursor_session_id', 'mode']),
  tool('cursor_send_prompt', idFields('session_id', 'prompt'), ['session_id', 'prompt']),
  tool('cursor_set_mode', { ...idFields('session_id'), mode: modeEnum }, ['session_id', 'mode']),
  tool('cursor_session_status', idFields('session_id'), ['session_id']),
  tool('cursor_read_result', { ...idFields('session_id', 'turn_id'), offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, ['session_id', 'turn_id']),
  tool('cursor_wait', { ...idFields('session_id', 'turn_id'), after_event_id: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, after_progress_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, timeout_ms: { type: 'integer', minimum: LIMITS.waitMinMs, maximum: LIMITS.waitMaxMs } }, ['session_id', 'turn_id']),
  tool('cursor_answer_question', { ...idFields('session_id', 'turn_id', 'request_id'), outcome: { type: 'string', enum: ['answered', 'skipped', 'cancelled'] }, answers: { type: 'array', items: answerItem } }, ['session_id', 'turn_id', 'request_id', 'outcome']),
  tool('cursor_answer_plan', { ...idFields('session_id', 'turn_id', 'request_id'), decision: { type: 'string', enum: ['accept', 'reject'] } }, ['session_id', 'turn_id', 'request_id', 'decision']),
  tool('cursor_answer_permission', { ...idFields('session_id', 'turn_id', 'request_id'), decision: { type: 'string', enum: ['allow-once', 'reject-once'] } }, ['session_id', 'turn_id', 'request_id', 'decision']),
  tool('cursor_cancel', idFields('session_id', 'turn_id'), ['session_id', 'turn_id']),
  tool('cursor_close_session', idFields('session_id'), ['session_id']),
];
const toolResult = (value, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify(value) }] });
function readBoundedLines(stream, onLine, onInvalid) {
  let buffered = Buffer.alloc(0); let discarding = false;
  stream.on('data', (incoming) => {
    let chunk = Buffer.from(incoming);
    if (discarding) { const newline = chunk.indexOf(0x0a); if (newline < 0) return; chunk = chunk.subarray(newline + 1); discarding = false; }
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const newline = buffered.indexOf(0x0a); if (newline < 0) break;
      let frame = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1); if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length > LIMITS.frameBytes) { onInvalid(); continue; }
      try { onLine(decoder.decode(frame)); } catch { onInvalid(); }
    }
    if (buffered.length > LIMITS.frameBytes) { buffered = Buffer.alloc(0); discarding = true; onInvalid(); }
  });
}
export async function serve() {
  const runtime = new Runtime();
  const closeAll = () => Promise.all([...runtime.sessions.values()].map((session) => session.active ? session.terminalize(session.active, 'cancelled', 'closed') : session.shutdown(null, null)));
  process.stdin.once('end', () => { void closeAll(); }); for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void closeAll().finally(() => process.exit(0)); });
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const invalidFrame = () => write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const handleLine = async (line) => { let request; try { request = JSON.parse(line); } catch { invalidFrame(); return; }
    if (!request || request.jsonrpc !== '2.0' || !validText(request.method)) { if (request?.id !== undefined) write({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'Invalid Request' } }); return; }
    if (request.method === 'notifications/initialized') return;
    try {
      let payload;
      if (request.method === 'initialize') payload = { protocolVersion: request.params?.protocolVersion || MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'cursor-subagent', version: MANIFEST_VERSION } };
      else if (request.method === 'tools/list') payload = { tools };
      else if (request.method === 'resources/list') payload = { resources: [] };
      else if (request.method === 'resources/templates/list') payload = { resourceTemplates: [] };
      else if (request.method === 'prompts/list') payload = { prompts: [] };
      else if (request.method === 'tools/call') payload = toolResult(await runtime.call(request.params?.name, request.params?.arguments));
      else { if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
      if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, result: payload });
    }
    catch (error) {
      if (request.id !== undefined) {
        const payload = { error_code: error instanceof DomainError ? error.error_code : 'protocol_error', message: bounded(error.message).text };
        if (error instanceof DomainError && error.recovery) payload.recovery = error.recovery;
        if (error instanceof DomainError && error.provider_error) payload.provider_error = error.provider_error;
        write({ jsonrpc: '2.0', id: request.id, result: toolResult(payload, true) });
      }
    }
  };
  readBoundedLines(process.stdin, (line) => { void handleLine(line); }, invalidFrame);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) serve();
