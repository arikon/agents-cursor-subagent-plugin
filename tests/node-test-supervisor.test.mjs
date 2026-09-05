import assert from 'node:assert/strict';
import { spawn as spawnChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cli, LANES, runSupervisor } from '../scripts/run-node-tests.mjs';
import { runUnitCoverage } from '../scripts/run-unit-coverage.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const processTreeFixture = join(projectRoot, 'tests/fixtures/supervisor-process-tree.mjs');

async function artifactRoot(t) {
  const path = await mkdtemp(join(tmpdir(), 'node-supervisor-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function reporterPath(args) {
  const prefix = '--test-reporter-destination=';
  return args.filter((arg) => arg.startsWith(prefix)).at(-1).slice(prefix.length);
}

function fakeSpawn({ code = 0, signal = null, report = 'complete', coverage = null, failures = null, childError = null, stderr = '', stderrError = null, closeDelayMs = 0, stderrDelayMs = 0, preventResultPublication = false } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stderr = new PassThrough();
    queueMicrotask(async () => {
      try {
        const path = reporterPath(args);
        if (report === 'complete') {
          const events = [];
          const reportedFailures = failures ?? (code !== 0 ? [{ name: 'broken test', details: { error: { message: 'boom' } } }] : []);
          events.push(...reportedFailures.map((data) => JSON.stringify({ type: 'test:fail', data })));
          events.push(JSON.stringify({ type: 'test:summary', data: { tests: 3, passed: code === 0 ? 3 : 2, failed: code === 0 ? 0 : 1 } }));
          if (coverage) events.push(JSON.stringify({ type: 'test:coverage', data: { summary: coverage } }));
          await writeFile(path, `${events.join('\n')}\n`);
        } else if (report === 'incomplete') {
          await writeFile(path, `${JSON.stringify({ type: 'test:pass', data: { name: 'only event' } })}\n`);
        } else if (report === 'empty') {
          await writeFile(path, '');
        } else if (report === 'invalid') {
          await writeFile(path, '{not-json}\n');
        }
        if (preventResultPublication) await mkdir(join(dirname(path), 'result.json'));
        if (stderr) child.stderr.write(stderr);
        if (stderrError) setTimeout(() => child.stderr.destroy(stderrError), stderrDelayMs);
        else setTimeout(() => child.stderr.end(), stderrDelayMs);
        if (childError) child.emit('error', childError);
        setTimeout(() => child.emit('close', code, signal), closeDelayMs);
      } catch (error) {
        child.emit('error', error);
        child.stderr.end();
        child.emit('close', 1, null);
      }
    });
    return child;
  };
}

async function coverageSummary(percent = 100, omitted = []) {
  const names = (await readdir(join(projectRoot, 'scripts')))
    .filter((name) => name.endsWith('.mjs') && !omitted.includes(`scripts/${name}`));
  return { files: names.map((name) => ({
    path: join(projectRoot, 'scripts', name),
    totalLineCount: 100, coveredLineCount: percent,
    totalBranchCount: 100, coveredBranchCount: percent,
    totalFunctionCount: 100, coveredFunctionCount: percent,
  })) };
}

async function publishedResult(result) {
  return JSON.parse(await readFile(join(result.artifactDir, 'result.json'), 'utf8'));
}

function waitForMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`fixture exited before its ready message: code=${code} signal=${signal}`));
    };
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('message', onMessage);
  });
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid) {
  const deadline = Date.now() + 2_000;
  while (processGroupExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processGroupExists(pid);
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processExists(pid);
}

async function stopProcessGroup(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await closed;
}

test('lane matrix produces the exact child argv and keeps parent deadlines fixed', async (t) => {
  const unitTests = [
    'tests/bootstrap.test.mjs',
    'tests/check-openspec-semantics.test.mjs',
    'tests/codex-app-server-client.test.mjs',
    'tests/cursor-skill-eval.test.mjs',
    'tests/facade.test.mjs',
    'tests/mcp-smoke.test.mjs',
    'tests/mcp-transport.test.mjs',
    'tests/node-test-reporter-v22.test.mjs',
    'tests/run-cursor-skill-eval.test.mjs',
    'tests/runtime.test.mjs',
    'tests/node-test-supervisor.test.mjs',
  ];
  const productSources = [
    'scripts/check-openspec-semantics.mjs', 'scripts/codex-app-server-client.mjs', 'scripts/cursor-eval-scenario.mjs', 'scripts/cursor-skill-eval.mjs', 'scripts/openspec-semantic-registry.mjs',
    'scripts/cursor-subagent-bootstrap.mjs', 'scripts/cursor-subagent-mcp.mjs', 'scripts/node-test-reporter-v22.mjs',
    'scripts/recording-mcp-proxy.mjs', 'scripts/run-cursor-skill-eval.mjs', 'scripts/run-node-tests.mjs', 'scripts/run-unit-coverage.mjs',
  ];
  const cases = [
    { lane: 'unit', concurrency: 2, tests: unitTests, timeoutMs: 120_000, deadlineMs: 600_000, coverage: false },
    { lane: 'coverage', concurrency: 2, tests: unitTests, timeoutMs: 120_000, deadlineMs: 900_000, coverage: true },
    { lane: 'release', concurrency: 1, tests: ['tests/release-e2e.test.mjs'], timeoutMs: 120_000, deadlineMs: 300_000, coverage: false },
  ];
  const coverage = await coverageSummary();

  for (const scenario of cases) {
    await t.test(scenario.lane, async (t) => {
      let invocation;
      const delegate = fakeSpawn({ coverage: scenario.lane === 'coverage' ? coverage : null });
      const captureSpawn = (command, args, options) => {
        invocation = { command, args, options };
        return delegate(command, args, options);
      };
      const result = await runSupervisor({
        laneName: scenario.lane,
        artifactRoot: await artifactRoot(t),
        env: { ...process.env, CURSOR_EVAL_REAL_CODEX: '1', CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_SUBAGENT_LIVE_E2E: '1' },
        dependencies: { platform: 'linux', spawn: captureSpawn },
      });

      assert.equal(result.verdict, 'passed');
      assert.equal(invocation.command, process.execPath);
      assert.deepEqual(
        invocation.args,
        [
          '--test', `--test-concurrency=${scenario.concurrency}`, `--test-timeout=${scenario.timeoutMs}`,
          '--test-reporter=tap', `--test-reporter-destination=${join(result.artifactDir, 'tap.txt')}`,
          `--test-reporter=${join(projectRoot, 'scripts/node-test-reporter-v22.mjs')}`,
          `--test-reporter-destination=${join(result.artifactDir, 'failures.jsonl')}`,
          ...(scenario.coverage ? [
            '--experimental-test-coverage', '--test-coverage-lines=90', '--test-coverage-branches=90', '--test-coverage-functions=90',
            ...productSources.map((source) => `--test-coverage-include=${source}`),
          ] : []),
          ...scenario.tests.map((path) => join(projectRoot, path)),
        ],
      );
      for (const name of ['CURSOR_EVAL_REAL_CODEX', 'CURSOR_EVAL_HOSTED_CODEX', 'CURSOR_SUBAGENT_LIVE_E2E']) assert.equal(invocation.options.env[name], undefined);
      assert.equal(LANES[scenario.lane].deadlineMs, scenario.deadlineMs);
    });
  }
});

test('unsupported platform and invalid lane fail closed before spawn', async () => {
  let spawnCount = 0;
  const dependencies = { platform: 'win32', spawn: () => { spawnCount += 1; } };
  const unsupported = await runSupervisor({ laneName: 'unit', dependencies });
  const invalid = await runSupervisor({ laneName: 'not-a-lane', dependencies: { ...dependencies, platform: 'linux' } });
  assert.deepEqual({ verdict: unsupported.verdict, cause: unsupported.terminal_cause, stage: unsupported.infrastructure.stage },
    { verdict: 'runner_error', cause: 'unsupported_platform', stage: 'preflight' });
  assert.deepEqual({ verdict: invalid.verdict, cause: invalid.terminal_cause }, { verdict: 'runner_error', cause: 'invalid_lane' });
  assert.equal(spawnCount, 0);
});

test('synchronous spawn failure is reported with bounded artifacts and structured infrastructure error', async (t) => {
  const root = await artifactRoot(t);
  const failure = Object.assign(new Error('cannot spawn'), { code: 'EACCES' });
  const result = await runSupervisor({ laneName: 'unit', artifactRoot: root, dependencies: { platform: 'linux', spawn: () => { throw failure; } } });
  assert.equal(result.verdict, 'runner_error');
  assert.equal(result.terminal_cause, 'spawn_error');
  assert.equal(result.infrastructure.stage, 'spawn');
  assert.equal(result.infrastructure.error.code, 'EACCES');
  assert.deepEqual(result.artifacts, { tap: 'tap.txt', stderr: 'stderr.txt', failures: 'failures.jsonl', result: 'result.json' });
});

test('non-Error spawn failure is normalized into the published infrastructure contract', async (t) => {
  const result = await runSupervisor({
    laneName: 'unit',
    artifactRoot: await artifactRoot(t),
    dependencies: { platform: 'linux', spawn: () => { throw 'spawn denied'; } },
  });

  assert.equal(result.verdict, 'runner_error');
  assert.equal(result.terminal_cause, 'spawn_error');
  assert.deepEqual(
    { name: result.infrastructure.error.name, message: result.infrastructure.error.message },
    { name: 'Error', message: 'spawn denied' },
  );
});

test('clean close publishes a terminal passing result without failures', async (t) => {
  const root = await artifactRoot(t);
  const times = [1_000, 1_075];
  const result = await runSupervisor({ laneName: 'unit', artifactRoot: root, dependencies: {
    platform: 'linux', now: () => times.shift(), spawn: fakeSpawn(),
  } });

  assert.equal(result.verdict, 'passed');
  assert.equal(result.terminal_cause, 'close_0');
  assert.deepEqual(result.child, { code: 0, signal: null });
  assert.equal(result.duration_ms, 75);
  const published = JSON.parse(await readFile(join(result.artifactDir, 'result.json'), 'utf8'));
  assert.equal(published.verdict, 'passed');
  assert.equal(published.terminal_cause, 'close_0');
  assert.equal(published.tests.tests, 3);
  assert.equal(published.coverage, null);
  assert.deepEqual(result.failureDetails, []);
});

test('terminal result is published only after child stderr is fully persisted', async (t) => {
  const root = await artifactRoot(t);
  const result = await runSupervisor({ laneName: 'unit', artifactRoot: root, dependencies: {
    platform: 'linux', spawn: fakeSpawn({ stderr: 'last diagnostic\n', stderrDelayMs: 25 }),
  } });
  assert.equal(result.verdict, 'passed');
  assert.equal(await readFile(join(result.artifactDir, 'stderr.txt'), 'utf8'), 'last diagnostic\n');
});

test('stderr persistence failure becomes a terminal infrastructure error', async (t) => {
  const spawnWithBrokenStderr = (command, args) => {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stderr = {
      pipe(destination) {
        setTimeout(() => destination.destroy(new Error('artifact storage failed')), 10);
      },
    };
    queueMicrotask(async () => {
      await writeFile(reporterPath(args), `${JSON.stringify({ type: 'test:summary', data: { tests: 1, passed: 1, failed: 0 } })}\n`);
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await runSupervisor({
    laneName: 'unit',
    artifactRoot: await artifactRoot(t),
    dependencies: { platform: 'linux', spawn: spawnWithBrokenStderr },
  });

  assert.equal(result.verdict, 'runner_error');
  assert.equal(result.terminal_cause, 'stream_error');
  assert.deepEqual(
    { stage: result.infrastructure.stage, cause: result.infrastructure.cause, message: result.infrastructure.error.message },
    { stage: 'stream', cause: 'stream_error', message: 'artifact storage failed' },
  );
});

test('coverage lane publishes a passing manifest-complete gate result above the accepted threshold', async (t) => {
  const root = await artifactRoot(t);
  const coverage = await coverageSummary(100);
  const result = await runSupervisor({ laneName: 'coverage', artifactRoot: root, dependencies: {
    platform: 'darwin', spawn: fakeSpawn({ coverage }),
  } });
  const published = await publishedResult(result);
  assert.equal(published.verdict, 'passed');
  assert.equal(published.terminal_cause, 'close_0');
  assert.deepEqual(published.coverage.metrics, { lines: 100, branches: 100, functions: 100 });
  assert.deepEqual(published.coverage.thresholds, { lines: 90, branches: 90, functions: 90 });
  assert.deepEqual(published.coverage.reported, [...published.coverage.manifest].sort());
  assert.deepEqual(published.coverage.diagnostics, []);
});

test('coverage lane fails closed when the coverage event is missing', async (t) => {
  const result = await runSupervisor({ laneName: 'coverage', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn(),
  } });
  const published = await publishedResult(result);
  assert.equal(published.verdict, 'failed');
  assert.equal(published.terminal_cause, 'coverage_gate');
  assert.equal(published.coverage.metrics, null);
  assert.deepEqual(published.coverage.diagnostics, [{ code: 'coverage_event_missing' }]);
});

test('coverage lane fails closed when the reporter publishes a malformed coverage summary', async (t) => {
  const result = await runSupervisor({ laneName: 'coverage', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn({ coverage: { files: 'not-an-array' } }),
  } });
  const published = await publishedResult(result);

  assert.equal(published.verdict, 'failed');
  assert.equal(published.terminal_cause, 'coverage_gate');
  assert.deepEqual(published.coverage.diagnostics, [{ code: 'coverage_event_missing' }]);
});

test('coverage lane reports new, missing, and unloaded product sources', async (t) => {
  const full = await coverageSummary();
  const manifest = full.files.map((file) => `scripts/${file.path.split('/').at(-1)}`).sort();
  const unexpected = { files: [...full.files, {
    path: join(projectRoot, 'unexpected-product.mjs'),
    totalLineCount: 1, coveredLineCount: 1,
    totalBranchCount: 1, coveredBranchCount: 1,
    totalFunctionCount: 1, coveredFunctionCount: 1,
  }] };
  const scenarios = [
    { discover: [...manifest, 'scripts/new-product.mjs'], coverage: full, code: 'coverage_manifest_mismatch', field: 'undeclared', value: 'scripts/new-product.mjs' },
    { discover: manifest.slice(1), coverage: full, code: 'coverage_manifest_mismatch', field: 'absent', value: manifest[0] },
    { discover: manifest, coverage: await coverageSummary(100, [manifest[0]]), code: 'coverage_report_mismatch', field: 'unloaded', value: manifest[0] },
    { discover: manifest, coverage: unexpected, code: 'coverage_report_mismatch', field: 'unexpected', value: 'unexpected-product.mjs' },
  ];
  for (const scenario of scenarios) {
    const result = await runSupervisor({ laneName: 'coverage', artifactRoot: await artifactRoot(t), dependencies: {
      platform: 'linux', spawn: fakeSpawn({ coverage: scenario.coverage }), discoverProductSources: async () => scenario.discover,
    } });
    const published = await publishedResult(result);
    assert.equal(published.verdict, 'failed');
    assert.equal(published.terminal_cause, 'coverage_gate');
    assert.equal(published.coverage.diagnostics.find((entry) => entry.code === scenario.code)[scenario.field].includes(scenario.value), true);
  }
});

test('coverage lane reports every metric below the accepted threshold', async (t) => {
  const result = await runSupervisor({ laneName: 'coverage', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn({ coverage: await coverageSummary(89) }),
  } });
  const published = await publishedResult(result);
  assert.equal(published.verdict, 'failed');
  assert.equal(published.terminal_cause, 'coverage_gate');
  assert.deepEqual(published.coverage.metrics, { lines: 89, branches: 89, functions: 89 });
  assert.deepEqual(published.coverage.diagnostics.filter((entry) => entry.code === 'coverage_below_threshold').map((entry) => entry.metric),
    ['lines', 'branches', 'functions']);
});

test('coverage lane fails closed when reporter counters are not numeric', async (t) => {
  const coverage = await coverageSummary();
  coverage.files[0].coveredBranchCount = undefined;
  const result = await runSupervisor({ laneName: 'coverage', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn({ coverage }),
  } });
  const published = await publishedResult(result);
  assert.equal(published.verdict, 'failed');
  assert.equal(published.terminal_cause, 'coverage_gate');
  assert.deepEqual(published.coverage.diagnostics.filter((entry) => entry.code === 'coverage_below_threshold').map((entry) => entry.metric),
    ['branches']);
});

