import test from 'node:test';
import * as support from './bootstrap-test-support.mjs';

const { assert, spawn, createHash, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile, join, tmpdir, fileURLToPath, MARKER_NAME, canonicalJson, normalizeManifestBytes, parseArgs, runBootstrap, runPackageCommand, treeHashV1, validateTopology, runFakeCodexAdapterCommand, repository, bootstrapScript, adapter, versionedAdapter, adapterGolden, currentVersionedAdapter, currentAdapterGolden, fakeCodexCli, fakeCursorAgentStatus, killWaitCommand, adapterFixtureCall, adapterFixtureResult, runInProcessFakeAdapter, runInProcessBootstrap, bootstrapCli, fixture } = support;

test('strict marker and registration tuples reject extra marker fields and duplicate owned IDs', async (t) => {
  const markerContext = await fixture(t);
  let result = await runBootstrap(['install', ...markerContext.common], { env: markerContext.env }); assert.equal(result.exitCode, 0);
  const markerPath = join(markerContext.managed, MARKER_NAME); const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  await writeFile(markerPath, JSON.stringify({ ...marker, unexpected: true }));
  const beforeMarker = JSON.parse(await readFile(markerContext.state, 'utf8')).mutations.length;
  result = await runBootstrap(['install', ...markerContext.common], { env: markerContext.env });
  assert.equal(result.envelope.error_code, 'state_drift');
  assert.equal(JSON.parse(await readFile(markerContext.state, 'utf8')).mutations.length, beforeMarker);

  const tupleContext = await fixture(t);
  result = await runBootstrap(['install', ...tupleContext.common], { env: tupleContext.env }); assert.equal(result.exitCode, 0);
  const state = JSON.parse(await readFile(tupleContext.state, 'utf8')); state.marketplaces.push({ ...state.marketplaces[0] });
  await writeFile(tupleContext.state, JSON.stringify(state));
  result = await runBootstrap(['install', ...tupleContext.common], { env: tupleContext.env });
  assert.equal(result.envelope.error_code, 'state_drift');
});

test('strict marker validation rejects every malformed owned identity before mutation', async (t) => {
  const context = await fixture(t);
  let result = await runInProcessBootstrap(['install', ...context.common], context);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const markerPath = join(context.managed, MARKER_NAME);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const variants = [
    ['format', { format: 2 }],
    ['operation', { operation: 'uninstall' }],
    ['marketplace id', { marketplace_id: 'foreign-marketplace' }],
    ['plugin id', { plugin_id: 'foreign-plugin' }],
    ['payload hash', { payload_hash: 'not-a-sha256' }],
    ['artifact hash', { artifact_hash: 'not-a-sha256' }],
    ['agent executable type', { agent_executable: 42 }],
    ['agent executable relative path', { agent_executable: 'relative-agent' }],
    ['agent executable noncanonical path', { agent_executable: `${context.root}/workspace/../agent` }],
    ['manifest version', { manifest_version: 'not-semver' }],
  ];
  const mutationCount = JSON.parse(await readFile(context.state, 'utf8')).mutations.length;
  for (const [name, patch] of variants) {
    await writeFile(markerPath, JSON.stringify({ ...marker, ...patch }));
    result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
      { exitCode: 1, state: 'failed', errorCode: 'state_drift' }, name);
    assert.equal(JSON.parse(await readFile(context.state, 'utf8')).mutations.length, mutationCount, name);
  }
});

test('owned marker rejects post-publication payload drift before mutation', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const mutationCount = JSON.parse(await readFile(context.state, 'utf8')).mutations.length;
  await writeFile(join(context.managed, 'plugins/agents-cursor-subagent-plugin/README.md'), 'foreign managed edit\n');
  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
    { exitCode: 1, state: 'failed', errorCode: 'state_drift' });
  assert.equal(JSON.parse(await readFile(context.state, 'utf8')).mutations.length, mutationCount);
});

test('publication remnant classification rejects conflicting, foreign and invalid paths', async (t) => {
  for (const kind of ['stage-and-backup', 'foreign-stage', 'invalid-stage', 'foreign-active']) {
    const context = await fixture(t);
    const staging = `${context.managed}.agents-cursor-subagent-plugin.staging`;
    const backup = `${context.managed}.agents-cursor-subagent-plugin.backup`;
    if (kind === 'stage-and-backup') {
      await mkdir(staging); await mkdir(backup);
    } else if (kind === 'foreign-stage') {
      await writeFile(staging, 'foreign staging artifact');
    } else if (kind === 'invalid-stage') {
      await mkdir(staging);
    } else {
      await writeFile(context.managed, 'foreign active artifact');
    }
    const result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
      { exitCode: 1, state: 'failed', errorCode: 'state_drift' }, kind);
    const mutationCount = await readFile(context.state, 'utf8').then(JSON.parse).then(({ mutations }) => mutations.length).catch(() => 0);
    assert.equal(mutationCount, 0, kind);
  }
});

