import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const matrix = fileURLToPath(new URL('../scripts/eval/run-cursor-skill-eval-matrix.mjs', import.meta.url));
const suite = fileURLToPath(new URL('../scripts/eval/run-cursor-skill-eval-suite.mjs', import.meta.url));
const fakeChild = fileURLToPath(new URL('./fixtures/fake-eval-matrix-child.mjs', import.meta.url));
const modelCount = JSON.parse(await readFile(join(repository, 'evals/cursor-subagent-scenarios.v1.json'))).scenarios.filter(({ lane }) => lane === 'model-behavior').length;

test('matrix rejects invalid launch settings before starting evaluation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [args, env, includeOutput = true] of [
    [[], {}, false], [['terra'], {}, false], [['terra', 'high'], {}, false],
    [['bad/model', 'high'], {}], [['terra', 'unknown'], {}],
    [['terra', 'high'], { CURSOR_EVAL_MATRIX_PROGRESS_MS: '0' }],
    [['terra', 'high'], { CURSOR_EVAL_MATRIX_CONCURRENCY: '17' }],
    [['terra', 'high'], { CURSOR_EVAL_MATRIX_SERIAL: '0' }],
  ]) {
    const child = spawn(process.execPath, [matrix, ...args, ...(includeOutput ? [join(root, 'result.json')] : [])], {
      env: { ...process.env, ...env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = []; child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.resume();
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0); assert.equal(Buffer.concat(stdout).length, 0);
  }
  await assert.rejects(readFile(join(root, 'result.json')));
});

async function runFixtureMatrix(root, effort, extraEnv = {}) {
  const output = join(root, `${effort}.json`);
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-terra', effort, output], {
    cwd: repository, env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  const summary = JSON.parse(await readFile(output, 'utf8').catch((error) => {
    throw new Error(`${error.message}: ${Buffer.concat(stderr)}`);
  }));
  return { code, summary, events: Buffer.concat(stdout).toString('utf8').trim().split('\n').map(JSON.parse) };
}

test('matrix preserves the first failure without automatic scenario retry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-no-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, summary, events } = await runFixtureMatrix(root, 'high', { FAKE_EVAL_MATRIX_FAILURE_SCENARIO: 'model-question' });
  assert.equal(code, 1);
  assert.equal(summary.counts.integration_failure, 1);
  assert.equal(summary.counts.pass, modelCount - 1);
  assert.equal(summary.attempted_runs, modelCount);
  assert.equal(events.filter(({ event }) => event === 'scenario_retrying').length, 0);
  assert.ok(summary.results.every(({ attempts }) => attempts.length === 1));
});

test('high and medium share candidate identity and bundle survives relocation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-portable-'));
  const moved = await mkdtemp(join(tmpdir(), 'cursor-matrix-moved-'));
  t.after(() => Promise.all([root, moved].map((path) => rm(path, { recursive: true, force: true }))));
  const high = await runFixtureMatrix(root, 'high');
  const medium = await runFixtureMatrix(root, 'medium');
  assert.equal(high.code, 0); assert.equal(medium.code, 0);
  assert.deepEqual(high.summary.candidate_digest, medium.summary.candidate_digest);
  await cp(root, moved, { recursive: true });
  await rm(root, { recursive: true, force: true });
  const summary = JSON.parse(await readFile(join(moved, 'high.json')));
  assert.deepEqual(JSON.parse(await readFile(join(moved, summary.candidate_ref))).digest, summary.candidate_digest);
  for (const artifact of summary.artifacts) {
    const content = await readFile(join(moved, artifact.path));
    assert.equal(content.length, artifact.bytes);
    assert.equal(createHash('sha256').update(content).digest('hex'), artifact.sha256);
  }
  for (const result of summary.results) {
    const evidencePath = join(moved, result.evidence_ref);
    const evidence = JSON.parse(await readFile(evidencePath));
    assert.equal(evidence.final_result.evidence_ref, 'fake-evidence.json');
  }
});

test('matrix rejects malformed verdicts and missing or drifting candidate evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = JSON.parse(await readFile(join(repository, 'evals/cursor-subagent-scenarios.v1.json')))
    .scenarios.filter(({ lane }) => lane === 'model-behavior').map(({ scenario_id }) => scenario_id);
  const faults = ['malformed', 'wrong-scenario', 'nonzero-pass', 'outside-evidence', 'missing-evidence', 'evaluator-drift', 'candidate-drift', 'extra-stdout', 'zero-failure', 'skipped', 'signalled-failure', 'extra-manifest-field', 'malformed-manifest', 'wrong-final', 'wrong-evidence-version', 'oversized-evidence', 'padded-stdout'];
  const { code, summary } = await runFixtureMatrix(root, 'high', {
    CURSOR_EVAL_MATRIX_CONCURRENCY: '1',
    FAKE_EVAL_MATRIX_FAULTS: JSON.stringify(Object.fromEntries(faults.map((fault, index) => [ids[index + 1], fault]))),
  });
  assert.equal(code, 1);
  assert.equal(summary.counts.integration_failure, faults.length);
  for (const row of summary.results.slice(1, faults.length + 1)) {
    assert.equal(row.eval_status, 'integration_failure');
    assert.ok(row.evidence_ref === null || !row.evidence_ref.startsWith('/'));
    assert.equal(row.attempts.length, 1);
  }
});

