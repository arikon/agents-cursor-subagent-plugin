import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ADAPTER, CURSOR_ADAPTER_VERSION, LIMITS, MANIFEST_VERSION, Runtime } from '../scripts/cursor-subagent-mcp.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));
const server = fileURLToPath(new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url));
const cursorAgentGolden = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/cursor-agent-v20260825.golden.json', import.meta.url)), 'utf8'));
const cwd = process.cwd();
const fakeEnvNames = ['CURSOR_API_KEY', 'CURSOR_AGENT_COMMAND', 'CURSOR_SUBAGENT_ADAPTER_ARGS', 'CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH', 'FAKE_ACP_PENDING', 'FAKE_ACP_CALLBACK_VARIANT', 'FAKE_ACP_FS_VARIANT', 'FAKE_ACP_LOG', 'FAKE_ACP_SAFE_EVIDENCE', 'FAKE_ACP_FOLLOWUP_RELEASE_PATH', 'FAKE_ACP_PATH', 'FAKE_ACP_CONTENT', 'FAKE_ACP_LINE', 'FAKE_ACP_LIMIT', 'FAKE_ACP_RESULT', 'FAKE_ACP_BAD_ADMISSION', 'FAKE_ACP_BAD_CAPABILITIES', 'FAKE_ACP_BAD_PROMPT_RESULT', 'FAKE_ACP_STOP_REASON', 'FAKE_ACP_VERSION', 'FAKE_ACP_VERSION_STDERR', 'FAKE_ACP_PICKER_FROM_ARGV', 'FAKE_ACP_MODEL_SELECTION', 'FAKE_ACP_VERSION_MODE', 'FAKE_ACP_UNLINK_COMMAND_ON_VERSION', 'FAKE_ACP_EXIT_ON_PROMPT', 'FAKE_ACP_EXIT_AFTER_RESULT', 'FAKE_ACP_STDOUT_EOF_ON_PROMPT', 'FAKE_ACP_INVALID_UTF8', 'FAKE_ACP_INVALID_FRAME', 'FAKE_ACP_INIT_FRAME', 'FAKE_ACP_INIT_RESPONSE_VARIANT', 'FAKE_ACP_INIT_ERROR_MESSAGE', 'FAKE_ACP_STARTUP_STDERR', 'FAKE_ACP_STARTUP_WARNING', 'FAKE_ACP_SESSION_VARIANT', 'FAKE_ACP_PROMPT_RESPONSE_VARIANT', 'FAKE_ACP_FRAME_VARIANT', 'FAKE_ACP_DELAY_INIT_MS', 'FAKE_ACP_DELAY_RESULT_MS', 'FAKE_ACP_DELAY_SET_MODE_MS', 'FAKE_ACP_IGNORE_CANCEL', 'FAKE_ACP_CRLF', 'FAKE_ACP_REQUIRE_POLICY', 'FAKE_ACP_EXPECT_DEFAULT_ARGV', 'FAKE_ACP_REJECT_PROMPT', 'FAKE_ACP_PROMPT_ERROR_MESSAGE', 'FAKE_ACP_EXPECT_MODEL_ARGV', 'FAKE_ACP_EXPECT_PLUGIN_DIRS', 'FAKE_ACP_ARGV_LOG', 'FAKE_ACP_LOAD_VARIANT', 'FAKE_ACP_PROGRESS_TEXT', 'FAKE_ACP_NOISE_UPDATES', 'FAKE_ACP_SECOND_PROGRESS_TEXT', 'FAKE_ACP_SECOND_PROGRESS_MS', 'FAKE_ACP_HOLD_PROMPT', 'FAKE_ACP_SET_MODE_LOG', 'FAKE_ACP_SET_MODE_VARIANT', 'FAKE_ACP_COLLAB'];

const offlineModelDependencies = {
  readModelAuth: async () => Buffer.from('{}'),
  fetchModels: async () => assert.fail('unit runtime must inject model HTTP explicitly'),
};

