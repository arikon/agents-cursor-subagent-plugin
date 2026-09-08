import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CodexAppServerClient } from '../scripts/codex-app-server-client.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));

function deterministicCaptureClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (delayMs) => { current += delayMs; },
  };
}

function positionedCaptureTimeoutClock(...readings) {
  let index = 0;
  return {
    now: () => readings[Math.min(index++, readings.length - 1)],
    sleep: async () => { throw new Error('positioned capture timeout must not poll'); },
  };
}
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

test('app-server client normalizes positive installed-skill evidence', async () => {
  const installedBytes = Buffer.from('exact installed skill\n');
  const client = new CodexAppServerClient(process.execPath, [fake], process.env, {
    readSkillFile: async (path) => {
      assert.equal(path, '/installed/skills/cursor-subagent/SKILL.md');
      return installedBytes;
    },
  });
  try {
    assert.equal((await client.initialize()).userAgent, 'fake');
    assert.deepEqual(await client.skillLoadEvidence('/fixture', 'agents-cursor-subagent-plugin:cursor-subagent'), {
      name: 'agents-cursor-subagent-plugin:cursor-subagent', path: '/installed/skills/cursor-subagent/SKILL.md',
      plugin_id: 'agents-cursor-subagent-plugin@personal', enabled: true,
      content_sha256: createHash('sha256').update(installedBytes).digest('hex'),
      content_bytes: installedBytes.length,
    });
  } finally { await client.close(); }
});

test('app-server client accepts text content when collecting installed-skill evidence', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], process.env, {
    readSkillFile: async () => 'installed text',
  });
  try {
    await client.initialize();
    const evidence = await client.skillLoadEvidence('/fixture', 'agents-cursor-subagent-plugin:cursor-subagent');
    assert.equal(evidence.content_bytes, Buffer.byteLength('installed text'));
    assert.equal(evidence.content_sha256, createHash('sha256').update('installed text').digest('hex'));
  } finally { await client.close(); }
});

test('app-server client preserves diagnostics and a missing optional plugin identity', async () => {
  const server = `
    const readline = require('node:readline');
    process.stderr.write('adapter diagnostic');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.method === 'notifications/initialized') return;
      const result = request.method === 'initialize'
        ? { userAgent: 'inline' }
        : { data: [{ cwd: request.params.cwds[0], skills: [{ name: 'skill', path: '/skill.md', enabled: true }] }] };
      if (request.method === 'initialize') process.stdout.write(JSON.stringify({ method: 'adapter/ready' }) + '\\n');
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
    });`;
  const client = new CodexAppServerClient(process.execPath, ['-e', server], process.env, {
    readSkillFile: async () => 'skill contents',
  });
  try {
    await client.initialize();
    const evidence = await client.skillLoadEvidence('/fixture', 'skill');
    assert.equal(evidence.plugin_id, null);
    assert.equal(client.notifications.length, 1);
    assert.deepEqual(
      { method: client.notifications[0].method, params: client.notifications[0].params },
      { method: 'adapter/ready', params: null },
    );
    assert.equal(Number.isSafeInteger(client.notifications[0].at_ms), true);
    assert.equal(client.clientRequests.some(({ method }) => method === 'initialize'), true);
    assert.equal(client.clientRequests.every((request) => !Object.hasOwn(request, 'params')), true);
    assert.equal(Buffer.concat(client.stderr).toString('utf8'), 'adapter diagnostic');
  } finally { await client.close(); }
});

test('app-server client starts an isolated thread through the public request contract', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake]);
  try {
    await client.initialize();
    assert.deepEqual(await client.startThread({ ephemeral: true }), { thread: { id: 'isolated-thread' } });
  } finally { await client.close(); }
});

