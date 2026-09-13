import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createServer } from 'node:net';

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
    [['terra', 'high'], { CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN: '1' }],
    [['terra', 'high'], { CURSOR_EVAL_MATRIX_SERIAL: '3', CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN: '1', CURSOR_EVAL_MATRIX_RESUME: '1' }],
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
  return { code, summary, stderr: Buffer.concat(stderr).toString(), events: Buffer.concat(stdout).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('matrix defaults to sixteen concurrent hosted evaluations while preserving an explicit budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-default-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaulted = await runFixtureMatrix(root, 'high');
  assert.equal(defaulted.code, 0);
  assert.equal(defaulted.summary.concurrency, 16);
  assert.equal(defaulted.summary.runs[0].concurrency, 16);
});

test('quota stops matrix serial runs and publishes incomplete retained results', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, summary, events } = await runFixtureMatrix(root, 'high', {
    FAKE_EVAL_MATRIX_ALL_FAULTS: 'quota', CURSOR_EVAL_MATRIX_CONCURRENCY: '2', CURSOR_EVAL_MATRIX_SERIAL: '3',
  });
  assert.equal(code, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.stop_reason, 'usage_limit_exceeded');
  assert.equal(summary.planned_total, modelCount * 3);
  assert.equal(summary.not_started_total, summary.planned_total - summary.results.length);
  assert.equal(summary.runs.length, 1);
  assert.ok(summary.results.length > 0 && summary.results.length <= 2);
  assert.equal(summary.counts.skipped, 0);
  assert.equal(summary.counts.total, summary.results.length);
  assert.equal(events.filter(({ event }) => event === 'scenario_started').length, summary.results.length);
  assert.ok(summary.artifacts.length > 0);
});

test('quota stops every active suite row and prevents queued configurations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-suite-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = join(root, 'plan.json'); const output = join(root, 'result.json');
  await writeFile(plan, JSON.stringify({ schema_version: 1, name: 'quota', rows: [
    { model: 'first', effort: 'low' }, { model: 'second', effort: 'medium' }, { model: 'queued', effort: 'high' },
  ] }));
  const child = spawn(process.execPath, [suite, plan, output], {
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, FAKE_EVAL_MATRIX_ALL_FAULTS: 'quota',
      CURSOR_EVAL_SUITE_CONCURRENCY: '2', CURSOR_EVAL_MATRIX_CONCURRENCY: '1', CURSOR_EVAL_MATRIX_SERIAL: '3' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); const stderr = []; child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(child, 'close');
  assert.equal(code, 1, Buffer.concat(stderr).toString());
  const summary = JSON.parse(await readFile(output));
  assert.equal(summary.stop_reason, 'usage_limit_exceeded');
  assert.equal(summary.complete, false);
  assert.equal(summary.results.length, 2);
  assert.equal(summary.not_started_total, 1);
  assert.equal(summary.counts.passed, 0);
  for (const row of summary.results) {
    assert.equal(row.summary.complete, false);
    assert.equal(row.summary.stop_reason, 'usage_limit_exceeded');
    assert.equal(row.process.signal, null);
    assert.ok(row.summary.runs.length <= 1);
  }
});

test('quota IPC stops an already active sibling and awaits its cleanup before publication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-quota-owned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join('/tmp', `quota-coordinator-${process.pid}-${Date.now()}.sock`);
  const connections = [];
  let cancelled = false;
  const server = createServer((socket) => {
    connections.push(socket);
    socket.on('data', (data) => {
      if (data.toString() === 'cancelled') cancelled = true;
      if (data.toString() === 'ready') connections[0].write('quota');
    });
    if (connections.length === 2) {
      connections[1].write('hold');
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(socketPath, done); });
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise((done) => server.close(done)); });
  const { code, summary, events } = await runFixtureMatrix(root, 'high', {
    FAKE_EVAL_MATRIX_ALL_FAULTS: 'coordinated-quota', FAKE_EVAL_QUOTA_COORDINATOR: socketPath,
    CURSOR_EVAL_MATRIX_CONCURRENCY: '2', CURSOR_EVAL_MATRIX_SERIAL: '3',
  });
  assert.equal(code, 1);
  assert.equal(cancelled, true);
  assert.equal(summary.complete, false);
  assert.equal(summary.stop_reason, 'usage_limit_exceeded');
  assert.equal(summary.results.length, 2);
  assert.equal(events.filter(({ event }) => event === 'scenario_started').length, 2);
  assert.ok(summary.results.every(({ process: child }) => child.signal === null));
});