test('coverage lane rejects product files with no executable counters', async (t) => {
  const coverage = await coverageSummary();
  for (const file of coverage.files) {
    file.totalLineCount = 0;
    file.coveredLineCount = 0;
    file.totalBranchCount = 0;
    file.coveredBranchCount = 0;
    file.totalFunctionCount = 0;
    file.coveredFunctionCount = 0;
  }
  const result = await runSupervisor({ laneName: 'coverage', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn({ coverage }),
  } });
  const published = await publishedResult(result);

  assert.equal(published.verdict, 'failed');
  assert.equal(published.terminal_cause, 'coverage_gate');
  assert.deepEqual(published.coverage.metrics, { lines: null, branches: null, functions: null });
  assert.deepEqual(published.coverage.diagnostics.filter((entry) => entry.code === 'coverage_below_threshold').map((entry) => entry.metric),
    ['lines', 'branches', 'functions']);
});

test('nonzero exit and signal termination produce failed verdicts with distinct terminal causes', async (t) => {
  const root = await artifactRoot(t);
  const nonzero = await runSupervisor({ laneName: 'release', artifactRoot: root, dependencies: { platform: 'linux', spawn: fakeSpawn({ code: 7 }) } });
  const signalled = await runSupervisor({ laneName: 'release', artifactRoot: root, dependencies: { platform: 'linux', spawn: fakeSpawn({ code: null, signal: 'SIGABRT' }) } });
  assert.deepEqual({ verdict: nonzero.verdict, cause: nonzero.terminal_cause, child: nonzero.child },
    { verdict: 'failed', cause: 'exit_nonzero', child: { code: 7, signal: null } });
  assert.deepEqual({ verdict: signalled.verdict, cause: signalled.terminal_cause, child: signalled.child },
    { verdict: 'failed', cause: 'child_signal', child: { code: null, signal: 'SIGABRT' } });
});

