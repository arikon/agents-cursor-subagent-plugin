import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
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

function observationsFromEvidence(scenario, transcript, safeEvidence, outcomes) {
  const pendingSteps = scenario.program.steps.filter(({ type }) => type === 'pending');
  const terminalStep = scenario.program.steps.find(({ type }) => type === 'terminal');
  const delegate = transcript.find(({ tool }) => tool === 'cursor_delegate');
  const sessionId = delegate?.response?.session_id;
  const turnId = delegate?.response?.turn_id;
  const pendingWaits = transcript.filter(({ tool, response }) => tool === 'cursor_wait' && response?.active_turn?.pending?.length);
  const trace = [];
  if (sessionId) trace.push({ kind: 'session.allocated', session_id: sessionId });
  if (turnId) trace.push({ kind: 'turn.started', turn_id: turnId });
  for (const [index, step] of pendingSteps.entries()) {
    const pending = pendingWaits[index]?.response?.active_turn?.pending?.[0];
    if (pending) trace.push({ kind: `pending.${step.request_kind}`, step_id: step.step_id, session_id: sessionId, turn_id: turnId, request_id: pending.request_id });
    const answerTool = `cursor_answer_${step.request_kind}`;
    const answer = transcript.find((entry) => entry.tool === answerTool && (!pending?.request_id || String(entry.request?.request_id) === String(pending.request_id)));
    if (answer) {
      trace.push({ kind: `answer.${step.request_kind}`, step_id: step.step_id, session_id: sessionId, turn_id: turnId, request_id: answer.request?.request_id,
        ...(step.request_kind === 'question' ? { option_ids: answer.request?.answers?.flatMap(({ selected_option_ids: ids }) => ids || []) || [] } : { decision: answer.request?.decision }) });
    }
    for (const effect of scenario.program.steps.filter(({ type }) => type === 'effect')) {
      if (safeEvidence.some(({ kind, step_id: stepId }) => kind === 'effect.file-written' && stepId === effect.step_id)) trace.push({ kind: 'effect.file-written', step_id: effect.step_id, session_id: sessionId, turn_id: turnId });
    }
  }
  if (pendingSteps.length === 0) {
    for (const effect of scenario.program.steps.filter(({ type }) => type === 'effect')) {
      if (safeEvidence.some(({ kind, step_id: stepId }) => kind === 'effect.file-written' && stepId === effect.step_id)) trace.push({ kind: 'effect.file-written', step_id: effect.step_id, session_id: sessionId, turn_id: turnId });
    }
  }
  if (transcript.some(({ tool, response }) => tool === 'cursor_wait' && response?.turn_status === 'completed')) trace.push({ kind: 'turn.completed', step_id: terminalStep.step_id, session_id: sessionId, turn_id: turnId });
  if (transcript.some(({ tool }) => tool === 'cursor_close_session')) trace.push({ kind: 'session.close-attempted', session_id: sessionId });
  const callbacks = safeEvidence.filter(({ kind }) => ['answer', 'decision', 'write-result'].includes(kind))
    .map(({ step_id, callback_id, kind, option_ids, decision, outcome }) => ({ step_id, callback_id, kind,
      ...(option_ids ? { option_ids } : {}), ...(decision ? { decision } : {}), ...(outcome ? { outcome } : {}) }));
  const effects = safeEvidence.filter(({ kind }) => kind === 'effect.file-written')
    .map(({ step_id, callback_id, kind }) => ({ step_id, callback_id, kind }));
  return { trace, callbacks, effects, ...outcomes };
}

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
  const authFile = process.env.CURSOR_EVAL_AUTH_FILE || '/Users/arikon/.codex/auth.json';
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
    const observations = observationsFromEvidence(outer.scenario, mcp.transcript, safeEvidence, outcomes);
    const oracle = evaluateScenario(outer.scenario, observations);
    assert.equal(oracle.eval_status, 'pass', JSON.stringify(oracle));
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof,
        model: { provider: null, name: null } },
      observations: { ...observations, assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      transcript: mcp.transcript,
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
  const programPath = await ensureProgramPath(fixture, outer.scenario);
  const node = await realpath(process.execPath); const providerEvidence = join(fixture.root, 'provider-safe-evidence.json');
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]),
    CURSOR_AGENT_COMMAND: node, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
    FAKE_ACP_EXPECT_CODEX_HOME: fixture.home, CURSOR_EVAL_WORKSPACE: outer.workspace,
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath, CURSOR_EVAL_SKILL_SENTINEL: 'Protocol completion не доказывает семантический успех задачи',
    CURSOR_EVAL_PROVIDER_EVIDENCE: providerEvidence, CURSOR_EVAL_MCP_EVIDENCE: join(evidenceRoot, 'mcp.json'),
    CURSOR_EVAL_WARMUP: '1', CURSOR_EVAL_DEFERRED_TOOL_SEARCH: '1', OLLAMA_HOST: 'http://127.0.0.1:11434' };
  await configureFakeAgent(fixture.fakeAgent, { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath });
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
  const runner = new CodexAppServerClient(codex, ['app-server', '--stdio', '-c', 'features.apps=true', '-c', 'model_provider="ollama"', '-c', 'oss_provider="ollama"', '-c', 'model="gpt-5.4-mini"'], env, { requestTimeoutMs: 15_000, onServerRequest: acceptOnlyCursorToolElicitation });
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
    const proof = await packageProof(fixture, node, env, skillEvidence);
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
    const evidence = await waitForProviderEvidence(providerEvidence, 8);
    assert.equal(evidence.provider_request_seen, true);
    assert.equal(evidence.requests, 8);
    const expectedToolSequence = ['tool_search', 'cursor_delegate', 'tool_search', 'cursor_wait', 'tool_search', 'cursor_close_session', 'final'];
    assert.deepEqual(evidence.tool_sequence, ['warmup', ...expectedToolSequence], JSON.stringify(evidence.request_trace));
    assert.deepEqual(evidence.request_trace, expectedToolSequence.map((tool, index) => ({
      step: index + 1, tool, call_id: tool === 'final' ? null : `call_${index + 2}`,
    })));
    assert.ok(evidence.declared_tool_types.includes('tool_search'));
    assert.equal(evidence.skill_context_seen, true);
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
    const observations = observationsFromEvidence(outer.scenario, mcp.transcript, [], outcomes);
    const oracle = evaluateScenario(outer.scenario, observations);
    assert.equal(oracle.eval_status, 'pass', JSON.stringify(oracle));
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof,
        model: { provider: 'ollama', name: 'gpt-5.4-mini' } },
      observations: { ...observations, assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      transcript: mcp.transcript,
      provider_oracle: { request_count: evidence.requests, skill_context_seen: evidence.skill_context_seen,
        terminal_result_matched: evidence.terminal_result_matched, tool_sequence: evidence.tool_sequence.slice(1), request_trace: evidence.request_trace },
    };
  } catch (error) {
    failure = error;
  } finally {
    await runner.close().catch((error) => { failure ||= error; });
    await stopProcess(provider.child).catch((error) => { failure ||= error; });
    await finalizeChildResult(fixture, childResult, failure);
  }
  if (failure) throw failure;
});
