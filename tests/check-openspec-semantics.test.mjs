import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const change = 'add-cursor-subagent-skill-evals';
const supervisorChange = 'add-durable-node-test-supervisor';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openspec-semantics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repository, 'AGENTS.md'), join(root, 'AGENTS.md'));
  await cp(join(repository, 'openspec'), join(root, 'openspec'), { recursive: true });
  await cp(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
  return root;
}

function run(root) { return spawnSync(process.execPath, ['scripts/check-openspec-semantics.mjs'], { cwd: root, encoding: 'utf8' }); }
async function replace(root, path, from, to = '') {
  const target = join(root, path); const source = await readFile(target, 'utf8'); assert.ok(source.includes(from), `${path} lacks fixture token`); await writeFile(target, source.replaceAll(from, to));
}

test('semantic gate accepts the committed eval baseline', async (t) => {
  const root = await fixture(t); const result = run(root); assert.equal(result.status, 0, result.stderr);
});

test('semantic gate accepts the committed node-supervisor baseline', async (t) => {
  const root = await fixture(t); const result = run(root); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed for 5 changes/);
});

for (const { name, path, from, to = '', expected } of [
  { name: 'missing modified delta', path: `openspec/changes/${change}/specs/cursor-task-delegation/spec.md`, from: '## MODIFIED Requirements', expected: 'invalid modified capability' },
  { name: 'orphaned authority rule', path: `openspec/changes/${change}/specs/cursor-task-delegation/spec.md`, from: '### Requirement: Skill workflow делегирования', expected: 'invalid modified capability' },
  { name: 'incomplete EvalResultV1', path: `openspec/changes/${change}/specs/cursor-subagent-skill-evals/spec.md`, from: '"failure_stage"', expected: 'EvalResultV1 missing failure_stage' },
  { name: 'unconditional transcript', path: `openspec/changes/${change}/specs/cursor-subagent-skill-evals/spec.md`, from: 'the transcript exists only inside published evidence', expected: 'transcript must remain conditional' },
  { name: 'invalid external adapter eval status', path: `openspec/changes/${change}/specs/cursor-subagent-skill-evals/spec.md`, from: '"eval_status": "pass | skipped | integration_failure | agent_behavior_mismatch",', to: '"eval_status": "external_adapter_drift",', expected: 'external_adapter_drift is adapter classification' },
  { name: 'incomplete scenario matrix', path: `openspec/changes/${change}/design.md`, from: '`model-plan`', expected: 'scenario matrix missing model-plan' },
  { name: 'inaccurate owner reference', path: `openspec/changes/${change}/specs/cursor-subagent-skill-evals/spec.md`, from: 'package-owned bootstrap', expected: 'must reuse package-owned bootstrap' },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t); await replace(root, path, from, to);
    const result = run(root); assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(expected));
  });
}

test('semantic gate rejects an unregistered active directory without a baseline', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'openspec/changes/unregistered-without-baseline'));
  const result = run(root); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active change is absent from semantic-gate registry/);
});

test('semantic gate rejects a registered active change without a baseline', async (t) => {
  const root = await fixture(t);
  await replace(root, `openspec/changes/${supervisorChange}/design.md`, '## v1 Contract Baseline');
  const result = run(root); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registered active change is missing v1 Contract Baseline/);
});

for (const { name, path, from, to = '', expected } of [
  { name: 'unregistered active v1 baseline', path: 'scripts/check-openspec-semantics.mjs', from: '  "add-durable-node-test-supervisor",\n', expected: 'active change is absent from semantic-gate registry' },
  { name: 'missing node-supervisor owner', path: `openspec/changes/${supervisorChange}/design.md`, from: '`node-test-supervision` owns runner lifecycle, artifacts, reporting and coverage gate', expected: 'owner map does not declare' },
  { name: 'broken NTS id mapping', path: `openspec/changes/${supervisorChange}/design.md`, from: '`NTS-2` → «Диагностика текущего прогона без console шума»', expected: 'Public-invariant index must equal' },
  { name: 'missing NTS task trace', path: `openspec/changes/${supervisorChange}/tasks.md`, from: '«Диагностика текущего прогона без console шума»', expected: 'no task references requirement' },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t); await replace(root, path, from, to);
    const result = run(root); assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(expected));
  });
}
