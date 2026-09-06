#!/usr/bin/env node
// Its normalized operations stand in for one version-specific Codex adapter,
// so package tests never invoke a real Codex installation.

import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [, , operation, rawRequest] = process.argv;
const request = JSON.parse(rawRequest || '{}');
if (process.env.FAKE_CODEX_EXPECT_CONFIG_ROOT &&
    (process.env.CODEX_HOME !== process.env.FAKE_CODEX_EXPECT_CONFIG_ROOT ||
     process.env.CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT !== process.env.FAKE_CODEX_EXPECT_CONFIG_ROOT)) {
  process.stderr.write('isolated adapter config root was not propagated\n'); process.exit(9);
}
const statePath = process.env.FAKE_CODEX_STATE;
const initial = { marketplaces: [], plugins: [], mutations: [] };
const load = async () => {
  try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return structuredClone(initial); }
};
const save = (state) => writeFile(statePath, JSON.stringify(state));
const reply = (value) => process.stdout.write(JSON.stringify(value));
const finishMutation = async (state) => {
  if (process.env.FAKE_CODEX_OBSERVED_DRIFT_OPERATION === operation) {
    const kind = process.env.FAKE_CODEX_OBSERVED_DRIFT_KIND;
    if (kind === 'coupled') state.marketplaces = [];
    if (kind === 'duplicate-marketplace' && state.marketplaces[0]) state.marketplaces.push({ ...state.marketplaces[0] });
    if (kind === 'target-plugin') state.plugins.push({ id: 'codex-cursor-subagent-plugin', marketplace_id: 'codex-cursor-subagent-plugin', source: '/foreign', version: '9.9.9' });
  }
  const failAfter = process.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION;
  const [countedOperation, rawCount] = (process.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION_COUNT || '').split(':');
  const countedFailure = countedOperation === operation &&
    state.mutations.filter((item) => item === operation).length === Number(rawCount);
  if (failAfter === '1' || failAfter === operation || countedFailure) state.fail_next_list = true;
  await save(state);
  if (process.env.FAKE_CODEX_PARTIAL_OPERATION === operation) { process.stderr.write(`partial ${operation}`); process.exit(7); }
  const timeoutAfterPrior = process.env.FAKE_CODEX_TIMEOUT_OPERATION_AFTER_PRIOR_MUTATION === operation &&
    state.mutations.filter((item) => item === operation).length > 1;
  if (process.env.FAKE_CODEX_TIMEOUT_OPERATION === operation || timeoutAfterPrior) await new Promise(() => setInterval(() => {}, 1_000));
  if (process.env.FAKE_CODEX_OVERFLOW_OPERATION === operation) process.stdout.write('x'.repeat(1_048_577));
  else reply({ ok: true });
};

const state = await load();
const failedOperations = new Set((process.env.FAKE_CODEX_FAIL_OPERATIONS || process.env.FAKE_CODEX_FAIL_OPERATION || '').split(',').filter(Boolean));
if (process.env.FAKE_CODEX_BLOCK_OPERATION === operation) await new Promise(() => setInterval(() => {}, 1_000));
if (process.env.FAKE_CODEX_READ_OVERFLOW_OPERATION === operation) { process.stdout.write('x'.repeat(1_048_577)); process.exit(0); }
if (failedOperations.has(operation)) {
  process.stderr.write(`injected ${operation} failure`);
  process.exit(7);
}
if (process.env.FAKE_CODEX_NEGATIVE_OPERATION === operation ||
    (process.env.FAKE_CODEX_NEGATIVE_OPERATION_AFTER_PRIOR_MUTATION === operation && state.mutations.includes(operation))) {
  reply({ ok: false });
  process.exit(0);
}

