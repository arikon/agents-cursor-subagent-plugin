import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const canaryEnabled = process.env.CLAUDE_MARKETPLACE_CANARY === '1';

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function checked(command, args, options) {
  const result = await run(command, args, options);
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

async function findFile(root, relative) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, relative);
      if (found) return found;
    } else if (path.endsWith(relative)) return path;
  }
  return null;
}

test('Claude marketplace installs a cache-local Cursor ACP plugin', { skip: !canaryEnabled && 'set CLAUDE_MARKETPLACE_CANARY=1 to run the live Claude CLI canary' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-acp-claude-marketplace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'marketplace'); const hidden = join(root, 'source-hidden'); const cache = join(root, 'cache');
  await cp(repository, checkout, { recursive: true, filter: (source) => !source.includes('/.git/') && !source.endsWith('/.git') });
  const marketplacePath = join(checkout, '.claude-plugin', 'marketplace.json');
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
  marketplace.plugins[0].source = './';
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  const env = { ...process.env, CLAUDE_CODE_PLUGIN_CACHE_DIR: cache };
  await checked('claude', ['plugin', 'marketplace', 'add', checkout, '--scope', 'local'], { cwd: checkout, env });
  await checked('claude', ['plugin', 'install', 'cursor-acp-subagent@codex-cursor-subagent-plugin', '--scope', 'local'], { cwd: checkout, env });
  const installed = JSON.parse(await checked('claude', ['plugin', 'list', '--json'], { cwd: checkout, env }));
  assert.equal(JSON.stringify(installed).includes('cursor-acp-subagent'), true);
  await rename(checkout, hidden);
  const pluginManifest = await findFile(cache, '/.claude-plugin/plugin.json');
  const runtime = await findFile(cache, '/scripts/cursor-subagent-mcp.mjs');
  const skill = await findFile(cache, '/skills/cursor-subagent/SKILL.md');
  assert.ok(pluginManifest); assert.ok(runtime); assert.ok(skill);
  assert.equal(pluginManifest.startsWith(hidden), false);
  assert.equal(runtime.startsWith(hidden), false);
  assert.equal(skill.startsWith(hidden), false);
  assert.equal(JSON.parse(await readFile(pluginManifest, 'utf8')).name, 'cursor-acp-subagent');
});
