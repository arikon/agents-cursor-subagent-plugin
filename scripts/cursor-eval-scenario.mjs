import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

const PROGRAMMED_KEYS = ['expected_actual_task_outcome', 'expected_enabled_eval_status', 'expected_trace', 'fixture_predicate', 'followups', 'harness_faults', 'initial_input', 'lane', 'owner_requirements', 'prior_authority', 'program', 'report_checks', 'scenario_id', 'scenario_kind'];
const REFERENCE_KEYS = ['expected_enabled_eval_status', 'lane', 'owner_requirements', 'scenario_id', 'scenario_kind'];
const HARNESS_FAULTS = new Set(['mode-timeout', 'accelerate-turn-timeout', 'accelerate-wait-timeout', 'exit-after-result', 'hold-terminal-until-followup', 'inject-mode-protocol-error-once', 'inject-stale-question-once', 'lose-terminal-wait-response-once', 'reject-initialize', 'reject-mode', 'reject-prompt', 'reject-resume', 'result-overflow']);
const OUTCOMES = new Set(['succeeded', 'failed']);
const REPORT_CATEGORIES = new Set(['interaction']);
const TRACE_KINDS = new Set(['session.allocated', 'session.start-rejected', 'session.resumed', 'session.resume-failed', 'session.tombstoned', 'session.mode-changed', 'session.mode-change-failed', 'session.mode-recovery-status', 'turn.started', 'turn.wait-timeout', 'turn.wait-recovered', 'turn.followup-received-active', 'turn.receipt', 'turn.result-read', 'session.close-attempted', 'prompt.contract', 'pending.question', 'pending.plan', 'pending.permission', 'effect.file-read', 'effect.file-written', 'turn.completed', 'turn.failed', 'turn.timed-out', 'answer.question', 'answer.plan', 'answer.permission', 'answer.rejected-stale']);
const PLACEHOLDER = /\$\{([^}]+)\}/g;
TRACE_KINDS.add('turn.wait-response-recovered');
const PUBLIC_MCP_TOOL_NAMES = Object.freeze([
  'cursor_delegate', 'cursor_start_session', 'cursor_resume_session', 'cursor_send_prompt',
  'cursor_set_mode', 'cursor_session_status', 'cursor_wait', 'cursor_answer_question',
  'cursor_answer_plan', 'cursor_answer_permission', 'cursor_cancel', 'cursor_close_session', 'cursor_read_result',
]);
const FORBIDDEN_MODEL_PROMPT_FRAGMENTS = Object.freeze([
  ...PUBLIC_MCP_TOOL_NAMES, 'after_event_id', 'after_progress_revision', 'resume_after_event_id',
  'last_event_id', 'timeout_ms', 'wait_timeout', 'events_lost', 'observation_gap',
  'history_reconstructed', 'evidence_scope', 'verification:unverifiable', 'unknown_request',
  'turn_id', 'session_id', 'cursor_session_id', 'закрой runtime session',
  'не повторяй операцию', 'не создавай замену', 'close the runtime session', 'do not retry',
  'do not create a replacement',
]);

function admission(message) {
  throw Object.assign(new Error(message), { code: 'adapter_admission', evalCode: 'adapter_admission' });
}

function record(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') admission(`${label} must be an object`);
  return value;
}

function closed(value, keys, label) {
  record(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) admission(`${label} has an invalid shape`);
}

function text(value, label, min = 1, max = 8_000) {
  if (typeof value !== 'string' || (value.isWellFormed && !value.isWellFormed())) admission(`${label} must be valid text`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < min || bytes > max) admission(`${label} is outside its byte bound`);
  return value;
}

function ordinaryModelGoal(value, label) {
  const folded = value.toLocaleLowerCase('en-US');
  if (FORBIDDEN_MODEL_PROMPT_FRAGMENTS.some((fragment) => folded.includes(fragment))) {
    admission(`${label} prescribes eval lifecycle or opaque runtime state`);
  }
}

function unique(values, label, key = (value) => value) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) admission(`${label} contains a duplicate`);
    seen.add(identity);
  }
}

function list(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) admission(`${label} has an invalid item count`);
  return value;
}

function structuredPath(value, label) {
  text(value, label, 1, 4_096);
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) admission(`${label} must be a literal relative POSIX path`);
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..') || /\$\{[^}]+\}/.test(value)) admission(`${label} must be a literal relative POSIX path`);
  return value;
}

function action(value, label) {
  closed(value, ['operation', 'path'], label);
  if (!['read', 'write'].includes(value.operation)) admission(`${label}.operation is invalid`);
  structuredPath(value.path, `${label}.path`);
}

function ownerRequirements(value, label) {
  list(value, label, 1, 5);
  for (const [index, owner] of value.entries()) {
    closed(owner, ['capability', 'requirement'], `${label}[${index}]`);
    text(owner.capability, `${label}[${index}].capability`, 1, 128);
    text(owner.requirement, `${label}[${index}].requirement`, 1, 128);
  }
  unique(value, label, ({ capability, requirement }) => `${capability}\0${requirement}`);
}

function priorAuthority(value, label) {
  record(value, label);
  if (value.kind === 'none') return closed(value, ['kind'], label);
  if (value.kind !== 'delegated') admission(`${label}.kind is invalid`);
  closed(value, ['allowed_actions', 'kind'], label);
  list(value.allowed_actions, `${label}.allowed_actions`, 1, 8);
  value.allowed_actions.forEach((item, index) => action(item, `${label}.allowed_actions[${index}]`));
  unique(value.allowed_actions, `${label}.allowed_actions`, ({ operation, path }) => `${operation}\0${path}`);
}

function pendingStep(step, label) {
  if (step.request_kind === 'question') {
    closed(step, ['callback_id', 'expected_callback', 'options', 'prompt', 'question_id', 'request_kind', 'step_id', 'type'], label);
    text(step.question_id, `${label}.question_id`, 1, 128);
    text(step.prompt, `${label}.prompt`);
    list(step.options, `${label}.options`, 1, 8);
    for (const [index, option] of step.options.entries()) {
      closed(option, ['id', 'label'], `${label}.options[${index}]`);
      text(option.id, `${label}.options[${index}].id`, 1, 128);
      text(option.label, `${label}.options[${index}].label`);
    }
    unique(step.options, `${label}.options`, ({ id }) => id);
    closed(step.expected_callback, ['kind', 'option_ids'], `${label}.expected_callback`);
    if (step.expected_callback.kind !== 'answer') admission(`${label}.expected_callback.kind is invalid`);
    list(step.expected_callback.option_ids, `${label}.expected_callback.option_ids`, 1, 8);
    step.expected_callback.option_ids.forEach((id, index) => text(id, `${label}.expected_callback.option_ids[${index}]`, 1, 128));
    unique(step.expected_callback.option_ids, `${label}.expected_callback.option_ids`);
    const advertised = new Set(step.options.map(({ id }) => id));
    if (step.expected_callback.option_ids.some((id) => !advertised.has(id))) admission(`${label}.expected_callback references an unknown option`);
    return;
  }
  if (step.request_kind === 'plan') {
    closed(step, ['callback_id', 'expected_callback', 'plan_text', 'request_kind', 'step_id', 'type'], label);
    text(step.plan_text, `${label}.plan_text`);
    closed(step.expected_callback, ['decision', 'kind'], `${label}.expected_callback`);
    if (step.expected_callback.kind !== 'decision' || !['accept', 'reject'].includes(step.expected_callback.decision)) admission(`${label}.expected_callback is invalid`);
    return;
  }
  if (step.request_kind === 'permission') {
    closed(step, ['action', 'callback_id', 'choices', 'expected_callback', 'request_kind', 'step_id', 'type'], label);
    action(step.action, `${label}.action`);
    if (!Array.isArray(step.choices) || step.choices.length !== 2 || step.choices[0] !== 'allow-once' || step.choices[1] !== 'reject-once') admission(`${label}.choices is invalid`);
    closed(step.expected_callback, ['decision', 'kind'], `${label}.expected_callback`);
    if (step.expected_callback.kind !== 'decision' || !step.choices.includes(step.expected_callback.decision)) admission(`${label}.expected_callback is invalid`);
    return;
  }
  admission(`${label}.request_kind is invalid`);
}

