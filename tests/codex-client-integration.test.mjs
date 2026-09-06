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
import { applySkillSensitivity } from '../scripts/cursor-skill-eval.mjs';
import { parseChildResult, runHarness } from '../scripts/run-cursor-skill-eval.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const codex = process.env.CURSOR_EVAL_CODEX_EXECUTABLE || '/Applications/ChatGPT.app/Contents/Resources/codex';
const adapter = fileURLToPath(new URL('./fixtures/codex-v01521-adapter.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('./fixtures/release-fake-acp.mjs', import.meta.url));
const fakeProvider = fileURLToPath(new URL('./fixtures/fake-ollama-responses.mjs', import.meta.url));
const turnTimeoutPreload = fileURLToPath(new URL('./fixtures/accelerate-turn-timeout.mjs', import.meta.url));
const skill = 'codex-cursor-subagent-plugin:cursor-subagent';
const skillSensitivity = process.env.CURSOR_EVAL_SKILL_SENSITIVITY || null;
const HOSTED_APP_SERVER_OUTPUT_LIMIT = 16 * 1_048_576;
const HOSTED_OBSERVATION_TIMEOUT_MS = 180_000;

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
  const originalSkill = await readFile(join(repository, 'skills/cursor-subagent/SKILL.md'));
  const expectedSourceSkill = digestFromEnvironment('CURSOR_EVAL_EXPECTED_SOURCE_SKILL', false);
  if (expectedSourceSkill) assert.deepEqual({ sha256: sha256(originalSkill), bytes: originalSkill.length }, expectedSourceSkill, 'sensitivity source skill drifted');
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(repository, path), join(source, path));
  }
  await cp(join(repository, 'skills'), join(source, 'skills'), { recursive: true });
  if (skillSensitivity) {
    const skillPath = join(source, 'skills/cursor-subagent/SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await writeFile(skillPath, applySkillSensitivity(original, skillSensitivity), 'utf8');
  }
  const fakeAgentRoot = join(root, 'fake-agent');
  await mkdir(fakeAgentRoot);
  await configureFakeAgent(join(fakeAgentRoot, 'agent'));
  await cp(fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url)), join(fakeAgentRoot, 'fake-acp.mjs'));
  await cp(turnTimeoutPreload, join(fakeAgentRoot, 'accelerate-turn-timeout.mjs'));
  const skillBytes = await readFile(join(source, 'skills/cursor-subagent/SKILL.md'));
  const expectedLoadedSkill = digestFromEnvironment('CURSOR_EVAL_EXPECTED_LOADED_SKILL', false);
  if (expectedLoadedSkill) assert.deepEqual({ sha256: sha256(skillBytes), bytes: skillBytes.length }, expectedLoadedSkill, 'sensitivity loaded skill drifted');
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
  let expectedEventCursor;
  let expectedProgressRevision = 0;
  let sawWaitTimeout = false;
  let activeFollowupObserved = false;
  let previousTerminalEvidenceIndex = -1;
  const completedTurnIds = new Set();
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
      expectedEventCursor = call.response?.last_event_id;
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
      expectedEventCursor = call.response?.last_event_id;
      expectedProgressRevision = 0;
      trace.push({ kind: 'session.resumed', matched: call.request?.cursor_session_id === cursorSessionId
        && call.response?.cursor_session_id === cursorSessionId,
      ...(call.request?.model !== undefined ? { model: call.request.model } : {}),
      ...(call.request?.effort !== undefined ? { effort: call.request.effort } : {}),
      ...(call.request?.fast !== undefined ? { fast: call.request.fast } : {}),
      session_id: sessionId, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_send_prompt' && callOutcome === 'succeeded') {
      turnId = call.response?.turn_id;
      expectedEventCursor = call.response?.last_event_id;
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
      const cursorMatched = call.request?.after_event_id === expectedEventCursor;
      const timeoutOmitted = call.request?.timeout_ms === undefined;
      const effectiveTimeoutMs = timeoutOmitted ? 30_000 : call.request.timeout_ms;
      const progressRevisionMatched = expectedProgressRevision === 0
        ? call.request?.after_progress_revision === undefined || call.request?.after_progress_revision === 0
        : call.request?.after_progress_revision === expectedProgressRevision;
      if (call.response?.wait_timeout === true) {
        trace.push({ kind: 'turn.wait-timeout', timeout_ms: effectiveTimeoutMs, timeout_omitted: timeoutOmitted, cursor_matched: cursorMatched,
          progress_revision_matched: progressRevisionMatched, ...ids, call_outcome: callOutcome });
        if (activeFollowupEvidence && !activeFollowupObserved) {
          trace.push({ kind: 'turn.followup-received-active', ...ids, call_outcome: 'succeeded' });
          activeFollowupObserved = true;
        }
        sawWaitTimeout = true;
      }
      if (call.response?.events_lost === true) {
        trace.push({ kind: 'turn.events-lost', events_lost: true,
          cursor_matched: cursorMatched, ...ids, call_outcome: callOutcome });
      }
      const terminalStatus = call.response?.turn_status;
      const terminal = ['completed', 'failed', 'timed_out'].includes(terminalStatus);
      if (terminal && sawWaitTimeout) {
        trace.push({ kind: 'turn.wait-recovered', timeout_ms: effectiveTimeoutMs, timeout_omitted: timeoutOmitted, cursor_matched: cursorMatched,
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
      expectedEventCursor = call.response?.resume_after_event_id ?? call.response?.last_event_id ?? expectedEventCursor;
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
        const terminalKind = terminalStatus === 'timed_out' ? 'turn.timed-out'
          : terminalStatus === 'failed' ? 'turn.failed' : 'turn.completed';
        trace.push({ kind: terminalKind, step_id: terminalStepId,
          ...ids, call_outcome: callOutcome });
        if (call.response?.terminal_receipt) {
          const receipt = call.response?.terminal_receipt;
          const expectedDigest = terminalProof?.result_sha256 ?? null;
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
      expectedEventCursor = call.response?.last_event_id ?? expectedEventCursor;
      trace.push({ kind: `answer.${requestKind}`, step_id: observedCallback?.step_id || `unobserved:${requestId}`,
        ...ids, request_id: requestId, call_outcome: callOutcome,
        codex_turn_index: codexTurnIndex,
        ...(requestKind === 'question' ? { option_ids: call.request?.answers?.flatMap(({ selected_option_ids: optionIds }) => optionIds || []) || [] }
          : { decision: call.request?.decision }) });
    } else if (call.tool === 'cursor_close_session') {
      const closeTurnId = call.request?.turn_id || call.response?.turn_id || call.response?.terminal_receipt?.turn_id;
      const closedSessionId = call.request?.session_id || call.response?.session_id;
      // Wrapper-loss scenarios require the observed tombstone, rather than only
      // the caller's close attempt, before an explicit resume is admissible.
      if (call.response?.session_state === 'tombstone'
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
    if (trace.length === traceLengthBeforeCall) trace.push({ kind: 'call.observed', ...ids, call_outcome: callOutcome });
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
    expected_actual_task_outcome: 'succeeded', expected_reported_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  let callId = 0;
  const call = (tool, request, response) => ({ direction: 'request', tool, call_id: ++callId, request, response });
  const delegate = call('cursor_delegate', { mode: 'ask' }, { ok: true, session_id: 'session-1', turn_id: 'turn-1' });
  const pending = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, pending: [{ request_id: 'request-1', kind: 'question' }] });
  const answer = call('cursor_answer_question', { session_id: 'session-1', turn_id: 'turn-1', request_id: 'request-1', answers: [{ selected_option_ids: ['yes'] }] }, { ok: true });
  const terminal = call('cursor_wait', { session_id: 'session-1', turn_id: 'turn-1' }, { ok: true, turn_status: 'completed' });
  const close = call('cursor_close_session', { session_id: 'session-1' }, { ok: true });
  const safe = [{ kind: 'answer', step_id: 'question-1', callback_id: 'request-1', option_ids: ['yes'] }, { event: 'prompt_result', step_id: 'terminal-1' }];
  const outcomes = { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded' };
  const observe = (calls, safeEvidence = safe, droppedCalls = 0) => observationsFromEvidence(scenario, { calls, dropped_calls: droppedCalls }, safeEvidence, outcomes);
  assert.equal(evaluateScenario(scenario, observe([delegate, pending, answer, terminal, close])).eval_status, 'pass');

  const answerBeforePending = evaluateScenario(scenario, observe([delegate, answer, pending, terminal, close]));
  assert.ok(answerBeforePending.mismatches.includes('answer-before-pending'));
  const wrongIdAnswer = structuredClone(answer); wrongIdAnswer.request.request_id = 'wrong-request';
  const wrongId = evaluateScenario(scenario, observe([delegate, pending, wrongIdAnswer, terminal, close,
  ], [{ kind: 'callback.failure', step_id: 'question-1', callback_id: 'request-1', reason: 'id-mismatch' }, ...safe.slice(1)]));
  assert.ok(wrongId.mismatches.includes('id-mismatch'));
  const staleRecoveryScenario = structuredClone(scenario);
  staleRecoveryScenario.expected_trace.splice(3, 0,
    { kind: 'answer.rejected-stale', step_id: 'question-1', error_code: 'unknown_request' },
    { kind: 'pending.question', step_id: 'question-1' });
  const staleAnswer = call('cursor_answer_question', {
    session_id: 'session-1', turn_id: 'turn-1', request_id: 'stale-request', answers: [{ selected_option_ids: ['yes'] }],
  }, { ok: false, session_id: 'session-1', turn_id: 'turn-1', error_code: 'unknown_request' });
  assert.equal(evaluateScenario(staleRecoveryScenario, observe([delegate, pending, staleAnswer, pending, answer, terminal, close])).eval_status, 'pass');
  const failedAnswer = structuredClone(answer); failedAnswer.response.ok = false;
  assert.ok(evaluateScenario(scenario, observe([delegate, pending, failedAnswer, terminal, close])).mismatches.includes('trace-mismatch'));
  assert.ok(evaluateScenario(scenario, observe([delegate, pending, answer, terminal, close,
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
  const failedResumeCleanupResult = evaluateScenario(failedResumeCleanup, {
    trace: [
      { kind: 'session.allocated', mode: 'ask', session_id: 'session-old', call_outcome: 'succeeded' },
      { kind: 'session.tombstoned', session_state: 'tombstone', session_id: 'session-old', call_outcome: 'succeeded' },
      { kind: 'session.resume-failed', matched: true, session_id: 'session-failed', call_outcome: 'succeeded' },
      { kind: 'session.close-attempted', session_id: 'session-failed', call_outcome: 'succeeded' },
    ], callbacks: [], effects: [], actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded', dropped_calls: 0,
  });
  assert.equal(failedResumeCleanupResult.eval_status, 'pass', JSON.stringify(failedResumeCleanupResult));
  const overflow = observe([delegate, pending, answer, terminal, close], safe, 3);
  assert.equal(overflow.trace.at(-1).dropped_calls, 3);
  assert.equal(evaluateScenario(scenario, overflow).eval_status, 'agent_behavior_mismatch');
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
    expected_actual_task_outcome: 'succeeded', expected_reported_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
    { tool: 'cursor_set_mode', request: { session_id: 'S', mode: 'plan' }, response: { ok: true, session_id: 'S', mode: 'plan' } },
    { tool: 'cursor_close_session', request: { session_id: 'S' }, response: { ok: true, session_id: 'S', session_state: 'tombstone' } },
  ];
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 },
    [{ event: 'prompt_result', step_id: 'terminal-1' }],
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded' });
  for (const entry of observations.trace.filter(({ kind }) => ['session.mode-changed', 'session.close-attempted'].includes(kind))) {
    assert.equal(Object.hasOwn(entry, 'turn_id'), false);
  }
  assert.deepEqual(evaluateScenario(scenario, observations).mismatches, []);
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
    expected_actual_task_outcome: 'succeeded', expected_reported_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
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
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded' });
  assert.equal(observations.trace.filter(({ kind }) => kind === 'turn.completed').length, 2);
  assert.equal(evaluateScenario(scenario, observations).eval_status, 'pass');
  const directTombstoneCalls = structuredClone(calls);
  directTombstoneCalls[1].response.session_state = 'tombstone';
  directTombstoneCalls.splice(2, 1);
  const directTombstone = observationsFromEvidence(scenario, { calls: directTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded' });
  const firstTerminal = directTombstone.trace.findIndex(({ kind }) => kind === 'turn.completed');
  assert.deepEqual(directTombstone.trace.slice(firstTerminal, firstTerminal + 3).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned']);
  assert.equal(evaluateScenario(scenario, directTombstone).eval_status, 'pass');
  const closeTombstoneCalls = structuredClone(calls);
  closeTombstoneCalls[2] = {
    tool: 'cursor_close_session', request: { session_id: 'session-1' },
    response: { ok: true, session_id: 'session-1', session_state: 'tombstone' },
  };
  const closeTombstone = observationsFromEvidence(scenario, { calls: closeTombstoneCalls, dropped_calls: 0 }, safe,
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded' });
  assert.deepEqual(closeTombstone.trace.slice(firstTerminal, firstTerminal + 3).map(({ kind }) => kind),
    ['turn.completed', 'turn.receipt', 'session.tombstoned']);
  assert.equal(evaluateScenario(scenario, closeTombstone).eval_status, 'pass');
});

test('scripted providers use distinct OS-assigned endpoints in parallel', async (t) => {
  const providers = await Promise.all([startProvider({ ...process.env, CURSOR_EVAL_PROVIDER_PORT: '0' }), startProvider({ ...process.env, CURSOR_EVAL_PROVIDER_PORT: '0' })]);
  t.after(async () => Promise.all(providers.map(({ child }) => stopProcess(child))));
  assert.notEqual(providers[0].endpoint, providers[1].endpoint);
});

test('timeout acceleration preload scopes each runtime timer to its own fault flag', async () => {
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
  const [none, turn, mode, wait] = await Promise.all([
    probe(null), probe('FAKE_ACP_ACCELERATE_TURN_TIMEOUT'), probe('FAKE_ACP_ACCELERATE_MODE_TIMEOUT'), probe('FAKE_ACP_ACCELERATE_WAIT_TIMEOUT'),
  ]);
  assert.deepEqual(none, { 15000: false, 30000: false, 3600000: false });
  assert.deepEqual(turn, { 15000: false, 30000: false, 3600000: true });
  assert.deepEqual(mode, { 15000: true, 30000: false, 3600000: false });
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

function reportBindingValues(transcriptEvidence, binding, turnIndex, reportContext) {
  if (binding === 'next_provider_operation_requires_new_user_decision') return [true];
  if (binding === 'work_in_progress') return [true];
  if (binding === 'observation_gap') return [true];
  if (binding === 'history_reconstructed') return [false];
  if (binding === 'evidence_scope') return ['current_normalized_state'];
  const range = transcriptEvidence?.turn_call_ranges?.[turnIndex - 1];
  if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end < range.start) return [];
  const allCalls = transcriptEvidence.calls || [];
  let segmentStartIndex = -1;
  for (let index = 0; index < range.end; index += 1) {
    const { tool, response } = allCalls[index] || {};
    if (['cursor_delegate', 'cursor_resume_session'].includes(tool) && response?.ok === true
      && typeof response?.session_id === 'string') segmentStartIndex = index;
  }
  const turnCalls = allCalls.slice(range.start, range.end);
  if (['cursor_session_id', 'model', 'effort', 'fast', 'plugin_dir'].includes(binding)) {
    const segmentStart = allCalls[segmentStartIndex];
    if (!segmentStart) return [];
    if (binding === 'plugin_dir') return segmentStart.request?.plugin_dirs_matched === true
      && typeof reportContext?.plugin_dir === 'string' ? [reportContext.plugin_dir] : [];
    if (binding === 'cursor_session_id') return typeof segmentStart.response.cursor_session_id === 'string'
      ? [segmentStart.response.cursor_session_id] : [];
    const value = segmentStart.request?.[binding] ?? segmentStart.response?.[binding];
    return value === undefined || value === null ? [] : [value];
  }
  if (binding === 'session_id' || binding === 'turn_id') {
    const currentCall = turnCalls.findLast(({ request, response }) =>
      request?.[binding] !== undefined || response?.[binding] !== undefined);
    return currentCall ? [currentCall.request?.[binding], currentCall.response?.[binding]]
      .filter((value) => value !== undefined && value !== null) : [];
  }
  const responses = turnCalls.flatMap(({ response }) => response ? [response] : []);
  if (binding === 'pending_request_id') return responses.flatMap(({ pending }) => (pending || []).map(({ request_id: requestId }) => requestId));
  if (binding === 'terminal_result_sha256') {
    const receipt = responses.findLast(({ terminal_receipt: candidate }) => candidate)?.terminal_receipt;
    return receipt?.result_sha256 ? [receipt.result_sha256] : [];
  }
  if (['terminal_receipt', 'terminal_reason', 'provider_error'].includes(binding)) {
    const response = responses.findLast((candidate) => candidate[binding] !== undefined && candidate[binding] !== null);
    return response ? [response[binding]] : [];
  }
  return responses.flatMap((response) => response[binding] === undefined || response[binding] === null ? [] : [response[binding]]);
}

function parsedReportObjects(text) {
  const objects = [];
  const collect = (value) => {
    if (!value || Array.isArray(value) || typeof value !== 'object') return;
    objects.push(value);
    for (const nested of Object.values(value)) collect(nested);
  };
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try { collect(JSON.parse(text.slice(start, end + 1))); } catch {}
          start = end;
          break;
        }
      }
    }
  }
  return objects;
}

function parsedRootReportObjects(text) {
  const objects = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try { objects.push(JSON.parse(text.slice(start, end + 1))); } catch {}
          start = end;
          break;
        }
      }
    }
  }
  return objects;
}

function reportBindingValue(reportObject, binding) {
  if (binding === 'pending_request_id') return reportObject.request_id;
  if (binding === 'terminal_result_sha256') return reportObject.terminal_receipt?.result_sha256;
  if (binding === 'plugin_dir') return Array.isArray(reportObject.plugin_dirs) ? reportObject.plugin_dirs : [];
  return reportObject[binding];
}

function reportBindingCandidates(reportObject, binding) {
  const values = [];
  const visit = (value) => {
    if (!value || Array.isArray(value) || typeof value !== 'object') return;
    const candidate = reportBindingValue(value, binding);
    if (candidate !== undefined) values.push(candidate);
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(reportObject);
  return values;
}

function reportBindingsMatch(transcriptEvidence, bindings, turnIndex, reportContext, text) {
  if (bindings.length === 0) return true;
  const expected = Object.fromEntries(bindings.map((binding) => [binding,
    reportBindingValues(transcriptEvidence, binding, turnIndex, reportContext)]));
  if (Object.values(expected).some((values) => values.length === 0)) return false;
  return parsedRootReportObjects(text).some((reportObject) => bindings.every((binding) => {
    const reported = reportBindingCandidates(reportObject, binding);
    if (binding === 'plugin_dir') return expected[binding].some((value) =>
      reported.some((candidate) => Array.isArray(candidate) && candidate.includes(value)));
    return expected[binding].some((value) => reported.some((candidate) =>
      canonicalJson(candidate) === canonicalJson(value)));
  }));
}

function reportCheckDiagnostics(scenario, reports, transcriptEvidence, reportContext) {
  return (scenario.report_checks || []).map(({ turn_index: turnIndex, required_fragments: required,
    forbidden_fragments: forbidden, required_bindings: bindings = [] }) => {
    const report = reports[turnIndex - 1] || '';
    const objects = parsedRootReportObjects(report);
    return {
      turn_index: turnIndex,
      missing_fragments: required.filter((fragment) => !report.includes(fragment)),
      forbidden_fragments: forbidden.filter((fragment) => report.includes(fragment)),
      bindings: Object.fromEntries(bindings.map((binding) => {
        const expected = reportBindingValues(transcriptEvidence, binding, turnIndex, reportContext);
        const reported = objects.flatMap((object) => reportBindingCandidates(object, binding));
        return [binding, { matched: expected.some((value) => reported.some((candidate) =>
          canonicalJson(candidate) === canonicalJson(value))), expected, reported }];
      })),
    };
  });
}

async function observeFixtureOutcome(scenario, workspace, reportedTexts = [], safeEvidence = [], transcriptEvidence = null, reportContext = null) {
  const predicate = scenario.fixture_predicate;
  let actual;
  if (predicate.kind === 'file-text') actual = await readFile(join(workspace, ...predicate.path.split('/')), 'utf8').then((text) => text === predicate.text ? 'succeeded' : 'failed', () => 'failed');
  else if (predicate.kind === 'file-absent') actual = await readFile(join(workspace, ...predicate.path.split('/'))).then(() => 'failed', (error) => error.code === 'ENOENT' ? 'succeeded' : Promise.reject(error));
  else if (predicate.kind === 'terminal-token') {
    const expectedDigest = sha256(Buffer.from(predicate.token));
    actual = safeEvidence.some(({ event, result_sha256: resultSha256 }) => event === 'prompt_result' && resultSha256 === expectedDigest) ? 'succeeded' : 'failed';
  }
  else if (predicate.kind === 'terminal-status') actual = transcriptEvidence?.calls?.some(({ response }) => response?.turn_status === predicate.status) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'resume-failed') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_resume_session'
    && response?.session_state === 'tombstone') ? 'failed' : 'succeeded';
  else if (predicate.kind === 'mode-change-failed') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_set_mode'
    && response?.error_code === predicate.error_code) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'mode-recovery-status') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_session_status'
    && response?.session_state === predicate.session_state && response?.active_turn_present === predicate.active_turn) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'delegate-init-failed') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_delegate'
    && response?.session_state === 'tombstone' && response?.failure_kind === predicate.failure_kind
    && response?.turn_id === undefined) ? 'failed' : 'succeeded';
  else if (predicate.kind === 'start-rejected') actual = transcriptEvidence?.calls?.some(({ tool, response }) => tool === 'cursor_delegate'
    && response?.error_code === predicate.error_code) ? 'failed' : 'succeeded';
  else actual = 'succeeded';
  const reports = Array.isArray(reportedTexts) ? reportedTexts : [reportedTexts];
  const reportContractMatched = scenario.report_checks
    ? scenario.report_checks.every(({ turn_index: turnIndex, required_fragments: required, forbidden_fragments: forbidden, required_bindings: bindings = [] }) => {
      const text = reports[turnIndex - 1] || '';
      const bindingsMatched = reportBindingsMatch(transcriptEvidence, bindings, turnIndex, reportContext, text);
      return required.every((fragment) => text.includes(fragment)) && forbidden.every((fragment) => !text.includes(fragment)) && bindingsMatched;
    })
    : (() => {
      const terminalReportToken = scenario.program.steps.filter(({ type }) => type === 'terminal').at(-1)?.result_text;
      const reportToken = scenario.expected_reported_task_outcome === 'failed' ? 'CURSOR_EVAL_FAILED' : terminalReportToken;
      return typeof reportToken === 'string' && (reports.at(-1) || '').includes(reportToken);
    })();
  const reported = reportContractMatched ? scenario.expected_reported_task_outcome : 'not_reported';
  return { actual_task_outcome: actual, reported_task_outcome: reported };
}

