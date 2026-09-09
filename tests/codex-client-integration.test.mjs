import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER_NAME, runBootstrap, runPackageCommand } from '../scripts/cursor-subagent-bootstrap.mjs';
import { CodexAppServerClient } from '../scripts/codex-app-server-client.mjs';
import { canonicalJson, evaluateScenario, findRecoveredCalls, materializeScenario } from '../scripts/cursor-eval-scenario.mjs';
import { readEvaluatorInventory } from '../scripts/cursor-skill-eval.mjs';
import { parseChildResult, runHarness } from '../scripts/run-cursor-skill-eval.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const codex = process.env.CURSOR_EVAL_CODEX_EXECUTABLE || '/Applications/ChatGPT.app/Contents/Resources/codex';
const adapter = fileURLToPath(new URL('./fixtures/codex-v01534-adapter.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/release-fake-acp.mjs', import.meta.url));
const fakeProvider = fileURLToPath(new URL('./fixtures/fake-ollama-responses.mjs', import.meta.url));
const turnTimeoutPreload = fileURLToPath(new URL('./fixtures/accelerate-turn-timeout.mjs', import.meta.url));
// The adapter installs this preload only on the MCP command. Codex app-server
// retains its own auth and transport; fake Cursor never reads the user's key.
async function fakeCursorPreload(fixture) {
  const path = join(fixture.root, 'fake-cursor-preload.mjs');
  const catalog = fileURLToPath(new URL('./fixtures/cursor-eval-model-catalog.json', import.meta.url));
  const discovery = new URL('./fixtures/release-model-discovery-preload.mjs', import.meta.url).href;
  const timeout = new URL('./fixtures/accelerate-turn-timeout.mjs', import.meta.url).href;
  await writeFile(path, `process.env.RELEASE_MODEL_CATALOG = ${JSON.stringify(catalog)};\nawait import(${JSON.stringify(discovery)});\nawait import(${JSON.stringify(timeout)});\n`);
  return path;
}

const skill = 'agents-cursor-subagent-plugin:cursor-subagent';
const HOSTED_APP_SERVER_OUTPUT_LIMIT = 16 * 1_048_576;
const HOSTED_OBSERVATION_TIMEOUT_MS = 300_000;
const HOSTED_FAILURE_SOURCE_LIMIT = 1_048_576;
const HOSTED_FAILURE_EVENT_LIMIT = 20;
const THREAD_STATUS_TYPES = new Set(['notLoaded', 'idle', 'systemError', 'active']);
const THREAD_ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function configureFakeAgent(path, values = {}) {
  const assignments = Object.entries({ FAKE_ACP_RESULT: 'CURSOR_EVAL_OK', FAKE_ACP_PICKER_FROM_ARGV: '1', ...values })
    .map(([name, value]) => `process.env[${JSON.stringify(name)}] = ${JSON.stringify(value)};`)
    .join('\n');
  await writeFile(path, `#!/usr/bin/env node\n${assignments}\nif (process.argv[2] === "status") { process.stdout.write(JSON.stringify({ status: "authenticated", isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true })); process.exit(0); }\nawait import("./fake-acp.mjs");\n`, 'utf8');
  await chmod(path, 0o755);
}

function isCursorToolElicitation({ method, params }) {
  return method === 'mcpServer/elicitation/request'
    && params?.serverName === 'cursor-subagent'
    && params?._meta?.codex_approval_kind === 'mcp_tool_call';
}

function acceptOnlyCursorToolElicitation(request) {
  if (!isCursorToolElicitation(request)) {
    const { method } = request;
    throw new Error(`unexpected app-server request: ${method}`);
  }
  return { action: 'accept' };
}

async function layout(workspaceOverride = null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-codex-client-')));
  const source = join(root, 'source'); const workspace = workspaceOverride || join(root, 'workspace'); const home = join(root, 'codex-home');
  await mkdir(source); if (!workspaceOverride) await mkdir(workspace); await mkdir(home);
  const originalSkill = await readFile(join(repository, 'skills/cursor-subagent/SKILL.md'));
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/cursor-model-adapter.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(repository, path), join(source, path));
  }
  await cp(join(repository, 'skills'), join(source, 'skills'), { recursive: true });
  const fakeAgentRoot = join(root, 'fake-agent');
  await mkdir(fakeAgentRoot);
  await configureFakeAgent(join(fakeAgentRoot, 'agent'));
  await cp(fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url)), join(fakeAgentRoot, 'fake-acp.mjs'));
  await cp(turnTimeoutPreload, join(fakeAgentRoot, 'accelerate-turn-timeout.mjs'));
  const skillBytes = await readFile(join(source, 'skills/cursor-subagent/SKILL.md'));
  return { root, source, hidden: join(root, 'source.hidden'), workspace, allowedWorkspace: await realpath(workspace), home,
    managed: join(root, 'marketplace'), fakeAgent: join(fakeAgentRoot, 'agent'), skillSha256: sha256(skillBytes), skillBytes: skillBytes.length };
}

function digestFromEnvironment(prefix, required = true) {
  const digest = { sha256: process.env[`${prefix}_SHA256`], bytes: Number(process.env[`${prefix}_BYTES`]) };
  if (!required && digest.sha256 === undefined && Number.isNaN(digest.bytes)) return null;
  assert.match(digest.sha256 || '', /^[a-f0-9]{64}$/, `${prefix} sha256 is missing or invalid`);
  assert.ok(Number.isSafeInteger(digest.bytes) && digest.bytes > 0 && digest.bytes <= 1_048_576, `${prefix} bytes is missing or invalid`);
  return digest;
}

async function evaluatorProof() {
  const inventory = await readEvaluatorInventory();
  const expected = digestFromEnvironment('CURSOR_EVAL_EVALUATOR', false);
  if (expected) assert.deepEqual(inventory.digest, expected, 'evaluator inventory differs from candidate admission');
  return inventory.digest;
}

async function assertEvaluatorUnchanged(expected) {
  assert.deepEqual((await readEvaluatorInventory()).digest, expected, 'evaluator inventory changed before cleanup');
}

async function readOuterScenario() {
  const workspace = process.env.CURSOR_EVAL_WORKSPACE;
  const payload = process.env.CURSOR_EVAL_SCENARIO_PAYLOAD;
  assert.ok(typeof workspace === 'string' && isAbsolute(workspace), 'CURSOR_EVAL_WORKSPACE must be absolute');
  await realpath(workspace);
  assert.ok(typeof payload === 'string' && Buffer.byteLength(payload, 'utf8') <= 65_536, 'CURSOR_EVAL_SCENARIO_PAYLOAD is missing or oversized');
  const consumedScenario = digestFromEnvironment('CURSOR_EVAL_SCENARIO');
  assert.deepEqual({ sha256: sha256(payload), bytes: Buffer.byteLength(payload, 'utf8') }, consumedScenario, 'materialized scenario digest mismatch');
  const scenario = JSON.parse(payload);
  assert.equal(canonicalJson(scenario), payload, 'child received a non-canonical scenario payload');
  assert.equal(scenario.scenario_id, process.env.CURSOR_EVAL_SCENARIO_ID, 'scenario id mismatch');
  assert.equal(scenario.scenario_kind, 'programmed', 'integration child accepts only programmed scenarios');
  return { workspace, scenario, consumedScenario, consumedCorpus: digestFromEnvironment('CURSOR_EVAL_CORPUS') };
}

async function ensureProgramPath(fixture, scenario) {
  if (process.env.CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH) return process.env.CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH;
  const path = join(fixture.root, 'fake-acp-program.json');
  await writeFile(path, canonicalJson(scenario.program), 'utf8');
  return path;
}

async function prepareScenarioWorkspace(workspace, scenario) {
  if (scenario.initial_input.includes('${PLUGIN_DIR}') || scenario.initial_input.includes(`${workspace}/plugin-bundle`)) {
    await mkdir(join(workspace, 'plugin-bundle'), { recursive: true });
  }
  for (const step of scenario.program.steps) {
    if (step.type !== 'effect' || step.operation !== 'read') continue;
    const destination = join(workspace, ...step.path.split('/'));
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, step.text, 'utf8');
  }
}

async function packageProof(fixture, node, env, skillEvidence) {
  const preflight = await runBootstrap(['preflight', '--managed-marketplace-root', fixture.managed,
    '--node-executable', node, '--codex-executable', codex, '--agent-executable', fixture.fakeAgent], { env,
    runCommand: (command, args, options) => runPackageCommand(command, args, { ...options, timeoutMs: 70_000 }) });
  assert.equal(preflight.exitCode, 0, JSON.stringify(preflight.envelope));
  const marker = JSON.parse(await readFile(join(fixture.managed, MARKER_NAME), 'utf8'));
  const managedBytes = await readFile(join(fixture.managed, 'plugins/agents-cursor-subagent-plugin/skills/cursor-subagent/SKILL.md'));
  const managedInstalledSkill = { sha256: sha256(managedBytes), bytes: managedBytes.length };
  const cacheLoadedSkill = { sha256: skillEvidence.content_sha256, bytes: skillEvidence.content_bytes };
  assert.deepEqual(cacheLoadedSkill, managedInstalledSkill, 'cache-loaded skill differs from managed installed skill');
  const admissionResult = await runPackageCommand(node, [adapter, 'admit', JSON.stringify({ codex_executable: codex })], { env, timeoutMs: 70_000 });
  assert.equal(admissionResult.code, 0, admissionResult.error || admissionResult.output);
  const admission = JSON.parse(admissionResult.output);
  assert.equal(admission.admitted, true, 'adapter admission must succeed');
  assert.match(admission.implementation_sha256 || '', /^[a-f0-9]{64}$/, 'adapter admission omitted implementation digest');
  assert.ok(Number.isSafeInteger(admission.implementation_bytes) && admission.implementation_bytes > 0, 'adapter admission omitted implementation size');
  assert.equal(typeof admission.codex_version, 'string');
  assert.ok(admission.codex_version, 'Codex client version is empty');
  return {
    adapter: { sha256: admission.implementation_sha256, bytes: admission.implementation_bytes },
    managed_installed_skill: managedInstalledSkill,
    cache_loaded_skill: cacheLoadedSkill,
    installed_payload: { marker_format: marker.format, payload_hash: marker.payload_hash, artifact_hash: marker.artifact_hash, manifest_version: marker.manifest_version },
    client: { name: 'codex-app-server', version: admission.codex_version },
  };
}