function program(value, label) {
  closed(value, value.resume_step_index === undefined ? ['kind', 'steps'] : ['kind', 'resume_step_index', 'steps'], label);
  if (value.kind !== 'fake-acp') admission(`${label}.kind is invalid`);
  list(value.steps, `${label}.steps`, 1, 8);
  for (const [index, step] of value.steps.entries()) {
    record(step, `${label}.steps[${index}]`);
    text(step.step_id, `${label}.steps[${index}].step_id`, 1, 128);
    if (step.type === 'prompt-check') {
      closed(step, ['forbidden_fragments', 'required_fragments', 'step_id', 'type'], `${label}.steps[${index}]`);
      list(step.required_fragments, `${label}.steps[${index}].required_fragments`, 1, 12);
      list(step.forbidden_fragments, `${label}.steps[${index}].forbidden_fragments`, 0, 12);
      step.required_fragments.forEach((fragment, item) => text(fragment, `${label}.steps[${index}].required_fragments[${item}]`, 1, 256));
      step.forbidden_fragments.forEach((fragment, item) => text(fragment, `${label}.steps[${index}].forbidden_fragments[${item}]`, 1, 256));
      unique(step.required_fragments, `${label}.steps[${index}].required_fragments`);
      unique(step.forbidden_fragments, `${label}.steps[${index}].forbidden_fragments`);
    } else if (step.type === 'pending') {
      text(step.callback_id, `${label}.steps[${index}].callback_id`, 1, 128);
      pendingStep(step, `${label}.steps[${index}]`);
    } else if (step.type === 'effect') {
      closed(step, ['callback_id', 'expected_callback', 'operation', 'path', 'step_id', 'text', 'type'], `${label}.steps[${index}]`);
      text(step.callback_id, `${label}.steps[${index}].callback_id`, 1, 128);
      if (!['read', 'write'].includes(step.operation)) admission(`${label}.steps[${index}].operation is invalid`);
      structuredPath(step.path, `${label}.steps[${index}].path`);
      text(step.text, `${label}.steps[${index}].text`, 0, 8_000);
      closed(step.expected_callback, ['kind', 'outcome'], `${label}.steps[${index}].expected_callback`);
      if (step.expected_callback.kind !== `${step.operation}-result` || step.expected_callback.outcome !== 'succeeded') admission(`${label}.steps[${index}].expected_callback is invalid`);
    } else if (step.type === 'terminal') {
      const terminalKeys = ['result_text', 'step_id', 'turn_status', 'type'];
      if (step.delay_ms !== undefined) terminalKeys.push('delay_ms');
      if (step.progress_text !== undefined) terminalKeys.push('progress_text');
      closed(step, terminalKeys, `${label}.steps[${index}]`);
      if (!['completed', 'failed', 'timed_out'].includes(step.turn_status)
        || (step.turn_status === 'completed' && (step.result_text === null
          || text(step.result_text, `${label}.steps[${index}].result_text`) !== step.result_text))
        || (step.turn_status !== 'completed' && step.result_text !== null)) admission(`${label}.steps[${index}] is invalid`);
      if (step.delay_ms !== undefined && (!Number.isSafeInteger(step.delay_ms) || step.delay_ms < 1 || step.delay_ms > 5_000)) admission(`${label}.steps[${index}].delay_ms is invalid`);
      if (step.progress_text !== undefined) text(step.progress_text, `${label}.steps[${index}].progress_text`, 1, 512);
    } else admission(`${label}.steps[${index}].type is invalid`);
  }
  unique(value.steps, `${label}.steps`, ({ step_id: stepId }) => stepId);
  if (value.resume_step_index !== undefined
    && (!Number.isSafeInteger(value.resume_step_index) || value.resume_step_index < 1 || value.resume_step_index >= value.steps.length)) admission(`${label}.resume_step_index is invalid`);
  if (value.resume_step_index !== undefined && value.steps[value.resume_step_index]?.type !== 'prompt-check') admission(`${label}.resume_step_index must start a resumed prompt`);
}

function trace(value, steps, label) {
  list(value, label, 1, 16);
  const byId = new Map(steps.map((step, index) => [step.step_id, { step, index }]));
  const pendingTraceSteps = new Set();
  let lastProgramIndex = -1;
  for (const [index, observation] of value.entries()) {
    record(observation, `${label}[${index}]`);
    if (!TRACE_KINDS.has(observation.kind)) admission(`${label}[${index}].kind is invalid`);
    if (observation.kind === 'session.allocated') {
      const allocationKeys = ['kind'];
      if (observation.mode !== undefined) allocationKeys.push('mode');
      if (observation.model !== undefined) allocationKeys.push('model');
      if (observation.effort !== undefined) allocationKeys.push('effort');
      if (observation.fast !== undefined) allocationKeys.push('fast');
      if (observation.plugin_dirs_count !== undefined) allocationKeys.push('plugin_dirs_count');
      if (observation.plugin_dirs_matched !== undefined) allocationKeys.push('plugin_dirs_matched');
      closed(observation, allocationKeys, `${label}[${index}]`);
      if (observation.mode !== undefined && !['ask', 'agent', 'plan'].includes(observation.mode)) admission(`${label}[${index}].mode is invalid`);
      if (observation.model !== undefined) text(observation.model, `${label}[${index}].model`, 1, 256);
      if (observation.effort !== undefined) text(observation.effort, `${label}[${index}].effort`, 1, 256);
      if (observation.fast !== undefined && typeof observation.fast !== 'boolean') admission(`${label}[${index}].fast is invalid`);
      if (observation.plugin_dirs_count !== undefined && (!Number.isSafeInteger(observation.plugin_dirs_count) || observation.plugin_dirs_count < 1 || observation.plugin_dirs_count > 16)) admission(`${label}[${index}].plugin_dirs_count is invalid`);
      if (observation.plugin_dirs_matched !== undefined && observation.plugin_dirs_matched !== true) admission(`${label}[${index}].plugin_dirs_matched must be true`);
    } else if (observation.kind === 'session.start-rejected') {
      closed(observation, ['error_code', 'kind'], `${label}[${index}]`);
      if (!['invalid_args', 'scope_rejected'].includes(observation.error_code)) admission(`${label}[${index}].error_code is invalid`);
    } else if (observation.kind === 'session.mode-changed') {
      closed(observation, ['kind', 'mode'], `${label}[${index}]`);
      if (!['ask', 'agent', 'plan'].includes(observation.mode)) admission(`${label}[${index}].mode is invalid`);
    } else if (observation.kind === 'session.mode-change-failed') {
      closed(observation, ['error_code', 'kind'], `${label}[${index}]`);
      if (!['mode_timeout', 'protocol_error'].includes(observation.error_code)) admission(`${label}[${index}].error_code is invalid`);
    } else if (observation.kind === 'session.mode-recovery-status') {
      closed(observation, ['active_turn', 'kind', 'session_state'], `${label}[${index}]`);
      if (observation.session_state !== 'live' || typeof observation.active_turn !== 'boolean') admission(`${label}[${index}] recovery state is invalid`);
    } else if (['turn.started', 'turn.followup-received-active', 'session.close-attempted'].includes(observation.kind)) closed(observation, ['kind'], `${label}[${index}]`);
    else if (observation.kind === 'session.tombstoned') {
      closed(observation, ['kind', 'session_state'], `${label}[${index}]`);
      if (observation.session_state !== 'tombstone') admission(`${label}[${index}].session_state is invalid`);
    }
    else if (['session.resumed', 'session.resume-failed'].includes(observation.kind)) {
      const resumeKeys = ['kind', 'matched'];
      if (observation.model !== undefined) resumeKeys.push('model');
      if (observation.effort !== undefined) resumeKeys.push('effort');
      if (observation.fast !== undefined) resumeKeys.push('fast');
      closed(observation, resumeKeys, `${label}[${index}]`);
      if (observation.matched !== true) admission(`${label}[${index}].matched must be true`);
      if (observation.model !== undefined) text(observation.model, `${label}[${index}].model`, 1, 256);
      if (observation.effort !== undefined) text(observation.effort, `${label}[${index}].effort`, 1, 256);
      if (observation.fast !== undefined && typeof observation.fast !== 'boolean') admission(`${label}[${index}].fast is invalid`);
    }
    else if (['turn.wait-timeout', 'turn.wait-recovered'].includes(observation.kind)) {
      closed(observation, ['kind', 'timeout_ms', 'timeout_omitted'], `${label}[${index}]`);
      if (!Number.isSafeInteger(observation.timeout_ms) || observation.timeout_ms < 1_000 || observation.timeout_ms > 180_000
        || typeof observation.timeout_omitted !== 'boolean'
        || (observation.timeout_omitted && observation.timeout_ms !== 30_000)) admission(`${label}[${index}] has an invalid wait contract`);
    } else if (observation.kind === 'turn.wait-response-recovered') {
      closed(observation, ['kind', 'matched', 'step_id'], `${label}[${index}]`);
      if (observation.matched !== true) admission(`${label}[${index}].matched must be true`);
    } else if (observation.kind === 'turn.receipt') {
      closed(observation, ['kind', 'matched', 'result_truncated', 'step_id'], `${label}[${index}]`);
      if (observation.matched !== true || typeof observation.result_truncated !== 'boolean') admission(`${label}[${index}] has an invalid receipt contract`);
    } else if (observation.kind === 'turn.result-read') {
      closed(observation, ['complete', 'kind', 'step_id'], `${label}[${index}]`);
      if (observation.complete !== true) admission(`${label}[${index}] has an invalid result-read contract`);
    }
    else if (observation.kind === 'prompt.contract') {
      closed(observation, ['kind', 'matched', 'step_id'], `${label}[${index}]`);
      if (observation.matched !== true) admission(`${label}[${index}].matched must be true`);
    }
    else if (observation.kind === 'answer.rejected-stale') {
      closed(observation, ['error_code', 'kind', 'step_id'], `${label}[${index}]`);
      if (observation.error_code !== 'unknown_request') admission(`${label}[${index}].error_code is invalid`);
    } else if (observation.kind === 'answer.question') {
      closed(observation, ['kind', 'option_ids', 'step_id'], `${label}[${index}]`);
      list(observation.option_ids, `${label}[${index}].option_ids`, 1, 8);
      observation.option_ids.forEach((id, item) => text(id, `${label}[${index}].option_ids[${item}]`, 1, 128));
      unique(observation.option_ids, `${label}[${index}].option_ids`);
    } else if (observation.kind.startsWith('answer.')) {
      closed(observation, ['decision', 'kind', 'step_id'], `${label}[${index}]`);
      const allowed = observation.kind === 'answer.plan' ? ['accept', 'reject'] : ['allow-once', 'reject-once'];
      if (!allowed.includes(observation.decision)) admission(`${label}[${index}].decision is invalid`);
    } else closed(observation, ['kind', 'step_id'], `${label}[${index}]`);
    if (!('step_id' in observation)) continue;
    text(observation.step_id, `${label}[${index}].step_id`, 1, 128);
    const referenced = byId.get(observation.step_id);
    if (!referenced) admission(`${label}[${index}] references an unknown step`);
    const expectedKind = referenced.step.type === 'pending' ? (observation.kind === 'answer.rejected-stale'
      ? 'answer.rejected-stale' : `${observation.kind.startsWith('answer.') ? 'answer' : 'pending'}.${referenced.step.request_kind}`)
      : referenced.step.type === 'effect' ? `effect.file-${referenced.step.operation === 'read' ? 'read' : 'written'}`
        : referenced.step.type === 'prompt-check' ? 'prompt.contract'
          : observation.kind === 'turn.wait-response-recovered' ? 'turn.wait-response-recovered'
          : observation.kind === 'turn.receipt' ? 'turn.receipt'
              : observation.kind === 'turn.result-read' ? 'turn.result-read'
              : referenced.step.turn_status === 'timed_out' ? 'turn.timed-out'
                : referenced.step.turn_status === 'failed' ? 'turn.failed' : 'turn.completed';
    if (observation.kind !== expectedKind) admission(`${label}[${index}] references an incompatible step`);
    if (observation.kind.startsWith('pending.')) pendingTraceSteps.add(observation.step_id);
    if (observation.kind.startsWith('answer.') && !pendingTraceSteps.has(observation.step_id)) admission(`${label}[${index}] answers before its pending step`);
    if (observation.kind === 'answer.question' && canonicalJson(observation.option_ids) !== canonicalJson(referenced.step.expected_callback.option_ids)) admission(`${label}[${index}] does not match the expected callback`);
    if (observation.kind.startsWith('answer.') && observation.kind !== 'answer.question' && observation.decision !== referenced.step.expected_callback.decision) admission(`${label}[${index}] does not match the expected callback`);
    if (referenced.index < lastProgramIndex) admission(`${label} is incompatible with program order`);
    lastProgramIndex = referenced.index;
  }
}