test('preflight classifies foreign and duplicate owned registrations independently', async (t) => {
  const context = await fixture(t);
  const plugin = {
    id: 'agents-cursor-subagent-plugin',
    marketplace_id: 'agents-cursor-subagent-plugin',
    source: join(context.managed, 'plugins/agents-cursor-subagent-plugin'),
    version: '0.1.0+codex.foreign',
  };
  await writeFile(context.state, JSON.stringify({
    marketplaces: [{ id: 'agents-cursor-subagent-plugin', path: join(context.root, 'foreign-marketplace') }],
    plugins: [plugin, { ...plugin }],
    mutations: [],
  }));
  const result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.state, 'not_ready');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'marketplace_registration').code, 'foreign');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'plugin_registration').code, 'duplicate');
  assert.deepEqual(JSON.parse(await readFile(context.state, 'utf8')).mutations, []);
});

test('preflight requires authenticated status and a version-bound admitted adapter', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
  context.env.FAKE_CURSOR_AGENT_STATUS = 'unauthenticated';
  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.state, 'not_ready'); assert.equal(result.envelope.auth_state, 'required');
  assert.deepEqual(result.envelope.checks.find(({ name }) => name === 'agent_status'), {
    name: 'agent_status', status: 'fail', code: 'auth_required', message: 'cursor agent status: authentication required',
  });
  context.env.FAKE_CURSOR_AGENT_STATUS = 'unexpected';
  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.auth_state, 'unknown');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'agent_status').code, 'auth_unknown');
  context.env.FAKE_CURSOR_AGENT_STATUS = 'authenticated';
  context.env.FAKE_CURSOR_AGENT_STATUS_EXIT_CODE = '1';
  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.auth_state, 'unknown', 'authenticated Cursor status with the wrong exit code is not verified');
  delete context.env.FAKE_CURSOR_AGENT_STATUS;
  delete context.env.FAKE_CURSOR_AGENT_STATUS_EXIT_CODE;
  context.env.FAKE_CODEX_OMIT_VERSION = '1';
  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.checks.find(({ name }) => name === 'codex_cli').code, 'adapter_drift');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'marketplace_registration').status, 'not_checked');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'mcp_config').status, 'pass');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'agent_status').status, 'pass');
});

test('preflight reports marketplace and plugin registrations independently', async (t) => {
  const context = await fixture(t);
  await writeFile(context.state, JSON.stringify({ marketplaces: [{ id: 'agents-cursor-subagent-plugin', path: context.managed }], plugins: [], mutations: [] }));
  const result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.checks.find(({ name }) => name === 'marketplace_registration').status, 'pass');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'plugin_registration').code, 'absent');
});

test('preflight isolates adapter-backed check failures and remains read-only', async (t) => {
  for (const [operation, checkName, independentCheck] of [
    ['mcp-check', 'mcp_config', 'agent_status'],
    ['agent-status', 'agent_status', 'mcp_config'],
  ]) {
    const context = await fixture(t);
    let result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.equal(result.envelope.state, 'installed', operation);
    const before = JSON.parse(await readFile(context.state, 'utf8'));
    context.env.FAKE_CODEX_FAIL_OPERATION = operation;
    result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
      '--node-executable', context.executable, '--codex-executable', context.executable,
      '--agent-executable', context.executable], { env: context.env });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state },
      { exitCode: 1, state: 'not_ready' }, operation);
    assert.deepEqual({ status: result.envelope.checks.find(({ name }) => name === checkName).status,
      code: result.envelope.checks.find(({ name }) => name === checkName).code },
    { status: 'fail', code: 'adapter_failure' }, operation);
    assert.equal(result.envelope.checks.find(({ name }) => name === independentCheck).status, 'pass', operation);
    assert.deepEqual(JSON.parse(await readFile(context.state, 'utf8')), before, operation);
  }
});

