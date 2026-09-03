#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_MCP_CLOSE_MARKER) process.on('exit', () => writeFileSync(process.env.FAKE_MCP_CLOSE_MARKER, 'closed'));

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cursor-subagent', version: '9.9.9' } }
    : { tools: [] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