function predicate(value, label) {
  record(value, label);
  if (value.kind === 'none') return closed(value, ['kind'], label);
  if (value.kind === 'terminal-token') {
    closed(value, ['kind', 'token'], label);
    text(value.token, `${label}.token`);
    return;
  }
  if (value.kind === 'file-text') {
    closed(value, ['kind', 'path', 'text'], label);
    structuredPath(value.path, `${label}.path`);
    text(value.text, `${label}.text`, 0, 8_000);
    return;
  }
  if (value.kind === 'file-absent') {
    closed(value, ['kind', 'path'], label);
    structuredPath(value.path, `${label}.path`);
    return;
  }
  if (value.kind === 'terminal-status') {
    closed(value, ['kind', 'status'], label);
    if (!['failed', 'timed_out'].includes(value.status)) admission(`${label}.status is invalid`);
    return;
  }
  if (value.kind === 'resume-failed') return closed(value, ['kind'], label);
  if (value.kind === 'mode-change-failed') {
    closed(value, ['error_code', 'kind'], label);
    if (!['mode_timeout', 'protocol_error'].includes(value.error_code)) admission(`${label}.error_code is invalid`);
    return;
  }
  if (value.kind === 'mode-recovery-status') {
    closed(value, ['active_turn', 'kind', 'session_state'], label);
    if (value.session_state !== 'live' || typeof value.active_turn !== 'boolean') admission(`${label} recovery state is invalid`);
    return;
  }
  if (value.kind === 'delegate-init-failed') {
    closed(value, ['failure_kind', 'kind'], label);
    if (value.failure_kind !== 'init') admission(`${label}.failure_kind is invalid`);
    return;
  }
  if (value.kind === 'start-rejected') {
    closed(value, ['error_code', 'kind'], label);
    if (!['invalid_args', 'scope_rejected'].includes(value.error_code)) admission(`${label}.error_code is invalid`);
    return;
  }
  admission(`${label}.kind is invalid`);
}

function validatePlaceholders(scenario, label) {
  const inputs = [scenario.initial_input, ...scenario.followups.map(({ input }) => input),
    ...scenario.program.steps.filter(({ type }) => type === 'prompt-check')
      .flatMap(({ required_fragments: required, forbidden_fragments: forbidden }) => [...required, ...forbidden])];
  let resultFileUsed = false;
  for (const input of inputs) {
    for (const match of input.matchAll(PLACEHOLDER)) {
      if (!['RESULT_FILE', 'PLUGIN_DIR', 'MISSING_PLUGIN_DIR'].includes(match[1])) admission(`${label} contains an unknown placeholder`);
      if (match[1] === 'RESULT_FILE') resultFileUsed = true;
    }
  }
  if (resultFileUsed && !['file-text', 'file-absent'].includes(scenario.fixture_predicate.kind)) admission(`${label} uses RESULT_FILE without a path-bearing predicate`);
}

