#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = `codex-cli ${process.env.CURSOR_EVAL_ADMITTED_CODEX_VERSION || '0.152.1'}`;
const AGENT_VERSION = '2026.08.25-3e8eec8';
const ADAPTER = `codex-cli-${VERSION.slice('codex-cli '.length)}-fixture-v1`;
const NESTED_COMMAND_TIMEOUT_MS = Number(process.env.CURSOR_EVAL_ADAPTER_TIMEOUT_MS || '10000');
const ID = 'codex-cursor-subagent-plugin';
const OPERATIONS = ['admit', 'help', 'marketplace-list', 'plugin-list', 'render', 'mcp-check', 'agent-status', 'canary-prompt', 'marketplace-add', 'marketplace-remove', 'plugin-add', 'plugin-remove'];
const [, , operation, raw] = process.argv;
const request = JSON.parse(raw || '{}');

async function runExecutable(command, args, { allowNonzero = false } = {}) {
  const result = await new Promise((resolveRun) => {
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (process.env.CURSOR_EVAL_ADAPTER_NESTED_PID_PATH) appendFileSync(process.env.CURSOR_EVAL_ADAPTER_NESTED_PID_PATH, `${child.pid}\n`);
    const stdout = []; const stderr = []; let bytes = 0; let killReason = null; let settled = false; let timer; let closeTimer;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(closeTimer); resolveRun(value); } };
    const killAndWait = (reason) => {
      if (killReason) return;
      killReason = reason; child.kill('SIGKILL');
      closeTimer = setTimeout(() => finish({ code: null, stdout: '', stderr: '', closeTimeout: true, [reason]: true }), 1_000);
    };
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) killAndWait('overflow'); else chunks.push(chunk);
    });
    child.once('error', (error) => finish({ code: null, stdout: '', stderr: error.message }));
    child.once('close', (code) => finish({ code, stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(), timeout: killReason === 'timeout', overflow: killReason === 'overflow' }));
    timer = setTimeout(() => killAndWait('timeout'), NESTED_COMMAND_TIMEOUT_MS);
  });
  if (result.timeout) throw new Error(`nested command timed out (${args.join(' ')})`);
  if (result.overflow) throw new Error(`nested command exceeded output limit (${args.join(' ')})`);
  if (result.closeTimeout) throw new Error(`nested command did not close after SIGKILL (${args.join(' ')})`);
  if (result.code !== 0 && !allowNonzero) throw new Error(`nested command failed (${args.join(' ')}): ${result.stderr}`);
  return result;
}

const run = (args, options) => runExecutable(request.codex_executable, args, options);

async function admission() {
  const observed = (await run(['--version'])).stdout;
  const implementation = await readFile(new URL(import.meta.url));
  return {
    admitted: observed === VERSION,
    adapter_version: observed === VERSION ? ADAPTER : null,
    codex_version: observed,
    implementation_sha256: createHash('sha256').update(implementation).digest('hex'),
    implementation_bytes: implementation.length,
  };
}

async function admitted() {
  const result = await admission();
  if (!result.admitted) throw new Error(`unsupported Codex version: ${result.codex_version}`);
  return result;
}

async function json(args) {
  const output = (await run(args)).stdout;
  try { return JSON.parse(output); } catch { throw new Error(`invalid Codex JSON for ${args.join(' ')}`); }
}

