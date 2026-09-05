import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER_NAME, runBootstrap, runPackageCommand } from '../scripts/cursor-subagent-bootstrap.mjs';
import { CodexAppServerClient } from '../scripts/codex-app-server-client.mjs';
import { canonicalJson, evaluateScenario, materializeScenario } from '../scripts/cursor-eval-scenario.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const codex = process.env.CURSOR_EVAL_CODEX_EXECUTABLE || '/Applications/ChatGPT.app/Contents/Resources/codex';
const adapter = fileURLToPath(new URL('./fixtures/codex-v01521-adapter.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/release-fake-acp.mjs', import.meta.url));
const fakeProvider = fileURLToPath(new URL('./fixtures/fake-ollama-responses.mjs', import.meta.url));
const skill = 'codex-cursor-subagent-plugin:cursor-subagent';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function configureFakeAgent(path, values = {}) {
  const assignments = Object.entries({ FAKE_ACP_RESULT: 'CURSOR_EVAL_OK', ...values })
    .map(([name, value]) => `process.env[${JSON.stringify(name)}] = ${JSON.stringify(value)};`)
    .join('\n');
  await writeFile(path, `#!/usr/bin/env node\n${assignments}\nif (process.argv[2] === "status") { process.stdout.write(JSON.stringify({ status: "authenticated", isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true })); process.exit(0); }\nawait import("./fake-acp.mjs");\n`, 'utf8');
  await chmod(path, 0o755);
}

function acceptOnlyCursorToolElicitation({ method, params }) {
  if (method !== 'mcpServer/elicitation/request'
    || params?.serverName !== 'cursor-subagent'
    || params?._meta?.codex_approval_kind !== 'mcp_tool_call') {
    throw new Error(`unexpected app-server request: ${method}`);
  }
  return { action: 'accept' };
}

async function layout(workspaceOverride = null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-codex-client-')));
  const source = join(root, 'source'); const workspace = workspaceOverride || join(root, 'workspace'); const home = join(root, 'codex-home');
  await mkdir(source); if (!workspaceOverride) await mkdir(workspace); await mkdir(home);
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(repository, path), join(source, path));
  }
  await cp(join(repository, 'skills'), join(source, 'skills'), { recursive: true });
  const fakeAgentRoot = join(root, 'fake-agent');
  await mkdir(fakeAgentRoot);
  await configureFakeAgent(join(fakeAgentRoot, 'agent'));
  await cp(fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url)), join(fakeAgentRoot, 'fake-acp.mjs'));
  const skillBytes = await readFile(join(source, 'skills/cursor-subagent/SKILL.md'));
  return { root, source, hidden: join(root, 'source.hidden'), workspace, allowedWorkspace: await realpath(workspace), home,
    managed: join(root, 'marketplace'), fakeAgent: join(fakeAgentRoot, 'agent'), skillSha256: sha256(skillBytes), skillBytes: skillBytes.length };
}