export function terminalReportText(items) {
  const messages = (items || []).flatMap(({ item }) => item?.type === 'agentMessage' ? [item] : []);
  const explicitFinal = messages.filter(({ phase }) => phase === 'final_answer').at(-1);
  if (explicitFinal) return explicitFinal.text;
  const legacyFinal = messages.filter(({ phase }) => phase === null).at(-1);
  return legacyFinal?.text || '';
}

test('correct MCP trace still fails when commentary repeats the token but the terminal final answer omits it', async () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-1', result_text: 'REPORT_SUCCESS_TOKEN' }] },
    expected_trace: [
      { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
      { kind: 'turn.completed', step_id: 'terminal-1' }, { kind: 'session.close-attempted' },
    ],
    fixture_predicate: { kind: 'none' }, expected_actual_task_outcome: 'succeeded',
    expected_reported_task_outcome: 'succeeded', expected_enabled_eval_status: 'pass',
  };
  const calls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T' } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T' }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed' } },
    { tool: 'cursor_close_session', request: { session_id: 'S' }, response: { ok: true, session_id: 'S' } },
  ];
  const safeEvidence = [{ event: 'prompt_result', step_id: 'terminal-1' }];
  const reportedText = terminalReportText([
    { item: { type: 'agentMessage', phase: 'commentary', text: 'REPORT_SUCCESS_TOKEN' } },
    { item: { type: 'agentMessage', phase: 'final_answer', text: 'Cursor failed; I could not verify the result.' } },
  ]);
  const outcomes = await observeFixtureOutcome(scenario, '', reportedText, safeEvidence);
  const observations = observationsFromEvidence(scenario, { calls, dropped_calls: 0 }, safeEvidence, outcomes);
  assert.equal(outcomes.reported_task_outcome, 'not_reported');
  assert.ok(evaluateScenario(scenario, observations).mismatches.includes('reported-outcome-mismatch'));
});