test('app-server client captures an exact final across paginated turns and items', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-paginated' });
  try {
    await client.initialize();
    assert.deepEqual(await client.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: 'PAGINATED FINAL', turn_id: 'evaluated-turn', turn_status: 'completed', phase: 'final_answer',
      source: 'thread/items/list', completeness: 'complete', error_code: null,
    });
    assert.deepEqual(client.clientRequests.map(({ method }) => method),
      ['initialize', 'thread/turns/list', 'thread/turns/list', 'thread/items/list', 'thread/items/list']);
  } finally { await client.close(); }
});

test('app-server client waits for a late indexed final', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-late' }, deterministicCaptureClock());
  try {
    await client.initialize();
    assert.deepEqual(await client.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 100, pollIntervalMs: 10 }), {
      text: 'LATE FINAL', turn_id: 'evaluated-turn', turn_status: 'completed', phase: 'final_answer',
      source: 'thread/items/list', completeness: 'complete', error_code: null,
    });
  } finally { await client.close(); }
});

test('app-server client distinguishes a confirmed missing final from an empty final', async () => {
  const missing = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-absent' }, deterministicCaptureClock());
  const empty = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-empty' });
  try {
    await Promise.all([missing.initialize(), empty.initialize()]);
    assert.deepEqual(await missing.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 200, pollIntervalMs: 200 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: 'completed', phase: null,
      source: 'thread/items/list', completeness: 'confirmed_missing', error_code: null,
    });
    assert.deepEqual(await empty.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: '', turn_id: 'evaluated-turn', turn_status: 'completed', phase: 'final_answer',
      source: 'thread/items/list', completeness: 'complete', error_code: null,
    });
  } finally { await Promise.all([missing.close(), empty.close()]); }
});

test('app-server client records the admitted legacy null phase', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-legacy' });
  try {
    await client.initialize();
    assert.deepEqual(await client.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: 'LEGACY FINAL', turn_id: 'evaluated-turn', turn_status: 'completed', phase: null,
      source: 'thread/items/list', completeness: 'complete', error_code: null,
    });
  } finally { await client.close(); }
});

test('app-server client keeps nonterminal and corrupt extraction incomplete', async () => {
  const incomplete = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-incomplete' }, deterministicCaptureClock());
  const corrupt = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-corrupt' });
  try {
    await Promise.all([incomplete.initialize(), corrupt.initialize()]);
    assert.deepEqual(await incomplete.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 100, pollIntervalMs: 100 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: 'inProgress', phase: null,
      source: 'thread/turns/list', completeness: 'incomplete', error_code: 'turn_not_terminal',
    });
    assert.deepEqual(await corrupt.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: null, phase: null,
      source: 'thread/turns/list', completeness: 'incomplete', error_code: 'invalid_turns_response',
    });
  } finally { await Promise.all([incomplete.close(), corrupt.close()]); }
});

test('app-server client returns exact long text and rejects a pagination cursor cycle', async () => {
  const long = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-long' });
  const cycle = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-cycle' });
  try {
    await Promise.all([long.initialize(), cycle.initialize()]);
    const captured = await long.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 });
    assert.equal(captured.text, 'x'.repeat(100_000));
    assert.equal(captured.completeness, 'complete');
    assert.deepEqual(await cycle.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: 'completed', phase: null,
      source: 'thread/items/list', completeness: 'incomplete', error_code: 'pagination_cursor_cycle',
    });
  } finally { await Promise.all([long.close(), cycle.close()]); }
});

test('app-server client admits the exact text limit and rejects the next byte under default transport limits', async () => {
  const exact = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-limit' });
  const oversized = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-oversized' });
  try {
    await Promise.all([exact.initialize(), oversized.initialize()]);
    const captured = await exact.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 });
    assert.equal(Buffer.byteLength(captured.text), 1_000_000);
    assert.equal(captured.completeness, 'complete');
    assert.deepEqual(await oversized.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: 'completed', phase: null,
      source: 'thread/items/list', completeness: 'incomplete', error_code: 'capture_text_limit',
    });
  } finally { await Promise.all([exact.close(), oversized.close()]); }
});

