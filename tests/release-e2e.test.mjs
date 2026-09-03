import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeManifestBytes, runBootstrap } from '../scripts/cursor-subagent-bootstrap.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fakeAdapter = fileURLToPath(new URL('./fixtures/fake-codex-adapter.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/release-fake-acp.mjs', import.meta.url));
const fakeMcpVersion = fileURLToPath(new URL('./fixtures/fake-mcp-version.mjs', import.meta.url));
const EXPECTED_TOOLS = [
  'cursor_delegate', 'cursor_start_session', 'cursor_send_prompt', 'cursor_session_status', 'cursor_wait',
  'cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission', 'cursor_cancel', 'cursor_close_session',
];
const MARKER_BYTES = 'CURSOR_AGENT_E2E_OK\n';
const RELEASE_PROCESS_LIMITS = Object.freeze({ timeoutMs: 10_000, outputBytes: 1_048_576 });
const MANAGED_PLUGIN_ID = 'codex-cursor-subagent-plugin';

async function copyPayload(destination) {
  await mkdir(destination);
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(destination, path, '..'), { recursive: true });
    await cp(join(repository, path), join(destination, path));
  }
  await cp(join(repository, 'skills'), join(destination, 'skills'), { recursive: true });
}

async function makeLayout(prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const source = join(root, 'source'); const workspace = join(root, 'workspace');
  await copyPayload(source); await mkdir(workspace);
  return {
    root, source, hiddenSource: join(root, 'source.hidden'), workspace,
    managed: join(root, 'managed-marketplace'), configRoot: join(root, 'codex-config'),
    state: join(root, 'adapter-state.json'), markerPath: join(workspace, 'cursor-agent-e2e.marker'),
  };
}

function parseCommand(raw, name) {
  let command;
  try { command = JSON.parse(raw); } catch { throw new Error(`${name} must be a JSON array`); }
  if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === 'string') || !command[0].startsWith('/')) throw new Error(`${name} must be an absolute command JSON array`);
  return command;
}

export async function invokeReleaseAdapter(command, operation, request, env, limits = RELEASE_PROCESS_LIMITS) {
  const child = spawn(command[0], [...command.slice(1), operation, JSON.stringify(request)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = []; const stderr = []; let bytes = 0; let overflow = false; let timer;
  const completion = new Promise((resolveExit, reject) => {
    for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limits.outputBytes) { overflow = true; child.kill('SIGKILL'); } else target.push(chunk);
    });
    child.once('error', reject); child.once('close', resolveExit);
  });
  const timed = new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`adapter ${operation} timed out`)); }, limits.timeoutMs); });
  let code;
  try { code = await Promise.race([completion, timed]); } finally { clearTimeout(timer); }
  if (overflow) throw new Error(`adapter ${operation} exceeded output limit`);
  if (code !== 0) throw new Error(`adapter ${operation} failed: ${Buffer.concat(stderr).toString('utf8')}`);
  try { return JSON.parse(Buffer.concat(stdout).toString('utf8')); }
  catch { throw new Error(`adapter ${operation} returned invalid JSON`); }
}

export class McpClient {
  constructor(command, args, env) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); this.nextId = 1; this.pending = new Map(); this.stderr = [];
    this.child.stderr.on('data', (chunk) => this.stderr.push(chunk));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(String(message.id)); if (!waiter) return;
      this.pending.delete(String(message.id)); clearTimeout(waiter.timer); waiter.resolve(message);
    });
    this.exit = new Promise((resolveExit) => this.child.once('close', (code, signal) => resolveExit({ code, signal })));
    const rejectPending = (error) => {
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      this.pending.clear();
    };
    this.child.once('error', (error) => rejectPending(error));
    this.child.once('close', (code) => rejectPending(new Error(`MCP exited with code ${code}`)));
  }

  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`MCP ${method} timed out`)); }, timeoutMs);
      this.pending.set(String(id), { resolve: resolveRequest, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error && this.pending.delete(String(id))) { clearTimeout(timer); reject(error); }
      });
    });
  }

  async tool(name, args) {
    const response = await this.request('tools/call', { name, arguments: args }, 65_000);
    if (response.error) throw new Error(response.error.message || `MCP ${name} error`);
    const result = response.result;
    if (!result?.content?.[0] || result.content[0].type !== 'text') throw new Error(`MCP ${name} returned invalid tool result`);
    const envelope = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(`MCP ${name}: ${envelope.error_code || 'unknown'}: ${envelope.message || ''}`);
    return envelope;
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      if (this.child.exitCode !== 0) throw new Error(`MCP exited with code ${this.child.exitCode ?? this.child.signalCode}: ${Buffer.concat(this.stderr).toString('utf8')}`);
      return;
    }
    this.child.stdin.end();
    let timer;
    const exited = await Promise.race([this.exit, new Promise((resolveWait) => { timer = setTimeout(() => resolveWait(null), 6_000); })]);
    clearTimeout(timer);
    if (!exited) { this.child.kill('SIGKILL'); await this.exit; throw new Error(`MCP close timed out: ${Buffer.concat(this.stderr).toString('utf8')}`); }
    if (exited.code !== 0) throw new Error(`MCP exited with code ${exited.code ?? exited.signal}: ${Buffer.concat(this.stderr).toString('utf8')}`);
  }
}