test('backup and registration recovery classification distinguishes owned deltas from foreign drift', async (t) => {
  const backupContext = await fixture(t);
  let result = await runBootstrap(['install', ...backupContext.common], { env: backupContext.env }); assert.equal(result.exitCode, 0);
  await rename(backupContext.managed, `${backupContext.managed}.agents-cursor-subagent-plugin.backup`);
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', backupContext.managed,
    '--codex-executable', backupContext.executable], { env: backupContext.env });
  assert.equal(result.envelope.state, 'recovery_required');
  assert.equal(result.envelope.backup_path, `${backupContext.managed}.agents-cursor-subagent-plugin.backup`);

  const partialContext = await fixture(t);
  await writeFile(partialContext.state, JSON.stringify({
    marketplaces: [{ id: 'agents-cursor-subagent-plugin', path: partialContext.managed }], plugins: [], mutations: [],
  }));
  result = await runBootstrap(['install', ...partialContext.common], { env: partialContext.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
    { exitCode: 1, state: 'recovery_required', errorCode: 'recovery_required' });
  assert.deepEqual(JSON.parse(await readFile(partialContext.state, 'utf8')).mutations, []);

  const foreignContext = await fixture(t);
  await writeFile(foreignContext.state, JSON.stringify({ marketplaces: [{ id: 'agents-cursor-subagent-plugin', path: join(foreignContext.root, 'foreign') }], plugins: [], mutations: [] }));
  result = await runBootstrap(['install', ...foreignContext.common], { env: foreignContext.env });
  assert.equal(result.envelope.state, 'failed'); assert.equal(result.envelope.error_code, 'state_drift');

  const independentContext = await fixture(t);
  await writeFile(independentContext.state, JSON.stringify({ marketplaces: [], plugins: [{ id: 'agents-cursor-subagent-plugin', marketplace_id: 'personal', source: join(independentContext.root, 'personal-plugin'), version: '0.1.0+codex.legacy' }], mutations: [] }));
  result = await runBootstrap(['install', ...independentContext.common], { env: independentContext.env });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const independentRegistrations = JSON.parse(await readFile(independentContext.state, 'utf8')).plugins;
  assert.equal(independentRegistrations.some((item) => item.marketplace_id === 'personal'), true);
  assert.equal(independentRegistrations.some((item) => item.marketplace_id === 'agents-cursor-subagent-plugin'), true);
});

test('interrupted uninstall cleanup is classified as cleanup_required on the next invocation', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], { env: context.env,
    fault: async (step) => { if (step === 'cleanup:before-marker') throw new Error('stop uninstall cleanup'); } });
  assert.equal(result.envelope.state, 'cleanup_required');
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.state, 'cleanup_required');
});

test('versioned adapter help drift fails before mutation without staging remnants', async (t) => {
  const context = await fixture(t); context.env.FAKE_CODEX_HELP_DRIFT = '1';
  const result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.envelope.state, 'failed');
  assert.equal(JSON.parse(await readFile(context.state, 'utf8').catch(() => '{"mutations":[]}')).mutations.length, 0);
  await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
});

