import test from 'node:test';
import * as support from './bootstrap-test-support.mjs';

const { assert, spawn, createHash, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile, join, tmpdir, fileURLToPath, MARKER_NAME, canonicalJson, normalizeManifestBytes, parseArgs, runBootstrap, runPackageCommand, treeHashV1, validateTopology, runFakeCodexAdapterCommand, repository, bootstrapScript, adapter, versionedAdapter, adapterGolden, currentVersionedAdapter, currentAdapterGolden, fakeCodexCli, fakeCursorAgentStatus, killWaitCommand, adapterFixtureCall, adapterFixtureResult, runInProcessFakeAdapter, runInProcessBootstrap, bootstrapCli, fixture } = support;

test('strict parser separates malformed invocation from semantic topology failure', async (t) => {
  assert.throws(() => parseArgs(['unknown']), { code: 'invalid_invocation', exitCode: 2 });
  assert.throws(() => parseArgs(['preflight', '--managed-marketplace-root', 'relative']), { code: 'invalid_invocation', exitCode: 2 });
  assert.throws(() => parseArgs(['install', '--source-root', '/source', '--managed-marketplace-root', '/managed',
    '--node-executable', '/node', '--codex-executable', '/codex', '--agent-executable', '/agent']),
  { code: 'invalid_invocation', exitCode: 2 });
  const context = await fixture(t);
  await assert.rejects(validateTopology({
    managedRoot: join(context.source, 'nested-managed'), sourceRoot: context.source,
    nodeExecutable: context.executable, codexExecutable: context.executable, agentExecutable: context.executable,
    allowedWorkspaceRoots: [context.workspace],
  }, { requireSource: true, requireAgent: true }), { code: 'topology_invalid' });

  const nestedExecutable = join(context.source, 'nested-node');
  await cp(context.executable, nestedExecutable); await chmod(nestedExecutable, 0o755);
  await assert.rejects(validateTopology({
    managedRoot: context.managed, sourceRoot: context.source,
    nodeExecutable: nestedExecutable, codexExecutable: context.executable, agentExecutable: context.executable,
    allowedWorkspaceRoots: [context.workspace],
  }, { requireSource: true, requireAgent: true }), { code: 'topology_invalid' });

  await assert.rejects(validateTopology({
    managedRoot: context.managed, sourceRoot: context.source,
    nodeExecutable: context.workspace, codexExecutable: context.executable, agentExecutable: context.executable,
    allowedWorkspaceRoots: [context.workspace],
  }, { requireSource: true, requireAgent: true }), { code: 'missing_dependency' });

  const copiedExecutable = join(context.root, 'copied-node');
  await cp(context.executable, copiedExecutable); await chmod(copiedExecutable, 0o755);
  await assert.rejects(validateTopology({
    managedRoot: context.managed, sourceRoot: context.source,
    nodeExecutable: `${context.workspace}/../copied-node`, codexExecutable: context.executable, agentExecutable: context.executable,
    allowedWorkspaceRoots: [context.workspace],
  }, { requireSource: true, requireAgent: true }), { code: 'missing_dependency' });
});

test('bootstrap rejects malformed adapter command configuration before publication', async (t) => {
  for (const command of [undefined, '{', JSON.stringify([]), JSON.stringify(['relative-adapter'])]) {
    const context = await fixture(t);
    const env = { ...context.env };
    if (command === undefined) delete env.CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND;
    else env.CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND = command;
    const result = await runBootstrap(['install', ...context.common], {
      env,
    });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
      { exitCode: 1, state: 'failed', errorCode: 'adapter_unavailable' }, command);
    await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
  }
});