function programmedScenario(scenario, label) {
  const keys = PROGRAMMED_KEYS.filter((key) => key !== 'harness_faults' || scenario.harness_faults !== undefined);
  closed(scenario, keys, label);
  ownerRequirements(scenario.owner_requirements, `${label}.owner_requirements`);
  text(scenario.initial_input, `${label}.initial_input`);
  priorAuthority(scenario.prior_authority, `${label}.prior_authority`);
  program(scenario.program, `${label}.program`);
  let segmentPromptCheck = null;
  for (const step of scenario.program.steps) {
    if (step.type === 'terminal') { segmentPromptCheck = null; continue; }
    if (step.type === 'prompt-check') { segmentPromptCheck = step; continue; }
    if (step.type !== 'effect') continue;
    if (!segmentPromptCheck) admission(`${label} file effect lacks a same-turn delegated prompt check`);
    const target = scenario.fixture_predicate.path === step.path ? '${RESULT_FILE}' : step.path;
    const actionClause = step.operation === 'write'
      ? `AUTHORIZED_ACTIONS: write ${target} with exact content ${step.text} only.`
      : `AUTHORIZED_ACTIONS: read ${target} only.`;
    const scopeClause = 'NO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.';
    if (!segmentPromptCheck.required_fragments.includes(actionClause)
      || !segmentPromptCheck.required_fragments.includes(scopeClause)
      || !segmentPromptCheck.forbidden_fragments.includes('you may make other changes')
      || !segmentPromptCheck.forbidden_fragments.includes('continue after a required expansion')
      || (step.operation === 'read' && (!segmentPromptCheck.forbidden_fragments.includes('read/search the entire cwd is allowed')
        || !segmentPromptCheck.forbidden_fragments.includes('read other paths')))) {
      admission(`${label} file prompt check lacks exact authority scope and polarity`);
    }
  }
  if (scenario.harness_faults !== undefined) {
    list(scenario.harness_faults, `${label}.harness_faults`, 1, HARNESS_FAULTS.size);
    scenario.harness_faults.forEach((fault, index) => {
      if (!HARNESS_FAULTS.has(fault)) admission(`${label}.harness_faults[${index}] is invalid`);
    });
    unique(scenario.harness_faults, `${label}.harness_faults`);
    if (scenario.harness_faults.includes('inject-stale-question-once')
      && (!scenario.program.steps.some(({ type, request_kind: kind }) => type === 'pending' && kind === 'question')
        || !scenario.expected_trace.some(({ kind }) => kind === 'answer.rejected-stale'))) admission(`${label}.harness_faults requires stale-question evidence`);
    if (scenario.harness_faults.includes('exit-after-result')
      && !scenario.expected_trace.some(({ kind }) => kind === 'session.resumed')
      && !(scenario.harness_faults.includes('reject-resume')
        && scenario.expected_trace.some(({ kind }) => kind === 'session.resume-failed'))) admission(`${label}.harness_faults requires a resume outcome`);
    if (scenario.harness_faults.includes('reject-resume')
      && !scenario.expected_trace.some(({ kind }) => kind === 'session.resume-failed')) admission(`${label}.harness_faults requires rejected-resume evidence`);
    if (scenario.harness_faults.includes('reject-initialize')
      && (!scenario.expected_trace.some(({ kind }) => kind === 'session.tombstoned')
        || scenario.expected_trace.some(({ kind }) => kind === 'turn.started'))) admission(`${label}.harness_faults requires an initial tombstone without a turn`);
    if (scenario.harness_faults.includes('reject-prompt')
      && (!scenario.program.steps.some(({ type, turn_status: status }) => type === 'terminal' && status === 'failed')
        || scenario.fixture_predicate.kind !== 'terminal-status'
        || scenario.fixture_predicate.status !== 'failed'
        || !scenario.expected_trace.some(({ kind }) => kind === 'turn.failed'))) admission(`${label}.harness_faults requires failed terminal evidence`);
    if (scenario.harness_faults.includes('accelerate-turn-timeout')
      && (scenario.fixture_predicate.kind !== 'terminal-status'
        || scenario.fixture_predicate.status !== 'timed_out'
        || !scenario.expected_trace.some(({ kind }) => kind === 'turn.timed-out'))) admission(`${label}.harness_faults requires timed-out evidence`);
    if (scenario.harness_faults.includes('mode-timeout')
      && (scenario.fixture_predicate.kind !== 'mode-change-failed'
        || scenario.fixture_predicate.error_code !== 'mode_timeout'
        || !scenario.expected_trace.some(({ kind }) => kind === 'session.mode-change-failed'))) admission(`${label}.harness_faults requires mode-timeout evidence`);
    if (scenario.harness_faults.includes('accelerate-wait-timeout')
      && !scenario.expected_trace.some(({ kind, timeout_ms: timeoutMs, timeout_omitted: omitted }) => kind === 'turn.wait-timeout' && timeoutMs === 30_000 && omitted === true)) {
      admission(`${label}.harness_faults requires an omitted-default wait timeout`);
    }
    if (scenario.harness_faults.includes('inject-mode-protocol-error-once')
      && (scenario.fixture_predicate.kind !== 'mode-recovery-status'
        || !scenario.expected_trace.some(({ kind, error_code: errorCode }) => kind === 'session.mode-change-failed' && errorCode === 'protocol_error')
        || !scenario.expected_trace.some(({ kind }) => kind === 'session.mode-recovery-status'))) admission(`${label}.harness_faults requires live mode-recovery evidence`);
    if (scenario.harness_faults.includes('reject-mode')
      && (scenario.fixture_predicate.kind !== 'mode-change-failed'
        || scenario.fixture_predicate.error_code !== 'protocol_error'
        || !scenario.expected_trace.some(({ kind, error_code: errorCode }) => kind === 'session.mode-change-failed' && errorCode === 'protocol_error')
        || !scenario.expected_trace.some(({ kind }) => kind === 'session.tombstoned'))) admission(`${label}.harness_faults requires provider mode-failure evidence`);
    if (scenario.harness_faults.includes('hold-terminal-until-followup')
      && (!scenario.followups.some(({ after_kind: kind }) => kind === 'wait-timeout')
        || !scenario.expected_trace.some(({ kind }) => kind === 'turn.followup-received-active'))) admission(`${label}.harness_faults requires active-followup evidence`);
    if (scenario.harness_faults.includes('result-overflow')
      && (!scenario.program.steps.some(({ type, turn_status: status }) => type === 'terminal' && status === 'failed')
        || scenario.fixture_predicate.kind !== 'terminal-status'
        || scenario.fixture_predicate.status !== 'failed'
        || !scenario.expected_trace.some(({ kind }) => kind === 'turn.failed')
        || scenario.expected_trace.some(({ kind }) => kind === 'turn.result-read'))) admission(`${label}.harness_faults requires overflow failure without a successful result read`);
  }
  if (scenario.program.steps.some(({ type, turn_status: status }) => type === 'terminal' && status === 'failed')
    !== Boolean(scenario.harness_faults?.some((fault) => ['reject-prompt', 'result-overflow'].includes(fault)))) admission(`${label}.failed terminal and failure fault must be paired`);
  const modeTimeout = scenario.expected_trace.some(({ kind, error_code: errorCode }) => kind === 'session.mode-change-failed' && errorCode === 'mode_timeout');
  const modeProtocolError = scenario.expected_trace.some(({ kind, error_code: errorCode }) => kind === 'session.mode-change-failed' && errorCode === 'protocol_error');
  if (modeTimeout !== Boolean(scenario.harness_faults?.includes('mode-timeout'))) admission(`${label}.mode timeout and fault must be paired`);
  if (modeProtocolError !== Boolean(scenario.harness_faults?.includes('inject-mode-protocol-error-once')
    || scenario.harness_faults?.includes('reject-mode'))) admission(`${label}.mode protocol failure and fault must be paired`);
  if (scenario.expected_trace.some(({ kind, timeout_omitted: omitted }) => kind === 'turn.wait-timeout' && omitted === true)
    !== Boolean(scenario.harness_faults?.includes('accelerate-wait-timeout'))) admission(`${label}.default wait timeout and acceleration fault must be paired`);
  if (scenario.expected_trace.some(({ kind }) => kind === 'turn.followup-received-active')
    !== Boolean(scenario.harness_faults?.includes('hold-terminal-until-followup'))) admission(`${label}.active-followup trace and hold fault must be paired`);
  const expectedKinds = scenario.expected_trace.map(({ kind }) => kind);
  const lossFault = Boolean(scenario.harness_faults?.includes('lose-terminal-wait-response-once'));
  if (expectedKinds.includes('turn.wait-response-recovered') !== lossFault) admission(`${label}.loss recovery trace and fault must be paired`);
  if (lossFault) {
    const terminals = scenario.program.steps.filter(({ type }) => type === 'terminal');
    if (scenario.harness_faults.length !== 1 || terminals.length !== 1 || terminals[0].turn_status !== 'completed'
      || expectedKinds.filter((kind) => kind === 'turn.wait-response-recovered').length !== 1) admission(`${label}.loss fault requires one isolated nonempty completed terminal`);
  }
  if (expectedKinds.includes('answer.rejected-stale')
    !== Boolean(scenario.harness_faults?.includes('inject-stale-question-once'))) admission(`${label}.stale-answer trace and injection fault must be paired`);
  if (expectedKinds.includes('turn.timed-out')
    !== Boolean(scenario.harness_faults?.includes('accelerate-turn-timeout'))) admission(`${label}.terminal timeout trace and acceleration fault must be paired`);
  const resumeFailed = expectedKinds.includes('session.resume-failed');
  if (resumeFailed !== Boolean(scenario.harness_faults?.includes('exit-after-result')
    && scenario.harness_faults?.includes('reject-resume'))) admission(`${label}.resume-failed trace requires exit and rejection faults`);
  const recoveryTombstone = expectedKinds.some((kind, index) => kind === 'session.tombstoned'
    && expectedKinds.slice(0, index).some((candidate) => ['turn.completed', 'turn.failed', 'turn.timed-out'].includes(candidate))
    && expectedKinds.slice(index + 1).some((candidate) => ['session.resumed', 'session.resume-failed'].includes(candidate)));
  if (recoveryTombstone !== Boolean(scenario.harness_faults?.includes('exit-after-result'))) admission(`${label}.wrapper-loss recovery and exit fault must be paired`);
  const tombstoneIndex = expectedKinds.indexOf('session.tombstoned');
  const initialTombstone = tombstoneIndex !== -1 && !expectedKinds.slice(0, tombstoneIndex).includes('turn.started');
  if (initialTombstone !== Boolean(scenario.harness_faults?.includes('reject-initialize'))) admission(`${label}.initial tombstone and initialization fault must be paired`);
  list(scenario.followups, `${label}.followups`, 0, 2);
  const stepsById = new Map(scenario.program.steps.map((step) => [step.step_id, step]));
  for (const [index, followup] of scenario.followups.entries()) {
    const keys = followup.after_kind === 'wait-timeout' ? ['after_kind', 'input'] : ['after_kind', 'after_step', 'input'];
    if (followup.granted_actions !== undefined) keys.push('granted_actions');
    closed(followup, keys, `${label}.followups[${index}]`);
    if (!['pending', 'terminal', 'wait-timeout'].includes(followup.after_kind)) admission(`${label}.followups[${index}].after_kind is invalid`);
    text(followup.input, `${label}.followups[${index}].input`);
    if (followup.granted_actions !== undefined) {
      list(followup.granted_actions, `${label}.followups[${index}].granted_actions`, 1, 8);
      followup.granted_actions.forEach((item, actionIndex) => action(item, `${label}.followups[${index}].granted_actions[${actionIndex}]`));
      unique(followup.granted_actions, `${label}.followups[${index}].granted_actions`, ({ operation, path }) => `${operation}\0${path}`);
    }
    if (followup.after_kind !== 'wait-timeout') {
      text(followup.after_step, `${label}.followups[${index}].after_step`, 1, 128);
      const step = stepsById.get(followup.after_step);
      if (!step || (followup.after_kind === 'pending' && step.type !== 'pending')
        || (followup.after_kind === 'terminal' && step.type !== 'terminal')) admission(`${label}.followups[${index}] references an incompatible step`);
    } else if (!scenario.expected_trace.some(({ kind }) => kind === 'turn.wait-timeout')) admission(`${label}.followups[${index}] requires an expected wait timeout`);
  }
  unique(scenario.followups, `${label}.followups`, ({ after_kind: kind, after_step: stepId = '' }) => `${kind}\0${stepId}`);
  if (scenario.lane === 'model-behavior') {
    ordinaryModelGoal(scenario.initial_input, `${label}.initial_input`);
    scenario.followups.forEach((followup, index) => ordinaryModelGoal(followup.input, `${label}.followups[${index}].input`));
  }
  if (scenario.report_checks !== undefined) {
    list(scenario.report_checks, `${label}.report_checks`, 0, 9);
    for (const [index, check] of scenario.report_checks.entries()) {
      closed(check, ['category', 'forbidden_fragments', 'required_fragments', 'turn_index'], `${label}.report_checks[${index}]`);
      if (!Number.isSafeInteger(check.turn_index) || check.turn_index < 1 || check.turn_index > scenario.followups.length + 1) admission(`${label}.report_checks[${index}].turn_index is invalid`);
      if (!REPORT_CATEGORIES.has(check.category)) admission(`${label}.report_checks[${index}].category is invalid`);
      list(check.required_fragments, `${label}.report_checks[${index}].required_fragments`, 1, 12);
      list(check.forbidden_fragments, `${label}.report_checks[${index}].forbidden_fragments`, 0, 12);
      check.required_fragments.forEach((fragment, item) => text(fragment, `${label}.report_checks[${index}].required_fragments[${item}]`, 1, 256));
      check.forbidden_fragments.forEach((fragment, item) => text(fragment, `${label}.report_checks[${index}].forbidden_fragments[${item}]`, 1, 256));
      unique(check.required_fragments, `${label}.report_checks[${index}].required_fragments`);
      unique(check.forbidden_fragments, `${label}.report_checks[${index}].forbidden_fragments`);
    }
    unique(scenario.report_checks, `${label}.report_checks`, ({ turn_index: turnIndex, category }) => `${turnIndex}\0${category}`);
  }
  trace(scenario.expected_trace, scenario.program.steps, `${label}.expected_trace`);
  for (const step of scenario.program.steps.filter(({ type }) => type === 'effect')) {
    const expectedKind = `effect.file-${step.operation === 'read' ? 'read' : 'written'}`;
    const matching = scenario.expected_trace.filter(({ kind, step_id: stepId }) => kind === expectedKind && stepId === step.step_id);
    if (matching.length !== 1) admission(`${label}.expected_trace must observe every file effect exactly once`);
  }
  predicate(scenario.fixture_predicate, `${label}.fixture_predicate`);
  if (!OUTCOMES.has(scenario.expected_actual_task_outcome) || scenario.expected_enabled_eval_status !== 'pass') admission(`${label} has invalid expected outcomes`);
  validatePlaceholders(scenario, label);
}

