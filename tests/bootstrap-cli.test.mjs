import test from 'node:test';
import * as support from './bootstrap-test-support.mjs';

const { assert, spawn, createHash, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile, join, tmpdir, fileURLToPath, MARKER_NAME, canonicalJson, normalizeManifestBytes, parseArgs, runBootstrap, runPackageCommand, treeHashV1, validateTopology, runFakeCodexAdapterCommand, repository, bootstrapScript, adapter, versionedAdapter, adapterGolden, currentVersionedAdapter, currentAdapterGolden, fakeCodexCli, fakeCursorAgentStatus, killWaitCommand, adapterFixtureCall, adapterFixtureResult, runInProcessFakeAdapter, runInProcessBootstrap, bootstrapCli, fixture } = support;

test('fake adapter CLI and in-process runner have normalized outcome parity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-bootstrap-adapter-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: 'success', operation: 'admit', request: {} },
    { name: 'negative', operation: 'admit', request: {}, fault: { FAKE_CODEX_NEGATIVE_OPERATION: 'admit' } },
    { name: 'partial', operation: 'marketplace-add', request: { id: 'm', path: '/managed' }, fault: { FAKE_CODEX_PARTIAL_OPERATION: 'marketplace-add' } },
    { name: 'timeout', operation: 'admit', request: {}, fault: { FAKE_CODEX_BLOCK_OPERATION: 'admit' } },
    { name: 'overflow', operation: 'admit', request: {}, fault: { FAKE_CODEX_READ_OVERFLOW_OPERATION: 'admit' } },
    { name: 'reread failure', operation: 'marketplace-list', request: {}, state: { marketplaces: [], plugins: [], mutations: [], fail_next_list: true } },
  ];
  for (const scenario of cases) {
    const cliState = join(root, `${scenario.name}-cli.json`); const coreState = join(root, `${scenario.name}-core.json`);
    if (scenario.state) {
      await writeFile(cliState, JSON.stringify(scenario.state));
      await writeFile(coreState, JSON.stringify(scenario.state));
    }
    const cliEnv = { ...process.env, FAKE_CODEX_STATE: cliState, ...scenario.fault };
    const coreEnv = { ...process.env, FAKE_CODEX_STATE: coreState, ...scenario.fault };
    const args = [adapter, scenario.operation, JSON.stringify(scenario.request)];
    const cli = await runPackageCommand(process.execPath, args, {
      env: cliEnv, timeoutMs: scenario.name === 'timeout' ? 100 : 2_000, outputBytes: 1_000,
    });
    const core = await runInProcessFakeAdapter(process.execPath, args, { env: coreEnv });
    assert.deepEqual({ code: cli.code, output: cli.output, error: cli.error, timeout: cli.timeout, overflow: cli.overflow }, core, scenario.name);
    const cliSaved = await readFile(cliState, 'utf8').catch(() => null);
    const coreSaved = await readFile(coreState, 'utf8').catch(() => null);
    assert.equal(cliSaved, coreSaved, `${scenario.name} state`);
  }
});

test('CLI returns one machine-readable invalid-invocation envelope', async () => {
  const result = await bootstrapCli(['install']);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  assert.deepEqual({ ok: result.envelope.ok, operation: result.envelope.operation, state: result.envelope.state,
    errorCode: result.envelope.error_code },
  { ok: false, operation: 'install', state: 'failed', errorCode: 'invalid_invocation' });

  const absentOperation = await bootstrapCli([]);
  assert.equal(absentOperation.code, 2);
  assert.equal(absentOperation.stderr, '');
  assert.deepEqual({ operation: absentOperation.envelope.operation, errorCode: absentOperation.envelope.error_code },
    { operation: null, errorCode: 'invalid_invocation' });
});

test('CLI bounds diagnostics in its machine-readable failure envelope', async () => {
  const result = await bootstrapCli(['install', `--${'a'.repeat(7_976)}😀xyz`, '/unused']);
  assert.equal(result.code, 2);
  assert.ok(Buffer.byteLength(result.envelope.message) <= 8_000);
  assert.equal(Buffer.from(result.envelope.message, 'utf8').toString('utf8'), result.envelope.message);
  assert.equal(result.envelope.message.endsWith('...'), true);
});