async function installAndDiscover(layout, executables, adapterCommand, env, runtimeEnv = {}) {
  await mkdir(layout.configRoot);
  const bootstrapEnv = {
    ...env, CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify(adapterCommand),
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: layout.configRoot, CODEX_HOME: layout.configRoot,
  };
  const installed = await runBootstrap(['install', '--source-root', layout.source,
    '--managed-marketplace-root', layout.managed, '--node-executable', executables.node,
    '--codex-executable', executables.codex, '--agent-executable', executables.agent,
    '--allowed-workspace-root', layout.workspace], { env: bootstrapEnv });
  if (installed.exitCode !== 0 || installed.envelope.state !== 'installed') throw new Error(`bootstrap install failed: ${JSON.stringify(installed.envelope)}`);

  const adapterRequest = { codex_executable: executables.codex };
  const marketplaces = await invokeReleaseAdapter(adapterCommand, 'marketplace-list', adapterRequest, bootstrapEnv);
  const plugins = await invokeReleaseAdapter(adapterCommand, 'plugin-list', adapterRequest, bootstrapEnv);
  const manifestPath = join(layout.managed, 'plugins/codex-cursor-subagent-plugin/.codex-plugin/plugin.json');
  const installedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(marketplaces.registrations.filter(({ id }) => id === MANAGED_PLUGIN_ID),
    [{ id: MANAGED_PLUGIN_ID, path: layout.managed }], 'managed marketplace registration differs');
  assert.deepEqual(plugins.registrations.filter(({ id }) => id === MANAGED_PLUGIN_ID),
    [{ id: MANAGED_PLUGIN_ID, marketplace_id: MANAGED_PLUGIN_ID,
      source: join(layout.managed, 'plugins/codex-cursor-subagent-plugin'), version: installedManifest.version }],
    'managed plugin registration differs');

  const configPath = join(layout.managed, 'plugins/codex-cursor-subagent-plugin/.mcp.json');
  const manifest = normalizeManifestBytes(JSON.stringify(installedManifest));
  const document = JSON.parse(await readFile(configPath, 'utf8'));
  const config = document.mcpServers?.['cursor-subagent'] || document;
  if (typeof config.command !== 'string' || !Array.isArray(config.args) || !config.env || typeof config.env !== 'object') throw new Error('adapter-owned MCP configuration has invalid shape');
  await rename(layout.source, layout.hiddenSource);
  const client = new McpClient(config.command, config.args, { ...bootstrapEnv, ...config.env, ...runtimeEnv });
  try {
    const initialized = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-e2e', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'cursor-subagent');
    assert.equal(initialized.result.serverInfo.version, manifest.baseVersion, 'installed manifest and MCP server versions differ');
    client.notify('notifications/initialized');
    const listed = await client.request('tools/list');
    assert.deepEqual(listed.result.tools.map(({ name }) => name), EXPECTED_TOOLS);
    return client;
  } catch (error) { await client.close().catch(() => {}); throw error; }
}