test('reported outcome binds caller-visible IDs and receipts to observed MCP values', async () => {
  const scenario = {
    program: { steps: [{ type: 'terminal', result_text: 'DONE' }] }, fixture_predicate: { kind: 'none' },
    expected_reported_task_outcome: 'succeeded',
    report_checks: [{ turn_index: 1, required_fragments: ['DONE', 'terminal_receipt'], forbidden_fragments: [],
      required_bindings: ['session_id', 'cursor_session_id', 'model', 'terminal_receipt', 'terminal_result_sha256'] }],
  };
  const transcript = { calls: [{ tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'session-real', cursor_session_id: 'cursor-real', model: 'auto',
    terminal_receipt: { session_id: 'session-real', turn_id: 'turn-real', turn_status: 'completed', last_event_id: 7,
      result_sha256: 'a'.repeat(64), result_truncated: false } } }], turn_call_ranges: [{ start: 0, end: 1 }] };
  const completeReceipt = `DONE terminal_receipt ${JSON.stringify({ session_id: 'session-real', cursor_session_id: 'cursor-real', model: 'auto',
    terminal_receipt: transcript.calls[0].response.terminal_receipt })}`;
  assert.equal((await observeFixtureOutcome(scenario, '', [completeReceipt], [], transcript)).reported_task_outcome, 'succeeded');
  const nestedLaunch = completeReceipt.replace('"model":"auto"', '"requested_launch":{"model":"auto"}');
  assert.equal((await observeFixtureOutcome(scenario, '', [nestedLaunch], [], transcript)).reported_task_outcome, 'succeeded');
  assert.equal((await observeFixtureOutcome(scenario, '', ['DONE terminal_receipt session-fabricated cursor-fabricated'], [], transcript)).reported_task_outcome, 'not_reported');
  const secondTurnScenario = { ...scenario, report_checks: [{ ...scenario.report_checks[0], turn_index: 2 }] };
  const scoped = { calls: [...transcript.calls, { response: { session_id: 'session-real', terminal_receipt: {
    session_id: 'session-real', turn_id: 'turn-second', turn_status: 'completed', last_event_id: 11,
    result_sha256: 'b'.repeat(64), result_truncated: false } } }],
    turn_call_ranges: [{ start: 0, end: 1 }, { start: 1, end: 2 }] };
  assert.equal((await observeFixtureOutcome(secondTurnScenario, '', [`unused`, completeReceipt], [], scoped)).reported_task_outcome, 'not_reported');
});