test('asynchronous child spawn error has infrastructure precedence over a later close', async (t) => {
  const root = await artifactRoot(t);
  const result = await runSupervisor({ laneName: 'unit', artifactRoot: root, dependencies: {
    platform: 'linux', spawn: fakeSpawn({ code: 1, childError: Object.assign(new Error('late spawn failure'), { code: 'ENOENT' }) }),
  } });
  assert.equal(result.verdict, 'runner_error');
  assert.equal(result.terminal_cause, 'spawn_error');
  assert.equal(result.infrastructure.stage, 'spawn');
});

test('SIGINT interruption publishes an interrupted terminal result', async (t) => {
  const root = await artifactRoot(t);
  const pending = runSupervisor({ laneName: 'unit', artifactRoot: root, dependencies: {
    platform: 'linux', spawn: fakeSpawn({ signal: 'SIGTERM', closeDelayMs: 25 }),
  } });
  setTimeout(() => process.emit('SIGINT', 'SIGINT'), 5);

  const result = await pending;
  const published = await publishedResult(result);
  assert.equal(result.verdict, 'interrupted');
  assert.equal(result.terminal_cause, 'SIGINT');
  assert.deepEqual(result.child, { code: 0, signal: 'SIGTERM' });
  assert.equal(published.verdict, 'interrupted');
  assert.equal(published.terminal_cause, 'SIGINT');
});