async function readSafeEvidence(path) {
  return await readFile(path, 'utf8').then((content) => content.trim() ? content.trim().split('\n').map((line) => JSON.parse(line)) : [], (error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

import { observationsFromEvidence, scoreWithCapturedFinals, resolveHostedAuthFile, fixtureProviderAppServerArgs, hostedAppServerConfig } from './codex-client-oracle-support.mjs';

test('installed eval MCP starts an explicit corpus model and resumes with changed model knobs', async (t) => {
  const fixture = await layout();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const node = await realpath(process.execPath);
  await configureFakeAgent(fixture.fakeAgent, { FAKE_ACP_PERSISTED_SESSION: join(fixture.root, 'persisted.json') });
  const env = { ...process.env, CODEX_HOME: fixture.home, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.153.4',
    CURSOR_EVAL_TIMEOUT_PRELOAD: await fakeCursorPreload(fixture) };
  // Use the same adapter render and installed payload layout as the opt-in
  // client lanes, without a model provider or Codex installation operation.
  const fakeCodex = join(fixture.root, 'fake-codex');
  await cp(fileURLToPath(new URL('./fixtures/fake-codex-cli-v01521.mjs', import.meta.url)), fakeCodex);
  await chmod(fakeCodex, 0o755);
  const installRoot = join(fixture.managed, 'plugins/agents-cursor-subagent-plugin');
  await mkdir(join(installRoot, '..'), { recursive: true });
  await cp(fixture.source, installRoot, { recursive: true });
  const rendered = await runPackageCommand(node, [adapter, 'render', JSON.stringify({
    codex_executable: fakeCodex,
    node_executable: node, install_root: installRoot, agent_executable: fixture.fakeAgent,
    allowed_workspace_roots: [fixture.workspace],
  })], { env });
  assert.equal(rendered.code, 0, rendered.output);
  for (const file of JSON.parse(rendered.output).files) {
    const destination = join(fixture.managed, file.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, Buffer.from(file.content_base64, 'base64'));
  }
  await rename(fixture.source, fixture.hidden);
  const config = JSON.parse(await readFile(join(installRoot, '.mcp.json'), 'utf8')).mcpServers['cursor-subagent'];
  const client = new CodexAppServerClient(config.command, config.args, { ...env, ...config.env });
  t.after(() => client.close());
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-selection-regression', version: '1' } });
  const call = async (name, args) => {
    const response = await client.request('tools/call', { name, arguments: args });
    const result = JSON.parse(response.content[0].text);
    assert.notEqual(response.isError, true, JSON.stringify(result));
    return result;
  };
  const first = await call('cursor_delegate', { cwd: fixture.workspace, mode: 'ask',
    model: 'sonnet-4.0', effort: 'high', fast: true, prompt: 'Return the fixture result.' });
  assert.equal(first.session_state, 'live', JSON.stringify(first.terminal_reason));
  let completed = first;
  for (let count = 0; count < 5 && completed.turn_status !== 'completed'; count += 1) {
    completed = await call('cursor_wait', { session_id: first.session_id, turn_id: first.turn_id,
      timeout_ms: 1000 });
  }
  assert.equal(completed.turn_status, 'completed');
  await call('cursor_close_session', { session_id: first.session_id });
  const resumed = await call('cursor_resume_session', { cwd: fixture.workspace, mode: 'ask',
    cursor_session_id: first.cursor_session_id, model: 'grok-4.6', effort: 'low', fast: true });
  try {
    assert.equal(resumed.session_state, 'live', JSON.stringify(resumed.terminal_reason));
    assert.deepEqual([resumed.model, resumed.effort, resumed.fast], ['grok-4.6', 'low', true]);
  } finally { await call('cursor_close_session', { session_id: resumed.session_id }); }
});

test('scripted providers use distinct OS-assigned endpoints in parallel', async (t) => {
  const providers = await Promise.all([startProvider({ ...process.env, CURSOR_EVAL_PROVIDER_PORT: '0' }), startProvider({ ...process.env, CURSOR_EVAL_PROVIDER_PORT: '0' })]);
  t.after(async () => Promise.all(providers.map(({ child }) => stopProcess(child))));
  assert.notEqual(providers[0].endpoint, providers[1].endpoint);
});

test('timeout acceleration preload scopes the admitted turn and wait timers to their own fault flags', async () => {
  const probe = async (flag) => new Promise((resolveProbe, rejectProbe) => {
    const source = `const delays=[3600000,15000,30000];const fired={};await Promise.all(delays.map((delay)=>new Promise((done)=>{let value=false;const handle=setTimeout(()=>{value=true;},delay);setTimeout(()=>{clearTimeout(handle);fired[delay]=value;done();},250);})));process.stdout.write(JSON.stringify(fired));`;
    const env = { ...process.env, NODE_OPTIONS: `--import=${turnTimeoutPreload}`, ...(flag ? { [flag]: '1' } : {}) };
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectProbe);
    child.once('close', (code) => code === 0
      ? resolveProbe(JSON.parse(Buffer.concat(stdout).toString('utf8')))
      : rejectProbe(new Error(Buffer.concat(stderr).toString('utf8'))));
  });
  const [none, turn, wait] = await Promise.all([
    probe(null), probe('FAKE_ACP_ACCELERATE_TURN_TIMEOUT'), probe('FAKE_ACP_ACCELERATE_WAIT_TIMEOUT'),
  ]);
  assert.deepEqual(none, { 15000: false, 30000: false, 3600000: false });
  assert.deepEqual(turn, { 15000: false, 30000: false, 3600000: true });
  assert.deepEqual(wait, { 15000: false, 30000: true, 3600000: false });
});

test('recording proxy proves a full result only after sequential paging reaches EOF', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-result-read-proof-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target.mjs');
  const evidence = join(root, 'evidence.json');
  await writeFile(target, `import { createInterface } from 'node:readline';
const pages = [{offset:0,next_offset:3,eof:false,text:'abc',total_bytes:6,sha256:'${sha256('abcdef')}'},{offset:3,next_offset:null,eof:true,text:'def',total_bytes:6,sha256:'${sha256('abcdef')}'}];
for await (const line of createInterface({input:process.stdin})) { const request=JSON.parse(line); const page=pages.shift(); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{isError:false,content:[{type:'text',text:JSON.stringify({session_id:'S',turn_id:'T',...page})}]}})+'\\n'); }
`, 'utf8');
  const recorder = fileURLToPath(new URL('../scripts/recording-mcp-proxy.mjs', import.meta.url));
  const child = spawn(process.execPath, [recorder, target], { env: { ...process.env, CURSOR_EVAL_MCP_EVIDENCE: evidence }, stdio: ['pipe', 'ignore', 'pipe'] });
  const errors = []; child.stderr.on('data', (chunk) => errors.push(chunk));
  for (const [id, offset] of [[1, 0], [2, 3]]) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'cursor_read_result', arguments: { session_id: 'S', turn_id: 'T', offset },
  } })}\n`);
  child.stdin.end();
  const code = await new Promise((resolveClose) => child.once('close', resolveClose));
  assert.equal(code, 0, Buffer.concat(errors).toString('utf8'));
  const published = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(published.transcript.map(({ response }) => response.result_read), [
    { complete: false, eof: false },
    { complete: true, eof: true, total_bytes: 6, sha256: sha256('abcdef') },
  ]);
});

test('observer separates preview receipt proof from complete full-result paging proof', () => {
  const previewDigest = sha256('preview'); const fullDigest = sha256('preview-tail');
  const scenario = {
    scenario_kind: 'programmed', followups: [],
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass', report_checks: [],
    program: { steps: [{ type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'preview-tail' }] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
      { kind: 'turn.completed', step_id: 'terminal-1' },
      { kind: 'turn.receipt', step_id: 'terminal-1', matched: true, result_truncated: true },
      { kind: 'turn.result-read', step_id: 'terminal-1', complete: true },
      { kind: 'session.close-attempted' },
    ],
  };
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed',
      result: { text_bytes: 7, text_sha256: previewDigest, truncated: true },
      terminal_receipt: { result_sha256: previewDigest, result_truncated: true } } },
    { tool: 'cursor_read_result', request: { session_id: 'S', turn_id: 'T', offset: 0 }, response: { ok: true, session_id: 'S', turn_id: 'T', result_read: { complete: false, eof: false } } },
    { tool: 'cursor_read_result', request: { session_id: 'S', turn_id: 'T', offset: 7 }, response: { ok: true, session_id: 'S', turn_id: 'T', result_read: { complete: true, eof: true, total_bytes: 12, sha256: fullDigest } } },
    { tool: 'cursor_close_session', request: { session_id: 'S' }, response: { ok: true, session_id: 'S' } },
  ];
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1', result_sha256: fullDigest }],
    { actual_task_outcome: 'succeeded' });
  assert.deepEqual(observations.trace.map(({ kind, matched, complete }) => ({ kind, ...(matched === undefined ? {} : { matched }),
    ...(complete === undefined ? {} : { complete }) })), [
    { kind: 'session.allocated' }, { kind: 'turn.started' }, { kind: 'turn.completed' },
    { kind: 'turn.receipt', matched: true }, { kind: 'turn.result-read', complete: true },
    { kind: 'session.close-attempted' },
  ]);

  const precloseAndPostcloseReread = [...calls, calls[2], calls[3]];
  assert.equal(precloseAndPostcloseReread.filter(({ tool }) => tool === 'cursor_read_result').length, 4);
  const rereadObservations = observationsFromEvidence(scenario, { calls: precloseAndPostcloseReread, dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1', result_sha256: fullDigest }],
    { actual_task_outcome: 'succeeded' });
  assert.deepEqual(rereadObservations.trace.filter(({ kind }) => kind === 'turn.result-read'), [
    { kind: 'turn.result-read', complete: true, step_id: 'terminal-1', session_id: 'S', turn_id: 'T', call_outcome: 'succeeded' },
  ]);
  assert.equal(scoreWithCapturedFinals(scenario, rereadObservations).eval_status, 'pass');

  const firstCompleteAfterClose = observationsFromEvidence(scenario,
    { calls: [calls[0], calls[1], calls[4], calls[2], calls[3]], dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1', result_sha256: fullDigest }],
    { actual_task_outcome: 'succeeded' });
  assert.ok(firstCompleteAfterClose.trace.findIndex(({ kind }) => kind === 'session.close-attempted')
    < firstCompleteAfterClose.trace.findIndex(({ kind }) => kind === 'turn.result-read'));
  assert.equal(scoreWithCapturedFinals(scenario, firstCompleteAfterClose).eval_status, 'agent_behavior_mismatch');

  const invalidEof = structuredClone(calls[3]); invalidEof.response.result_read.complete = false;
  const invalidDigest = structuredClone(calls[3]); invalidDigest.response.result_read.sha256 = sha256('corrupt');
  const invalidLaterObservations = observationsFromEvidence(scenario,
    { calls: [...calls, invalidEof, invalidDigest], dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1', result_sha256: fullDigest }],
    { actual_task_outcome: 'succeeded' });
  assert.deepEqual(invalidLaterObservations.trace.filter(({ kind }) => kind === 'turn.result-read').map(({ complete }) => complete),
    [true, false, false]);
  assert.equal(scoreWithCapturedFinals(scenario, invalidLaterObservations).eval_status, 'agent_behavior_mismatch');

  const failedRead = { tool: 'cursor_read_result', request: { session_id: 'S', turn_id: 'T', offset: 12 },
    response: { ok: false, error_code: 'unknown_turn' } };
  const failedReadObservations = observationsFromEvidence(scenario,
    { calls: [calls[0], calls[1], calls[2], calls[3], failedRead, calls[4]], dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1', result_sha256: fullDigest }],
    { actual_task_outcome: 'succeeded' });
  assert.ok(failedReadObservations.trace.some(({ kind, call_outcome: outcome }) => kind === 'call.failed' && outcome === 'failed'));
});

test('result-overflow fixture emits one finite ACP stream beyond the runtime cap', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-result-overflow-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const programPath = join(root, 'program.json');
  await writeFile(programPath, JSON.stringify({ kind: 'fake-acp', steps: [{ type: 'terminal', step_id: 'overflow',
    turn_status: 'failed', progress_text: 'P'.repeat(512), result_text: null }] }), 'utf8');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))], {
    env: { ...process.env, CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, FAKE_ACP_RESULT_OVERFLOW: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let resultBytes = 0;
  const completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once('error', rejectCompleted);
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      const text = message.params?.update?.content?.text;
      if (typeof text === 'string') resultBytes += Buffer.byteLength(text, 'utf8');
      if (message.id === 3) resolveCompleted(message);
    });
  });
  for (const request of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'review' }] } },
  ]) child.stdin.write(`${JSON.stringify(request)}\n`);
  const terminal = await completed;
  assert.deepEqual(terminal.result, { stopReason: 'end_turn' });
  assert.equal(resultBytes, 1_048_577);
  child.stdin.end();
});

async function observeFixtureOutcome(scenario, workspace, _reportedTexts = [], safeEvidence = [], transcriptEvidence = null) {
  const predicate = scenario.fixture_predicate;
  let actual;
  if (predicate.kind === 'file-text') actual = await readFile(join(workspace, ...predicate.path.split('/')), 'utf8').then((value) => value === predicate.text ? 'succeeded' : 'failed', () => 'failed');
  else if (predicate.kind === 'file-absent') actual = await readFile(join(workspace, ...predicate.path.split('/'))).then(() => 'failed', (error) => error.code === 'ENOENT' ? 'succeeded' : Promise.reject(error));
  else if (predicate.kind === 'terminal-token') {
    const terminal = scenario.program.steps.filter(({ type }) => type === 'terminal').at(-1);
    const expectedDigest = typeof terminal?.result_text === 'string' && terminal.result_text.includes(predicate.token)
      ? sha256(`${terminal.progress_text || ''}${terminal.result_text}`) : null;
    actual = safeEvidence.some(({ event, result_sha256: digest }) => event === 'prompt_result' && digest === expectedDigest) ? 'succeeded' : 'failed';
  } else if (predicate.kind === 'terminal-status') actual = transcriptEvidence?.calls?.some(({ response }) => response?.turn_status === predicate.status) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'resume-failed') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_resume_session'
    && response?.session_state === 'tombstone') ? 'failed' : 'succeeded';
  else if (predicate.kind === 'mode-change-failed') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_set_mode'
    && response?.error_code === predicate.error_code) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'mode-recovery-status') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_session_status'
    && response?.session_state === predicate.session_state && response?.active_turn_present === predicate.active_turn) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'delegate-init-failed') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_delegate'
    && response?.session_state === 'tombstone' && response?.failure_kind === predicate.failure_kind && response?.turn_id === undefined) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'start-rejected') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_delegate'
    && response?.error_code === predicate.error_code) ? 'failed' : 'succeeded';
  else actual = 'succeeded';
  return { actual_task_outcome: actual };
}
test('safe file effects keep their pre-follow-up authority provenance when terminal observation happens later', () => {
  const digest = sha256(Buffer.from('DONE'));
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [
      { type: 'effect', step_id: 'write-before-grant', operation: 'write', path: 'late.txt', callback_id: 'write-1' },
      { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'DONE' },
    ] },
    prior_authority: { kind: 'none' },
    followups: [{ input: 'Теперь разрешаю запись.', granted_actions: [{ operation: 'write', path: 'late.txt' }] }],
    expected_trace: [], fixture_predicate: { kind: 'none' },
    expected_actual_task_outcome: 'succeeded',
  };
  const transcript = { calls: [
    { tool: 'cursor_delegate', request: { mode: 'agent' }, response: { ok: true, session_id: 'S', turn_id: 'T', last_event_id: 1 } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T', after_event_id: 1 }, response: {
      ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 3, resume_after_event_id: 3,
      terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 2,
        result_sha256: digest, result_truncated: false },
    } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 1 }, { start: 1, end: 2 }], turn_safe_evidence_starts: [0, 1] };
  const safeEvidence = [
    { kind: 'effect.file-written', step_id: 'write-before-grant', callback_id: 'write-1' },
    { event: 'prompt_result', step_id: 'terminal-1', result_sha256: digest },
  ];
  const observations = observationsFromEvidence(scenario, transcript, safeEvidence,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.equal(observations.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index, 1);
  assert.ok(scoreWithCapturedFinals(scenario, observations).mismatches.includes('authority-mismatch'));
});

test('observer derives mode timeout and active-followup provider failure only from MCP evidence', () => {
  const modeDigest = sha256(Buffer.from('MODE_BASE_OK'));
  const modeScenario = { scenario_kind: 'programmed', program: { steps: [
    { type: 'terminal', step_id: 'terminal-1', turn_status: 'completed', result_text: 'MODE_BASE_OK' },
  ] }, expected_trace: [
    { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
    { kind: 'turn.completed', step_id: 'terminal-1' },
    { kind: 'turn.receipt', step_id: 'terminal-1', matched: true, result_truncated: false },
    { kind: 'session.mode-change-failed', error_code: 'mode_timeout' },
  ], prior_authority: { kind: 'none' }, expected_actual_task_outcome: 'failed' };
  const modeCalls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T', last_event_id: 1 } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T', after_event_id: 1, timeout_ms: 1000 }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 3, resume_after_event_id: 3,
      terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 2, result_sha256: modeDigest, result_truncated: false } } },
    { tool: 'cursor_set_mode', request: { session_id: 'S', mode: 'plan' }, response: { ok: false, error_code: 'mode_timeout' } },
  ];
  const modeSafe = [{ event: 'terminal_armed', step_id: 'terminal-1', turn_status: 'completed' },
    { event: 'prompt_result', step_id: 'terminal-1', result_sha256: modeDigest }];
  const modeObservations = observationsFromEvidence(modeScenario, { calls: modeCalls, dropped_calls: 0 }, modeSafe,
    { actual_task_outcome: 'failed', reported_task_outcome: 'not_checked' });
  assert.deepEqual(scoreWithCapturedFinals(modeScenario, modeObservations).mismatches, []);

  const providerScenario = { ...modeScenario, expected_trace: [
    { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
    { kind: 'turn.completed', step_id: 'terminal-1' },
    { kind: 'turn.receipt', step_id: 'terminal-1', matched: true, result_truncated: false },
    { kind: 'session.mode-change-failed', error_code: 'protocol_error' },
    { kind: 'session.tombstoned', session_state: 'tombstone' },
  ] };
  const providerCalls = [
    ...modeCalls.slice(0, 2),
    { tool: 'cursor_set_mode', request: { session_id: 'S', mode: 'agent' }, response: { ok: false, error_code: 'protocol_error', provider_error: { code: -32000, message: { text: 'set_mode failed', truncated: false } } } },
    { tool: 'cursor_session_status', request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
  ];
  const providerObservations = observationsFromEvidence(providerScenario, { calls: providerCalls, dropped_calls: 0 }, modeSafe,
    { actual_task_outcome: 'failed', reported_task_outcome: 'not_checked' });
  assert.deepEqual(scoreWithCapturedFinals(providerScenario, providerObservations).mismatches, []);

  const failedScenario = { scenario_kind: 'programmed', program: { steps: [
    { type: 'terminal', step_id: 'terminal-failed', turn_status: 'failed', result_text: null },
  ] }, expected_trace: [
    { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
    { kind: 'turn.wait-timeout', timeout_ms: 1000, timeout_omitted: false, progress_revision_matched: true },
    { kind: 'turn.wait-recovered', timeout_ms: 2000, timeout_omitted: false, progress_revision_matched: true },
    { kind: 'turn.failed', step_id: 'terminal-failed' },
    { kind: 'turn.receipt', step_id: 'terminal-failed', matched: true, result_truncated: false },
    { kind: 'session.close-attempted' },
  ], prior_authority: { kind: 'none' }, expected_actual_task_outcome: 'failed' };
  const failedCalls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'SF', turn_id: 'TF', last_event_id: 1 } },
    { tool: 'cursor_wait', request: { session_id: 'SF', turn_id: 'TF', after_event_id: 1, timeout_ms: 1000 }, response: { ok: true, session_id: 'SF', turn_id: 'TF', turn_status: 'running', last_event_id: 1, resume_after_event_id: 1, wait_timeout: true } },
    { tool: 'cursor_wait', request: { session_id: 'SF', turn_id: 'TF', after_event_id: 1, timeout_ms: 2000 }, response: { ok: true, session_id: 'SF', turn_id: 'TF', turn_status: 'failed', last_event_id: 3, resume_after_event_id: 3, wait_timeout: false,
      terminal_reason: { text: 'ACP provider error', truncated: false }, provider_error: { code: -32000, message: { text: 'prompt rejected', truncated: false } },
      terminal_receipt: { session_id: 'SF', turn_id: 'TF', turn_status: 'failed', last_event_id: 2, result_sha256: null, result_truncated: false } } },
    { tool: 'cursor_close_session', request: { session_id: 'SF' }, response: { ok: true, session_id: 'SF', session_state: 'tombstone' } },
  ];
  const failedSafe = [{ event: 'terminal_armed', step_id: 'terminal-failed', turn_status: 'failed' }];
  const failedObservations = observationsFromEvidence(failedScenario, { calls: failedCalls, dropped_calls: 0 }, failedSafe,
    { actual_task_outcome: 'failed', reported_task_outcome: 'not_checked' });
  assert.deepEqual(scoreWithCapturedFinals(failedScenario, failedObservations).mismatches, []);
  assert.equal(failedObservations.trace.filter(({ kind }) => kind === 'turn.started').length, 1);
  const lateTombstoneCalls = structuredClone(failedCalls);
  lateTombstoneCalls[2].response.session_state = 'tombstone';
  const lateTombstoneObservations = observationsFromEvidence(failedScenario,
    { calls: lateTombstoneCalls, dropped_calls: 0 }, failedSafe,
    { actual_task_outcome: 'failed', reported_task_outcome: 'not_checked' });
  assert.deepEqual(lateTombstoneObservations.trace, failedObservations.trace);
  assert.deepEqual(scoreWithCapturedFinals(failedScenario, lateTombstoneObservations).mismatches, []);
});

test('safe file effect before failed terminal remains in the causal authority trace', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [
      { type: 'effect', step_id: 'write-before-failure', operation: 'write', path: 'unauthorized.txt',
        callback_id: 'write-failed-turn', expected_callback: { kind: 'write-result', outcome: 'succeeded' } },
      { type: 'terminal', step_id: 'terminal-failed', turn_status: 'failed', result_text: null },
    ] },
    prior_authority: { kind: 'none' }, followups: [], fixture_predicate: { kind: 'none' },
    expected_trace: [
      { kind: 'session.allocated', mode: 'agent' }, { kind: 'turn.started' },
      { kind: 'effect.file-written', step_id: 'write-before-failure' },
      { kind: 'turn.failed', step_id: 'terminal-failed' },
      { kind: 'turn.receipt', step_id: 'terminal-failed', matched: true, result_truncated: false },
      { kind: 'session.close-attempted' },
    ],
    expected_actual_task_outcome: 'failed',
  };
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'agent' }, response: { ok: true, session_id: 'S', turn_id: 'T', last_event_id: 1 } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T', after_event_id: 1 }, response: {
      ok: true, session_id: 'S', turn_id: 'T', turn_status: 'failed', last_event_id: 3,
      terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'failed', last_event_id: 2,
        result_sha256: null, result_truncated: false },
    } },
    { tool: 'cursor_close_session', request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
  ];
  const safeEvidence = [
    { kind: 'write-result', step_id: 'write-before-failure', callback_id: 'write-failed-turn', outcome: 'succeeded' },
    { kind: 'effect.file-written', step_id: 'write-before-failure', callback_id: 'write-failed-turn' },
    { event: 'terminal_armed', step_id: 'terminal-failed', turn_status: 'failed' },
  ];
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 }, safeEvidence,
    { actual_task_outcome: 'failed', reported_task_outcome: 'not_checked' });
  assert.equal(observations.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index, 1);
  assert.ok(scoreWithCapturedFinals(scenario, observations).mismatches.includes('authority-mismatch'));
});

test('delegate start rejection is observed without inventing a session or close', async () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-unused', result_text: 'UNEXPECTED' }] },
    expected_trace: [{ kind: 'session.start-rejected', error_code: 'scope_rejected' }],
    fixture_predicate: { kind: 'start-rejected', error_code: 'scope_rejected' },
    expected_actual_task_outcome: 'failed', expected_enabled_eval_status: 'pass',
    report_checks: [{ turn_index: 1, required_fragments: ['scope_rejected'], forbidden_fragments: [] }],
  };
  const transcript = { calls: [{ tool: 'cursor_delegate', request: { mode: 'ask', plugin_dirs_count: 1 },
    response: { ok: false, error_code: 'scope_rejected' } }], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 1 }] };
  const outcomes = await observeFixtureOutcome(scenario, '', ['scope_rejected'], [], transcript);
  const observations = observationsFromEvidence(scenario, transcript, [], outcomes);
  assert.deepEqual(observations.trace, [{ kind: 'session.start-rejected', error_code: 'scope_rejected', call_outcome: 'failed' }]);
  assert.deepEqual(scoreWithCapturedFinals(scenario, observations, ['scope_rejected']).mismatches, []);
});

test('allocated delegate init tombstone is reported without wait, retry or fallback', async () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-unused', result_text: 'UNEXPECTED' }] },
    expected_trace: [{ kind: 'session.allocated', mode: 'ask' }, { kind: 'session.tombstoned', session_state: 'tombstone' }],
    fixture_predicate: { kind: 'delegate-init-failed', failure_kind: 'init' },
    expected_actual_task_outcome: 'failed', expected_enabled_eval_status: 'pass',
    report_checks: [{ turn_index: 1, category: 'interaction',
      required_fragments: ['session_id', 'failure_kind', 'provider_error'], forbidden_fragments: [] }],
  };
  const transcript = { calls: [{ tool: 'cursor_delegate', request: { mode: 'ask' }, response: {
    ok: true, session_id: 'session-init-failed', session_state: 'tombstone', failure_kind: 'init',
    provider_error: { code: -32001, message: { text: 'authentication required', truncated: false } },
  } }], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 1 }] };
  const report = `session_id failure_kind provider_error ${JSON.stringify({ session_id: 'session-init-failed', failure_kind: 'init',
    provider_error: transcript.calls[0].response.provider_error })}`;
  const outcomes = await observeFixtureOutcome(scenario, '', [report], [], transcript);
  const observations = observationsFromEvidence(scenario, transcript, [], outcomes);
  assert.deepEqual(observations.trace, [
    { kind: 'session.allocated', session_id: 'session-init-failed', mode: 'ask', call_outcome: 'succeeded' },
    { kind: 'session.tombstoned', session_state: 'tombstone', session_id: 'session-init-failed', call_outcome: 'succeeded' },
  ]);
  assert.deepEqual(outcomes, { actual_task_outcome: 'failed' });
  assert.deepEqual(scoreWithCapturedFinals(scenario, observations, [report]).mismatches, []);
});

async function finalizeChildResult(fixture, result, error = null, cleanupAlreadyFailed = false, destination = process.env.CURSOR_EVAL_CHILD_RESULT) {
  let cleanupStatus = cleanupAlreadyFailed ? 'failed' : 'succeeded';
  try { await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { cleanupStatus = 'failed'; }
  const value = result
    ? { ...result, provenance: { ...result.provenance, cleanup_status: cleanupStatus } }
    : { schema_version: 1, scenario_id: process.env.CURSOR_EVAL_SCENARIO_ID, error_code: 'child_failure', message: String(error?.message || 'child failed').slice(0, 8_000), cleanup_status: cleanupStatus };
  await writeChildResult(value, destination);
  if (cleanupStatus === 'failed' && !error) throw new Error('integration child cleanup failed');
}

async function cleanupHostedRunner(runner, hostedThreadId, initialFailure = null) {
  let failure = initialFailure;
  let cleanupFailed = false;
  if (hostedThreadId) {
    try { await runner.archiveThread(hostedThreadId); }
    catch (error) { failure ||= error; cleanupFailed = true; }
  }
  try { await runner.close(); }
  catch (error) { failure ||= error; cleanupFailed = true; }
  return { failure, cleanupFailed };
}

function boundedDiagnosticText(value, limit = 4_000) {
  return typeof value === 'string' ? Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8') : null;
}

function normalizedTurnError(value) {
  if (typeof value === 'string') return { message: boundedDiagnosticText(value), codex_error_info: null };
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const message = boundedDiagnosticText(value.message);
  const codexErrorInfo = boundedDiagnosticText(value.codexErrorInfo, 256);
  return message === null && codexErrorInfo === null ? null : { message, codex_error_info: codexErrorInfo };
}

function normalizedId(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? boundedDiagnosticText(String(value), 256) : null;
}

function normalizedThreadStatus(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || !THREAD_STATUS_TYPES.has(value.type)) return null;
  return {
    type: value.type,
    active_flags: Array.isArray(value.activeFlags)
      ? value.activeFlags.filter((flag) => THREAD_ACTIVE_FLAGS.has(flag)).slice(0, HOSTED_FAILURE_EVENT_LIMIT) : [],
  };
}

async function snapshotHostedFailureSource(path, dependencies = {}) {
  const stream = dependencies.createReadStream || createReadStream;
  const hash = createHash('sha256');
  let sourceBytes = 0;
  let retained = Buffer.alloc(0);
  try {
    for await (const value of stream(path)) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk); sourceBytes += chunk.length;
      if (chunk.length >= HOSTED_FAILURE_SOURCE_LIMIT) retained = chunk.subarray(chunk.length - HOSTED_FAILURE_SOURCE_LIMIT);
      else {
        const combined = Buffer.concat([retained, chunk]);
        retained = combined.length <= HOSTED_FAILURE_SOURCE_LIMIT
          ? combined : combined.subarray(combined.length - HOSTED_FAILURE_SOURCE_LIMIT);
      }
    }
    return {
      status: sourceBytes > retained.length ? 'truncated' : 'captured',
      source_bytes: sourceBytes,
      source_sha256: hash.digest('hex'),
      retained_bytes: retained.length,
      retained_range: sourceBytes > retained.length ? 'tail' : 'full',
      utf8: retained.toString('utf8'),
    };
  } catch (error) {
    return {
      status: error?.code === 'ENOENT' ? 'missing' : 'read_error',
      source_bytes: null, source_sha256: null, retained_bytes: 0, retained_range: null, utf8: null,
      error: boundedDiagnosticText(String(error?.message || error), 1_000),
    };
  }
}

async function hostedFailureDiagnostics(runner, threadId, turnId) {
  let turn = null;
  let threadReadError = null;
  if (threadId) {
    try {
      const current = await runner.request('thread/read', { threadId, includeTurns: true });
      turn = current.thread?.turns?.find(({ id }) => id === turnId) ?? null;
    } catch (error) {
      threadReadError = boundedDiagnosticText(String(error?.message || error), 1_000);
    }
  }
  return {
    turn: turn ? { id: normalizedId(turn.id), status: typeof turn.status === 'string' ? boundedDiagnosticText(turn.status, 256) : null,
      error: normalizedTurnError(turn.error) } : null,
    thread_read_error: threadReadError,
    notification_methods: (runner.notifications || []).slice(-HOSTED_FAILURE_EVENT_LIMIT)
      .map(({ method }) => typeof method === 'string' ? boundedDiagnosticText(method, 256) : null),
    lifecycle_notifications: (runner.notifications || [])
      .filter(({ method }) => ['turn/started', 'turn/completed', 'thread/status/changed', 'account/rateLimits/updated'].includes(method))
      .slice(-HOSTED_FAILURE_EVENT_LIMIT)
      .map(({ method, params, at_ms: atMs }) => ({
        method, at_ms: atMs,
        thread_id: normalizedId(params?.threadId ?? params?.thread?.id),
        turn_id: normalizedId(params?.turnId ?? params?.turn?.id),
        turn_status: typeof params?.turn?.status === 'string' ? boundedDiagnosticText(params.turn.status, 256) : null,
        thread_status: normalizedThreadStatus(params?.status),
      })),
    client_requests: (runner.clientRequests || [])
      .filter(({ method }) => ['thread/start', 'thread/read', 'turn/start', 'thread/archive'].includes(method))
      .slice(-HOSTED_FAILURE_EVENT_LIMIT)
      .map(({ id, method, thread_id: threadId, at_ms: atMs }) => ({
        id: normalizedId(id), method: boundedDiagnosticText(method, 256), at_ms: atMs,
        thread_id: normalizedId(threadId),
      })),
    server_requests: (runner.serverRequests || []).slice(-HOSTED_FAILURE_EVENT_LIMIT).map(({ id, method, params }) => ({
      id: normalizedId(id),
      method: boundedDiagnosticText(method, 256),
      server_name: boundedDiagnosticText(params?.serverName, 256),
      approval_kind: boundedDiagnosticText(params?._meta?.codex_approval_kind, 256),
    })),
    stderr_tail: Buffer.concat(runner.stderr || []).toString('utf8').slice(-4_000),
  };
}

async function persistHostedFailureDiagnostics({ diagnostics, evidenceRoot, mcpPath, originalError, safeEvidencePath, scenarioId }, dependencies = {}) {
  const makeDirectory = dependencies.mkdir || mkdir;
  const publish = dependencies.writeFile || writeFile;
  const move = dependencies.rename || rename;
  const snapshot = dependencies.snapshot || snapshotHostedFailureSource;
  const identifier = (dependencies.randomUUID || randomUUID)();
  const finalPath = join(evidenceRoot, `hosted-failure-${identifier}.json`);
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  const [mcp, acpSafe] = await Promise.all([snapshot(mcpPath), snapshot(safeEvidencePath)]);
  const sidecar = {
    schema_version: 1,
    kind: 'hosted_failure_diagnostics',
    scenario_id: boundedDiagnosticText(scenarioId, 256),
    original_error: { message: boundedDiagnosticText(String(originalError?.message || originalError), 8_000) },
    hosted: diagnostics,
    sources: { mcp, acp_safe: acpSafe },
  };
  const encoded = Buffer.from(JSON.stringify(sidecar));
  try {
    await makeDirectory(evidenceRoot, { recursive: true });
    await publish(temporaryPath, encoded, { flag: 'wx' });
    await move(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { path: finalPath, bytes: encoded.length, sha256: sha256(encoded) };
}

async function captureHostedFailure(error, options, dependencies = {}) {
  const diagnostics = await hostedFailureDiagnostics(options.runner, options.threadId, options.turnId);
  try {
    const ref = await persistHostedFailureDiagnostics({ ...options, diagnostics, originalError: error }, dependencies);
    return new Error(`hosted_diagnostics_ref=${JSON.stringify(ref)}; original_error=${boundedDiagnosticText(String(error?.message || error), 8_000)}`, { cause: error });
  } catch (persistenceError) {
    const persistence = { status: 'failed', message: boundedDiagnosticText(String(persistenceError?.message || persistenceError), 1_000) };
    return new Error(`hosted_diagnostics_persistence=${JSON.stringify(persistence)}; original_error=${boundedDiagnosticText(String(error?.message || error), 8_000)}; hosted_diagnostics=${JSON.stringify(diagnostics)}`, { cause: error });
  }
}

async function cleanupCredentialFreeRunner(runner, providerChild, initialFailure = null, stop = stopProcess) {
  let failure = initialFailure;
  let cleanupFailed = false;
  try { await runner.close(); }
  catch (error) { failure ||= error; cleanupFailed = true; }
  try { await stop(providerChild); }
  catch (error) { failure ||= error; cleanupFailed = true; }
  return { failure, cleanupFailed };
}

test('hosted runner cleanup surfaces archive failure and still closes transport', async () => {
  const archiveFailure = new Error('archive failed');
  let closed = false;
  const cleanup = await cleanupHostedRunner({
    archiveThread: async () => { throw archiveFailure; },
    close: async () => { closed = true; },
  }, 'thread-1');
  assert.equal(cleanup.failure, archiveFailure);
  assert.equal(cleanup.cleanupFailed, true);
  assert.equal(closed, true);
});

test('credential-free cleanup preserves cleanup precedence across runner and provider failures', async () => {
  const closeFailure = new Error('close failed');
  let stopAttempted = false;
  const cleanup = await cleanupCredentialFreeRunner({ close: async () => { throw closeFailure; } }, {}, null, async () => {
    stopAttempted = true;
    throw new Error('provider stop failed');
  });
  assert.equal(cleanup.failure, closeFailure);
  assert.equal(cleanup.cleanupFailed, true);
  assert.equal(stopAttempted, true);
});

async function startProvider(env) {
  const child = spawn(process.execPath, [fakeProvider], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const diagnostics = [];
  child.stderr.on('data', (chunk) => diagnostics.push(chunk));
  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('scripted provider did not become ready')), 5_000);
      const reader = createInterface({ input: child.stdout });
      const fail = (error) => { clearTimeout(timer); reader.close(); rejectReady(error); };
      reader.once('line', (line) => {
        clearTimeout(timer); reader.close();
        try { resolveReady(JSON.parse(line)); } catch { rejectReady(new Error('scripted provider returned invalid readiness metadata')); }
      });
      child.once('error', fail);
      child.once('exit', (code, signal) => fail(new Error(`scripted provider exited before ready (${code ?? signal}): ${Buffer.concat(diagnostics).toString('utf8').trim()}`)));
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.provider_request_seen, true);
    assert.ok(Number.isInteger(ready.port) && ready.port > 0, 'scripted provider returned invalid port');
    return { child, endpoint: `http://127.0.0.1:${ready.port}` };
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolveClose) => child.once('close', resolveClose));
  child.kill('SIGTERM');
  const graceful = await Promise.race([closed.then(() => true), new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2_000))]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    const killed = await Promise.race([closed.then(() => true), new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2_000))]);
    if (!killed) throw new Error('provider did not close after SIGKILL');
  }
}

