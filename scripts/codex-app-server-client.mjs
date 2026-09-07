import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const OUTPUT_LIMIT = 1_048_576;
const CAPTURE_PAGE_LIMIT = 100;
const CAPTURE_PAGE_SIZE = 100;
const CAPTURE_TEXT_LIMIT = 1_000_000;
const TURN_STATUSES = new Set(['completed', 'failed', 'interrupted', 'inProgress']);
const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted']);

function finalCapture(turnId, turnStatus, text, phase, completeness, errorCode = null, source = 'thread/items/list') {
  return {
    text,
    turn_id: turnId,
    turn_status: turnStatus,
    phase,
    source,
    completeness,
    error_code: errorCode,
  };
}

function captureFailure(turnId, turnStatus, errorCode, source = 'thread/turns/list') {
  return finalCapture(turnId, turnStatus, null, null, 'incomplete', errorCode, source);
}

export class CodexAppServerClient {
  constructor(command, args = ['app-server', '--stdio'], env = process.env, options = {}) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.outputLimit = options.outputLimit ?? OUTPUT_LIMIT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.closeGraceMs = options.closeGraceMs ?? 1_000;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.closeConfirmMs = options.closeConfirmMs ?? 1_000;
    this.captureNow = options.now ?? Date.now;
    this.captureSleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.clientRequests = [];
    this.serverRequests = [];
    this.onServerRequest = options.onServerRequest ?? null;
    this.readSkillFile = options.readSkillFile ?? readFile;
    this.stderr = [];
    this.outputBytes = 0;
    this.closed = false;
    this.closePromise = null;
    this.child.stderr.on('data', (chunk) => this.stderr.push(chunk));
    const rejectAll = (error) => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
    };
    this.child.once('error', rejectAll);
    this.child.once('close', (code, signal) => rejectAll(new Error(`Codex app-server exited (${code ?? signal})`)));
    const decoder = new StringDecoder('utf8'); let buffered = '';
    const respondToServerRequest = async (message) => {
      const record = { method: message.method, id: message.id, params: message.params ?? null };
      this.serverRequests.push(record);
      try {
        if (typeof this.onServerRequest !== 'function') throw new Error(`unsupported server request: ${message.method}`);
        const result = await this.onServerRequest(record);
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      } catch (error) {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: error.message } })}\n`);
      }
    };
    const receive = (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) void respondToServerRequest(message);
        else this.notifications.push({ method: message.method, params: message.params ?? null, at_ms: Date.now() });
        return;
      }
      const waiter = this.pending.get(String(message.id));
      if (!waiter) return;
      this.pending.delete(String(message.id)); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'Codex app-server request failed'));
      else waiter.resolve(message.result);
    };
    this.child.stdout.on('data', (chunk) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > this.outputLimit) { this.child.kill('SIGKILL'); rejectAll(new Error('Codex app-server exceeded output limit')); return; }
      buffered += decoder.write(chunk);
      for (;;) { const newline = buffered.indexOf('\n'); if (newline < 0) break; receive(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1); }
    });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = `client-${this.nextId++}`;
    this.clientRequests.push({
      id,
      method,
      thread_id: typeof params?.threadId === 'string' ? params.threadId : null,
      at_ms: Date.now(),
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`Codex app-server ${method} timed out`)); }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error && this.pending.delete(String(id))) { clearTimeout(timer); reject(error); }
      });
    });
  }

  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'cursor-skill-evals', version: '1' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    return result;
  }

  startThread(params = {}) { return this.request('thread/start', params); }

  async captureTurnFinal(threadId, turnId, options = {}) {
    if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) throw new Error('invalid turn capture identity');
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const pageLimit = options.pageLimit ?? CAPTURE_PAGE_LIMIT;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0
      || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > CAPTURE_PAGE_LIMIT) throw new Error('invalid turn capture limits');
    const deadline = this.captureNow() + timeoutMs;
    let latest = captureFailure(turnId, null, 'turn_not_found');
    let attempted = false;
    for (;;) {
      if (attempted && this.captureNow() >= deadline) return latest;
      attempted = true;
      let turnPage;
      try { turnPage = await this.#findTurn(threadId, turnId, pageLimit, deadline); }
      catch (error) { return captureFailure(turnId, null, error?.message?.endsWith(' timed out') ? 'capture_timeout' : 'request_failed'); }
      if (turnPage.error) return captureFailure(turnId, turnPage.status, turnPage.error);
      const turn = turnPage.turn;
      if (!turn) latest = captureFailure(turnId, null, 'turn_not_found');
      else if (!TERMINAL_TURN_STATUSES.has(turn.status)) latest = captureFailure(turnId, turn.status, 'turn_not_terminal');
      else {
        let captured;
        try { captured = await this.#readTurnFinal(threadId, turnId, pageLimit, deadline); }
        catch (error) {
          return captureFailure(turnId, turn.status, error?.message?.endsWith(' timed out') ? 'capture_timeout' : 'request_failed', 'thread/items/list');
        }
        if (captured.error) return captureFailure(turnId, turn.status, captured.error, 'thread/items/list');
        if (captured.found) {
          if (Buffer.byteLength(captured.text, 'utf8') > CAPTURE_TEXT_LIMIT) {
            return captureFailure(turnId, turn.status, 'capture_text_limit', 'thread/items/list');
          }
          return finalCapture(turnId, turn.status, captured.text, captured.phase, 'complete');
        }
        latest = finalCapture(turnId, turn.status, null, null, 'confirmed_missing');
      }
      if (this.captureNow() >= deadline) return latest;
      await this.captureSleep(Math.min(pollIntervalMs, Math.max(0, deadline - this.captureNow())));
    }
  }

  async #findTurn(threadId, turnId, pageLimit, deadline) {
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < pageLimit; page += 1) {
      const remainingMs = deadline - this.captureNow();
      if (remainingMs <= 0) return { turn: null, status: null, error: 'capture_timeout' };
      const result = await this.request('thread/turns/list', {
        threadId, cursor, limit: CAPTURE_PAGE_SIZE, sortDirection: 'desc', itemsView: 'notLoaded',
      }, remainingMs);
      if (!result || !Array.isArray(result.data) || !(typeof result.nextCursor === 'string' || result.nextCursor === null)) {
        return { turn: null, status: null, error: 'invalid_turns_response' };
      }
      if (result.data.some((item) => !item || typeof item.id !== 'string' || !TURN_STATUSES.has(item.status))) {
        return { turn: null, status: null, error: 'invalid_turns_response' };
      }
      const turn = result.data.find((item) => item?.id === turnId);
      if (turn) {
        return { turn, status: turn.status, error: null };
      }
      if (result.nextCursor === null) return { turn: null, status: null, error: null };
      if (seen.has(result.nextCursor)) return { turn: null, status: null, error: 'pagination_cursor_cycle' };
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return { turn: null, status: null, error: 'capture_page_limit' };
  }

  async #readTurnFinal(threadId, turnId, pageLimit, deadline) {
    let cursor = null;
    let explicitFinal = null;
    let legacyFinal = null;
    const seen = new Set();
    for (let page = 0; page < pageLimit; page += 1) {
      const remainingMs = deadline - this.captureNow();
      if (remainingMs <= 0) return { found: false, error: 'capture_timeout' };
      const result = await this.request('thread/items/list', {
        threadId, turnId, cursor, limit: CAPTURE_PAGE_SIZE, sortDirection: 'asc',
      }, remainingMs);
      if (!result || !Array.isArray(result.data) || !(typeof result.nextCursor === 'string' || result.nextCursor === null)) {
        return { found: false, error: 'invalid_items_response' };
      }
      for (const entry of result.data) {
        if (!entry || entry.turnId !== turnId || !entry.item || typeof entry.item.type !== 'string') {
          return { found: false, error: 'invalid_items_response' };
        }
        if (entry.item.type !== 'agentMessage') continue;
        if (typeof entry.item.id !== 'string' || !entry.item.id || typeof entry.item.text !== 'string'
          || !['commentary', 'final_answer', null].includes(entry.item.phase)) {
          return { found: false, error: 'invalid_items_response' };
        }
        if (entry.item.phase === 'final_answer') explicitFinal = { text: entry.item.text, phase: 'final_answer' };
        else if (entry.item.phase === null) legacyFinal = { text: entry.item.text, phase: null };
      }
      if (result.nextCursor === null) {
        const selected = explicitFinal ?? legacyFinal;
        return selected ? { ...selected, found: true, error: null } : { found: false, error: null };
      }
      if (seen.has(result.nextCursor)) return { found: false, error: 'pagination_cursor_cycle' };
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return { found: false, error: 'capture_page_limit' };
  }

  archiveThread(threadId) {
    if (typeof threadId !== 'string' || !threadId) return Promise.reject(new Error('invalid thread id'));
    return this.request('thread/archive', { threadId });
  }

  startTurn({ threadId, text, skill, pluginName }) {
    if (typeof threadId !== 'string' || typeof text !== 'string' || !skill || typeof skill.name !== 'string' || typeof skill.path !== 'string' || typeof pluginName !== 'string' || !pluginName) throw new Error('invalid versioned turn input');
    return this.request('turn/start', { threadId, input: [
      { type: 'text', text, text_elements: [] }, { type: 'skill', name: skill.name, path: skill.path },
      { type: 'mention', name: pluginName, path: `plugin://${pluginName}` },
    ] });
  }

  async skillLoadEvidence(cwd, skillName) {
    const result = await this.request('skills/list', { cwds: [cwd], forceReload: true });
    const skills = result?.data?.find((entry) => entry?.cwd === cwd)?.skills;
    if (!Array.isArray(skills)) throw new Error('Codex app-server returned invalid skills/list response');
    const skill = skills.find((item) => item?.name === skillName && item.enabled === true && typeof item.path === 'string');
    if (!skill) throw new Error(`required skill is not loaded: ${skillName}`);
    let content;
    try { content = await this.readSkillFile(skill.path); }
    catch (error) { throw new Error(`loaded skill content is unreadable: ${skillName}`, { cause: error }); }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return {
      name: skill.name,
      path: skill.path,
      plugin_id: skill.pluginId ?? null,
      enabled: skill.enabled,
      content_sha256: createHash('sha256').update(bytes).digest('hex'),
      content_bytes: bytes.length,
    };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.child.stdin.end();
    this.closePromise = new Promise((resolve, reject) => {
      let killTimer; let confirmTimer;
      const finish = (result) => {
        clearTimeout(termTimer); clearTimeout(killTimer); clearTimeout(confirmTimer);
        this.child.removeListener('close', onClose);
        result();
      };
      const onClose = () => finish(resolve);
      const termTimer = setTimeout(() => {
        this.child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          this.child.kill('SIGKILL');
          confirmTimer = setTimeout(() => finish(() => reject(new Error('Codex app-server did not close after SIGKILL'))), this.closeConfirmMs);
        }, this.killGraceMs);
      }, this.closeGraceMs);
      this.child.once('close', onClose);
      if (this.child.exitCode !== null || this.child.signalCode !== null) finish(resolve);
    });
    return this.closePromise;
  }
}