function digestFromEnvironment(prefix) {
  const digest = { sha256: process.env[`${prefix}_SHA256`], bytes: Number(process.env[`${prefix}_BYTES`]) };
  assert.match(digest.sha256 || '', /^[a-f0-9]{64}$/, `${prefix} sha256 is missing or invalid`);
  assert.ok(Number.isSafeInteger(digest.bytes) && digest.bytes > 0 && digest.bytes <= 1_048_576, `${prefix} bytes is missing or invalid`);
  return digest;
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
  const rematerialized = materializeScenario(scenario, { workspace });
  assert.equal(rematerialized.canonicalPayload, payload, 'child received a non-canonical scenario payload');
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

async function packageProof(fixture, node, env, skillEvidence) {
  const preflight = await runBootstrap(['preflight', '--managed-marketplace-root', fixture.managed,
    '--node-executable', node, '--codex-executable', codex, '--agent-executable', fixture.fakeAgent], { env,
    runCommand: (command, args, options) => runPackageCommand(command, args, { ...options, timeoutMs: 70_000 }) });
  assert.equal(preflight.exitCode, 0, JSON.stringify(preflight.envelope));
  const marker = JSON.parse(await readFile(join(fixture.managed, MARKER_NAME), 'utf8'));
  const managedBytes = await readFile(join(fixture.managed, 'plugins/codex-cursor-subagent-plugin/skills/cursor-subagent/SKILL.md'));
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

export function observationsFromEvidence(_scenario, transcriptEvidence, safeEvidence, outcomes) {
  const calls = transcriptEvidence.calls;
  const callbackEvidence = safeEvidence.filter(({ kind }) => ['answer', 'decision', 'write-result', 'callback.failure'].includes(kind));
  const callbackById = new Map(callbackEvidence.map((entry) => [String(entry.callback_id), entry]));
  const terminalEvidence = safeEvidence.findLast(({ event, step_id: stepId }) => event === 'prompt_result' && typeof stepId === 'string');
  const trace = [];
  let sessionId;
  let turnId;
  let emittedEffects = false;
  for (const call of calls) {
    const traceLengthBeforeCall = trace.length;
    const callOutcome = !call.response ? 'not_observed' : call.response.ok ? 'succeeded' : 'failed';
    const ids = { session_id: call.request?.session_id || call.response?.session_id || sessionId,
      turn_id: call.request?.turn_id || call.response?.turn_id || turnId };
    if (call.tool === 'cursor_delegate' && callOutcome === 'succeeded') {
      sessionId = call.response?.session_id;
      turnId = call.response?.turn_id;
      if (sessionId) trace.push({ kind: 'session.allocated', session_id: sessionId, call_outcome: callOutcome });
      if (turnId) trace.push({ kind: 'turn.started', session_id: sessionId, turn_id: turnId, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_wait') {
      for (const pending of call.response?.active_turn?.pending || []) {
        const observedCallback = callbackById.get(String(pending.request_id));
        trace.push({ kind: `pending.${pending.kind}`, step_id: observedCallback?.step_id || `unobserved:${pending.request_id}`,
          ...ids, request_id: pending.request_id, call_outcome: callOutcome });
      }
      const terminal = call.response?.turn_status === 'completed' || call.response?.last_terminal_turn?.turn_status === 'completed';
      if (terminal) trace.push({ kind: 'turn.completed', step_id: terminalEvidence?.step_id || 'unobserved:terminal',
        ...ids, call_outcome: callOutcome });
    } else if (call.tool?.startsWith('cursor_answer_')) {
      const requestId = call.request?.request_id;
      const observedCallback = callbackById.get(String(requestId)) || callbackEvidence.find(({ kind }) => kind === 'callback.failure');
      const requestKind = call.tool.slice('cursor_answer_'.length);
      trace.push({ kind: `answer.${requestKind}`, step_id: observedCallback?.step_id || `unobserved:${requestId}`,
        ...ids, request_id: requestId, call_outcome: callOutcome,
        ...(requestKind === 'question' ? { option_ids: call.request?.answers?.flatMap(({ selected_option_ids: optionIds }) => optionIds || []) || [] }
          : { decision: call.request?.decision }) });
      if (!emittedEffects) {
        for (const effect of safeEvidence.filter(({ kind }) => kind === 'effect.file-written')) {
          trace.push({ kind: 'effect.file-written', step_id: effect.step_id, ...ids, call_outcome: 'succeeded' });
        }
        emittedEffects = true;
      }
    } else if (call.tool === 'cursor_close_session') {
      trace.push({ kind: 'session.close-attempted', ...ids, call_outcome: callOutcome });
    } else {
      trace.push({ kind: 'unexpected-operation', ...ids, call_outcome: callOutcome });
    }
    if (trace.length === traceLengthBeforeCall) trace.push({ kind: 'call.observed', ...ids, call_outcome: callOutcome });
    if (callOutcome !== 'succeeded') trace.push({ kind: 'call.failed', ...ids, call_outcome: callOutcome });
  }
  if (transcriptEvidence.dropped_calls > 0) trace.push({ kind: 'dropped-calls', session_id: sessionId, turn_id: turnId,
    dropped_calls: transcriptEvidence.dropped_calls, call_outcome: 'not_observed' });
  const callbacks = callbackEvidence
    .map(({ step_id, callback_id, kind, option_ids, decision, outcome }) => ({ step_id, callback_id, kind,
      ...(option_ids ? { option_ids } : {}), ...(decision ? { decision } : {}), ...(outcome ? { outcome } : {}) }));
  const effects = safeEvidence.filter(({ kind }) => kind === 'effect.file-written')
    .map(({ step_id, callback_id, kind }) => ({ step_id, callback_id, kind }));
  return { trace, callbacks, effects, ...outcomes };
}

export async function resolveHostedAuthFile(env = process.env, dependencies = {}) {
  const candidate = env.CURSOR_EVAL_AUTH_FILE || join((dependencies.homedir || homedir)(), '.codex', 'auth.json');
  try { await (dependencies.access || access)(candidate); }
  catch { throw new Error('hosted Codex credentials are unavailable; set CURSOR_EVAL_AUTH_FILE or authenticate Codex in the current home directory'); }
  return candidate;
}

export function fixtureProviderAppServerArgs(endpoint) {
  const provider = 'fixture_ollama';
  const baseUrl = `${endpoint.replace(/\/$/, '')}/v1`;
  return ['app-server', '--stdio', '-c', 'features.apps=true', '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', 'model="qwen2.5-coder:7b"', '-c', `model_providers.${provider}.name="Fixture Ollama"`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
    '-c', `model_providers.${provider}.wire_api="responses"`];
}

test('observed MCP transcript drives oracle order, IDs, call outcomes and dropped-call evidence', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [
      { type: 'pending', request_kind: 'question', step_id: 'question-1', callback_id: 'request-1', expected_callback: { kind: 'answer', option_ids: ['yes'] } },
      { type: 'terminal', step_id: 'terminal-1' },
    ] },
    expected_trace: [
      { kind: 'session.allocated' }, { kind: 'turn.started' }, { kind: 'pending.question', step_id: 'question-1' },
      { kind: 'answer.question', step_id: 'question-1', option_ids: ['yes'] }, { kind: 'turn.completed', step_id: 'terminal-1' },
      { kind: 'session.close-attempted' },
    ],
    forbidden_observations: ['answer-before-pending', 'id-mismatch', 'operation-after-close', 'unexpected-effect', 'raw-provider-payload'],
    expected_actual_task_outcome: 'succeeded', expected_reported_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  let callId = 0;
  const call = (tool, request, response) => ({ direction: 'request', tool, call_id: ++callId, request, response });
  const delegate = call('cursor_delegate', { mode: 'ask' }, { ok: true, session_id: 'session-1', turn_id: 'turn-1' });
  const pending = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, active_turn: { pending: [{ request_id: 'request-1', kind: 'question' }] } });
  const answer = call('cursor_answer_question', { session_id: 'session-1', turn_id: 'turn-1', request_id: 'request-1', answers: [{ selected_option_ids: ['yes'] }] }, { ok: true });
  const terminal = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, turn_status: 'completed' });
  const close = call('cursor_close_session', { session_id: 'session-1' }, { ok: true });
  const safe = [{ kind: 'answer', step_id: 'question-1', callback_id: 'request-1', option_ids: ['yes'] }, { event: 'prompt_result', step_id: 'terminal-1' }];
  const outcomes = { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded' };
  const observe = (calls, safeEvidence = safe, droppedCalls = 0) => observationsFromEvidence({}, { calls, dropped_calls: droppedCalls }, safeEvidence, outcomes);
  assert.equal(evaluateScenario(scenario, observe([delegate, pending, answer, terminal, close])).eval_status, 'pass');

  const answerBeforePending = evaluateScenario(scenario, observe([delegate, answer, pending, terminal, close]));
  assert.ok(answerBeforePending.mismatches.includes('answer-before-pending'));
  const wrongIdAnswer = structuredClone(answer); wrongIdAnswer.request.request_id = 'wrong-request';
  const wrongId = evaluateScenario(scenario, observe([delegate, pending, wrongIdAnswer, terminal, close,
  ], [{ kind: 'callback.failure', step_id: 'question-1', callback_id: 'request-1', reason: 'id-mismatch' }, ...safe.slice(1)]));
  assert.ok(wrongId.mismatches.includes('id-mismatch'));
  const failedAnswer = structuredClone(answer); failedAnswer.response.ok = false;
  assert.ok(evaluateScenario(scenario, observe([delegate, pending, failedAnswer, terminal, close])).mismatches.includes('trace-mismatch'));
  assert.ok(evaluateScenario(scenario, observe([delegate, pending, answer, terminal, close,
    call('cursor_session_status', { session_id: 'session-1' }, { ok: true })])).mismatches.includes('operation-after-close'));
  const overflow = observe([delegate, pending, answer, terminal, close], safe, 3);
  assert.equal(overflow.trace.at(-1).dropped_calls, 3);
  assert.equal(evaluateScenario(scenario, overflow).eval_status, 'agent_behavior_mismatch');
});