test('app-server client attributes a corrupt item page to item extraction', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-corrupt-items' });
  try {
    await client.initialize();
    assert.deepEqual(await client.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: 'completed', phase: null,
      source: 'thread/items/list', completeness: 'incomplete', error_code: 'invalid_items_response',
    });
  } finally { await client.close(); }
});

test('app-server client applies one deadline to slow pages and caps the page override', async () => {
  const slow = new CodexAppServerClient(
    process.execPath,
    [fake],
    { ...process.env, FAKE_APP_SERVER_MODE: 'capture-slow' },
    { requestTimeoutMs: 120_000, ...positionedCaptureTimeoutClock(0, 900) },
  );
  const slowItems = new CodexAppServerClient(
    process.execPath,
    [fake],
    { ...process.env, FAKE_APP_SERVER_MODE: 'capture-slow-items' },
    { requestTimeoutMs: 120_000, ...positionedCaptureTimeoutClock(0, 0, 900) },
  );
  try {
    await Promise.all([slow.initialize(), slowItems.initialize()]);
    assert.deepEqual(await slow.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: null, phase: null,
      source: 'thread/turns/list', completeness: 'incomplete', error_code: 'capture_timeout',
    });
    assert.deepEqual(await slowItems.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: 'completed', phase: null,
      source: 'thread/items/list', completeness: 'incomplete', error_code: 'capture_timeout',
    });
    await assert.rejects(
      slow.captureTurnFinal('thread', 'evaluated-turn', { pageLimit: 101 }),
      /invalid turn capture limits/,
    );
    await assert.rejects(slow.captureTurnFinal('', 'evaluated-turn'), /invalid turn capture identity/);
    await assert.rejects(slow.captureTurnFinal('thread', '', {}), /invalid turn capture identity/);
    await assert.rejects(slow.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: -1 }), /invalid turn capture limits/);
    await assert.rejects(slow.captureTurnFinal('thread', 'evaluated-turn', { pollIntervalMs: -1 }), /invalid turn capture limits/);
    await assert.rejects(slow.captureTurnFinal('thread', 'evaluated-turn', { pageLimit: 0 }), /invalid turn capture limits/);
  } finally { await Promise.all([slow.close(), slowItems.close()]); }
});

test('app-server client rejects an agent message without its required id', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'capture-missing-id' });
  try {
    await client.initialize();
    assert.deepEqual(await client.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000 }), {
      text: null, turn_id: 'evaluated-turn', turn_status: 'completed', phase: null,
      source: 'thread/items/list', completeness: 'incomplete', error_code: 'invalid_items_response',
    });
  } finally { await client.close(); }
});

test('app-server client classifies bounded pagination and request failures by source', async () => {
  const cases = [
    ['capture-turn-absent', {}, 'thread/turns/list', 'turn_not_found'],
    ['capture-turn-cycle', {}, 'thread/turns/list', 'pagination_cursor_cycle'],
    ['capture-turn-page-limit', { pageLimit: 1 }, 'thread/turns/list', 'capture_page_limit'],
    ['capture-item-page-limit', { pageLimit: 1 }, 'thread/items/list', 'capture_page_limit'],
    ['capture-turn-error', {}, 'thread/turns/list', 'request_failed'],
    ['capture-item-error', {}, 'thread/items/list', 'request_failed'],
    ['capture-invalid-turn-entry', {}, 'thread/turns/list', 'invalid_turns_response'],
    ['capture-wrong-item-turn', {}, 'thread/items/list', 'invalid_items_response'],
  ];
  for (const [mode, options, source, errorCode] of cases) {
    const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: mode });
    try {
      await client.initialize();
      const captured = await client.captureTurnFinal('thread', 'evaluated-turn', { timeoutMs: 1_000, ...options });
      assert.equal(captured.completeness, 'incomplete', mode);
      assert.equal(captured.source, source, mode);
      assert.equal(captured.error_code, errorCode, mode);
    } finally { await client.close(); }
  }
});