test('matrix retains an atomic failure bundle when no child supplies candidate proof', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-no-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, summary } = await runFixtureMatrix(root, 'high', { FAKE_EVAL_MATRIX_ALL_FAULTS: 'malformed' });
  assert.equal(code, 1);
  assert.equal(summary.counts.integration_failure, modelCount);
  assert.equal(summary.candidate_digest, null);
  assert.equal(summary.candidate_ref, null);
  assert.ok(summary.artifacts.length > modelCount);
  for (const row of summary.results) assert.ok(Buffer.byteLength(row.message) <= 8_000);
});

test('eval matrix emits per-scenario progress and writes atomic aggregate statistics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-matrix-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'summary.json');
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-sol', 'low', output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, CURSOR_EVAL_MATRIX_PROGRESS_MS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const events = Buffer.concat(stdout).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.counts.total, modelCount);
  assert.equal(summary.counts.pass, modelCount);
  assert.equal(summary.pass_rate, 1);
  assert.equal(summary.concurrency, 8);
  assert.equal(summary.digest_stable, true);
  assert.equal(summary.serial, 1);
  assert.equal(summary.runs.length, 1);
  assert.ok(summary.runs.every((run) => !Object.hasOwn(run, 'results')));
  assert.equal(summary.results.length, summary.counts.total);
  assert.ok(summary.results.every(({ serial_index: index }) => index === 1));
  assert.equal(summary.results[0].artifact_root, relative(root, `${output}.artifacts/serial-1/model-question-attempt-1`));
  assert.equal(summary.results[0].process.artifact_root, relative(root, `${output}.artifacts/serial-1/model-question-attempt-1`));
  assert.equal(summary.results[0].evidence_ref,
    relative(root, `${output}.artifacts/serial-1/model-question-attempt-1/evidence/fake-evidence.json`));
  await readFile(join(root, summary.results[0].process.artifact_root, 'driver-stdout.txt'), 'utf8');
  await readFile(join(root, summary.results[0].process.artifact_root, 'driver-stderr.txt'), 'utf8');
  assert.equal(events.filter(({ event }) => event === 'scenario_started').length, modelCount);
  assert.equal(events.filter(({ event }) => event === 'scenario_completed').length, modelCount);
  assert.ok(events.filter(({ event }) => event === 'scenario_progress').length >= modelCount);
  assert.equal(events.at(0).event, 'matrix_started');
  assert.equal(events.at(-1).event, 'matrix_completed');
  const firstCompletion = events.findIndex(({ event }) => event === 'scenario_completed');
  assert.equal(events.slice(0, firstCompletion).filter(({ event }) => event === 'scenario_started').length, 8);
  assert.deepEqual(events.filter(({ event }) => event === 'scenario_started').map(({ index }) => index).sort((a, b) => a - b),
    Array.from({ length: modelCount }, (_, index) => index + 1));
});

test('eval matrix records every independent serial run without collapsing failed evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-matrix-serial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'summary.json');
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-terra', 'high', output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, CURSOR_EVAL_MATRIX_PROGRESS_MS: '10', CURSOR_EVAL_MATRIX_SERIAL: '3' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stdout.resume();
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.serial, 3);
  assert.equal(summary.runs.length, 3);
  assert.deepEqual(summary.runs.map(({ serial_index: index, counts }) => [index, counts.pass, counts.total]),
    [[1, modelCount, modelCount], [2, modelCount, modelCount], [3, modelCount, modelCount]]);
  assert.deepEqual(summary.counts, { total: modelCount * 3, pass: modelCount * 3, agent_behavior_mismatch: 0, integration_failure: 0, skipped: 0 });
  assert.equal(summary.results.length, summary.counts.total);
  assert.deepEqual([...new Set(summary.results.map(({ serial_index: index }) => index))], [1, 2, 3]);
  assert.ok(summary.runs.every((run) => !Object.hasOwn(run, 'results')));
  assert.equal(summary.results.find(({ serial_index: index, scenario_id: scenarioId }) =>
    index === 3 && scenarioId === 'model-events-lost').artifact_root,
    relative(root, `${output}.artifacts/serial-3/model-events-lost-attempt-1`));
  await readFile(`${output}.artifacts/serial-3/model-events-lost-attempt-1/driver-stdout.txt`, 'utf8');
});