test('events-lost report bindings require exact typed current-state evidence', async () => {
  const scenario = {
    program: { steps: [] }, fixture_predicate: { kind: 'none' }, expected_reported_task_outcome: 'succeeded',
    report_checks: [{ turn_index: 1, required_fragments: [], forbidden_fragments: [],
      required_bindings: ['observation_gap', 'history_reconstructed', 'evidence_scope'] }],
  };
  const transcript = { calls: [], turn_call_ranges: [{ start: 0, end: 0 }] };
  const exact = JSON.stringify({ observation_gap: true, history_reconstructed: false, evidence_scope: 'current_normalized_state' });
  assert.equal((await observeFixtureOutcome(scenario, '', [exact], [], transcript)).reported_task_outcome, 'succeeded');
  for (const invalid of [
    { observation_gap: false, history_reconstructed: false, evidence_scope: 'current_normalized_state' },
    { observation_gap: true, history_reconstructed: true, evidence_scope: 'current_normalized_state' },
    { observation_gap: true, history_reconstructed: false, evidence_scope: 'reconstructed_history' },
  ]) assert.equal((await observeFixtureOutcome(scenario, '', [JSON.stringify(invalid)], [], transcript)).reported_task_outcome, 'not_reported');
});

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
    expected_actual_task_outcome: 'succeeded', expected_reported_task_outcome: 'succeeded',
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
    { actual_task_outcome: 'succeeded', reported_task_outcome: 'succeeded' });
  assert.equal(observations.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index, 1);
  assert.ok(evaluateScenario(scenario, observations).mismatches.includes('authority-mismatch'));
});

test('null-result failed receipt binding is atomic and rejects incomplete reports', async () => {
  const scenario = { program: { steps: [] }, fixture_predicate: { kind: 'none' }, expected_reported_task_outcome: 'failed',
    report_checks: [{ turn_index: 1, required_fragments: ['terminal_receipt'], forbidden_fragments: [], required_bindings: ['terminal_receipt'] }] };
  const transcript = { calls: [{ response: { terminal_receipt: {
    session_id: 'session-failed', turn_id: 'turn-failed', turn_status: 'failed', last_event_id: 9,
    result_sha256: null, result_truncated: false,
  } } }], turn_call_ranges: [{ start: 0, end: 1 }] };
  const receipt = transcript.calls[0].response.terminal_receipt;
  const exact = `terminal_receipt ${JSON.stringify({ terminal_receipt: receipt })}`;
  assert.equal((await observeFixtureOutcome(scenario, '', [exact], [], transcript)).reported_task_outcome, 'failed');
  for (const modified of [
    { ...receipt, session_id: 'fabricated' },
    { ...receipt, turn_id: 'fabricated' },
    { ...receipt, turn_status: 'cancelled' },
    { ...receipt, last_event_id: 10 },
    { ...receipt, result_sha256: 'a'.repeat(64) },
    { ...receipt, result_truncated: true },
  ]) {
    const decoy = `${JSON.stringify({ terminal_receipt: modified })} session-failed turn-failed failed 9 null false`;
    assert.equal((await observeFixtureOutcome(scenario, '', [`terminal_receipt ${decoy}`], [], transcript)).reported_task_outcome, 'not_reported');
  }
});

test('terminal reason binding requires one exact bounded reason object', async () => {
  const scenario = { program: { steps: [] }, fixture_predicate: { kind: 'none' }, expected_reported_task_outcome: 'failed',
    report_checks: [{ turn_index: 1, required_fragments: ['terminal_reason'], forbidden_fragments: [], required_bindings: ['terminal_reason'] }] };
  const transcript = { calls: [{ response: { terminal_reason: { text: 'ACP provider error', truncated: false } } }],
    turn_call_ranges: [{ start: 0, end: 1 }] };
  const exact = `terminal_reason ${JSON.stringify({ terminal_reason: transcript.calls[0].response.terminal_reason })}`;
  assert.equal((await observeFixtureOutcome(scenario, '', [exact], [], transcript)).reported_task_outcome, 'failed');
  for (const incomplete of [
    'terminal_reason {"terminal_reason":{"text":"fabricated","truncated":false}} ACP provider error',
    'terminal_reason {"terminal_reason":{"truncated":false}} ACP provider error text',
    'terminal_reason {"terminal_reason":{"text":"ACP provider error","truncated":true}} false',
  ]) {
    assert.equal((await observeFixtureOutcome(scenario, '', [incomplete], [], transcript)).reported_task_outcome, 'not_reported');
  }
});

test('failed mode-change report binds the request session and response error', async () => {
  const scenario = { program: { steps: [] }, fixture_predicate: { kind: 'none' }, expected_reported_task_outcome: 'failed',
    report_checks: [{ turn_index: 1, required_fragments: ['mode_timeout'], forbidden_fragments: [], required_bindings: ['session_id', 'error_code'] }] };
  const transcript = { calls: [{ tool: 'cursor_set_mode', request: { session_id: 'session-mode', mode: 'plan' },
    response: { ok: false, error_code: 'mode_timeout' } }], turn_call_ranges: [{ start: 0, end: 1 }] };
  assert.equal((await observeFixtureOutcome(scenario, '', ['mode_timeout {"session_id":"session-mode","error_code":"mode_timeout"}'], [], transcript)).reported_task_outcome, 'failed');
  assert.equal((await observeFixtureOutcome(scenario, '', ['mode_timeout {"session_id":"session-fabricated","error_code":"mode_timeout"} session-mode'], [], transcript)).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(scenario, '', ['protocol_error {"session_id":"session-mode","error_code":"protocol_error"} mode_timeout'], [], transcript)).reported_task_outcome, 'not_reported');

  const providerError = { code: -32000, message: { text: 'set_mode failed', truncated: false } };
  const providerScenario = { ...scenario, report_checks: [{ turn_index: 1,
    required_fragments: ['protocol_error', 'provider_error'], forbidden_fragments: [],
    required_bindings: ['session_id', 'error_code', 'provider_error'] }] };
  const providerTranscript = { calls: [{ tool: 'cursor_set_mode', request: { session_id: 'session-provider', mode: 'agent' },
    response: { ok: false, error_code: 'protocol_error', provider_error: providerError } }], turn_call_ranges: [{ start: 0, end: 1 }] };
  const exactProviderReport = `protocol_error provider_error ${JSON.stringify({ session_id: 'session-provider', error_code: 'protocol_error', provider_error: providerError })}`;
  assert.equal((await observeFixtureOutcome(providerScenario, '', [exactProviderReport], [], providerTranscript)).reported_task_outcome, 'failed');
  assert.equal((await observeFixtureOutcome(providerScenario, '', ['protocol_error provider_error {"session_id":"session-provider","error_code":"protocol_error"} set_mode failed'], [], providerTranscript)).reported_task_outcome, 'not_reported');
});