test('quota IPC survives a cleanup error that replaces the primary result code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-quota-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, summary } = await runFixtureMatrix(root, 'high', {
    FAKE_EVAL_MATRIX_ALL_FAULTS: 'quota-cleanup', CURSOR_EVAL_MATRIX_CONCURRENCY: '1', CURSOR_EVAL_MATRIX_SERIAL: '3',
  });
  assert.equal(code, 1);
  assert.equal(summary.stop_reason, 'usage_limit_exceeded');
  assert.equal(summary.complete, false);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].error_code, 'cleanup_failed');
});

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

test('matrix stops before the next serial after a non-pass by default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-serial-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, summary } = await runFixtureMatrix(root, 'high', {
    CURSOR_EVAL_MATRIX_SERIAL: '3', CURSOR_EVAL_MATRIX_CONCURRENCY: '1',
    FAKE_EVAL_MATRIX_FAILURE_SCENARIO: 'model-question',
  });
  assert.equal(code, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.stop_reason, 'nonpass');
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.not_started_total, modelCount * 2);
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
  const output = join(root, 'unsupported-artifact.json');
  const preload = join(root, 'linked-artifact.mjs');
  await writeFile(preload, `import { symlink } from 'node:fs/promises';
if (process.argv[1] === ${JSON.stringify(fakeChild)} && process.argv[2] === ${JSON.stringify(ids[0])}) {
  await symlink(${JSON.stringify(fakeChild)}, process.env.NODE_TEST_ARTIFACT_ROOT + '/linked-artifact');
}
`);
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-terra', 'high', output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${JSON.stringify(preload)}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors = [];
  child.stdout.resume(); child.stderr.on('data', (chunk) => errors.push(chunk));
  const [unsupportedCode] = await once(child, 'close');
  assert.notEqual(unsupportedCode, 0);
  assert.match(Buffer.concat(errors).toString('utf8'), /unsupported bundle artifact/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await assert.rejects(readFile(`${output}.tmp`), { code: 'ENOENT' });
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
  assert.equal(summary.concurrency, 16);
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
  assert.equal(summary.token_usage.reporting.codex, 'provider');
  assert.equal(summary.token_usage.reporting.cursor, 'not_reported');
  assert.equal(summary.token_usage.totals.codex.input_tokens, 10 * modelCount);
  assert.equal(summary.token_usage.totals.codex.output_tokens, 5 * modelCount);
  assert.equal(summary.token_usage.totals.cursor.total_tokens, 0);
  assert.equal(summary.results[0].token_usage.totals.codex.input_tokens, 10);
  await readFile(join(root, summary.results[0].process.artifact_root, 'driver-stdout.txt'), 'utf8');
  await readFile(join(root, summary.results[0].process.artifact_root, 'driver-stderr.txt'), 'utf8');
  assert.equal(events.filter(({ event }) => event === 'scenario_started').length, modelCount);
  assert.equal(events.filter(({ event }) => event === 'scenario_completed').length, modelCount);
  assert.ok(events.filter(({ event }) => event === 'scenario_progress').length >= modelCount);
  assert.equal(events.at(0).event, 'matrix_started');
  assert.equal(events.at(-1).event, 'matrix_completed');
  const firstCompletion = events.findIndex(({ event }) => event === 'scenario_completed');
  assert.equal(events.slice(0, firstCompletion).filter(({ event }) => event === 'scenario_started').length, summary.concurrency);
  assert.deepEqual(events.filter(({ event }) => event === 'scenario_started').map(({ index }) => index).sort((a, b) => a - b),
    Array.from({ length: modelCount }, (_, index) => index + 1));
});

test('eval matrix records every independent serial run without collapsing failed evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-matrix-serial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'summary.json');
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-terra', 'high', output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, CURSOR_EVAL_MATRIX_PROGRESS_MS: '10', CURSOR_EVAL_MATRIX_SERIAL: '3',
      CURSOR_EVAL_MATRIX_CONTINUE_ON_FAILURE: '1' },
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
    index === 3 && scenarioId === 'model-state-observation').artifact_root,
  relative(root, `${output}.artifacts/serial-3/model-state-observation-attempt-1`));
  await readFile(`${output}.artifacts/serial-3/model-state-observation-attempt-1/driver-stdout.txt`, 'utf8');
});

