import { dirname, resolve } from 'node:path';

const COUNT_KEYS = Object.freeze(['input_tokens', 'cached_input_tokens', 'output_tokens', 'thought_tokens', 'total_tokens']);
const TURN_KEYS = Object.freeze(['turn_id', 'source', ...COUNT_KEYS]);
const SESSION_KEYS = Object.freeze(['provider', 'session_id', 'reporting', 'turns', 'totals']);
const REPORTING = new Set(['provider', 'not_reported']);
const PROVIDERS = new Set(['codex', 'cursor']);

function exactKeys(value, keys) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedId(value) {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256);
}

export function emptyTokenCounts() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thought_tokens: 0, total_tokens: 0 };
}

function addCounts(left, right) {
  const total = emptyTokenCounts();
  for (const key of COUNT_KEYS) total[key] = left[key] + right[key];
  return total;
}

function countsFrom(fields, totalFallback) {
  if (!fields) return null;
  const input_tokens = fields.input_tokens;
  const cached_input_tokens = fields.cached_input_tokens;
  const output_tokens = fields.output_tokens;
  const thought_tokens = fields.thought_tokens ?? 0;
  const total_tokens = fields.total_tokens ?? totalFallback;
  if (![input_tokens, cached_input_tokens, output_tokens, thought_tokens, total_tokens].every(nonNegativeInt)) return null;
  return { input_tokens, cached_input_tokens, output_tokens, thought_tokens, total_tokens };
}