test('interrupted eval matrix terminates active children without publishing a partial summary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-matrix-interrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'summary.json');
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-terra', 'high', output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, FAKE_EVAL_MATRIX_DELAY_MS: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  let markStarted;
  const started = new Promise((resolveStarted) => { markStarted = resolveStarted; });
  child.stdout.on('data', (chunk) => {
    stdout.push(chunk);
    if (Buffer.concat(stdout).toString('utf8').includes('matrix_started')) markStarted();
  });
  await started;
  child.kill('SIGTERM');
  child.kill('SIGINT');
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 130);
  await assert.rejects(readFile(output, 'utf8'));
});

test('eval suite runs saved model rows with default parallelism and preserves every row result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-suite-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = join(root, 'plan.json');
  const output = join(root, 'summary.json');
  await writeFile(plan, `${JSON.stringify({ schema_version: 1, name: 'fixture', rows: [
    { model: 'gpt-5.6-sol', effort: 'low' },
    { model: 'gpt-5.6-terra', effort: 'medium' },
    { model: 'gpt-5.6-luna', effort: 'high' },
  ] })}\n`);
  const child = spawn(process.execPath, [suite, plan, output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild,
      CURSOR_EVAL_MATRIX_PROGRESS_MS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const events = Buffer.concat(stdout).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(summary.counts, { total: 3, passed: 3, failed: 0 });
  assert.equal(summary.concurrency, 3);
  assert.equal(events.at(0).event, 'suite_started');
  assert.equal(events.at(-1).event, 'suite_completed');
  assert.equal(events.filter(({ event }) => event === 'row_started').length, 3);
  for (const row of summary.results) {
    assert.equal(row.summary.counts.pass, modelCount);
    assert.equal(row.summary.digest_stable, true);
    await readFile(row.output, 'utf8');
  }
});

test('suite preserves failed children and rejects stale green output after nonzero exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-suite-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = join(root, 'plan.json'); const output = join(root, 'summary.json');
  const runner = join(root, 'matrix.mjs');
  await writeFile(plan, JSON.stringify({ schema_version: 1, name: 'failures', rows: [
    { model: 'stale', effort: 'high' }, { model: 'missing', effort: 'medium' },
    { model: 'signalled', effort: 'high' }, { model: 'silent', effort: 'high' },
  ] }));
  await writeFile(runner, `import {writeFile} from 'node:fs/promises';
if (['stale','signalled'].includes(process.argv[2])) await writeFile(process.argv[4], JSON.stringify({counts:{total:1,pass:1},digest_stable:true}));
process.stdout.write('partial progress');
if (process.argv[2] !== 'silent') process.stderr.write('injected child failure');
if (process.argv[2] === 'signalled') process.kill(process.pid, 'SIGTERM');
process.exitCode=1;`);
  const child = spawn(process.execPath, [suite, plan, output], {
    env: { ...process.env, CURSOR_EVAL_SUITE_MATRIX_RUNNER: runner, CURSOR_EVAL_SUITE_CONCURRENCY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const [code] = await once(child, 'close'); assert.equal(code, 1);
  const result = JSON.parse(await readFile(output));
  assert.deepEqual(result.counts, { total: 4, passed: 0, failed: 4 });
  assert.equal(result.results[0].summary.counts.pass, 1);
  assert.equal(result.results[1].summary, null);
  assert.equal(result.results[1].error, 'injected child failure');
  assert.equal(result.results[2].process.signal, 'SIGTERM');
  assert.equal(result.results[3].error, 'matrix summary was not published');
});

test('suite rejects invalid plans and launch settings before starting rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-suite-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = { schema_version: 1, name: 'fixture', rows: [{ model: 'terra', effort: 'high' }] };
  const plan = join(root, 'plan.json'); const output = join(root, 'summary.json');
  for (const entry of [
    { args: [] }, { concurrency: '0' }, { concurrency: '4' },
    { value: { ...valid, schema_version: 2 } }, { value: { ...valid, name: '' } },
    { value: { ...valid, rows: [] } }, { value: { ...valid, rows: null } },
    ...[{}, { model: 'bad/model', effort: 'high' }, { model: 'terra' }, { model: 'terra', effort: 'unknown' }]
      .map((row) => ({ value: { ...valid, rows: [row] } })),
    { value: { ...valid, rows: [valid.rows[0], valid.rows[0]] } },
  ]) {
    await writeFile(plan, JSON.stringify(entry.value || valid));
    const child = spawn(process.execPath, [suite, ...(entry.args || [plan, output])], {
      env: { ...process.env, CURSOR_EVAL_SUITE_CONCURRENCY: entry.concurrency || '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = []; child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.resume();
    const [code] = await once(child, 'close'); assert.notEqual(code, 0);
    assert.equal(Buffer.concat(stdout).length, 0);
  }
  await assert.rejects(readFile(output));
});
