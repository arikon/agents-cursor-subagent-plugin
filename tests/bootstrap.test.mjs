import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MARKER_NAME, canonicalJson, normalizeManifestBytes, parseArgs, runBootstrap, runPackageCommand, treeHashV1, validateTopology,
} from '../scripts/cursor-subagent-bootstrap.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const adapter = fileURLToPath(new URL('./fixtures/fake-codex-adapter.mjs', import.meta.url));
const versionedAdapter = fileURLToPath(new URL('./fixtures/codex-v01521-adapter.mjs', import.meta.url));
const adapterGolden = fileURLToPath(new URL('./fixtures/codex-v01521-adapter.golden.json', import.meta.url));
const fakeCodexCli = fileURLToPath(new URL('./fixtures/fake-codex-cli-v01521.mjs', import.meta.url));
const fakeCursorAgentStatus = fileURLToPath(new URL('./fixtures/fake-cursor-agent-status.mjs', import.meta.url));
const killWaitCommand = fileURLToPath(new URL('./fixtures/kill-wait-command.mjs', import.meta.url));

async function adapterFixtureCall(executable, operation, request, env, adapterPath = adapter) {
  const result = await adapterFixtureResult(executable, operation, request, env, adapterPath);
  assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
}

async function adapterFixtureResult(executable, operation, request, env, adapterPath = adapter) {
  const child = spawn(executable, [adapterPath, operation, JSON.stringify(request)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = []; const errors = []; child.stdout.on('data', (chunk) => output.push(chunk)); child.stderr.on('data', (chunk) => errors.push(chunk));
  const code = await new Promise((resolveExit) => child.once('close', resolveExit));
  return { code, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-bootstrap-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); const workspace = join(root, 'workspace'); const managed = join(root, 'managed-marketplace');
  await mkdir(source); await mkdir(workspace);
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(repository, path), join(source, path));
  }
  await cp(join(repository, 'skills'), join(source, 'skills'), { recursive: true });
  const executable = await realpath(process.execPath); const state = join(root, 'codex-state.json');
  const env = { ...process.env, FAKE_CODEX_STATE: state, CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([executable, adapter]) };
  const common = ['--source-root', source, '--managed-marketplace-root', managed, '--node-executable', executable,
    '--codex-executable', executable, '--agent-executable', executable, '--allowed-workspace-root', workspace];
  return { root, source, workspace, managed, executable, state, env, common };
}

test('canonical manifest normalization sorts objects recursively and preserves arrays', () => {
  const normalized = normalizeManifestBytes('{"z":{"b":2,"a":1},"version":"1.2.3+codex.old","a":[{"z":1,"a":2},1]}');
  assert.equal(normalized.baseVersion, '1.2.3');
  assert.equal(normalized.bytes.toString(), '{"a":[{"a":2,"z":1},1],"version":"1.2.3","z":{"a":1,"b":2}}');
  assert.throws(() => normalizeManifestBytes('{"version":"1.2.3+foreign.1"}'), { code: 'invalid_manifest' });
  for (const version of ['1.2.3-01', '1.2.3-a..b', '1.2.3-', '1.2.3+codex.', '01.2.3']) {
    assert.throws(() => normalizeManifestBytes(JSON.stringify({ version })), { code: 'invalid_manifest' }, version);
  }
  assert.equal(canonicalJson({ b: [2, 1], a: true }), '{"a":true,"b":[2,1]}');
});

