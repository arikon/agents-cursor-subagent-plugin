#!/usr/bin/env node
// Compatibility entry point; the supervisor owns the actual coverage run.
import { cli } from './run-node-tests.mjs';

/**
 * Compatibility API for callers that still invoke the former coverage entrypoint.
 * Its observable meaning is exactly the supervisor's `coverage` lane.
 */
export async function runUnitCoverage(run) {
  return run({ argv: ['coverage'] });
}

// Import-based unit coverage cannot enter this CLI-only guard; the documented
// foreground `node scripts/run-unit-coverage.mjs` verification owns it.
/* node:coverage disable */
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  process.exitCode = await runUnitCoverage(cli);
}
/* node:coverage enable */
