#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvaluatorInventory } from '../../scripts/cursor-skill-eval.mjs';

await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_EVAL_MATRIX_DELAY_MS || '35')));
const repository = fileURLToPath(new URL('../..', import.meta.url));
const digest = async (path) => {
  const content = await readFile(join(repository, path));
  return { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length };
};
const fault = process.env.FAKE_EVAL_MATRIX_ALL_FAULTS || JSON.parse(process.env.FAKE_EVAL_MATRIX_FAULTS || '{}')[process.argv[2]];
const failed = process.argv[2] === process.env.FAKE_EVAL_MATRIX_FAILURE_SCENARIO || ['zero-failure', 'signalled-failure'].includes(fault);
const result = {
  schema_version: 1,
  scenario_id: process.argv[2],
  lane: 'model-behavior',
  eval_status: failed ? 'integration_failure' : 'pass',
  actual_task_outcome: failed ? 'not_observed' : 'succeeded',
  reported_task_outcome: 'not_checked',
  fixture_assertion_outcome: failed ? 'not_observed' : 'pass',
  evidence_publication_status: 'published', cleanup_status: 'succeeded',
  failure_stage: failed ? 'runner' : null, message: failed ? 'injected failure' : null,
  error_code: failed ? 'injected_failure' : null,
  evidence_ref: `${process.env.CURSOR_EVAL_EVIDENCE_ROOT}/fake-evidence.json`,
};
await mkdir(process.env.CURSOR_EVAL_EVIDENCE_ROOT, { recursive: true });
const evidence = {
  schema_version: 1, scenario_id: result.scenario_id, lane: result.lane,
  manifest: {
    schema_version: 1, hash_algorithm: 'sha256', hash_encoding: 'lowercase-hex',
    evaluator: (await readEvaluatorInventory()).digest,
    corpus: await digest('evals/cursor-subagent-scenarios.v1.json'),
    installed_skill: await digest('skills/cursor-subagent/SKILL.md'),
    adapter: { sha256: 'a'.repeat(64), bytes: 1 },
    materialized_scenario: { sha256: 'b'.repeat(64), bytes: 1 },
    installed_payload: { marker_format: 1, payload_hash: 'c'.repeat(64), artifact_hash: 'd'.repeat(64), manifest_version: 'fixture-1' },
    client: { name: 'fake-matrix-fixture', version: '1' },
    model: { name: null, provider: null },
  },
  final_result: { ...result, evidence_ref: 'fake-evidence.json' },
};
if (fault === 'candidate-drift') evidence.manifest.client.version = 'different';
if (fault === 'evaluator-drift') evidence.manifest.evaluator.sha256 = '0'.repeat(64);
if (fault === 'extra-manifest-field') evidence.manifest.extra = true;
if (fault === 'malformed-manifest') delete evidence.manifest.materialized_scenario;
if (fault === 'wrong-final') evidence.final_result.actual_task_outcome = 'failed';
if (fault === 'wrong-evidence-version') evidence.schema_version = 2;
if (fault === 'oversized-evidence') evidence.padding = 'x'.repeat(1_048_576);
await writeFile(result.evidence_ref, JSON.stringify(evidence));
if (fault === 'outside-evidence') result.evidence_ref = '/outside-attempt.json';
if (fault === 'missing-evidence') {
  result.evidence_ref = null;
  result.evidence_publication_status = 'not_attempted';
}
if (fault === 'wrong-scenario') result.scenario_id = 'other';
if (fault === 'skipped') Object.assign(result, { eval_status: 'skipped', actual_task_outcome: 'not_observed',
  reported_task_outcome: 'not_checked', fixture_assertion_outcome: 'not_observed', cleanup_status: 'not_required',
  evidence_publication_status: 'not_attempted', evidence_ref: null });
if (fault === 'extra-stdout') process.stdout.write('unexpected progress\n');
if (fault === 'padded-stdout') process.stdout.write(' '.repeat(16_384));
if (fault === 'malformed') process.stderr.write('ошибка '.repeat(2_000));
await new Promise((done) => process.stdout.write(`${fault === 'malformed' ? 'broken' : JSON.stringify(result)}\n`, done));
if (fault === 'signalled-failure') process.kill(process.pid, 'SIGTERM');
process.exitCode = fault === 'zero-failure' ? 0 : failed || fault === 'nonzero-pass' ? 1 : 0;