test('versioned Codex adapter help matches its checked-in golden operation and outcome surface', async (t) => {
  const context = await fixture(t); const golden = JSON.parse(await readFile(adapterGolden, 'utf8'));
  const codex = join(context.root, 'codex'); await cp(fakeCodexCli, codex); await chmod(codex, 0o755);
  const agent = join(context.root, 'agent'); await cp(fakeCursorAgentStatus, agent); await chmod(agent, 0o755);
  const log = join(context.root, 'codex-argv.log'); const agentLog = join(context.root, 'agent-argv.log');
  const state = join(context.root, 'versioned-state.json');
  const env = { ...process.env, FAKE_CODEX_CLI_LOG: log, FAKE_CODEX_CLI_STATE: state, FAKE_CURSOR_AGENT_LOG: agentLog };
  const help = await adapterFixtureCall(context.executable, 'help', { codex_executable: codex }, env, versionedAdapter);
  assert.deepEqual(help, { adapter_version: golden.adapter_version, codex_version: golden.codex_version, operations: golden.operations });
  const rendered = await adapterFixtureCall(context.executable, 'render', {
    codex_executable: codex, node_executable: context.executable, agent_executable: agent,
    install_root: join(context.managed, 'plugins/codex-cursor-subagent-plugin'), allowed_workspace_roots: [context.workspace],
  }, env, versionedAdapter);
  assert.deepEqual(rendered.files.map(({ path }) => path), ['.agents/plugins/marketplace.json', 'plugins/codex-cursor-subagent-plugin/.mcp.json']);
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
  let lifecycle = await runBootstrap(['install', ...args], { env: adapterEnv }); assert.equal(lifecycle.exitCode, 0, JSON.stringify(lifecycle));
  lifecycle = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed, '--node-executable', context.executable,
    '--codex-executable', codex, '--agent-executable', agent], { env: adapterEnv });
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
  lifecycle = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed, '--node-executable', context.executable,
    '--codex-executable', codex, '--agent-executable', agent], { env: { ...adapterEnv, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.152.2' } });
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'codex_cli').status, 'fail');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'marketplace_registration').status, 'not_checked');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'plugin_registration').status, 'not_checked');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'mcp_config').status, 'pass');
  assert.equal(lifecycle.envelope.checks.find(({ name }) => name === 'agent_status').status, 'pass');
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).slice(codexBeforeIndependent), [['--version']]);
  assert.deepEqual((await readFile(agentLog, 'utf8')).trim().split('\n').map(JSON.parse).slice(agentBeforeIndependent),
    [['--version'], ['status', '--format', 'json']]);
  lifecycle = await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed, '--codex-executable', codex], { env: adapterEnv });
  assert.equal(lifecycle.exitCode, 0, JSON.stringify(lifecycle));
  const invocations = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const [name, expected] of Object.entries(golden.cli_forms).filter(([name, value]) => !name.startsWith('agent_') &&
    !value.includes('<SOURCE>') && !value.includes('<MARKETPLACE>') && !value.some((part) => part.includes('<PLUGIN>')))) {
    assert.equal(invocations.some((actual) => JSON.stringify(actual) === JSON.stringify(expected)), true, JSON.stringify(expected));
  }
  for (const expected of [
    ['plugin', 'marketplace', 'add', context.managed, '--json'],
    ['plugin', 'add', 'codex-cursor-subagent-plugin@codex-cursor-subagent-plugin', '--json'],
    ['plugin', 'remove', 'codex-cursor-subagent-plugin@codex-cursor-subagent-plugin', '--json'],
    ['plugin', 'marketplace', 'remove', 'codex-cursor-subagent-plugin', '--json'],
  ]) {
    assert.equal(invocations.some((actual) => JSON.stringify(actual) === JSON.stringify(expected)), true, JSON.stringify(expected));
  }
  const unknown = await adapterFixtureCall(context.executable, 'admit', { codex_executable: codex }, { ...env, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.152.2' }, versionedAdapter);
  assert.equal(unknown.admitted, false);
  const beforeUnknown = (await readFile(log, 'utf8')).trim().split('\n').length;
  lifecycle = await runBootstrap(['install', ...args], { env: { ...adapterEnv, FAKE_CODEX_CLI_VERSION: 'codex-cli 0.152.2' } });
  assert.equal(lifecycle.envelope.error_code, 'adapter_drift');
  const afterUnknown = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).slice(beforeUnknown);
  assert.deepEqual(afterUnknown, [['--version']], 'unknown version must stop before read or mutation argv');
});