test('incompatible adapter render payload fails before mutation without staging remnants', async (t) => {
  const variants = [
    ['FAKE_CODEX_RENDER_OVERRIDE', '1'],
    ['FAKE_CODEX_RENDER_VARIANT', 'files-not-array'],
    ['FAKE_CODEX_RENDER_VARIANT', 'absolute-path'],
    ['FAKE_CODEX_RENDER_VARIANT', 'backslash-path'],
    ['FAKE_CODEX_RENDER_VARIANT', 'dot-segment'],
    ['FAKE_CODEX_RENDER_VARIANT', 'duplicate-path'],
    ['FAKE_CODEX_RENDER_VARIANT', 'noncanonical-base64'],
  ];
  for (const [name, value] of variants) {
    const context = await fixture(t); context.env[name] = value;
    const result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.equal(result.envelope.state, 'failed', value);
    assert.equal(JSON.parse(await readFile(context.state, 'utf8').catch(() => '{"mutations":[]}')).mutations.length, 0, value);
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
});

test('incompatible adapter registration entries fail before publication', async (t) => {
  for (const variant of ['invalid-marketplace-entry', 'invalid-plugin-entry']) {
    const context = await fixture(t); context.env.FAKE_CODEX_LIST_VARIANT = variant;
    const result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
      { exitCode: 1, state: 'failed', errorCode: 'adapter_drift' }, variant);
    await assert.rejects(realpath(context.managed), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
});

test('negative, nonzero, partial and output-overflow mutators compensate only their observed registration delta', async (t) => {
  const cases = [
    ['FAKE_CODEX_NEGATIVE_OPERATION', 'marketplace-add'],
    ['FAKE_CODEX_FAIL_OPERATION', 'marketplace-add'],
    ['FAKE_CODEX_PARTIAL_OPERATION', 'marketplace-add'],
    ['FAKE_CODEX_OVERFLOW_OPERATION', 'plugin-add'],
  ];
  for (const [name, operation] of cases) {
    const context = await fixture(t); context.env[name] = operation;
    const result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.equal(result.envelope.state, 'failed', name);
    const state = JSON.parse(await readFile(context.state, 'utf8').catch(() => '{"marketplaces":[],"plugins":[],"mutations":[]}'));
    assert.deepEqual(state.marketplaces, [], name); assert.deepEqual(state.plugins, [], name);
    if (name === 'FAKE_CODEX_FAIL_OPERATION') assert.deepEqual(state.mutations, [], 'a failed add with no observed delta must not run remove');
  }
});

test('mutator timeout compensates an observed partial add and list reread failure requires recovery', async (t) => {
  const timeoutContext = await fixture(t); timeoutContext.env.FAKE_CODEX_TIMEOUT_OPERATION = 'marketplace-add';
  let result = await runBootstrap(['install', ...timeoutContext.common], {
    env: timeoutContext.env,
    runCommand: (command, args, options) => runPackageCommand(command, args, { ...options, timeoutMs: 1_000 }),
  });
  assert.equal(result.envelope.state, 'failed');
  const timeoutState = JSON.parse(await readFile(timeoutContext.state, 'utf8'));
  assert.deepEqual(timeoutState.marketplaces, []); assert.deepEqual(timeoutState.mutations, ['marketplace-add', 'marketplace-remove']);

  const rereadContext = await fixture(t); rereadContext.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION = '1';
  result = await runBootstrap(['install', ...rereadContext.common], { env: rereadContext.env });
  assert.equal(result.envelope.state, 'recovery_required'); assert.match(result.envelope.message, /reread failed/);
  assert.equal(result.envelope.last_completed_step, 'marketplace-add');
  assert.equal(JSON.parse(await readFile(rereadContext.state, 'utf8')).marketplaces[0].path, rereadContext.managed);
});

test('registration reread failure during compensation requires recovery without advancing publication', async (t) => {
  const installContext = await fixture(t);
  installContext.env.FAKE_CODEX_PARTIAL_OPERATION = 'marketplace-add';
  installContext.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION = 'marketplace-remove';
  let result = await runInProcessBootstrap(['install', ...installContext.common], installContext);
  assert.equal(result.envelope.state, 'recovery_required');
  assert.deepEqual(JSON.parse(await readFile(installContext.state, 'utf8')).marketplaces, []);
  assert.ok(await realpath(installContext.managed));

  for (const lifecycle of ['update', 'uninstall']) {
    const context = await fixture(t);
    result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.equal(result.envelope.state, 'installed', lifecycle);
    const marker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
    if (lifecycle === 'update') await writeFile(join(context.source, 'README.md'), 'compensation reread failure\n');
    context.env.FAKE_CODEX_PARTIAL_OPERATION = 'plugin-remove';
    context.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION = 'plugin-add';
    result = lifecycle === 'update'
      ? await runInProcessBootstrap(['update', ...context.common], context)
      : await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
        '--codex-executable', context.executable], context);
    assert.equal(result.envelope.state, 'recovery_required', lifecycle);
    const registrations = JSON.parse(await readFile(context.state, 'utf8'));
    assert.equal(registrations.marketplaces[0].path, context.managed, lifecycle);
    assert.equal(registrations.plugins[0].version, marker.manifest_version, lifecycle);
    assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, marker.artifact_hash, lifecycle);
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
  }
});

test('install preserves recovery evidence when marketplace compensation cannot reread registrations', async (t) => {
  const context = await fixture(t);
  context.env.FAKE_CODEX_FAIL_OPERATION = 'plugin-add';
  context.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION_COUNT = 'marketplace-remove:1';
  const result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, lastCompletedStep: result.envelope.last_completed_step },
    { exitCode: 1, state: 'recovery_required', lastCompletedStep: 'marketplace-remove' });
  const registrations = JSON.parse(await readFile(context.state, 'utf8'));
  assert.deepEqual({ marketplaces: registrations.marketplaces, plugins: registrations.plugins },
    { marketplaces: [], plugins: [] });
  assert.equal(await lstat(context.managed).then(() => true).catch(() => false), true);
});

test('uninstall preserves recovery evidence when publication plugin compensation cannot reread registrations', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.exitCode, 0);
  context.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION_COUNT = 'plugin-add:2';
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], {
    env: context.env,
    fault: async (step) => { if (step === 'publication:before-uninstall-active-to-backup') throw new Error(step); },
  });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, lastCompletedStep: result.envelope.last_completed_step },
    { exitCode: 1, state: 'recovery_required', lastCompletedStep: 'plugin-add' });
  const registrations = JSON.parse(await readFile(context.state, 'utf8'));
  assert.equal(registrations.marketplaces[0].path, context.managed);
  assert.equal(registrations.plugins[0].source, join(context.managed, 'plugins/agents-cursor-subagent-plugin'));
});

test('update reports recovery when publication rollback cannot rename the owned backup into place', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.exitCode, 0);
  await writeFile(join(context.source, 'README.md'), 'rollback rename failure\n');
  let restored;
  result = await runBootstrap(['update', ...context.common], {
    env: context.env,
    fault: async (step) => {
      if (step !== 'publication:after-update-active-to-backup') return;
      await rm(`${context.managed}.agents-cursor-subagent-plugin.staging`, { recursive: true });
      await chmod(context.root, 0o555);
      restored = new Promise((resolveRestore) => setTimeout(async () => {
        await chmod(context.root, 0o755);
        resolveRestore();
      }, 100));
      throw new Error(step);
    },
  });
  await restored;
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, backupPath: result.envelope.backup_path },
    { exitCode: 1, state: 'recovery_required', backupPath: null });
  assert.equal(await lstat(`${context.managed}.agents-cursor-subagent-plugin.backup`).then(() => true).catch(() => false), true);
});