async function waitForProviderEvidence(path, minimumRequests = 4) {
  const deadline = Date.now() + 15_000;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      const evidence = JSON.parse(await readFile(path, 'utf8'));
      latest = evidence;
      if (evidence.requests >= minimumRequests) return evidence;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`scripted provider did not observe a complete tool loop: ${JSON.stringify(latest)}`);
}

async function waitForMcpEvidence(path, minimumTranscriptLength = 3, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    try { const value = JSON.parse(await readFile(path, 'utf8')); latest = value; if (value.transcript?.length >= minimumTranscriptLength) return value; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`recording MCP proxy did not publish tool transcript: ${JSON.stringify(latest)}`);
}

async function stableMcpTranscriptLength(path, timeoutMs = 5_000, minimumTranscriptLength = 1) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const evidence = await waitForMcpEvidence(path, minimumTranscriptLength, Math.min(500, Math.max(25, deadline - Date.now())));
    const length = evidence.transcript.length;
    if (length === previous) stableReads += 1;
    else { previous = length; stableReads = 0; }
    if (stableReads >= 2) return length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`recording MCP proxy transcript did not stabilize: ${previous}`);
}

async function assertHostedMcpConnected(runner, threadId, pluginId) {
  const status = await runner.request('mcpServerStatus/list', { threadId, detail: 'full' });
  assert.equal(status.nextCursor ?? null, null, 'isolated hosted fixture unexpectedly paginated MCP status');
  const selected = status.data?.find(({ name }) => name === 'cursor-subagent');
  assert.equal(selected?.pluginId, pluginId, 'hosted turn did not select the installed Cursor MCP server');
  assert.equal(selected?.runtimeStatus, 'connected', 'selected Cursor MCP server is not connected');
}