const consumeListFailure = async () => {
  if (!state.fail_next_list) return false;
  delete state.fail_next_list;
  await save(state);
  return true;
};
if (operation === 'admit') {
  const admission = process.env.FAKE_CODEX_UNKNOWN === '1'
    ? { admitted: false, adapter_version: null, codex_version: process.env.FAKE_CODEX_VERSION || 'codex-cli 0.152.1' }
    : { admitted: true, adapter_version: process.env.FAKE_CODEX_ADAPTER_VERSION || 'codex-cli-0.152.1-fixture-v1', codex_version: process.env.FAKE_CODEX_VERSION || 'codex-cli 0.152.1' };
  if (process.env.FAKE_CODEX_OMIT_VERSION === '1') delete admission.codex_version;
  reply(admission);
} else if (operation === 'help') {
  reply({ adapter_version: process.env.FAKE_CODEX_HELP_DRIFT === '1' ? 'drifted' : process.env.FAKE_CODEX_ADAPTER_VERSION || 'codex-cli-0.152.1-fixture-v1', codex_version: process.env.FAKE_CODEX_VERSION || 'codex-cli 0.152.1',
    operations: ['admit', 'help', 'marketplace-list', 'plugin-list', 'render', 'mcp-check', 'agent-status', 'canary-prompt', 'marketplace-add', 'marketplace-remove', 'plugin-add', 'plugin-remove'] });
} else if (operation === 'marketplace-list') {
  if (await consumeListFailure()) { process.stderr.write('injected reread failure'); process.exit(8); }
  reply({ registrations: process.env.FAKE_CODEX_LIST_VARIANT === 'invalid-marketplace-entry' ? [{}] : state.marketplaces });
} else if (operation === 'plugin-list') {
  if (await consumeListFailure()) { process.stderr.write('injected reread failure'); process.exit(8); }
  reply({ registrations: process.env.FAKE_CODEX_LIST_VARIANT === 'invalid-plugin-entry' ? [{}] : state.plugins });
} else if (operation === 'render') {
  if (process.env.FAKE_CODEX_LOCK_FAILED_STAGE === '1') {
    await chmod(`${request.managed_root}.codex-cursor-subagent-plugin.staging`, 0o555);
    process.stderr.write('injected render failure with locked staging\n');
    process.exit(7);
  } else if (process.env.FAKE_CODEX_RENDER_VARIANT === 'files-not-array') reply({ files: {} });
  else {
    const mcpCommand = process.env.FAKE_CODEX_MCP_COMMAND || request.node_executable;
    const mcpArgs = process.env.FAKE_CODEX_MCP_ARGS ? JSON.parse(process.env.FAKE_CODEX_MCP_ARGS) : [join(request.install_root, 'scripts/cursor-subagent-mcp.mjs')];
    const files = [
    { path: '.agents/plugins/marketplace.json', content_base64: Buffer.from(JSON.stringify({ name: 'codex-cursor-subagent-plugin', plugins: [{ name: 'codex-cursor-subagent-plugin', source: { source: 'local', path: './plugins/codex-cursor-subagent-plugin' } }] })).toString('base64') },
    { path: process.env.FAKE_CODEX_RENDER_OVERRIDE === '1' ? 'plugins/codex-cursor-subagent-plugin/README.md' : 'plugins/codex-cursor-subagent-plugin/.mcp.json', content_base64: Buffer.from(JSON.stringify({
      command: mcpCommand,
      args: mcpArgs,
      env: { CURSOR_AGENT_COMMAND: request.agent_executable, AGENT_CLI_CREDENTIAL_STORE: 'file', CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify(request.allowed_workspace_roots),
        ...(process.env.FAKE_CODEX_CONFIG_VARIANT ? { FAKE_CODEX_CONFIG_VARIANT: process.env.FAKE_CODEX_CONFIG_VARIANT } : {}) },
    })).toString('base64') },
    ];
    if (process.env.FAKE_CODEX_RENDER_VARIANT === 'absolute-path') files[1].path = '/outside';
    if (process.env.FAKE_CODEX_RENDER_VARIANT === 'backslash-path') files[1].path = 'plugins\\outside';
    if (process.env.FAKE_CODEX_RENDER_VARIANT === 'dot-segment') files[1].path = 'plugins/../outside';
    if (process.env.FAKE_CODEX_RENDER_VARIANT === 'duplicate-path') files.push({ ...files[1] });
    if (process.env.FAKE_CODEX_RENDER_VARIANT === 'noncanonical-base64') files[1].content_base64 = 'YQ';
    reply({ files });
  }
} else if (operation === 'mcp-check') {
  const path = join(request.managed_root, 'plugins/codex-cursor-subagent-plugin/.mcp.json');
  const regular = await stat(path).then((value) => value.isFile()).catch(() => false);
  reply({ ok: regular, message: regular ? 'fixture config found' : 'fixture config missing' });
} else if (operation === 'agent-status') {
  const status = process.env.FAKE_CURSOR_AGENT_STATUS || 'authenticated';
  const exitCode = Number(process.env.FAKE_CURSOR_AGENT_STATUS_EXIT_CODE ?? (status === 'error' ? 1 : 0));
  const authenticated = status === 'authenticated' && exitCode === 0;
  const required = ['unauthenticated', 'partially-authenticated'].includes(status) && exitCode === 0;
  const verified = authenticated || required;
  const auth_state = verified && authenticated ? 'authenticated' : verified && required ? 'required' : 'unknown';
  reply({ ok: verified, verified, auth_state, message: `cursor agent status: ${authenticated ? 'authenticated' : required ? 'authentication required' : 'unknown'}` });
} else if (operation === 'canary-prompt') {
  reply({ prompt: `AUTHORIZED_ACTIONS: write ${request.marker_path} with exact content ${JSON.stringify(request.marker_bytes)} only.\nNO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.` });
} else if (operation === 'marketplace-add') {
  state.mutations.push(operation);
  if (process.env.FAKE_CODEX_NOOP_OPERATION !== operation) {
    state.marketplaces = state.marketplaces.filter((item) => item.id !== request.id);
    state.marketplaces.push({ id: request.id, path: request.path });
  }
  await finishMutation(state);
} else if (operation === 'marketplace-remove') {
  state.mutations.push(operation);
  if (process.env.FAKE_CODEX_NOOP_OPERATION !== operation) state.marketplaces = state.marketplaces.filter((item) => item.id !== request.id);
  await finishMutation(state);
} else if (operation === 'plugin-add') {
  state.mutations.push(operation);
  if (process.env.FAKE_CODEX_NOOP_OPERATION !== operation) {
    state.plugins = state.plugins.filter((item) => item.id !== request.id || item.marketplace_id !== request.marketplace_id);
    state.plugins.push({ id: request.id, marketplace_id: request.marketplace_id, source: request.source, version: request.version });
  }
  await finishMutation(state);
} else if (operation === 'plugin-remove') {
  state.mutations.push(operation);
  if (process.env.FAKE_CODEX_NOOP_OPERATION !== operation) state.plugins = state.plugins.filter((item) => item.id !== request.id || item.marketplace_id !== request.marketplace_id);
  await finishMutation(state);
} else {
  process.stderr.write(`unknown fixture operation: ${operation}`); process.exitCode = 2;
}