test('rejected and timed-out compensation commands classify install, update and uninstall by observed state', async (t) => {
  const cases = [
    { lifecycle: 'install', forward: 'marketplace-add', compensation: 'marketplace-remove' },
    { lifecycle: 'install', forward: 'plugin-add', compensation: 'plugin-remove' },
    { lifecycle: 'update', forward: 'plugin-remove', compensation: 'plugin-add' },
    { lifecycle: 'update', forward: 'plugin-add', compensation: 'plugin-remove' },
    { lifecycle: 'uninstall', forward: 'plugin-remove', compensation: 'plugin-add' },
    { lifecycle: 'uninstall', forward: 'marketplace-remove', compensation: 'plugin-add', noOp: true },
  ];
  for (const outcome of ['rejected', 'timed_out']) {
    for (const scenario of cases) {
      const context = await fixture(t);
      let before = null;
      if (scenario.lifecycle !== 'install') {
        const installed = await runInProcessBootstrap(['install', ...context.common], context);
        assert.equal(installed.envelope.state, 'installed', `${scenario.lifecycle}:${scenario.forward}:${outcome}`);
        before = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
      }
      if (scenario.lifecycle === 'update') await writeFile(join(context.source, 'README.md'), `compensation ${outcome}\n`);
      context.env[scenario.noOp ? 'FAKE_CODEX_NOOP_OPERATION' : 'FAKE_CODEX_PARTIAL_OPERATION'] = scenario.forward;
      const repeatedCompensation = scenario.lifecycle === 'update' && scenario.forward === 'plugin-add';
      const faultName = outcome === 'rejected'
        ? repeatedCompensation ? 'FAKE_CODEX_NEGATIVE_OPERATION_AFTER_PRIOR_MUTATION' : 'FAKE_CODEX_NEGATIVE_OPERATION'
        : repeatedCompensation ? 'FAKE_CODEX_TIMEOUT_OPERATION_AFTER_PRIOR_MUTATION' : 'FAKE_CODEX_TIMEOUT_OPERATION';
      context.env[faultName] = scenario.compensation;
      const overrides = { env: context.env, runCommand: runInProcessFakeAdapter };
      const result = scenario.lifecycle === 'install'
        ? await runBootstrap(['install', ...context.common], overrides)
        : scenario.lifecycle === 'update'
          ? await runBootstrap(['update', ...context.common], overrides)
          : await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
            '--codex-executable', context.executable], overrides);
      assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state },
        { exitCode: 1, state: outcome === 'rejected' ? 'recovery_required' : 'failed' },
        `${scenario.lifecycle}:${scenario.forward}:${scenario.compensation}:${outcome}`);
      if (outcome === 'timed_out') {
        if (scenario.lifecycle === 'install') await assert.rejects(realpath(context.managed), { code: 'ENOENT' });
        else assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash,
          before.artifact_hash, `${scenario.lifecycle}:${scenario.forward}`);
      }
    }
  }
});

test('failed stage preparation reports recovery_required when its owned staging cannot be removed', async (t) => {
  const context = await fixture(t);
  const staging = `${context.managed}.agents-cursor-subagent-plugin.staging`;
  context.env.FAKE_CODEX_LOCK_FAILED_STAGE = '1';
  const result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, code: result.envelope.error_code,
    stagingPath: result.envelope.staging_path },
  { exitCode: 1, state: 'recovery_required', code: 'recovery_required', stagingPath: staging });
  assert.match(result.envelope.message, /stage preparation failed and owned staging cleanup failed/);
  assert.equal((await lstat(staging)).isDirectory(), true);
  await chmod(staging, 0o755);
  await rm(staging, { recursive: true });
});

