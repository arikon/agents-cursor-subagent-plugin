#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
export const SCRUBBED_ENV = Object.freeze(['CURSOR_EVAL_REAL_CODEX', 'CURSOR_EVAL_HOSTED_CODEX', 'CURSOR_SUBAGENT_LIVE_E2E']);
const unitTests = Object.freeze([
  'tests/bootstrap.test.mjs', 'tests/check-openspec-semantics.test.mjs', 'tests/claude-marketplace-canary.test.mjs', 'tests/codex-app-server-client.test.mjs',
  'tests/cursor-skill-eval.test.mjs', 'tests/facade.test.mjs', 'tests/mcp-smoke.test.mjs', 'tests/mcp-transport.test.mjs',
  'tests/node-test-reporter-v22.test.mjs', 'tests/run-cursor-skill-eval.test.mjs', 'tests/runtime.test.mjs', 'tests/node-test-supervisor.test.mjs',
]);
const productSources = Object.freeze([
  'scripts/check-openspec-semantics.mjs', 'scripts/codex-app-server-client.mjs', 'scripts/cursor-eval-scenario.mjs', 'scripts/cursor-skill-eval.mjs', 'scripts/openspec-semantic-registry.mjs',
  'scripts/cursor-subagent-bootstrap.mjs', 'scripts/cursor-subagent-mcp.mjs', 'scripts/node-test-reporter-v22.mjs',
  'scripts/recording-mcp-proxy.mjs', 'scripts/run-cursor-skill-eval.mjs', 'scripts/run-node-tests.mjs', 'scripts/run-unit-coverage.mjs',
]);
const coverageThresholds = Object.freeze({ lines: 90, branches: 90, functions: 90 });
export const LANES = Object.freeze({
  unit: Object.freeze({ tests: unitTests, concurrency: 2, timeoutMs: 120_000, deadlineMs: 600_000 }),
  coverage: Object.freeze({ tests: unitTests, concurrency: 2, timeoutMs: 120_000, deadlineMs: 900_000, coverage: true }),
  release: Object.freeze({ tests: Object.freeze(['tests/release-e2e.test.mjs']), concurrency: 1, timeoutMs: 120_000, deadlineMs: 300_000 }),
});

