import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const OUTPUT_LIMIT = 1_048_576;

export class CodexAppServerClient {
  constructor(command, args = ['app-server', '--stdio'], env = process.env, options = {}) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.outputLimit = options.outputLimit ?? OUTPUT_LIMIT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.closeGraceMs = options.closeGraceMs ?? 1_000;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.closeConfirmMs = options.closeConfirmMs ?? 1_000;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
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
        else this.notifications.push({ method: message.method, params: message.params ?? null });
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
