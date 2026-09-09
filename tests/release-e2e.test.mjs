import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER_NAME, normalizeManifestBytes, runBootstrap } from '../scripts/cursor-subagent-bootstrap.mjs';
import { materializeScenario, parseScenarioCorpus } from '../scripts/cursor-eval-scenario.mjs';
import { readEvaluatorInventory } from '../scripts/cursor-skill-eval.mjs';
import { parseChildResult } from '../scripts/run-cursor-skill-eval.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fakeAdapter = fileURLToPath(new URL('./fixtures/fake-codex-adapter.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/release-fake-acp.mjs', import.meta.url));
const modelDiscoveryPreload = fileURLToPath(new URL('./fixtures/release-model-discovery-preload.mjs', import.meta.url));
const modelCatalogFixture = fileURLToPath(new URL('./fixtures/cursor-model-catalog-1.0.31.json', import.meta.url));
const fakeMcpVersion = fileURLToPath(new URL('./fixtures/fake-mcp-version.mjs', import.meta.url));
const EXPECTED_TOOLS = [
  'cursor_list_models', 'cursor_delegate', 'cursor_start_session', 'cursor_resume_session', 'cursor_send_prompt', 'cursor_set_mode', 'cursor_session_status', 'cursor_wait',
  'cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission', 'cursor_cancel', 'cursor_close_session', 'cursor_read_result',
];
const MARKER_BYTES = 'CURSOR_AGENT_E2E_OK\n';
const RELEASE_PROCESS_LIMITS = Object.freeze({ timeoutMs: 10_000, outputBytes: 1_048_576 });
const MANAGED_PLUGIN_ID = 'agents-cursor-subagent-plugin';
const SHA256 = /^[0-9a-f]{64}$/;
const releaseCorpus = parseScenarioCorpus(await readFile(join(repository, 'evals/cursor-subagent-scenarios.v1.json'), 'utf8'));
const packageCanaryScenario = releaseCorpus.scenarios.find(({ scenario_kind: kind }) => kind === 'package-canary-reference');
const packageCanaryId = packageCanaryScenario.scenario_id;

