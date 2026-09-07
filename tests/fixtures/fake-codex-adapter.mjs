#!/usr/bin/env node
// Thin process-wire wrapper around the single fake adapter lifecycle owner.

import { runFakeCodexAdapter } from './fake-codex-adapter-core.mjs';

const [, , operation, rawRequest] = process.argv;
const result = await runFakeCodexAdapter(operation, JSON.parse(rawRequest || '{}'), process.env);

if (result.overflow) {
  process.stdout.write('x'.repeat(1_048_577));
} else if (result.output) {
  (result.stream === 'stderr' ? process.stderr : process.stdout).write(result.output);
}
if (result.timeout) await new Promise(() => setInterval(() => {}, 1_000));
process.exitCode = result.code ?? 0;