test('versioned adapter bounds nested Cursor commands and waits for killed child close', async (t) => {
  const context = await fixture(t); const agent = join(context.root, 'agent'); await cp(fakeCursorAgentStatus, agent); await chmod(agent, 0o755);
  const pidPath = join(context.root, 'nested-agent.pid'); const started = Date.now();
  let result = await adapterFixtureResult(context.executable, 'agent-status', { agent_executable: agent }, {
    ...process.env, FAKE_CURSOR_AGENT_BLOCK_ARGV: '--version', FAKE_CURSOR_AGENT_PID_PATH: pidPath,
  }, versionedAdapter);
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1); assert.match(result.stderr, /nested command timed out/); assert.ok(elapsed >= 9_000 && elapsed < 13_000, elapsed);
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
      ...(overflow ? { KILL_WAIT_OVERFLOW: '1' } : {}) }, timeoutMs: overflow ? 1_000 : 50, outputBytes: 64, closeWaitMs: 1_000 });
    assert.equal(overflow ? result.overflow : result.timeout, true);
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `child ${pid} was still alive after command return`);
    assert.equal(result.closeTimeout, undefined);
  }
});

test('treeHashV1 has a stable byte-framed golden vector', () => {
  assert.equal(treeHashV1([{ path: 'b', content: 'two' }, { path: 'a', content: 'one' }]), 'b7cfd8f25704e2e9e7d848116d1f8a90458415103d8972181996f5b8b815d1a7');
  assert.throws(() => treeHashV1([{ path: '../escape', content: '' }]), { code: 'invalid_hash_entry' });
});

test('strict parser separates malformed invocation from semantic topology failure', async (t) => {
  assert.throws(() => parseArgs(['preflight', '--managed-marketplace-root', 'relative']), { code: 'invalid_invocation', exitCode: 2 });
  const context = await fixture(t);
  await assert.rejects(validateTopology({
    managedRoot: join(context.source, 'nested-managed'), sourceRoot: context.source,
    nodeExecutable: context.executable, codexExecutable: context.executable, agentExecutable: context.executable,
    allowedWorkspaceRoots: [context.workspace],
  }, { requireSource: true, requireAgent: true }), { code: 'topology_invalid' });
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
  assert.equal(calls.some((operation) => /(?:add|remove)$/.test(operation)), false);
});

test('fake adapter drives portable install, identical no-op, update, preflight and uninstall', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, ok: result.envelope.ok, state: result.envelope.state }, { exitCode: 0, ok: true, state: 'installed' }, JSON.stringify(result));
  const pluginRoot = join(context.managed, 'plugins/codex-cursor-subagent-plugin');
  const config = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'));
  assert.equal(config.args[0], join(pluginRoot, 'scripts/cursor-subagent-mcp.mjs'));
  assert.equal(config.args[0].startsWith(context.source), false);
  assert.equal(config.env.AGENT_CLI_CREDENTIAL_STORE, 'file');
  const marker = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
  assert.match(marker.manifest_version, /^0\.1\.0\+codex\.[0-9a-f]{64}$/);

  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.envelope.state, 'installed');
  await writeFile(join(context.source, 'README.md'), 'changed payload\n');
  result = await runBootstrap(['update', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 0, state: 'installed' }, JSON.stringify(result));
  assert.equal(await readFile(join(pluginRoot, 'README.md'), 'utf8'), 'changed payload\n');

  result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable,
    '--agent-executable', context.executable], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, auth: result.envelope.auth_state }, { exitCode: 0, state: 'ready', auth: 'authenticated' });

  result = await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
    '--codex-executable', context.executable], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 0, state: 'absent' });
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
    let result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.equal(result.envelope.state, 'installed', step);
    await writeFile(join(context.source, 'README.md'), `changed for ${step}\n`);
    result = await runBootstrap(['update', ...context.common], {
      env: context.env,
      fault: async (observed) => { if (observed === step) throw new Error(`injected ${step}`); },
    });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 1, state: 'cleanup_required' }, step);
    assert.equal(result.envelope.backup_path, `${context.managed}.codex-cursor-subagent-plugin.backup`, step);
    const before = JSON.parse(await readFile(context.state, 'utf8')).mutations.length;
    result = await runBootstrap(['update', ...context.common], { env: context.env });
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
    let result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.equal(result.envelope.state, 'installed', operation);
    if (operation === 'update') {
      await writeFile(join(context.source, 'README.md'), 'update requiring compensation\n');
      context.env.FAKE_CODEX_FAIL_OPERATIONS = 'plugin-add';
      result = await runBootstrap(['update', ...context.common], { env: context.env });
    } else {
      context.env.FAKE_CODEX_FAIL_OPERATIONS = 'marketplace-remove,plugin-add';
      result = await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed,
        '--codex-executable', context.executable], { env: context.env });
    }
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 1, state: 'recovery_required' }, operation);
    delete context.env.FAKE_CODEX_FAIL_OPERATIONS;
    result = await runBootstrap(['install', ...context.common], { env: context.env });
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
  const config = JSON.parse(await readFile(join(context.managed, 'plugins/codex-cursor-subagent-plugin/.mcp.json'), 'utf8'));
  assert.equal(config.env.FAKE_CODEX_CONFIG_VARIANT, 'second');
});