function digestBytes(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function outerReleaseHandoff(env) {
  if (!env.CURSOR_EVAL_SCENARIO_PAYLOAD) return null;
  const required = ['CURSOR_EVAL_SCENARIO_SHA256', 'CURSOR_EVAL_SCENARIO_BYTES', 'CURSOR_EVAL_CORPUS_SHA256',
    'CURSOR_EVAL_CORPUS_BYTES', 'CURSOR_EVAL_CHILD_RESULT'];
  for (const name of required) if (!env[name]) throw new Error(`${name} is required with CURSOR_EVAL_SCENARIO_PAYLOAD`);
  let scenario;
  try { scenario = JSON.parse(env.CURSOR_EVAL_SCENARIO_PAYLOAD); }
  catch { throw new Error('CURSOR_EVAL_SCENARIO_PAYLOAD must be valid JSON'); }
  const materialized = materializeScenario(scenario);
  const scenarioBytes = Number(env.CURSOR_EVAL_SCENARIO_BYTES); const corpusBytes = Number(env.CURSOR_EVAL_CORPUS_BYTES);
  if (materialized.materializedScenario.scenario_kind !== 'package-canary-reference' || materialized.materializedScenario.lane !== 'full-live') throw new Error('release canary requires the corpus-owned full-live package-canary-reference');
  if (!SHA256.test(env.CURSOR_EVAL_SCENARIO_SHA256) || materialized.digest.sha256 !== env.CURSOR_EVAL_SCENARIO_SHA256 || materialized.digest.bytes !== scenarioBytes) throw new Error('outer scenario digest does not match the consumed package canary reference');
  if (!SHA256.test(env.CURSOR_EVAL_CORPUS_SHA256) || !Number.isSafeInteger(corpusBytes) || corpusBytes < 1) throw new Error('outer corpus digest is invalid');
  return {
    scenario: materialized.materializedScenario, childResultPath: env.CURSOR_EVAL_CHILD_RESULT,
    scenarioDigest: materialized.digest, corpusDigest: { sha256: env.CURSOR_EVAL_CORPUS_SHA256, bytes: corpusBytes },
  };
}

async function writeReleaseChildResult(destination, result) {
  const encoded = JSON.stringify({ schema_version: 1, ...result });
  if (Buffer.byteLength(encoded, 'utf8') > 1_048_576) throw new Error('release child result exceeded 1 MiB');
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(temporary, encoded, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, destination);
}

async function copyPayload(destination) {
  await mkdir(destination);
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/cursor-model-adapter.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
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
  const manifestPath = join(layout.managed, 'plugins/agents-cursor-subagent-plugin/.codex-plugin/plugin.json');
  const installedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(marketplaces.registrations.filter(({ id }) => id === MANAGED_PLUGIN_ID),
    [{ id: MANAGED_PLUGIN_ID, path: layout.managed }], 'managed marketplace registration differs');
  assert.deepEqual(plugins.registrations.filter(({ id }) => id === MANAGED_PLUGIN_ID),
    [{ id: MANAGED_PLUGIN_ID, marketplace_id: MANAGED_PLUGIN_ID,
      source: join(layout.managed, 'plugins/agents-cursor-subagent-plugin'), version: installedManifest.version }],
    'managed plugin registration differs');

  const configPath = join(layout.managed, 'plugins/agents-cursor-subagent-plugin/.mcp.json');
  const manifest = normalizeManifestBytes(JSON.stringify(installedManifest));
  const document = JSON.parse(await readFile(configPath, 'utf8'));
  const config = document.mcpServers?.['cursor-subagent'] || document;
  if (typeof config.command !== 'string' || !Array.isArray(config.args) || !config.env || typeof config.env !== 'object') throw new Error('adapter-owned MCP configuration has invalid shape');
  await rename(layout.source, layout.hiddenSource);
  const clientEnv = { ...bootstrapEnv, ...config.env, ...runtimeEnv };
  // Undefined overrides explicitly remove inherited test injection from live runs.
  for (const [name, value] of Object.entries(clientEnv)) if (value === undefined) delete clientEnv[name];
  const client = new McpClient(config.command, config.args, clientEnv);
  try {
    const initialized = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-e2e', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'cursor-subagent');
    assert.equal(initialized.result.serverInfo.version, manifest.baseVersion, 'installed manifest and MCP server versions differ');
    client.notify('notifications/initialized');
    const listed = await client.request('tools/list');
    assert.deepEqual(listed.result.tools.map(({ name }) => name).sort(), [...EXPECTED_TOOLS].sort());
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
    NODE_OPTIONS: `--import=${modelDiscoveryPreload}`, RELEASE_MODEL_CATALOG: modelCatalogFixture,
    FAKE_ACP_LOG: join(layout.root, 'acp.jsonl'), FAKE_ACP_PICKER_FROM_ARGV: '1',
  });
  t.after(() => client.close());
  const catalog = await client.tool('cursor_list_models', {});
  const fixedModel = catalog.models.find(({ id }) => !['default', 'auto-smart'].includes(id));
  const autoModel = catalog.models.find(({ id }) => id === 'auto-smart');
  assert.ok(fixedModel); assert.ok(autoModel?.optimize_for.includes('cost'));
  await assert.rejects(readFile(join(layout.root, 'acp.jsonl')), { code: 'ENOENT' });
  const delegated = await client.tool('cursor_delegate', { cwd: layout.workspace, mode: 'agent', model: fixedModel.id, prompt: 'Return the deterministic fake ACP result.' });
  assert.equal(delegated.session_state, 'live'); assert.ok(delegated.session_id); assert.ok(delegated.turn_id);
  let waited = delegated;
  for (let count = 0; count < 5 && waited.turn_status !== 'completed'; count += 1) {
    waited = await client.tool('cursor_wait', { session_id: delegated.session_id, turn_id: delegated.turn_id, after_event_id: waited.last_event_id, timeout_ms: 1_000 });
  }
  assert.equal(waited.session_id, delegated.session_id); assert.equal(waited.turn_id, delegated.turn_id); assert.equal(waited.turn_status, 'completed');
  await client.tool('cursor_close_session', { session_id: delegated.session_id });
  const auto = await client.tool('cursor_start_session', { cwd: layout.workspace, mode: 'ask', model: autoModel.id, optimize_for: 'cost' });
  assert.equal(auto.session_state, 'live'); assert.equal(auto.model, autoModel.id); assert.equal(auto.optimize_for, 'cost');
  await client.tool('cursor_close_session', { session_id: auto.session_id });
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

async function captureReleaseProof(layout, configuration, executables, childEnv) {
  const preflight = await runBootstrap(['preflight', '--managed-marketplace-root', layout.managed,
    '--node-executable', executables.node, '--codex-executable', executables.codex,
    '--agent-executable', executables.agent], { env: childEnv });
  if (preflight.exitCode !== 0 || preflight.envelope.state !== 'ready') throw new Error(`bootstrap preflight failed: ${JSON.stringify(preflight.envelope)}`);
  const [skillBytes, marker, adapter] = await Promise.all([
    readFile(join(layout.managed, 'plugins/agents-cursor-subagent-plugin/skills/cursor-subagent/SKILL.md')),
    readFile(join(layout.managed, MARKER_NAME), 'utf8').then(JSON.parse),
    invokeReleaseAdapter(configuration.adapterCommand, 'admit', { codex_executable: executables.codex }, childEnv),
  ]);
  if (!SHA256.test(adapter.implementation_sha256 || '') || !Number.isSafeInteger(adapter.implementation_bytes) || adapter.implementation_bytes < 1 || typeof adapter.codex_version !== 'string' || !adapter.codex_version) throw new Error('adapter admission omitted normalized implementation proof');
  if (marker.format !== 1 || !SHA256.test(marker.payload_hash || '') || !SHA256.test(marker.artifact_hash || '') || typeof marker.manifest_version !== 'string' || !marker.manifest_version) throw new Error('installed package marker has invalid proof fields');
  return {
    adapter: { sha256: adapter.implementation_sha256, bytes: adapter.implementation_bytes },
    managedInstalledSkill: digestBytes(skillBytes),
    installedPayload: { marker_format: marker.format, payload_hash: marker.payload_hash,
      artifact_hash: marker.artifact_hash, manifest_version: marker.manifest_version },
    client: { name: 'codex-cli', version: adapter.codex_version },
    model: { provider: 'cursor', name: 'agent-default' },
  };
}

function exactPermission(turn, markerPath, alreadyAllowed) {
  const pending = turn.pending || [];
  if (alreadyAllowed || pending.length !== 1 || pending[0].kind !== 'permission') throw new Error('unexpected pending request');
  const locations = pending[0].context?.locations || [];
  if (locations.length === 0 || locations.some((location) => location.path?.text !== markerPath)) throw new Error('permission location is outside the exact marker path');
  return pending[0];
}

export function terminalAgentError(turn) {
  return /^\s*Error:/.test(turn?.result?.text || '');
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

async function finalizeReleaseRun({ layout, installed, handoff, proof, observations, outcome,
  cleanupPackage, removeLayout = rm, writeChildResult = writeReleaseChildResult }) {
  let cleanupStatus = layout ? 'succeeded' : 'not_required'; let cleanupMessage = null;
  if (layout) {
    if (installed) {
      try { await cleanupPackage(); }
      catch (error) { cleanupStatus = 'failed'; cleanupMessage = `package cleanup failed: ${error.message}`; }
    }
    if (cleanupStatus === 'succeeded') {
      try { await removeLayout(layout.root, { recursive: true, force: true }); }
      catch (error) { cleanupStatus = 'failed'; cleanupMessage = `temporary layout cleanup failed: ${error.message}`; }
    }
  }
  if (cleanupStatus === 'failed') outcome = { status: 'integration_failure', message: cleanupMessage };
  if (handoff) {
    const childResult = {
      scenario_id: handoff.scenario.scenario_id, lane: handoff.scenario.lane,
      provenance: {
        consumed_scenario: handoff.scenarioDigest, consumed_corpus: handoff.corpusDigest,
        adapter: proof?.adapter || null, evaluator: proof?.evaluator || null, managed_installed_skill: proof?.managedInstalledSkill || null,
        cache_loaded_skill: null, installed_payload: proof?.installedPayload || null,
        client: proof?.client || null, model: proof?.model || null, cleanup_status: cleanupStatus,
      },
      observations, captured_finals: [], transcript: { calls: [], dropped_calls: 0 }, eval_status: outcome.status,
      error_code: outcome.status === 'pass' ? null : outcome.status === 'agent_behavior_mismatch' ? 'canary_marker_mismatch' : 'live_canary_failure',
      message: outcome.message || null,
    };
    await writeChildResult(handoff.childResultPath, childResult);
  }
  return outcome;
}

export async function runLiveCanary(env = process.env, hooks = {}) {
  if (env.CURSOR_SUBAGENT_LIVE_E2E !== '1') return { status: 'skipped' };
  let handoff;
  try { handoff = outerReleaseHandoff(env); }
  catch (error) { return { status: 'integration_failure', message: error.message }; }
  let layout; let client; let turn; let configuration; let executables; let childEnv; let proof; let installed = false;
  let closeSucceeded = false; let completed = false; let failure = null; let permissionAllowed = false;
  const trace = []; const callbacks = []; const effects = [];
  try {
    configuration = liveConfiguration(env);
    const make = hooks.makeLayout || (() => makeLayout('cursor-release-live-'));
    layout = await make();
    const node = await realpath(process.execPath); const codex = await realpath(configuration.codex); const agent = await realpath(configuration.agent);
    executables = { node, codex, agent };
    childEnv = { ...env, ...configuration.adapterEnvironment, CODEX_HOME: layout.configRoot,
      CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: layout.configRoot,
      CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify(configuration.adapterCommand) };
    client = await installAndDiscover(layout, executables, configuration.adapterCommand, childEnv); installed = true;
    const built = await invokeReleaseAdapter(configuration.adapterCommand, 'canary-prompt', {
      codex_executable: codex, marker_path: layout.markerPath, marker_bytes: MARKER_BYTES,
    }, childEnv);
    if (typeof built.prompt !== 'string' || !built.prompt || Buffer.byteLength(built.prompt) > 64_000) throw new Error('adapter canary prompt shape is invalid');
    if (!built.prompt.includes(`AUTHORIZED_ACTIONS: write ${layout.markerPath} with exact content ${JSON.stringify(MARKER_BYTES)} only.`)
      || !built.prompt.includes('NO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.')) throw new Error('adapter canary prompt authority boundary is invalid');
    turn = await client.tool('cursor_delegate', { cwd: layout.workspace, mode: 'agent', prompt: built.prompt });
    if (turn.session_state !== 'live' || !turn.session_id || !turn.turn_id) throw new Error('delegate did not allocate a live turn');
    trace.push({ kind: 'session.allocated' }, { kind: 'turn.started' });
    for (let count = 0; count < 12; count += 1) {
      turn = await client.tool('cursor_wait', { session_id: turn.session_id, turn_id: turn.turn_id, after_event_id: turn.last_event_id, timeout_ms: 60_000 });
      if (turn.turn_status === 'completed') {
        trace.push({ kind: 'turn.completed' });
        if (terminalAgentError(turn)) throw new Error('agent completed with an error');
        completed = true; break;
      }
      if (turn.turn_status === 'waiting_for_input') {
        const pending = exactPermission(turn, layout.markerPath, permissionAllowed); permissionAllowed = true;
        trace.push({ kind: 'pending.permission' });
        turn = await client.tool('cursor_answer_permission', { session_id: turn.session_id, turn_id: turn.turn_id, request_id: pending.request_id, decision: 'allow-once' });
        callbacks.push({ kind: 'answer.permission', decision: 'allow-once' }); trace.push({ kind: 'answer.permission' });
      } else if (!['running'].includes(turn.turn_status)) throw new Error(`unexpected terminal turn: ${turn.turn_status}`);
    }
    if (!completed) throw new Error('live canary did not complete within bounded waits');
  } catch (error) {
    failure = error;
  } finally {
    if (client) {
      trace.push({ kind: 'session.close-attempted' });
      const closed = await closeCanaryClient(client, turn); closeSucceeded = closed.ok;
      if (!closed.ok && !failure) failure = new Error(closed.message);
    }
  }
  let markerMatches = false; let inspectionFailure = null;
  if (!failure && closeSucceeded) {
    try {
      const marker = await inspectMarker(layout.markerPath);
      markerMatches = marker.matches;
      effects.push({ kind: 'marker.inspected', matches: marker.matches });
    } catch (error) { inspectionFailure = `marker inspection failed: ${error.message}`; }
  }
  let outcome = classifyLiveOutcome({ enabled: true, failure: failure?.message || inspectionFailure, closeSucceeded, markerMatches });
  if (handoff && installed) {
    try { proof = { ...await captureReleaseProof(layout, configuration, executables, childEnv), evaluator: (await readEvaluatorInventory()).digest }; }
    catch (error) { outcome = { status: 'integration_failure', message: `package proof failed: ${error.message}` }; }
  }
  const observations = { trace, callbacks, effects,
    actual_task_outcome: markerMatches ? 'succeeded' : effects.length ? 'failed' : 'not_observed',
    reported_task_outcome: 'not_checked' };
  return finalizeReleaseRun({ layout, installed, handoff, proof, observations, outcome,
    cleanupPackage: async () => {
      const cleaned = await (hooks.runBootstrap || runBootstrap)(['uninstall', '--managed-marketplace-root', layout.managed,
        '--codex-executable', executables.codex], { env: childEnv });
      if (cleaned.exitCode !== 0 || cleaned.envelope.state !== 'absent') throw new Error(JSON.stringify(cleaned.envelope));
    }, removeLayout: hooks.removeLayout || rm, writeChildResult: hooks.writeChildResult || writeReleaseChildResult });
}

test('credential-free release gate installs, discovers and starts the published MCP payload', deterministicReleaseGate);

test('installed live model discovery canary rejects an unknown ID before allocation', {
  skip: process.env.CURSOR_MODEL_DISCOVERY_LIVE !== '1',
}, async (t) => {
  const layout = await makeLayout('cursor-installed-model-live-');
  t.after(() => rm(layout.root, { recursive: true, force: true }));
  const executable = await realpath(process.execPath);
  const agent = process.env.CURSOR_MODEL_DISCOVERY_AGENT
    ? await realpath(process.env.CURSOR_MODEL_DISCOVERY_AGENT) : executable;
  const authPath = join(homedir(), '.cursor', 'auth.json');
  const originalAuth = await readFile(authPath);
  const client = await installAndDiscover(layout, { node: executable, codex: executable, agent },
    [executable, fakeAdapter], { ...process.env, FAKE_CODEX_STATE: layout.state }, {
      CURSOR_AGENT_COMMAND: agent,
      CURSOR_SUBAGENT_ADAPTER_ARGS: agent === executable ? JSON.stringify([fakeAcp]) : undefined,
      FAKE_ACP_LOG: join(layout.root, 'acp.jsonl'),
    });
  t.after(async () => {
    try { await client.close(); } finally {
      const currentAuth = await readFile(authPath);
      assert.equal(currentAuth.equals(originalAuth), true, 'live canary changed Cursor auth file');
    }
  });
  const catalog = await client.tool('cursor_list_models', {});
  assert.ok(catalog.models.length > 0);
  const unknown = 'cursor-package-canary-unknown-model';
  assert.equal(catalog.models.some(({ id }) => id === unknown), false);
  await assert.rejects(client.tool('cursor_start_session', { cwd: layout.workspace, mode: 'ask', model: unknown }), /invalid_args/);
  await assert.rejects(readFile(join(layout.root, 'acp.jsonl')), { code: 'ENOENT' });
  if (agent !== executable) {
    const started = await client.tool('cursor_start_session', { cwd: layout.workspace, mode: 'ask' });
    try {
      assert.equal(started.session_state, 'live', JSON.stringify({
        failure_kind: started.failure_kind, terminal_reason: started.terminal_reason,
      }));
      assert.ok(started.cursor_session_id);
    } finally {
      if (started.session_id) await client.tool('cursor_close_session', { session_id: started.session_id });
    }
  }
  await client.close();
  const skill = await readFile(join(layout.managed, 'plugins/agents-cursor-subagent-plugin/skills/cursor-subagent/SKILL.md'));
  t.diagnostic(JSON.stringify({ models: catalog.models.length, installed_skill: digestBytes(skill), unknown_id_rejected_before_allocation: true, real_session_initialized_without_prompt: agent !== executable }));
});

test('installed discovery failure precedes ACP allocation and startup diagnostics cross MCP', async (t) => {
  for (const discoveryFailure of [true, false]) await t.test(discoveryFailure ? 'catalog unavailable' : 'provider startup failure', async (caseT) => {
    const layout = await makeLayout('cursor-release-model-failure-');
    caseT.after(() => rm(layout.root, { recursive: true, force: true }));
    const executable = await realpath(process.execPath);
    const acpLog = join(layout.root, 'acp.jsonl');
    const client = await installAndDiscover(layout, { node: executable, codex: executable, agent: executable },
      [executable, fakeAdapter], { ...process.env, FAKE_CODEX_STATE: layout.state }, {
        CURSOR_AGENT_COMMAND: executable, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
        NODE_OPTIONS: `--import=${modelDiscoveryPreload}`, RELEASE_MODEL_CATALOG: modelCatalogFixture,
        RELEASE_MODEL_DISCOVERY_FAILURE: discoveryFailure ? '1' : '0', FAKE_ACP_LOG: acpLog,
        FAKE_ACP_STARTUP_STDERR: 'Selected model is unavailable for the fixture account.',
      });
    caseT.after(() => client.close());
    if (discoveryFailure) {
      await assert.rejects(client.tool('cursor_list_models', {}), /model_discovery_failed/);
      await assert.rejects(readFile(acpLog), { code: 'ENOENT' });
    } else {
      const failed = await client.tool('cursor_start_session', { cwd: layout.workspace, mode: 'ask' });
      assert.equal(failed.session_state, 'tombstone');
      assert.equal(failed.failure_kind, 'init');
      assert.match(JSON.stringify(failed.terminal_reason), /Selected model is unavailable for the fixture account/);
    }
  });
});

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
  const turn = { pending: [{ request_id: 'one', kind: 'permission', context: { locations: [{ path: { text: marker } }] } }] };
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
  assert.equal(terminalAgentError({ result: { text: '\nError: RetriableError' } }), true);
  assert.equal(terminalAgentError({ result: { text: 'Created the marker.' } }), false);
});