test('reread failures preserve every recoverable artifact and expose the observed lifecycle state', async (t) => {
  const cases = [
    { name: 'install plugin compensation reread', lifecycle: 'install', partial: 'plugin-add', noOp: 'marketplace-remove', reread: 'plugin-remove:1', registrations: 'marketplace_only', active: 'new' },
    { name: 'update publication reread', lifecycle: 'update', publication: 'publication:after-update-active-to-backup', failList: true, registrations: 'marketplace_only', active: 'old' },
    { name: 'update publication compensation reread', lifecycle: 'update', publication: 'publication:after-update-active-to-backup', reread: 'plugin-add:2', registrations: 'exact_old', active: 'old' },
    { name: 'update new plugin removal reread', lifecycle: 'update', partial: 'plugin-add', reread: 'plugin-remove:2', registrations: 'marketplace_only', active: 'new', backup: true },
    { name: 'update old plugin restoration reread', lifecycle: 'update', partial: 'plugin-add', reread: 'plugin-add:3', registrations: 'exact_old', active: 'old' },
    { name: 'uninstall uncertain marketplace compensation reread', lifecycle: 'uninstall', negative: 'marketplace-remove', reread: 'plugin-add:2', registrations: 'exact_old', active: 'old' },
    { name: 'uninstall no-op marketplace compensation reread', lifecycle: 'uninstall', noOp: 'marketplace-remove', reread: 'plugin-add:2', registrations: 'exact_old', active: 'old' },
    { name: 'uninstall publication compensation reread', lifecycle: 'uninstall', publication: 'publication:before-uninstall-active-to-backup', reread: 'marketplace-add:2', registrations: 'marketplace_only', active: 'old' },
  ];
  const exists = (path) => lstat(path).then(() => true).catch(() => false);
  for (const scenario of cases) {
    const context = await fixture(t);
    let installedMarker = null;
    if (scenario.lifecycle !== 'install') {
      const installed = await runInProcessBootstrap(['install', ...context.common], context);
      assert.equal(installed.exitCode, 0, scenario.name);
      installedMarker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
    }
    if (scenario.lifecycle === 'update') await writeFile(join(context.source, 'README.md'), `${scenario.name}\n`);
    if (scenario.partial) context.env.FAKE_CODEX_PARTIAL_OPERATION = scenario.partial;
    if (scenario.noOp) context.env.FAKE_CODEX_NOOP_OPERATION = scenario.noOp;
    if (scenario.negative) context.env.FAKE_CODEX_NEGATIVE_OPERATION = scenario.negative;
    if (scenario.reread) context.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION_COUNT = scenario.reread;
    const fault = scenario.publication ? async (step) => {
      if (step !== scenario.publication) return;
      if (scenario.failList) context.env.FAKE_CODEX_FAIL_OPERATION = 'marketplace-list';
      throw new Error(scenario.name);
    } : undefined;
    const result = scenario.lifecycle === 'install'
      ? await runInProcessBootstrap(['install', ...context.common], context, { fault })
      : scenario.lifecycle === 'update'
        ? await runInProcessBootstrap(['update', ...context.common], context, { fault })
        : await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
          '--codex-executable', context.executable], context, { fault });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state },
      { exitCode: 1, state: 'recovery_required' }, scenario.name);

    const staging = `${context.managed}.agents-cursor-subagent-plugin.staging`;
    const backup = `${context.managed}.agents-cursor-subagent-plugin.backup`;
    assert.deepEqual({ active: await exists(context.managed), backup: await exists(backup), staging: await exists(staging) },
      { active: true, backup: scenario.backup === true, staging: false }, scenario.name);
    const registrations = JSON.parse(await readFile(context.state, 'utf8'));
    assert.equal(registrations.marketplaces.length, 1, scenario.name);
    assert.equal(registrations.marketplaces[0].path, context.managed, scenario.name);
    if (scenario.registrations === 'marketplace_only') assert.equal(registrations.plugins.length, 0, scenario.name);
    else {
      assert.equal(registrations.plugins.length, 1, scenario.name);
      assert.equal(registrations.plugins[0].version, installedMarker.manifest_version, scenario.name);
    }
    const activeMarker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
    if (scenario.active === 'old') assert.equal(activeMarker.artifact_hash, installedMarker.artifact_hash, scenario.name);
    if (scenario.backup) assert.equal(JSON.parse(await readFile(join(backup, MARKER_NAME), 'utf8')).artifact_hash,
      installedMarker.artifact_hash, scenario.name);
  }

  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.exitCode, 0);
  const before = JSON.parse(await readFile(context.state, 'utf8'));
  await symlink(join(context.root, 'foreign'), join(context.managed, 'plugins/agents-cursor-subagent-plugin/foreign-link'));
  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.state, 'not_ready');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'plugin_registration').status, 'fail');
  const after = JSON.parse(await readFile(context.state, 'utf8'));
  assert.deepEqual({ marketplaces: after.marketplaces, plugins: after.plugins, mutations: after.mutations },
    { marketplaces: before.marketplaces, plugins: before.plugins, mutations: before.mutations });
});