test('install no-op compares the desired generated artifact hash as well as payload hash', async (t) => {
  const context = await fixture(t);
  let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
  context.env.FAKE_CODEX_CONFIG_VARIANT = 'different-install-config';
  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, code: result.envelope.error_code }, { exitCode: 1, code: 'update_required' });
  assert.equal(await lstat(`${context.managed}.codex-cursor-subagent-plugin.staging`).then(() => true).catch(() => false), false);
});

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
  await writeFile(context.state, JSON.stringify({ marketplaces: [{ id: 'codex-cursor-subagent-plugin', path: context.managed }], plugins: [], mutations: [] }));
  const result = await runBootstrap(['preflight', '--managed-marketplace-root', context.managed,
    '--node-executable', context.executable, '--codex-executable', context.executable], { env: context.env });
  assert.equal(result.envelope.checks.find(({ name }) => name === 'marketplace_registration').status, 'pass');
  assert.equal(result.envelope.checks.find(({ name }) => name === 'plugin_registration').code, 'absent');
});

test('backup and registration recovery classification distinguishes owned deltas from foreign drift', async (t) => {
  const backupContext = await fixture(t);
  let result = await runBootstrap(['install', ...backupContext.common], { env: backupContext.env }); assert.equal(result.exitCode, 0);
  await rename(backupContext.managed, `${backupContext.managed}.codex-cursor-subagent-plugin.backup`);
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', backupContext.managed,
    '--codex-executable', backupContext.executable], { env: backupContext.env });
  assert.equal(result.envelope.state, 'recovery_required');
  assert.equal(result.envelope.backup_path, `${backupContext.managed}.codex-cursor-subagent-plugin.backup`);

  const foreignContext = await fixture(t);
  await writeFile(foreignContext.state, JSON.stringify({ marketplaces: [{ id: 'codex-cursor-subagent-plugin', path: join(foreignContext.root, 'foreign') }], plugins: [], mutations: [] }));
  result = await runBootstrap(['install', ...foreignContext.common], { env: foreignContext.env });
  assert.equal(result.envelope.state, 'failed'); assert.equal(result.envelope.error_code, 'state_drift');

  const independentContext = await fixture(t);
  await writeFile(independentContext.state, JSON.stringify({ marketplaces: [], plugins: [{ id: 'codex-cursor-subagent-plugin', marketplace_id: 'personal', source: join(independentContext.root, 'personal-plugin'), version: '0.1.0+codex.legacy' }], mutations: [] }));
  result = await runBootstrap(['install', ...independentContext.common], { env: independentContext.env });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const independentRegistrations = JSON.parse(await readFile(independentContext.state, 'utf8')).plugins;
  assert.equal(independentRegistrations.some((item) => item.marketplace_id === 'personal'), true);
  assert.equal(independentRegistrations.some((item) => item.marketplace_id === 'codex-cursor-subagent-plugin'), true);
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