async function deterministicReleaseGate(t) {
  const layout = await makeLayout('cursor-release-fake-'); t.after(() => rm(layout.root, { recursive: true, force: true }));
  const executable = await realpath(process.execPath);
  const env = { ...process.env, FAKE_CODEX_STATE: layout.state, FAKE_CODEX_EXPECT_CONFIG_ROOT: layout.configRoot,
    FAKE_ACP_EXPECT_CODEX_HOME: layout.configRoot };
  const client = await installAndDiscover(layout, { node: executable, codex: executable, agent: executable }, [executable, fakeAdapter], env, {
    CURSOR_AGENT_COMMAND: executable, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
  });
  const delegated = await client.tool('cursor_delegate', { cwd: layout.workspace, mode: 'agent', prompt: 'Return the deterministic fake ACP result.' });
  assert.equal(delegated.session_state, 'live'); assert.ok(delegated.session_id); assert.ok(delegated.turn_id);
  const waited = await client.tool('cursor_wait', { session_id: delegated.session_id, turn_id: delegated.turn_id, after_event_id: 0, timeout_ms: 1_000 });
  assert.equal(waited.session_id, delegated.session_id); assert.equal(waited.turn_id, delegated.turn_id); assert.equal(waited.turn_status, 'completed');
  await client.tool('cursor_close_session', { session_id: delegated.session_id });
  await client.close(); return { status: 'pass' };
}

function liveConfiguration(env) {
  for (const name of ['CURSOR_SUBAGENT_LIVE_CODEX_EXECUTABLE', 'CURSOR_SUBAGENT_LIVE_AGENT_EXECUTABLE', 'CURSOR_SUBAGENT_LIVE_ADAPTER_COMMAND']) {
    if (!env[name]) throw new Error(`${name} is required when live E2E is enabled`);
  }
  let adapterEnvironment = {};
  if (env.CURSOR_SUBAGENT_LIVE_ADAPTER_ENV) {
    try { adapterEnvironment = JSON.parse(env.CURSOR_SUBAGENT_LIVE_ADAPTER_ENV); } catch { throw new Error('CURSOR_SUBAGENT_LIVE_ADAPTER_ENV must be a JSON object'); }
    if (!adapterEnvironment || Array.isArray(adapterEnvironment) || typeof adapterEnvironment !== 'object' || !Object.values(adapterEnvironment).every((value) => typeof value === 'string')) throw new Error('CURSOR_SUBAGENT_LIVE_ADAPTER_ENV must contain only string values');
  }
  return {
    codex: env.CURSOR_SUBAGENT_LIVE_CODEX_EXECUTABLE,
    agent: env.CURSOR_SUBAGENT_LIVE_AGENT_EXECUTABLE,
    adapterCommand: parseCommand(env.CURSOR_SUBAGENT_LIVE_ADAPTER_COMMAND, 'CURSOR_SUBAGENT_LIVE_ADAPTER_COMMAND'),
    adapterEnvironment,
  };
}

async function inspectMarker(markerPath) {
  try {
    const canonical = await realpath(markerPath); const info = await lstat(markerPath);
    if (canonical !== markerPath || !info.isFile() || info.isSymbolicLink()) return { inspected: true, matches: false };
    return { inspected: true, matches: await readFile(markerPath, 'utf8') === MARKER_BYTES };
  } catch (error) {
    if (error.code === 'ENOENT') return { inspected: true, matches: false };
    throw error;
  }
}

function exactPermission(turn, markerPath, alreadyAllowed) {
  const pending = turn.active_turn?.pending || [];
  if (alreadyAllowed || pending.length !== 1 || pending[0].kind !== 'permission') throw new Error('unexpected pending request');
  const locations = pending[0].context?.locations || [];
  if (locations.length === 0 || locations.some((location) => location.path?.text !== markerPath)) throw new Error('permission location is outside the exact marker path');
  return pending[0];
}

export function terminalAgentError(turn) {
  return /^\s*Error:/.test(turn?.last_terminal_turn?.result?.text || '');
}

export function classifyLiveOutcome({ enabled, failure = null, closeSucceeded = false, markerMatches = false }) {
  if (!enabled) return { status: 'skipped' };
  if (failure) return { status: 'integration_failure', message: failure };
  if (!closeSucceeded) return { status: 'integration_failure', message: 'finally close failed' };
  return markerMatches ? { status: 'pass' } : { status: 'agent_behavior_mismatch' };
}

export async function closeCanaryClient(client, turn) {
  const failures = [];
  try {
    if (turn?.session_id) await client.tool('cursor_close_session', { session_id: turn.session_id });
  } catch (error) { failures.push(`tool close failed: ${error.message}`); }
  try { await client.close(); } catch (error) { failures.push(`transport close failed: ${error.message}`); }
  return failures.length ? { ok: false, message: failures.join('; ') } : { ok: true, message: null };
}