test('scripted providers use distinct OS-assigned endpoints in parallel', async (t) => {
  const providers = await Promise.all([startProvider({ ...process.env, CURSOR_EVAL_PROVIDER_PORT: '0' }), startProvider({ ...process.env, CURSOR_EVAL_PROVIDER_PORT: '0' })]);
  t.after(async () => Promise.all(providers.map(({ child }) => stopProcess(child))));
  assert.notEqual(providers[0].endpoint, providers[1].endpoint);
});

test('credential-free app-server adapter pins the custom provider to the observed fixture endpoint', () => {
  assert.deepEqual(fixtureProviderAppServerArgs('http://127.0.0.1:43123/'), [
    'app-server', '--stdio', '-c', 'features.apps=true', '-c', 'model_provider="fixture_ollama"',
    '-c', 'model="qwen2.5-coder:7b"', '-c', 'model_providers.fixture_ollama.name="Fixture Ollama"',
    '-c', 'model_providers.fixture_ollama.base_url="http://127.0.0.1:43123/v1"',
    '-c', 'model_providers.fixture_ollama.wire_api="responses"',
  ]);
});

test('hosted credential resolution supports explicit and portable paths with a clear missing preflight', async () => {
  const seen = [];
  const accessFile = async (path) => { seen.push(path); };
  assert.equal(await resolveHostedAuthFile({ CURSOR_EVAL_AUTH_FILE: '/fixture/auth.json' }, { access: accessFile, homedir: () => '/portable/home' }), '/fixture/auth.json');
  assert.equal(await resolveHostedAuthFile({}, { access: accessFile, homedir: () => '/portable/home' }), '/portable/home/.codex/auth.json');
  await assert.rejects(resolveHostedAuthFile({}, { access: async () => { throw new Error('missing'); }, homedir: () => '/portable/home' }),
    (error) => /set CURSOR_EVAL_AUTH_FILE/.test(error.message) && !error.message.includes('/portable/home'));
  assert.deepEqual(seen, ['/fixture/auth.json', '/portable/home/.codex/auth.json']);
});

