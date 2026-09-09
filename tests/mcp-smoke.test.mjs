import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

const serverPath = new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url);

test('Codex repository marketplace discovers the root plugin', () => {
  const root = new URL('../', import.meta.url);
  const marketplace = JSON.parse(readFileSync(new URL('.agents/plugins/marketplace.json', root), 'utf8'));
  const plugin = JSON.parse(readFileSync(new URL('.codex-plugin/plugin.json', root), 'utf8'));
  assert.equal(marketplace.name, plugin.name);
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.source.source, 'local');
  assert.equal(new URL(entry.source.path, root).href, root.href);
  assert.equal(entry.policy.installation, 'AVAILABLE');
});

test('source MCP manifest uses only portable runtime paths', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8'));
  const server = manifest.mcpServers['cursor-subagent'];
  assert.equal(server.command, 'node');
  assert.equal(server.cwd, '.');
  assert.deepEqual(server.args, ['scripts/cursor-subagent-mcp.mjs']);
  assert.deepEqual(server.env, { AGENT_CLI_CREDENTIAL_STORE: 'file' });
});

test('Claude marketplace plugin uses the cached plugin root without changing authority', () => {
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const marketplace = JSON.parse(readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
  const server = plugin.mcpServers['cursor-subagent'];
  assert.equal(plugin.name, 'agents-cursor-subagent-plugin');
  assert.equal(plugin.skills, './skills');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/cursor-subagent-mcp.mjs']);
  assert.deepEqual(server.env, { AGENT_CLI_CREDENTIAL_STORE: 'file' });
  assert.equal('approval_mode' in server, false);
  assert.equal('CURSOR_AGENT_COMMAND' in server.env, false);
  assert.equal(JSON.stringify(plugin).includes('/Users/'), false);
  assert.equal(marketplace.name, 'agents-cursor-subagent-plugin');
  assert.deepEqual(marketplace.plugins, [{
    name: 'agents-cursor-subagent-plugin',
    source: { source: 'github', repo: 'arikon/agents-cursor-subagent-plugin' },
    description: 'Delegate tasks to Cursor Agent through an interactive ACP session.',
    strict: true,
  }]);
  assert.equal('version' in marketplace.plugins[0], false);
});

test('MCP server fails loudly when its packaged manifest is absent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-no-manifest-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts'); mkdirSync(scripts); const copy = join(scripts, 'cursor-subagent-mcp.mjs'); copyFileSync(serverPath, copy);
  const child = spawn(process.execPath, [copy], { stdio: ['ignore', 'ignore', 'pipe'] }); const stderr = []; child.stderr.on('data', (chunk) => stderr.push(chunk)); const [code] = await once(child, 'exit');
  assert.notEqual(code, 0); assert.match(Buffer.concat(stderr).toString('utf8'), /plugin\.json|manifest/i);
});
