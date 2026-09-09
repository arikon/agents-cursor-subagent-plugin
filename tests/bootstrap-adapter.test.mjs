import test from 'node:test';
import * as support from './bootstrap-test-support.mjs';

const { assert, spawn, createHash, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile, join, tmpdir, fileURLToPath, MARKER_NAME, canonicalJson, normalizeManifestBytes, parseArgs, runBootstrap, runPackageCommand, treeHashV1, validateTopology, runFakeCodexAdapterCommand, repository, bootstrapScript, adapter, versionedAdapter, adapterGolden, currentVersionedAdapter, currentAdapterGolden, fakeCodexCli, fakeCursorAgentStatus, killWaitCommand, adapterFixtureCall, adapterFixtureResult, runInProcessFakeAdapter, runInProcessBootstrap, bootstrapCli, fixture } = support;

test('versioned Codex adapter admission and help match its checked-in golden surface', async (t) => {
  const context = await fixture(t); const golden = JSON.parse(await readFile(adapterGolden, 'utf8'));
  const currentGolden = JSON.parse(await readFile(currentAdapterGolden, 'utf8'));
  const codex = join(context.root, 'codex'); await cp(fakeCodexCli, codex); await chmod(codex, 0o755);
  const agent = join(context.root, 'agent'); await cp(fakeCursorAgentStatus, agent); await chmod(agent, 0o755);
  const log = join(context.root, 'codex-argv.log'); const agentLog = join(context.root, 'agent-argv.log');
  const state = join(context.root, 'versioned-state.json');
  const env = {
    ...process.env,
    CURSOR_EVAL_ADAPTER_TIMEOUT_MS: '60000',
    FAKE_CODEX_CLI_LOG: log,
    FAKE_CODEX_CLI_STATE: state,
    FAKE_CURSOR_AGENT_LOG: agentLog,
  };
  const implementation = await readFile(versionedAdapter);
  const implementationProof = {
    implementation_sha256: createHash('sha256').update(implementation).digest('hex'),
    implementation_bytes: implementation.length,
  };
  assert.deepEqual({ implementation_sha256: golden.implementation_sha256, implementation_bytes: golden.implementation_bytes }, implementationProof);
  assert.deepEqual({ implementation_sha256: currentGolden.implementation_sha256, implementation_bytes: currentGolden.implementation_bytes }, implementationProof);
  const admission = await adapterFixtureCall(context.executable, 'admit', { codex_executable: codex }, env, versionedAdapter);
  assert.deepEqual(admission, {
    admitted: true,
    adapter_version: golden.adapter_version,
    codex_version: golden.codex_version,
    ...implementationProof,
  });
  const help = await adapterFixtureCall(context.executable, 'help', { codex_executable: codex }, env, versionedAdapter);
  assert.deepEqual(help, { adapter_version: golden.adapter_version, codex_version: golden.codex_version, operations: golden.operations });
  const rendered = await adapterFixtureCall(context.executable, 'render', {
    codex_executable: codex, node_executable: context.executable, agent_executable: agent,
    install_root: join(context.managed, 'plugins/agents-cursor-subagent-plugin'), allowed_workspace_roots: [context.workspace],
  }, env, versionedAdapter);
  assert.deepEqual(rendered.files.map(({ path }) => path), ['.agents/plugins/marketplace.json', 'plugins/agents-cursor-subagent-plugin/.mcp.json']);
  const timeoutPreload = join(context.root, 'accelerate-turn-timeout.mjs');
  const timeoutRendered = await adapterFixtureCall(context.executable, 'render', {
    codex_executable: codex, node_executable: context.executable, agent_executable: agent,
    install_root: join(context.managed, 'plugins/agents-cursor-subagent-plugin'), allowed_workspace_roots: [context.workspace],
  }, { ...env, CURSOR_EVAL_TIMEOUT_PRELOAD: timeoutPreload, FAKE_ACP_ACCELERATE_TURN_TIMEOUT: '1',
    FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1' }, versionedAdapter);
  const mcpFile = timeoutRendered.files.find(({ path }) => path.endsWith('/.mcp.json'));
  const mcpDocument = JSON.parse(Buffer.from(mcpFile.content_base64, 'base64').toString('utf8'));
  assert.deepEqual(mcpDocument.mcpServers['cursor-subagent'].env, {
    CURSOR_AGENT_COMMAND: agent,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify([context.workspace]),
    NODE_OPTIONS: `--import=${timeoutPreload}`,
    FAKE_ACP_ACCELERATE_TURN_TIMEOUT: '1',
    FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1',
  });
  assert.deepEqual(golden.covered_outcomes, ['success', 'nonzero', 'partial', 'timeout', 'output_overflow', 'reread_failure']);
  assert.deepEqual(golden.cli_forms, {
    version: ['--version'], help: ['plugin', '--help'], agent_version: ['--version'], agent_status: ['status', '--format', 'json'],
    marketplace_list: ['plugin', 'marketplace', 'list', '--json'], plugin_list: ['plugin', 'list', '--json'],
    marketplace_add: ['plugin', 'marketplace', 'add', '<SOURCE>', '--json'], marketplace_remove: ['plugin', 'marketplace', 'remove', '<MARKETPLACE>', '--json'],
    plugin_add: ['plugin', 'add', '<PLUGIN>@<MARKETPLACE>', '--json'], plugin_remove: ['plugin', 'remove', '<PLUGIN>@<MARKETPLACE>', '--json'],
  });
  assert.deepEqual(golden.agent_status_forms, {
    version: '2026.08.25-3e8eec8',
    authenticated: { status: 'authenticated', isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true },
    required: [
      { status: 'unauthenticated', isAuthenticated: false, hasAccessToken: false, hasRefreshToken: false },
      { status: 'partially-authenticated', isAuthenticated: false, hasAccessToken: true, hasRefreshToken: false },
    ],
    unknown_status: 'error',
  });
  const adapterEnv = { ...env, CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([context.executable, versionedAdapter]) };
  const args = ['--source-root', context.source, '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', codex, '--agent-executable', agent,
    '--allowed-workspace-root', context.workspace];
  const runVersionedBootstrap = (argv, bootstrapEnv = adapterEnv) => runBootstrap(argv, {
    env: bootstrapEnv,
    runCommand: (command, commandArgs, options) => runPackageCommand(command, commandArgs, { ...options, timeoutMs: 70_000 }),
  });
  let lifecycle = await runVersionedBootstrap(['install', ...args]); assert.equal(lifecycle.exitCode, 0, JSON.stringify(lifecycle));
  lifecycle = await runVersionedBootstrap(['preflight', '--managed-marketplace-root', context.managed, '--node-executable', context.executable,
    '--codex-executable', codex, '--agent-executable', agent]);
  assert.equal(lifecycle.envelope.auth_state, 'authenticated');
  assert.deepEqual((await readFile(agentLog, 'utf8')).trim().split('\n').map(JSON.parse), [['--version'], ['status', '--format', 'json']]);
  for (const [status, expected] of [['unauthenticated', 'required'], ['partially-authenticated', 'required'], ['error', 'unknown']]) {
    const normalized = await adapterFixtureCall(context.executable, 'agent-status', { codex_executable: codex, agent_executable: agent },
      { ...env, FAKE_CURSOR_AGENT_STATUS: status }, versionedAdapter);
    assert.equal(normalized.auth_state, expected, status);
    assert.equal(normalized.verified, expected !== 'unknown', status);
  }
  const agentBeforeDrift = (await readFile(agentLog, 'utf8')).trim().split('\n').length;
  const driftedAgent = await adapterFixtureCall(context.executable, 'agent-status', { agent_executable: agent },
    { ...env, FAKE_CURSOR_AGENT_VERSION: '2026.08.26-drift' }, versionedAdapter);
  assert.deepEqual({ auth_state: driftedAgent.auth_state, verified: driftedAgent.verified }, { auth_state: 'unknown', verified: false });
  assert.deepEqual((await readFile(agentLog, 'utf8')).trim().split('\n').map(JSON.parse).slice(agentBeforeDrift), [['--version']],
    'unknown Cursor Agent version must stop before status');
  const codexBeforeIndependent = (await readFile(log, 'utf8')).trim().split('\n').length;
  const agentBeforeIndependent = (await readFile(agentLog, 'utf8')).trim().split('\n').length;
  lifecycle = await runVersionedBootstrap(['preflight', '--managed-marketplace-root', context.managed, '--node-executable', context.executable,
    '--codex-executable', codex, '--agent-executable', agent], { ...adapterEnv, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.152.2' });
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'codex_cli').status, 'fail');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'marketplace_registration').status, 'not_checked');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'plugin_registration').status, 'not_checked');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'mcp_config').status, 'pass');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'agent_status').status, 'pass');
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).slice(codexBeforeIndependent), [['--version']]);
  assert.deepEqual((await readFile(agentLog, 'utf8')).trim().split('\n').map(JSON.parse).slice(agentBeforeIndependent),
    [['--version'], ['status', '--format', 'json']]);
  lifecycle = await runVersionedBootstrap(['uninstall', '--managed-marketplace-root', context.managed, '--codex-executable', codex]);
  assert.equal(lifecycle.exitCode, 0, JSON.stringify(lifecycle));
  const invocations = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const [name, expected] of Object.entries(golden.cli_forms).filter(([name, value]) => !name.startsWith('agent_') &&
    !value.includes('<SOURCE>') && !value.includes('<MARKETPLACE>') && !value.some((part) => part.includes('<PLUGIN>')))) {
    assert.equal(invocations.some((actual) => JSON.stringify(actual) === JSON.stringify(expected)), true, JSON.stringify(expected));
  }
  for (const expected of [
    ['plugin', 'marketplace', 'add', context.managed, '--json'],
    ['plugin', 'add', 'agents-cursor-subagent-plugin@agents-cursor-subagent-plugin', '--json'],
    ['plugin', 'remove', 'agents-cursor-subagent-plugin@agents-cursor-subagent-plugin', '--json'],
    ['plugin', 'marketplace', 'remove', 'agents-cursor-subagent-plugin', '--json'],
  ]) {
    assert.equal(invocations.some((actual) => JSON.stringify(actual) === JSON.stringify(expected)), true, JSON.stringify(expected));
  }
  const beforeCurrentPluginList = invocations.length;
  const currentPlugins = await adapterFixtureCall(context.executable, 'plugin-list', { codex_executable: codex },
    { ...env, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.153.4' }, currentVersionedAdapter);
  assert.deepEqual(currentPlugins, { registrations: [] });
  const currentPluginListInvocations = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).slice(beforeCurrentPluginList);
  assert.deepEqual(currentPluginListInvocations, [
    ['--version'],
    ['plugin', 'list', '--marketplace', 'agents-cursor-subagent-plugin', '--json'],
  ]);
  assert.deepEqual(currentGolden.cli_forms.plugin_list,
    ['plugin', 'list', '--marketplace', 'agents-cursor-subagent-plugin', '--json']);
  const unknown = await adapterFixtureCall(context.executable, 'admit', { codex_executable: codex }, { ...env, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.152.2' }, versionedAdapter);
  assert.equal(unknown.admitted, false);
  const beforeUnknown = (await readFile(log, 'utf8')).trim().split('\n').length;
  lifecycle = await runVersionedBootstrap(['install', ...args], { ...adapterEnv, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.152.2' });
  assert.equal(lifecycle.envelope.error_code, 'adapter_drift');
  const afterUnknown = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).slice(beforeUnknown);
  assert.deepEqual(afterUnknown, [['--version']], 'unknown version must stop before read or mutation argv');
});

test('versioned adapter bounds nested Cursor commands and waits for killed child close', async (t) => {
  const context = await fixture(t); const agent = join(context.root, 'agent'); await symlink(fakeCursorAgentStatus, agent);
  const pidPath = join(context.root, 'nested-agent.pid'); const timeoutMs = 2_000; const started = Date.now();
  let result = await adapterFixtureResult(context.executable, 'agent-status', { agent_executable: agent }, {
    ...process.env,
    CURSOR_EVAL_ADAPTER_TIMEOUT_MS: String(timeoutMs),
    FAKE_CURSOR_AGENT_BLOCK_ARGV: '--version',
    CURSOR_EVAL_ADAPTER_NESTED_PID_PATH: pidPath,
  }, versionedAdapter);
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1); assert.match(result.stderr, /nested command timed out/); assert.ok(elapsed >= timeoutMs - 200 && elapsed < 5_000, elapsed);
  const pid = Number((await readFile(pidPath, 'utf8')).trim().split('\n').at(-1));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'nested Cursor child survived adapter timeout');
  result = await adapterFixtureResult(context.executable, 'agent-status', { agent_executable: agent }, {
    ...process.env, FAKE_CURSOR_AGENT_OVERFLOW_ARGV: '--version',
  }, versionedAdapter);
  assert.equal(result.code, 1); assert.match(result.stderr, /nested command exceeded output limit/);
});