test('CLI rejects an option without its value', async () => {
  const result = await bootstrapCli(['install', '--source-root']);
  assert.equal(result.code, 2);
  assert.equal(result.envelope.error_code, 'invalid_invocation');
  assert.match(result.envelope.message, /missing value for --source-root/);
});

test('CLI rejects a duplicate singleton option', async () => {
  const result = await bootstrapCli(['uninstall', '--managed-marketplace-root', '/tmp/managed',
    '--managed-marketplace-root', '/tmp/other', '--codex-executable', process.execPath]);
  assert.equal(result.code, 2);
  assert.equal(result.envelope.error_code, 'invalid_invocation');
  assert.match(result.envelope.message, /duplicate option: --managed-marketplace-root/);
});

test('CLI rejects a relative filesystem boundary', async () => {
  const result = await bootstrapCli(['uninstall', '--managed-marketplace-root', 'relative/managed',
    '--codex-executable', process.execPath]);
  assert.equal(result.code, 2);
  assert.equal(result.envelope.error_code, 'invalid_invocation');
  assert.match(result.envelope.message, /must be an absolute normalized path/);
});

test('CLI install rejects a malformed package manifest without publishing artifacts', async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.source, '.codex-plugin/plugin.json'), '{not-json');
  const result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.deepEqual({ ok: result.envelope.ok, state: result.envelope.state, errorCode: result.envelope.error_code },
    { ok: false, state: 'failed', errorCode: 'invalid_manifest' });
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
  await assert.rejects(lstat(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
});

test('CLI install rejects a non-object package manifest without publishing artifacts', async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.source, '.codex-plugin/plugin.json'), '[]');
  const result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'invalid_manifest');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI install rejects an incomplete package payload without publishing artifacts', async (t) => {
  const context = await fixture(t);
  await rm(join(context.source, 'README.md'));
  const result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'invalid_payload');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
  await assert.rejects(lstat(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
});

test('CLI install requires the recording proxy as a managed payload owner entry', async (t) => {
  const context = await fixture(t);
  await rm(join(context.source, 'scripts/recording-mcp-proxy.mjs'));
  const result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'invalid_payload');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI install rejects a package without its required skill tree', async (t) => {
  const context = await fixture(t);
  await rm(join(context.source, 'skills'), { recursive: true });
  const result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'invalid_payload');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI install rejects a symbolic link inside the published skill tree', async (t) => {
  const context = await fixture(t);
  const skillEntry = join(context.source, 'skills/cursor-subagent/SKILL.md');
  await rm(skillEntry);
  await symlink(join(context.source, 'README.md'), skillEntry);
  const result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'foreign_artifact');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI update rejects an absent managed installation', async (t) => {
  const context = await fixture(t);
  const result = await bootstrapCli(['update', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.deepEqual({ state: result.envelope.state, errorCode: result.envelope.error_code },
    { state: 'failed', errorCode: 'not_installed' });
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI uninstall is idempotent when the managed installation is absent', async (t) => {
  const context = await fixture(t);
  const result = await bootstrapCli(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], context.env);
  assert.equal(result.code, 0);
  assert.deepEqual({ ok: result.envelope.ok, operation: result.envelope.operation, state: result.envelope.state },
    { ok: true, operation: 'uninstall', state: 'absent' });
});

test('CLI install rejects an overlapping managed topology before publication', async (t) => {
  const context = await fixture(t);
  const managed = join(context.source, 'managed');
  const args = context.common.map((value) => value === context.managed ? managed : value);
  const result = await bootstrapCli(['install', ...args], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'topology_invalid');
  await assert.rejects(lstat(managed), { code: 'ENOENT' });
});

