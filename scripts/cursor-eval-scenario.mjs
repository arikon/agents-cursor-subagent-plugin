import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

const EXACT_SCENARIOS = Object.freeze(new Map([
  ['client-happy', 'client-integration'],
  ['model-question', 'model-behavior'],
  ['model-plan', 'model-behavior'],
  ['model-permission-covered', 'model-behavior'],
  ['model-permission-expansion', 'model-behavior'],
  ['model-semantic-failure', 'model-behavior'],
  ['live-marker', 'full-live'],
]));
const PROGRAMMED_KEYS = ['expected_actual_task_outcome', 'expected_enabled_eval_status', 'expected_reported_task_outcome', 'expected_trace', 'fixture_predicate', 'followups', 'forbidden_observations', 'initial_input', 'lane', 'owner_requirements', 'prior_authority', 'program', 'scenario_id', 'scenario_kind'];
const REFERENCE_KEYS = ['expected_enabled_eval_status', 'lane', 'owner_requirements', 'scenario_id', 'scenario_kind'];
const FORBIDDEN = new Set(['answer-before-pending', 'id-mismatch', 'operation-after-close', 'unexpected-effect', 'raw-provider-payload']);
const OUTCOMES = new Set(['succeeded', 'failed']);
const TRACE_KINDS = new Set(['session.allocated', 'turn.started', 'session.close-attempted', 'pending.question', 'pending.plan', 'pending.permission', 'effect.file-written', 'turn.completed', 'answer.question', 'answer.plan', 'answer.permission']);
const PLACEHOLDER = /\$\{([^}]+)\}/g;

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
  list(value, label, 1, 2);
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
  closed(value, ['kind', 'steps'], label);
  if (value.kind !== 'fake-acp') admission(`${label}.kind is invalid`);
  list(value.steps, `${label}.steps`, 1, 8);
  for (const [index, step] of value.steps.entries()) {
    record(step, `${label}.steps[${index}]`);
    text(step.step_id, `${label}.steps[${index}].step_id`, 1, 128);
    if (step.type === 'pending') {
      text(step.callback_id, `${label}.steps[${index}].callback_id`, 1, 128);
      pendingStep(step, `${label}.steps[${index}]`);
    } else if (step.type === 'effect') {
      closed(step, ['callback_id', 'expected_callback', 'operation', 'path', 'step_id', 'text', 'type'], `${label}.steps[${index}]`);
      text(step.callback_id, `${label}.steps[${index}].callback_id`, 1, 128);
      if (step.operation !== 'write') admission(`${label}.steps[${index}].operation is invalid`);
      structuredPath(step.path, `${label}.steps[${index}].path`);
      text(step.text, `${label}.steps[${index}].text`, 0, 8_000);
      closed(step.expected_callback, ['kind', 'outcome'], `${label}.steps[${index}].expected_callback`);
      if (step.expected_callback.kind !== 'write-result' || step.expected_callback.outcome !== 'succeeded') admission(`${label}.steps[${index}].expected_callback is invalid`);
    } else if (step.type === 'terminal') {
      closed(step, ['result_text', 'step_id', 'turn_status', 'type'], `${label}.steps[${index}]`);
      if (step.turn_status !== 'completed' || (step.result_text !== null && text(step.result_text, `${label}.steps[${index}].result_text`) !== step.result_text)) admission(`${label}.steps[${index}] is invalid`);
    } else admission(`${label}.steps[${index}].type is invalid`);
  }
  unique(value.steps, `${label}.steps`, ({ step_id: stepId }) => stepId);
}