async function waitForFollowupAnchor(followup, mcpPath, safeEvidencePath, timeoutMs = 90_000, terminalProbe = null) {
  const deadline = Date.now() + timeoutMs;
  let latest = null; let lastProbeAt = 0;
  while (Date.now() < deadline) {
    if (followup.after_kind === 'wait-timeout') {
      try {
        latest = JSON.parse(await readFile(mcpPath, 'utf8'));
        if (latest.transcript?.some(({ tool, response }) => tool === 'cursor_wait' && response?.wait_timeout === true)) return { kind: 'anchor' };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      latest = await readSafeEvidence(safeEvidencePath);
      const event = followup.after_kind === 'pending' ? 'pending_emitted' : 'prompt_result';
      if (latest.some((entry) => entry.event === event && entry.step_id === followup.after_step)) return { kind: 'anchor' };
    }
    if (terminalProbe && Date.now() - lastProbeAt >= 2_000) {
      lastProbeAt = Date.now();
      const terminal = await terminalProbe();
      if (terminal) return { kind: 'terminal', turn: terminal };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`follow-up anchor did not appear: ${JSON.stringify({ followup, latest })}`);
}

function isTransientThreadPersistenceError(error) {
  return error?.message === 'list_turns is not supported yet'
    || (error?.message?.includes('failed to read session metadata') && error.message.includes(' is empty'));
}

function hasConfirmedInterruptedNotification(runner, turnId) {
  return runner.notifications?.some(({ method, params }) => {
    const turn = params?.turn ?? null;
    return method === 'turn/completed'
      && (turn?.id ?? params?.turnId) === turnId
      && (turn?.status ?? params?.status) === 'interrupted';
  }) ?? false;
}

function isConfirmedTerminalTurn(runner, turn) {
  if (!turn || !['completed', 'failed', 'interrupted'].includes(turn.status)) return false;
  return turn.status !== 'interrupted' || hasConfirmedInterruptedNotification(runner, turn.id);
}

async function waitForExactTurnTerminal(runner, threadId, turnId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      const thread = await runner.request('thread/read', { threadId, includeTurns: true });
      latest = thread.thread?.turns?.find(({ id }) => id === turnId) ?? null;
    } catch (error) {
      // Codex 0.152.1 can transiently answer thread/read with this backend
      // capability error while the turn is being persisted. It is not a
      // scenario verdict; keep the bounded terminal poll alive.
      if (!isTransientThreadPersistenceError(error)) throw error;
    }
    if (isConfirmedTerminalTurn(runner, latest)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`evaluated turn did not become terminal: ${JSON.stringify({ turn_id: turnId, status: latest?.status ?? null })}`);
}

test('terminal polling tolerates the transient Codex list_turns capability race', async () => {
  let calls = 0;
  const runner = { request: async () => {
    calls += 1;
    if (calls === 1) throw new Error('list_turns is not supported yet');
    if (calls === 2) throw new Error('failed to read thread: failed to read session metadata /tmp/rollout.jsonl: rollout is empty');
    return { thread: { turns: [{ id: 'turn-1', status: 'completed' }] } };
  } };
  assert.deepEqual(await waitForExactTurnTerminal(runner, 'thread-1', 'turn-1', 2_500),
    { id: 'turn-1', status: 'completed' });
  assert.equal(calls, 3);
});

test('terminal polling ignores an unconfirmed interrupted persistence snapshot', async () => {
  let calls = 0;
  const runner = {
    notifications: [{ method: 'turn/started', params: { turn: { id: 'turn-1', status: 'inProgress' } } }],
    request: async () => {
      calls += 1;
      const status = calls === 1 ? 'interrupted' : calls === 2 ? 'inProgress' : 'completed';
      return { thread: { turns: [{ id: 'turn-1', status }] } };
    },
  };
  assert.deepEqual(await waitForExactTurnTerminal(runner, 'thread-1', 'turn-1', 2_500),
    { id: 'turn-1', status: 'completed' });
  assert.equal(calls, 3);
});

test('terminal polling accepts interruption confirmed by its completion notification', async () => {
  const runner = {
    notifications: [{ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted' } } }],
    request: async () => ({ thread: { turns: [{ id: 'turn-1', status: 'interrupted' }] } }),
  };
  assert.deepEqual(await waitForExactTurnTerminal(runner, 'thread-1', 'turn-1', 1_000),
    { id: 'turn-1', status: 'interrupted' });
});

test('a completed turn before its follow-up anchor keeps the exact final and skips the follow-up', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-early-terminal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mcpPath = join(root, 'mcp.json');
  await writeFile(mcpPath, JSON.stringify({ schema_version: 1, transcript: [], dropped_calls: 0 }), 'utf8');
  let followupStarts = 0;
  const runner = {
    request: async (method) => {
      assert.equal(method, 'mcpServerStatus/list');
      return { data: [{ name: 'cursor-subagent', pluginId: 'plugin-1', runtimeStatus: 'connected' }], nextCursor: null };
    },
    captureTurnFinal: async () => ({ turn_id: 'turn-1', turn_status: 'completed', text: 'Stopped early.',
      phase: 'final_answer', source: 'thread/items/list', completeness: 'complete', error_code: null }),
    startTurn: async () => { followupStarts += 1; },
  };
  const anchor = await waitForFollowupAnchor({ after_kind: 'pending', after_step: 'question-1' }, mcpPath,
    join(root, 'safe.jsonl'), 1_000, async () => ({ id: 'turn-1', status: 'completed' }));
  const capturedFinals = [{ turn_index: 1, ...await runner.captureTurnFinal() }];
  if (anchor.kind === 'anchor') await runner.startTurn();
  await assertHostedMcpConnected(runner, 'thread-1', 'plugin-1');
  const mcp = await waitForMcpEvidence(mcpPath, 0, 1_000);
  const scenario = {
    scenario_kind: 'programmed', followups: [{ input: 'Continue.' }],
    program: { steps: [{ type: 'pending', step_id: 'question-1' }] },
    expected_trace: [{ kind: 'session.allocated', mode: 'ask' }], expected_actual_task_outcome: 'succeeded',
    report_checks: [
      { turn_index: 1, category: 'interaction', required_fragments: ['Stopped early.'], forbidden_fragments: [] },
      { turn_index: 2, category: 'interaction', required_fragments: ['continued'], forbidden_fragments: [] },
    ],
  };
  const oracle = evaluateScenario(scenario, { trace: [], callbacks: [], effects: [], actual_task_outcome: 'failed',
    captured_finals: capturedFinals, transcript: { calls: mcp.transcript, dropped_calls: mcp.dropped_calls,
      turn_call_ranges: [{ start: 0, end: 0 }], unexpected_input_requests: 0 } });
  assert.equal(anchor.kind, 'terminal');
  assert.equal(followupStarts, 0);
  assert.equal(capturedFinals[0].completeness, 'complete');
  assert.equal(capturedFinals[0].text, 'Stopped early.');
  assert.equal(oracle.eval_status, 'agent_behavior_mismatch');
  assert.ok(oracle.mismatches.includes('interaction-report-mismatch'));
  await assert.rejects(assertHostedMcpConnected({ request: async () => ({ data: [{ name: 'cursor-subagent',
    pluginId: 'plugin-1', runtimeStatus: 'failed' }] }) }, 'thread-1', 'plugin-1'), /not connected/);
  await assert.rejects(waitForFollowupAnchor({ after_kind: 'pending', after_step: 'question-1' }, mcpPath,
    join(root, 'safe.jsonl'), 1_000, async () => { throw new Error('terminal probe transport failed'); }),
  /terminal probe transport failed/);
});

async function writeChildResult(result, destination = process.env.CURSOR_EVAL_CHILD_RESULT) {
  if (!destination) return;
  const value = { schema_version: 1, ...result };
  const serialized = JSON.stringify(value);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 1_048_576, 'child result exceeded 1 MiB');
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(temporary, serialized, 'utf8');
  await rename(temporary, destination);
}

test('behavior mismatch finalization preserves complete proof for outer classification', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-eval-mismatch-proof-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = join(root, 'fixture');
  const destination = join(root, 'child-result.json');
  await mkdir(fixtureRoot);
  const digest = (character) => ({ sha256: character.repeat(64), bytes: 1 });
  const skillDigest = digest('a');
  const scenario = { scenario_kind: 'programmed', followups: [{ input: 'Continue.' }] };
  const result = {
    scenario_id: 'forced-behavior-mismatch',
    provenance: {
      consumed_scenario: digest('b'), consumed_corpus: digest('c'), adapter: digest('d'),
      evaluator: digest('9'),
      managed_installed_skill: skillDigest, cache_loaded_skill: skillDigest,
      installed_payload: { marker_format: 1, payload_hash: 'e'.repeat(64), artifact_hash: 'f'.repeat(64), manifest_version: '0.1.0+codex.fixture' },
      client: { name: 'codex-app-server', version: '0.152.1' }, model: { provider: null, name: null },
    },
    observations: { trace: [], callbacks: [], effects: [], actual_task_outcome: 'failed', reported_task_outcome: 'not_checked',
      assertion_outcome: 'fail', eval_status: 'agent_behavior_mismatch' },
    captured_finals: [{ turn_index: 1, text: 'CURSOR_EVAL_OK', turn_id: 'turn-1', turn_status: 'completed',
      phase: 'final_answer', source: 'thread/items/list', completeness: 'complete', error_code: null }],
    transcript: { calls: [], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 0 }], unexpected_input_requests: 0 },
    provider_oracle: { terminal_result_matched: false },
  };
  await finalizeChildResult({ root: fixtureRoot }, result, new Error('forced oracle mismatch'), false, destination);
  const parsed = parseChildResult(await readFile(destination, 'utf8'), result.scenario_id, { scenario });
  assert.equal(parsed.observations.eval_status, 'agent_behavior_mismatch');
  assert.equal(parsed.provenance.cleanup_status, 'succeeded');
  assert.deepEqual(parsed.transcript, result.transcript);
  const harness = await runHarness({ pattern: 'forced mismatch', test: '/tmp/forced-mismatch.test.mjs', scenario }, {
    CURSOR_EVAL_CHILD_RESULT: destination, CURSOR_EVAL_SCENARIO_ID: result.scenario_id,
  }, {
    runSupervisor: async () => ({ verdict: 'failed', terminal_cause: 'exit_nonzero', infrastructure: false,
      child: { code: 1, signal: null }, failureDetails: ['forced oracle mismatch'] }),
  });
  assert.equal(harness.failure, 'scenario_contract_mismatch');
  assert.equal(harness.childResult.observations.eval_status, 'agent_behavior_mismatch');
});