test('CLI install rejects a missing source root without creating managed state', async (t) => {
  const context = await fixture(t);
  const missingSource = join(context.root, 'missing-source');
  const args = context.common.map((value) => value === context.source ? missingSource : value);
  const result = await bootstrapCli(['install', ...args], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'topology_invalid');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI install rejects a source root reached through a symbolic link', async (t) => {
  const context = await fixture(t);
  const linkedSource = join(context.root, 'linked-source');
  await symlink(context.source, linkedSource);
  const args = context.common.map((value) => value === context.source ? linkedSource : value);
  const result = await bootstrapCli(['install', ...args], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.error_code, 'topology_invalid');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI preflight rejects a managed root that is not a directory', async (t) => {
  const context = await fixture(t);
  await writeFile(context.managed, 'foreign file');
  const result = await bootstrapCli(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.state, 'not_ready');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'managed_root').code, 'topology_invalid');
});

test('CLI preflight rejects a managed root reached through a symbolic link without mutating its target', async (t) => {
  const context = await fixture(t);
  const canonicalManaged = join(context.root, 'canonical-managed-marketplace');
  await mkdir(canonicalManaged);
  await symlink(canonicalManaged, context.managed);
  const result = await bootstrapCli(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], context.env);
  assert.equal(result.code, 1);
  assert.equal(result.envelope.state, 'not_ready');
  assert.deepEqual(result.envelope.checks.find(({ name }) => name === 'managed_root'), {
    name: 'managed_root', status: 'fail', code: 'topology_invalid',
    message: 'managed root must be absent or a canonical directory',
  });
  assert.deepEqual(await readdir(canonicalManaged), []);
});

test('CLI install exposes interrupted owned staging as recovery_required', async (t) => {
  const context = await fixture(t);
  let result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 0, result.stdout);
  const staging = `${context.managed}.agents-cursor-subagent-plugin.staging`;
  await rename(context.managed, staging);
  result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 1);
  assert.deepEqual({ state: result.envelope.state, errorCode: result.envelope.error_code,
    stagingPath: result.envelope.staging_path },
  { state: 'recovery_required', errorCode: 'recovery_required', stagingPath: staging });
});

test('CLI preflight reports unavailable registrations while completing independent checks', async (t) => {
  const context = await fixture(t);
  const result = await bootstrapCli(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { ...context.env, FAKE_CODEX_FAIL_OPERATION: 'marketplace-list' });
  assert.equal(result.code, 1);
  assert.equal(result.envelope.state, 'not_ready');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'marketplace_registration').status, 'fail');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'plugin_registration').status, 'fail');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'mcp_config').status, 'fail');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'agent_status').status, 'pass');
});

test('CLI preflight reports an absent managed installation without creating it', async (t) => {
  const context = await fixture(t);
  const result = await bootstrapCli(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], context.env);
  assert.equal(result.code, 1);
  assert.deepEqual({ state: result.envelope.state, errorCode: result.envelope.error_code },
    { state: 'not_ready', errorCode: 'preflight_failed' });
  assert.equal(result.envelope.checks.find(({ name }) => name === 'managed_root').status, 'pass');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'marketplace_registration').code, 'absent');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'plugin_registration').code, 'absent');
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });

  const missingCodexContext = await fixture(t);
  const missingCodex = join(missingCodexContext.root, 'missing-codex');
  const missingCodexResult = await bootstrapCli(['preflight', '--managed-marketplace-root', missingCodexContext.managed,
    '--node-executable', missingCodexContext.executable, '--codex-executable', missingCodex,
    '--agent-executable', missingCodexContext.executable], missingCodexContext.env);
  assert.deepEqual(missingCodexResult.envelope.checks.find(({ name }) => name === 'codex_cli'), {
    name: 'codex_cli', status: 'fail', code: 'missing_dependency', message: 'codex_cli must be a canonical regular executable',
  });
  assert.equal(missingCodexResult.envelope.checks.find(({ name }) => name === 'marketplace_registration').status, 'not_checked');
  assert.equal(missingCodexResult.envelope.checks.find(({ name }) => name === 'plugin_registration').status, 'not_checked');
  assert.equal(missingCodexResult.envelope.checks.find(({ name }) => name === 'node').status, 'pass');
  assert.equal(missingCodexResult.envelope.checks.find(({ name }) => name === 'agent_status').status, 'pass');
});