async function observeFixtureOutcome(scenario, workspace, reportedText = '') {
  const predicate = scenario.fixture_predicate;
  let actual;
  if (predicate.kind === 'file-text') actual = await readFile(join(workspace, ...predicate.path.split('/')), 'utf8').then((text) => text === predicate.text ? 'succeeded' : 'failed', () => 'failed');
  else if (predicate.kind === 'file-absent') actual = await readFile(join(workspace, ...predicate.path.split('/'))).then(() => 'failed', (error) => error.code === 'ENOENT' ? 'succeeded' : Promise.reject(error));
  else if (predicate.kind === 'terminal-token') actual = reportedText.includes(predicate.token) ? 'succeeded' : 'failed';
  else actual = 'succeeded';
  const reported = scenario.scenario_id === 'model-semantic-failure'
    ? reportedText.includes('CURSOR_EVAL_FAILED') ? 'failed' : reportedText.includes('CURSOR_EVAL_OK') ? 'succeeded' : 'not_reported'
    : reportedText ? 'succeeded' : actual;
  return { actual_task_outcome: actual, reported_task_outcome: reported };
}

async function reportedTextForThread(runner, threadId) {
  const thread = await runner.request('thread/read', { threadId, includeTurns: true });
  const messages = [];
  for (const turn of thread.thread?.turns || []) {
    const items = await runner.request('thread/items/list', { threadId, turnId: turn.id, limit: 100, sortDirection: 'asc' });
    messages.push(...(items.data?.flatMap(({ item }) => item?.type === 'agentMessage' ? [item.text] : []) || []));
  }
  return messages.join('\n');
}

