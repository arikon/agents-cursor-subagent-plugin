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
const skill = 'codex-cursor-subagent-plugin:cursor-subagent';
const HOSTED_APP_SERVER_OUTPUT_LIMIT = 16 * 1_048_576;
const HOSTED_OBSERVATION_TIMEOUT_MS = 300_000;
const HOSTED_FAILURE_SOURCE_LIMIT = 1_048_576;
const HOSTED_FAILURE_EVENT_LIMIT = 20;
const THREAD_STATUS_TYPES = new Set(['notLoaded', 'idle', 'systemError', 'active']);
const THREAD_ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function configureFakeAgent(path, values = {}) {
  const assignments = Object.entries({ FAKE_ACP_RESULT: 'CURSOR_EVAL_OK', ...values })
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
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
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

export function observationsFromEvidence(scenario, transcriptEvidence, safeEvidence, outcomes) {
  const calls = transcriptEvidence.calls;
  const recoveredProjectionIndices = new Set(findRecoveredCalls(
    transcriptEvidence, (scenario.followups?.length || 0) + 1,
  ).flatMap(({ failed_call_index: start, successful_call_index: end }) =>
    Array.from({ length: end - start }, (_value, index) => start + index)));
  const callbackEvidence = safeEvidence.filter(({ kind }) => ['answer', 'decision', 'read-result', 'write-result', 'burst.ack', 'callback.failure'].includes(kind));
  const callbackById = new Map(callbackEvidence.map((entry) => [String(entry.callback_id), entry]));
  const terminalEvidence = safeEvidence.map((entry, index) => ({ entry, index }))
    .filter(({ entry: { event, step_id: stepId } }) => event === 'prompt_result' && typeof stepId === 'string');
  const armedTerminalEvidence = safeEvidence.map((entry, index) => ({ entry, index }))
    .filter(({ entry: { event, step_id: stepId } }) => event === 'terminal_armed' && typeof stepId === 'string');
  const promptContractEvidence = safeEvidence.map((entry, index) => ({ entry, index }))
    .filter(({ entry: { kind, step_id: stepId } }) => kind === 'prompt.contract' && typeof stepId === 'string');
  const progressEvidence = safeEvidence.filter(({ kind, step_id: stepId }) => kind?.startsWith('progress.') && typeof stepId === 'string');
  const activeFollowupEvidence = safeEvidence.find(({ event, step_id: stepId }) => event === 'followup_received_active' && typeof stepId === 'string');
  let terminalIndex = 0;
  let terminalProgramIndex = 0;
  const trace = [];
  let sessionId;
  let turnId;
  let cursorSessionId;
  let expectedProgressRevision = 0;
  let sawWaitTimeout = false;
  let activeFollowupObserved = false;
  let previousTerminalEvidenceIndex = -1;
  const completedTurnIds = new Set();
  const completeResultReadTurns = new Set();
  const fullResultDigestByTurn = new Map();
  const codexTurnIndexForCall = (callIndex) => {
    const rangeIndex = transcriptEvidence.turn_call_ranges?.findIndex(({ start, end }) => callIndex >= start && callIndex < end) ?? -1;
    return rangeIndex < 0 ? 1 : rangeIndex + 1;
  };
  const codexTurnIndexForSafeEvidence = (evidenceIndex, fallback) => {
    const starts = transcriptEvidence.turn_safe_evidence_starts;
    if (!Array.isArray(starts) || starts.length === 0) return fallback;
    let index = 0;
    for (let candidate = 1; candidate < starts.length; candidate += 1) {
      if (!Number.isSafeInteger(starts[candidate]) || starts[candidate] > evidenceIndex) break;
      index = candidate;
    }
    return index + 1;
  };
  const promptContractForTurn = (codexTurnIndex) => promptContractEvidence
    .find(({ index }) => codexTurnIndexForSafeEvidence(index, codexTurnIndex) === codexTurnIndex)?.entry;
  for (const [callIndex, call] of calls.entries()) {
    if (recoveredProjectionIndices.has(callIndex + 1)) {
      continue;
    }
    const codexTurnIndex = codexTurnIndexForCall(callIndex);
    const traceLengthBeforeCall = trace.length;
    let expectedFailure = false;
    const callOutcome = !call.response ? 'not_observed' : call.response.ok ? 'succeeded' : 'failed';
    const ids = { session_id: call.request?.session_id || call.response?.session_id || sessionId,
      turn_id: call.request?.turn_id || call.response?.turn_id || turnId };
    if (call.tool === 'cursor_delegate' && callOutcome === 'failed'
      && ['invalid_args', 'scope_rejected'].includes(call.response?.error_code)) {
      expectedFailure = true;
      trace.push({ kind: 'session.start-rejected', error_code: call.response.error_code, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_delegate' && callOutcome === 'succeeded') {
      sessionId = call.response?.session_id;
      turnId = call.response?.turn_id;
      cursorSessionId = call.response?.cursor_session_id;
      if (sessionId) trace.push({ kind: 'session.allocated', session_id: sessionId,
        ...(call.request?.mode !== undefined ? { mode: call.request.mode } : {}),
        ...(call.request?.model !== undefined ? { model: call.request.model } : {}),
        ...(call.request?.effort !== undefined ? { effort: call.request.effort } : {}),
        ...(call.request?.fast !== undefined ? { fast: call.request.fast } : {}),
        ...(call.request?.plugin_dirs_count !== undefined ? { plugin_dirs_count: call.request.plugin_dirs_count } : {}),
        ...(call.request?.plugin_dirs_matched !== undefined ? { plugin_dirs_matched: call.request.plugin_dirs_matched } : {}),
        call_outcome: callOutcome });
      if (turnId) {
        trace.push({ kind: 'turn.started', session_id: sessionId, turn_id: turnId, call_outcome: callOutcome });
        const contract = promptContractForTurn(codexTurnIndex);
        if (contract) trace.push({ kind: contract.kind, step_id: contract.step_id, matched: contract.matched === true,
          session_id: sessionId, turn_id: turnId, call_outcome: 'succeeded' });
      }
      if (call.response?.session_state === 'tombstone') {
        trace.push({ kind: 'session.tombstoned', session_state: call.response.session_state,
          session_id: sessionId, call_outcome: callOutcome });
      }
    } else if (call.tool === 'cursor_resume_session' && callOutcome === 'succeeded'
      && call.response?.session_state === 'tombstone') {
      sessionId = call.response?.session_id;
      turnId = undefined;
      trace.push({ kind: 'session.resume-failed', matched: call.request?.cursor_session_id === cursorSessionId
        && call.response?.cursor_session_id === cursorSessionId,
        session_id: sessionId, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_resume_session' && callOutcome === 'succeeded') {
      sessionId = call.response?.session_id;
      turnId = undefined;
      expectedProgressRevision = 0;
      trace.push({ kind: 'session.resumed', matched: call.request?.cursor_session_id === cursorSessionId
        && call.response?.cursor_session_id === cursorSessionId,
      ...(call.request?.model !== undefined ? { model: call.request.model } : {}),
      ...(call.request?.effort !== undefined ? { effort: call.request.effort } : {}),
      ...(call.request?.fast !== undefined ? { fast: call.request.fast } : {}),
      session_id: sessionId, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_send_prompt' && callOutcome === 'succeeded') {
      turnId = call.response?.turn_id;
      expectedProgressRevision = 0;
      if (turnId) {
        trace.push({ kind: 'turn.started', session_id: sessionId, turn_id: turnId, call_outcome: callOutcome });
        const contract = promptContractForTurn(codexTurnIndex);
        if (contract) trace.push({ kind: contract.kind, step_id: contract.step_id, matched: contract.matched === true,
          session_id: sessionId, turn_id: turnId, call_outcome: 'succeeded' });
      }
    } else if (call.tool === 'cursor_set_mode' && callOutcome === 'failed'
      && ['mode_timeout', 'protocol_error'].includes(call.response?.error_code)) {
      expectedFailure = true;
      trace.push({ kind: 'session.mode-change-failed', error_code: call.response.error_code,
        session_id: call.request?.session_id || sessionId, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_set_mode' && callOutcome === 'succeeded') {
      trace.push({ kind: 'session.mode-changed', mode: call.request?.mode,
        session_id: call.request?.session_id || call.response?.session_id, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_wait') {
      const timeoutOmitted = call.request?.timeout_ms === undefined;
      const effectiveTimeoutMs = timeoutOmitted ? 30_000 : call.request.timeout_ms;
      const progressRevisionMatched = expectedProgressRevision === 0
        ? call.request?.after_progress_revision === undefined || call.request?.after_progress_revision === 0
        : call.request?.after_progress_revision === expectedProgressRevision;
      if (call.response?.wait_timeout === true) {
        trace.push({ kind: 'turn.wait-timeout', timeout_ms: effectiveTimeoutMs, timeout_omitted: timeoutOmitted,
          progress_revision_matched: progressRevisionMatched, ...ids, call_outcome: callOutcome });
        if (activeFollowupEvidence && !activeFollowupObserved) {
          trace.push({ kind: 'turn.followup-received-active', ...ids, call_outcome: 'succeeded' });
          activeFollowupObserved = true;
        }
        sawWaitTimeout = true;
      }
      if (call.response?.events_lost === true) {
        trace.push({ kind: 'turn.events-lost', events_lost: true, ...ids, call_outcome: callOutcome });
      }
      const terminalStatus = call.response?.turn_status;
      const terminal = ['completed', 'failed', 'timed_out'].includes(terminalStatus);
      if (terminal && sawWaitTimeout) {
        trace.push({ kind: 'turn.wait-recovered', timeout_ms: effectiveTimeoutMs, timeout_omitted: timeoutOmitted,
          progress_revision_matched: progressRevisionMatched, ...ids, call_outcome: callOutcome });
        sawWaitTimeout = false;
      }
      // A terminal wait can observe either a transient closing wrapper or its
      // tombstone. Keep terminal/receipt evidence stable across that race.
      if (call.response?.session_state === 'tombstone'
        && (!terminal || (ids.turn_id && completedTurnIds.has(ids.turn_id)))) {
        trace.push({ kind: 'session.tombstoned', session_state: call.response.session_state,
          session_id: ids.session_id, call_outcome: callOutcome });
      }
      if (Number.isSafeInteger(call.response?.progress_revision)) expectedProgressRevision = call.response.progress_revision;
      for (const event of call.response?.events || []) {
        const evidence = progressEvidence.find(({ kind, step_id: stepId }) => kind === `progress.${event.kind}`
          && !trace.some((entry) => entry.step_id === stepId));
        if (evidence) trace.push({ kind: evidence.kind, step_id: evidence.step_id, ...ids, call_outcome: callOutcome });
      }
      for (const pending of call.response?.pending || []) {
        const observedCallback = callbackById.get(String(pending.request_id));
        trace.push({ kind: `pending.${pending.kind}`, step_id: observedCallback?.step_id || `unobserved:${pending.request_id}`,
          ...ids, request_id: pending.request_id, call_outcome: callOutcome });
      }
      if (terminal && ids.turn_id && !completedTurnIds.has(ids.turn_id)) {
        completedTurnIds.add(ids.turn_id);
        terminalProgramIndex += 1;
        const completedEvidenceRecord = terminalStatus === 'completed' ? terminalEvidence[terminalIndex++] : null;
        const armedEvidenceRecord = armedTerminalEvidence[terminalProgramIndex - 1];
        const terminalBoundaryRecord = completedEvidenceRecord || armedEvidenceRecord;
        if (terminalBoundaryRecord) {
          for (const [relativeIndex, effect] of safeEvidence.slice(previousTerminalEvidenceIndex + 1, terminalBoundaryRecord.index).entries()) {
            if (!effect.kind?.startsWith('effect.file-')) continue;
            const evidenceIndex = previousTerminalEvidenceIndex + 1 + relativeIndex;
            trace.push({ kind: effect.kind, step_id: effect.step_id, ...ids,
              codex_turn_index: codexTurnIndexForSafeEvidence(evidenceIndex, codexTurnIndex), call_outcome: 'succeeded' });
          }
          previousTerminalEvidenceIndex = terminalBoundaryRecord.index;
        }
        const terminalProof = completedEvidenceRecord?.entry;
        const armedProof = terminalStatus === 'completed' ? null : armedEvidenceRecord?.entry;
        const terminalStepId = terminalProof?.step_id || armedProof?.step_id || 'unobserved:terminal';
        if (ids.turn_id && typeof terminalProof?.result_sha256 === 'string') {
          fullResultDigestByTurn.set(ids.turn_id, { sha256: terminalProof.result_sha256, step_id: terminalStepId });
        }
        const terminalKind = terminalStatus === 'timed_out' ? 'turn.timed-out'
          : terminalStatus === 'failed' ? 'turn.failed' : 'turn.completed';
        trace.push({ kind: terminalKind, step_id: terminalStepId,
          ...ids, call_outcome: callOutcome });
        if (call.response?.terminal_receipt) {
          const receipt = call.response?.terminal_receipt;
          const expectedDigest = call.response?.result?.text_sha256 ?? terminalProof?.result_sha256 ?? null;
          trace.push({ kind: 'turn.receipt', step_id: terminalStepId,
            matched: receipt?.result_sha256 === expectedDigest,
            result_truncated: receipt?.result_truncated === true,
            ...ids, call_outcome: callOutcome });
        }
        if (terminalStatus === 'completed' && call.response?.session_state === 'tombstone') {
          trace.push({ kind: 'session.tombstoned', session_state: 'tombstone',
            session_id: ids.session_id, call_outcome: callOutcome });
        }
      }
    } else if (call.tool === 'cursor_read_result') {
      if (call.response?.result_read?.eof === true) {
        const expected = fullResultDigestByTurn.get(ids.turn_id);
        const complete = call.response.result_read.complete === true
          && typeof expected?.sha256 === 'string' && call.response.result_read.sha256 === expected.sha256;
        if (!complete || !completeResultReadTurns.has(ids.turn_id)) {
          trace.push({ kind: 'turn.result-read', complete,
            step_id: expected?.step_id || 'unobserved:terminal',
            ...ids, call_outcome: callOutcome });
          if (complete) completeResultReadTurns.add(ids.turn_id);
        }
      }
    } else if (call.tool === 'cursor_session_status' && callOutcome === 'succeeded'
      && trace.findLast(({ kind }) => kind === 'session.mode-change-failed')?.error_code === 'protocol_error') {
      if (call.response?.session_state === 'tombstone') trace.push({ kind: 'session.tombstoned', session_state: 'tombstone',
        session_id: call.request?.session_id || call.response?.session_id || sessionId, call_outcome: callOutcome });
      else trace.push({ kind: 'session.mode-recovery-status', session_state: call.response?.session_state,
        active_turn: call.response?.active_turn_present === true,
        session_id: call.request?.session_id || call.response?.session_id || sessionId, call_outcome: callOutcome });
    } else if (call.tool?.startsWith('cursor_answer_') && callOutcome === 'failed'
      && call.response?.error_code === 'unknown_request') {
      const requestKind = call.tool.slice('cursor_answer_'.length);
      const staleRequestId = String(call.request?.request_id);
      const observedPending = trace.findLast(({ kind, session_id: pendingSessionId, turn_id: pendingTurnId }) =>
        kind === `pending.${requestKind}` && pendingSessionId === ids.session_id && pendingTurnId === ids.turn_id);
      trace.push({ kind: 'answer.rejected-stale', step_id: observedPending?.step_id || `unobserved:${staleRequestId}`,
        error_code: 'unknown_request', ...ids, request_id: call.request?.request_id, call_outcome: callOutcome });
      expectedFailure = true;
    } else if (call.tool?.startsWith('cursor_answer_')) {
      const requestId = call.request?.request_id;
      const observedCallback = callbackById.get(String(requestId)) || callbackEvidence.find(({ kind }) => kind === 'callback.failure');
      const requestKind = call.tool.slice('cursor_answer_'.length);
      trace.push({ kind: `answer.${requestKind}`, step_id: observedCallback?.step_id || `unobserved:${requestId}`,
        ...ids, request_id: requestId, call_outcome: callOutcome,
        codex_turn_index: codexTurnIndex,
        ...(requestKind === 'question' ? { option_ids: call.request?.answers?.flatMap(({ selected_option_ids: optionIds }) => optionIds || []) || [] }
          : { decision: call.request?.decision }) });
    } else if (call.tool === 'cursor_close_session' && callOutcome === 'failed') {
      trace.push({ kind: 'call.failed', ...ids, call_outcome: callOutcome });
      expectedFailure = true;
    } else if (call.tool === 'cursor_close_session') {
      const closeTurnId = call.request?.turn_id || call.response?.turn_id || call.response?.terminal_receipt?.turn_id;
      const closedSessionId = call.request?.session_id || call.response?.session_id;
      // Wrapper-loss scenarios require the observed tombstone, rather than only
      // the caller's close attempt, before an explicit resume is admissible.
      if (call.response?.session_state === 'tombstone'
        && !trace.some(({ kind, session_id: observedSessionId }) => kind === 'session.tombstoned' && observedSessionId === closedSessionId)
        && scenario.expected_trace.some(({ kind }) => kind === 'session.tombstoned')
        && calls.slice(callIndex + 1).some(({ tool }) => tool === 'cursor_resume_session')) {
        trace.push({ kind: 'session.tombstoned', session_state: 'tombstone',
          session_id: closedSessionId, call_outcome: callOutcome });
      } else {
        trace.push({ kind: 'session.close-attempted', session_id: closedSessionId,
          ...(closeTurnId === undefined || closeTurnId === null ? {} : { turn_id: closeTurnId }),
          call_outcome: callOutcome });
      }
    } else {
      trace.push({ kind: 'unexpected-operation', ...ids, call_outcome: callOutcome });
    }
    if (trace.length === traceLengthBeforeCall && !(call.tool === 'cursor_read_result' && callOutcome === 'succeeded')) {
      trace.push({ kind: 'call.observed', ...ids, call_outcome: callOutcome });
    }
    if (callOutcome !== 'succeeded' && !expectedFailure) trace.push({ kind: 'call.failed', ...ids, call_outcome: callOutcome });
  }
  if (transcriptEvidence.dropped_calls > 0) trace.push({ kind: 'dropped-calls', session_id: sessionId, turn_id: turnId,
    dropped_calls: transcriptEvidence.dropped_calls, call_outcome: 'not_observed' });
  const callbacks = callbackEvidence
    .map(({ step_id, callback_id, kind, option_ids, decision, outcome }) => ({ step_id, callback_id, kind,
      ...(option_ids ? { option_ids } : {}), ...(decision ? { decision } : {}), ...(outcome ? { outcome } : {}) }));
  const effects = safeEvidence.filter(({ kind }) => kind?.startsWith('effect.file-'))
    .map(({ step_id, callback_id, kind }) => ({ step_id, callback_id, kind }));
  return { trace, callbacks, effects, ...outcomes };
}

function scoreWithCapturedFinals(scenario, observations, reports = null) {
  const count = (scenario.followups?.length || 0) + 1;
  const checks = scenario.report_checks || [];
  const texts = reports || Array.from({ length: count }, (_value, index) => checks
    .filter(({ turn_index: turnIndex }) => turnIndex === index + 1)
    .flatMap(({ required_fragments: fragments }) => fragments.map((fragment) => Array.isArray(fragment) ? fragment[0] : fragment))
    .join('\n') || 'completed');
  const scenarioForScore = { ...scenario, followups: scenario.followups || [], report_checks: scenario.report_checks?.map((check, index, checks) => ({
    turn_index: check.turn_index, category: check.category || 'interaction',
    required_fragments: check.required_fragments, forbidden_fragments: check.forbidden_fragments,
  })) || [],
  };
  const capturedFinals = Array.from({ length: count }, (_, index) => ({
    turn_index: index + 1, text: texts[index] ?? '', turn_id: `codex-turn-${index + 1}`,
    turn_status: 'completed', phase: 'final_answer', source: 'thread/items/list',
    completeness: 'complete', error_code: null,
  }));
  return evaluateScenario(scenarioForScore, { ...observations, captured_finals: capturedFinals });
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

export function hostedAppServerConfig(env = process.env) {
  const model = env.CURSOR_EVAL_HOSTED_MODEL || null;
  const effort = env.CURSOR_EVAL_HOSTED_REASONING_EFFORT || null;
  for (const [name, value] of [['CURSOR_EVAL_HOSTED_MODEL', model], ['CURSOR_EVAL_HOSTED_REASONING_EFFORT', effort]]) {
    if (value !== null && !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${name} is invalid`);
  }
  return {
    args: ['app-server', '--stdio', '-c', 'features.apps=true',
      ...(model ? ['-c', `model=${JSON.stringify(model)}`] : []),
      ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])],
    model: { provider: null, name: model },
  };
}

test('observed MCP transcript drives oracle order, IDs, call outcomes and dropped-call evidence', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [
      { type: 'pending', request_kind: 'question', step_id: 'question-1', callback_id: 'request-1', expected_callback: { kind: 'answer', option_ids: ['yes'] } },
      { type: 'terminal', step_id: 'terminal-1' },
    ] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' }, { kind: 'pending.question', step_id: 'question-1' },
      { kind: 'answer.question', step_id: 'question-1', option_ids: ['yes'] }, { kind: 'turn.completed', step_id: 'terminal-1' },
      { kind: 'session.close-attempted' },
    ],
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  let callId = 0;
  const call = (tool, request, response) => ({ direction: 'request', tool, call_id: ++callId, request, response });
  const delegate = call('cursor_delegate', { mode: 'ask' }, { ok: true, session_id: 'session-1', turn_id: 'turn-1' });
  const pending = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, pending: [{ request_id: 'request-1', kind: 'question' }] });
  const answer = call('cursor_answer_question', { session_id: 'session-1', turn_id: 'turn-1', request_id: 'request-1', answers: [{ selected_option_ids: ['yes'] }] }, { ok: true });
  const terminal = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, turn_status: 'completed' });
  const close = call('cursor_close_session', { session_id: 'session-1' }, { ok: true });
  const safe = [{ kind: 'answer', step_id: 'question-1', callback_id: 'request-1', option_ids: ['yes'] }, { event: 'prompt_result', step_id: 'terminal-1' }];
  const outcomes = { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' };
  const observe = (calls, safeEvidence = safe, droppedCalls = 0) => observationsFromEvidence(scenario, { calls, dropped_calls: droppedCalls }, safeEvidence, outcomes);
  assert.equal(scoreWithCapturedFinals(scenario, observe([delegate, pending, answer, terminal, close])).eval_status, 'pass');

  const watermarkedPending = structuredClone(pending); watermarkedPending.response.last_event_id = 4;
  const watermarkedAnswer = structuredClone(answer); watermarkedAnswer.response.last_event_id = 6;
  for (const afterEventId of [4, 6, 0, undefined]) {
    const nextWait = structuredClone(terminal);
    if (afterEventId === undefined) delete nextWait.request.after_event_id;
    else nextWait.request.after_event_id = afterEventId;
    assert.equal(scoreWithCapturedFinals(scenario,
      observe([delegate, watermarkedPending, watermarkedAnswer, nextWait, close])).eval_status, 'pass');
  }
  const repeatedCursorScenario = structuredClone(scenario);
  repeatedCursorScenario.expected_trace.splice(4, 0,
    { kind: 'turn.wait-timeout', timeout_ms: 1000, timeout_omitted: false, progress_revision_matched: true },
    { kind: 'turn.wait-recovered', timeout_ms: 2000, timeout_omitted: false, progress_revision_matched: true });
  const repeatedCursorWait = structuredClone(terminal);
  repeatedCursorWait.request = { ...repeatedCursorWait.request, after_event_id: 4, timeout_ms: 1000 };
  repeatedCursorWait.response = { ok: true, session_id: 'session-1', turn_id: 'turn-1', turn_status: 'running', wait_timeout: true };
  const repeatedCursorTerminal = structuredClone(terminal);
  repeatedCursorTerminal.request = { ...repeatedCursorTerminal.request, after_event_id: 4, timeout_ms: 2000 };
  const repeatedCursorObservations = observationsFromEvidence(repeatedCursorScenario,
    { calls: [delegate, watermarkedPending, watermarkedAnswer, repeatedCursorWait, repeatedCursorTerminal, close], dropped_calls: 0 }, safe, outcomes);
  assert.equal(scoreWithCapturedFinals(repeatedCursorScenario, repeatedCursorObservations).eval_status, 'pass');
  const futureWait = structuredClone(terminal); futureWait.request.after_event_id = 7;
  futureWait.response = { ok: false, error_code: 'invalid_args' };
  assert.equal(scoreWithCapturedFinals(scenario,
    observe([delegate, watermarkedPending, watermarkedAnswer, futureWait, close])).eval_status, 'agent_behavior_mismatch');

  const answerBeforePending = scoreWithCapturedFinals(scenario, observe([delegate, answer, pending, terminal, close]));
  assert.ok(answerBeforePending.mismatches.includes('answer-before-pending'));
  const wrongIdAnswer = structuredClone(answer); wrongIdAnswer.request.request_id = 'wrong-request';
  const wrongId = scoreWithCapturedFinals(scenario, observe([delegate, pending, wrongIdAnswer, terminal, close,
  ], [{ kind: 'callback.failure', step_id: 'question-1', callback_id: 'request-1', reason: 'id-mismatch' }, ...safe.slice(1)]));
  assert.ok(wrongId.mismatches.includes('id-mismatch'));
  const staleRecoveryScenario = structuredClone(scenario);
  staleRecoveryScenario.expected_trace.splice(3, 0,
    { kind: 'answer.rejected-stale', step_id: 'question-1', error_code: 'unknown_request' },
    { kind: 'pending.question', step_id: 'question-1' });
  const staleAnswer = call('cursor_answer_question', {
    session_id: 'session-1', turn_id: 'turn-1', request_id: 'stale-request', answers: [{ selected_option_ids: ['yes'] }],
  }, { ok: false, session_id: 'session-1', turn_id: 'turn-1', error_code: 'unknown_request' });
  assert.equal(scoreWithCapturedFinals(staleRecoveryScenario, observe([delegate, pending, staleAnswer, pending, answer, terminal, close])).eval_status, 'pass');
  const failedAnswer = structuredClone(answer); failedAnswer.response.ok = false;
  assert.ok(scoreWithCapturedFinals(scenario, observe([delegate, pending, failedAnswer, terminal, close])).mismatches.includes('trace-mismatch'));
  assert.ok(scoreWithCapturedFinals(scenario, observe([delegate, pending, answer, terminal, close,
    call('cursor_session_status', { session_id: 'session-1' }, { ok: true })])).mismatches.includes('operation-after-close'));
  const failedResumeCleanup = {
    ...scenario,
    program: { steps: [] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' },
      { kind: 'session.tombstoned', session_state: 'tombstone' },
      { kind: 'session.resume-failed', matched: true },
      { kind: 'session.close-attempted' },
    ],
  };
  const failedResumeCleanupResult = scoreWithCapturedFinals(failedResumeCleanup, {
    trace: [
      { kind: 'session.allocated', mode: 'ask', session_id: 'session-old', call_outcome: 'succeeded' },
      { kind: 'session.tombstoned', session_state: 'tombstone', session_id: 'session-old', call_outcome: 'succeeded' },
      { kind: 'session.resume-failed', matched: true, session_id: 'session-failed', call_outcome: 'succeeded' },
      { kind: 'session.close-attempted', session_id: 'session-failed', call_outcome: 'succeeded' },
    ], callbacks: [], effects: [], actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked', dropped_calls: 0,
  });
  assert.equal(failedResumeCleanupResult.eval_status, 'pass', JSON.stringify(failedResumeCleanupResult));
  const overflow = observe([delegate, pending, answer, terminal, close], safe, 3);
  assert.equal(overflow.trace.at(-1).dropped_calls, 3);
  assert.equal(scoreWithCapturedFinals(scenario, overflow).eval_status, 'agent_behavior_mismatch');
});

test('session-level observations do not inherit a prior turn ID', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-1' }] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
      { kind: 'turn.completed', step_id: 'terminal-1' }, { kind: 'session.mode-changed', mode: 'plan' },
      { kind: 'session.close-attempted' },
    ],
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
    { tool: 'cursor_set_mode', request: { session_id: 'S', mode: 'plan' }, response: { ok: true, session_id: 'S', mode: 'plan' } },
    { tool: 'cursor_close_session', request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
  ];
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1' }],
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  for (const entry of observations.trace.filter(({ kind }) => ['session.mode-changed', 'session.close-attempted'].includes(kind))) {
    assert.equal(Object.hasOwn(entry, 'turn_id'), false);
  }
  assert.deepEqual(scoreWithCapturedFinals(scenario, observations).mismatches, []);

  const privatePrompt = 'private close rationale';
  const argumentsDigest = sha256(privatePrompt);
  const recoveredCloseCalls = [...calls.slice(0, -1),
    { tool: 'cursor_close_session', request: { session_id: 'typo', arguments_without_session_turn_sha256: argumentsDigest },
      response: { ok: false, error_code: 'unknown_session' } },
    { tool: 'cursor_close_session', request: { session_id: 'S', arguments_without_session_turn_sha256: argumentsDigest },
      response: { ok: true, session_id: 'S', session_state: 'tombstone' } }];
  const recoveryTranscript = { calls: recoveredCloseCalls, dropped_calls: 0,
    turn_call_ranges: [{ start: 0, end: recoveredCloseCalls.length }], unexpected_input_requests: 0 };
  const recoveredClose = observationsFromEvidence(scenario, recoveryTranscript,
    [{ event: 'prompt_result', step_id: 'terminal-1' }],
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.equal(recoveryTranscript.calls.filter(({ tool }) => tool === 'cursor_close_session').length, 2);
  assert.equal(recoveredClose.trace.filter(({ kind }) => kind === 'session.close-attempted').length, 1);
  assert.deepEqual(recoveredClose.trace, observations.trace);
  assert.equal(JSON.stringify(recoveryTranscript).includes(privatePrompt), false);

  for (const diagnosticCount of [1, 2]) {
    const withStatus = structuredClone(recoveryTranscript);
    withStatus.calls.splice(-1, 0, ...Array.from({ length: diagnosticCount }, () => ({
      tool: 'cursor_session_status', request: { session_id: 'S', arguments_without_session_turn_sha256: sha256('{}') },
      response: { ok: true, session_id: 'S', session_state: 'live' },
    })));
    withStatus.turn_call_ranges[0].end = withStatus.calls.length;
    const original = structuredClone(withStatus);
    const projected = observationsFromEvidence(scenario, withStatus,
      [{ event: 'prompt_result', step_id: 'terminal-1' }],
      { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
    assert.equal(scoreWithCapturedFinals(scenario, { ...projected, transcript: withStatus }).eval_status, 'pass');
    assert.deepEqual(withStatus, original);
    withStatus.calls.at(-2).request.turn_id = 'T';
    const malformed = observationsFromEvidence(scenario, withStatus,
      [{ event: 'prompt_result', step_id: 'terminal-1' }],
      { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
    assert.equal(scoreWithCapturedFinals(scenario, { ...malformed, transcript: withStatus }).eval_status, 'agent_behavior_mismatch');
  }

  const cursorScenario = structuredClone(scenario);
  cursorScenario.expected_trace.splice(2, 0, { kind: 'turn.events-lost', events_lost: true });
  const cursorCalls = structuredClone(calls);
  cursorCalls[0].response.last_event_id = 2;
  cursorCalls[1].request = { session_id: 'S', turn_id: 'T', after_event_id: 3,
    arguments_without_session_turn_sha256: sha256(canonicalJson({ after_event_id: 3 })) };
  cursorCalls[1].response.events_lost = true;
  cursorCalls.splice(1, 0,
    { tool: 'cursor_wait', request: { arguments_without_session_turn_sha256: sha256('{}') },
      response: { ok: false, error_code: 'invalid_args' } },
    { tool: 'cursor_session_status', request: { session_id: 'S', arguments_without_session_turn_sha256: sha256('{}') },
      response: { ok: true, session_id: 'S', last_event_id: 3 } });
  const cursorTranscript = { calls: cursorCalls, dropped_calls: 0, unexpected_input_requests: 0,
    turn_call_ranges: [{ start: 0, end: cursorCalls.length }] };
  const cursorObservation = observationsFromEvidence(cursorScenario, cursorTranscript,
    [{ event: 'prompt_result', step_id: 'terminal-1' }],
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.equal(scoreWithCapturedFinals(cursorScenario, { ...cursorObservation, transcript: cursorTranscript }).eval_status, 'pass');

  const missingRecoveryProof = { calls: recoveredCloseCalls, dropped_calls: 0 };
  const unrecoveredClose = observationsFromEvidence(scenario, missingRecoveryProof,
    [{ event: 'prompt_result', step_id: 'terminal-1' }],
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.ok(unrecoveredClose.trace.some(({ kind }) => kind === 'call.failed'));
});

test('runtime recovery trace proves the old wrapper tombstone without duplicating terminal evidence', () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-1' }, { type: 'terminal', step_id: 'terminal-2' }] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' }, { kind: 'turn.completed', step_id: 'terminal-1' },
      { kind: 'turn.receipt', step_id: 'terminal-1', matched: true, result_truncated: false },
      { kind: 'session.tombstoned', session_state: 'tombstone' },
      { kind: 'session.resumed', matched: true }, { kind: 'turn.started' }, { kind: 'turn.completed', step_id: 'terminal-2' },
      { kind: 'turn.receipt', step_id: 'terminal-2', matched: true, result_truncated: false }, { kind: 'session.close-attempted' },
    ],
    expected_actual_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  const digest1 = 'a'.repeat(64); const digest2 = 'b'.repeat(64);
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'session-1', turn_id: 'turn-1', cursor_session_id: 'cursor-1' } },
    { tool: 'cursor_wait', request: { session_id: 'session-1', turn_id: 'turn-1' }, response: { ok: true, session_id: 'session-1', turn_id: 'turn-1', turn_status: 'completed', terminal_receipt: { result_sha256: digest1, result_truncated: false } } },
    { tool: 'cursor_wait', request: { session_id: 'session-1', turn_id: 'turn-1' }, response: { ok: true, session_id: 'session-1', turn_id: 'turn-1', turn_status: 'completed', session_state: 'tombstone' } },
    { tool: 'cursor_resume_session', request: { cursor_session_id: 'cursor-1' }, response: { ok: true, session_id: 'session-2', cursor_session_id: 'cursor-1' } },
    { tool: 'cursor_send_prompt', request: { session_id: 'session-2' }, response: { ok: true, session_id: 'session-2', turn_id: 'turn-2' } },
    { tool: 'cursor_wait', request: { session_id: 'session-2', turn_id: 'turn-2' }, response: { ok: true, session_id: 'session-2', turn_id: 'turn-2', turn_status: 'completed', terminal_receipt: { result_sha256: digest2, result_truncated: false } } },
    { tool: 'cursor_close_session', request: { session_id: 'session-2' }, response: { ok: true, session_id: 'session-2' } },
  ];
  const safe = [
    { event: 'prompt_result', step_id: 'terminal-1', result_sha256: digest1 },
    { event: 'prompt_result', step_id: 'terminal-2', result_sha256: digest2 },
  ];
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.equal(observations.trace.filter(({ kind }) => kind === 'turn.completed').length, 2);
  assert.equal(scoreWithCapturedFinals(scenario, observations).eval_status, 'pass');
  const directTombstoneCalls = structuredClone(calls);
  directTombstoneCalls[1].response.session_state = 'tombstone';
  directTombstoneCalls.splice(2, 1);
  const directTombstone = observationsFromEvidence(scenario, { calls: directTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  const firstTerminal = directTombstone.trace.findIndex(({ kind }) => kind === 'turn.completed');
  assert.deepEqual(directTombstone.trace.slice(firstTerminal, firstTerminal + 3).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned']);
  assert.equal(scoreWithCapturedFinals(scenario, directTombstone).eval_status, 'pass');
  const idempotentCloseCalls = structuredClone(directTombstoneCalls);
  idempotentCloseCalls.splice(2, 0, {
    tool: 'cursor_close_session', request: { session_id: 'session-1' },
    response: { ok: true, session_id: 'session-1', session_state: 'tombstone' },
  });
  const idempotentClose = observationsFromEvidence(scenario, { calls: idempotentCloseCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.deepEqual(idempotentClose.trace.slice(firstTerminal, firstTerminal + 4).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned', 'session.close-attempted']);
  assert.equal(scoreWithCapturedFinals(scenario, idempotentClose).eval_status, 'pass');
  const repeatedTombstoneCalls = structuredClone(directTombstoneCalls);
  repeatedTombstoneCalls.splice(2, 0, structuredClone(repeatedTombstoneCalls[1]));
  const repeatedTombstone = observationsFromEvidence(scenario, { calls: repeatedTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.ok(scoreWithCapturedFinals(scenario, repeatedTombstone).mismatches.includes('operation-after-close'));
  const postCloseDelegateCalls = structuredClone(idempotentCloseCalls);
  postCloseDelegateCalls.splice(3, 0, {
    tool: 'cursor_delegate', request: { mode: 'ask' },
    response: { ok: true, session_id: 'session-replacement', turn_id: 'turn-replacement', cursor_session_id: 'cursor-replacement' },
  });
  const postCloseDelegate = observationsFromEvidence(scenario, { calls: postCloseDelegateCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.ok(scoreWithCapturedFinals(scenario, postCloseDelegate).mismatches.includes('operation-after-close'));
  const closeTombstoneCalls = structuredClone(calls);
  closeTombstoneCalls[2] = {
    tool: 'cursor_close_session', request: { session_id: 'session-1' },
    response: { ok: true, session_id: 'session-1', session_state: 'tombstone' },
  };
  const closeTombstone = observationsFromEvidence(scenario, { calls: closeTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked' });
  assert.deepEqual(closeTombstone.trace.slice(firstTerminal, firstTerminal + 3).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned']);
  assert.equal(scoreWithCapturedFinals(scenario, closeTombstone).eval_status, 'pass');
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

test('credential-free app-server adapter pins the custom provider to the observed fixture endpoint', () => {
  assert.deepEqual(fixtureProviderAppServerArgs('http://127.0.0.1:43123/'), [
    'app-server', '--stdio', '-c', 'features.apps=true', '-c', 'model_provider="fixture_ollama"',
    '-c', 'model="qwen2.5-coder:7b"', '-c', 'model_providers.fixture_ollama.name="Fixture Ollama"',
    '-c', 'model_providers.fixture_ollama.base_url="http://127.0.0.1:43123/v1"',
    '-c', 'model_providers.fixture_ollama.wire_api="responses"',
  ]);
});

test('hosted app-server config safely pins an explicit model and effort', () => {
  assert.deepEqual(hostedAppServerConfig({ CURSOR_EVAL_HOSTED_MODEL: 'gpt-5.6-terra', CURSOR_EVAL_HOSTED_REASONING_EFFORT: 'medium' }), {
    args: ['app-server', '--stdio', '-c', 'features.apps=true', '-c', 'model="gpt-5.6-terra"', '-c', 'model_reasoning_effort="medium"'],
    model: { provider: null, name: 'gpt-5.6-terra' },
  });
  assert.throws(() => hostedAppServerConfig({ CURSOR_EVAL_HOSTED_MODEL: 'bad[value]' }), /HOSTED_MODEL is invalid/);
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
    ...(harnessFaults.has('accelerate-turn-timeout') || harnessFaults.has('accelerate-wait-timeout')
      ? { CURSOR_EVAL_TIMEOUT_PRELOAD: join(fixture.root, 'fake-agent/accelerate-turn-timeout.mjs') }
      : {}),
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
    const installedSkillSelected = typeof skillEvidence.plugin_id === 'string'
      && skillEvidence.content_sha256 === fixture.skillSha256
      && skillEvidence.content_bytes === fixture.skillBytes;
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
    assert.deepEqual(Object.keys(selectedServer?.tools || {}).sort(), ['cursor_answer_permission', 'cursor_answer_plan', 'cursor_answer_question', 'cursor_cancel', 'cursor_close_session', 'cursor_delegate', 'cursor_read_result', 'cursor_resume_session', 'cursor_send_prompt', 'cursor_session_status', 'cursor_set_mode', 'cursor_start_session', 'cursor_wait']);
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