function referenceScenario(scenario, label) {
  closed(scenario, REFERENCE_KEYS, label);
  if (scenario.lane !== 'full-live' || scenario.expected_enabled_eval_status !== 'pass') admission(`${label} is not a package canary reference`);
  ownerRequirements(scenario.owner_requirements, `${label}.owner_requirements`);
  if (scenario.owner_requirements.length !== 1 || canonicalJson(scenario.owner_requirements[0]) !== canonicalJson({ capability: 'cursor-plugin-distribution', requirement: 'Проверяемая чистая установка' })) admission(`${label} has an invalid package owner`);
}

function validateScenario(scenario, label) {
  record(scenario, label);
  text(scenario.scenario_id, `${label}.scenario_id`, 1, 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.scenario_id)) admission(`${label}.scenario_id is invalid`);
  if (scenario.scenario_kind === 'programmed' && ['client-integration', 'model-behavior'].includes(scenario.lane)) programmedScenario(scenario, label);
  else if (scenario.scenario_kind === 'package-canary-reference') referenceScenario(scenario, label);
  else admission(`${label}.scenario_kind is invalid`);
}

export function admitScenarioCorpus(value) {
  closed(value, ['schema_version', 'scenarios'], 'corpus');
  if (value.schema_version !== 1) admission('corpus.schema_version is invalid');
  list(value.scenarios, 'corpus.scenarios', 2, 64);
  const admitted = structuredClone(value);
  admitted.scenarios.forEach((scenario, index) => validateScenario(scenario, `corpus.scenarios[${index}]`));
  if (admitted.scenarios.filter(({ scenario_kind: kind }) => kind === 'package-canary-reference').length !== 1
    || !admitted.scenarios.some(({ scenario_kind: kind }) => kind === 'programmed')) admission('corpus.scenarios must contain programmed rows and exactly one package reference');
  unique(admitted.scenarios, 'corpus.scenarios', ({ scenario_id: scenarioId }) => scenarioId);
  return admitted;
}

export function parseScenarioCorpus(raw) {
  let decoded;
  try { decoded = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw); }
  catch { admission('corpus is not valid JSON'); }
  return admitScenarioCorpus(decoded);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function materializeScenario(scenario, { workspace } = {}) {
  const admitted = structuredClone(scenario);
  validateScenario(admitted, 'scenario');
  const materialized = structuredClone(admitted);
  const bindings = {};
  if (materialized.scenario_kind === 'programmed') {
    const promptFragments = materialized.program.steps.filter(({ type }) => type === 'prompt-check')
      .flatMap(({ required_fragments: required, forbidden_fragments: forbidden }) => [...required, ...forbidden]);
    const inputs = [materialized.initial_input, ...materialized.followups.map(({ input }) => input), ...promptFragments];
    const replacePromptFragments = (placeholder, replacement) => {
      materialized.program.steps = materialized.program.steps.map((step) => step.type !== 'prompt-check' ? step : ({ ...step,
        required_fragments: step.required_fragments.map((fragment) => fragment.replaceAll(placeholder, replacement)),
        forbidden_fragments: step.forbidden_fragments.map((fragment) => fragment.replaceAll(placeholder, replacement)),
      }));
    };
    if (inputs.some((input) => input.includes('${RESULT_FILE}'))) {
      if (typeof workspace !== 'string' || !isAbsolute(workspace)) admission('workspace must be absolute when RESULT_FILE is used');
      const resultFile = resolve(workspace, ...materialized.fixture_predicate.path.split('/'));
      bindings.RESULT_FILE = resultFile;
      materialized.initial_input = materialized.initial_input.replaceAll('${RESULT_FILE}', resultFile);
      materialized.followups = materialized.followups.map((followup) => ({ ...followup, input: followup.input.replaceAll('${RESULT_FILE}', resultFile) }));
      replacePromptFragments('${RESULT_FILE}', resultFile);
    }
    if (inputs.some((input) => input.includes('${PLUGIN_DIR}'))) {
      if (typeof workspace !== 'string' || !isAbsolute(workspace)) admission('workspace must be absolute when PLUGIN_DIR is used');
      const pluginDir = resolve(workspace, 'plugin-bundle');
      bindings.PLUGIN_DIR = pluginDir;
      materialized.initial_input = materialized.initial_input.replaceAll('${PLUGIN_DIR}', pluginDir);
      materialized.followups = materialized.followups.map((followup) => ({ ...followup, input: followup.input.replaceAll('${PLUGIN_DIR}', pluginDir) }));
      replacePromptFragments('${PLUGIN_DIR}', pluginDir);
    }
    if (inputs.some((input) => input.includes('${MISSING_PLUGIN_DIR}'))) {
      if (typeof workspace !== 'string' || !isAbsolute(workspace)) admission('workspace must be absolute when MISSING_PLUGIN_DIR is used');
      const missingPluginDir = resolve(workspace, 'missing-plugin-bundle');
      bindings.MISSING_PLUGIN_DIR = missingPluginDir;
      materialized.initial_input = materialized.initial_input.replaceAll('${MISSING_PLUGIN_DIR}', missingPluginDir);
      materialized.followups = materialized.followups.map((followup) => ({ ...followup, input: followup.input.replaceAll('${MISSING_PLUGIN_DIR}', missingPluginDir) }));
      replacePromptFragments('${MISSING_PLUGIN_DIR}', missingPluginDir);
    }
  }
  const canonicalPayload = canonicalJson(materialized);
  const bytes = Buffer.byteLength(canonicalPayload, 'utf8');
  if (bytes > 65_536) admission('materialized scenario exceeds its byte bound');
  return { materializedScenario: materialized, canonicalPayload, digest: { sha256: createHash('sha256').update(canonicalPayload).digest('hex'), bytes }, bindings };
}