export async function runLiveCanary(env = process.env, hooks = {}) {
  if (env.CURSOR_SUBAGENT_LIVE_E2E !== '1') return { status: 'skipped' };
  let layout; let client; let turn; let closeSucceeded = false; let completed = false; let failure = null; let permissionAllowed = false;
  try {
    const configuration = liveConfiguration(env);
    const make = hooks.makeLayout || (() => makeLayout('cursor-release-live-'));
    layout = await make();
    const node = await realpath(process.execPath); const codex = await realpath(configuration.codex); const agent = await realpath(configuration.agent);
    const childEnv = { ...env, ...configuration.adapterEnvironment, CODEX_HOME: layout.configRoot,
      CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: layout.configRoot };
    client = await installAndDiscover(layout, { node, codex, agent }, configuration.adapterCommand, childEnv);
    const built = await invokeReleaseAdapter(configuration.adapterCommand, 'canary-prompt', {
      codex_executable: codex, marker_path: layout.markerPath, marker_bytes: MARKER_BYTES,
    }, childEnv);
    if (typeof built.prompt !== 'string' || !built.prompt || Buffer.byteLength(built.prompt) > 64_000) throw new Error('adapter canary prompt shape is invalid');
    turn = await client.tool('cursor_delegate', { cwd: layout.workspace, mode: 'agent', prompt: built.prompt });
    if (turn.session_state !== 'live' || !turn.session_id || !turn.turn_id) throw new Error('delegate did not allocate a live turn');
    for (let count = 0; count < 12; count += 1) {
      turn = await client.tool('cursor_wait', { session_id: turn.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 60_000 });
      if (turn.turn_status === 'completed') {
        if (terminalAgentError(turn)) throw new Error('agent completed with an error');
        completed = true; break;
      }
      if (turn.turn_status === 'waiting_for_input') {
        const pending = exactPermission(turn, layout.markerPath, permissionAllowed); permissionAllowed = true;
        turn = await client.tool('cursor_answer_permission', { session_id: turn.session_id, turn_id: turn.turn_id, request_id: pending.request_id, decision: 'allow-once' });
      } else if (!['running'].includes(turn.turn_status)) throw new Error(`unexpected terminal turn: ${turn.turn_status}`);
    }
    if (!completed) throw new Error('live canary did not complete within bounded waits');
  } catch (error) {
    failure = error;
  } finally {
    if (client) {
      const closed = await closeCanaryClient(client, turn); closeSucceeded = closed.ok;
      if (!closed.ok && !failure) failure = new Error(closed.message);
    }
  }
  let markerMatches = false; let inspectionFailure = null;
  if (!failure && closeSucceeded) {
    try {
      const marker = await inspectMarker(layout.markerPath);
      markerMatches = marker.matches;
    } catch (error) { inspectionFailure = `marker inspection failed: ${error.message}`; }
  }
  let outcome = classifyLiveOutcome({ enabled: true, failure: failure?.message || inspectionFailure, closeSucceeded, markerMatches });
  if (layout) await rm(layout.root, { recursive: true, force: true }).catch((error) => {
    outcome = { status: 'integration_failure', message: `temporary layout cleanup failed: ${error.message}` };
  });
  return outcome;
}

test('credential-free release gate installs, discovers and starts the published MCP payload', deterministicReleaseGate);

test('release discovery accepts unrelated marketplaces while requiring one exact managed tuple', async (t) => {
  const layout = await makeLayout('cursor-release-neighbour-'); t.after(() => rm(layout.root, { recursive: true, force: true }));
  const executable = await realpath(process.execPath);
  const env = { ...process.env, FAKE_CODEX_STATE: layout.state, FAKE_CODEX_EXPECT_CONFIG_ROOT: layout.configRoot,
    FAKE_ACP_EXPECT_CODEX_HOME: layout.configRoot };
  await writeFile(layout.state, JSON.stringify({
    marketplaces: [{ id: 'personal', path: '/Users/example' }],
    plugins: [{ id: 'unrelated-plugin', marketplace_id: 'personal', source: '/Users/example/plugins/unrelated-plugin', version: '1.0.0' }],
    mutations: [],
  }));
  const client = await installAndDiscover(layout, { node: executable, codex: executable, agent: executable }, [executable, fakeAdapter], env, {
    CURSOR_AGENT_COMMAND: executable, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
  });
  await client.close();
});

