import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const golden = new URL('./fixtures/codex-app-server-v01521.golden.json', import.meta.url);
const captureGolden = new URL('./fixtures/codex-app-server-v01534.golden.json', import.meta.url);

test('versioned golden fixes the admitted persistent-turn and skill-load surface', async () => {
  const contract = JSON.parse(await readFile(golden, 'utf8'));
  assert.deepEqual(contract.methods, ['initialize', 'notifications/initialized', 'skills/list', 'thread/start', 'thread/resume', 'thread/archive', 'turn/start', 'mcpServer/elicitation/request']);
  assert.deepEqual(contract.server_request, { method: 'mcpServer/elicitation/request', response: { action: 'accept | decline | cancel' } });
  assert.deepEqual(contract.skill_load_evidence, ['name', 'path', 'plugin_id', 'enabled']);
  assert.deepEqual(contract.credential_free_mcp_route, {
    model_metadata: { slug: 'qwen2.5-coder:7b', supports_search_tool: false },
    provider_capability: { namespace_tools: true }, model_visible_tool: { type: 'namespace' },
    loaded_call: { type: 'function_call', fields: ['namespace', 'name', 'arguments', 'call_id'], namespace_source: 'declared_namespace' },
    confirmed_sequence: ['cursor_delegate', 'cursor_wait', 'cursor_close_session'],
    reported_outcome_evidence: { turn_status: 'completed', turn_identity: 'exact turn/start id',
      agent_message_phase: ['commentary', 'final_answer', null],
      selection: 'last final_answer; otherwise last phase-null message in the exact terminal turn', terminal_text: 'CURSOR_EVAL_OK' },
    unrelated_features: ['tool_search', 'tool_suggest', 'deferred_executor', 'deferred_tool_world_state'],
    unsupported_config_keys: ['tools.deferred_namespaces'],
  });
  assert.deepEqual(contract.turn_start_input, [
    { type: 'text', fields: ['text', 'text_elements'] },
    { type: 'skill', fields: ['name', 'path'] },
    { type: 'mention', fields: ['name', 'path'], path_prefix: 'plugin://' },
  ]);
});

test('current versioned golden fixes the paginated final-capture surface', async () => {
  const contract = JSON.parse(await readFile(captureGolden, 'utf8'));
  assert.equal(contract.codex_version, 'codex-cli 0.153.4');
  assert.match(contract.executable_sha256, /^[a-f0-9]{64}$/);
  assert.equal(contract.executable_bytes, 220585024);
  assert.equal(Object.keys(contract.generated_schema_sha256).length, 8);
  assert.equal(Object.values(contract.generated_schema_sha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)), true);
  assert.deepEqual(contract.capture_methods, ['thread/turns/list', 'thread/items/list']);
  assert.deepEqual(contract.turns_list, {
    params: ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView'],
    response: ['data', 'nextCursor', 'backwardsCursor'],
    terminal_statuses: ['completed', 'interrupted', 'failed'],
  });
  assert.deepEqual(contract.items_list, {
    params: ['threadId', 'turnId', 'cursor', 'limit', 'sortDirection'],
    response: ['data', 'nextCursor', 'backwardsCursor'], entry: ['turnId', 'item'],
  });
  assert.deepEqual(contract.agent_message, {
    type: 'agentMessage', fields: ['id', 'text', 'phase'], phases: ['commentary', 'final_answer', null],
    selection: 'last final_answer; otherwise last phase-null message in the exact terminal turn',
  });
  assert.deepEqual(contract.capture_evidence, {
    fields: ['text', 'turn_id', 'turn_status', 'phase', 'source', 'completeness', 'error_code'],
    source: 'thread/items/list', completeness: ['complete', 'confirmed_missing', 'incomplete'], max_text_bytes: 1_000_000,
  });
});