test('hosted failure sidecar preserves bounded raw evidence before fixture cleanup', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-hosted-failure-proof-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outerFixture = join(root, 'outer-fixture'); const fixtureRoot = join(outerFixture, 'inner-fixture');
  const evidenceRoot = join(root, 'durable'); const fixtureEvidence = join(fixtureRoot, 'evidence');
  const destination = join(outerFixture, 'child-result.json');
  const mcpPath = join(fixtureEvidence, 'mcp.json'); const safeEvidencePath = join(fixtureEvidence, 'acp-safe.jsonl');
  await mkdir(fixtureEvidence, { recursive: true });
  const mcpRaw = Buffer.from('{"partial_transcript":');
  const safeTail = 'SAFE_LOG_TAIL';
  const safeRaw = Buffer.from(`${'x'.repeat(HOSTED_FAILURE_SOURCE_LIMIT + 32)}${safeTail}`);
  await writeFile(mcpPath, mcpRaw); await writeFile(safeEvidencePath, safeRaw);
  const forbidden = ['FORBIDDEN_REQUEST_PARAMS', 'FORBIDDEN_PROVIDER_DETAILS', 'FORBIDDEN_LIFECYCLE_OBJECT', 'FORBIDDEN_TURN_TEXT'];
  const runner = {
    request: async () => ({ thread: { turns: [{ id: 'turn-1', status: 'inProgress',
      error: { message: 'bounded provider message', codexErrorInfo: 'rateLimitExceeded', details: forbidden[1] },
      items: [{ id: 'item-1', type: 'agentMessage', status: 'inProgress', text: forbidden[3] }] }] } }),
    notifications: [{ method: 'thread/status/changed', params: { threadId: 'thread-1',
      status: { type: 'active', activeFlags: ['waitingOnApproval'], extra: forbidden[2] } }, at_ms: 123 }],
    clientRequests: [{ id: 7, method: 'thread/read', thread_id: 'thread-1', at_ms: 124 }],
    serverRequests: [{ id: 8, method: 'mcpServer/elicitation/request', params: { serverName: 'cursor-subagent',
      _meta: { codex_approval_kind: 'mcp_tool_call' }, prompt: forbidden[0] } }],
    stderr: [Buffer.from('bounded stderr')],
  };
  const original = new Error(`original hosted failure ${'z'.repeat(9_000)}`);
  const captured = await captureHostedFailure(original, { runner, threadId: 'thread-1', turnId: 'turn-1',
    evidenceRoot, mcpPath, safeEvidencePath, scenarioId: 'model-test' }, { randomUUID: () => 'fixed-id' });
  assert.equal(captured.cause, original);
  const ref = JSON.parse(captured.message.match(/^hosted_diagnostics_ref=({[^;]+})/)[1]);
  await finalizeChildResult({ root: fixtureRoot }, null, captured, false, destination);
  assert.equal(JSON.parse(await readFile(destination)).message.startsWith('hosted_diagnostics_ref='), true);
  await rm(outerFixture, { recursive: true, force: true });
  const encoded = await readFile(ref.path); const sidecar = JSON.parse(encoded);
  assert.equal(ref.sha256, sha256(encoded)); assert.equal(ref.bytes, encoded.length);
  assert.deepEqual(sidecar.sources.mcp, { status: 'captured', source_bytes: mcpRaw.length,
    source_sha256: sha256(mcpRaw), retained_bytes: mcpRaw.length, retained_range: 'full', utf8: mcpRaw.toString() });
  assert.equal(sidecar.sources.acp_safe.status, 'truncated');
  assert.equal(sidecar.sources.acp_safe.source_sha256, sha256(safeRaw));
  assert.equal(sidecar.sources.acp_safe.retained_bytes, HOSTED_FAILURE_SOURCE_LIMIT);
  assert.ok(sidecar.sources.acp_safe.utf8.endsWith(safeTail));
  assert.deepEqual(sidecar.hosted.server_requests, [{ id: '8', method: 'mcpServer/elicitation/request',
    server_name: 'cursor-subagent', approval_kind: 'mcp_tool_call' }]);
  assert.deepEqual(sidecar.hosted.turn.error, { message: 'bounded provider message', codex_error_info: 'rateLimitExceeded' });
  assert.equal(sidecar.hosted.lifecycle_notifications[0].turn_status, null);
  assert.deepEqual(sidecar.hosted.lifecycle_notifications[0].thread_status,
    { type: 'active', active_flags: ['waitingOnApproval'] });
  for (const sentinel of forbidden) assert.ok(!encoded.includes(Buffer.from(sentinel)), sentinel);
});

