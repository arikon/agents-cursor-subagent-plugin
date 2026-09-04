#!/usr/bin/env node

import { spawn } from 'node:child_process';

const tests = [
  'tests/runtime.test.mjs',
  'tests/facade.test.mjs',
  'tests/mcp-smoke.test.mjs',
  'tests/mcp-transport.test.mjs',
  'tests/cursor-skill-eval.test.mjs',
  'tests/run-cursor-skill-eval.test.mjs',
];

const outcome = await new Promise((resolveRun) => {
  const child = spawn(process.execPath, ['--experimental-test-coverage', '--test', '--test-concurrency=1', ...tests], { stdio: 'inherit' });
  child.once('error', (error) => resolveRun({ error }));
  child.once('close', (code, signal) => resolveRun({ code, signal }));
});

if (outcome.error) {
  process.stderr.write(`${outcome.error.message}\n`);
  process.exitCode = 1;
} else process.exitCode = outcome.code ?? (outcome.signal ? 1 : 0);