function withFake(t, extra = {}) {
  const old = Object.fromEntries(fakeEnvNames.map((name) => [name, process.env[name]]));
  for (const name of fakeEnvNames) delete process.env[name];
  process.env.CURSOR_AGENT_COMMAND = process.execPath;
  process.env.FAKE_ACP_PENDING = extra.pending || '';
  process.env.FAKE_ACP_REQUIRE_POLICY = '1';
  process.env.CURSOR_SUBAGENT_ADAPTER_ARGS = JSON.stringify([fake]);
  for (const [name, value] of Object.entries(extra.env || {})) process.env[name] = value;
  const runtime = new Runtime({ ...offlineModelDependencies, env: { ...process.env }, roots: Object.hasOwn(extra, 'roots') ? extra.roots : [cwd] });
  t.after(async () => {
    try { await runtime.shutdown(); } finally {
      for (const name of fakeEnvNames) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name];
    }
  });
  return runtime;
}

function withInjectedFake(t, extra = {}) {
  const env = isolatedFakeEnvironment({
    ...(extra.pending ? { FAKE_ACP_PENDING: extra.pending } : {}),
    ...extra.env,
  });
  const runtime = new Runtime({ ...offlineModelDependencies, env, roots: Object.hasOwn(extra, 'roots') ? extra.roots : [cwd], ...extra.runtime });
  t.after(() => runtime.shutdown());
  return runtime;
}

function isolatedFakeEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of fakeEnvNames) delete env[name];
  return { ...env, CURSOR_AGENT_COMMAND: process.execPath, FAKE_ACP_PENDING: '', FAKE_ACP_REQUIRE_POLICY: '1',
    CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fake]), ...overrides };
}

function withDefaultFake(t) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-default-argv-'));
  const executable = join(root, 'cursor-agent');
  symlinkSync(fake, executable);
  const env = isolatedFakeEnvironment({ PATH: `${root}:${process.env.PATH || ''}`, FAKE_ACP_REQUIRE_POLICY: '1', FAKE_ACP_EXPECT_DEFAULT_ARGV: '1' });
  delete env.CURSOR_AGENT_COMMAND;
  delete env.CURSOR_SUBAGENT_ADAPTER_ARGS;
  delete env.FAKE_ACP_PENDING;
  const runtime = new Runtime({ ...offlineModelDependencies, env, roots: [cwd] });
  t.after(async () => { await runtime.shutdown(); rmSync(root, { recursive: true, force: true }); });
  return runtime;
}

async function fireInitBudgetDeadline(operation) {
  const originalSetTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === LIMITS.initMs) { expire = () => callback(...args); return { deadlineFixture: true }; }
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    const pending = operation();
    for (let attempt = 0; attempt < 20 && !expire; attempt += 1) await Promise.resolve();
    assert.equal(typeof expire, 'function');
    expire();
    globalThis.setTimeout = originalSetTimeout;
    return await pending;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

async function waitTerminal(runtime, sessionId, turnId) {
  let envelope;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    envelope = await runtime.call('cursor_wait', { session_id: sessionId, turn_id: turnId, timeout_ms: 1_000 });
    if (!['running', 'waiting_for_input'].includes(envelope.turn_status)) {
      return envelope;
    }
    await new Promise((resolveWait) => setImmediate(resolveWait));
  }
  assert.equal(envelope?.turn_status, 'completed', `turn ${turnId} did not terminate`);
  return envelope;
}

async function waitSessionState(runtime, sessionId, expected) {
  let status;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    status = await runtime.call('cursor_session_status', { session_id: sessionId });
    if (status.session_state === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(status?.session_state, expected);
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function lastLogged(path) {
  return readJsonLines(path).at(-1);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolve(buffered.slice(0, newline));
    };
    const onEnd = () => { cleanup(); reject(new Error('stream ended before a line')); };
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); };
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}


export {
  assert, spawn, createHash, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
  tmpdir, join, fileURLToPath, ADAPTER, CURSOR_ADAPTER_VERSION, LIMITS, MANIFEST_VERSION, Runtime,
  fake, server, cursorAgentGolden, cwd, fakeEnvNames, offlineModelDependencies,
  withFake, withInjectedFake, isolatedFakeEnvironment, withDefaultFake, fireInitBudgetDeadline,
  waitTerminal, waitSessionState, readJsonLines, lastLogged, waitForExit, waitForLine,
};