test('release adapter calls enforce timeout and aggregate output cap', async () => {
  const executable = await realpath(process.execPath);
  await assert.rejects(invokeReleaseAdapter([executable, fakeAdapter], 'help', { codex_executable: executable },
    { ...process.env, FAKE_CODEX_BLOCK_OPERATION: 'help' }, { timeoutMs: 25, outputBytes: 1_048_576 }), /timed out/);
  await assert.rejects(invokeReleaseAdapter([executable, fakeAdapter], 'help', { codex_executable: executable },
    { ...process.env, FAKE_CODEX_READ_OVERFLOW_OPERATION: 'help' }, { timeoutMs: 1_000, outputBytes: 64 }), /output limit/);
});

test('MCP transport close rejects a nonzero child exit', async () => {
  const client = new McpClient(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(7))'], process.env);
  await assert.rejects(client.close(), /exited with code 7/);
});

test('canary finally closes transport even when cursor_close_session fails', async () => {
  const calls = [];
  const result = await closeCanaryClient({
    tool: async () => { calls.push('tool'); throw new Error('injected tool close'); },
    close: async () => { calls.push('transport'); },
  }, { session_id: 'session' });
  assert.deepEqual(calls, ['tool', 'transport']); assert.equal(result.ok, false); assert.match(result.message, /tool close failed/);
});

test('release discovery rejects a server version different from the installed manifest and closes the client', async (t) => {
  const layout = await makeLayout('cursor-release-version-'); t.after(() => rm(layout.root, { recursive: true, force: true }));
  const executable = await realpath(process.execPath);
  const closeMarker = join(layout.root, 'mcp-closed');
  const env = { ...process.env, FAKE_CODEX_STATE: layout.state, FAKE_CODEX_MCP_COMMAND: executable,
    FAKE_CODEX_MCP_ARGS: JSON.stringify([fakeMcpVersion]) };
  await assert.rejects(installAndDiscover(layout, { node: executable, codex: executable, agent: executable },
    [executable, fakeAdapter], env, { FAKE_MCP_CLOSE_MARKER: closeMarker }), /manifest and MCP server versions differ/);
  assert.equal(await readFile(closeMarker, 'utf8'), 'closed');
});

test('live canary admits at most one exact-path permission', () => {
  const marker = '/tmp/exact-marker';
  const turn = { active_turn: { pending: [{ request_id: 'one', kind: 'permission', context: { locations: [{ path: { text: marker } }] } }] } };
  assert.equal(exactPermission(turn, marker, false).request_id, 'one');
  assert.throws(() => exactPermission(turn, marker, true), /unexpected pending request/);
  assert.throws(() => exactPermission(turn, '/tmp/other', false), /outside the exact marker path/);
});

test('live result classifier covers every terminal outcome deterministically', () => {
  assert.deepEqual(classifyLiveOutcome({ enabled: false }), { status: 'skipped' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, failure: 'boom', closeSucceeded: true }), { status: 'integration_failure', message: 'boom' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, closeSucceeded: false }), { status: 'integration_failure', message: 'finally close failed' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, closeSucceeded: true, markerMatches: false }), { status: 'agent_behavior_mismatch' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, closeSucceeded: true, markerMatches: true }), { status: 'pass' });
  assert.equal(terminalAgentError({ last_terminal_turn: { result: { text: '\nError: RetriableError' } } }), true);
  assert.equal(terminalAgentError({ last_terminal_turn: { result: { text: 'Created the marker.' } } }), false);
});

test('enabled live canary rejects missing explicit adapter configuration before side effects', async () => {
  let layoutCalls = 0;
  const outcome = await runLiveCanary({ CURSOR_SUBAGENT_LIVE_E2E: '1' }, {
    makeLayout: async () => { layoutCalls += 1; return makeLayout('cursor-release-invalid-'); },
  });
  assert.equal(outcome.status, 'integration_failure'); assert.equal(layoutCalls, 0);
});

test('live release canary is opt-in and classified without hidden retry', async (t) => {
  let layoutCalls = 0;
  const outcome = await runLiveCanary(process.env, { makeLayout: async () => { layoutCalls += 1; return makeLayout('cursor-release-live-'); } });
  t.diagnostic(`live release result: ${outcome.status}`);
  if (process.env.CURSOR_SUBAGENT_LIVE_E2E === '1') assert.deepEqual(outcome, { status: 'pass' }, JSON.stringify(outcome));
  else { assert.deepEqual(outcome, { status: 'skipped' }); assert.equal(layoutCalls, 0); }
});