test('preflight is read-only, emits exactly eight checks and reports missing executable as not_ready', async (t) => {
  const context = await fixture(t); const calls = [];
  const missing = join(context.root, 'missing-node');
  const result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', missing, '--codex-executable', context.executable], {
    env: context.env,
    runCommand: async (command, args, options) => {
      calls.push(args[1] || args[0]);
      const { spawn } = await import('node:child_process');
      return await new Promise((resolveResult) => {
        const child = spawn(command, args, { env: options.env }); const chunks = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk)); child.on('close', (code) => resolveResult({ code, output: Buffer.concat(chunks).toString() }));
      });
    },
  });
  assert.equal(result.exitCode, 1); assert.equal(result.envelope.state, 'not_ready');
  assert.deepEqual(result.envelope.checks.map(({ name }) => name), ['node', 'codex_cli', 'managed_root', 'marketplace_registration', 'plugin_registration', 'mcp_config', 'agent_executable', 'agent_status']);
  assert.equal(result.envelope.checks.find(({ name }) => name === 'node').status, 'fail');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'managed_root').status, 'pass');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'agent_status').status, 'not_checked');
  const messageLess = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', missing, '--codex-executable', context.executable, '--agent-executable', context.executable], {
    env: context.env,
    runCommand: async (command, args, options) => {
      const operation = args[1];
      calls.push(operation);
      if (operation === 'mcp-check') return { code: 0, output: JSON.stringify({ ok: true }) };
      if (operation === 'agent-status') return { code: 0, output: JSON.stringify({ ok: true, verified: true, auth_state: 'authenticated' }) };
      return runFakeCodexAdapterCommand(command, args, options);
    },
  });
  assert.deepEqual(messageLess.envelope.checks.filter(({ name }) => ['mcp_config', 'agent_status'].includes(name)), [
    { name: 'mcp_config', status: 'pass', code: 'ok', message: 'managed MCP config checked' },
    { name: 'agent_status', status: 'pass', code: 'ok', message: 'authentication authenticated' },
  ]);
  assert.equal(calls.some((operation) => /(?:add|remove)$/.test(operation)), false);
});

test('preflight rejects an executable inside managed publication topology without executing it', async (t) => {
  const context = await fixture(t);
  await mkdir(context.managed);
  const managedNode = join(context.managed, 'node');
  await cp(context.executable, managedNode);
  await chmod(managedNode, 0o755);
  let managedNodeCalls = 0;
  const result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', managedNode, '--codex-executable', context.executable], {
    env: context.env,
    runCommand: async (command, args, options) => {
      if (command === managedNode && args.length === 1 && args[0] === '--version') managedNodeCalls += 1;
      return runPackageCommand(command, args, options);
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.envelope.checks.find(({ name }) => name === 'node'), {
    name: 'node', status: 'fail', code: 'topology_invalid', message: 'node is inside managed publication topology',
  });
  assert.equal(managedNodeCalls, 0, 'rejected executable must not run');
  await assert.rejects(lstat(context.state), { code: 'ENOENT' });
});

test('preflight classifies every unsuccessful Node version-command outcome as incompatible', async (t) => {
  for (const scenario of [
    { name: 'nonzero', commandResult: { code: 1, output: 'v22.0.0', timeout: false, overflow: false } },
    { name: 'timeout', commandResult: { code: null, output: '', timeout: true, overflow: false } },
    { name: 'overflow', commandResult: { code: null, output: '', timeout: false, overflow: true } },
    { name: 'malformed version', commandResult: { code: 0, output: 'not-a-node-version', timeout: false, overflow: false } },
    { name: 'unsupported major', commandResult: { code: 0, output: 'v17.9.1', timeout: false, overflow: false } },
  ]) {
    const context = await fixture(t);
    let versionCalls = 0;
    const result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
      '--node-executable', context.executable, '--codex-executable', context.executable], {
      env: context.env,
      runCommand: async (command, args, options) => {
        if (command === context.executable && args.length === 1 && args[0] === '--version') {
          versionCalls += 1;
          return scenario.commandResult;
        }
        return runPackageCommand(command, args, options);
      },
    });
    assert.equal(result.exitCode, 1, scenario.name);
    assert.deepEqual(result.envelope.checks.find(({ name }) => name === 'node'), {
      name: 'node', status: 'fail', code: 'incompatible_version', message: 'Node 18 or newer is required',
    }, scenario.name);
    assert.equal(versionCalls, 1, scenario.name);
    assert.equal(result.envelope.checks.find(({ name }) => name === 'codex_cli').status, 'pass', scenario.name);
    await assert.rejects(lstat(context.state), { code: 'ENOENT' }, scenario.name);
  }
});