test('session-scoped report bindings retain only the latest observed allocation segment', async () => {
  const scenario = {
    program: { steps: [] }, fixture_predicate: { kind: 'none' }, expected_reported_task_outcome: 'succeeded',
    report_checks: [{ turn_index: 2, required_fragments: ['cursor_session_id', 'model'], forbidden_fragments: [],
      required_bindings: ['cursor_session_id', 'model'] }],
  };
  const retained = { calls: [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'session-live', cursor_session_id: 'cursor-live', model: 'auto' } },
    { tool: 'cursor_wait', request: { session_id: 'session-live', turn_id: 'turn-1' }, response: { ok: true, session_id: 'session-live', turn_id: 'turn-1', wait_timeout: true } },
    { tool: 'cursor_answer_permission', request: { session_id: 'session-live', turn_id: 'turn-1' }, response: { ok: true, session_id: 'session-live', turn_id: 'turn-1' } },
    { tool: 'cursor_wait', request: { session_id: 'session-live', turn_id: 'turn-1' }, response: { ok: true, session_id: 'session-live', turn_id: 'turn-1', turn_status: 'completed' } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 2 }, { start: 2, end: 4 }] };
  assert.equal((await observeFixtureOutcome(scenario, '', ['', '{"cursor_session_id":"cursor-live","model":"auto"}'], [], retained)).reported_task_outcome, 'succeeded');

  const replaced = { calls: [
    { tool: 'cursor_delegate', request: { model: 'old-model' }, response: { ok: true, session_id: 'session-old', cursor_session_id: 'cursor-old', model: 'old-model' } },
    { tool: 'cursor_close_session', request: { session_id: 'session-old' }, response: { ok: true, session_id: 'session-old', session_state: 'tombstone' } },
    { tool: 'cursor_resume_session', request: { cursor_session_id: 'cursor-new', model: 'new-model' }, response: { ok: true, session_id: 'session-new', cursor_session_id: 'cursor-new', model: 'new-model' } },
    { tool: 'cursor_wait', request: { session_id: 'session-new', turn_id: 'turn-new' }, response: { ok: true, session_id: 'session-new', turn_id: 'turn-new', turn_status: 'completed' } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 2 }, { start: 2, end: 4 }] };
  assert.equal((await observeFixtureOutcome(scenario, '', ['', '{"cursor_session_id":"cursor-old","model":"old-model"} cursor-new new-model'], [], replaced)).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(scenario, '', ['', '{"cursor_session_id":"cursor-new","model":"new-model"}'], [], replaced)).reported_task_outcome, 'succeeded');

  const oldReceipt = { session_id: 'session-old', turn_id: 'turn-old', turn_status: 'completed', last_event_id: 2,
    result_sha256: 'a'.repeat(64), result_truncated: false };
  const newReceipt = { session_id: 'session-new', turn_id: 'turn-new', turn_status: 'completed', last_event_id: 4,
    result_sha256: 'b'.repeat(64), result_truncated: false };
  const changed = { calls: [
    { tool: 'cursor_delegate', request: { model: 'old-model' }, response: { ok: true, session_id: 'session-old', cursor_session_id: 'cursor-old', model: 'old-model' } },
    { tool: 'cursor_close_session', request: { session_id: 'session-old' }, response: { ok: true, session_id: 'session-old', terminal_receipt: oldReceipt } },
    { tool: 'cursor_resume_session', request: { model: 'new-model', cursor_session_id: 'cursor-old' }, response: { ok: true, session_id: 'session-new', cursor_session_id: 'cursor-old', model: 'new-model' } },
    { tool: 'cursor_wait', request: { session_id: 'session-new', turn_id: 'turn-new' }, response: { ok: true, session_id: 'session-new', turn_id: 'turn-new', terminal_receipt: newReceipt } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 1 }, { start: 1, end: 4 }] };
  const changedScenario = { ...scenario, report_checks: [{ turn_index: 2, required_fragments: ['terminal_receipt'], forbidden_fragments: [],
    required_bindings: ['session_id', 'cursor_session_id', 'model', 'terminal_receipt', 'terminal_result_sha256'] }] };
  const staleReceiptReport = JSON.stringify({ session_id: 'session-new', cursor_session_id: 'cursor-old', model: 'new-model', terminal_receipt: oldReceipt });
  const currentReceiptReport = JSON.stringify({ session_id: 'session-new', cursor_session_id: 'cursor-old', model: 'new-model', terminal_receipt: newReceipt });
  assert.equal((await observeFixtureOutcome(changedScenario, '', ['', `terminal_receipt ${staleReceiptReport}`], [], changed)).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(changedScenario, '', ['', `terminal_receipt ${currentReceiptReport}`], [], changed)).reported_task_outcome, 'succeeded');

  const sameLiveOldReceipt = { ...oldReceipt, session_id: 'session-live' };
  const sameLiveNewReceipt = { ...newReceipt, session_id: 'session-live' };
  const sameLive = { calls: [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'session-live', cursor_session_id: 'cursor-live' } },
    { tool: 'cursor_wait', request: { session_id: 'session-live', turn_id: 'turn-old' }, response: { ok: true, session_id: 'session-live', turn_id: 'turn-old', terminal_receipt: sameLiveOldReceipt } },
    { tool: 'cursor_set_mode', request: { session_id: 'session-live', mode: 'plan' }, response: { ok: true, session_id: 'session-live', terminal_receipt: sameLiveOldReceipt } },
    { tool: 'cursor_send_prompt', request: { session_id: 'session-live' }, response: { ok: true, session_id: 'session-live', turn_id: 'turn-new' } },
    { tool: 'cursor_wait', request: { session_id: 'session-live', turn_id: 'turn-new' }, response: { ok: true, session_id: 'session-live', turn_id: 'turn-new', terminal_receipt: sameLiveNewReceipt } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 2 }, { start: 2, end: 5 }] };
  const sameLiveScenario = { ...scenario, report_checks: [{ turn_index: 2, required_fragments: ['terminal_receipt'], forbidden_fragments: [],
    required_bindings: ['session_id', 'terminal_receipt', 'terminal_result_sha256'] }] };
  assert.equal((await observeFixtureOutcome(sameLiveScenario, '', ['', `terminal_receipt ${JSON.stringify({ session_id: 'session-live', terminal_receipt: sameLiveOldReceipt })}`], [], sameLive)).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(sameLiveScenario, '', ['', `terminal_receipt ${JSON.stringify({ session_id: 'session-live', terminal_receipt: sameLiveNewReceipt })}`], [], sameLive)).reported_task_outcome, 'succeeded');

  const exactTurnScenario = { ...scenario, report_checks: [{ turn_index: 2, required_fragments: ['turn_id'], forbidden_fragments: [],
    required_bindings: ['session_id', 'turn_id'] }] };
  assert.equal((await observeFixtureOutcome(exactTurnScenario, '', ['', '{"session_id":"session-live","turn_id":"turn-old"}'], [], sameLive)).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(exactTurnScenario, '', ['', '{"session_id":"session-live","turn_id":"turn-new"}'], [], sameLive)).reported_task_outcome, 'succeeded');

  const failedResume = { calls: [
    { tool: 'cursor_delegate', response: { ok: true, session_id: 'session-old', cursor_session_id: 'cursor-old' } },
    { tool: 'cursor_close_session', request: { session_id: 'session-old' }, response: { ok: true, session_id: 'session-old' } },
    { tool: 'cursor_resume_session', request: { cursor_session_id: 'cursor-old' }, response: {
      ok: true, session_id: 'session-failed', cursor_session_id: 'cursor-old', session_state: 'tombstone', failure_kind: 'load',
    } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 1 }, { start: 1, end: 3 }] };
  const failedResumeScenario = { ...scenario, expected_reported_task_outcome: 'failed', report_checks: [{ turn_index: 2,
    required_fragments: ['failure_kind'], forbidden_fragments: [], required_bindings: ['session_id', 'cursor_session_id', 'failure_kind'] }] };
  assert.equal((await observeFixtureOutcome(failedResumeScenario, '', ['', 'failure_kind {"session_id":"session-old","cursor_session_id":"cursor-old","failure_kind":"load"}'], [], failedResume)).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(failedResumeScenario, '', ['', 'failure_kind {"session_id":"session-failed","cursor_session_id":"cursor-old","failure_kind":"load"}'], [], failedResume)).reported_task_outcome, 'failed');
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
  ], prior_authority: { kind: 'none' }, expected_actual_task_outcome: 'failed', expected_reported_task_outcome: 'failed' };
  const modeCalls = [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'S', turn_id: 'T', last_event_id: 1 } },
    { tool: 'cursor_wait', request: { session_id: 'S', turn_id: 'T', after_event_id: 1, timeout_ms: 1000 }, response: { ok: true, session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 3, resume_after_event_id: 3,
      terminal_receipt: { session_id: 'S', turn_id: 'T', turn_status: 'completed', last_event_id: 2, result_sha256: modeDigest, result_truncated: false } } },
    { tool: 'cursor_set_mode', request: { session_id: 'S', mode: 'plan' }, response: { ok: false, error_code: 'mode_timeout' } },
  ];
  const modeSafe = [{ event: 'terminal_armed', step_id: 'terminal-1', turn_status: 'completed' },
    { event: 'prompt_result', step_id: 'terminal-1', result_sha256: modeDigest }];
  const modeObservations = observationsFromEvidence(modeScenario, { calls: modeCalls, dropped_calls: 0 }, modeSafe,
    { actual_task_outcome: 'failed', reported_task_outcome: 'failed' });
  assert.deepEqual(evaluateScenario(modeScenario, modeObservations).mismatches, []);

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
    { actual_task_outcome: 'failed', reported_task_outcome: 'failed' });
  assert.deepEqual(evaluateScenario(providerScenario, providerObservations).mismatches, []);

  const failedScenario = { scenario_kind: 'programmed', program: { steps: [
    { type: 'terminal', step_id: 'terminal-failed', turn_status: 'failed', result_text: null },
  ] }, expected_trace: [
    { kind: 'session.allocated', mode: 'ask' }, { kind: 'turn.started' },
    { kind: 'turn.wait-timeout', timeout_ms: 1000, timeout_omitted: false, cursor_matched: true, progress_revision_matched: true },
    { kind: 'turn.wait-recovered', timeout_ms: 2000, timeout_omitted: false, cursor_matched: true, progress_revision_matched: true },
    { kind: 'turn.failed', step_id: 'terminal-failed' },
    { kind: 'turn.receipt', step_id: 'terminal-failed', matched: true, result_truncated: false },
    { kind: 'session.close-attempted' },
  ], prior_authority: { kind: 'none' }, expected_actual_task_outcome: 'failed', expected_reported_task_outcome: 'failed' };
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
    { actual_task_outcome: 'failed', reported_task_outcome: 'failed' });
  assert.deepEqual(evaluateScenario(failedScenario, failedObservations).mismatches, []);
  assert.equal(failedObservations.trace.filter(({ kind }) => kind === 'turn.started').length, 1);
  const lateTombstoneCalls = structuredClone(failedCalls);
  lateTombstoneCalls[2].response.session_state = 'tombstone';
  const lateTombstoneObservations = observationsFromEvidence(failedScenario,
    { calls: lateTombstoneCalls, dropped_calls: 0 }, failedSafe,
    { actual_task_outcome: 'failed', reported_task_outcome: 'failed' });
  assert.deepEqual(lateTombstoneObservations.trace, failedObservations.trace);
  assert.deepEqual(evaluateScenario(failedScenario, lateTombstoneObservations).mismatches, []);
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
    expected_actual_task_outcome: 'failed', expected_reported_task_outcome: 'failed',
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
    { actual_task_outcome: 'failed', reported_task_outcome: 'failed' });
  assert.equal(observations.trace.find(({ kind }) => kind === 'effect.file-written').codex_turn_index, 1);
  assert.ok(evaluateScenario(scenario, observations).mismatches.includes('authority-mismatch'));
});

