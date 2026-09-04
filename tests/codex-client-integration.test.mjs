import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runBootstrap, runPackageCommand } from '../scripts/cursor-subagent-bootstrap.mjs';
import { CodexAppServerClient } from '../scripts/codex-app-server-client.mjs';
import { classifyScenario, evalResult, publishEvidence } from '../scripts/cursor-skill-eval.mjs';

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
  await writeFile(path, `#!/usr/bin/env node\n${assignments}\nawait import("./fake-acp.mjs");\n`, 'utf8');
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

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-codex-client-')));
  const source = join(root, 'source'); const workspace = join(root, 'workspace'); const home = join(root, 'codex-home');
  await mkdir(source); await mkdir(workspace); await mkdir(home);
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(repository, path), join(source, path));
  }
  await cp(join(repository, 'skills'), join(source, 'skills'), { recursive: true });
  const fakeAgentRoot = join(root, 'fake-agent');
  await mkdir(fakeAgentRoot);
  await configureFakeAgent(join(fakeAgentRoot, 'agent'));
  await cp(fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url)), join(fakeAgentRoot, 'fake-acp.mjs'));
  const skillBytes = await readFile(join(source, 'skills/cursor-subagent/SKILL.md'));
  return { root, source, hidden: join(root, 'source.hidden'), workspace, home, managed: join(root, 'marketplace'), fakeAgent: join(fakeAgentRoot, 'agent'), skillSha256: sha256(skillBytes), skillBytes: skillBytes.length };
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

async function runCodex(args, env) {
  const child = spawn(codex, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = []; const stderr = []; let size = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { size += chunk.length; if (size <= 1_048_576) (stream === child.stdout ? stdout : stderr).push(chunk); });
  const result = await new Promise((resolveRun, rejectRun) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error('real Codex eval timed out')); }, 45_000);
    child.once('error', rejectRun);
    child.once('close', (code) => { clearTimeout(timer); resolveRun({ code, output: Buffer.concat(stdout).toString('utf8'), diagnostics: Buffer.concat(stderr).toString('utf8'), overflow: size > 1_048_576 }); });
  });
  if (result.overflow) throw new Error('real Codex eval output exceeded bound');
  if (result.code !== 0) throw new Error(`real Codex eval failed (${result.code}): ${result.diagnostics.slice(0, 2_000)}`);
  return result;
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

