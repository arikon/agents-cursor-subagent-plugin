import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

const serverPath = new URL('../scripts/cursor-subagent-mcp.mjs', import.meta.url);

test('source MCP manifest uses only portable runtime paths', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8'));
  const server = manifest.mcpServers['cursor-subagent'];
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['scripts/cursor-subagent-mcp.mjs']);
  assert.deepEqual(server.env, { AGENT_CLI_CREDENTIAL_STORE: 'file' });
});

test('MCP server fails loudly when its packaged manifest is absent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-no-manifest-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts'); mkdirSync(scripts); const copy = join(scripts, 'cursor-subagent-mcp.mjs'); copyFileSync(serverPath, copy);
  const child = spawn(process.execPath, [copy], { stdio: ['ignore', 'ignore', 'pipe'] }); const stderr = []; child.stderr.on('data', (chunk) => stderr.push(chunk)); const [code] = await once(child, 'exit');
  assert.notEqual(code, 0); assert.match(Buffer.concat(stderr).toString('utf8'), /plugin\.json|manifest/i);
});