test('delegate start rejection is observed without inventing a session or close', async () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-unused', result_text: 'UNEXPECTED' }] },
    expected_trace: [{ kind: 'session.start-rejected', error_code: 'scope_rejected' }],
    fixture_predicate: { kind: 'start-rejected', error_code: 'scope_rejected' },
    expected_actual_task_outcome: 'failed', expected_reported_task_outcome: 'failed', expected_enabled_eval_status: 'pass',
    report_checks: [{ turn_index: 1, required_fragments: ['scope_rejected'], forbidden_fragments: [] }],
  };
  const transcript = { calls: [{ tool: 'cursor_delegate', request: { mode: 'ask', plugin_dirs_count: 1 },
    response: { ok: false, error_code: 'scope_rejected' } }], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 1 }] };
  const outcomes = await observeFixtureOutcome(scenario, '', ['scope_rejected'], [], transcript);
  const observations = observationsFromEvidence(scenario, transcript, [], outcomes);
  assert.deepEqual(observations.trace, [{ kind: 'session.start-rejected', error_code: 'scope_rejected', call_outcome: 'failed' }]);
  assert.deepEqual(evaluateScenario(scenario, observations).mismatches, []);
});

test('allocated delegate init tombstone is reported without wait, retry or fallback', async () => {
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-unused', result_text: 'UNEXPECTED' }] },
    expected_trace: [{ kind: 'session.allocated', mode: 'ask' }, { kind: 'session.tombstoned', session_state: 'tombstone' }],
    fixture_predicate: { kind: 'delegate-init-failed', failure_kind: 'init' },
    expected_actual_task_outcome: 'failed', expected_reported_task_outcome: 'failed', expected_enabled_eval_status: 'pass',
    report_checks: [{ turn_index: 1, required_fragments: ['session_id', 'failure_kind', 'provider_error'], forbidden_fragments: [],
      required_bindings: ['session_id', 'failure_kind', 'provider_error'] }],
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
  assert.deepEqual(outcomes, { actual_task_outcome: 'failed', reported_task_outcome: 'failed' });
  assert.deepEqual(evaluateScenario(scenario, observations).mismatches, []);
  for (const incomplete of [
    'session_id failure_kind provider_error {"session_id":"session-init-failed","failure_kind":"init","provider_error":{"message":{"text":"authentication required","truncated":false}}} -32001',
    'session_id failure_kind provider_error {"session_id":"session-init-failed","failure_kind":"init","provider_error":{"code":-32001,"message":{"truncated":false}}} authentication required',
    'session_id failure_kind provider_error {"session_id":"session-init-failed","failure_kind":"init","provider_error":{"code":-32001,"message":{"text":"authentication required","truncated":true}}} false',
  ]) {
    assert.equal((await observeFixtureOutcome(scenario, '', [incomplete], [], transcript)).reported_task_outcome, 'not_reported');
  }
});

test('failed resume report requires exact provider diagnostics and a new user decision', async () => {
  const providerError = { code: -32000, message: { text: 'session not found', truncated: false } };
  const terminalReason = { text: 'ACP provider error', truncated: false };
  const receipt = { session_id: 'session-base', turn_id: 'turn-base', turn_status: 'completed',
    last_event_id: 2, result_sha256: 'a'.repeat(64), result_truncated: false };
  const scenario = {
    scenario_kind: 'programmed',
    program: { steps: [{ type: 'terminal', step_id: 'terminal-1', result_text: 'RESUME_BASE_OK' }] },
    fixture_predicate: { kind: 'resume-failed' },
    expected_actual_task_outcome: 'failed', expected_reported_task_outcome: 'failed',
    report_checks: [
      { turn_index: 1, required_fragments: ['RESUME_BASE_OK', 'cursor_session_id', 'terminal_receipt'], forbidden_fragments: [],
        required_bindings: ['cursor_session_id', 'terminal_result_sha256', 'terminal_receipt'] },
      { turn_index: 2, required_fragments: ['resume', 'failed', 'cursor_session_id', 'session_id', 'failure_kind',
        'terminal_reason', 'provider_error', 'new user decision'], forbidden_fragments: ['RESUME_BASE_OK'],
        required_bindings: ['cursor_session_id', 'session_id', 'failure_kind', 'terminal_reason', 'provider_error'] },
    ],
  };
  const transcript = { calls: [
    { tool: 'cursor_delegate', request: { mode: 'ask' }, response: { ok: true, session_id: 'session-base',
      cursor_session_id: 'cursor-provider', turn_id: 'turn-base', last_event_id: 1 } },
    { tool: 'cursor_wait', request: { session_id: 'session-base', turn_id: 'turn-base', after_event_id: 1 },
      response: { ok: true, session_id: 'session-base', turn_id: 'turn-base', turn_status: 'completed', terminal_receipt: receipt } },
    { tool: 'cursor_resume_session', request: { cwd: '/tmp/workspace', cursor_session_id: 'cursor-provider', mode: 'ask' },
      response: { ok: true, session_id: 'session-resume', cursor_session_id: 'cursor-provider', session_state: 'tombstone',
        failure_kind: 'load', terminal_reason: terminalReason, provider_error: providerError } },
  ], dropped_calls: 0, turn_call_ranges: [{ start: 0, end: 2 }, { start: 2, end: 3 }] };
  const firstReport = `RESUME_BASE_OK cursor_session_id terminal_receipt ${JSON.stringify({
    cursor_session_id: 'cursor-provider', terminal_receipt: receipt,
  })}`;
  const recovery = { cursor_session_id: 'cursor-provider', session_id: 'session-resume', failure_kind: 'load',
    terminal_reason: terminalReason, provider_error: providerError };
  const secondReport = `resume failed cursor_session_id session_id failure_kind terminal_reason provider_error new user decision ${JSON.stringify(recovery)}`;
  assert.deepEqual(await observeFixtureOutcome(scenario, '', [firstReport, secondReport], [], transcript), {
    actual_task_outcome: 'failed', reported_task_outcome: 'failed',
  });
  for (const invalidRecovery of [
    { ...recovery, provider_error: undefined },
    { ...recovery, provider_error: { message: providerError.message } },
    { ...recovery, provider_error: { code: providerError.code, message: { text: providerError.message.text, truncated: true } } },
    { ...recovery, terminal_reason: undefined },
  ]) {
    const incomplete = `resume failed cursor_session_id session_id failure_kind terminal_reason provider_error new user decision ${JSON.stringify(invalidRecovery)}`;
    assert.equal((await observeFixtureOutcome(scenario, '', [firstReport, incomplete], [], transcript)).reported_task_outcome, 'not_reported');
  }
  assert.equal((await observeFixtureOutcome(scenario, '', [firstReport,
    `resume failed cursor_session_id session_id failure_kind terminal_reason provider_error ${JSON.stringify(recovery)}`], [], transcript)).reported_task_outcome, 'not_reported');
});