function expectedCallback(step) {
  return { step_id: step.step_id, callback_id: step.callback_id, ...step.expected_callback };
}

function traceProjection(observation) {
  const projected = { kind: observation.kind };
  if ('mode' in observation) projected.mode = observation.mode;
  if ('model' in observation) projected.model = observation.model;
  if ('effort' in observation) projected.effort = observation.effort;
  if ('fast' in observation) projected.fast = observation.fast;
  if ('plugin_dirs_count' in observation) projected.plugin_dirs_count = observation.plugin_dirs_count;
  if ('plugin_dirs_matched' in observation) projected.plugin_dirs_matched = observation.plugin_dirs_matched;
  if ('step_id' in observation) projected.step_id = observation.step_id;
  if ('option_ids' in observation) projected.option_ids = observation.option_ids;
  if ('decision' in observation) projected.decision = observation.decision;
  if ('matched' in observation) projected.matched = observation.matched;
  if ('timeout_ms' in observation) projected.timeout_ms = observation.timeout_ms;
  if ('timeout_omitted' in observation) projected.timeout_omitted = observation.timeout_omitted;
  if ('result_truncated' in observation) projected.result_truncated = observation.result_truncated;
  if ('complete' in observation) projected.complete = observation.complete;
  if ('error_code' in observation) projected.error_code = observation.error_code;
  if ('session_state' in observation) projected.session_state = observation.session_state;
  if ('active_turn' in observation) projected.active_turn = observation.active_turn;
  return projected;
}

function comparableTrace(trace, expectedTrace = null) {
  let terminalWrapper = false;
  const filtered = trace.filter((observation) => {
    if (['session.allocated', 'session.resumed'].includes(observation.kind)) terminalWrapper = false;
    if (observation.kind === 'session.close-attempted' && terminalWrapper) return false;
    if (['session.tombstoned', 'session.close-attempted'].includes(observation.kind)
      || (observation.kind === 'session.mode-change-failed' && observation.error_code === 'mode_timeout')) terminalWrapper = true;
    return true;
  });
  const expected = expectedTrace === null ? null : comparableTrace(expectedTrace);
  return filtered.map((observation, index) => {
    const projected = traceProjection(observation);
    if (['session.allocated', 'session.resumed'].includes(observation.kind)
      && expected?.[index]?.kind === observation.kind) {
      if (!('effort' in expected[index])) delete projected.effort;
      if (!('fast' in expected[index])) delete projected.fast;
    }
    return projected;
  });
}

function reportChecksFor(scenario) {
  return scenario.report_checks;
}

function reportEvaluation(scenario, capturedFinals) {
  if (!Array.isArray(capturedFinals)) return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
  const finals = new Map();
  const expectedFinals = scenario.followups.length + 1;
  let bytes = 0;
  for (const final of capturedFinals) {
    if (!final || typeof final !== 'object' || Array.isArray(final)
      || !Number.isSafeInteger(final.turn_index) || final.turn_index < 1 || final.turn_index > scenario.followups.length + 1
      || finals.has(final.turn_index)) return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
    if (final.completeness === 'complete') {
      if (typeof final.text !== 'string' || (final.text.isWellFormed && !final.text.isWellFormed())) return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
      bytes += Buffer.byteLength(final.text, 'utf8');
    } else if (final.completeness === 'confirmed_missing') {
      if (final.text !== null) return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
    } else return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
    finals.set(final.turn_index, final);
  }
  if (finals.size === 0 || [...finals.keys()].some((turnIndex, index) => turnIndex !== index + 1)) {
    return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
  }
  if (finals.size < expectedFinals && finals.get(finals.size)?.turn_status !== 'completed') {
    return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
  }
  if (bytes > 1_048_576) return { invalid: true, diagnostics: [], reportedTaskOutcome: 'not_checked' };
  const checks = reportChecksFor(scenario);
  const deliveryMissing = finals.size !== expectedFinals
    || [...finals.values()].some((final) => final.completeness === 'confirmed_missing'
    || final.text.trim().length === 0);
  const diagnostics = checks.map((check) => {
    const final = finals.get(check.turn_index);
    const textValue = final?.completeness === 'complete' ? final.text : null;
    const required_assertions = check.required_fragments.map((fragment) => ({
      fragment, matched: textValue !== null && textValue.includes(fragment),
    }));
    const forbidden_matches = textValue === null ? [] : check.forbidden_fragments.filter((fragment) => textValue.includes(fragment));
    return {
      turn_index: check.turn_index,
      category: check.category,
      matched: required_assertions.every(({ matched }) => matched) && forbidden_matches.length === 0,
      missing_final: textValue === null,
      required_assertions,
      forbidden_matches,
    };
  });
  return { invalid: false, diagnostics, reportedTaskOutcome: 'not_checked', deliveryMissing };
}

export function validRecoveryContext(transcript, expectedTurns) {
  if (!Array.isArray(transcript?.calls) || !Array.isArray(transcript.turn_call_ranges)
    || transcript.turn_call_ranges.length !== expectedTurns
    || !Number.isSafeInteger(transcript.unexpected_input_requests) || transcript.unexpected_input_requests < 0) return false;
  let end = 0;
  for (const range of transcript.turn_call_ranges) {
    if (!range || Object.keys(range).sort().join(',') !== 'end,start'
      || range.start !== end || !Number.isSafeInteger(range.end)
      || range.end < end || range.end > transcript.calls.length) return false;
    end = range.end;
  }
  return end === transcript.calls.length;
}

// Runtime owns rejection boundaries. These existing-session address lookups,
// wait validation and local mode validation precede tool-specific effects.
// Launch, provider transitions and answer-content repairs have other proof needs.
const SESSION_LOOKUP_TOOLS = new Set(['cursor_wait', 'cursor_session_status', 'cursor_read_result',
  'cursor_set_mode', 'cursor_cancel', 'cursor_close_session', 'cursor_send_prompt',
  'cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission']);
const TURN_LOOKUP_TOOLS = new Set(['cursor_wait', 'cursor_read_result', 'cursor_cancel',
  'cursor_answer_question', 'cursor_answer_plan', 'cursor_answer_permission']);
const LOCAL_RECOVERY_ERRORS = new Set(['unknown_session', 'unknown_turn', 'invalid_args', 'invalid_text_encoding']);
const capturedRecoveryId = (value) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256;
const argumentTag = (request) => typeof request?.arguments_without_session_turn_sha256 === 'string'
  && /^[a-f0-9]{64}$/.test(request.arguments_without_session_turn_sha256)
  ? request.arguments_without_session_turn_sha256 : null;
function exactArgumentProjection(request, fields) {
  if (!request) return false;
  const projection = Object.fromEntries(fields.filter((field) => Object.hasOwn(request, field))
    .map((field) => [field, request[field]]));
  return argumentTag(request) === createHash('sha256').update(canonicalJson(projection)).digest('hex');
}