test('hosted failure source snapshot distinguishes missing and read errors', async () => {
  const missing = await snapshotHostedFailureSource('/definitely/missing/hosted-eval-source');
  assert.equal(missing.status, 'missing'); assert.equal(missing.utf8, null);
  const readError = await snapshotHostedFailureSource('/unused', { createReadStream: () => ({
    async *[Symbol.asyncIterator]() { throw Object.assign(new Error('forced source read failure'), { code: 'EIO' }); },
  }) });
  assert.equal(readError.status, 'read_error'); assert.equal(readError.error, 'forced source read failure');
});

test('hosted diagnostic publication failure retains original cause and cleanup', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-hosted-failure-publish-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = join(root, 'fixture'); const blockedRoot = join(root, 'not-a-directory');
  const destination = join(root, 'child-result.json'); await mkdir(fixtureRoot); await writeFile(blockedRoot, 'blocked');
  const original = new Error(`original failure ${'z'.repeat(9_000)}`);
  let archives = 0; let closes = 0;
  const runner = { request: async () => ({ thread: { turns: [] } }), notifications: [], clientRequests: [], serverRequests: [], stderr: [],
    archiveThread: async () => { archives += 1; }, close: async () => { closes += 1; } };
  const captured = await captureHostedFailure(original, { runner, threadId: 'thread-1', turnId: 'turn-1', evidenceRoot: blockedRoot,
    mcpPath: join(fixtureRoot, 'missing-mcp.json'), safeEvidencePath: join(fixtureRoot, 'missing-safe.jsonl'), scenarioId: 'model-test' });
  assert.equal(captured.cause, original);
  assert.match(captured.message, /^hosted_diagnostics_persistence=.*original_error=original failure/);
  const cleanup = await cleanupHostedRunner(runner, 'thread-1', captured);
  assert.equal(cleanup.failure, captured); assert.equal(cleanup.cleanupFailed, false);
  assert.equal(archives, 1); assert.equal(closes, 1);
  await finalizeChildResult({ root: fixtureRoot }, null, cleanup.failure, cleanup.cleanupFailed, destination);
  await assert.rejects(access(fixtureRoot));
  const result = JSON.parse(await readFile(destination));
  assert.match(result.message, /^hosted_diagnostics_persistence=/);
  assert.match(result.message, /original_error=original failure/);
  assert.equal(result.cleanup_status, 'succeeded');
});