test('uncertain remove outcomes compensate their observed delta and never advance lifecycle', async (t) => {
  for (const [lifecycle, uncertainOperation, fault] of [
    ['update', 'plugin-remove', 'FAKE_CODEX_PARTIAL_OPERATION'],
    ['uninstall', 'plugin-remove', 'FAKE_CODEX_PARTIAL_OPERATION'],
    ['uninstall', 'marketplace-remove', 'FAKE_CODEX_PARTIAL_OPERATION'],
    ['update', 'plugin-remove', 'FAKE_CODEX_FAIL_OPERATION'],
    ['uninstall', 'plugin-remove', 'FAKE_CODEX_FAIL_OPERATION'],
  ]) {
    const context = await fixture(t);
    let result = await runInProcessBootstrap(['install', ...context.common], context); assert.equal(result.exitCode, 0);
    const before = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
    if (lifecycle === 'update') await writeFile(join(context.source, 'README.md'), 'uncertain update payload\n');
    context.env[fault] = uncertainOperation;
    result = lifecycle === 'update'
      ? await runInProcessBootstrap(['update', ...context.common], context)
      : await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', context.managed, '--codex-executable', context.executable], context);
    const registrations = JSON.parse(await readFile(context.state, 'utf8'));
    if (uncertainOperation === 'marketplace-remove') {
      assert.equal(result.envelope.state, 'recovery_required');
      assert.deepEqual(registrations.marketplaces, []); assert.deepEqual(registrations.plugins, []);
      assert.deepEqual(registrations.mutations.slice(-2), ['plugin-remove', 'marketplace-remove'], 'coupled delta must not run add compensation');
    } else {
      assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 1, state: 'failed' }, `${lifecycle}:${uncertainOperation}`);
      assert.deepEqual(registrations.marketplaces, [{ id: 'agents-cursor-subagent-plugin', path: context.managed }]);
      assert.deepEqual(registrations.plugins, [{ id: 'agents-cursor-subagent-plugin', marketplace_id: 'agents-cursor-subagent-plugin',
        source: join(context.managed, 'plugins/agents-cursor-subagent-plugin'), version: before.manifest_version }]);
    }
    assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, before.artifact_hash);
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
});

test('reported successful no-op mutations do not advance their lifecycle', async (t) => {
  for (const operation of ['marketplace-add', 'plugin-add']) {
    const context = await fixture(t); context.env.FAKE_CODEX_NOOP_OPERATION = operation;
    const result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
      { exitCode: 1, state: 'failed', errorCode: 'install_failed' }, operation);
    const registrations = JSON.parse(await readFile(context.state, 'utf8'));
    assert.deepEqual({ marketplaces: registrations.marketplaces, plugins: registrations.plugins },
      { marketplaces: [], plugins: [] }, operation);
    await assert.rejects(realpath(context.managed), { code: 'ENOENT' });
  }

  for (const lifecycle of ['update', 'uninstall']) {
    const context = await fixture(t);
    let result = await runInProcessBootstrap(['install', ...context.common], context);
    assert.equal(result.envelope.state, 'installed', lifecycle);
    const marker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
    if (lifecycle === 'update') await writeFile(join(context.source, 'README.md'), 'confirmed no-op plugin removal\n');
    context.env.FAKE_CODEX_NOOP_OPERATION = 'plugin-remove';
    result = lifecycle === 'update'
      ? await runInProcessBootstrap(['update', ...context.common], context)
      : await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
        '--codex-executable', context.executable], context);
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
      { exitCode: 1, state: 'failed', errorCode: `${lifecycle}_failed` }, lifecycle);
    const registrations = JSON.parse(await readFile(context.state, 'utf8'));
    assert.equal(registrations.marketplaces[0].path, context.managed, lifecycle);
    assert.equal(registrations.plugins[0].version, marker.manifest_version, lifecycle);
    assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, marker.artifact_hash, lifecycle);
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }

  const context = await fixture(t);
  let result = await runInProcessBootstrap(['install', ...context.common], context);
  assert.equal(result.envelope.state, 'installed');
  const marker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
  context.env.FAKE_CODEX_NOOP_OPERATION = 'marketplace-remove';
  result = await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], context);
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
    { exitCode: 1, state: 'failed', errorCode: 'uninstall_failed' });
  const registrations = JSON.parse(await readFile(context.state, 'utf8'));
  assert.deepEqual(registrations.marketplaces, [{ id: 'agents-cursor-subagent-plugin', path: context.managed }]);
  assert.deepEqual(registrations.plugins, [{ id: 'agents-cursor-subagent-plugin', marketplace_id: 'agents-cursor-subagent-plugin',
    source: join(context.managed, 'plugins/agents-cursor-subagent-plugin'), version: marker.manifest_version }]);
  assert.deepEqual(registrations.mutations.slice(-3), ['plugin-remove', 'marketplace-remove', 'plugin-add']);
  assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, marker.artifact_hash);
  await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
});