function errorRecord(error) { return { name: error?.name || 'Error', message: error?.message || String(error), code: error?.code, stack: error?.stack }; }
function latch(state, cause, stage, error) {
  if (!state.terminalCause) state.terminalCause = cause;
  if (stage && !state.infrastructure) {
    // Every supported stage-bearing failure supplies its Error; this only
    // preserves a defensive API boundary for non-contract callers.
    /* node:coverage ignore next */
    const details = error === undefined ? {} : { error: errorRecord(error) };
    state.infrastructure = { stage, cause, ...details };
  }
}
function streamDone(stream) {
  if (stream.writableFinished || stream.destroyed) return Promise.resolve();
  return new Promise((resolveDone, rejectDone) => { stream.once('finish', resolveDone); stream.once('error', rejectDone); });
}
function parseEvents(content) {
  const events = content.trim() ? content.trim().split('\n').map((line) => JSON.parse(line)) : [];
  const summary = events.filter((entry) => entry.type === 'test:summary').at(-1)?.data || null;
  const failures = events.filter((entry) => entry.type === 'test:fail').map((entry) => entry.data);
  const coverage = events.filter((entry) => entry.type === 'test:coverage').at(-1)?.data?.summary || null;
  return { events, summary, failures, coverage, complete: Boolean(summary) };
}
function formatFailure(failure) {
  const details = failure?.details || failure;
  const error = details?.error || details?.cause || details;
  return [details?.name || failure?.name || 'test failure', details?.file || details?.location || '', error?.message || String(error || '')].filter(Boolean).join(': ');
}
async function discoverProductSources() {
  return (await readdir(here, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
}
function coverageGate(summary, discoveredSources) {
  const diagnostics = [];
  const denominatorClassifications = [];
  const manifest = [...productSources].sort();
  const discovered = [...discoveredSources].sort();
  if (!summary || !Array.isArray(summary.files)) {
    diagnostics.push({ code: 'coverage_event_missing' });
    return { passed: false, reported: [], metrics: null, diagnostics, denominatorClassifications };
  }
  const reported = summary.files.map((file) => relative(root, resolve(file.path)).replaceAll('\\', '/')).sort();
  const difference = (left, right) => left.filter((entry) => !right.includes(entry));
  const undeclared = difference(discovered, manifest);
  const absent = difference(manifest, discovered);
  if (undeclared.length || absent.length) diagnostics.push({ code: 'coverage_manifest_mismatch', undeclared, absent });
  const unloaded = difference(manifest, reported);
  const unexpected = difference(reported, manifest);
  if (unloaded.length || unexpected.length) diagnostics.push({ code: 'coverage_report_mismatch', unloaded, unexpected });
  for (const file of summary.files) {
    const source = relative(root, resolve(file.path)).replaceAll('\\', '/');
    if (!Number.isFinite(file.totalLineCount) || file.totalLineCount <= 0) {
      diagnostics.push({ code: 'coverage_invalid_line_denominator', source, actual: file.totalLineCount ?? null });
    }
    for (const [metric, totalKey] of [['branches', 'totalBranchCount'], ['functions', 'totalFunctionCount']]) {
      if (file[totalKey] === 0) denominatorClassifications.push({ source, metric, classification: 'zero_total' });
    }
  }
  const counters = {
    lines: ['coveredLineCount', 'totalLineCount'],
    branches: ['coveredBranchCount', 'totalBranchCount'],
    functions: ['coveredFunctionCount', 'totalFunctionCount'],
  };
  const metrics = Object.fromEntries(Object.entries(counters).map(([metric, [coveredKey, totalKey]]) => {
    const covered = summary.files.reduce((sum, file) => sum + file[coveredKey], 0);
    const total = summary.files.reduce((sum, file) => sum + file[totalKey], 0);
    return [metric, total > 0 ? (covered / total) * 100 : null];
  }));
  for (const [metric, required] of Object.entries(coverageThresholds)) {
    if (!Number.isFinite(metrics[metric]) || metrics[metric] < required) diagnostics.push({ code: 'coverage_below_threshold', metric, actual: metrics[metric], required });
  }
  return { passed: diagnostics.length === 0, reported, metrics, diagnostics, denominatorClassifications };
}
async function readReporter(path) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { const report = parseEvents(await readFile(path, 'utf8')); if (report.complete) return report; lastError = new Error('reporter summary is incomplete'); }
    catch (error) { lastError = error; }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw lastError;
}

export function parseArgs(argv) {
  if (argv.length !== 1 || !Object.hasOwn(LANES, argv[0])) throw Object.assign(new Error(`usage: ${basename(process.argv[1] || 'run-node-tests.mjs')} <${Object.keys(LANES).join('|')}>`), { code: 'invalid_invocation' });
  return argv[0];
}

export async function runSupervisor({ laneName, env = process.env, artifactRoot = env.NODE_TEST_ARTIFACT_ROOT || join(tmpdir(), 'codex-node-test-artifacts'), dependencies = {} }) {
  const now = dependencies.now || (() => Date.now());
  const startedAt = now();
  const artifactLabel = String(laneName).replace(/[^a-zA-Z0-9_-]/g, '-') || 'invalid';
  const dir = join(resolve(artifactRoot), `${new Date().toISOString().replace(/[:.]/g, '-')}-${artifactLabel}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const paths = { tap: join(dir, 'tap.txt'), stderr: join(dir, 'stderr.txt'), failures: join(dir, 'failures.jsonl'), result: join(dir, 'result.json') };
  const publish = async (result) => {
    try { await writeAtomic(paths.result, JSON.stringify(result)); }
    catch (error) {
      result.verdict = 'runner_error';
      if (result.terminal_cause === 'close_0') result.terminal_cause = 'publish_error';
      result.infrastructure = { stage: 'publish', cause: 'publish_error', error: errorRecord(error) };
    }
    return { ...result, artifactDir: dir };
  };
  const earlyFailure = async (terminalCause, infrastructure) => {
    const published = await publish({
      schema_version: 1, lane: laneName, verdict: 'runner_error', terminal_cause: terminalCause,
      child: { code: null, signal: null }, duration_ms: now() - startedAt, tests: null, coverage: null,
      artifacts: relativePaths(dir, paths), infrastructure,
    });
    return { ...published, failureDetails: [] };
  };
  const lane = LANES[laneName];
  const spawnProcess = dependencies.spawn || spawn;
  const platform = dependencies.platform || process.platform;
  if (!lane) return earlyFailure('invalid_lane', { stage: 'preflight', cause: 'invalid_lane' });
  if (platform !== 'darwin' && platform !== 'linux') return earlyFailure('unsupported_platform', { stage: 'preflight', cause: 'unsupported_platform' });
  const state = { terminalCause: null, infrastructure: null, timedOut: false, interrupted: false, signal: null };
  const childEnv = { ...env }; for (const key of SCRUBBED_ENV) delete childEnv[key];
  const args = ['--test', `--test-concurrency=${lane.concurrency}`, `--test-timeout=${lane.timeoutMs}`,
    '--test-reporter=tap', `--test-reporter-destination=${paths.tap}`, `--test-reporter=${join(root, 'scripts/node-test-reporter-v22.mjs')}`, `--test-reporter-destination=${paths.failures}`];
  if (lane.coverage) {
    args.push('--experimental-test-coverage', `--test-coverage-lines=${coverageThresholds.lines}`, `--test-coverage-branches=${coverageThresholds.branches}`, `--test-coverage-functions=${coverageThresholds.functions}`);
    for (const source of productSources) args.push(`--test-coverage-include=${source}`);
  }
  args.push(...lane.tests.map((test) => join(root, test)));
  let child;
  try { child = spawnProcess(process.execPath, args, { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'], detached: true }); }
  catch (error) {
    return earlyFailure('spawn_error', { stage: 'spawn', cause: 'spawn_error', error: errorRecord(error) });
  }
  const stderr = createWriteStream(paths.stderr, { flags: 'wx' });
  child.stderr?.pipe(stderr);
  child.once('error', (error) => latch(state, 'spawn_error', 'spawn', error));
  let killTimer = null;
  const stop = async (cause, signal = 'SIGTERM') => {
    latch(state, cause); if (cause === 'deadline') state.timedOut = true; else { state.interrupted = true; state.signal = cause; }
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') latch(state, 'signal_error', 'signal', error); }
    if (!killTimer) killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') latch(state, 'signal_error', 'signal', error); }
    }, 5_000);
  };
  const deadline = setTimeout(() => { void stop('deadline'); }, lane.deadlineMs);
  const onInterrupt = (signal) => { void stop(signal); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  const closed = await new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  clearTimeout(deadline); if (killTimer) clearTimeout(killTimer); process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
  try { await streamDone(stderr); } catch (error) { latch(state, 'stream_error', 'stream', error); }
  let report = { summary: null, failures: [], coverage: null, complete: false };
  try { report = await readReporter(paths.failures); }
  catch (error) { latch(state, error.message === 'reporter summary is incomplete' ? 'reporter_incomplete' : 'reporter_error', 'reporter', error); }
  const gate = lane.coverage
    ? coverageGate(report.coverage, await (dependencies.discoverProductSources || discoverProductSources)())
    : null;
  if (!state.terminalCause && lane.coverage && !gate.passed) latch(state, 'coverage_gate');
  if (!state.terminalCause && closed.signal) latch(state, 'child_signal');
  if (!state.terminalCause && closed.code !== 0) latch(state, 'exit_nonzero');
  const terminalCause = state.terminalCause || 'close_0';
  let verdict = state.infrastructure ? 'runner_error' : state.timedOut ? 'timed_out' : state.interrupted ? 'interrupted' : closed.code === 0 && !closed.signal ? 'passed' : 'failed';
  if (terminalCause === 'coverage_gate') verdict = 'failed';
  const result = { schema_version: 1, lane: laneName, verdict, terminal_cause: terminalCause, child: closed, duration_ms: now() - startedAt,
    tests: report.summary, coverage: lane.coverage ? { enabled: true, manifest: productSources, reported: gate.reported, metrics: gate.metrics,
      thresholds: coverageThresholds, diagnostics: gate.diagnostics, denominator_classifications: gate.denominatorClassifications } : null,
    artifacts: relativePaths(dir, paths), infrastructure: state.infrastructure };
  const published = await publish(result);
  return { ...published, failureDetails: report.failures.map(formatFailure) };
}
function relativePaths(dir, paths) { return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, key === 'result' ? 'result.json' : path.slice(dir.length + 1)])); }
export async function writeAtomic(path, content) { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); }
export async function cli({ argv = process.argv.slice(2), processLike = process, run = runSupervisor } = {}) {
  let lane; try { lane = parseArgs(argv); } catch (error) { processLike.stderr.write(`${error.message}\n`); return 2; }
  let result; try { result = await run({ laneName: lane }); } catch (error) { processLike.stderr.write(`runner_error: ${error.message}\n`); return 1; }
  const artifact = result.artifactDir || result.artifacts?.result || 'unavailable';
  if (result.verdict === 'passed') processLike.stdout.write(`PASS ${lane}: ${result.duration_ms}ms; artifacts: ${artifact}\n`);
  else {
    processLike.stderr.write(`${result.verdict} (${result.terminal_cause}); artifacts: ${artifact}\n`);
    if (result.infrastructure) {
      const diagnostic = result.infrastructure.error;
      const description = diagnostic ? `${diagnostic.code ? `${diagnostic.code}: ` : ''}${diagnostic.message}` : result.infrastructure.cause;
      processLike.stderr.write(`infrastructure: ${result.infrastructure.stage}${description ? `; ${description}` : ''}\n`);
    }
    for (const failure of result.failureDetails || []) processLike.stderr.write(`${failure}\n`);
    const stderrRef = result.artifactDir && result.artifacts?.stderr ? join(result.artifactDir, result.artifacts.stderr) : null;
    if (stderrRef) {
      processLike.stderr.write(`stderr: ${stderrRef}\n`);
      if (!(result.failureDetails || []).length) {
        try {
          const rawStderr = await readFile(stderrRef, 'utf8');
          if (rawStderr) processLike.stderr.write(`raw stderr:\n${rawStderr}${rawStderr.endsWith('\n') ? '' : '\n'}`);
        } catch (error) {
          const diagnostic = errorRecord(error);
          // Node fs read errors in the supported runtime always have `code`;
          // the name fallback only protects non-Node injected implementations.
          /* node:coverage disable */
          processLike.stderr.write(`raw stderr unavailable: ${diagnostic.code || diagnostic.name}\n`);
          /* node:coverage enable */
        }
      }
    }
  }
  return result.verdict === 'passed' ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await cli();