test('CLI reports an unavailable adapter executable without publishing artifacts', async (t) => {
  const context = await fixture(t);
  const missingAdapter = join(context.root, 'missing-adapter');
  const result = await bootstrapCli(['install', ...context.common], {
    ...context.env,
    CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([missingAdapter]),
  });
  assert.equal(result.code, 1);
  assert.deepEqual({ state: result.envelope.state, errorCode: result.envelope.error_code },
    { state: 'failed', errorCode: 'adapter_failure' });
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
});

test('CLI rejects malformed adapter envelopes without publishing artifacts', async (t) => {
  for (const [name, output] of [['non-json', 'not-json'], ['array', '[]'], ['null', 'null']]) {
    const context = await fixture(t);
    const invalidAdapter = join(context.root, `invalid-adapter-${name}.mjs`);
    await writeFile(invalidAdapter, `process.stdout.write(${JSON.stringify(output)});\n`);
    const result = await bootstrapCli(['install', ...context.common], {
      ...context.env,
      CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([context.executable, invalidAdapter]),
    });
    assert.equal(result.code, 1, name);
    assert.equal(result.envelope.error_code, 'adapter_drift', name);
    await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
  }
});

test('CLI install publishes a self-contained managed package', async (t) => {
  const context = await fixture(t);
  const result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual({ ok: result.envelope.ok, operation: result.envelope.operation, state: result.envelope.state },
    { ok: true, operation: 'install', state: 'installed' });
  const pluginRoot = join(context.managed, 'plugins/agents-cursor-subagent-plugin');
  const marker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
  const manifest = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.version, marker.manifest_version);
  assert.match(manifest.version, /^0\.1\.0\+codex\.[0-9a-f]{64}$/);
  assert.equal(await readFile(join(pluginRoot, 'README.md'), 'utf8'), await readFile(join(context.source, 'README.md'), 'utf8'));
});

test('CLI update replaces the published package with the requested payload', async (t) => {
  const context = await fixture(t);
  let result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 0, result.stdout);
  await writeFile(join(context.source, 'README.md'), 'updated through the public CLI\n');
  result = await bootstrapCli(['update', ...context.common], context.env);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual({ ok: result.envelope.ok, operation: result.envelope.operation, state: result.envelope.state },
    { ok: true, operation: 'update', state: 'installed' });
  assert.equal(await readFile(join(context.managed, 'plugins/agents-cursor-subagent-plugin/README.md'), 'utf8'),
    'updated through the public CLI\n');
  await assert.rejects(lstat(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  await assert.rejects(lstat(`${context.managed}.agents-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
});

test('CLI preflight reports a completed installation ready for use', async (t) => {
  const context = await fixture(t);
  let result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 0, result.stdout);
  result = await bootstrapCli(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], context.env);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual({ ok: result.envelope.ok, operation: result.envelope.operation, state: result.envelope.state,
    authState: result.envelope.auth_state },
  { ok: true, operation: 'preflight', state: 'ready', authState: 'authenticated' });
  assert.equal(result.envelope.checks.every(({ status }) => status === 'pass'), true);
});

test('CLI uninstall removes its managed publication and registrations', async (t) => {
  const context = await fixture(t);
  let result = await bootstrapCli(['install', ...context.common], context.env);
  assert.equal(result.code, 0, result.stdout);
  result = await bootstrapCli(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], context.env);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual({ ok: result.envelope.ok, operation: result.envelope.operation, state: result.envelope.state },
    { ok: true, operation: 'uninstall', state: 'absent' });
  await assert.rejects(lstat(context.managed), { code: 'ENOENT' });
  const registrations = JSON.parse(await readFile(context.state, 'utf8'));
  assert.deepEqual({ marketplaces: registrations.marketplaces, plugins: registrations.plugins },
    { marketplaces: [], plugins: [] });
});