test('fake adapter drives portable install, identical no-op, update, preflight and uninstall', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, ok: result.envelope.ok, state: result.envelope.state }, { exitCode: 0, ok: true, state: 'installed' }, JSON.stringify(result));
  const pluginRoot = join(context.managed, 'plugins/agents-cursor-subagent-plugin');
  const config = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
  assert.equal(config.args[0], join(pluginRoot, 'scripts/cursor-subagent-mcp.mjs'));
  assert.equal(config.args[0].startsWith(context.source), false);
  assert.equal(config.env.AGENT_CLI_CREDENTIAL_STORE, 'file');
  const marker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
  assert.match(marker.manifest_version, /^0\.1\.0\+codex\.[0-9a-f]{64}$/);
  assert.equal(await readFile(join(pluginRoot, 'scripts/recording-mcp-proxy.mjs'), 'utf8'),
    await readFile(join(context.source, 'scripts/recording-mcp-proxy.mjs'), 'utf8'));

  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.envelope.state, 'installed');
  await writeFile(join(context.source, 'README.md'), 'changed payload\n');
  result = await runBootstrap(['update', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 0, state: 'installed' }, JSON.stringify(result));
  assert.equal(await readFile(join(pluginRoot, 'README.md'), 'utf8'), 'changed payload\n');
  const updatedMarker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
  assert.notEqual(updatedMarker.payload_hash, marker.payload_hash);
  assert.notEqual(updatedMarker.artifact_hash, marker.artifact_hash);
  assert.notEqual(updatedMarker.manifest_version, marker.manifest_version);
  const registrations = JSON.parse(await readFile(context.state, 'utf8'));
  assert.deepEqual(registrations.plugins.map(({ version }) => version), [updatedMarker.manifest_version],
    'the adapter-visible installed cache must reference the updated payload version');

  result = await runBootstrap(['update', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 0, state: 'installed' });
  await assert.rejects(lstat(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });

  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, auth: result.envelope.auth_state }, { exitCode: 0, state: 'ready', auth: 'authenticated' });

  result = await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 0, state: 'absent' });
});

test('README documents the verified Codex cache refresh and reinstall sequence', async () => {
  const readme = await readFile(join(repository, 'README.md'), 'utf8');
  const commands = [
    'codex plugin marketplace upgrade agents-cursor-subagent-plugin',
    'codex plugin remove agents-cursor-subagent-plugin@agents-cursor-subagent-plugin',
    'codex plugin add agents-cursor-subagent-plugin@agents-cursor-subagent-plugin',
  ];
  const updateStart = readme.indexOf(commands[0]);
  const positions = commands.map((command) => readme.indexOf(command, updateStart));
  assert.ok(positions.every((position) => position >= 0), 'README must include every verified update command');
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2], 'README update commands must preserve the verified order');
  assert.match(readme, /Start a new Codex task only after the final `plugin add` succeeds\./);
});

test('unknown adapter version is rejected before fake mutation', async (t) => {
  const context = await fixture(t); context.env.FAKE_CODEX_UNKNOWN = '1';
  const result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.exitCode, 1); assert.equal(result.envelope.error_code, 'adapter_drift');
  const state = await readFile(context.state, 'utf8').then(JSON.parse).catch(() => ({ mutations: [] }));
  assert.deepEqual(state.mutations, []);
});