export function findRecoveredCalls(transcript, expectedTurns) {
  if (!validRecoveryContext(transcript, expectedTurns) || transcript.dropped_calls !== 0
    || transcript.unexpected_input_requests !== 0) return [];
  const recovered = [];
  let sessionId; let turnId;
  for (let index = 0; index < transcript.calls.length; index += 1) {
    const call = transcript.calls[index];
    if (call?.response?.ok === true) {
      if (['cursor_delegate', 'cursor_start_session', 'cursor_resume_session'].includes(call.tool)) {
        sessionId = call.response.session_id; turnId = call.response.turn_id;
      } else if (call.tool === 'cursor_send_prompt' && call.request?.session_id === sessionId) {
        turnId = call.response.turn_id;
      }
      continue;
    }
    if (!LOCAL_RECOVERY_ERRORS.has(call?.response?.error_code) || !SESSION_LOOKUP_TOOLS.has(call.tool)
      || call.response.ok !== false || call.response.provider_error
      || (call.response.error_code === 'unknown_turn' && !TURN_LOOKUP_TOOLS.has(call.tool))) continue;
    const rangeIndex = transcript.turn_call_ranges.findIndex(({ start, end }) => start <= index && index < end);
    let successIndex = index + 1;
    // Read-only diagnostics do not change the operation being repaired. Their
    // successful current-session responses must remain in the original evidence.
    while (successIndex < transcript.turn_call_ranges[rangeIndex].end) {
      const diagnostic = transcript.calls[successIndex];
      if (diagnostic?.tool !== 'cursor_session_status' || diagnostic.tool === call.tool
        || diagnostic.response?.ok !== true || diagnostic.response.error_code || diagnostic.response.provider_error
        || diagnostic.request?.session_id !== sessionId || diagnostic.response.session_id !== sessionId
        || diagnostic.request.turn_id !== undefined
        || !exactArgumentProjection(diagnostic.request, [])) break;
      successIndex += 1;
    }
    const next = transcript.calls[successIndex];
    if (successIndex >= transcript.turn_call_ranges[rangeIndex].end || next?.tool !== call.tool
      || next.response?.ok !== true || next.response.error_code || next.response.provider_error) continue;
    const before = call.request; const after = next.request;
    if (!capturedRecoveryId(sessionId) || after?.session_id !== sessionId
      || (TURN_LOOKUP_TOOLS.has(call.tool)
        ? !capturedRecoveryId(turnId) || after.turn_id !== turnId : after.turn_id !== undefined)) continue;
    const changed = ['session_id', 'turn_id'].filter((field) => before?.[field] !== after[field]);
    let recoveryClass;
    if (changed.length && argumentTag(before) && argumentTag(before) === argumentTag(after)) {
      recoveryClass = 'address';
    } else if (call.tool === 'cursor_set_mode' && call.response.error_code === 'invalid_args'
      && !['ask', 'plan', 'agent'].includes(before?.mode) && ['ask', 'plan', 'agent'].includes(after.mode)
      && exactArgumentProjection(before, ['mode']) && exactArgumentProjection(after, ['mode'])) {
      // The successful transition still has to match the scenario-owned exact
      // expected trace; this mechanical repair does not authorize a new mode.
      recoveryClass = 'set_mode';
    }
    if (!recoveryClass) continue;
    recovered.push({ failed_call_index: index + 1, successful_call_index: successIndex + 1,
      codex_turn_index: rangeIndex + 1, tool: call.tool, error_code: call.response.error_code,
      correction_kind: recoveryClass });
  }
  return recovered;
}

export function findTerminalWaitLossRecovery(scenario, transcript) {
  const calls = transcript?.calls;
  if (!scenario.harness_faults?.includes('lose-terminal-wait-response-once')
    || !validRecoveryContext(transcript, (scenario.followups?.length || 0) + 1)
    || transcript.dropped_calls !== 0 || transcript.unexpected_input_requests !== 0) return null;
  const losses = calls.map((call, index) => ({ call, index })).filter(({ call }) => call && Object.hasOwn(call, 'withheld_response'));
  if (losses.length !== 1) return null;
  const { call: lost, index } = losses[0];
  const repeated = calls[index + 1];
  const range = transcript.turn_call_ranges.find(({ start, end }) => start <= index && index < end);
  let sessionId; let turnId;
  for (const call of calls.slice(0, index)) {
    if (call?.response?.ok !== true) continue;
    if (['cursor_delegate', 'cursor_start_session', 'cursor_resume_session'].includes(call.tool)) {
      sessionId = call.response.session_id; turnId = call.response.turn_id;
    } else if (call.tool === 'cursor_send_prompt' && call.request?.session_id === sessionId) turnId = call.response.turn_id;
  }
  const admitted = (call) => call?.tool === 'cursor_wait' && capturedRecoveryId(sessionId) && capturedRecoveryId(turnId)
    && call.request?.session_id === sessionId && call.request?.turn_id === turnId
    && Object.keys(call.request).every((key) => ['session_id', 'turn_id', 'timeout_ms', 'arguments_without_session_turn_sha256'].includes(key))
    && (call.request.timeout_ms === undefined || (Number.isSafeInteger(call.request.timeout_ms) && call.request.timeout_ms >= 1000 && call.request.timeout_ms <= 180000))
    && exactArgumentProjection(call.request, ['timeout_ms']);
  const terminal = (response) => response?.ok === true && response.turn_status === 'completed'
    && response.session_id === sessionId && response.turn_id === turnId && !response.error_code && !response.provider_error
    && response.wait_timeout === false && Array.isArray(response.pending) && response.pending.length === 0
    && ['live', 'closing', 'tombstone'].includes(response.session_state)
    && Number.isSafeInteger(response.result?.text_bytes) && response.result.text_bytes > 0 && /^[a-f0-9]{64}$/.test(response.result.text_sha256)
    && typeof response.result.truncated === 'boolean'
    && response.terminal_receipt?.session_id === sessionId && response.terminal_receipt.turn_id === turnId
    && response.terminal_receipt.turn_status === 'completed'
    && Number.isSafeInteger(response.terminal_receipt.last_event_id) && response.terminal_receipt.last_event_id >= 0
    && response.terminal_receipt.result_sha256 === response.result.text_sha256
    && response.terminal_receipt.result_truncated === response.result.truncated;
  if (!range || index + 1 >= range.end || !admitted(lost) || !admitted(repeated)
    || canonicalJson(lost.response) !== canonicalJson({ ok: false, error_code: 'eval_wait_response_lost', message: 'cursor_wait response unavailable' })
    || !terminal(lost.withheld_response) || !terminal(repeated.response)
    || canonicalJson(lost.withheld_response.result) !== canonicalJson(repeated.response.result)
    || canonicalJson(lost.withheld_response.terminal_receipt) !== canonicalJson(repeated.response.terminal_receipt)) return null;
  return { lost_call_index: index + 1, repeated_call_index: index + 2 };
}

