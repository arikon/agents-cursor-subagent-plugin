import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('app-server client records notifications and answers only an admitted elicitation', async () => {
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
    assert.deepEqual(client.serverRequests.map(({ method }) => method), ['mcpServer/elicitation/request']);
    assert.deepEqual(client.notifications.map(({ method }) => method), ['item/started', 'item/completed']);
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

test('app-server runner rejects spawn, timeout and aggregate output failures', async () => {
  const missing = new CodexAppServerClient('/definitely/missing-codex');
  await assert.rejects(missing.initialize(), /ENOENT|exited/); await missing.close();
  const timeout = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'timeout' }, { requestTimeoutMs: 10, readSkillFile: async () => Buffer.alloc(0) });
  try { await assert.rejects(timeout.skillLoadEvidence('/fixture', 'any'), /timed out/); } finally { await timeout.close(); }
  const overflow = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'overflow' }, { outputLimit: 64 });
  try { await assert.rejects(overflow.initialize(), /output limit/); } finally { await overflow.close(); }
});

test('app-server runner stops gracefully, then TERM→KILL when close hangs', async () => {
  const graceful = new CodexAppServerClient(process.execPath, [fake]); await graceful.close();
  const hung = new CodexAppServerClient(process.execPath, [fake], { ...process.env, FAKE_APP_SERVER_MODE: 'hang-close' }, { closeGraceMs: 10, killGraceMs: 10 });
  const started = Date.now(); await hung.close(); assert.ok(Date.now() - started < 500);
});