test('app-server client sends the admitted explicit skill input', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake]);
  try {
    await client.initialize();
    await assert.rejects(client.startTurn({ threadId: 'thread', text: 'delegate', skill: { name: 'cursor-subagent', path: '/installed/SKILL.md' }, pluginName: 'cursor-plugin' }), /unknown method/);
    assert.throws(() => client.startTurn({ threadId: 'thread', text: 'delegate', skill: { name: 'cursor-subagent' } }), /invalid versioned turn input/);
  } finally { await client.close(); }
});

test('app-server client archives an isolated eval thread before transport close', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake]);
  try {
    await client.initialize();
    await assert.doesNotReject(client.archiveThread('isolated-thread'));
    await assert.rejects(client.archiveThread(''), /invalid thread id/);
  } finally { await client.close(); }
});

test('app-server client completes a turn around notifications and an admitted elicitation', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'elicitation' }, {
    onServerRequest: ({ method, params }) => {
      assert.equal(method, 'mcpServer/elicitation/request');
      assert.equal(params.serverName, 'cursor-subagent');
      assert.equal(params._meta.codex_approval_kind, 'mcp_tool_call');
      return { action: 'accept' };
    },
  });
  try {
    await client.initialize();
    const result = await client.startTurn({ threadId: 'thread', text: 'delegate', skill: { name: 'cursor-subagent', path: '/installed/SKILL.md' }, pluginName: 'cursor-plugin' });
    assert.deepEqual(result, { turn: { id: 'turn' } });
  } finally { await client.close(); }
});

test('app-server client normalizes omitted server-request params to null', async () => {
  const server = `
    const readline = require('node:readline');
    let initialize;
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        initialize = message.id;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'server-request', method: 'adapter/confirm' }) + '\\n');
      } else if (message.id === 'server-request') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: initialize, result: { accepted: message.result.accepted } }) + '\\n');
      }
    });`;
  const client = new CodexAppServerClient(process.execPath, ['-e', server], process.env, {
    onServerRequest: ({ method, params }) => {
      assert.equal(method, 'adapter/confirm');
      assert.equal(params, null);
      return { accepted: true };
    },
  });
  try {
    assert.deepEqual(await client.initialize(), { accepted: true });
    assert.deepEqual(client.serverRequests, [{ method: 'adapter/confirm', id: 'server-request', params: null }]);
  } finally { await client.close(); }
});

test('app-server client serializes a server-request handler failure as JSON-RPC error', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'elicitation-handler-error' }, {
    onServerRequest: async () => { throw new Error('denied by test'); },
  });
  try {
    await client.initialize();
    assert.deepEqual(
      await client.startTurn({ threadId: 'thread', text: 'delegate', skill: { name: 'cursor-subagent', path: '/installed/SKILL.md' }, pluginName: 'cursor-plugin' }),
      { turn: { id: 'turn-error-confirmed' } },
    );
  } finally { await client.close(); }
});

test('app-server client denies an unsupported server request by default', async () => {
  const client = new CodexAppServerClient(
    process.execPath,
    [fake],
    { ...process.env, FAKE_APP_SERVER_MODE: 'elicitation-handler-error' },
  );
  try {
    await client.initialize();
    await assert.rejects(
      client.startTurn({ threadId: 'thread', text: 'delegate', skill: { name: 'cursor-subagent', path: '/installed/SKILL.md' }, pluginName: 'cursor-plugin' }),
      /unsupported server request/,
    );
  } finally { await client.close(); }
});

test('app-server client rejects absent skill evidence', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], process.env, { readSkillFile: async () => Buffer.alloc(0) });
  try {
    await client.initialize();
    await assert.rejects(client.skillLoadEvidence('/fixture', 'missing'), /required skill is not loaded/);
  } finally { await client.close(); }
});

