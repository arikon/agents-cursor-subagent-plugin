import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const initial = { marketplaces: [], plugins: [], mutations: [] };
const normalized = (code, output = '', stream = 'stdout', extra = {}) => ({
  code, output, timeout: false, overflow: false, stream, ...extra,
});
const json = (value) => normalized(0, JSON.stringify(value));

export async function runFakeCodexAdapter(operation, request, env = process.env) {
  if (env.FAKE_CODEX_EXPECT_CONFIG_ROOT &&
      (env.CODEX_HOME !== env.FAKE_CODEX_EXPECT_CONFIG_ROOT ||
       env.CURSOR_SUBAGENT_ADAPTER_CONFIG_ROOT !== env.FAKE_CODEX_EXPECT_CONFIG_ROOT)) {
    return normalized(9, 'isolated adapter config root was not propagated\n', 'stderr');
  }
  const statePath = env.FAKE_CODEX_STATE;
  const load = async () => {
    try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return structuredClone(initial); }
  };
  const save = (state) => writeFile(statePath, JSON.stringify(state));
  const state = await load();
  const failedOperations = new Set((env.FAKE_CODEX_FAIL_OPERATIONS || env.FAKE_CODEX_FAIL_OPERATION || '').split(',').filter(Boolean));
  if (env.FAKE_CODEX_BLOCK_OPERATION === operation) return normalized(null, '', 'stdout', { timeout: true });
  if (env.FAKE_CODEX_READ_OVERFLOW_OPERATION === operation) return normalized(null, '', 'stdout', { overflow: true });
  if (failedOperations.has(operation)) return normalized(7, `injected ${operation} failure`, 'stderr');
  if (env.FAKE_CODEX_NEGATIVE_OPERATION === operation ||
      (env.FAKE_CODEX_NEGATIVE_OPERATION_AFTER_PRIOR_MUTATION === operation && state.mutations.includes(operation))) {
    return json({ ok: false });
  }

  const consumeListFailure = async () => {
    if (!state.fail_next_list) return false;
    delete state.fail_next_list;
    await save(state);
    return true;
  };
  const finishMutation = async () => {
    if (env.FAKE_CODEX_OBSERVED_DRIFT_OPERATION === operation) {
      const kind = env.FAKE_CODEX_OBSERVED_DRIFT_KIND;
      if (kind === 'coupled') state.marketplaces = [];
      if (kind === 'duplicate-marketplace' && state.marketplaces[0]) state.marketplaces.push({ ...state.marketplaces[0] });
      if (kind === 'target-plugin') state.plugins.push({ id: 'agents-cursor-subagent-plugin', marketplace_id: 'agents-cursor-subagent-plugin', source: '/foreign', version: '9.9.9' });
    }
    const failAfter = env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION;
    const [countedOperation, rawCount] = (env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION_COUNT || '').split(':');
    const countedFailure = countedOperation === operation &&
      state.mutations.filter((item) => item === operation).length === Number(rawCount);
    if (failAfter === '1' || failAfter === operation || countedFailure) state.fail_next_list = true;
    await save(state);
    if (env.FAKE_CODEX_PARTIAL_OPERATION === operation) return normalized(7, `partial ${operation}`, 'stderr');
    const timeoutAfterPrior = env.FAKE_CODEX_TIMEOUT_OPERATION_AFTER_PRIOR_MUTATION === operation &&
      state.mutations.filter((item) => item === operation).length > 1;
    if (env.FAKE_CODEX_TIMEOUT_OPERATION === operation || timeoutAfterPrior) return normalized(null, '', 'stdout', { timeout: true });
    if (env.FAKE_CODEX_OVERFLOW_OPERATION === operation) return normalized(null, '', 'stdout', { overflow: true });
    return json({ ok: true });
  };

  if (operation === 'admit') {
    const admission = env.FAKE_CODEX_UNKNOWN === '1'
      ? { admitted: false, adapter_version: null, codex_version: env.FAKE_CODEX_VERSION || 'codex-cli 0.152.1' }
      : { admitted: true, adapter_version: env.FAKE_CODEX_ADAPTER_VERSION || 'codex-cli-0.152.1-fixture-v1', codex_version: env.FAKE_CODEX_VERSION || 'codex-cli 0.152.1' };
    if (env.FAKE_CODEX_OMIT_VERSION === '1') delete admission.codex_version;
    return json(admission);
  }
  if (operation === 'help') return json({
    adapter_version: env.FAKE_CODEX_HELP_DRIFT === '1' ? 'drifted' : env.FAKE_CODEX_ADAPTER_VERSION || 'codex-cli-0.152.1-fixture-v1',
    codex_version: env.FAKE_CODEX_VERSION || 'codex-cli 0.152.1',
    operations: ['admit', 'help', 'marketplace-list', 'plugin-list', 'render', 'mcp-check', 'agent-status', 'canary-prompt', 'marketplace-add', 'marketplace-remove', 'plugin-add', 'plugin-remove'],
  });
  if (operation === 'marketplace-list') {
    if (await consumeListFailure()) return normalized(8, 'injected reread failure', 'stderr');
    return json({ registrations: env.FAKE_CODEX_LIST_VARIANT === 'invalid-marketplace-entry' ? [{}] : state.marketplaces });
  }
  if (operation === 'plugin-list') {
    if (await consumeListFailure()) return normalized(8, 'injected reread failure', 'stderr');
    return json({ registrations: env.FAKE_CODEX_LIST_VARIANT === 'invalid-plugin-entry' ? [{}] : state.plugins });
  }
  if (operation === 'render') {
    if (env.FAKE_CODEX_LOCK_FAILED_STAGE === '1') {
      await chmod(`${request.managed_root}.agents-cursor-subagent-plugin.staging`, 0o555);
      return normalized(7, 'injected render failure with locked staging\n', 'stderr');
    }
    if (env.FAKE_CODEX_RENDER_VARIANT === 'files-not-array') return json({ files: {} });
    const mcpCommand = env.FAKE_CODEX_MCP_COMMAND || request.node_executable;
    const mcpArgs = env.FAKE_CODEX_MCP_ARGS ? JSON.parse(env.FAKE_CODEX_MCP_ARGS) : [join(request.install_root, 'scripts/cursor-subagent-mcp.mjs')];
    const files = [
      { path: '.agents/plugins/marketplace.json', content_base64: Buffer.from(JSON.stringify({ name: 'agents-cursor-subagent-plugin', plugins: [{ name: 'agents-cursor-subagent-plugin', source: { source: 'local', path: './plugins/agents-cursor-subagent-plugin' } }] })).toString('base64') },
      { path: env.FAKE_CODEX_RENDER_OVERRIDE === '1' ? 'plugins/agents-cursor-subagent-plugin/README.md' : 'plugins/agents-cursor-subagent-plugin/.mcp.json', content_base64: Buffer.from(JSON.stringify({
        command: mcpCommand,
        args: mcpArgs,
        env: { CURSOR_AGENT_COMMAND: request.agent_executable, AGENT_CLI_CREDENTIAL_STORE: 'file', CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify(request.allowed_workspace_roots),
          ...(env.FAKE_CODEX_CONFIG_VARIANT ? { FAKE_CODEX_CONFIG_VARIANT: env.FAKE_CODEX_CONFIG_VARIANT } : {}) },
      })).toString('base64') },
    ];
    if (env.FAKE_CODEX_RENDER_VARIANT === 'absolute-path') files[1].path = '/outside';
    if (env.FAKE_CODEX_RENDER_VARIANT === 'backslash-path') files[1].path = 'plugins\\outside';
    if (env.FAKE_CODEX_RENDER_VARIANT === 'dot-segment') files[1].path = 'plugins/../outside';
    if (env.FAKE_CODEX_RENDER_VARIANT === 'duplicate-path') files.push({ ...files[1] });
    if (env.FAKE_CODEX_RENDER_VARIANT === 'noncanonical-base64') files[1].content_base64 = 'YQ';
    return json({ files });
  }
  if (operation === 'mcp-check') {
    const path = join(request.managed_root, 'plugins/agents-cursor-subagent-plugin/.mcp.json');
    const regular = await stat(path).then((value) => value.isFile()).catch(() => false);
    return json({ ok: regular, message: regular ? 'fixture config found' : 'fixture config missing' });
  }
  if (operation === 'agent-status') {
    const status = env.FAKE_CURSOR_AGENT_STATUS || 'authenticated';
    const exitCode = Number(env.FAKE_CURSOR_AGENT_STATUS_EXIT_CODE ?? (status === 'error' ? 1 : 0));
    const authenticated = status === 'authenticated' && exitCode === 0;
    const required = ['unauthenticated', 'partially-authenticated'].includes(status) && exitCode === 0;
    const verified = authenticated || required;
    const auth_state = verified && authenticated ? 'authenticated' : verified && required ? 'required' : 'unknown';
    return json({ ok: verified, verified, auth_state, message: `cursor agent status: ${authenticated ? 'authenticated' : required ? 'authentication required' : 'unknown'}` });
  }
  if (operation === 'canary-prompt') return json({ prompt: `AUTHORIZED_ACTIONS: write ${request.marker_path} with exact content ${JSON.stringify(request.marker_bytes)} only.\nNO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.` });
  if (operation === 'marketplace-add') {
    state.mutations.push(operation);
    if (env.FAKE_CODEX_NOOP_OPERATION !== operation) {
      state.marketplaces = state.marketplaces.filter((item) => item.id !== request.id);
      state.marketplaces.push({ id: request.id, path: request.path });
    }
    return finishMutation();
  }
  if (operation === 'marketplace-remove') {
    state.mutations.push(operation);
    if (env.FAKE_CODEX_NOOP_OPERATION !== operation) state.marketplaces = state.marketplaces.filter((item) => item.id !== request.id);
    return finishMutation();
  }
  if (operation === 'plugin-add') {
    state.mutations.push(operation);
    if (env.FAKE_CODEX_NOOP_OPERATION !== operation) {
      state.plugins = state.plugins.filter((item) => item.id !== request.id || item.marketplace_id !== request.marketplace_id);
      state.plugins.push({ id: request.id, marketplace_id: request.marketplace_id, source: request.source, version: request.version });
    }
    return finishMutation();
  }
  if (operation === 'plugin-remove') {
    state.mutations.push(operation);
    if (env.FAKE_CODEX_NOOP_OPERATION !== operation) state.plugins = state.plugins.filter((item) => item.id !== request.id || item.marketplace_id !== request.marketplace_id);
    return finishMutation();
  }
  return normalized(2, `unknown fixture operation: ${operation}`, 'stderr');
}

export async function runFakeCodexAdapterCommand(_command, args, { env = process.env } = {}) {
  const [, operation, rawRequest] = args;
  const result = await runFakeCodexAdapter(operation, JSON.parse(rawRequest || '{}'), env);
  return { code: result.code, output: result.stream === 'stdout' ? result.output : '', error: result.stream === 'stderr' ? result.output : '', timeout: result.timeout, overflow: result.overflow };
}