test('the first interruption remains authoritative when another signal follows', async (t) => {
  const pending = runSupervisor({ laneName: 'unit', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn({ signal: 'SIGTERM', closeDelayMs: 35 }),
  } });
  setTimeout(() => process.emit('SIGINT', 'SIGINT'), 5);
  setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 10);

  const result = await pending;
  assert.equal(result.verdict, 'interrupted');
  assert.equal(result.terminal_cause, 'SIGINT');
});

test('a child that exits during interruption remains an interrupted run', async (t) => {
  const originalKill = process.kill;
  process.kill = () => { throw Object.assign(new Error('already exited'), { code: 'ESRCH' }); };
  t.after(() => { process.kill = originalKill; });
  const pending = runSupervisor({ laneName: 'unit', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn({ closeDelayMs: 25 }),
  } });
  setTimeout(() => process.emit('SIGINT', 'SIGINT'), 5);

  const result = await pending;
  assert.equal(result.verdict, 'interrupted');
  assert.equal(result.terminal_cause, 'SIGINT');
  assert.equal(result.infrastructure, null);
});

test('failure to signal the child process group is reported as infrastructure failure', async (t) => {
  const originalKill = process.kill;
  process.kill = () => { throw Object.assign(new Error('operation denied'), { code: 'EPERM' }); };
  t.after(() => { process.kill = originalKill; });
  const pending = runSupervisor({ laneName: 'unit', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: fakeSpawn({ signal: 'SIGTERM', closeDelayMs: 25 }),
  } });
  setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 5);

  const result = await pending;
  assert.equal(result.verdict, 'runner_error');
  assert.equal(result.terminal_cause, 'SIGTERM');
  assert.deepEqual(
    { stage: result.infrastructure.stage, cause: result.infrastructure.cause, code: result.infrastructure.error.code },
    { stage: 'signal', cause: 'signal_error', code: 'EPERM' },
  );
});

