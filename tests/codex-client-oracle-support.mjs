import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { evaluateScenario, findRecoveredCalls, findTerminalWaitLossRecovery } from '../scripts/cursor-eval-scenario.mjs';

function observationsFromEvidence(scenario, transcriptEvidence, safeEvidence, outcomes) {
  const calls = transcriptEvidence.calls;
  const waitLossRecovery = findTerminalWaitLossRecovery(scenario, transcriptEvidence);
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
  const activeFollowupEvidence = safeEvidence.find(({ event, step_id: stepId }) => event === 'followup_received_active' && typeof stepId === 'string');
  let terminalIndex = 0;
  let terminalProgramIndex = 0;
  const trace = [];
  let sessionId;
  let turnId;
  let cursorSessionId;
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
    if (waitLossRecovery?.lost_call_index === callIndex + 1) continue;
    if (recoveredProjectionIndices.has(callIndex + 1)) {
      continue;
    }
    const codexTurnIndex = codexTurnIndexForCall(callIndex);
    const traceLengthBeforeCall = trace.length;
    let expectedFailure = false;
    let terminalAlreadyObserved = false;
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
      trace.push({ kind: 'session.resumed', matched: call.request?.cursor_session_id === cursorSessionId
        && call.response?.cursor_session_id === cursorSessionId,
      ...(call.request?.model !== undefined ? { model: call.request.model } : {}),
      ...(call.request?.effort !== undefined ? { effort: call.request.effort } : {}),
      ...(call.request?.fast !== undefined ? { fast: call.request.fast } : {}),
      session_id: sessionId, call_outcome: callOutcome });
    } else if (call.tool === 'cursor_send_prompt' && callOutcome === 'succeeded') {
      turnId = call.response?.turn_id;
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
    } else if (call.tool === 'cursor_list_models' && callOutcome === 'succeeded') {
      // Model discovery is global runtime metadata.  It neither reads nor
      // advances a delegated session, including one that was just closed.
    } else if (call.tool === 'cursor_wait') {
      const timeoutOmitted = call.request?.timeout_ms === undefined;
      const effectiveTimeoutMs = timeoutOmitted ? 30_000 : call.request.timeout_ms;
      if (call.response?.wait_timeout === true) {
        trace.push({ kind: 'turn.wait-timeout', timeout_ms: effectiveTimeoutMs, timeout_omitted: timeoutOmitted,
          ...ids, call_outcome: callOutcome });
        if (activeFollowupEvidence && !activeFollowupObserved) {
          trace.push({ kind: 'turn.followup-received-active', ...ids, call_outcome: 'succeeded' });
          activeFollowupObserved = true;
        }
        sawWaitTimeout = true;
      }
      const terminalStatus = call.response?.turn_status;
      const terminal = ['completed', 'failed', 'timed_out'].includes(terminalStatus);
      terminalAlreadyObserved = terminal && ids.turn_id && completedTurnIds.has(ids.turn_id);
      if (terminal && sawWaitTimeout) {
        trace.push({ kind: 'turn.wait-recovered', timeout_ms: effectiveTimeoutMs, timeout_omitted: timeoutOmitted,
          ...ids, call_outcome: callOutcome });
        sawWaitTimeout = false;
      }
      // A terminal wait can observe either a transient closing wrapper or its
      // tombstone. Keep terminal/receipt evidence stable across that race.
      if (call.response?.session_state === 'tombstone'
        && (!terminal || (ids.turn_id && completedTurnIds.has(ids.turn_id)))) {
        trace.push({ kind: 'session.tombstoned', session_state: call.response.session_state,
          session_id: ids.session_id, call_outcome: callOutcome });
      }
      for (const pending of call.response?.pending || []) {
        const observedCallback = callbackById.get(String(pending.request_id));
        trace.push({ kind: `pending.${pending.kind}`, step_id: observedCallback?.step_id || `unobserved:${pending.request_id}`,
          ...ids, request_id: pending.request_id, call_outcome: callOutcome });
      }
      if (terminal && ids.turn_id && !terminalAlreadyObserved) {
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
        if (waitLossRecovery?.repeated_call_index === callIndex + 1) trace.push({
          kind: 'turn.wait-response-recovered', step_id: terminalStepId, matched: true,
          ...waitLossRecovery, ...ids, call_outcome: callOutcome,
        });
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
            matched: receipt?.result_sha256 === expectedDigest
              && (waitLossRecovery?.repeated_call_index !== callIndex + 1
                || /^[a-f0-9]{64}$/.test(terminalProof?.result_sha256 ?? ''))
              && (call.response?.result?.truncated !== false || !terminalProof?.result_sha256
                || call.response.result.text_sha256 === terminalProof.result_sha256),
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
    if (trace.length === traceLengthBeforeCall
      && !(callOutcome === 'succeeded' && (call.tool === 'cursor_read_result'
        || call.tool === 'cursor_list_models'
        || (call.tool === 'cursor_wait' && terminalAlreadyObserved)))) {
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

async function resolveHostedAuthFile(env = process.env, dependencies = {}) {
  const candidate = env.CURSOR_EVAL_AUTH_FILE || join((dependencies.homedir || homedir)(), '.codex', 'auth.json');
  try { await (dependencies.access || access)(candidate); }
  catch { throw new Error('hosted Codex credentials are unavailable; set CURSOR_EVAL_AUTH_FILE or authenticate Codex in the current home directory'); }
  return candidate;
}

function fixtureProviderAppServerArgs(endpoint) {
  const provider = 'fixture_ollama';
  const baseUrl = `${endpoint.replace(/\/$/, '')}/v1`;
  return ['app-server', '--stdio', '-c', 'features.apps=true', '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', 'model="qwen2.5-coder:7b"', '-c', `model_providers.${provider}.name="Fixture Ollama"`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
    '-c', `model_providers.${provider}.wire_api="responses"`];
}

function hostedAppServerConfig(env = process.env) {
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


export { observationsFromEvidence, scoreWithCapturedFinals, resolveHostedAuthFile, fixtureProviderAppServerArgs, hostedAppServerConfig };
