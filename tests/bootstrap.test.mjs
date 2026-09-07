import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MARKER_NAME, canonicalJson, normalizeManifestBytes, parseArgs, runBootstrap, runPackageCommand, treeHashV1, validateTopology,
} from '../scripts/cursor-subagent-bootstrap.mjs';
import { runFakeCodexAdapterCommand } from './fixtures/fake-codex-adapter-core.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const bootstrapScript = fileURLToPath(new URL('../scripts/cursor-subagent-bootstrap.mjs', import.meta.url));
const adapter = fileURLToPath(new URL('./fixtures/fake-codex-adapter.mjs', import.meta.url));
const versionedAdapter = fileURLToPath(new URL('./fixtures/codex-v01521-adapter.mjs', import.meta.url));
const adapterGolden = fileURLToPath(new URL('./fixtures/codex-v01521-adapter.golden.json', import.meta.url));
const currentVersionedAdapter = fileURLToPath(new URL('./fixtures/codex-v01534-adapter.mjs', import.meta.url));
const currentAdapterGolden = fileURLToPath(new URL('./fixtures/codex-v01534-adapter.golden.json', import.meta.url));
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

const runInProcessFakeAdapter = (command, args, options) => runFakeCodexAdapterCommand(command, args, options);
const runInProcessBootstrap = (args, context, overrides = {}) => runBootstrap(args, {
  env: context.env, runCommand: runInProcessFakeAdapter, ...overrides,
});