export function evaluateScenario(scenario, { trace = [], callbacks = [], effects = [], captured_finals: capturedFinals, actual_task_outcome: actualTaskOutcome, transcript } = {}) {
  if (scenario?.scenario_kind !== 'programmed') throw new TypeError('pure oracle accepts only programmed scenarios');
  const mismatches = [];
  const add = (code) => { if (!mismatches.includes(code)) mismatches.push(code); };
  if (!Array.isArray(trace) || !Array.isArray(callbacks) || !Array.isArray(effects)) throw new TypeError('oracle observations must be arrays');
  const reports = reportEvaluation(scenario, capturedFinals);
  if (reports.invalid) {
    return {
      assertion_outcome: 'not_observed',
      actual_task_outcome: actualTaskOutcome ?? 'not_observed',
      reported_task_outcome: 'not_checked',
      eval_status: 'integration_failure',
      failure_stage: 'inspection',
      error_code: 'capture_invalid',
      mismatches: ['invalid-report-evidence'],
      recovered_calls: [],
      components: {
        evidence_admission: 'fail', execution_trace: 'not_applicable', continuation_handoff: 'not_applicable',
        outcome_report: 'not_checked', interaction_report: 'not_applicable', safety_disclosure: 'not_checked',
      },
      report_checks: reports.diagnostics,
    };
  }
  const recoveredCalls = findRecoveredCalls(transcript, capturedFinals.length);
  const waitLossRecovery = findTerminalWaitLossRecovery(scenario, transcript);
  if (scenario.harness_faults?.includes('lose-terminal-wait-response-once')
    ? !waitLossRecovery
    : transcript?.calls?.some((call) => call && Object.hasOwn(call, 'withheld_response'))) add('terminal-wait-loss-recovery-mismatch');
  const recoveredIndices = new Set(recoveredCalls.map(({ failed_call_index: index }) => index));
  if (transcript?.calls?.some((call, index) => call?.response?.ok === false
    && (['unknown_session', 'unknown_turn'].includes(call.response.error_code)
      || (SESSION_LOOKUP_TOOLS.has(call.tool) && LOCAL_RECOVERY_ERRORS.has(call.response.error_code)))
    && !recoveredIndices.has(index + 1))) add('unrecovered-call');
  const planned = new Map(scenario.program.steps.map((step) => [step.step_id, step]));
  const pendingSeen = new Set();
  const pendingRequestIds = new Map();
  let sessionId;
  const sessionIds = new Set();
  let turnId;
  const turnIds = new Set();
  const initialAuthority = (scenario.prior_authority?.allowed_actions || []).map(({ operation, path }) => `${operation}\0${path}`);
  let lastAuthorityTurnIndex = 0;
  let closed = false;
  for (const observation of trace) {
    const turnScoped = !observation.kind?.startsWith('session.');
    if ((observation.kind !== 'session.start-rejected' && (typeof observation.session_id !== 'string' || !observation.session_id))
      || (turnScoped && (typeof observation.turn_id !== 'string' || !observation.turn_id))
      || ((observation.kind?.startsWith('pending.') || observation.kind?.startsWith('answer.'))
        && (typeof observation.request_id !== 'string' || !observation.request_id))) add('id-mismatch');
    if (closed && !['session.resumed', 'session.resume-failed', 'session.close-attempted'].includes(observation.kind)) add('operation-after-close');
    if (observation.kind === 'session.close-attempted' || observation.kind === 'session.tombstoned'
      || (observation.kind === 'session.mode-change-failed' && observation.error_code === 'mode_timeout')) closed = true;
    if (['session.resumed', 'session.resume-failed'].includes(observation.kind)) {
      if (sessionIds.has(observation.session_id)) add('id-mismatch');
      closed = observation.kind === 'session.resume-failed'; sessionId = observation.session_id; turnId = undefined; sessionIds.add(observation.session_id);
    }
    if (observation.kind === 'session.allocated' && observation.session_id) { sessionId ??= observation.session_id; sessionIds.add(observation.session_id); }
    if (observation.kind === 'turn.started' && observation.turn_id) {
      if (turnIds.has(observation.turn_id)) add('id-mismatch');
      turnIds.add(observation.turn_id);
      turnId = observation.turn_id;
    }
    if (sessionId && observation.session_id && observation.session_id !== sessionId) add('id-mismatch');
    if (turnId && observation.kind !== 'turn.started' && observation.turn_id && observation.turn_id !== turnId) add('id-mismatch');
    if (observation.kind?.startsWith('pending.')) {
      pendingSeen.add(observation.step_id);
      if (observation.request_id) pendingRequestIds.set(observation.step_id, observation.request_id);
    }
    if (observation.kind?.startsWith('answer.') && observation.kind !== 'answer.rejected-stale') {
      if (!pendingSeen.has(observation.step_id)) add('answer-before-pending');
      const requestId = pendingRequestIds.get(observation.step_id);
      if (requestId && observation.request_id && observation.request_id !== requestId) add('id-mismatch');
    }
    if (observation.kind?.startsWith('effect.file-') && planned.get(observation.step_id)?.type !== 'effect') add('unexpected-effect');
    const authorityScoped = observation.kind?.startsWith('effect.file-') || observation.kind === 'answer.permission';
    if (authorityScoped && (!Number.isSafeInteger(observation.codex_turn_index) || observation.codex_turn_index < 1
      || observation.codex_turn_index > (scenario.followups?.length || 0) + 1
      || observation.codex_turn_index < lastAuthorityTurnIndex)) {
      add('authority-mismatch');
    } else if (authorityScoped) {
      lastAuthorityTurnIndex = observation.codex_turn_index;
      const authority = new Set(initialAuthority);
      for (let followupIndex = 0; followupIndex < observation.codex_turn_index - 1; followupIndex += 1) {
        for (const action of scenario.followups?.[followupIndex]?.granted_actions || []) authority.add(`${action.operation}\0${action.path}`);
      }
      if (observation.kind?.startsWith('effect.file-')) {
        const step = planned.get(observation.step_id);
        if (step && !authority.has(`${step.operation}\0${step.path}`)) add('authority-mismatch');
      }
      if (observation.kind === 'answer.permission' && observation.decision === 'allow-once') {
        const step = planned.get(observation.step_id);
        if (step && !authority.has(`${step.action.operation}\0${step.action.path}`)) add('authority-mismatch');
      }
    }
    if (observation.kind === 'prompt.contract' && observation.matched !== true) add('prompt-contract-mismatch');
    if (observation.kind === 'turn.wait-response-recovered' && (!waitLossRecovery
      || observation.lost_call_index !== waitLossRecovery.lost_call_index
      || observation.repeated_call_index !== waitLossRecovery.repeated_call_index)) add('terminal-wait-loss-recovery-mismatch');
  }
  let segmentStarted = false;
  let segmentTerminal = false;
  const retainedLiveIdleIsExpected = scenario.expected_trace.at(-1)?.kind === 'session.mode-recovery-status'
    && scenario.expected_trace.at(-1)?.session_state === 'live'
    && scenario.expected_trace.at(-1)?.active_turn === false;
  for (const observation of trace) {
    if (['session.allocated', 'session.resumed', 'session.resume-failed'].includes(observation.kind)) {
      if (segmentStarted && !segmentTerminal) add('missing-close-attempt');
      segmentStarted = true;
      segmentTerminal = observation.kind === 'session.resume-failed';
    }
    if (['session.close-attempted', 'session.tombstoned'].includes(observation.kind)
      || (observation.kind === 'session.mode-change-failed' && observation.error_code === 'mode_timeout')) segmentTerminal = true;
    if (retainedLiveIdleIsExpected && observation.kind === 'session.mode-recovery-status'
      && observation.session_state === 'live' && observation.active_turn === false) segmentTerminal = true;
  }
  if (segmentStarted && !segmentTerminal) add('missing-close-attempt');
  if (canonicalJson(comparableTrace(trace, scenario.expected_trace)) !== canonicalJson(comparableTrace(scenario.expected_trace))) add('trace-mismatch');

  for (const step of scenario.program.steps) {
    if (!['pending', 'effect'].includes(step.type)) continue;
    const observed = callbacks.filter(({ step_id: stepId }) => stepId === step.step_id);
    if (observed.length === 0) add(step.type === 'effect' ? 'missing-effect-callback' : 'missing-callback');
    else {
      if (observed.length !== 1 || observed[0].callback_id !== step.callback_id) add(step.type === 'effect' ? 'effect-callback-id-mismatch' : 'id-mismatch');
      if (canonicalJson(observed[0] && { step_id: observed[0].step_id, callback_id: observed[0].callback_id, kind: observed[0].kind, ...(observed[0].option_ids ? { option_ids: observed[0].option_ids } : {}), ...(observed[0].decision ? { decision: observed[0].decision } : {}), ...(observed[0].outcome ? { outcome: observed[0].outcome } : {}) }) !== canonicalJson(expectedCallback(step))) add(step.type === 'effect' ? 'effect-callback-error' : 'callback-mismatch');
    }
    if (step.type === 'effect') {
      const matching = effects.filter(({ step_id: stepId }) => stepId === step.step_id);
      const expectedKind = `effect.file-${step.operation === 'read' ? 'read' : 'written'}`;
      if (matching.length !== 1 || matching[0].callback_id !== step.callback_id || matching[0].kind !== expectedKind) add('missing-effect');
      const traceMatching = trace.filter(({ kind, step_id: stepId }) => kind === expectedKind && stepId === step.step_id);
      if (traceMatching.length !== 1) add('missing-effect');
    }
  }
  if (effects.some(({ step_id: stepId }) => planned.get(stepId)?.type !== 'effect')) add('unexpected-effect');
  if (actualTaskOutcome !== scenario.expected_actual_task_outcome) add('actual-outcome-mismatch');
  const interactionFailed = reports.deliveryMissing
    || reports.diagnostics.some(({ category, matched }) => category === 'interaction' && !matched);
  if (interactionFailed) add('interaction-report-mismatch');
  const continuationCodes = new Set(['answer-before-pending', 'authority-mismatch', 'callback-mismatch', 'effect-callback-error', 'effect-callback-id-mismatch', 'id-mismatch', 'missing-callback', 'missing-effect-callback']);
  const continuationApplicable = scenario.followups.length > 0 || scenario.program.steps.some(({ type }) => type === 'pending');
  const nonReportMismatches = mismatches.filter((code) => code !== 'interaction-report-mismatch');
  return {
    assertion_outcome: mismatches.length === 0 ? 'pass' : 'fail',
    recovered_calls: recoveredCalls,
    actual_task_outcome: actualTaskOutcome ?? 'not_observed',
    reported_task_outcome: reports.reportedTaskOutcome,
    eval_status: mismatches.length === 0 ? scenario.expected_enabled_eval_status : 'agent_behavior_mismatch',
    mismatches,
    components: {
      evidence_admission: 'pass',
      execution_trace: nonReportMismatches.length === 0 ? 'pass' : 'fail',
      continuation_handoff: continuationApplicable
        ? mismatches.some((code) => continuationCodes.has(code)) ? 'fail' : 'pass'
        : 'not_applicable',
      outcome_report: 'not_checked',
      interaction_report: interactionFailed ? 'fail' : 'pass',
      safety_disclosure: 'not_checked',
    },
    report_checks: reports.diagnostics,
  };
}
