import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const publisher = fileURLToPath(new URL('../scripts/eval/publish-model-baseline.mjs', import.meta.url));

const counts = (total = 2) => ({ total, pass: total, agent_behavior_mismatch: 0, integration_failure: 0, skipped: 0 });
const green = () => ({ effort: 'low', serial: 3, concurrency: 2, digest_stable: true,
  counts: counts(6), final: { corpus: {}, skill: {}, evaluator: {} }, results: [{ eval_status: 'pass' }],
  runs: [1, 2, 3].map((serial_index) => ({ serial_index, digest_stable: true, counts: counts() })) });

test('publisher binds matrix bytes and rejects incomplete or inconsistent serial baselines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ['green', (s) => s, true],
    ['quota subset', (s) => ({ ...s, complete: false, stop_reason: 'usage_limit_exceeded', planned_total: 6, not_started_total: 4, counts: counts(2), runs: s.runs.slice(0, 1) }), false],
    ['empty', (s) => ({ ...s, counts: counts(0) }), false],
    ['drift', (s) => ({ ...s, digest_stable: false }), false],
    ['serial', (s) => ({ ...s, serial: 1 }), false],
    ['run mismatch', (s) => ({ ...s, runs: [{ ...s.runs[0], counts: counts(1) }, ...s.runs.slice(1)] }), false],
    ['behavior failure', (s) => ({ ...s, counts: { ...counts(6), pass: 5, agent_behavior_mismatch: 1 }, results: [{ eval_status: 'agent_behavior_mismatch', scenario_id: 'review' }, { eval_status: 'agent_behavior_mismatch', scenario_id: 'review' }] }), false],
    ['missing optional evidence', (s) => ({ ...s, final: undefined, initial: {}, results: undefined, concurrency: undefined, counts: { ...counts(6), pass: 5, integration_failure: 1 } }), false],
  ];
  for (const [name, transform, accepted] of cases) await t.test(name, async () => {
    const model = `test-${randomUUID()}`;
    const matrix = join(root, `${model}.json`);
    const bytes = JSON.stringify(transform(green()));
    await writeFile(matrix, bytes);
    const json = new URL(`../evals/cursor-skill-eval-baseline-${model}-test.json`, import.meta.url);
    const md = new URL(`../evals/cursor-skill-eval-baseline-${model}-test.md`, import.meta.url);
    try {
      await execute(process.execPath, [publisher, model, 'test', 'fixture', matrix]);
      const result = JSON.parse(await readFile(json, 'utf8'));
      assert.equal(result.accepted_green, accepted);
      assert.equal(result.series[0].sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(result.series[0].bytes, Buffer.byteLength(bytes));
      assert.match(await readFile(md, 'utf8'), accepted ? /Все три запуска/ : /Baseline не принят/);
      if (name === 'quota subset') assert.equal(result.series[0].stop_reason, 'usage_limit_exceeded');
      if (name === 'behavior failure') assert.equal(result.series[0].mismatch_by_scenario.review, 2);
    } finally { await Promise.all([rm(json, { force: true }), rm(md, { force: true })]); }
  });
  await assert.rejects(execute(process.execPath, [publisher]), /usage:/);
});