test('versioned adapter help drift and render payload override fail before mutation without staging remnants', async (t) => {
  for (const [name, value] of [['FAKE_CODEX_HELP_DRIFT', '1'], ['FAKE_CODEX_RENDER_OVERRIDE', '1']]) {
    const context = await fixture(t); context.env[name] = value;
    const result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.equal(result.envelope.state, 'failed', name);
    assert.equal(JSON.parse(await readFile(context.state, 'utf8').catch(() => '{"mutations":[]}')).mutations.length, 0, name);
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
});

test('nonzero, partial and output-overflow mutators compensate only their observed registration delta', async (t) => {
  const cases = [
    ['FAKE_CODEX_FAIL_OPERATION', 'marketplace-add'],
    ['FAKE_CODEX_PARTIAL_OPERATION', 'marketplace-add'],
    ['FAKE_CODEX_OVERFLOW_OPERATION', 'plugin-add'],
  ];
  for (const [name, operation] of cases) {
    const context = await fixture(t); context.env[name] = operation;
    const result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.equal(result.envelope.state, 'failed', name);
    const state = JSON.parse(await readFile(context.state, 'utf8').catch(() => '{"marketplaces":[],"plugins":[],"mutations":[]}'));
    assert.deepEqual(state.marketplaces, [], name); assert.deepEqual(state.plugins, [], name);
    if (name === 'FAKE_CODEX_FAIL_OPERATION') assert.deepEqual(state.mutations, [], 'a failed add with no observed delta must not run remove');
  }
});

test('mutator timeout compensates an observed partial add and list reread failure requires recovery', async (t) => {
  const timeoutContext = await fixture(t); timeoutContext.env.FAKE_CODEX_TIMEOUT_OPERATION = 'marketplace-add';
  let result = await runBootstrap(['install', ...timeoutContext.common], { env: timeoutContext.env });
  assert.equal(result.envelope.state, 'failed');
  const timeoutState = JSON.parse(await readFile(timeoutContext.state, 'utf8'));
  assert.deepEqual(timeoutState.marketplaces, []); assert.deepEqual(timeoutState.mutations, ['marketplace-add', 'marketplace-remove']);

  const rereadContext = await fixture(t); rereadContext.env.FAKE_CODEX_LIST_FAILURE_AFTER_MUTATION = '1';
  result = await runBootstrap(['install', ...rereadContext.common], { env: rereadContext.env });
  assert.equal(result.envelope.state, 'recovery_required'); assert.match(result.envelope.message, /reread failed/);
  assert.equal(result.envelope.last_completed_step, 'marketplace-add');
  assert.equal(JSON.parse(await readFile(rereadContext.state, 'utf8')).marketplaces[0].path, rereadContext.managed);
});

test('uncertain remove outcomes compensate their observed delta and never advance lifecycle', async (t) => {
  for (const [lifecycle, uncertainOperation] of [
    ['update', 'plugin-remove'], ['uninstall', 'plugin-remove'], ['uninstall', 'marketplace-remove'],
  ]) {
    const context = await fixture(t);
    let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
    const before = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8'));
    if (lifecycle === 'update') await writeFile(join(context.source, 'README.md'), 'uncertain update payload\n');
    context.env.FAKE_CODEX_PARTIAL_OPERATION = uncertainOperation;
    result = lifecycle === 'update'
      ? await runBootstrap(['update', ...context.common], { env: context.env })
      : await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed, '--codex-executable', context.executable], { env: context.env });
    const registrations = JSON.parse(await readFile(context.state, 'utf8'));
    if (uncertainOperation === 'marketplace-remove') {
      assert.equal(result.envelope.state, 'recovery_required');
      assert.deepEqual(registrations.marketplaces, []); assert.deepEqual(registrations.plugins, []);
      assert.deepEqual(registrations.mutations.slice(-2), ['plugin-remove', 'marketplace-remove'], 'coupled delta must not run add compensation');
    } else {
      assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state }, { exitCode: 1, state: 'failed' }, `${lifecycle}:${uncertainOperation}`);
      assert.deepEqual(registrations.marketplaces, [{ id: 'codex-cursor-subagent-plugin', path: context.managed }]);
      assert.deepEqual(registrations.plugins, [{ id: 'codex-cursor-subagent-plugin', marketplace_id: 'codex-cursor-subagent-plugin',
        source: join(context.managed, 'plugins/codex-cursor-subagent-plugin'), version: before.manifest_version }]);
    }
    assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, before.artifact_hash);
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
});

