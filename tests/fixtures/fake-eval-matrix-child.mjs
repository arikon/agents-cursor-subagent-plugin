#!/usr/bin/env node

await new Promise((resolve) => setTimeout(resolve, 35));
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  scenario_id: process.argv[2],
  eval_status: 'pass',
  error_code: null,
  evidence_ref: '/tmp/fake-evidence.json',
})}\n`);