test('an unresponsive child process group is force-killed after the shutdown grace period', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalKill = process.kill;
  const signals = [];
  let child;
  let markSpawned;
  const spawned = new Promise((resolve) => { markSpawned = resolve; });
  const spawnUnresponsiveChild = (command, args) => {
    child = new EventEmitter();
    child.pid = 424242;
    child.stderr = new PassThrough();
    queueMicrotask(async () => {
      await writeFile(reporterPath(args), `${JSON.stringify({ type: 'test:summary', data: { tests: 1, passed: 0, failed: 1 } })}\n`);
      child.stderr.end();
    });
    markSpawned();
    return child;
  };
  process.kill = (pid, signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  t.after(() => {
    process.kill = originalKill;
    t.mock.timers.reset();
  });

  const pending = runSupervisor({ laneName: 'unit', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: spawnUnresponsiveChild,
  } });
  await spawned;
  process.emit('SIGINT', 'SIGINT');
  t.mock.timers.tick(5_000);

  const result = await pending;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.verdict, 'interrupted');
  assert.equal(result.terminal_cause, 'SIGINT');
  assert.deepEqual(result.child, { code: null, signal: 'SIGKILL' });
});

test('a SIGKILL escalation error is reported without replacing the initiating interruption', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalKill = process.kill;
  const signals = [];
  let child;
  let markSpawned;
  const spawned = new Promise((resolve) => { markSpawned = resolve; });
  const spawnUnresponsiveChild = (command, args) => {
    child = new EventEmitter();
    child.pid = 424242;
    child.stderr = new PassThrough();
    queueMicrotask(async () => {
      await writeFile(reporterPath(args), `${JSON.stringify({ type: 'test:summary', data: { tests: 1, passed: 0, failed: 1 } })}\n`);
      child.stderr.end();
    });
    markSpawned();
    return child;
  };
  process.kill = (pid, signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      throw Object.assign(new Error('force kill denied'), { code: 'EPERM' });
    }
    return true;
  };
  t.after(() => {
    process.kill = originalKill;
    t.mock.timers.reset();
  });

  const pending = runSupervisor({ laneName: 'unit', artifactRoot: await artifactRoot(t), dependencies: {
    platform: 'linux', spawn: spawnUnresponsiveChild,
  } });
  await spawned;
  process.emit('SIGINT', 'SIGINT');
  t.mock.timers.tick(5_000);

  const result = await pending;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.verdict, 'runner_error');
  assert.equal(result.terminal_cause, 'SIGINT');
  assert.deepEqual(
    { stage: result.infrastructure.stage, cause: result.infrastructure.cause, code: result.infrastructure.error.code },
    { stage: 'signal', cause: 'signal_error', code: 'EPERM' },
  );
});