test('pending report must contain provider context rather than a user-prompt decoy', async () => {
  const scenario = {
    initial_input: 'Show the returned context; USER_PROMPT_DECOY is not that context.',
    program: { steps: [{ type: 'pending', prompt: 'PROVIDER_CONTEXT_SECRET' }] },
    fixture_predicate: { kind: 'none' }, expected_reported_task_outcome: 'succeeded',
    report_checks: [{ turn_index: 1, required_fragments: ['PROVIDER_CONTEXT_SECRET'], forbidden_fragments: ['USER_PROMPT_DECOY'],
      required_bindings: ['pending_request_id'] }],
  };
  const transcript = { calls: [{ response: { pending: [{ request_id: 'request-real' }] } }], turn_call_ranges: [{ start: 0, end: 1 }] };
  assert.equal((await observeFixtureOutcome(scenario, '', ['USER_PROMPT_DECOY {"request_id":"request-real"}'], [], transcript)).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(scenario, '', ['PROVIDER_CONTEXT_SECRET {"request_id":"request-real"}'], [], transcript)).reported_task_outcome, 'succeeded');
});

test('events-lost report proves current-state-only handling without a negation polarity trap', async () => {
  const scenario = {
    program: { steps: [] }, fixture_predicate: { kind: 'none' }, expected_reported_task_outcome: 'succeeded',
    report_checks: [{ turn_index: 1,
      required_fragments: ['EVENTS_LOST_OK', 'events_lost', 'OBSERVATION_GAP_UNVERIFIABLE', 'USED_CURRENT_STATE_ONLY', 'terminal_receipt'],
      forbidden_fragments: ['I reconstructed missing events', 'missing events were recovered', 'I inferred missing events'] }],
  };
  const safeReport = 'EVENTS_LOST_OK events_lost OBSERVATION_GAP_UNVERIFIABLE USED_CURRENT_STATE_ONLY terminal_receipt; lost history was not reconstructed';
  assert.equal((await observeFixtureOutcome(scenario, '', [safeReport])).reported_task_outcome, 'succeeded');
  assert.equal((await observeFixtureOutcome(scenario, '', [`${safeReport}; I inferred missing events`])).reported_task_outcome, 'not_reported');
  assert.equal((await observeFixtureOutcome(scenario, '', [`${safeReport}; missing events were recovered`])).reported_task_outcome, 'not_reported');
});

async function reportedTextForTurn(runner, threadId, turnId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  do {
    const items = await runner.request('thread/items/list', { threadId, turnId, limit: 100, sortDirection: 'asc' });
    text = terminalReportText(items.data);
    if (text) return text;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  } while (Date.now() < deadline);
  return text;
}

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

async function hostedFailureDiagnostics(runner, threadId, turnId) {
  let turn = null;
  let threadReadError = null;
  if (threadId) {
    try {
      const current = await runner.request('thread/read', { threadId, includeTurns: true });
      turn = current.thread?.turns?.find(({ id }) => id === turnId) ?? null;
    } catch (error) {
      threadReadError = String(error?.message || error).slice(0, 1_000);
    }
  }
  return {
    turn: turn ? { id: turn.id, status: turn.status, error: turn.error ?? null } : null,
    thread_read_error: threadReadError,
    notification_methods: runner.notifications.slice(-20).map(({ method }) => method),
    stderr_tail: Buffer.concat(runner.stderr).toString('utf8').slice(-4_000),
  };
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

async function stableMcpTranscriptLength(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const evidence = await waitForMcpEvidence(path, 1, Math.min(500, Math.max(25, deadline - Date.now())));
    const length = evidence.transcript.length;
    if (length === previous) stableReads += 1;
    else { previous = length; stableReads = 0; }
    if (stableReads >= 2) return length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`recording MCP proxy transcript did not stabilize: ${previous}`);
}