async function finalizeChildResult(fixture, result, error = null) {
  let cleanupStatus = 'succeeded';
  try { await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { cleanupStatus = 'failed'; }
  const value = result
    ? { ...result, provenance: { ...result.provenance, cleanup_status: cleanupStatus } }
    : { schema_version: 1, scenario_id: process.env.CURSOR_EVAL_SCENARIO_ID, error_code: 'child_failure', message: String(error?.message || 'child failed').slice(0, 8_000), cleanup_status: cleanupStatus };
  await writeChildResult(value);
  if (cleanupStatus === 'failed' && !error) throw new Error('integration child cleanup failed');
}

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
    await closed;
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

async function waitForExactTurnTerminal(runner, threadId, turnId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const thread = await runner.request('thread/read', { threadId, includeTurns: true });
    latest = thread.thread?.turns?.find(({ id }) => id === turnId) ?? null;
    if (latest && ['completed', 'failed', 'interrupted'].includes(latest.status)) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`evaluated turn did not become terminal: ${JSON.stringify({ turn_id: turnId, status: latest?.status ?? null })}`);
}

async function writeChildResult(result) {
  const destination = process.env.CURSOR_EVAL_CHILD_RESULT;
  if (!destination) return;
  const value = { schema_version: 1, ...result };
  const serialized = JSON.stringify(value);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 1_048_576, 'child result exceeded 1 MiB');
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(temporary, serialized, 'utf8');
  await rename(temporary, destination);
}

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
  const outer = await readOuterScenario();
  const fixture = await layout(outer.workspace);
  t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const evidenceRoot = join(fixture.root, 'evidence');
  await mkdir(evidenceRoot);
  const safeEvidencePath = join(evidenceRoot, 'acp-safe.jsonl');
  const programPath = await ensureProgramPath(fixture, outer.scenario);
  const authFile = await resolveHostedAuthFile();
  const node = await realpath(process.execPath);
  await cp(authFile, join(fixture.home, 'auth.json'));
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]),
    CURSOR_EVAL_ADAPTER_TIMEOUT_MS: '60000',
    CURSOR_AGENT_COMMAND: node, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
    FAKE_ACP_EXPECT_CODEX_HOME: fixture.home, CURSOR_EVAL_WORKSPACE: outer.workspace,
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, CURSOR_EVAL_MCP_EVIDENCE: join(evidenceRoot, 'mcp.json'),
    FAKE_ACP_SAFE_EVIDENCE: safeEvidencePath };
  await configureFakeAgent(fixture.fakeAgent, {
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    FAKE_ACP_SAFE_EVIDENCE: env.FAKE_ACP_SAFE_EVIDENCE,
  });
  const installed = await runBootstrap(['install', '--source-root', fixture.source,
    '--managed-marketplace-root', fixture.managed, '--node-executable', node,
    '--codex-executable', codex, '--agent-executable', fixture.fakeAgent,
    '--allowed-workspace-root', fixture.allowedWorkspace], { env,
    runCommand: (command, args, options) => runPackageCommand(command, args, { ...options, timeoutMs: 70_000 }) });
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.envelope));
  await rename(fixture.source, fixture.hidden);
  const runner = new CodexAppServerClient(codex, ['app-server', '--stdio', '-c', 'features.apps=true'], env, {
    requestTimeoutMs: 120_000, onServerRequest: acceptOnlyCursorToolElicitation,
  });
  let hostedThreadId = null;
  let childResult = null;
  let failure = null;
  try {
    await runner.initialize();
    const skillEvidence = await runner.skillLoadEvidence(fixture.workspace, skill);
    assert.equal(typeof skillEvidence.plugin_id, 'string');
    assert.equal(skillEvidence.content_sha256, fixture.skillSha256);
    assert.equal(skillEvidence.content_bytes, fixture.skillBytes);
    const proof = await packageProof(fixture, node, env, skillEvidence);
    const thread = await runner.startThread({ cwd: fixture.workspace });
    hostedThreadId = thread.thread.id;
    await runner.startTurn({ threadId: thread.thread.id,
      text: outer.scenario.initial_input,
      skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
    for (const followup of outer.scenario.followups) {
      await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), 2, 90_000);
      await runner.startTurn({ threadId: thread.thread.id, text: followup.input,
        skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
    }
    const expectedCalls = outer.scenario.program.steps.some(({ type }) => type === 'pending') ? 5 : 3;
    const mcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), expectedCalls, 90_000);
    const safeEvidence = await readSafeEvidence(safeEvidencePath);
    const reportedText = await reportedTextForThread(runner, thread.thread.id);
    const outcomes = await observeFixtureOutcome(outer.scenario, outer.workspace, reportedText);
    const transcriptEvidence = { calls: mcp.transcript, dropped_calls: mcp.dropped_calls };
    const observations = observationsFromEvidence(outer.scenario, transcriptEvidence, safeEvidence, outcomes);
    const oracle = evaluateScenario(outer.scenario, observations);
    assert.equal(oracle.eval_status, 'pass', JSON.stringify(oracle));
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof,
        model: { provider: null, name: null } },
      observations: { ...observations, assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      transcript: transcriptEvidence,
      provider_oracle: { request_count: mcp.transcript.length, skill_context_seen: true, terminal_result_matched: oracle.assertion_outcome === 'pass',
        tool_sequence: mcp.transcript.map(({ tool }) => tool), request_trace: mcp.transcript.map(({ tool, call_id: callId }, index) => ({ step: index + 1, tool, call_id: callId })) },
    };
  } catch (error) {
    failure = error;
  } finally {
    if (hostedThreadId) await runner.archiveThread(hostedThreadId).catch(() => {});
    await runner.close().catch((error) => { failure ||= error; });
    await finalizeChildResult(fixture, childResult, failure);
  }
  if (failure) throw failure;
});