test('credential-free Codex client observes only the package-bootstrap-installed skill', async (t) => {
  const fixture = await layout(); t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const node = await realpath(process.execPath);
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]) };
  const installed = await runBootstrap(['install', '--source-root', fixture.source,
    '--managed-marketplace-root', fixture.managed, '--node-executable', node,
    '--codex-executable', codex, '--agent-executable', fixture.fakeAgent,
    '--allowed-workspace-root', fixture.allowedWorkspace], { env });
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.envelope));
  await rename(fixture.source, fixture.hidden);
  const client = new CodexAppServerClient(codex, ['app-server', '--stdio'], env);
  try {
    await client.initialize();
    const evidence = await client.skillLoadEvidence(fixture.workspace, skill);
    assert.equal(evidence.enabled, true);
    assert.match(evidence.path, new RegExp(`^${fixture.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/plugins/cache/`));
    assert.ok(!evidence.path.startsWith(repository), 'Codex read the source checkout instead of the isolated installed payload');
    assert.equal(evidence.content_sha256, fixture.skillSha256);
    assert.equal(evidence.content_bytes, fixture.skillBytes);
  } finally { await client.close(); }
});

test('hosted Codex actually calls the installed Cursor MCP tools', { skip: process.env.CURSOR_EVAL_HOSTED_CODEX === '1' ? false : 'requires explicit hosted-auth eval lane' }, async (t) => {
  const phase = (name) => process.stderr.write(`[hosted-eval] ${name}\n`);
  phase('scenario-loaded');
  const outer = await readOuterScenario();
  const evaluator = await evaluatorProof();
  const fixture = await layout(outer.workspace);
  t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const evidenceRoot = join(fixture.root, 'evidence');
  await mkdir(evidenceRoot);
  const safeEvidencePath = join(evidenceRoot, 'acp-safe.jsonl');
  const programPath = await ensureProgramPath(fixture, outer.scenario);
  const harnessFaults = new Set(outer.scenario.harness_faults || []);
  const followupReleasePath = join(fixture.root, 'followup-release');
  await prepareScenarioWorkspace(outer.workspace, outer.scenario);
  const authFile = await resolveHostedAuthFile();
  phase('auth-resolved');
  const node = await realpath(process.execPath);
  await cp(authFile, join(fixture.home, 'auth.json'));
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]),
    CURSOR_EVAL_ADAPTER_TIMEOUT_MS: '60000',
    CURSOR_AGENT_COMMAND: node, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
    FAKE_ACP_EXPECT_CODEX_HOME: fixture.home, CURSOR_EVAL_WORKSPACE: outer.workspace,
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, CURSOR_EVAL_MCP_EVIDENCE: join(evidenceRoot, 'mcp.json'),
    FAKE_ACP_SAFE_EVIDENCE: safeEvidencePath,
    CURSOR_EVAL_TIMEOUT_PRELOAD: await fakeCursorPreload(fixture),
    ...(harnessFaults.has('accelerate-turn-timeout') ? { FAKE_ACP_ACCELERATE_TURN_TIMEOUT: '1' } : {}),
    ...(harnessFaults.has('accelerate-wait-timeout') ? { FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1' } : {}) };
  await configureFakeAgent(fixture.fakeAgent, {
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    FAKE_ACP_SAFE_EVIDENCE: env.FAKE_ACP_SAFE_EVIDENCE,
    ...(harnessFaults.has('exit-after-result') ? { FAKE_ACP_EXIT_AFTER_RESULT: '1' } : {}),
    ...(harnessFaults.has('reject-initialize') ? { FAKE_ACP_INIT_RESPONSE_VARIANT: 'provider-error' } : {}),
    ...(harnessFaults.has('reject-prompt') ? { FAKE_ACP_REJECT_PROMPT: '1' } : {}),
    ...(harnessFaults.has('result-overflow') ? { FAKE_ACP_RESULT_OVERFLOW: '1' } : {}),
    ...(harnessFaults.has('reject-resume') ? { FAKE_ACP_LOAD_VARIANT: 'reject' } : {}),
    ...(harnessFaults.has('hold-terminal-until-followup') ? { FAKE_ACP_FOLLOWUP_RELEASE_PATH: followupReleasePath } : {}),
    ...(harnessFaults.has('accelerate-turn-timeout') ? { FAKE_ACP_ACCELERATE_TURN_TIMEOUT: '1' } : {}),
    ...(harnessFaults.has('mode-timeout') ? { FAKE_ACP_DELAY_INIT_MS: '250', FAKE_ACP_SET_MODE_VARIANT: 'no-response',
      FAKE_ACP_SET_MODE_FAIL_AFTER: '1' } : {}),
    ...(harnessFaults.has('accelerate-wait-timeout') ? { FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1' } : {}),
    ...(harnessFaults.has('reject-mode') ? { FAKE_ACP_SET_MODE_VARIANT: 'error', FAKE_ACP_SET_MODE_FAIL_AFTER: '1' } : {}),
  });
  const installed = await runBootstrap(['install', '--source-root', fixture.source,
    '--managed-marketplace-root', fixture.managed, '--node-executable', node,
    '--codex-executable', codex, '--agent-executable', fixture.fakeAgent,
    '--allowed-workspace-root', fixture.allowedWorkspace], { env,
    runCommand: (command, args, options) => runPackageCommand(command, args, { ...options, timeoutMs: 70_000 }) });
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.envelope));
  phase('package-installed');
  await rename(fixture.source, fixture.hidden);
  const hostedConfig = hostedAppServerConfig(env);
  const runner = new CodexAppServerClient(codex, hostedConfig.args, env, {
    requestTimeoutMs: 120_000, outputLimit: HOSTED_APP_SERVER_OUTPUT_LIMIT,
    onServerRequest: acceptOnlyCursorToolElicitation,
  });
  let hostedThreadId = null;
  let hostedTurnId = null;
  let childResult = null;
  let failure = null;
  try {
    phase('app-server-initialize');
    await runner.initialize();
    phase('app-server-initialized');
    const skillEvidence = await runner.skillLoadEvidence(fixture.workspace, skill);
    assert.equal(typeof skillEvidence.plugin_id, 'string');
    assert.equal(skillEvidence.content_sha256, fixture.skillSha256);
    assert.equal(skillEvidence.content_bytes, fixture.skillBytes);
    phase('skill-loaded');
    const proof = await packageProof(fixture, node, env, skillEvidence);
    const thread = await runner.startThread({ cwd: fixture.workspace });
    phase('thread-started');
    hostedThreadId = thread.thread.id;
    phase('turn-started');
    let evaluatedTurn = await runner.startTurn({ threadId: thread.thread.id,
      text: outer.scenario.initial_input,
      skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
    hostedTurnId = evaluatedTurn.turn?.id ?? null;
    const capturedFinals = [];
    const reportTranscriptEnds = [];
    const turnSafeEvidenceStarts = [0];
    let completedBeforeFollowupAnchor = false;
    for (const followup of outer.scenario.followups) {
      const anchor = await waitForFollowupAnchor(followup, join(evidenceRoot, 'mcp.json'), safeEvidencePath, HOSTED_OBSERVATION_TIMEOUT_MS, async () => {
        try {
          const current = await runner.request('thread/read', { threadId: thread.thread.id, includeTurns: true });
          const turn = current.thread?.turns?.find(({ id }) => id === evaluatedTurn.turn?.id) ?? null;
          return isConfirmedTerminalTurn(runner, turn) ? turn : null;
        } catch (error) {
          if (isTransientThreadPersistenceError(error)) return null;
          throw error;
        }
      });
      assert.equal(typeof evaluatedTurn.turn?.id, 'string');
      const boundaryTurn = await waitForExactTurnTerminal(runner, thread.thread.id, evaluatedTurn.turn.id, HOSTED_OBSERVATION_TIMEOUT_MS);
      assert.equal(boundaryTurn.status, 'completed', JSON.stringify(boundaryTurn));
      capturedFinals.push({ turn_index: capturedFinals.length + 1,
        ...await runner.captureTurnFinal(thread.thread.id, evaluatedTurn.turn.id) });
      if (anchor.kind === 'terminal') {
        completedBeforeFollowupAnchor = true;
        break;
      }
      reportTranscriptEnds.push(await stableMcpTranscriptLength(join(evidenceRoot, 'mcp.json')));
      if (harnessFaults.has('hold-terminal-until-followup')) {
        const firstTerminal = outer.scenario.program.steps.find(({ type }) => type === 'terminal');
        const heldEvidence = await readSafeEvidence(safeEvidencePath);
        assert.ok(heldEvidence.some(({ event, step_id: stepId }) => event === 'terminal_armed' && stepId === firstTerminal.step_id));
        assert.ok(!heldEvidence.some(({ event, step_id: stepId }) => event === 'prompt_result' && stepId === firstTerminal.step_id),
          'Cursor turn terminalized before the separate Codex follow-up started');
      }
      turnSafeEvidenceStarts.push((await readSafeEvidence(safeEvidencePath)).length);
      evaluatedTurn = await runner.startTurn({ threadId: thread.thread.id, text: followup.input,
        skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
      hostedTurnId = evaluatedTurn.turn?.id ?? null;
      if (harnessFaults.has('hold-terminal-until-followup')) await writeFile(followupReleasePath, 'follow-up turn started', 'utf8');
    }
    if (!completedBeforeFollowupAnchor) {
      assert.equal(typeof evaluatedTurn.turn?.id, 'string');
      const terminalTurn = await waitForExactTurnTerminal(runner, thread.thread.id, evaluatedTurn.turn.id, HOSTED_OBSERVATION_TIMEOUT_MS);
      assert.equal(terminalTurn.status, 'completed', JSON.stringify(terminalTurn));
      capturedFinals.push({ turn_index: capturedFinals.length + 1,
        ...await runner.captureTurnFinal(thread.thread.id, evaluatedTurn.turn.id) });
    }
    phase('terminal-observed');
    const finalTranscriptEnd = await stableMcpTranscriptLength(join(evidenceRoot, 'mcp.json'), HOSTED_OBSERVATION_TIMEOUT_MS, 0);
    const mcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), finalTranscriptEnd, 5_000);
    if (mcp.transcript.length === 0) await assertHostedMcpConnected(runner, thread.thread.id, skillEvidence.plugin_id);
    const safeEvidence = await readSafeEvidence(safeEvidencePath);
    reportTranscriptEnds.push(finalTranscriptEnd);
    const transcriptEvidence = { calls: mcp.transcript, dropped_calls: mcp.dropped_calls,
      turn_call_ranges: reportTranscriptEnds.map((end, index) => ({ start: index === 0 ? 0 : reportTranscriptEnds[index - 1], end })),
      unexpected_input_requests: runner.serverRequests.filter((request) => !isCursorToolElicitation(request)).length,
      turn_safe_evidence_starts: turnSafeEvidenceStarts };
    const outcomes = await observeFixtureOutcome(outer.scenario, outer.workspace,
      capturedFinals.map(({ text }) => text ?? ''), safeEvidence, transcriptEvidence,
      { plugin_dir: join(outer.workspace, 'plugin-bundle') });
    const observations = observationsFromEvidence(outer.scenario, transcriptEvidence, safeEvidence,
      { actual_task_outcome: outcomes.actual_task_outcome });
    const oracle = evaluateScenario(outer.scenario, { ...observations, captured_finals: capturedFinals,
      transcript: transcriptEvidence });
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof,
        evaluator, model: hostedConfig.model },
      observations: { ...observations, reported_task_outcome: oracle.reported_task_outcome,
        assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      captured_finals: capturedFinals,
      transcript: { calls: transcriptEvidence.calls, dropped_calls: transcriptEvidence.dropped_calls,
        turn_call_ranges: transcriptEvidence.turn_call_ranges,
        unexpected_input_requests: transcriptEvidence.unexpected_input_requests },
      provider_oracle: { request_count: mcp.transcript.length,
        skill_context_seen: typeof skillEvidence.plugin_id === 'string' && skillEvidence.content_sha256 === fixture.skillSha256
          && skillEvidence.content_bytes === fixture.skillBytes,
        terminal_result_matched: oracle.assertion_outcome === 'pass', components: oracle.components,
        report_checks: oracle.report_checks,
        prompt_contracts: safeEvidence.filter(({ kind }) => kind === 'prompt.contract'),
        tool_sequence: mcp.transcript.map(({ tool }) => tool), request_trace: mcp.transcript.map(({ tool, call_id: callId }, index) => ({ step: index + 1, tool, call_id: callId })) },
    };
    phase('child-result-built');
    const mismatchDiagnostics = { oracle, trace: observations.trace, capturedFinals };
    if (oracle.eval_status !== 'pass') process.stderr.write(`hosted behavior mismatch: ${JSON.stringify(mismatchDiagnostics)}\n`);
    assert.equal(oracle.eval_status, 'pass', JSON.stringify(mismatchDiagnostics));
    assert.ok(Object.values(oracle.components).every((status) => ['pass', 'not_applicable', 'not_checked'].includes(status)),
      JSON.stringify(mismatchDiagnostics));
  } catch (error) {
    failure = await captureHostedFailure(error, {
      runner, threadId: hostedThreadId, turnId: hostedTurnId,
      evidenceRoot: process.env.CURSOR_EVAL_EVIDENCE_ROOT || join(tmpdir(), 'cursor-eval-evidence'),
      mcpPath: join(evidenceRoot, 'mcp.json'), safeEvidencePath,
      scenarioId: outer.scenario.scenario_id,
    });
  } finally {
    phase('cleanup-started');
    try { await assertEvaluatorUnchanged(evaluator); }
    catch (error) { failure ||= error; }
    const cleanup = await cleanupHostedRunner(runner, hostedThreadId, failure);
    failure = cleanup.failure;
    await finalizeChildResult(fixture, childResult, failure, cleanup.cleanupFailed);
  }
  if (failure) throw failure;
});

test('credential-free client integration completes the installed-skill MCP loop when provisioned', { skip: process.env.CURSOR_EVAL_REAL_CODEX === '1' ? false : 'requires provisioned loopback eval lane' }, async (t) => {
  const outer = await readOuterScenario();
  const evaluator = await evaluatorProof();
  assert.equal(outer.scenario.lane, 'client-integration');
  const fixture = await layout(outer.workspace);
  t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const evidenceRoot = join(fixture.root, 'evidence');
  await mkdir(evidenceRoot);
  const programPath = await ensureProgramPath(fixture, outer.scenario);
  await prepareScenarioWorkspace(outer.workspace, outer.scenario);
  const node = await realpath(process.execPath); const providerEvidence = join(fixture.root, 'provider-safe-evidence.json');
  const safeEvidencePath = join(evidenceRoot, 'acp-safe.jsonl');
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]),
    CURSOR_AGENT_COMMAND: node, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
    FAKE_ACP_EXPECT_CODEX_HOME: fixture.home, CURSOR_EVAL_WORKSPACE: outer.workspace,
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    CURSOR_EVAL_PROVIDER_EVIDENCE: providerEvidence, CURSOR_EVAL_MCP_EVIDENCE: join(evidenceRoot, 'mcp.json'),
    FAKE_ACP_SAFE_EVIDENCE: safeEvidencePath,
    CURSOR_EVAL_TIMEOUT_PRELOAD: await fakeCursorPreload(fixture),
    CURSOR_EVAL_WARMUP: '1', CURSOR_EVAL_DEFERRED_TOOL_SEARCH: '0', CURSOR_EVAL_PROVIDER_PORT: '0' };
  await configureFakeAgent(fixture.fakeAgent, { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, FAKE_ACP_SAFE_EVIDENCE: safeEvidencePath });
  const installed = await runBootstrap(['install', '--source-root', fixture.source,
    '--managed-marketplace-root', fixture.managed, '--node-executable', node,
    '--codex-executable', codex, '--agent-executable', fixture.fakeAgent,
    '--allowed-workspace-root', fixture.allowedWorkspace], { env });
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.envelope));
  const mcpConfig = JSON.parse(await readFile(join(fixture.managed, 'plugins/agents-cursor-subagent-plugin/.mcp.json'), 'utf8'));
  assert.equal(mcpConfig.mcpServers['cursor-subagent'].args[0], join(fixture.managed, 'plugins/agents-cursor-subagent-plugin/scripts/recording-mcp-proxy.mjs'));
  assert.equal(mcpConfig.mcpServers['cursor-subagent'].env.CURSOR_EVAL_MCP_EVIDENCE, join(evidenceRoot, 'mcp.json'));
  await rename(fixture.source, fixture.hidden);
  const provider = await startProvider(env);
  const clientEnv = { ...env, OLLAMA_HOST: provider.endpoint };
  const runner = new CodexAppServerClient(codex, fixtureProviderAppServerArgs(provider.endpoint), clientEnv, { requestTimeoutMs: 15_000, onServerRequest: acceptOnlyCursorToolElicitation });
  let childResult = null;
  let failure = null;
  try {
    await runner.initialize();
    const skillEvidence = await runner.skillLoadEvidence(fixture.workspace, skill);
    assert.equal(skillEvidence.enabled, true);
    assert.equal(typeof skillEvidence.plugin_id, 'string', 'installed skill must disclose its selected plugin identity');
    assert.ok(skillEvidence.path.startsWith(`${fixture.home}/plugins/cache/`));
    assert.equal(skillEvidence.content_sha256, fixture.skillSha256);
    assert.equal(skillEvidence.content_bytes, fixture.skillBytes);
    const installedSkillSelected = typeof skillEvidence.plugin_id === 'string'
      && skillEvidence.content_sha256 === fixture.skillSha256
      && skillEvidence.content_bytes === fixture.skillBytes;
    const proof = await packageProof(fixture, node, clientEnv, skillEvidence);
    const cachedMcpConfig = JSON.parse(await readFile(join(skillEvidence.path, '..', '..', '..', '.mcp.json'), 'utf8'));
    assert.equal(cachedMcpConfig.mcpServers['cursor-subagent'].args[0], join(fixture.managed, 'plugins/agents-cursor-subagent-plugin/scripts/recording-mcp-proxy.mjs'));
    const thread = await runner.startThread({ cwd: fixture.workspace });
    await runner.startTurn({ threadId: thread.thread.id, text: 'Warm up the explicitly selected plugin MCP and return no tools.', skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
    await waitForProviderEvidence(providerEvidence, 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const mcpStatus = await runner.request('mcpServerStatus/list', { threadId: thread.thread.id, detail: 'full' });
    const selectedServer = mcpStatus.data?.find(({ name }) => name === 'cursor-subagent');
    assert.equal(selectedServer?.pluginId, skillEvidence.plugin_id);
    assert.equal(selectedServer?.runtimeStatus, 'connected');
    assert.deepEqual(Object.keys(selectedServer?.tools || {}).sort(), ['cursor_answer_permission', 'cursor_answer_plan', 'cursor_answer_question', 'cursor_cancel', 'cursor_close_session', 'cursor_delegate', 'cursor_list_models', 'cursor_read_result', 'cursor_resume_session', 'cursor_send_prompt', 'cursor_session_status', 'cursor_set_mode', 'cursor_start_session', 'cursor_wait']);
    const evaluatedTurn = await runner.startTurn({ threadId: thread.thread.id, text: outer.scenario.initial_input, skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
    assert.equal(typeof evaluatedTurn.turn?.id, 'string');
    const evidence = await waitForProviderEvidence(providerEvidence, 5);
    assert.equal(evidence.provider_request_seen, true);
    assert.equal(evidence.requests, 5);
    const expectedToolSequence = ['cursor_delegate', 'cursor_wait', 'cursor_close_session', 'final'];
    assert.deepEqual(evidence.tool_sequence, ['warmup', ...expectedToolSequence], JSON.stringify(evidence));
    assert.deepEqual(evidence.request_trace, expectedToolSequence.map((tool, index) => ({
      step: index + 1, tool, call_id: tool === 'final' ? null : `call_${index + 2}`,
    })));
    assert.ok(evidence.declared_tool_types.includes('namespace'));
    assert.equal(evidence.terminal_result_matched, true);
    const terminalTurn = await waitForExactTurnTerminal(runner, thread.thread.id, evaluatedTurn.turn.id);
    assert.equal(terminalTurn.status, 'completed');
    const capturedFinals = [{ turn_index: 1,
      ...await runner.captureTurnFinal(thread.thread.id, evaluatedTurn.turn.id) }];
    assert.equal(capturedFinals[0].text, 'CURSOR_EVAL_OK');
    let mcp;
    try { mcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json')); }
    catch (error) {
      const diagnostics = Buffer.concat(runner.stderr).toString('utf8').slice(-4_000);
      throw new Error(`${error.message}; app-server diagnostics: ${diagnostics}`);
    }
    assert.deepEqual(mcp.transcript.map(({ tool }) => tool), ['cursor_delegate', 'cursor_wait', 'cursor_close_session']);
    const safeEvidence = await readSafeEvidence(safeEvidencePath);
    const outcomes = await observeFixtureOutcome(outer.scenario, outer.workspace, [capturedFinals[0].text], safeEvidence);
    const transcriptEvidence = { calls: mcp.transcript, dropped_calls: mcp.dropped_calls };
    const observations = observationsFromEvidence(outer.scenario, transcriptEvidence, safeEvidence,
      { actual_task_outcome: outcomes.actual_task_outcome });
    const oracle = evaluateScenario(outer.scenario, { ...observations, captured_finals: capturedFinals,
      transcript: transcriptEvidence });
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof, evaluator,
        model: { provider: 'fixture_ollama', name: 'qwen2.5-coder:7b' } },
      observations: { ...observations, reported_task_outcome: oracle.reported_task_outcome,
        assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      captured_finals: capturedFinals,
      transcript: transcriptEvidence,
      provider_oracle: { request_count: evidence.requests, skill_context_seen: installedSkillSelected,
        terminal_result_matched: evidence.terminal_result_matched, tool_sequence: evidence.tool_sequence.slice(1), request_trace: evidence.request_trace },
    };
    assert.equal(oracle.eval_status, 'pass', JSON.stringify(oracle));
  } catch (error) {
    const diagnostics = Buffer.concat(runner.stderr).toString('utf8').slice(-4_000);
    failure = diagnostics ? new Error(`${error.message}; app-server diagnostics: ${diagnostics}`, { cause: error }) : error;
  } finally {
    try { await assertEvaluatorUnchanged(evaluator); }
    catch (error) { failure ||= error; }
    const cleanup = await cleanupCredentialFreeRunner(runner, provider.child, failure);
    failure = cleanup.failure;
    await finalizeChildResult(fixture, childResult, failure, cleanup.cleanupFailed);
  }
  if (failure) throw failure;
});