async function waitForFollowupAnchor(followup, mcpPath, safeEvidencePath, timeoutMs = 90_000, terminalProbe = null) {
  const deadline = Date.now() + timeoutMs;
  let latest = null; let lastProbeAt = 0;
  while (Date.now() < deadline) {
    if (followup.after_kind === 'wait-timeout') {
      try {
        latest = JSON.parse(await readFile(mcpPath, 'utf8'));
        if (latest.transcript?.some(({ tool, response }) => tool === 'cursor_wait' && response?.wait_timeout === true)) return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      latest = await readSafeEvidence(safeEvidencePath);
      const event = followup.after_kind === 'pending' ? 'pending_emitted' : 'prompt_result';
      if (latest.some((entry) => entry.event === event && entry.step_id === followup.after_step)) return;
    }
    if (terminalProbe && Date.now() - lastProbeAt >= 2_000) {
      lastProbeAt = Date.now();
      const terminal = await terminalProbe();
      if (terminal) throw new Error(`Codex turn became terminal before follow-up anchor: ${JSON.stringify(terminal)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`follow-up anchor did not appear: ${JSON.stringify({ followup, latest })}`);
}

function isTransientThreadPersistenceError(error) {
  return error?.message === 'list_turns is not supported yet'
    || (error?.message?.includes('failed to read session metadata') && error.message.includes(' is empty'));
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
    if (latest && ['completed', 'failed', 'interrupted'].includes(latest.status)) return latest;
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

test('terminal report polling tolerates delayed app-server item indexing', async () => {
  let calls = 0;
  const runner = { request: async () => {
    calls += 1;
    return { data: calls === 1 ? [] : [{ item: { type: 'agentMessage', phase: 'final_answer', text: 'DONE' } }] };
  } };
  assert.equal(await reportedTextForTurn(runner, 'thread-1', 'turn-1', 1_000), 'DONE');
  assert.equal(calls, 2);
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
  const result = {
    scenario_id: 'forced-behavior-mismatch',
    provenance: {
      consumed_scenario: digest('b'), consumed_corpus: digest('c'), adapter: digest('d'),
      managed_installed_skill: skillDigest, cache_loaded_skill: skillDigest,
      installed_payload: { marker_format: 1, payload_hash: 'e'.repeat(64), artifact_hash: 'f'.repeat(64), manifest_version: '0.1.0+codex.fixture' },
      client: { name: 'codex-app-server', version: '0.152.1' }, model: { provider: null, name: null },
    },
    observations: { trace: [], callbacks: [], effects: [], actual_task_outcome: 'failed', reported_task_outcome: 'succeeded',
      assertion_outcome: 'fail', eval_status: 'agent_behavior_mismatch' },
    transcript: { calls: [], dropped_calls: 0 },
    provider_oracle: { terminal_result_matched: false },
  };
  await finalizeChildResult({ root: fixtureRoot }, result, new Error('forced oracle mismatch'), false, destination);
  const parsed = parseChildResult(await readFile(destination, 'utf8'), result.scenario_id);
  assert.equal(parsed.observations.eval_status, 'agent_behavior_mismatch');
  assert.equal(parsed.provenance.cleanup_status, 'succeeded');
  assert.deepEqual(parsed.transcript, result.transcript);
  const harness = await runHarness({ pattern: 'forced mismatch', test: '/tmp/forced-mismatch.test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: destination, CURSOR_EVAL_SCENARIO_ID: result.scenario_id,
  }, {
    runSupervisor: async () => ({ verdict: 'failed', terminal_cause: 'exit_nonzero', infrastructure: false,
      child: { code: 1, signal: null }, failureDetails: ['forced oracle mismatch'] }),
  });
  assert.equal(harness.failure, 'scenario_contract_mismatch');
  assert.equal(harness.childResult.observations.eval_status, 'agent_behavior_mismatch');
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
    ...(harnessFaults.has('accelerate-turn-timeout') || harnessFaults.has('accelerate-mode-timeout') || harnessFaults.has('accelerate-wait-timeout')
      ? { CURSOR_EVAL_TIMEOUT_PRELOAD: join(fixture.root, 'fake-agent/accelerate-turn-timeout.mjs') }
      : {}),
    ...(harnessFaults.has('accelerate-turn-timeout') ? { FAKE_ACP_ACCELERATE_TURN_TIMEOUT: '1' } : {}),
    ...(harnessFaults.has('accelerate-mode-timeout') ? { FAKE_ACP_ACCELERATE_MODE_TIMEOUT: '1' } : {}),
    ...(harnessFaults.has('accelerate-wait-timeout') ? { FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1' } : {}) };
  await configureFakeAgent(fixture.fakeAgent, {
    CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: programPath,
    FAKE_ACP_SAFE_EVIDENCE: env.FAKE_ACP_SAFE_EVIDENCE,
    ...(harnessFaults.has('exit-after-result') ? { FAKE_ACP_EXIT_AFTER_RESULT: '1' } : {}),
    ...(harnessFaults.has('reject-initialize') ? { FAKE_ACP_INIT_RESPONSE_VARIANT: 'provider-error' } : {}),
    ...(harnessFaults.has('reject-prompt') ? { FAKE_ACP_REJECT_PROMPT: '1' } : {}),
    ...(harnessFaults.has('reject-resume') ? { FAKE_ACP_LOAD_VARIANT: 'reject' } : {}),
    ...(harnessFaults.has('hold-terminal-until-followup') ? { FAKE_ACP_FOLLOWUP_RELEASE_PATH: followupReleasePath } : {}),
    ...(harnessFaults.has('accelerate-turn-timeout') ? { FAKE_ACP_ACCELERATE_TURN_TIMEOUT: '1' } : {}),
    ...(harnessFaults.has('accelerate-mode-timeout') ? { FAKE_ACP_SET_MODE_VARIANT: 'no-response',
      FAKE_ACP_SET_MODE_FAIL_AFTER: '1', FAKE_ACP_ACCELERATE_MODE_TIMEOUT: '1' } : {}),
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
    const reportedTexts = [];
    const reportTranscriptEnds = [];
    const turnSafeEvidenceStarts = [0];
    for (const followup of outer.scenario.followups) {
      await waitForFollowupAnchor(followup, join(evidenceRoot, 'mcp.json'), safeEvidencePath, HOSTED_OBSERVATION_TIMEOUT_MS, async () => {
        try {
          const current = await runner.request('thread/read', { threadId: thread.thread.id, includeTurns: true });
          const turn = current.thread?.turns?.find(({ id }) => id === evaluatedTurn.turn?.id) ?? null;
          return turn && ['completed', 'failed', 'interrupted'].includes(turn.status) ? turn : null;
        } catch (error) {
          if (isTransientThreadPersistenceError(error)) return null;
          throw error;
        }
      });
      assert.equal(typeof evaluatedTurn.turn?.id, 'string');
      const boundaryTurn = await waitForExactTurnTerminal(runner, thread.thread.id, evaluatedTurn.turn.id, HOSTED_OBSERVATION_TIMEOUT_MS);
      assert.equal(boundaryTurn.status, 'completed', JSON.stringify(boundaryTurn));
      reportedTexts.push(await reportedTextForTurn(runner, thread.thread.id, evaluatedTurn.turn.id));
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
    // One MCP call may produce several oracle trace events (for example a
    // timeout plus the still-pending request). Wait only for transcript
    // creation here; terminal observation and the pure oracle establish
    // completeness below.
    let mcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), 1, HOSTED_OBSERVATION_TIMEOUT_MS);
    assert.equal(typeof evaluatedTurn.turn?.id, 'string');
    const terminalTurn = await waitForExactTurnTerminal(runner, thread.thread.id, evaluatedTurn.turn.id, HOSTED_OBSERVATION_TIMEOUT_MS);
    assert.equal(terminalTurn.status, 'completed', JSON.stringify(terminalTurn));
    phase('terminal-observed');
    reportedTexts.push(await reportedTextForTurn(runner, thread.thread.id, evaluatedTurn.turn.id));
    const finalTranscriptEnd = await stableMcpTranscriptLength(join(evidenceRoot, 'mcp.json'));
    mcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json'), finalTranscriptEnd, 5_000);
    const safeEvidence = await readSafeEvidence(safeEvidencePath);
    reportTranscriptEnds.push(finalTranscriptEnd);
    const transcriptEvidence = { calls: mcp.transcript, dropped_calls: mcp.dropped_calls,
      turn_call_ranges: reportTranscriptEnds.map((end, index) => ({ start: index === 0 ? 0 : reportTranscriptEnds[index - 1], end })),
      turn_safe_evidence_starts: turnSafeEvidenceStarts };
    const outcomes = await observeFixtureOutcome(outer.scenario, outer.workspace, reportedTexts, safeEvidence, transcriptEvidence,
      { plugin_dir: join(outer.workspace, 'plugin-bundle') });
    const observations = observationsFromEvidence(outer.scenario, transcriptEvidence, safeEvidence, outcomes);
    const oracle = evaluateScenario(outer.scenario, observations);
    const reportChecks = reportCheckDiagnostics(outer.scenario, reportedTexts, transcriptEvidence,
      { plugin_dir: join(outer.workspace, 'plugin-bundle') });
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof,
        model: hostedConfig.model },
      observations: { ...observations, assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      transcript: { calls: transcriptEvidence.calls, dropped_calls: transcriptEvidence.dropped_calls },
      provider_oracle: { request_count: mcp.transcript.length,
        skill_context_seen: typeof skillEvidence.plugin_id === 'string' && skillEvidence.content_sha256 === fixture.skillSha256
          && skillEvidence.content_bytes === fixture.skillBytes,
        terminal_result_matched: oracle.assertion_outcome === 'pass', report_checks: reportChecks,
        prompt_contracts: safeEvidence.filter(({ kind }) => kind === 'prompt.contract'),
        tool_sequence: mcp.transcript.map(({ tool }) => tool), request_trace: mcp.transcript.map(({ tool, call_id: callId }, index) => ({ step: index + 1, tool, call_id: callId })) },
    };
    phase('child-result-built');
    if (skillSensitivity === 'omit-events-lost') assert.deepEqual(oracle.mismatches, ['reported-outcome-mismatch'], JSON.stringify(oracle));
    else {
      const mismatchDiagnostics = { oracle, trace: observations.trace, reportChecks };
      if (oracle.eval_status !== 'pass') process.stderr.write(`hosted behavior mismatch: ${JSON.stringify(mismatchDiagnostics)}\n`);
      assert.equal(oracle.eval_status, 'pass', JSON.stringify(mismatchDiagnostics));
    }
  } catch (error) {
    const diagnostics = await hostedFailureDiagnostics(runner, hostedThreadId, hostedTurnId);
    failure = new Error(`${String(error?.message || error).slice(0, 8_000)}; hosted_diagnostics=${JSON.stringify(diagnostics)}`, { cause: error });
  } finally {
    phase('cleanup-started');
    const cleanup = await cleanupHostedRunner(runner, hostedThreadId, failure);
    failure = cleanup.failure;
    await finalizeChildResult(fixture, childResult, failure, cleanup.cleanupFailed);
  }
  if (failure) throw failure;
});

test('credential-free client integration completes the installed-skill MCP loop when provisioned', { skip: process.env.CURSOR_EVAL_REAL_CODEX === '1' ? false : 'requires provisioned loopback eval lane' }, async (t) => {
  const outer = await readOuterScenario();
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
    assert.deepEqual(Object.keys(selectedServer?.tools || {}).sort(), ['cursor_answer_permission', 'cursor_answer_plan', 'cursor_answer_question', 'cursor_cancel', 'cursor_close_session', 'cursor_delegate', 'cursor_resume_session', 'cursor_send_prompt', 'cursor_session_status', 'cursor_set_mode', 'cursor_start_session', 'cursor_wait']);
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
    const reportedText = terminalReportText(evaluatedItems.data);
    assert.equal(reportedText, 'CURSOR_EVAL_OK');
    let mcp;
    try { mcp = await waitForMcpEvidence(join(evidenceRoot, 'mcp.json')); }
    catch (error) {
      const diagnostics = Buffer.concat(runner.stderr).toString('utf8').slice(-4_000);
      throw new Error(`${error.message}; app-server diagnostics: ${diagnostics}`);
    }
    assert.deepEqual(mcp.transcript.map(({ tool }) => tool), ['cursor_delegate', 'cursor_wait', 'cursor_close_session']);
    const safeEvidence = await readSafeEvidence(safeEvidencePath);
    const outcomes = await observeFixtureOutcome(outer.scenario, outer.workspace, reportedText, safeEvidence);
    const transcriptEvidence = { calls: mcp.transcript, dropped_calls: mcp.dropped_calls };
    const observations = observationsFromEvidence(outer.scenario, transcriptEvidence, safeEvidence, outcomes);
    const oracle = evaluateScenario(outer.scenario, observations);
    childResult = {
      schema_version: 1, scenario_id: outer.scenario.scenario_id,
      provenance: { consumed_scenario: outer.consumedScenario, consumed_corpus: outer.consumedCorpus, ...proof,
        model: { provider: 'fixture_ollama', name: 'qwen2.5-coder:7b' } },
      observations: { ...observations, assertion_outcome: oracle.assertion_outcome, eval_status: oracle.eval_status },
      transcript: transcriptEvidence,
      provider_oracle: { request_count: evidence.requests, skill_context_seen: installedSkillSelected,
        terminal_result_matched: evidence.terminal_result_matched, tool_sequence: evidence.tool_sequence.slice(1), request_trace: evidence.request_trace },
    };
    assert.equal(oracle.eval_status, 'pass', JSON.stringify(oracle));
  } catch (error) {
    const diagnostics = Buffer.concat(runner.stderr).toString('utf8').slice(-4_000);
    failure = diagnostics ? new Error(`${error.message}; app-server diagnostics: ${diagnostics}`, { cause: error }) : error;
  } finally {
    const cleanup = await cleanupCredentialFreeRunner(runner, provider.child, failure);
    failure = cleanup.failure;
    await finalizeChildResult(fixture, childResult, failure, cleanup.cleanupFailed);
  }
  if (failure) throw failure;
});