test('credential-free client-happy completes the installed-skill MCP loop when provisioned', { skip: process.env.CURSOR_EVAL_REAL_CODEX === '1' ? false : 'requires provisioned loopback eval lane' }, async (t) => {
  const outer = await readOuterScenario();
  assert.equal(outer.scenario.scenario_id, 'client-happy');
  const fixture = await layout(outer.workspace);
  t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const evidenceRoot = join(fixture.root, 'evidence');
  await mkdir(evidenceRoot);
  const programPath = await ensureProgramPath(fixture, outer.scenario);
  const node = await realpath(process.execPath); const providerEvidence = join(fixture.root, 'provider-safe-evidence.json');
  const safeEvidencePath = join(evidenceRoot, 'acp-safe.jsonl');
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]),
    CURSOR_AGENT_COMMAND: node, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
    FAKE_ACP_EXPECT_CODEX_HOME: fixture.home, CURSOR_EVAL_WORKSPACE: outer.workspace,
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, CURSOR_EVAL_SKILL_SENTINEL: 'Protocol completion не доказывает семантический успех задачи',
    CURSOR_EVAL_PROVIDER_EVIDENCE: providerEvidence, CURSOR_EVAL_MCP_EVIDENCE: join(evidenceRoot, 'mcp.json'),
    FAKE_ACP_SAFE_EVIDENCE: safeEvidencePath,
    CURSOR_EVAL_WARMUP: '1', CURSOR_EVAL_DEFERRED_TOOL_SEARCH: '0', CURSOR_EVAL_PROVIDER_PORT: '0' };
  await configureFakeAgent(fixture.fakeAgent, { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, FAKE_ACP_SAFE_EVIDENCE: safeEvidencePath });
  const installed = await runBootstrap(['install', '--source-root', fixture.source,
    '--managed-marketplace-root', fixture.managed, '--node-executable', node,
    '--codex-executable', codex, '--agent-executable', fixture.fakeAgent,
    '--allowed-workspace-root', fixture.allowedWorkspace], { env });
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.envelope));
  const mcpConfig = JSON.parse(await readFile(join(fixture.managed, 'plugins/codex-cursor-subagent-plugin/.mcp.json'), 'utf8'));
  assert.equal(mcpConfig.mcpServers['cursor-subagent'].args[0], join(fixture.managed, 'plugins/codex-cursor-subagent-plugin/scripts/recording-mcp-proxy.mjs'));
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
    const proof = await packageProof(fixture, node, clientEnv, skillEvidence);
    const cachedMcpConfig = JSON.parse(await readFile(join(skillEvidence.path, '..', '..', '..', '.mcp.json'), 'utf8'));
    assert.equal(cachedMcpConfig.mcpServers['cursor-subagent'].args[0], join(fixture.managed, 'plugins/codex-cursor-subagent-plugin/scripts/recording-mcp-proxy.mjs'));
    const thread = await runner.startThread({ cwd: fixture.workspace });
    await runner.startTurn({ threadId: thread.thread.id, text: 'Warm up the explicitly selected plugin MCP and return no tools.', skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
    await waitForProviderEvidence(providerEvidence, 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const mcpStatus = await runner.request('mcpServerStatus/list', { threadId: thread.thread.id, detail: 'full' });
    const selectedServer = mcpStatus.data?.find(({ name }) => name === 'cursor-subagent');
    assert.equal(selectedServer?.pluginId, skillEvidence.plugin_id);
    assert.equal(selectedServer?.runtimeStatus, 'connected');
    assert.deepEqual(Object.keys(selectedServer?.tools || {}).sort(), ['cursor_answer_permission', 'cursor_answer_plan', 'cursor_answer_question', 'cursor_cancel', 'cursor_close_session', 'cursor_delegate', 'cursor_send_prompt', 'cursor_session_status', 'cursor_start_session', 'cursor_wait']);
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
    const evaluatedItems = await runner.request('thread/items/list', {
      threadId: thread.thread.id, turnId: evaluatedTurn.turn.id, limit: 100, sortDirection: 'asc',
    });
    const reportedMessages = evaluatedItems.data?.flatMap(({ item }) => item?.type === 'agentMessage' ? [item.text] : []) ?? [];
    assert.deepEqual(reportedMessages, ['CURSOR_EVAL_OK']);
    let mcp;
    try { mcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json')); }
    catch (error) {
      const diagnostics = Buffer.concat(runner.stderr).toString('utf8').slice(-4_000);
      throw new Error(`${error.message}; app-server diagnostics: ${diagnostics}`);
    }
    assert.deepEqual(mcp.transcript.map(({ tool }) => tool), ['cursor_delegate', 'cursor_wait', 'cursor_close_session']);
    const reportedText = reportedMessages.join('\n');
    const outcomes = await observeFixtureOutcome(outer.scenario, outer.workspace, reportedText);
    const safeEvidence = await readSafeEvidence(safeEvidencePath);
    const transcriptEvidence = { calls: mcp.transcript, dropped_calls: mcp.dropped_calls };
    const observations = observationsFromEvidence(outer.scenario, transcriptEvidence, safeEvidence, outcomes);
    const oracle = evaluateScenario(outer.scenario, observations);
    assert.equal(oracle.eval_status, 'pass', JSON.stringify(oracle));
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof,
        model: { provider: 'fixture_ollama', name: 'qwen2.5-coder:7b' } },
      observations: { ...observations, assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      transcript: transcriptEvidence,
      provider_oracle: { request_count: evidence.requests, skill_context_seen: evidence.skill_context_seen,
        terminal_result_matched: evidence.terminal_result_matched, tool_sequence: evidence.tool_sequence.slice(1), request_trace: evidence.request_trace },
    };
  } catch (error) {
    const diagnostics = Buffer.concat(runner.stderr).toString('utf8').slice(-4_000);
    failure = diagnostics ? new Error(`${error.message}; app-server diagnostics: ${diagnostics}`, { cause: error }) : error;
  } finally {
    await runner.close().catch((error) => { failure ||= error; });
    await stopProcess(provider.child).catch((error) => { failure ||= error; });
    await finalizeChildResult(fixture, childResult, failure);
  }
  if (failure) throw failure;
});