test('deadline terminates only the owned POSIX process tree and publishes after it exits', async (t) => {
  const sibling = spawnChildProcess(process.execPath, [processTreeFixture, 'sibling'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let owned = null;
  t.after(async () => {
    if (owned && processGroupExists(owned.pid)) {
      try { process.kill(-owned.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await stopProcessGroup(sibling);
  });
  await waitForMessage(sibling, (message) => message?.type === 'ready');

  let markOwnedReady;
  const ownedReady = new Promise((resolve) => { markOwnedReady = resolve; });
  const spawnOwnedTree = (command, args, options) => {
    owned = spawnChildProcess(process.execPath, [processTreeFixture, 'owned-parent', reporterPath(args)], {
      ...options,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    waitForMessage(owned, (message) => message?.type === 'ready').then(markOwnedReady);
    return owned;
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let timersActive = true;
  t.after(() => { if (timersActive) t.mock.timers.reset(); });
  const pending = runSupervisor({
    laneName: 'unit',
    artifactRoot: await artifactRoot(t),
    dependencies: { platform: process.platform, spawn: spawnOwnedTree },
  });
  const ownedState = await ownedReady;
  t.mock.timers.tick(600_000);
  const result = await pending;
  t.mock.timers.reset();
  timersActive = false;

  const published = await publishedResult(result);
  assert.equal(published.verdict, 'timed_out');
  assert.equal(published.terminal_cause, 'deadline');
  assert.deepEqual(published.child, { code: null, signal: 'SIGTERM' });
  assert.equal(await waitForProcessGroupExit(ownedState.pid), true, `owned process group ${ownedState.pid} survived`);
  assert.equal(await waitForProcessExit(ownedState.descendantPid), true, `owned descendant ${ownedState.descendantPid} survived`);

  const pong = waitForMessage(sibling, (message) => message?.type === 'pong');
  sibling.send({ type: 'ping' });
  assert.deepEqual(await pong, { type: 'pong', pid: sibling.pid });
});

test('publication failure preserves a preceding non-success cause but replaces provisional clean close', async (t) => {
  const cases = [
    { code: 0, expectedCause: 'publish_error' },
    { code: 7, expectedCause: 'exit_nonzero' },
  ];
  for (const { code, expectedCause } of cases) {
    const result = await runSupervisor({ laneName: 'unit', artifactRoot: await artifactRoot(t), dependencies: {
      platform: 'linux', spawn: fakeSpawn({ code, preventResultPublication: true }),
    } });

    assert.equal(result.verdict, 'runner_error');
    assert.equal(result.terminal_cause, expectedCause);
    assert.equal(result.infrastructure.stage, 'publish');
    assert.equal(result.infrastructure.error.code, 'EISDIR');
  }
});

test('failure report formats each supported observable reporter shape', async (t) => {
  const cases = [
    {
      name: 'nested error message',
      failures: undefined,
      expected: 'broken test: boom',
    },
    {
      name: 'nested location and causal message',
      failures: [{ name: 'loads fixture', details: { location: 'fixture.mjs:7', cause: { message: 'fixture unavailable' } } }],
      expected: 'loads fixture: fixture.mjs:7: fixture unavailable',
    },
    {
      name: 'plain failure text',
      failures: [{ details: 'plain failure text' }],
      expected: 'test failure: plain failure text',
    },
    {
      name: 'direct fields',
      failures: [{ name: 'direct failure', file: 'direct.mjs:4', message: 'direct boom' }],
      expected: 'direct failure: direct.mjs:4: direct boom',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const result = await runSupervisor({
        laneName: 'release',
        artifactRoot: await artifactRoot(t),
        dependencies: { platform: 'linux', spawn: fakeSpawn({ code: 1, failures: scenario.failures }) },
      });

      assert.deepEqual(result.failureDetails, [scenario.expected]);
    });
  }
});

test('empty or summary-less reporter streams are incomplete, while malformed JSON is a reporter error', async (t) => {
  const root = await artifactRoot(t);
  const incomplete = [];
  for (const report of ['empty', 'incomplete']) {
    incomplete.push(await runSupervisor({ laneName: 'unit', artifactRoot: root, dependencies: { platform: 'linux', spawn: fakeSpawn({ report }) } }));
  }
  const malformed = await runSupervisor({ laneName: 'unit', artifactRoot: root, dependencies: { platform: 'linux', spawn: fakeSpawn({ report: 'invalid' }) } });
  for (const result of incomplete) {
    assert.deepEqual({ verdict: result.verdict, cause: result.terminal_cause, stage: result.infrastructure.stage },
      { verdict: 'runner_error', cause: 'reporter_incomplete', stage: 'reporter' });
  }
  assert.deepEqual({ verdict: malformed.verdict, cause: malformed.terminal_cause, stage: malformed.infrastructure.stage },
    { verdict: 'runner_error', cause: 'reporter_error', stage: 'reporter' });
});

test('CLI rejects missing and invalid lanes with the stable usage contract', async (t) => {
  for (const [name, argv] of [['missing lane', []], ['invalid lane', ['nope']]]) {
    await t.test(name, async () => {
      let stdout = '';
      let stderr = '';
      const processLike = { stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } } };

      assert.equal(await cli({ argv, processLike }), 2);
      assert.equal(stdout, '');
      assert.match(stderr, /^usage: \S+\.mjs <unit\|coverage\|release>\n$/);
    });
  }
});

test('CLI renders each terminal supervisor verdict with current-run diagnostics', async (t) => {
  const rawRoot = await artifactRoot(t);
  await writeFile(join(rawRoot, 'stderr.txt'), 'native runner crash\n');
  const cases = [
    [{ verdict: 'passed', lane: 'unit', duration_ms: 17, artifactDir: '/tmp/pass', failureDetails: [] }, 0, 'PASS unit: 17ms; artifacts: /tmp/pass\n', ''],
    [{ verdict: 'failed', terminal_cause: 'exit_nonzero', artifacts: { result: 'result.json' }, failureDetails: ['named failure: file.mjs: boom'] }, 1, '', 'failed (exit_nonzero); artifacts: result.json\nnamed failure: file.mjs: boom\n'],
    [{ verdict: 'timed_out', terminal_cause: 'deadline', artifactDir: '/tmp/deadline', failureDetails: [] }, 1, '', 'timed_out (deadline); artifacts: /tmp/deadline\n'],
    [{ verdict: 'interrupted', terminal_cause: 'SIGTERM', artifactDir: rawRoot, artifacts: { stderr: 'missing-stderr.txt' }, failureDetails: [] }, 1, '',
      `interrupted (SIGTERM); artifacts: ${rawRoot}\nstderr: ${join(rawRoot, 'missing-stderr.txt')}\nraw stderr unavailable: ENOENT\n`],
    [{ verdict: 'failed', terminal_cause: 'child_signal', artifactDir: rawRoot, artifacts: { stderr: 'stderr.txt' }, failureDetails: [] }, 1, '',
      `failed (child_signal); artifacts: ${rawRoot}\nstderr: ${join(rawRoot, 'stderr.txt')}\nraw stderr:\nnative runner crash\n`],
    [{ verdict: 'runner_error', terminal_cause: 'reporter_error', artifactDir: rawRoot, artifacts: { stderr: 'stderr.txt' },
      infrastructure: { stage: 'reporter', cause: 'reporter_error', error: { code: 'EBADMSG', message: 'malformed reporter' } }, failureDetails: [] }, 1, '',
    `runner_error (reporter_error); artifacts: ${rawRoot}\ninfrastructure: reporter; EBADMSG: malformed reporter\nstderr: ${join(rawRoot, 'stderr.txt')}\nraw stderr:\nnative runner crash\n`],
  ];
  for (const [result, expectedCode, expectedStdout, expectedStderr] of cases) {
    let stdout = ''; let stderr = '';
    const processLike = { stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } } };
    assert.equal(await cli({ argv: ['unit'], processLike, run: async () => result }), expectedCode);
    assert.equal(stdout, expectedStdout);
    assert.equal(stderr, expectedStderr);
  }
});

test('CLI reports an artifact storage failure and exits nonzero', async (t) => {
  const root = await artifactRoot(t);
  const invalidRoot = join(root, 'not-a-directory');
  await writeFile(invalidRoot, 'occupied');
  const previousRoot = process.env.NODE_TEST_ARTIFACT_ROOT;
  process.env.NODE_TEST_ARTIFACT_ROOT = invalidRoot;
  let stdout = '';
  let stderr = '';
  const processLike = { stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } } };
  try {
    assert.equal(await cli({ argv: ['release'], processLike }), 1);
  } finally {
    if (previousRoot === undefined) delete process.env.NODE_TEST_ARTIFACT_ROOT;
    else process.env.NODE_TEST_ARTIFACT_ROOT = previousRoot;
  }
  assert.equal(stdout, '');
  assert.match(stderr, /^runner_error: .+\n$/);
});

test('legacy coverage entrypoint delegates to the documented coverage lane', async () => {
  let invocation;
  const exitCode = await runUnitCoverage(async (value) => { invocation = value; return 0; });
  assert.equal(exitCode, 0);
  assert.deepEqual(invocation, { argv: ['coverage'] });
});