test('each backup cleanup deletion boundary is fail-closed as cleanup_required', async (t) => {
  const steps = [
    'cleanup:before-entry:.agents', 'cleanup:after-entry:.agents',
    'cleanup:before-entry:plugins', 'cleanup:after-entry:plugins',
    'cleanup:before-marker', 'cleanup:after-marker', 'cleanup:before-directory',
  ];
  for (const step of steps) {
    const context = await fixture(t);
    let result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.equal(result.envelope.state, 'installed', step);
    await writeFile(join(context.source, 'README.md'), `changed for ${step}\n`);
    result = await runInProcessBootstrap(['update', ...context.common], context, {
      fault: async (observed) => { if (observed === step) throw new Error(`injected ${step}`); },
    });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 1, state: 'cleanup_required' }, step);
    assert.equal(result.envelope.backup_path, `${context.managed}.agents-cursor-subagent-plugin.backup`, step);
    const before = JSON.parse(await readFile(context.state, 'utf8')).mutations.length;
    result = await runInProcessBootstrap(['update', ...context.common], context);
    assert.equal(result.envelope.state, 'cleanup_required', step);
    assert.equal(JSON.parse(await readFile(context.state, 'utf8')).mutations.length, before, step);
  }
});

test('failed compensation preserves observed state and returns recovery_required', async (t) => {
  const context = await fixture(t); context.env.FAKE_CODEX_FAIL_OPERATIONS = 'plugin-add,marketplace-remove';
  let result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 1, state: 'recovery_required' });
  const marker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
  assert.equal(marker.operation, 'install');
  const persisted = JSON.parse(await readFile(context.state, 'utf8'));
  assert.equal(persisted.marketplaces[0].path, context.managed);
  delete context.env.FAKE_CODEX_FAIL_OPERATIONS;
  const before = persisted.mutations.length;
  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.envelope.state, 'recovery_required');
  assert.equal(JSON.parse(await readFile(context.state, 'utf8')).mutations.length, before);
});

test('update and uninstall also return recovery_required when compensation cannot restore registrations', async (t) => {
  for (const operation of ['update', 'uninstall']) {
    const context = await fixture(t);
    let result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.equal(result.envelope.state, 'installed', operation);
    if (operation === 'update') {
      await writeFile(join(context.source, 'README.md'), 'update requiring compensation\n');
      context.env.FAKE_CODEX_FAIL_OPERATIONS = 'plugin-add';
      result = await runInProcessBootstrap(['update', ...context.common], context);
    } else {
      context.env.FAKE_CODEX_FAIL_OPERATIONS = 'marketplace-remove,plugin-add';
      result = await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
        '--codex-executable', context.executable], context);
    }
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 1, state: 'recovery_required' }, operation);
    delete context.env.FAKE_CODEX_FAIL_OPERATIONS;
    result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.equal(result.envelope.state, 'recovery_required', operation);
  }
});

test('config-only update changes artifact hash without changing payload cachebuster', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
  const markerPath = join(context.managed, MARKER_NAME); const before = JSON.parse(await readFile(markerPath, 'utf8'));
  context.env.FAKE_CODEX_CONFIG_VARIANT = 'second';
  result = await runBootstrap(['update', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
  const after = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(after.payload_hash, before.payload_hash); assert.equal(after.manifest_version, before.manifest_version);
  assert.notEqual(after.artifact_hash, before.artifact_hash);
  const config = JSON.parse(await readFile(join(context.managed, 'plugins/agents-cursor-subagent-plugin/.mcp.json'), 'utf8'));
  assert.equal(config.env.FAKE_CODEX_CONFIG_VARIANT, 'second');
});

test('install no-op compares the desired generated artifact hash as well as payload hash', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
  context.env.FAKE_CODEX_CONFIG_VARIANT = 'different-install-config';
  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, code: result.envelope.error_code }, { exitCode: 1, code: 'update_required' });
  assert.equal(await lstat(`${context.managed}.agents-cursor-subagent-plugin.staging`).then(() => true).catch(() => false), false);
});