test('app-server client rejects catalog evidence when installed skill bytes are unavailable', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], process.env, {
    readSkillFile: async () => { throw new Error('missing'); },
  });
  try {
    await client.initialize();
    await assert.rejects(client.skillLoadEvidence('/fixture', 'agents-cursor-subagent-plugin:cursor-subagent'), /loaded skill content is unreadable/);
  } finally { await client.close(); }
});

test('app-server client rejects an invalid skills catalog response', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'invalid-skills-list' });
  try {
    await client.initialize();
    await assert.rejects(client.skillLoadEvidence('/fixture', 'any'), /invalid skills\/list response/);
  } finally { await client.close(); }
});

test('app-server client ignores malformed and unrelated frames before a valid response', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'protocol-noise' });
  try {
    assert.equal((await client.initialize()).userAgent, 'fake-after-noise');
  } finally { await client.close(); }
});

test('app-server client uses a stable fallback for an error without a message', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'empty-error' });
  try { await assert.rejects(client.initialize(), /Codex app-server request failed/); }
  finally { await client.close(); }
});

test('app-server client rejects a request when the server exits before responding', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'exit-on-thread-start' }, { closeGraceMs: 10, killGraceMs: 10 });
  try {
    await client.initialize();
    await assert.rejects(client.startThread({}), /exited \(7\)/);
  } finally { await client.close(); }
});

test('app-server client rejects a request issued after its transport has exited', async () => {
  const client = new CodexAppServerClient(
    process.execPath,
    ['-e', 'process.exit(0)'],
    process.env,
    { closeGraceMs: 10, killGraceMs: 10 },
  );
  await once(client.child, 'close');
  await assert.rejects(client.startThread({}), /write after end|destroyed|closed|EPIPE/i);
  await client.close();
});

test('app-server client rejects spawn failure', async () => {
  const missing = new CodexAppServerClient('/definitely/missing-codex');
  await assert.rejects(missing.initialize(), /ENOENT|exited/);
  await missing.close();
});

test('app-server client rejects a timed-out request', async () => {
  const timeout = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'timeout' }, { requestTimeoutMs: 10, readSkillFile: async () => Buffer.alloc(0) });
  try { await assert.rejects(timeout.skillLoadEvidence('/fixture', 'any'), /timed out/); } finally { await timeout.close(); }
});

test('app-server client rejects aggregate output overflow', async () => {
  const overflow = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'overflow' }, { outputLimit: 64 });
  try { await assert.rejects(overflow.initialize(), /output limit/); } finally { await overflow.close(); }
});

test('app-server client closes a cooperative process gracefully', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake]);
  await client.close();
});

test('app-server client escalates shutdown when the process ignores TERM', { timeout: 1_000 }, async () => {
  const hung = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'hang-close' }, { closeGraceMs: 10, killGraceMs: 10, closeConfirmMs: 100 });
  let observedClose = false;
  hung.child.once('close', () => { observedClose = true; });
  await hung.close();
  assert.equal(observedClose, true);
  assert.ok(hung.child.exitCode !== null || hung.child.signalCode !== null);
});

test('app-server client rejects shutdown when close is not observed after SIGKILL', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake]);
  const spawned = client.child;
  spawned.kill('SIGKILL');
  if (spawned.exitCode === null && spawned.signalCode === null) await once(spawned, 'close');
  const inert = new EventEmitter();
  inert.stdin = { end() {} };
  inert.kill = () => true;
  inert.exitCode = null;
  inert.signalCode = null;
  client.child = inert;
  client.closeGraceMs = 1;
  client.killGraceMs = 1;
  client.closeConfirmMs = 5;
  await assert.rejects(client.close(), /did not close after SIGKILL/);
  await assert.rejects(client.close(), /did not close after SIGKILL/);
});

test('app-server client rejects requests after shutdown', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake]);
  await client.close();
  await assert.rejects(client.startThread({}), /Codex app-server is closed/);
});

test('app-server client shutdown is idempotent', async () => {
  const client = new CodexAppServerClient(process.execPath, [fake]);
  await client.close();
  await assert.doesNotReject(client.close());
});