test('package command waits for child close after timeout and output overflow kills', async (t) => {
  const context = await fixture(t);
  for (const overflow of [false, true]) {
    const pidPath = join(context.root, `killed-${overflow}.pid`);
    const result = await runPackageCommand(context.executable, [killWaitCommand], { env: { ...process.env, KILL_WAIT_PID_PATH: pidPath,
      ...(overflow ? { KILL_WAIT_OVERFLOW: '1' } : {}) }, timeoutMs: overflow ? 1_000 : 500, outputBytes: 64, closeWaitMs: 1_000 });
    assert.equal(overflow ? result.overflow : result.timeout, true);
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `child ${pid} was still alive after command return`);
    assert.equal(result.closeTimeout, undefined);
  }
});

test('package command reports close timeout while a descendant retains the killed child output pipe', async () => {
  const descendantScript = [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 750)"], { stdio: ["ignore", "inherit", "inherit"] });',
    'setInterval(() => {}, 1_000);',
  ].join(' ');
  const result = await runPackageCommand(process.execPath, ['-e', descendantScript], {
    timeoutMs: 100,
    closeWaitMs: 100,
  });
  assert.deepEqual({ code: result.code, timeout: result.timeout, closeTimeout: result.closeTimeout },
    { code: null, timeout: true, closeTimeout: true });
});

test('package command keeps the first kill reason when overflow precedes its timeout', async () => {
  const descendantScript = [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 750)"], { stdio: ["ignore", "inherit", "inherit"] });',
    'process.stdout.write("overflow");',
    'setInterval(() => {}, 1_000);',
  ].join(' ');
  const result = await runPackageCommand(process.execPath, ['-e', descendantScript], {
    timeoutMs: 2_000,
    outputBytes: 1,
    closeWaitMs: 300,
  });
  assert.deepEqual({ code: result.code, timeout: result.timeout, overflow: result.overflow, closeTimeout: result.closeTimeout },
    { code: null, timeout: false, overflow: true, closeTimeout: true });
});

test('package command bounds simultaneous stdout and stderr overflow with one terminal outcome', async () => {
  const script = [
    'process.stdout.write("o".repeat(65536));',
    'process.stderr.write("e".repeat(65536));',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const result = await runPackageCommand(process.execPath, ['-e', script], {
    timeoutMs: 2_000,
    outputBytes: 1,
    closeWaitMs: 1_000,
  });
  assert.deepEqual({ code: result.code, timeout: result.timeout, overflow: result.overflow },
    { code: null, timeout: false, overflow: true });
  assert.equal(result.closeTimeout, undefined);
});