test('release handoff consumes only the exact outer package canary reference and digests', async () => {
  const scenario = packageCanaryScenario;
  const materialized = materializeScenario(scenario); const corpusDigest = digestBytes(JSON.stringify(releaseCorpus));
  const env = {
    CURSOR_EVAL_SCENARIO_PAYLOAD: materialized.canonicalPayload,
    CURSOR_EVAL_SCENARIO_SHA256: materialized.digest.sha256,
    CURSOR_EVAL_SCENARIO_BYTES: String(materialized.digest.bytes),
    CURSOR_EVAL_CORPUS_SHA256: corpusDigest.sha256,
    CURSOR_EVAL_CORPUS_BYTES: String(corpusDigest.bytes),
    CURSOR_EVAL_CHILD_RESULT: '/tmp/outer-child-result.json',
  };
  const handoff = outerReleaseHandoff(env);
  assert.deepEqual({ id: handoff.scenario.scenario_id, kind: handoff.scenario.scenario_kind, scenario: handoff.scenarioDigest, corpus: handoff.corpusDigest },
    { id: packageCanaryId, kind: 'package-canary-reference', scenario: materialized.digest, corpus: corpusDigest });
  assert.throws(() => outerReleaseHandoff({ ...env, CURSOR_EVAL_SCENARIO_SHA256: '0'.repeat(64) }), /does not match/);
});

