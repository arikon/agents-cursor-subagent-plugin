import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CodexAppServerClient } from '../scripts/codex-app-server-client.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const golden = new URL('./fixtures/codex-app-server-v01521.golden.json', import.meta.url);

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
    reported_outcome_evidence: { turn_status: 'completed', turn_identity: 'exact turn/start id', agent_messages: ['CURSOR_EVAL_OK'] },
    unrelated_features: ['tool_search', 'tool_suggest', 'deferred_executor', 'deferred_tool_world_state'],
    unsupported_config_keys: ['tools.deferred_namespaces'],
  });
  assert.deepEqual(contract.turn_start_input, [
    { type: 'text', fields: ['text', 'text_elements'] },
    { type: 'skill', fields: ['name', 'path'] },
    { type: 'mention', fields: ['name', 'path'], path_prefix: 'plugin://' },
  ]);
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
    assert.deepEqual(await client.skillLoadEvidence('/fixture', 'codex-cursor-subagent-plugin:cursor-subagent'), {
      name: 'codex-cursor-subagent-plugin:cursor-subagent', path: '/installed/skills/cursor-subagent/SKILL.md',
      plugin_id: 'codex-cursor-subagent-plugin@personal', enabled: true,
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
    const evidence = await client.skillLoadEvidence('/fixture', 'codex-cursor-subagent-plugin:cursor-subagent');
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
    assert.deepEqual(client.notifications, [{ method: 'adapter/ready', params: null }]);
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
    await assert.rejects(client.skillLoadEvidence('/fixture', 'codex-cursor-subagent-plugin:cursor-subagent'), /loaded skill content is unreadable/);
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
  const hung = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'hang-close' }, { closeGraceMs: 10, killGraceMs: 10 });
  await hung.close();
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