test('update and uninstall never add compensation over foreign, duplicate or coupled observed tuples', async (t) => {
  for (const [lifecycle, operation, drift, uncertain] of [
    ['update', 'plugin-remove', 'duplicate-marketplace', true],
    ['uninstall', 'plugin-remove', 'coupled', true],
    ['update', 'plugin-add', 'target-plugin', true],
    ['update', 'plugin-remove', 'duplicate-marketplace', false],
    ['uninstall', 'plugin-remove', 'coupled', false],
  ]) {
    const context = await fixture(t); let result = await runBootstrap(['install', ...context.common], { env: context.env }); assert.equal(result.exitCode, 0);
    if (lifecycle === 'update') await writeFile(join(context.source, 'README.md'), `${drift}\n`);
    if (uncertain) context.env.FAKE_CODEX_PARTIAL_OPERATION = operation;
    context.env.FAKE_CODEX_OBSERVED_DRIFT_OPERATION = operation;
    context.env.FAKE_CODEX_OBSERVED_DRIFT_KIND = drift;
    result = lifecycle === 'update'
      ? await runBootstrap(['update', ...context.common], { env: context.env })
      : await runBootstrap(['uninstall', '--managed-marketplace-root', context.managed, '--codex-executable', context.executable], { env: context.env });
    assert.equal(result.envelope.state, 'recovery_required', `${lifecycle}:${operation}:${drift}:${uncertain}`);
    const mutations = JSON.parse(await readFile(context.state, 'utf8')).mutations;
    const uncertainIndex = mutations.lastIndexOf(operation);
    assert.equal(mutations.slice(uncertainIndex + 1).some((name) => name.endsWith('-add')), false, mutations.join(','));
  }
});

test('pre-commit publication rename faults compensate install and update while uninstall commit fault is cleanup_required', async (t) => {
  for (const step of ['publication:before-install-stage-to-active', 'publication:after-install-stage-to-active']) {
    const context = await fixture(t);
    const result = await runBootstrap(['install', ...context.common], { env: context.env,
      fault: async (observed) => { if (observed === step) throw new Error(step); } });
    assert.equal(result.envelope.state, 'failed', step);
    await assert.rejects(realpath(context.managed), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
  for (const step of ['publication:before-update-active-to-backup', 'publication:after-update-active-to-backup',
    'publication:before-update-stage-to-active', 'publication:after-update-stage-to-active']) {
    const context = await fixture(t); let result = await runBootstrap(['install', ...context.common], { env: context.env });
    const original = JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')); await writeFile(join(context.source, 'README.md'), `${step}\n`);
    result = await runBootstrap(['update', ...context.common], { env: context.env,
      fault: async (observed) => { if (observed === step) throw new Error(step); } });
    assert.equal(result.envelope.state, 'failed', step);
    assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, original.artifact_hash, step);
  }
  const beforeUninstall = await fixture(t); let result = await runBootstrap(['install', ...beforeUninstall.common], { env: beforeUninstall.env }); assert.equal(result.exitCode, 0);
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', beforeUninstall.managed, '--codex-executable', beforeUninstall.executable],
    { env: beforeUninstall.env, fault: async (step) => { if (step === 'publication:before-uninstall-active-to-backup') throw new Error(step); } });
  assert.equal(result.envelope.state, 'failed'); assert.ok(await realpath(beforeUninstall.managed));

  const uninstallContext = await fixture(t); result = await runBootstrap(['install', ...uninstallContext.common], { env: uninstallContext.env }); assert.equal(result.exitCode, 0);
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', uninstallContext.managed, '--codex-executable', uninstallContext.executable],
    { env: uninstallContext.env, fault: async (step) => { if (step === 'publication:after-uninstall-active-to-backup') throw new Error(step); } });
  assert.equal(result.envelope.state, 'cleanup_required'); assert.equal(result.envelope.backup_path, `${uninstallContext.managed}.codex-cursor-subagent-plugin.backup`);
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
