import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateTokenUsage, assertEvalTokenUsageV1, buildEvalTokenUsage, collectCodexSessionUsage,
  cursorSessionsFromSidecar, emptyEvalTokenUsage, emptyTokenCounts, makeUsageSession, makeUsageTurn,
  mergeEvalTokenUsage, parseCodexBreakdown, parseCodexTurnUsage, parseCursorBilledUsage,
  readTokenUsageFromEvidence, tokenUsageSidecarPath,
} from '../scripts/eval-token-usage.mjs';

test('Codex turn/completed camelCase usage is the billed turn owner', () => {
  assert.deepEqual(parseCodexTurnUsage({ inputTokens: 10, cachedInputTokens: 3, outputTokens: 4 }), {
    input_tokens: 10, cached_input_tokens: 3, output_tokens: 4, thought_tokens: 0, total_tokens: 14,
  });
  const sessions = collectCodexSessionUsage([
    { method: 'thread/tokenUsage/updated', params: { threadId: 'th-1', turnId: 'tu-1', tokenUsage: {
      last: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 15 },
      total: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 15 },
    } } },
    { method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed',
      usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 } } } },
  ], 'th-1');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].turns.length, 1);
  assert.equal(sessions[0].turns[0].source, 'turn/completed');
  assert.equal(sessions[0].totals.input_tokens, 12);
  assert.equal(sessions[0].totals.output_tokens, 5);
});

test('Codex cumulative snapshot is used only when no completed-turn usage exists', () => {
  const sessions = collectCodexSessionUsage([
    { method: 'thread/tokenUsage/updated', params: { threadId: 'th-2', tokenUsage: {
      total: { inputTokens: 40, cachedInputTokens: 8, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 48 },
    } } },
  ]);
  assert.equal(sessions[0].turns[0].source, 'thread/tokenUsage/updated');
  assert.equal(sessions[0].totals.thought_tokens, 2);
  assert.equal(sessions[0].totals.total_tokens, 48);
});

test('Cursor billed usage is distinct from context-window used/size', () => {
  assert.equal(parseCursorBilledUsage({ used: 53_000, size: 200_000 }), null);
  assert.deepEqual(parseCursorBilledUsage({
    inputTokens: 35, outputTokens: 12, thoughtTokens: 5, cachedReadTokens: 4, totalTokens: 56,
  }), { input_tokens: 35, cached_input_tokens: 4, output_tokens: 12, thought_tokens: 5, total_tokens: 56 });
});

test('eval token usage aggregates Codex and Cursor sessions without inventing Cursor spend', () => {
  const usage = buildEvalTokenUsage({
    notifications: [{ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'tu-1',
      usage: { inputTokens: 8, cachedInputTokens: 1, outputTokens: 2 } } } }],
    threadId: 'th-1',
    cursorSidecar: { schema_version: 1, sessions: [{ session_id: 'S1', reporting: 'not_reported', turns: [] }] },
  });
  assert.equal(usage.reporting.codex, 'provider');
  assert.equal(usage.reporting.cursor, 'not_reported');
  assert.equal(usage.totals.codex.input_tokens, 8);
  assert.equal(usage.totals.cursor.total_tokens, 0);
  assert.equal(usage.totals.combined.input_tokens, 8);
  const merged = mergeEvalTokenUsage([usage, usage]);
  assert.equal(merged.totals.combined.input_tokens, 16);
  assert.equal(merged.sessions.length, 4);
  assert.equal(tokenUsageSidecarPath('/tmp/evidence/mcp.json'), '/tmp/evidence/token-usage.json');
  assert.deepEqual(readTokenUsageFromEvidence({}), emptyEvalTokenUsage());
  assert.throws(() => assertEvalTokenUsageV1({ ...emptyEvalTokenUsage(), extra: true }), /invalid contract/);
  assert.deepEqual(aggregateTokenUsage([]).totals.combined, emptyTokenCounts());
  assert.equal(parseCodexTurnUsage(null), null);
  assert.equal(parseCodexTurnUsage({ inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }), null);
  assert.equal(mergeEvalTokenUsage(Array.from({ length: 3 }, () => usage)).sessions.length, 6);
});

test('Codex usage ignores other threads, missing turn usage, and snapshot-only last without turnId', () => {
  assert.equal(parseCodexTurnUsage({}), null);
  assert.deepEqual(parseCodexBreakdown({
    inputTokens: 7, cachedInputTokens: 1, outputTokens: 2, totalTokens: 9,
  }), {
    input_tokens: 7, cached_input_tokens: 1, output_tokens: 2, thought_tokens: 0, total_tokens: 9,
  });
  assert.equal(makeUsageTurn('tu', null, 'turn/completed'), null);
  const sessions = collectCodexSessionUsage([
    { method: 'turn/completed', params: { threadId: 'other', turn: { id: 'tu-x', usage: { inputTokens: 9, cachedInputTokens: 0, outputTokens: 1 } } } },
    { method: 'turn/completed', params: { threadId: 'wanted', turn: { id: 'tu-empty' } } },
    { method: 'thread/tokenUsage/updated', params: { threadId: 'other', tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2 } } } },
    { method: 'thread/tokenUsage/updated', params: { threadId: 'wanted', tokenUsage: {
      last: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 1, totalTokens: 4 },
      total: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 1, totalTokens: 4 },
    } } },
  ], 'wanted');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_id, 'wanted');
  assert.equal(sessions[0].turns.length, 1);
  assert.equal(sessions[0].turns[0].turn_id, null);
  assert.equal(sessions[0].reporting, 'provider');
  assert.equal(collectCodexSessionUsage(undefined, 'empty-thread')[0].reporting, 'not_reported');
  assert.equal(tokenUsageSidecarPath(''), null);
  assert.equal(parseCursorBilledUsage([]), null);
  assert.equal(makeUsageSession('codex', undefined, []).session_id, null);
  assert.deepEqual(aggregateTokenUsage(null).sessions, []);
  const noThreadField = collectCodexSessionUsage([
    { method: 'turn/completed', params: { turn: { id: 'tu-local', usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } } } },
  ], 'wanted');
  assert.equal(noThreadField[0].session_id, 'wanted');
  assert.equal(mergeEvalTokenUsage([null, {}]).sessions.length, 0);
});

test('Cursor sidecar and optional billed fields do not invent spend', () => {
  assert.deepEqual(parseCursorBilledUsage({ inputTokens: 5, outputTokens: 2 }), {
    input_tokens: 5, cached_input_tokens: 0, output_tokens: 2, thought_tokens: 0, total_tokens: 7,
  });
  const fromAlias = cursorSessionsFromSidecar({
    schema_version: 1,
    sessions: [{ cursor_session_id: 'cs-1' }],
  });
  assert.equal(fromAlias[0].session_id, 'cs-1');
  assert.equal(fromAlias[0].reporting, 'not_reported');
  assert.deepEqual(cursorSessionsFromSidecar({ schema_version: 2, sessions: [] }), []);
  const usage = readTokenUsageFromEvidence({
    token_usage: buildEvalTokenUsage({ notifications: [], threadId: 'th-empty' }),
  });
  assert.equal(usage.reporting.codex, 'not_reported');
  assert.equal(usage.sessions[0].session_id, 'th-empty');
  assert.equal(mergeEvalTokenUsage(undefined).sessions.length, 0);
  const broken = emptyEvalTokenUsage();
  broken.totals.codex = { input_tokens: 0 };
  assert.throws(() => assertEvalTokenUsageV1(broken), /invalid contract/);
});