test('update and uninstall never add compensation over foreign, duplicate or coupled observed tuples', async (t) => {
  for (const [lifecycle, operation, drift, uncertain] of [
    ['update', 'plugin-remove', 'duplicate-marketplace', true],
    ['uninstall', 'plugin-remove', 'coupled', true],
    ['update', 'plugin-add', 'target-plugin', true],
    ['update', 'plugin-remove', 'duplicate-marketplace', false],
    ['uninstall', 'plugin-remove', 'coupled', false],
  ]) {
    const context = await fixture(t); let result = await runInProcessBootstrap(['install', ...context.common], context); assert.equal(result.exitCode, 0);
    if (lifecycle === 'update') await writeFile(join(context.source, 'README.md'), `${drift}\n`);
    if (uncertain) context.env.FAKE_CODEX_PARTIAL_OPERATION = operation;
    context.env.FAKE_CODEX_OBSERVED_DRIFT_OPERATION = operation;
    context.env.FAKE_CODEX_OBSERVED_DRIFT_KIND = drift;
    result = lifecycle === 'update'
      ? await runInProcessBootstrap(['update', ...context.common], context)
      : await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', context.managed, '--codex-executable', context.executable], context);
    assert.equal(result.envelope.state, 'recovery_required', `${lifecycle}:${operation}:${drift}:${uncertain}`);
    const mutations = JSON.parse(await readFile(context.state, 'utf8')).mutations;
    const uncertainIndex = mutations.lastIndexOf(operation);
    assert.equal(mutations.slice(uncertainIndex + 1).some((name) => name.endsWith('-add')), false, mutations.join(','));
  }
});

test('pre-commit publication rename faults compensate install and update while uninstall commit fault is cleanup_required', async (t) => {
  for (const step of ['publication:before-install-stage-to-active', 'publication:after-install-stage-to-active']) {
    const context = await fixture(t);
    const result = await runInProcessBootstrap(['install', ...context.common], context, {
      fault: async (observed) => { if (observed === step) throw new Error(step); } });
    assert.equal(result.envelope.state, 'failed', step);
    await assert.rejects(realpath(context.managed), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.agents-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
  for (const step of ['publication:before-update-active-to-backup', 'publication:after-update-active-to-backup',
    'publication:before-update-stage-to-active', 'publication:after-update-stage-to-active']) {
    const context = await fixture(t); let result = await runInProcessBootstrap(['install', ...context.common], context);
    const original = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')); await writeFile(join(context.source, 'README.md'), `${step}\n`);
    result = await runInProcessBootstrap(['update', ...context.common], context, {
      fault: async (observed) => { if (observed === step) throw new Error(step); } });
    assert.equal(result.envelope.state, 'failed', step);
    assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, original.artifact_hash, step);
  }
  const cleanupOwnership = await fixture(t);
  let result = await runInProcessBootstrap(['install', ...cleanupOwnership.common], cleanupOwnership);
  assert.equal(result.exitCode, 0);
  await writeFile(join(cleanupOwnership.source, 'README.md'), 'cleanup ownership recheck\n');
  const backupPath = `${cleanupOwnership.managed}.agents-cursor-subagent-plugin.backup`;
  result = await runInProcessBootstrap(['update', ...cleanupOwnership.common], cleanupOwnership, {
    fault: async (step) => {
      if (step === 'publication:after-update-stage-to-active') await rm(join(backupPath, MARKER_NAME));
    } });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, backupPath: result.envelope.backup_path },
    { exitCode: 1, state: 'cleanup_required', backupPath });
  assert.equal((await lstat(backupPath)).isDirectory(), true);
  await assert.rejects(lstat(join(backupPath, MARKER_NAME)), { code: 'ENOENT' });

  const beforeUninstall = await fixture(t); result = await runInProcessBootstrap(['install', ...beforeUninstall.common], beforeUninstall); assert.equal(result.exitCode, 0);
  result = await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', beforeUninstall.managed, '--codex-executable', beforeUninstall.executable],
    beforeUninstall, { fault: async (step) => { if (step === 'publication:before-uninstall-active-to-backup') throw new Error(step); } });
  assert.equal(result.envelope.state, 'failed'); assert.ok(await realpath(beforeUninstall.managed));

  const uninstallContext = await fixture(t); result = await runInProcessBootstrap(['install', ...uninstallContext.common], uninstallContext); assert.equal(result.exitCode, 0);
  result = await runInProcessBootstrap(['uninstall', '--managed-marketplace-root', uninstallContext.managed, '--codex-executable', uninstallContext.executable],
    uninstallContext, { fault: async (step) => { if (step === 'publication:after-uninstall-active-to-backup') throw new Error(step); } });
  assert.equal(result.envelope.state, 'cleanup_required'); assert.equal(result.envelope.backup_path, `${uninstallContext.managed}.agents-cursor-subagent-plugin.backup`);
});

test('plugin registration version must equal the installed cachebuster', async (t) => {
  const context = await fixture(t); let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
  const state = JSON.parse(await readFile(context.state, 'utf8')); state.plugins[0].version = '0.1.0+codex.bad'; await writeFile(context.state, JSON.stringify(state));
  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.checks.find(({ name }) => name === 'plugin_registration').code, 'foreign');
  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.envelope.error_code, 'state_drift');
});