for (const timing of ['early', 'active', 'quota-early']) test(timing === 'quota-early'
  ? 'quota before scenario launch publishes an empty incomplete matrix'
  : `interrupted eval matrix stops ${timing} work without publishing a partial summary`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-matrix-interrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'summary.json');
  const pidPath = join(root, 'active-child.pid');
  const readyPath = timing !== 'active' ? join(root, 'mkdir-ready.pid') : pidPath;
  const preload = join(root, 'ready-child.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1] === ${JSON.stringify(fakeChild)}) await fs.writeFile(${JSON.stringify(pidPath)}, String(process.pid));
if (${JSON.stringify(timing)} !== 'active' && process.argv[1] === ${JSON.stringify(matrix)}) {
  const mkdir = fs.mkdir;
  fs.mkdir = async (path, options) => {
    const result = await mkdir(path, options);
    if (String(path).startsWith(${JSON.stringify(`${output}.artifacts/serial-`)})) {
      // The real allocation completed; hold its continuation until cancellation.
      const release = once(process, ${JSON.stringify(timing === 'quota-early' ? 'message' : 'SIGTERM')});
      const keepAlive = setInterval(() => {}, 1000);
      try { await fs.writeFile(${JSON.stringify(readyPath)}, String(process.pid)); await release; }
      finally { clearInterval(keepAlive); }
    }
    return result;
  };
  syncBuiltinESMExports();
}
`);
  const child = spawn(process.execPath, [matrix, 'gpt-5.6-terra', 'high', output], {
    cwd: repository,
    env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild, CURSOR_EVAL_MATRIX_CONCURRENCY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${JSON.stringify(preload)}`, FAKE_EVAL_MATRIX_DELAY_MS: '10000' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.resume();
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  let readyPid;
  const deadline = Date.now() + 10_000;
  while (!readyPid && Date.now() < deadline) {
    const value = await readFile(readyPath, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (/^\d+$/.test(value)) readyPid = Number(value);
    else await nextTurn();
  }
  assert.ok(readyPid, `${timing} readiness must be published before interruption`);
  process.kill(readyPid, 0);
  if (timing === 'quota-early') child.send({ type: 'usage_limit_exceeded' });
  else { child.kill('SIGTERM'); child.kill('SIGINT'); }
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(code, timing === 'quota-early' ? 1 : 130);
  if (timing === 'active') {
    assert.throws(() => process.kill(readyPid, 0), { code: 'ESRCH' }, 'the active scenario child must be reaped');
  } else {
    await assert.rejects(readFile(pidPath), { code: 'ENOENT' });
    const events = Buffer.concat(stdout).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(events.some(({ event }) => event === 'scenario_started'), false, 'early cancellation must prevent scenario launch');
  }
  if (timing === 'quota-early') {
    const summary = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(summary.complete, false);
    assert.equal(summary.stop_reason, 'usage_limit_exceeded');
    assert.equal(summary.counts.total, 0);
    assert.equal(summary.pass_rate, 0);
    assert.deepEqual(summary.results, []);
    assert.equal(summary.not_started_total, summary.planned_total);
  } else await assert.rejects(readFile(output, 'utf8'));
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

test('declared series pauses for review and resumes exactly its remaining runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { CURSOR_EVAL_MATRIX_SERIAL: '3', CURSOR_EVAL_MATRIX_CONCURRENCY: '4' };
  const first = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN: '1' });
  assert.equal(first.code, 1);
  assert.equal(first.summary.stop_reason, 'review_required');
  assert.equal(first.summary.runs.length, 1);
  assert.equal(first.summary.counts.pass, modelCount);
  const resumed = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_RESUME: '1' });
  assert.equal(resumed.code, 0);
  assert.equal(resumed.summary.runs.length, 3);
  assert.equal(resumed.summary.started_at, first.summary.started_at);
  assert.ok(resumed.summary.duration_ms >= resumed.summary.runs.reduce((sum, run) => sum + run.duration_ms, 0));
  assert.equal(resumed.summary.counts.pass, modelCount * 3);
  assert.equal(resumed.events.filter(item => item.event === 'scenario_started').length, modelCount * 2);
  assert.deepEqual(resumed.summary.results.filter(item => item.serial_index === 1), first.summary.results);
});