export function parseCodexTurnUsage(usage) {
  if (!usage || Array.isArray(usage) || typeof usage !== 'object') return null;
  return countsFrom({
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    output_tokens: usage.outputTokens,
    thought_tokens: 0,
  }, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
}

export function parseCodexBreakdown(usage) {
  if (!usage || Array.isArray(usage) || typeof usage !== 'object') return null;
  return countsFrom({
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    output_tokens: usage.outputTokens,
    thought_tokens: usage.reasoningOutputTokens ?? 0,
    total_tokens: usage.totalTokens,
  }, usage.totalTokens);
}

export function parseCursorBilledUsage(usage) {
  if (!usage || Array.isArray(usage) || typeof usage !== 'object') return null;
  const input_tokens = usage.inputTokens;
  const output_tokens = usage.outputTokens;
  if (!nonNegativeInt(input_tokens) || !nonNegativeInt(output_tokens)) return null;
  const cached_input_tokens = usage.cachedReadTokens ?? 0;
  const thought_tokens = usage.thoughtTokens ?? 0;
  const total_tokens = usage.totalTokens ?? (input_tokens + output_tokens + thought_tokens);
  return countsFrom({ input_tokens, cached_input_tokens, output_tokens, thought_tokens, total_tokens }, total_tokens);
}

export function makeUsageTurn(turnId, counts, source) {
  if (!counts) return null;
  return { turn_id: turnId ?? null, source, ...counts };
}

export function makeUsageSession(provider, sessionId, turns, reporting = turns.length ? 'provider' : 'not_reported') {
  const totals = turns.reduce((sum, turn) => addCounts(sum, turn), emptyTokenCounts());
  return { provider, session_id: sessionId ?? null, reporting, turns, totals };
}

export function emptyEvalTokenUsage() {
  return {
    schema_version: 1,
    sessions: [],
    totals: { codex: emptyTokenCounts(), cursor: emptyTokenCounts(), combined: emptyTokenCounts() },
    reporting: { codex: 'not_reported', cursor: 'not_reported' },
  };
}

export function aggregateTokenUsage(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const totals = { codex: emptyTokenCounts(), cursor: emptyTokenCounts(), combined: emptyTokenCounts() };
  const reporting = { codex: 'not_reported', cursor: 'not_reported' };
  for (const session of list) {
    totals[session.provider] = addCounts(totals[session.provider], session.totals);
    totals.combined = addCounts(totals.combined, session.totals);
    if (session.reporting === 'provider') reporting[session.provider] = 'provider';
  }
  return { schema_version: 1, sessions: list, totals, reporting };
}

export function assertEvalTokenUsageV1(value) {
  if (!exactKeys(value, ['schema_version', 'sessions', 'totals', 'reporting'])
    || value.schema_version !== 1
    || !exactKeys(value.totals, ['codex', 'cursor', 'combined'])
    || !exactKeys(value.reporting, ['codex', 'cursor'])
    || !REPORTING.has(value.reporting.codex) || !REPORTING.has(value.reporting.cursor)
    || !Array.isArray(value.sessions) || value.sessions.length > 1024) {
    throw new Error('EvalTokenUsageV1 has an invalid contract');
  }
  for (const key of ['codex', 'cursor', 'combined']) {
    if (!exactKeys(value.totals[key], COUNT_KEYS) || !COUNT_KEYS.every((field) => nonNegativeInt(value.totals[key][field]))) {
      throw new Error('EvalTokenUsageV1 has an invalid contract');
    }
  }
  for (const session of value.sessions) {
    if (!exactKeys(session, SESSION_KEYS) || !PROVIDERS.has(session.provider) || !REPORTING.has(session.reporting)
      || !boundedId(session.session_id) || !Array.isArray(session.turns) || session.turns.length > 32
      || !exactKeys(session.totals, COUNT_KEYS) || !COUNT_KEYS.every((field) => nonNegativeInt(session.totals[field]))) {
      throw new Error('EvalTokenUsageV1 has an invalid contract');
    }
    for (const turn of session.turns) {
      if (!exactKeys(turn, TURN_KEYS) || !boundedId(turn.turn_id) || typeof turn.source !== 'string'
        || turn.source.length > 64 || !COUNT_KEYS.every((field) => nonNegativeInt(turn[field]))) {
        throw new Error('EvalTokenUsageV1 has an invalid contract');
      }
    }
  }
  return value;
}

export function collectCodexSessionUsage(notifications, threadId = null) {
  const byThread = new Map();
  const ensure = (id) => {
    if (!byThread.has(id)) byThread.set(id, { turns: new Map(), snapshot: null });
    return byThread.get(id);
  };
  for (const note of notifications || []) {
    if (note?.method === 'turn/completed') {
      if (threadId && note.params?.threadId && note.params.threadId !== threadId) continue;
      const usage = parseCodexTurnUsage(note.params?.turn?.usage);
      if (!usage) continue;
      const id = note.params?.threadId ?? threadId ?? 'unknown';
      const turnId = note.params?.turn?.id ?? null;
      ensure(id).turns.set(turnId ?? `completed-${ensure(id).turns.size}`, makeUsageTurn(turnId, usage, 'turn/completed'));
    }
    if (note?.method === 'thread/tokenUsage/updated') {
      if (threadId && note.params?.threadId && note.params.threadId !== threadId) continue;
      const id = note.params?.threadId ?? threadId ?? 'unknown';
      const bucket = ensure(id);
      bucket.snapshot = parseCodexBreakdown(note.params?.tokenUsage?.total);
      const turnId = note.params?.turnId ?? null;
      const last = parseCodexBreakdown(note.params?.tokenUsage?.last);
      if (last && turnId && !bucket.turns.has(turnId)) {
        bucket.turns.set(turnId, makeUsageTurn(turnId, last, 'thread/tokenUsage/updated'));
      }
    }
  }
  const sessions = [];
  for (const [sessionId, bucket] of byThread) {
    let turns = [...bucket.turns.values()];
    if (!turns.length && bucket.snapshot) turns = [makeUsageTurn(null, bucket.snapshot, 'thread/tokenUsage/updated')];
    sessions.push(makeUsageSession('codex', sessionId, turns, turns.length ? 'provider' : 'not_reported'));
  }
  if (!sessions.length && threadId) sessions.push(makeUsageSession('codex', threadId, [], 'not_reported'));
  return sessions;
}

export function tokenUsageSidecarPath(mcpEvidencePath) {
  if (typeof mcpEvidencePath !== 'string' || !mcpEvidencePath) return null;
  return resolve(dirname(mcpEvidencePath), 'token-usage.json');
}

export function cursorSessionsFromSidecar(sidecar) {
  if (!sidecar || sidecar.schema_version !== 1 || !Array.isArray(sidecar.sessions)) return [];
  return sidecar.sessions.map((session) => makeUsageSession(
    'cursor',
    session.session_id ?? session.cursor_session_id ?? null,
    Array.isArray(session.turns) ? session.turns : [],
    session.reporting === 'provider' || (Array.isArray(session.turns) && session.turns.length) ? 'provider' : 'not_reported',
  ));
}

export function buildEvalTokenUsage({ notifications = [], threadId = null, cursorSidecar = null } = {}) {
  return assertEvalTokenUsageV1(aggregateTokenUsage([
    ...collectCodexSessionUsage(notifications, threadId),
    ...cursorSessionsFromSidecar(cursorSidecar),
  ]));
}

export function mergeEvalTokenUsage(usages) {
  return assertEvalTokenUsageV1(aggregateTokenUsage((usages || []).flatMap((usage) => usage?.sessions || [])));
}

export function readTokenUsageFromEvidence(evidence) {
  if (!evidence || evidence.token_usage == null) return emptyEvalTokenUsage();
  return assertEvalTokenUsageV1(evidence.token_usage);
}