async function waitForMcpEvidenceOrTurnTerminal(runner, threadId, path, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      latest = value;
      if (value.transcript?.length >= 3) return { mcp: value, terminal: null };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const thread = await runner.request('thread/read', { threadId, includeTurns: true });
    const terminal = thread.thread?.turns?.find(({ status }) => status === 'completed' || status === 'failed' || status === 'interrupted');
    if (terminal) return { mcp: null, terminal: { status: terminal.status, durationMs: terminal.durationMs, error: terminal.error?.message || null, transcript: latest } };
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return { mcp: null, terminal: null, timeout: true, transcript: latest };
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

function assertCorrelatedPendingTranscript(transcript, answerTool, fixtureCallback) {
  assert.equal(transcript.length, 5);
  const [delegate, firstWait, answer, terminalWait, close] = transcript;
  assert.deepEqual(transcript.map(({ tool }) => tool), ['cursor_delegate', 'cursor_wait', answerTool, 'cursor_wait', 'cursor_close_session']);
  const sessionId = delegate.response?.session_id;
  const turnId = delegate.response?.turn_id;
  assert.equal(typeof sessionId, 'string');
  assert.equal(typeof turnId, 'string');
  assert.equal(firstWait.request?.session_id, sessionId);
  assert.equal(firstWait.request?.turn_id, turnId);
  assert.equal(firstWait.response?.session_id, sessionId);
  assert.equal(firstWait.response?.turn_id, turnId);
  const pending = firstWait.response?.active_turn?.pending?.[0];
  assert.equal(typeof pending?.request_id, 'string');
  assert.equal(answer.request?.session_id, sessionId);
  assert.equal(answer.request?.turn_id, turnId);
  assert.equal(answer.request?.request_id, pending.request_id);
  assert.equal(answer.response?.session_id, sessionId);
  assert.equal(answer.response?.turn_id, turnId);
  assert.equal(terminalWait.request?.session_id, sessionId);
  assert.equal(terminalWait.request?.turn_id, turnId);
  assert.equal(terminalWait.response?.session_id, sessionId);
  assert.equal(terminalWait.response?.turn_id, turnId);
  assert.equal(terminalWait.response?.turn_status, 'completed');
  assert.equal(close.request?.session_id, sessionId);
  assert.equal(close.response?.session_id, sessionId);
  assert.equal(close.response?.session_state, 'tombstone');
  assert.equal(fixtureCallback.request_id, pending.request_id);
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
    '--allowed-workspace-root', fixture.workspace], { env });
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
  const fixture = await layout(); t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'cursor-hosted-eval-published-')); t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const authFile = process.env.CURSOR_EVAL_AUTH_FILE || '/Users/arikon/.codex/auth.json';
  const node = await realpath(process.execPath);
  const selectedModelScenario = process.env.CURSOR_EVAL_MODEL_SCENARIO || '';
  await cp(authFile, join(fixture.home, 'auth.json'));
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]),
    CURSOR_EVAL_ADAPTER_TIMEOUT_MS: '60000',
    CURSOR_AGENT_COMMAND: node, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
    FAKE_ACP_EXPECT_CODEX_HOME: fixture.home, CURSOR_EVAL_WORKSPACE: fixture.workspace,
    FAKE_ACP_PENDING: process.env.CURSOR_EVAL_FAKE_ACP_PENDING || '',
    CURSOR_EVAL_MODEL_SCENARIO: selectedModelScenario,
    FAKE_ACP_RESULT: selectedModelScenario === 'semantic-failure' ? 'CURSOR_EVAL_DONE_NO_MARKER' : 'CURSOR_EVAL_OK', CURSOR_EVAL_MCP_EVIDENCE: join(evidenceRoot, 'mcp.json'),
    FAKE_ACP_SAFE_EVIDENCE: join(evidenceRoot, 'acp-safe.jsonl') };
  await configureFakeAgent(fixture.fakeAgent, {
    FAKE_ACP_PENDING: env.FAKE_ACP_PENDING,
    FAKE_ACP_RESULT: env.FAKE_ACP_RESULT,
    FAKE_ACP_SAFE_EVIDENCE: env.FAKE_ACP_SAFE_EVIDENCE,
  });
  const installed = await runBootstrap(['install', '--source-root', fixture.source,
    '--managed-marketplace-root', fixture.managed, '--node-executable', node,
    '--codex-executable', codex, '--agent-executable', fixture.fakeAgent,
    '--allowed-workspace-root', fixture.workspace], { env,
    runCommand: (command, args, options) => runPackageCommand(command, args, { ...options, timeoutMs: 70_000 }) });
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.envelope));
  await rename(fixture.source, fixture.hidden);
  const runner = new CodexAppServerClient(codex, ['app-server', '--stdio', '-c', 'features.apps=true'], env, {
    requestTimeoutMs: 120_000, onServerRequest: acceptOnlyCursorToolElicitation,
  });
  let hostedThreadId = null;
  try {
    await runner.initialize();
    const skillEvidence = await runner.skillLoadEvidence(fixture.workspace, skill);
    assert.equal(typeof skillEvidence.plugin_id, 'string');
    assert.equal(skillEvidence.content_sha256, fixture.skillSha256);
    assert.equal(skillEvidence.content_bytes, fixture.skillBytes);
    const thread = await runner.startThread({ cwd: fixture.workspace });
    hostedThreadId = thread.thread.id;
    const pendingScenario = env.FAKE_ACP_PENDING;
    const modelScenario = env.CURSOR_EVAL_MODEL_SCENARIO || pendingScenario;
    const permissionCovered = modelScenario === 'permission-covered';
    const permissionExpansion = modelScenario === 'permission-expansion';
    const semanticFailure = modelScenario === 'semantic-failure';
    const mode = pendingScenario === 'plan' ? 'plan' : pendingScenario === 'permission' ? 'agent' : 'ask';
    const markerPath = join(fixture.workspace, 'result.txt');
    const phaseOneText = pendingScenario
      ? permissionCovered
        ? `Создай через Cursor только ${markerPath} с точным содержимым CURSOR_EVAL_OK. Этим поручением я явно разрешаю одну такую запись.`
        : permissionExpansion
          ? `Делегируй Cursor только read-only проверку ${markerPath}. Запись изменений сейчас не разрешаю.`
          : pendingScenario === 'question'
            ? 'Делегируй Cursor проверку в режиме ask. Если Cursor задаст вопрос, покажи его мне.'
            : 'Запроси у Cursor план. Не одобряй его без моего решения.'
      : semanticFailure
        ? `Use the explicitly selected Cursor plugin now. Delegate an ask-mode task to create exactly ${join(fixture.workspace, 'result.txt')} with CURSOR_EVAL_OK. Wait until Cursor is terminal, independently inspect that exact marker file, then close the session. If the marker is absent or differs, reply exactly CURSOR_EVAL_FAILED; otherwise reply CURSOR_EVAL_OK.`
        : 'Use the explicitly selected Cursor plugin now. Do not answer in natural language before tools. You MUST call cursor_delegate in ask mode for a read-only check, cursor_wait with exactly the opaque IDs returned by delegate until terminal, then cursor_close_session. Only after close may you reply CURSOR_EVAL_OK.';
    if (pendingScenario) assert.doesNotMatch(phaseOneText, /cursor_(?:delegate|wait|answer|close)|session_id|turn_id|request_id|allow-once|reject-once/);
    await runner.startTurn({ threadId: thread.thread.id,
      text: phaseOneText,
      skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
    if (pendingScenario) {
      if (permissionCovered) {
        const completedMcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), 5, 90_000);
        const safeEvidence = (await readFile(join(evidenceRoot, 'acp-safe.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(safeEvidence, [{ callback: 'permission', request_id: 'p1', option_id: 'opaque-allow' }]);
        assertCorrelatedPendingTranscript(completedMcp.transcript, 'cursor_answer_permission', safeEvidence[0]);
        return;
      }
      const pendingMcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), 2, 90_000);
      assert.deepEqual(pendingMcp.transcript.map(({ tool }) => tool), ['cursor_delegate', 'cursor_wait']);
      const followUp = pendingScenario === 'question'
        ? 'Выбираю показанный вариант Yes.'
        : pendingScenario === 'plan'
          ? 'Явно одобряю показанный план.'
          : `Разрешаю только одну запись в ${markerPath} с содержимым CURSOR_EVAL_OK.`;
      assert.doesNotMatch(followUp, /cursor_(?:delegate|wait|answer|close)|session_id|turn_id|request_id|allow-once|reject-once/);
      await runner.startTurn({ threadId: thread.thread.id, text: followUp,
        skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
      const completedMcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), 5, 90_000);
      const answerTool = pendingScenario === 'question' ? 'cursor_answer_question' : pendingScenario === 'plan' ? 'cursor_answer_plan' : 'cursor_answer_permission';
      assert.deepEqual(completedMcp.transcript.map(({ tool }) => tool), ['cursor_delegate', 'cursor_wait', answerTool, 'cursor_wait', 'cursor_close_session']);
      const safeEvidence = (await readFile(join(evidenceRoot, 'acp-safe.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const expectedSafe = pendingScenario === 'question'
        ? { callback: 'question', request_id: 'q1', outcome: 'answered', selected_option_ids: ['yes'] }
        : pendingScenario === 'plan' ? { callback: 'plan', request_id: 'plan1', outcome: 'accepted' }
          : { callback: 'permission', request_id: 'p1', option_id: 'opaque-allow' };
      assert.deepEqual(safeEvidence, [expectedSafe]);
      assertCorrelatedPendingTranscript(completedMcp.transcript, answerTool, safeEvidence[0]);
      return;
    }
    const observed = await waitForMcpEvidenceOrTurnTerminal(runner, thread.thread.id, join(evidenceRoot, 'mcp.json'));
    let mcp = observed.mcp;
    if (!mcp) {
      const [statusResult, turnsResult] = await Promise.allSettled([
        runner.request('mcpServerStatus/list', { threadId: thread.thread.id, detail: 'toolsAndAuthOnly' }),
        runner.request('thread/read', { threadId: thread.thread.id, includeTurns: true }),
      ]);
      const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
      const turns = turnsResult.status === 'fulfilled' ? turnsResult.value : null;
      const turnId = turns?.thread?.turns?.[0]?.id ?? null;
      const itemsResult = turnId
        ? await runner.request('thread/items/list', { threadId: thread.thread.id, turnId, limit: 100, sortDirection: 'asc' }).then((value) => ({ value }), (error) => ({ error: error.message }))
        : { error: 'turn id unavailable' };
      const items = itemsResult.value ?? null;
      const publicStatus = status?.data?.filter(({ name }) => name === 'cursor-subagent').map(({ name, runtimeStatus, pluginId, tools }) => ({ name, runtimeStatus, pluginId, toolNames: Object.keys(tools || {}).sort() })) || [];
      const publicTurns = turns?.thread?.turns?.map(({ status: turnStatus, error: turnError, durationMs }) => ({ status: turnStatus, error: turnError?.message || null, durationMs })) || [];
      const publicItems = items?.data?.flatMap(({ item }) => item?.type === 'agentMessage' ? [{ type: item.type, text: item.text.slice(0, 1_000) }] : item?.type === 'mcpToolCall' ? [{ type: item.type, server: item.server, tool: item.tool, status: item.status }] : []).slice(-8) || [];
      throw new Error(`hosted MCP transcript missing; ${JSON.stringify({ terminal: observed.terminal || null, timeout: observed.timeout === true, publicStatus, publicTurns, publicItems, notificationMethods: [...new Set(runner.notifications.map(({ method }) => method))].sort().slice(0, 24), serverRequests: runner.serverRequests.map(({ method }) => method), diagnostics: [statusResult, turnsResult].filter(({ status: state }) => state === 'rejected').map(({ reason }) => reason.message), itemsDiagnostic: itemsResult.error ?? null })}`);
    }
    assert.deepEqual(mcp.transcript.map(({ tool }) => tool), ['cursor_delegate', 'cursor_wait', 'cursor_close_session']);
    if (semanticFailure) {
      const markerExists = await readFile(join(fixture.workspace, 'result.txt'), 'utf8').then(() => true, () => false);
      const turns = await runner.request('thread/read', { threadId: thread.thread.id, includeTurns: true });
      const turnId = turns.thread?.turns?.[0]?.id;
      const items = turnId ? await runner.request('thread/items/list', { threadId: thread.thread.id, turnId, limit: 100, sortDirection: 'asc' }) : { data: [] };
      const message = items.data?.flatMap(({ item }) => item?.type === 'agentMessage' ? [item.text] : []).join('\n') || '';
      const reported = message.includes('CURSOR_EVAL_FAILED') ? 'failed' : message.includes('CURSOR_EVAL_OK') ? 'succeeded' : 'not_reported';
      const actual = markerExists ? 'succeeded' : 'failed';
      const verdict = classifyScenario({ enabled: true, expectedActual: 'failed', actual, expectedReported: 'failed', reported });
      if (verdict !== 'pass') throw new Error(`semantic_failure actual=${actual} reported=${reported}`);
    }
  } finally {
    if (hostedThreadId) await runner.archiveThread(hostedThreadId).catch(() => {});
    await runner.close();
  }
});

test('credential-free client-happy completes the installed-skill MCP loop when provisioned', { skip: process.env.CURSOR_EVAL_REAL_CODEX === '1' ? false : 'requires provisioned loopback eval lane' }, async (t) => {
  const fixture = await layout(); t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'cursor-eval-published-')); t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const node = await realpath(process.execPath); const providerEvidence = join(fixture.root, 'provider-safe-evidence.json');
  const env = { ...process.env, CODEX_HOME: fixture.home, CODEX_SQLITE_HOME: fixture.home,
    CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT: fixture.home,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([node, adapter]),
    CURSOR_AGENT_COMMAND: node, CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]),
    FAKE_ACP_EXPECT_CODEX_HOME: fixture.home, CURSOR_EVAL_WORKSPACE: fixture.workspace,
    FAKE_ACP_RESULT: 'CURSOR_EVAL_OK', CURSOR_EVAL_SKILL_SENTINEL: 'Protocol completion не доказывает семантический успех задачи',
    CURSOR_EVAL_PROVIDER_EVIDENCE: providerEvidence, CURSOR_EVAL_MCP_EVIDENCE: join(evidenceRoot, 'mcp.json'),
    CURSOR_EVAL_WARMUP: '1', CURSOR_EVAL_DEFERRED_TOOL_SEARCH: '1', OLLAMA_HOST: 'http://127.0.0.1:11434' };
  const installed = await runBootstrap(['install', '--source-root', fixture.source,
    '--managed-marketplace-root', fixture.managed, '--node-executable', node,
    '--codex-executable', codex, '--agent-executable', fixture.fakeAgent,
    '--allowed-workspace-root', fixture.workspace], { env });
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.envelope));
  const mcpConfig = JSON.parse(await readFile(join(fixture.managed, 'plugins/codex-cursor-subagent-plugin/.mcp.json'), 'utf8'));
  assert.equal(mcpConfig.mcpServers['cursor-subagent'].args[0], join(fixture.managed, 'plugins/codex-cursor-subagent-plugin/scripts/recording-mcp-proxy.mjs'));
  assert.equal(mcpConfig.mcpServers['cursor-subagent'].env.CURSOR_EVAL_MCP_EVIDENCE, join(evidenceRoot, 'mcp.json'));
  await rename(fixture.source, fixture.hidden);
  const provider = await startProvider(env); t.after(() => stopProcess(provider.child));
  const runner = new CodexAppServerClient(codex, ['app-server', '--stdio', '-c', 'features.apps=true', '-c', 'model_provider="ollama"', '-c', 'oss_provider="ollama"', '-c', 'model="gpt-5.4-mini"'], env, { requestTimeoutMs: 15_000, onServerRequest: acceptOnlyCursorToolElicitation });
  try {
    await runner.initialize();
    const skillEvidence = await runner.skillLoadEvidence(fixture.workspace, skill);
    assert.equal(skillEvidence.enabled, true);
    assert.equal(typeof skillEvidence.plugin_id, 'string', 'installed skill must disclose its selected plugin identity');
    assert.ok(skillEvidence.path.startsWith(`${fixture.home}/plugins/cache/`));
    assert.equal(skillEvidence.content_sha256, fixture.skillSha256);
    assert.equal(skillEvidence.content_bytes, fixture.skillBytes);
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
    const evaluatedTurn = await runner.startTurn({ threadId: thread.thread.id, text: 'Делегируй Cursor read-only проверку и верни CURSOR_EVAL_OK.', skill: { name: skill, path: skillEvidence.path }, pluginName: skillEvidence.plugin_id });
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
    const evidenceRef = await publishEvidence({ evidenceRoot, fixtureRoot: fixture.root, evidence: { scenario_id: 'client-happy', skill_load: skillEvidence, provider: evidence, transcript: mcp.transcript } });
    const result = evalResult({ scenario_id: 'client-happy', lane: 'client-integration', eval_status: 'pass', actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded', fixture_assertion_outcome: 'pass', evidence_publication_status: 'published', evidence_ref: evidenceRef, cleanup_status: 'succeeded', failure_stage: null });
    assert.equal(JSON.parse(await readFile(evidenceRef, 'utf8')).provider.skill_context_seen, true);
    await runner.close();
    await rm(fixture.root, { recursive: true, force: true });
    await writeChildResult({
      scenario_id: process.env.CURSOR_EVAL_SCENARIO_ID || 'client-happy',
      eval_status: 'pass',
      skill: { sha256: skillEvidence.content_sha256, bytes: skillEvidence.content_bytes },
      transcript: mcp.transcript,
      provider_oracle: { request_count: evidence.requests, skill_context_seen: evidence.skill_context_seen,
        terminal_result_matched: evidence.terminal_result_matched, tool_sequence: evidence.tool_sequence.slice(1), request_trace: evidence.request_trace },
      fixture_oracle: { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded', assertion_outcome: 'pass' },
    });
    assert.equal(result.evidence_ref, evidenceRef);
    assert.equal(JSON.parse(await readFile(evidenceRef, 'utf8')).provider.skill_context_seen, true);
  } finally { await runner.close(); }
});