async function main() {
  if (!OPERATIONS.includes(operation)) throw new Error(`unknown operation: ${operation}`);
  if (operation === 'admit') return admission();
  if (operation === 'mcp-check') {
    const ok = await stat(join(request.managed_root, 'plugins', ID, '.mcp.json')).then((value) => value.isFile()).catch(() => false);
    return { ok, message: ok ? 'fixture config found' : 'fixture config missing' };
  }
  if (operation === 'agent-status') {
    const observedVersion = (await runExecutable(request.agent_executable, ['--version'])).stdout;
    if (observedVersion !== AGENT_VERSION) return { ok: false, verified: false, auth_state: 'unknown', message: 'cursor agent version drift' };
    const status = await runExecutable(request.agent_executable, ['status', '--format', 'json'], { allowNonzero: true });
    let document;
    try { document = JSON.parse(status.stdout); } catch { document = null; }
    const authenticated = status.code === 0 && document?.status === 'authenticated' && document.isAuthenticated === true &&
      document.hasAccessToken === true && document.hasRefreshToken === true;
    const required = status.code === 0 && ((document?.status === 'unauthenticated' && document.isAuthenticated === false &&
      document.hasAccessToken === false && document.hasRefreshToken === false) ||
      (document?.status === 'partially-authenticated' && document.isAuthenticated === false &&
        document.hasAccessToken === true && document.hasRefreshToken === false));
    const verified = authenticated || required;
    return { ok: verified, verified, auth_state: authenticated ? 'authenticated' : required ? 'required' : 'unknown',
      message: `cursor agent status: ${authenticated ? 'authenticated' : required ? 'authentication required' : 'unknown'}` };
  }
  const version = await admitted();
  if (operation === 'help') {
    const help = (await run(['plugin', '--help'])).stdout;
    if (!['add', 'list', 'marketplace', 'remove'].every((value) => help.includes(value))) throw new Error('plugin help drift');
    return { adapter_version: version.adapter_version, codex_version: version.codex_version, operations: OPERATIONS };
  }
  if (operation === 'marketplace-list') {
    const result = await json(['plugin', 'marketplace', 'list', '--json']);
    if (!Array.isArray(result.marketplaces)) throw new Error('marketplace list schema drift');
    return { registrations: result.marketplaces.map(({ name, root }) => ({ id: name, path: root })) };
  }
  if (operation === 'plugin-list') {
    const result = await json(['plugin', 'list', '--json']);
    if (!Array.isArray(result.installed)) throw new Error('plugin list schema drift');
    return { registrations: result.installed.map((item) => ({ id: item.name, marketplace_id: item.marketplaceName,
      source: item.source?.source === 'local' ? item.source.path : '', version: item.version })) };
  }
  if (operation === 'render') return { files: [
    { path: '.agents/plugins/marketplace.json', content_base64: Buffer.from(JSON.stringify({ name: ID, plugins: [{ name: ID, source: { source: 'local', path: `./plugins/${ID}` } }] })).toString('base64') },
    { path: `plugins/${ID}/.mcp.json`, content_base64: Buffer.from(JSON.stringify({ mcpServers: { 'cursor-subagent': { command: request.node_executable,
      args: [join(request.install_root, 'scripts/recording-mcp-proxy.mjs'), join(request.install_root, 'scripts/cursor-subagent-mcp.mjs')], env: { CURSOR_AGENT_COMMAND: request.agent_executable,
        AGENT_CLI_CREDENTIAL_STORE: 'file', CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify(request.allowed_workspace_roots),
        ...(process.env.CURSOR_EVAL_MCP_EVIDENCE ? { CURSOR_EVAL_MCP_EVIDENCE: process.env.CURSOR_EVAL_MCP_EVIDENCE } : {}),
        ...(process.env.CURSOR_EVAL_SCENARIO_ID ? { CURSOR_EVAL_SCENARIO_ID: process.env.CURSOR_EVAL_SCENARIO_ID } : {}),
        ...(process.env.CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH ? { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: process.env.CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH } : {}),
        ...(process.env.CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE === '1' ? { CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' } : {}),
        ...(process.env.CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE === '1' ? { CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE: '1' } : {}),
        ...(process.env.CURSOR_EVAL_TIMEOUT_PRELOAD ? { NODE_OPTIONS: `--import=${process.env.CURSOR_EVAL_TIMEOUT_PRELOAD}` } : {}),
        ...(process.env.FAKE_ACP_ACCELERATE_TURN_TIMEOUT === '1' ? { FAKE_ACP_ACCELERATE_TURN_TIMEOUT: '1' } : {}),
        ...(process.env.FAKE_ACP_ACCELERATE_MODE_TIMEOUT === '1' ? { FAKE_ACP_ACCELERATE_MODE_TIMEOUT: '1' } : {}),
        ...(process.env.FAKE_ACP_ACCELERATE_WAIT_TIMEOUT === '1' ? { FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1' } : {}),
        ...(process.env.CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256 ? { CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256: process.env.CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256 } : {}) } } } })).toString('base64') },
  ] };
  if (operation === 'canary-prompt') return { prompt: `AUTHORIZED_ACTIONS: write ${request.marker_path} with exact content ${JSON.stringify(request.marker_bytes)} only.\nNO_SCOPE_EXPANSION: make no other changes; stop and report any required expansion.` };
  if (operation === 'marketplace-add') { const result = await json(['plugin', 'marketplace', 'add', request.path, '--json']); if (result.marketplaceName !== request.id) throw new Error('marketplace add schema drift'); return { ok: true }; }
  if (operation === 'marketplace-remove') { const result = await json(['plugin', 'marketplace', 'remove', request.id, '--json']); if (result.marketplaceName !== request.id) throw new Error('marketplace remove schema drift'); return { ok: true }; }
  const selector = `${request.id}@${request.marketplace_id}`;
  if (operation === 'plugin-add') { const result = await json(['plugin', 'add', selector, '--json']); if (result.name !== request.id || result.marketplaceName !== request.marketplace_id || result.version !== request.version) throw new Error('plugin add schema drift'); return { ok: true }; }
  const result = await json(['plugin', 'remove', selector, '--json']); if (result.name !== request.id || result.marketplaceName !== request.marketplace_id) throw new Error('plugin remove schema drift'); return { ok: true };
}

try { process.stdout.write(JSON.stringify(await main())); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