async function bootstrapCli(args, env = process.env) {
  const child = spawn(process.execPath, [bootstrapScript, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = []; const errors = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const code = await new Promise((resolveExit) => child.once('close', resolveExit));
  const stdout = Buffer.concat(output).toString('utf8');
  const stderr = Buffer.concat(errors).toString('utf8');
  return { code, stdout, stderr, envelope: JSON.parse(stdout) };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cursor-bootstrap-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); const workspace = join(root, 'workspace'); const managed = join(root, 'managed-marketplace');
  await mkdir(source); await mkdir(workspace);
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(repository, path), join(source, path));
  }
  await cp(join(repository, 'skills'), join(source, 'skills'), { recursive: true });
  const executable = await realpath(process.execPath); const state = join(root, 'codex-state.json');
  const env = { ...process.env, FAKE_CODEX_STATE: state, CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([executable, adapter]) };
  const common = ['--source-root', source, '--managed-marketplace-root', managed, '--node-executable', executable,
    '--codex-executable', executable, '--agent-executable', executable, '--allowed-workspace-root', workspace];
  return { root, source, workspace, managed, executable, state, env, common };
}

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
    assert.deepEqual({ code: cli.code, output: cli.output, timeout: cli.timeout, overflow: cli.overflow }, core, scenario.name);
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
  await assert.rejects(lstat(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
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
  await assert.rejects(lstat(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
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
  const staging = `${context.managed}.codex-cursor-subagent-plugin.staging`;
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
  const pluginRoot = join(context.managed, 'plugins/codex-cursor-subagent-plugin');
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
  assert.equal(await readFile(join(context.managed, 'plugins/codex-cursor-subagent-plugin/README.md'), 'utf8'),
    'updated through the public CLI\n');
  await assert.rejects(lstat(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  await assert.rejects(lstat(`${context.managed}.codex-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
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

test('canonical manifest normalization sorts objects recursively and preserves arrays', () => {
  const normalized = normalizeManifestBytes('{"z":{"b":2,"a":1},"version":"1.2.3+codex.old","a":[{"z":1,"a":2},1]}');
  assert.equal(normalized.baseVersion, '1.2.3');
  assert.equal(normalized.bytes.toString(), '{"a":[{"a":2,"z":1},1],"version":"1.2.3","z":{"a":1,"b":2}}');
  assert.throws(() => normalizeManifestBytes('{"version":"1.2.3+foreign.1"}'), { code: 'invalid_manifest' });
  for (const version of ['1.2.3-01', '1.2.3-a..b', '1.2.3-', '1.2.3+codex.', '01.2.3']) {
    assert.throws(() => normalizeManifestBytes(JSON.stringify({ version })), { code: 'invalid_manifest' }, version);
  }
  assert.equal(canonicalJson({ b: [2, 1], a: true }), '{"a":true,"b":[2,1]}');
  assert.throws(() => canonicalJson(undefined), { code: 'invalid_json' });
  assert.throws(() => normalizeManifestBytes('[]'), { code: 'invalid_manifest' });
  assert.throws(() => normalizeManifestBytes('{}'), { code: 'invalid_manifest' });
  assert.equal(normalizeManifestBytes('{"version":"1.2.3-rc.1"}').baseVersion, '1.2.3-rc.1');
});

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
    install_root: join(context.managed, 'plugins/codex-cursor-subagent-plugin'), allowed_workspace_roots: [context.workspace],
  }, env, versionedAdapter);
  assert.deepEqual(rendered.files.map(({ path }) => path), ['.agents/plugins/marketplace.json', 'plugins/codex-cursor-subagent-plugin/.mcp.json']);
  const timeoutPreload = join(context.root, 'accelerate-turn-timeout.mjs');
  const timeoutRendered = await adapterFixtureCall(context.executable, 'render', {
    codex_executable: codex, node_executable: context.executable, agent_executable: agent,
    install_root: join(context.managed, 'plugins/codex-cursor-subagent-plugin'), allowed_workspace_roots: [context.workspace],
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
    ['plugin', 'add', 'codex-cursor-subagent-plugin@codex-cursor-subagent-plugin', '--json'],
    ['plugin', 'remove', 'codex-cursor-subagent-plugin@codex-cursor-subagent-plugin', '--json'],
    ['plugin', 'marketplace', 'remove', 'codex-cursor-subagent-plugin', '--json'],
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
    ['plugin', 'list', '--marketplace', 'codex-cursor-subagent-plugin', '--json'],
  ]);
  assert.deepEqual(currentGolden.cli_forms.plugin_list,
    ['plugin', 'list', '--marketplace', 'codex-cursor-subagent-plugin', '--json']);
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

test('treeHashV1 has a stable byte-framed golden vector', () => {
  assert.equal(treeHashV1([{ path: 'b', content: 'two' }, { path: 'a', content: 'one' }]), 'b7cfd8f25704e2e9e7d848116d1f8a90458415103d8972181996f5b8b815d1a7');
  assert.throws(() => treeHashV1([{ path: '../escape', content: '' }]), { code: 'invalid_hash_entry' });
  assert.throws(() => treeHashV1([{ path: 'same', content: '' }, { path: 'same', content: '' }]), { code: 'invalid_hash_entry' });
});

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
  const pluginRoot = join(context.managed, 'plugins/codex-cursor-subagent-plugin');
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
  await assert.rejects(lstat(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });

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
    'codex plugin marketplace upgrade codex-cursor-subagent-plugin',
    'codex plugin remove codex-cursor-subagent-plugin@codex-cursor-subagent-plugin',
    'codex plugin add codex-cursor-subagent-plugin@codex-cursor-subagent-plugin',
  ];
  const positions = commands.map((command) => readme.indexOf(command, readme.indexOf('Updating an existing installation')));
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
    assert.equal(result.envelope.backup_path, `${context.managed}.codex-cursor-subagent-plugin.backup`, step);
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
  await writeFile(join(context.managed, 'plugins/codex-cursor-subagent-plugin/README.md'), 'foreign managed edit\n');
  result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
    { exitCode: 1, state: 'failed', errorCode: 'state_drift' });
  assert.equal(JSON.parse(await readFile(context.state, 'utf8')).mutations.length, mutationCount);
});

test('publication remnant classification rejects conflicting, foreign and invalid paths', async (t) => {
  for (const kind of ['stage-and-backup', 'foreign-stage', 'invalid-stage', 'foreign-active']) {
    const context = await fixture(t);
    const staging = `${context.managed}.codex-cursor-subagent-plugin.staging`;
    const backup = `${context.managed}.codex-cursor-subagent-plugin.backup`;
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
    id: 'codex-cursor-subagent-plugin',
    marketplace_id: 'codex-cursor-subagent-plugin',
    source: join(context.managed, 'plugins/codex-cursor-subagent-plugin'),
    version: '0.1.0+codex.foreign',
  };
  await writeFile(context.state, JSON.stringify({
    marketplaces: [{ id: 'codex-cursor-subagent-plugin', path: join(context.root, 'foreign-marketplace') }],
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
  await writeFile(context.state, JSON.stringify({ marketplaces: [{ id: 'codex-cursor-subagent-plugin', path: context.managed }], plugins: [], mutations: [] }));
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
  await rename(backupContext.managed, `${backupContext.managed}.codex-cursor-subagent-plugin.backup`);
  result = await runBootstrap(['uninstall', '--managed-marketplace-root', backupContext.managed,
    '--codex-executable', backupContext.executable], { env: backupContext.env });
  assert.equal(result.envelope.state, 'recovery_required');
  assert.equal(result.envelope.backup_path, `${backupContext.managed}.codex-cursor-subagent-plugin.backup`);

  const partialContext = await fixture(t);
  await writeFile(partialContext.state, JSON.stringify({
    marketplaces: [{ id: 'codex-cursor-subagent-plugin', path: partialContext.managed }], plugins: [], mutations: [],
  }));
  result = await runBootstrap(['install', ...partialContext.common], { env: partialContext.env });
  assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
    { exitCode: 1, state: 'recovery_required', errorCode: 'recovery_required' });
  assert.deepEqual(JSON.parse(await readFile(partialContext.state, 'utf8')).mutations, []);

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

test('versioned adapter help drift fails before mutation without staging remnants', async (t) => {
  const context = await fixture(t); context.env.FAKE_CODEX_HELP_DRIFT = '1';
  const result = await runBootstrap(['install', ...context.common], { env: context.env });
  assert.equal(result.envelope.state, 'failed');
  assert.equal(JSON.parse(await readFile(context.state, 'utf8').catch(() => '{"mutations":[]}')).mutations.length, 0);
  await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
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
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
  }
});

test('incompatible adapter registration entries fail before publication', async (t) => {
  for (const variant of ['invalid-marketplace-entry', 'invalid-plugin-entry']) {
    const context = await fixture(t); context.env.FAKE_CODEX_LIST_VARIANT = variant;
    const result = await runBootstrap(['install', ...context.common], { env: context.env });
    assert.deepEqual({ exitCode: result.exitCode, state: result.envelope.state, errorCode: result.envelope.error_code },
      { exitCode: 1, state: 'failed', errorCode: 'adapter_drift' }, variant);
    await assert.rejects(realpath(context.managed), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
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
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
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
  assert.equal(registrations.plugins[0].source, join(context.managed, 'plugins/codex-cursor-subagent-plugin'));
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
      await rm(`${context.managed}.codex-cursor-subagent-plugin.staging`, { recursive: true });
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
  assert.equal(await lstat(`${context.managed}.codex-cursor-subagent-plugin.backup`).then(() => true).catch(() => false), true);
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
  const staging = `${context.managed}.codex-cursor-subagent-plugin.staging`;
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

    const staging = `${context.managed}.codex-cursor-subagent-plugin.staging`;
    const backup = `${context.managed}.codex-cursor-subagent-plugin.backup`;
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
  await symlink(join(context.root, 'foreign'), join(context.managed, 'plugins/codex-cursor-subagent-plugin/foreign-link'));
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
      assert.deepEqual(registrations.marketplaces, [{ id: 'codex-cursor-subagent-plugin', path: context.managed }]);
      assert.deepEqual(registrations.plugins, [{ id: 'codex-cursor-subagent-plugin', marketplace_id: 'codex-cursor-subagent-plugin',
        source: join(context.managed, 'plugins/codex-cursor-subagent-plugin'), version: before.manifest_version }]);
    }
    assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, before.artifact_hash);
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
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
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
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
  assert.deepEqual(registrations.marketplaces, [{ id: 'codex-cursor-subagent-plugin', path: context.managed }]);
  assert.deepEqual(registrations.plugins, [{ id: 'codex-cursor-subagent-plugin', marketplace_id: 'codex-cursor-subagent-plugin',
    source: join(context.managed, 'plugins/codex-cursor-subagent-plugin'), version: marker.manifest_version }]);
  assert.deepEqual(registrations.mutations.slice(-3), ['plugin-remove', 'marketplace-remove', 'plugin-add']);
  assert.equal(JSON.parse(await readFile(join(context.managed, MARKER_NAME), 'utf8')).artifact_hash, marker.artifact_hash);
  await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.backup`), { code: 'ENOENT' });
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
    await assert.rejects(realpath(`${context.managed}.codex-cursor-subagent-plugin.staging`), { code: 'ENOENT' });
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
  const backupPath = `${cleanupOwnership.managed}.codex-cursor-subagent-plugin.backup`;
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