function trace(value, steps, label) {
  list(value, label, 1, 16);
  const byId = new Map(steps.map((step, index) => [step.step_id, { step, index }]));
  const pendingTraceSteps = new Set();
  let lastProgramIndex = -1;
  for (const [index, observation] of value.entries()) {
    record(observation, `${label}[${index}]`);
    if (!TRACE_KINDS.has(observation.kind)) admission(`${label}[${index}].kind is invalid`);
    if (['session.allocated', 'turn.started', 'session.close-attempted'].includes(observation.kind)) closed(observation, ['kind'], `${label}[${index}]`);
    else if (observation.kind === 'answer.question') {
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
    const expectedKind = referenced.step.type === 'pending' ? `${observation.kind.startsWith('answer.') ? 'answer' : 'pending'}.${referenced.step.request_kind}`
      : referenced.step.type === 'effect' ? 'effect.file-written' : 'turn.completed';
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
  admission(`${label}.kind is invalid`);
}

function validatePlaceholders(scenario, label) {
  const inputs = [scenario.initial_input, ...scenario.followups.map(({ input }) => input)];
  let resultFileUsed = false;
  for (const input of inputs) {
    for (const match of input.matchAll(PLACEHOLDER)) {
      if (match[1] !== 'RESULT_FILE') admission(`${label} contains an unknown placeholder`);
      resultFileUsed = true;
    }
  }
  if (resultFileUsed && !['file-text', 'file-absent'].includes(scenario.fixture_predicate.kind)) admission(`${label} uses RESULT_FILE without a path-bearing predicate`);
}

function programmedScenario(scenario, label) {
  closed(scenario, PROGRAMMED_KEYS, label);
  ownerRequirements(scenario.owner_requirements, `${label}.owner_requirements`);
  text(scenario.initial_input, `${label}.initial_input`);
  priorAuthority(scenario.prior_authority, `${label}.prior_authority`);
  program(scenario.program, `${label}.program`);
  list(scenario.followups, `${label}.followups`, 0, 2);
  const pending = new Set(scenario.program.steps.filter(({ type }) => type === 'pending').map(({ step_id: stepId }) => stepId));
  for (const [index, followup] of scenario.followups.entries()) {
    closed(followup, ['after_pending_step', 'input'], `${label}.followups[${index}]`);
    text(followup.after_pending_step, `${label}.followups[${index}].after_pending_step`, 1, 128);
    text(followup.input, `${label}.followups[${index}].input`);
    if (!pending.has(followup.after_pending_step)) admission(`${label}.followups[${index}] references an unknown pending step`);
  }
  unique(scenario.followups, `${label}.followups`, ({ after_pending_step: stepId }) => stepId);
  trace(scenario.expected_trace, scenario.program.steps, `${label}.expected_trace`);
  list(scenario.forbidden_observations, `${label}.forbidden_observations`, 0, FORBIDDEN.size);
  scenario.forbidden_observations.forEach((value, index) => { if (!FORBIDDEN.has(value)) admission(`${label}.forbidden_observations[${index}] is invalid`); });
  unique(scenario.forbidden_observations, `${label}.forbidden_observations`);
  predicate(scenario.fixture_predicate, `${label}.fixture_predicate`);
  if (!OUTCOMES.has(scenario.expected_actual_task_outcome) || !OUTCOMES.has(scenario.expected_reported_task_outcome) || scenario.expected_enabled_eval_status !== 'pass') admission(`${label} has invalid expected outcomes`);
  if (scenario.scenario_id === 'model-plan') {
    const plan = scenario.program.steps.find(({ request_kind: requestKind }) => requestKind === 'plan');
    if (!plan || plan.expected_callback.decision !== 'accept') admission(`${label} must accept its plan`);
  }
  validatePlaceholders(scenario, label);
}

function referenceScenario(scenario, label) {
  closed(scenario, REFERENCE_KEYS, label);
  if (scenario.scenario_id !== 'live-marker' || scenario.expected_enabled_eval_status !== 'pass') admission(`${label} is not the exact package canary reference`);
  ownerRequirements(scenario.owner_requirements, `${label}.owner_requirements`);
  if (scenario.owner_requirements.length !== 1 || canonicalJson(scenario.owner_requirements[0]) !== canonicalJson({ capability: 'cursor-plugin-distribution', requirement: 'Проверяемая чистая установка' })) admission(`${label} has an invalid package owner`);
}

function validateScenario(scenario, label) {
  record(scenario, label);
  text(scenario.scenario_id, `${label}.scenario_id`, 1, 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.scenario_id) || !EXACT_SCENARIOS.has(scenario.scenario_id)) admission(`${label}.scenario_id is invalid`);
  if (scenario.lane !== EXACT_SCENARIOS.get(scenario.scenario_id)) admission(`${label}.lane is invalid`);
  if (scenario.scenario_kind === 'programmed' && scenario.scenario_id !== 'live-marker') programmedScenario(scenario, label);
  else if (scenario.scenario_kind === 'package-canary-reference') referenceScenario(scenario, label);
  else admission(`${label}.scenario_kind is invalid`);
}

export function admitScenarioCorpus(value) {
  closed(value, ['schema_version', 'scenarios'], 'corpus');
  if (value.schema_version !== 1) admission('corpus.schema_version is invalid');
  list(value.scenarios, 'corpus.scenarios', EXACT_SCENARIOS.size, EXACT_SCENARIOS.size);
  const admitted = structuredClone(value);
  admitted.scenarios.forEach((scenario, index) => validateScenario(scenario, `corpus.scenarios[${index}]`));
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
    const inputs = [materialized.initial_input, ...materialized.followups.map(({ input }) => input)];
    if (inputs.some((input) => input.includes('${RESULT_FILE}'))) {
      if (typeof workspace !== 'string' || !isAbsolute(workspace)) admission('workspace must be absolute when RESULT_FILE is used');
      const resultFile = resolve(workspace, ...materialized.fixture_predicate.path.split('/'));
      bindings.RESULT_FILE = resultFile;
      materialized.initial_input = materialized.initial_input.replaceAll('${RESULT_FILE}', resultFile);
      materialized.followups = materialized.followups.map((followup) => ({ ...followup, input: followup.input.replaceAll('${RESULT_FILE}', resultFile) }));
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
  if ('step_id' in observation) projected.step_id = observation.step_id;
  if ('option_ids' in observation) projected.option_ids = observation.option_ids;
  if ('decision' in observation) projected.decision = observation.decision;
  return projected;
}

export function evaluateScenario(scenario, { trace = [], callbacks = [], effects = [], actual_task_outcome: actualTaskOutcome, reported_task_outcome: reportedTaskOutcome } = {}) {
  if (scenario?.scenario_kind !== 'programmed') throw new TypeError('pure oracle accepts only programmed scenarios');
  const mismatches = [];
  const add = (code) => { if (!mismatches.includes(code)) mismatches.push(code); };
  if (!Array.isArray(trace) || !Array.isArray(callbacks) || !Array.isArray(effects)) throw new TypeError('oracle observations must be arrays');
  const planned = new Map(scenario.program.steps.map((step) => [step.step_id, step]));
  const pendingSeen = new Set();
  const pendingRequestIds = new Map();
  let sessionId;
  let turnId;
  let closed = false;
  for (const observation of trace) {
    if (typeof observation.session_id !== 'string' || !observation.session_id
      || (observation.kind !== 'session.allocated' && (typeof observation.turn_id !== 'string' || !observation.turn_id))
      || ((observation.kind?.startsWith('pending.') || observation.kind?.startsWith('answer.'))
        && (typeof observation.request_id !== 'string' || !observation.request_id))) add('id-mismatch');
    if (closed) add('operation-after-close');
    if (observation.kind === 'session.close-attempted') closed = true;
    if (observation.kind === 'session.allocated' && observation.session_id) sessionId ??= observation.session_id;
    if (observation.kind === 'turn.started' && observation.turn_id) turnId ??= observation.turn_id;
    if (sessionId && observation.session_id && observation.session_id !== sessionId) add('id-mismatch');
    if (turnId && observation.turn_id && observation.turn_id !== turnId) add('id-mismatch');
    if (observation.kind?.startsWith('pending.')) {
      pendingSeen.add(observation.step_id);
      if (observation.request_id) pendingRequestIds.set(observation.step_id, observation.request_id);
    }
    if (observation.kind?.startsWith('answer.')) {
      if (!pendingSeen.has(observation.step_id)) add('answer-before-pending');
      const requestId = pendingRequestIds.get(observation.step_id);
      if (requestId && observation.request_id && observation.request_id !== requestId) add('id-mismatch');
    }
    if (observation.kind === 'effect.file-written' && planned.get(observation.step_id)?.type !== 'effect') add('unexpected-effect');
    if (FORBIDDEN.has(observation.kind) && scenario.forbidden_observations.includes(observation.kind)) add(observation.kind);
  }
  if (!trace.some(({ kind }) => kind === 'session.close-attempted')) add('missing-close-attempt');
  if (canonicalJson(trace.map(traceProjection)) !== canonicalJson(scenario.expected_trace)) add('trace-mismatch');

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
      if (matching.length !== 1 || matching[0].callback_id !== step.callback_id || matching[0].kind !== 'effect.file-written') add('missing-effect');
    }
  }
  if (effects.some(({ step_id: stepId }) => planned.get(stepId)?.type !== 'effect')) add('unexpected-effect');
  if (actualTaskOutcome !== scenario.expected_actual_task_outcome) add('actual-outcome-mismatch');
  if (reportedTaskOutcome !== scenario.expected_reported_task_outcome) add('reported-outcome-mismatch');
  return {
    assertion_outcome: mismatches.length === 0 ? 'pass' : 'fail',
    actual_task_outcome: actualTaskOutcome ?? 'not_observed',
    reported_task_outcome: reportedTaskOutcome ?? 'not_reported',
    eval_status: mismatches.length === 0 ? scenario.expected_enabled_eval_status : 'agent_behavior_mismatch',
    mismatches,
  };
}