test('resume rejects changed settings and modified retained artifacts before starting children', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-resume-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { CURSOR_EVAL_MATRIX_SERIAL: '3', CURSOR_EVAL_MATRIX_CONCURRENCY: '4' };
  const first = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN: '1' });
  for (const extra of [{ CURSOR_EVAL_MATRIX_CONCURRENCY: '3' }, { CURSOR_EVAL_MATRIX_CONTINUE_ON_FAILURE: '1' }]) {
    const rejected = await runFixtureMatrix(root, 'high', { ...settings, ...extra, CURSOR_EVAL_MATRIX_RESUME: '1' });
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.events.filter(item => item.event === 'scenario_started').length, 0);
  }
  const artifact = first.summary.artifacts.find(item => item.path.endsWith('driver-stdout.txt'));
  await writeFile(join(root, artifact.path), 'tampered');
  const rejected = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_RESUME: '1' });
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.events.filter(item => item.event === 'scenario_started').length, 0);
});

test('resume rejects duplicated history and failed series without new evaluations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-resume-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { CURSOR_EVAL_MATRIX_SERIAL: '3' };
  const first = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN: '1' });
  first.summary.results.push(first.summary.results[0]);
  await writeFile(join(root, 'high.json'), JSON.stringify(first.summary));
  const duplicate = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_RESUME: '1' });
  assert.notEqual(duplicate.code, 0);
  assert.equal(duplicate.events.length, 0);
  const failed = await runFixtureMatrix(root, 'medium', { ...settings, FAKE_EVAL_MATRIX_ALL_FAULTS: 'quota' });
  assert.equal(failed.summary.complete, false);
  const rejected = await runFixtureMatrix(root, 'medium', { ...settings, CURSOR_EVAL_MATRIX_RESUME: '1' });
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.events.length, 0);
});

test('matrix preserves an existing output file and rejects unreadable output targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-existing-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [false, true]) {
    const output = join(root, directory ? 'directory.json' : 'file.json');
    if (directory) await mkdir(output);
    else await writeFile(output, 'retained evidence');
    const child = spawn(process.execPath, [matrix, 'terra', 'high', output], {
      env: { ...process.env, CURSOR_EVAL_MATRIX_RUNNER: fakeChild }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = []; child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.resume();
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0);
    assert.equal(Buffer.concat(stdout).length, 0);
    if (!directory) assert.equal(await readFile(output, 'utf8'), 'retained evidence');
  }
});

test('matrix stops later serial runs when corpus changes before the completed-run digest check', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-corpus-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preload = join(root, 'drifting-corpus.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1] === ${JSON.stringify(matrix)}) {
  const readFile = fs.readFile;
  let reads = 0;
  fs.readFile = async (path, ...args) => {
    const bytes = await readFile(path, ...args);
    if (path === ${JSON.stringify(join(repository, 'evals/cursor-subagent-scenarios.v1.json'))} && ++reads >= 3) {
      return Buffer.concat([bytes, Buffer.from('\\n')]);
    }
    return bytes;
  };
  syncBuiltinESMExports();
}
`);
  const { code, summary, events } = await runFixtureMatrix(root, 'high', {
    CURSOR_EVAL_MATRIX_SERIAL: '3', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${JSON.stringify(preload)}`,
  });
  assert.equal(code, 1);
  assert.equal(summary.stop_reason, 'digest_drift');
  assert.equal(summary.complete, false);
  assert.equal(summary.counts.pass, modelCount);
  assert.equal(summary.runs.length, 1);
  assert.equal(events.filter(item => item.event === 'scenario_started').length, modelCount);
});


test('resume validates retained trial history even when its checkpoint hash matches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-matrix-resume-invalid-trial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { CURSOR_EVAL_MATRIX_SERIAL: '3' };
  const first = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_PAUSE_AFTER_RUN: '1' });
  for (const corrupt of [
    summary => { summary.results[0].scenario_id = summary.results[1].scenario_id; },
    summary => { summary.results[0].serial_index = 2; },
    summary => { summary.results[0].eval_status = 'integration_failure'; },
    summary => { summary.results[0].scenario_id = 'not-an-admitted-scenario'; },
  ]) {
    const summary = structuredClone(first.summary);
    corrupt(summary);
    const encoded = Buffer.from(JSON.stringify(summary));
    await writeFile(join(root, 'high.json'), encoded);
    await writeFile(join(root, 'high.json.artifacts/checkpoint.json'), JSON.stringify({
      aggregate: { sha256: createHash('sha256').update(encoded).digest('hex'), bytes: encoded.length },
    }));
    const rejected = await runFixtureMatrix(root, 'high', { ...settings, CURSOR_EVAL_MATRIX_RESUME: '1' });
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.events.length, 0);
    assert.match(rejected.stderr, /not an eligible reviewed first run/);
  }
});