test('release child finalizer cleans package layout before writing outer-owned evidence', async (t) => {
  const outerRoot = await mkdtemp(join(tmpdir(), 'cursor-release-outer-')); const layoutRoot = await mkdtemp(join(tmpdir(), 'cursor-release-package-'));
  t.after(() => rm(outerRoot, { recursive: true, force: true })); t.after(() => rm(layoutRoot, { recursive: true, force: true }));
  const destination = join(outerRoot, 'child-result.json'); const order = [];
  const digest = { sha256: 'a'.repeat(64), bytes: 123 }; const proof = {
    adapter: { sha256: 'b'.repeat(64), bytes: 456 }, evaluator: { sha256: '9'.repeat(64), bytes: 800 }, managedInstalledSkill: { sha256: 'c'.repeat(64), bytes: 789 },
    installedPayload: { marker_format: 1, payload_hash: 'd'.repeat(64), artifact_hash: 'e'.repeat(64), manifest_version: `0.1.0+codex.${'d'.repeat(64)}` },
    client: { name: 'codex-cli', version: 'codex-cli 0.152.1' }, model: { provider: 'cursor', name: 'agent-default' },
  };
  const outcome = await finalizeReleaseRun({ layout: { root: layoutRoot }, installed: true,
    handoff: { scenario: { scenario_id: packageCanaryId, lane: 'full-live' }, scenarioDigest: digest,
      corpusDigest: { sha256: 'f'.repeat(64), bytes: 321 }, childResultPath: destination },
    proof, observations: { trace: [], callbacks: [], effects: [], actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' },
    outcome: { status: 'pass' }, cleanupPackage: async () => { order.push('package-cleanup'); },
    removeLayout: async (...args) => { order.push('layout-cleanup'); await rm(...args); },
    writeChildResult: async (...args) => { order.push('child-result'); await writeReleaseChildResult(...args); } });
  const child = JSON.parse(await readFile(destination, 'utf8'));
  const parsed = parseChildResult(JSON.stringify(child), packageCanaryId, {
    scenario: { scenario_kind: 'package-canary-reference' }, scenarioDigest: digest,
    corpusDigest: { sha256: 'f'.repeat(64), bytes: 321 },
  });
  assert.deepEqual(order, ['package-cleanup', 'layout-cleanup', 'child-result']); assert.deepEqual(outcome, { status: 'pass' });
  assert.deepEqual({ schema: child.schema_version, scenario: child.scenario_id, status: child.eval_status,
    consumed: child.provenance.consumed_scenario, installedSkill: child.provenance.managed_installed_skill,
    cacheSkill: child.provenance.cache_loaded_skill, cleanup: child.provenance.cleanup_status },
  { schema: 1, scenario: packageCanaryId, status: 'pass', consumed: digest,
    installedSkill: proof.managedInstalledSkill, cacheSkill: null, cleanup: 'succeeded' });
  assert.deepEqual(parsed.manifest.installed_payload, proof.installedPayload);
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
