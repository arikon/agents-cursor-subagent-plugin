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
  for (const path of ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/cursor-model-adapter.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs']) {
    await mkdir(join(source, path, '..'), { recursive: true }); await cp(join(repository, path), join(source, path));
  }
  await cp(join(repository, 'skills'), join(source, 'skills'), { recursive: true });
  const executable = await realpath(process.execPath); const state = join(root, 'codex-state.json');
  const env = { ...process.env, FAKE_CODEX_STATE: state, CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND: JSON.stringify([executable, adapter]) };
  const common = ['--source-root', source, '--managed-marketplace-root', managed, '--node-executable', executable,
    '--codex-executable', executable, '--agent-executable', executable, '--allowed-workspace-root', workspace];
  return { root, source, workspace, managed, executable, state, env, common };
}


export {
  assert, spawn, createHash, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile,
  join, tmpdir, fileURLToPath, MARKER_NAME, canonicalJson, normalizeManifestBytes, parseArgs, runBootstrap, runPackageCommand, treeHashV1, validateTopology, runFakeCodexAdapterCommand,
  repository, bootstrapScript, adapter, versionedAdapter, adapterGolden, currentVersionedAdapter, currentAdapterGolden, fakeCodexCli, fakeCursorAgentStatus, killWaitCommand,
  adapterFixtureCall, adapterFixtureResult, runInProcessFakeAdapter, runInProcessBootstrap, bootstrapCli, fixture,
};
