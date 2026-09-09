import test from 'node:test';
import * as support from './run-cursor-skill-eval-test-support.mjs';

const { assert, execFile, createHash, EventEmitter, mkdtemp, readFile, rm, writeFile, tmpdir, join, promisify, fileURLToPath, admitScenarioCorpus, evaluateScenario, materializeScenario, parseScenarioCorpus, assertEvalResultV1, cli, parseChildResult, publishFinalEvidence, runEval, runHarness, run, execute, transcript, toolSequence, requestTrace, rawCorpus, admittedCorpus, corpusDigest, scenarioById, fixedDigest, evaluatorDigest, observedTraceFor, observedCallbacksFor, transcriptFor, reportChecksFor, capturedFinalsFor, observationsFor, childResult, passHarness, published, removed, inertFixture, encodedChildResult, supervisorResult } = support;

test('eval runner emits exactly one bounded lane-specific skipped EvalResultV1', async () => {
  for (const [scenario, lane] of [['client-happy', 'client-integration'], ['model-question', 'model-behavior'], ['live-marker', 'full-live']]) {
    const { stdout, stderr } = await execute(process.execPath, [run, scenario], { env: { ...process.env, CURSOR_EVAL_REAL_CODEX: '', CURSOR_EVAL_HOSTED_CODEX: '', CURSOR_SUBAGENT_LIVE_E2E: '' } });
    assert.equal(typeof stderr, 'string'); assert.equal(stdout.trim().split('\n').length, 1);
    const result = assertEvalResultV1(JSON.parse(stdout));
    assert.deepEqual({ scenario: result.scenario_id, lane: result.lane, status: result.eval_status, cleanup: result.cleanup_status }, { scenario, lane, status: 'skipped', cleanup: 'not_required' });
  }
});

test('eval runner returns a bounded machine-readable integration failure for an unknown scenario', async () => {
  const failure = await execute(process.execPath, [run, 'unknown'], { env: process.env }).then(() => assert.fail('unknown scenario must fail the process'), (error) => error);
  const { stdout, stderr } = failure;
  assert.equal(failure.code, 1);
  assert.equal(typeof stderr, 'string');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code }, { status: 'integration_failure', stage: 'runner', code: 'unknown_scenario' });
});

test('eval runner defaults to the credential-free client scenario when no scenario is supplied', async () => {
  const { stdout, stderr } = await execute(process.execPath, [run], {
    env: { ...process.env, CURSOR_EVAL_REAL_CODEX: '', CURSOR_EVAL_HOSTED_CODEX: '', CURSOR_SUBAGENT_LIVE_E2E: '' },
  });
  assert.equal(typeof stderr, 'string');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.deepEqual(
    { scenario: result.scenario_id, lane: result.lane, status: result.eval_status },
    { scenario: 'client-happy', lane: 'client-integration', status: 'skipped' },
  );
});

test('eval runner bounds an untrusted unknown scenario name in its public result', async () => {
  const failure = await execute(process.execPath, [run, 'x'.repeat(4_096)], { env: process.env }).then(() => assert.fail('unknown scenario must fail the process'), (error) => error);
  const { stdout, stderr } = failure;
  assert.equal(failure.code, 1);
  assert.equal(typeof stderr, 'string');
  const result = assertEvalResultV1(JSON.parse(stdout));
  assert.equal(result.eval_status, 'integration_failure');
  assert.ok(Buffer.byteLength(result.scenario_id, 'utf8') <= 128);
  assert.match(result.scenario_id, /\.\.\.$/);
});

test('runner selects each lane and propagates the scenario environment expected by its harness', async () => {
  const cases = [
    ['client-happy', { CURSOR_EVAL_REAL_CODEX: '1' }, 'client-integration', 'credential-free client integration', { CURSOR_EVAL_REAL_CODEX: '1' }],
    ['model-question', { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_EVIDENCE_ROOT: '/tmp/retained-eval-evidence' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_INJECT_STALE_QUESTION_ONCE: '1' }],
    ['model-mode-protocol-recovery', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE: '1' }],
    ['model-active-followup', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { FAKE_ACP_ACCELERATE_WAIT_TIMEOUT: '1', CURSOR_EVAL_LOSE_TERMINAL_WAIT_RESPONSE_ONCE: '1' }],
    ['model-launch-progress', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', {}],
    ['model-permission-covered', { CURSOR_EVAL_HOSTED_CODEX: '1' }, 'model-behavior', 'hosted Codex', { CURSOR_EVAL_HOSTED_CODEX: '1' }],
    ['live-marker', { CURSOR_SUBAGENT_LIVE_E2E: '1' }, 'full-live', 'live release canary', { CURSOR_SUBAGENT_LIVE_E2E: '1' }],
  ];
  for (const [scenarioId, env, lane, pattern, expectedEnv] of cases) {
    let observed;
    const result = await runEval({ scenarioId, env }, { ...inertFixture, publishEvidence: published,
      runHarness: async (config, harnessEnv) => { observed = { pattern: config.pattern, env: harnessEnv }; return passHarness(config, harnessEnv); } });
    assert.equal(assertEvalResultV1(result).eval_status, 'pass', JSON.stringify(result)); assert.equal(result.lane, lane); assert.equal(observed.pattern, pattern);
    for (const [name, value] of Object.entries(expectedEnv)) assert.equal(observed.env[name], value);
    assert.equal(observed.env.CURSOR_EVAL_WORKSPACE, '/tmp/fixture/workspace');
    assert.equal(observed.env.CURSOR_EVAL_EVIDENCE_ROOT, env.CURSOR_EVAL_EVIDENCE_ROOT || join(tmpdir(), 'cursor-eval-evidence'));
    assert.deepEqual(JSON.parse(observed.env.CURSOR_EVAL_SCENARIO_PAYLOAD).scenario_id, scenarioId);
    assert.match(observed.env.CURSOR_EVAL_SCENARIO_SHA256, /^[a-f0-9]{64}$/);
    assert.equal(Number.isSafeInteger(Number(observed.env.CURSOR_EVAL_SCENARIO_BYTES)), true);
    assert.equal(observed.env.CURSOR_EVAL_CORPUS_SHA256, corpusDigest.sha256);
    assert.equal(Number(observed.env.CURSOR_EVAL_CORPUS_BYTES), corpusDigest.bytes);
    if (scenarioId === 'model-launch-progress') {
      assert.equal(observed.env.CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256,
        createHash('sha256').update(JSON.stringify(['/tmp/fixture/workspace/plugin-bundle'])).digest('hex'));
    }
  }
});

test('runner reports evaluator inventory failures and frozen digest drift before starting a harness', async () => {
  const cases = [
    { env: {}, readEvaluatorInventory: async () => { throw new Error('inventory unavailable'); } },
    { env: { CURSOR_EVAL_EVALUATOR_SHA256: 'f'.repeat(64), CURSOR_EVAL_EVALUATOR_BYTES: '789' }, readEvaluatorInventory: inertFixture.readEvaluatorInventory },
    { env: { CURSOR_EVAL_EVALUATOR_SHA256: 'invalid', CURSOR_EVAL_EVALUATOR_BYTES: '789' }, readEvaluatorInventory: inertFixture.readEvaluatorInventory },
  ];
  for (const { env, readEvaluatorInventory } of cases) {
    let harnessStarted = false;
    const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1', ...env } }, {
      ...inertFixture, readEvaluatorInventory,
      runHarness: async () => { harnessStarted = true; throw new Error('must not start'); },
    });
    assert.equal(harnessStarted, false);
    assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code },
      { status: 'integration_failure', stage: 'inspection', code: 'evaluator_drift' });
  }
});

test('runner has a bounded default failure when an admitted corpus has no client scenario', async () => {
  const noClient = structuredClone(admittedCorpus);
  noClient.scenarios = noClient.scenarios.filter(({ lane }) => lane !== 'client-integration');
  const result = await runEval({ env: {} }, { readFile: async () => Buffer.from(JSON.stringify(noClient)) });
  assert.deepEqual({ scenario: result.scenario_id, status: result.eval_status, stage: result.failure_stage, code: result.error_code },
    { scenario: 'corpus-default', status: 'integration_failure', stage: 'runner', code: 'unknown_scenario' });
});

test('cleanup failure overrides a behavior mismatch after evidence publication', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 1, signal: null, failure: 'scenario_contract_mismatch',
      childResult: childResult(config.scenario.scenario_id, { actual: 'succeeded', status: 'agent_behavior_mismatch',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
    rm: async () => { throw new Error('fixture remains'); },
  });
  assert.deepEqual(assertEvalResultV1(result), {
    schema_version: 1, scenario_id: 'model-question', lane: 'model-behavior', eval_status: 'integration_failure',
    actual_task_outcome: 'succeeded', reported_task_outcome: 'not_checked', fixture_assertion_outcome: 'pass',
    evidence_publication_status: 'published', evidence_ref: '/tmp/evidence.json', cleanup_status: 'failed', failure_stage: 'cleanup',
    error_code: 'cleanup_failed', message: 'fixture remains',
  });
});

test('publication failure has integration precedence and still performs cleanup', async () => {
  let cleanupCalled = false;
  const result = await runEval({ scenarioId: 'model-plan', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: passHarness,
    publishEvidence: async () => { throw new Error('disk full'); },
    rm: async () => { cleanupCalled = true; },
  });
  assert.equal(cleanupCalled, true); assert.deepEqual({ status: result.eval_status, publication: result.evidence_publication_status, ref: result.evidence_ref, cleanup: result.cleanup_status, stage: result.failure_stage, code: result.error_code },
    { status: 'integration_failure', publication: 'failed', ref: null, cleanup: 'succeeded', stage: 'publication', code: 'evidence_publication_failed' });
  assertEvalResultV1(result);
});

test('runner and fixture setup catches always return valid stage-specific EvalResultV1 objects', async () => {
  let spawned = false;
  const corpus = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    readFile: async () => { throw Object.assign(new Error('malformed corpus'), { evalCode: 'adapter_admission' }); },
    runHarness: async () => { spawned = true; throw new Error('must not spawn'); },
  });
  assert.deepEqual(
    { status: corpus.eval_status, stage: corpus.failure_stage, code: corpus.error_code, cleanup: corpus.cleanup_status },
    { status: 'integration_failure', stage: 'adapter_admission', code: 'adapter_admission', cleanup: 'not_required' },
  );
  assert.equal(spawned, false);
  assertEvalResultV1(corpus);
  const setup = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, { mkdtemp: async () => { throw new Error('no temp'); } });
  assert.deepEqual({ status: setup.eval_status, stage: setup.failure_stage, code: setup.error_code, cleanup: setup.cleanup_status }, { status: 'integration_failure', stage: 'runner', code: 'fixture_setup_failed', cleanup: 'not_required' });
  assertEvalResultV1(setup);
  const harness = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: async () => { throw Object.assign(new Error('spawn failed'), { evalCode: 'harness_spawn_failure' }); },
  });
  assert.deepEqual({ status: harness.eval_status, stage: harness.failure_stage, code: harness.error_code, assertion: harness.fixture_assertion_outcome, cleanup: harness.cleanup_status },
    { status: 'integration_failure', stage: 'runner', code: 'harness_spawn_failure', assertion: 'not_observed', cleanup: 'succeeded' });
  assertEvalResultV1(harness);
  const multibyteMessage = '😀'.repeat(3_000);
  const generic = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: async () => { throw new Error(multibyteMessage); },
  });
  assert.deepEqual(
    { status: generic.eval_status, stage: generic.failure_stage, code: generic.error_code, cleanup: generic.cleanup_status },
    { status: 'integration_failure', stage: 'runner', code: 'runner_failure', cleanup: 'succeeded' },
  );
  assert.equal(Buffer.byteLength(generic.message, 'utf8') <= 8_000, true);
  assert.equal(generic.message.includes('\uFFFD'), false);
  assertEvalResultV1(generic);
});

test('runner admits string corpus input and rejects empty or oversized corpus bytes before fixture setup', async () => {
  const admitted = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    ...inertFixture,
    readFile: async () => rawCorpus.toString('utf8'),
    runHarness: passHarness,
    publishEvidence: published,
  });
  assert.equal(assertEvalResultV1(admitted).eval_status, 'pass');

  for (const contents of ['', 'x'.repeat(1_048_577)]) {
    let fixtureCreated = false;
    const rejected = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
      readFile: async () => contents,
      mkdtemp: async () => { fixtureCreated = true; return '/tmp/unexpected-fixture'; },
    });
    assert.deepEqual(
      { status: rejected.eval_status, stage: rejected.failure_stage, code: rejected.error_code },
      { status: 'integration_failure', stage: 'adapter_admission', code: 'adapter_admission' },
    );
    assert.equal(fixtureCreated, false);
    assertEvalResultV1(rejected);
  }
});

test('runner preserves adapter-admission classification from an enabled harness boundary', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    runHarness: async () => { throw Object.assign(new Error('unsupported adapter payload'), { evalCode: 'adapter_admission' }); },
  });
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, cleanup: result.cleanup_status },
    { status: 'integration_failure', stage: 'adapter_admission', code: 'adapter_admission', cleanup: 'succeeded' },
  );
  assertEvalResultV1(result);
});

test('runner owns the disposable fixture lifecycle by default', async () => {
  let fixtureRoot;
  const result = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    runHarness: async (_config, harnessEnv) => {
      fixtureRoot = harnessEnv.CURSOR_EVAL_CHILD_RESULT.slice(0, -'/child-result.json'.length);
      return passHarness(_config, harnessEnv);
    },
    publishEvidence: published,
  });
  assert.equal(result.eval_status, 'pass');
  await assert.rejects(readFile(fixtureRoot), /ENOENT/);
});

test('runner normalizes a harness infrastructure failure without child evidence', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async () => ({ code: 9, signal: null, failure: 'harness_failure', childResult: null, semantic: null, diagnostics: 'failed' }),
  });
  assert.deepEqual(
    {
      status: result.eval_status,
      actual: result.actual_task_outcome,
      reported: result.reported_task_outcome,
      assertion: result.fixture_assertion_outcome,
      stage: result.failure_stage,
      code: result.error_code,
    },
    {
      status: 'integration_failure',
      actual: 'not_observed',
      reported: 'not_checked',
      assertion: 'not_observed',
      stage: 'runner',
      code: 'harness_failure',
    },
  );
  assertEvalResultV1(result);
});

test('runner does not publish durable evidence before complete programmed or package proof', async () => {
  const packageFailure = childResult('live-marker');
  packageFailure.manifest = null;
  packageFailure.observations = { ...packageFailure.observations, assertion_outcome: 'not_observed', eval_status: 'integration_failure' };
  for (const [scenarioId, env, harness] of [
    ['model-question', { CURSOR_EVAL_HOSTED_CODEX: '1' }, { code: 9, signal: null, failure: 'harness_failure', childResult: null, diagnostics: 'failed' }],
    ['live-marker', { CURSOR_SUBAGENT_LIVE_E2E: '1' }, { code: 1, signal: null, failure: 'child_integration_failure', childResult: packageFailure, diagnostics: 'failed' }],
  ]) {
    let published = false;
    const result = await runEval({ scenarioId, env }, {
      ...inertFixture,
      runHarness: async () => harness,
      publishEvidence: async () => { published = true; },
    });
    assert.deepEqual(
      { status: result.eval_status, publication: result.evidence_publication_status, ref: result.evidence_ref },
      { status: 'integration_failure', publication: 'not_attempted', ref: null },
    );
    assert.equal(published, false);
    assertEvalResultV1(result);
  }
});

test('runner distinguishes malformed proof inspection from missing runner evidence', async () => {
  for (const [failure, stage] of [['child_result_invalid', 'inspection'], ['child_result_missing', 'runner']]) {
    const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
      ...inertFixture,
      runHarness: async () => ({ code: 1, signal: null, failure, childResult: null, diagnostics: '' }),
    });
    assert.equal(result.eval_status, 'integration_failure');
    assert.equal(result.failure_stage, stage);
    assert.equal(result.error_code, failure);
    assert.equal(result.evidence_ref, null);
  }
});

test('runner treats missing child evidence as an integration failure before behavior classification', async () => {
  const result = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async () => ({
      code: 1,
      signal: null,
      failure: 'scenario_contract_mismatch',
      childResult: null,
      diagnostics: '',
    }),
  });
  assert.deepEqual(
    {
      status: result.eval_status,
      actual: result.actual_task_outcome,
      reported: result.reported_task_outcome,
      assertion: result.fixture_assertion_outcome,
      stage: result.failure_stage,
    },
    {
      status: 'integration_failure',
      actual: 'not_observed',
      reported: 'not_checked',
      assertion: 'not_observed',
      stage: 'runner',
    },
  );
  assertEvalResultV1(result);
});

test('published evidence is emitted after cleanup with exact child provenance and the final EvalResultV1', async () => {
  const order = []; let evidence;
  const result = await runEval({ scenarioId: 'client-happy', env: { CURSOR_EVAL_REAL_CODEX: '1' } }, {
    ...inertFixture, runHarness: passHarness,
    rm: async () => { order.push('cleanup'); },
    publishEvidence: async ({ makeEvidence }) => { order.push('publication'); evidence = makeEvidence('/tmp/final-evidence.json'); return '/tmp/final-evidence.json'; },
  });
  assert.deepEqual(order, ['cleanup', 'publication']); assert.equal(result.eval_status, 'pass');
  assert.deepEqual(evidence.skill, { sha256: 'a'.repeat(64), bytes: 123 });
  assert.deepEqual(evidence.transcript, transcript); assert.deepEqual(evidence.provider_oracle, childResult('client-happy').provider_oracle);
  assert.equal(evidence.fixture_oracle.eval_status, 'pass');
  assert.deepEqual(evidence.final_result, { ...result, evidence_ref: 'final-evidence.json' });
  assert.deepEqual(Object.keys(evidence.manifest).sort(), ['adapter', 'client', 'corpus', 'evaluator', 'hash_algorithm', 'hash_encoding', 'installed_payload', 'installed_skill', 'materialized_scenario', 'model', 'schema_version']);
  assert.deepEqual(evidence.manifest.installed_skill, { sha256: 'a'.repeat(64), bytes: 123 });
  assert.equal(Buffer.byteLength(JSON.stringify(evidence), 'utf8') < 1_048_576, true);
});

test('actual failure outcomes are classified without grading reported prose', async () => {
  const result = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 0, signal: null, failure: null,
      childResult: childResult(config.scenario.scenario_id, { actual: 'failed',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
  });
  assert.deepEqual({ status: result.eval_status, actual: result.actual_task_outcome, reported: result.reported_task_outcome, assertion: result.fixture_assertion_outcome },
    { status: 'pass', actual: 'failed', reported: 'not_checked', assertion: 'pass' });

  const wrongActual = await runEval({ scenarioId: 'model-semantic-failure', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({ code: 0, signal: null, failure: null,
      childResult: childResult(config.scenario.scenario_id, { actual: 'succeeded', status: 'agent_behavior_mismatch',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) }, corpusDigest }), diagnostics: '' }),
  });
  assert.deepEqual({ status: wrongActual.eval_status, actual: wrongActual.actual_task_outcome, reported: wrongActual.reported_task_outcome },
    { status: 'agent_behavior_mismatch', actual: 'succeeded', reported: 'not_checked' });
});

test('runner rejects the removed skill sensitivity probe instead of silently passing it', async () => {
  let harnessStarted = false;
  const result = await runEval({
    scenarioId: 'model-state-observation',
    env: { CURSOR_EVAL_HOSTED_CODEX: '1', CURSOR_EVAL_SKILL_SENSITIVITY: 'omit-events-lost' },
  }, {
    runHarness: async () => { harnessStarted = true; throw new Error('must not start'); },
  });
  assert.equal(harnessStarted, false);
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, reported: result.reported_task_outcome },
    { status: 'integration_failure', stage: 'adapter_admission', code: 'unsupported_skill_sensitivity', reported: 'not_checked' },
  );
  assertEvalResultV1(result);
});

test('cleanup failure remains the primary stage when failure-artifact publication also fails', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture, runHarness: passHarness,
    rm: async () => { throw new Error('cleanup broke'); }, publishEvidence: async () => { throw new Error('publication broke'); },
  });
  assert.deepEqual({ status: result.eval_status, stage: result.failure_stage, code: result.error_code, publication: result.evidence_publication_status, cleanup: result.cleanup_status },
    { status: 'integration_failure', stage: 'cleanup', code: 'cleanup_failed', publication: 'failed', cleanup: 'failed' });
  assertEvalResultV1(result);
});

test('child cleanup failure takes precedence over otherwise successful scenario evidence', async () => {
  const result = await runEval({ scenarioId: 'model-question', env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({
      code: 0,
      signal: null,
      failure: null,
      childResult: childResult(config.scenario.scenario_id, {
        cleanup: 'failed',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) },
        corpusDigest,
      }),
      diagnostics: '',
    }),
  });
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, message: result.message },
    { status: 'integration_failure', stage: 'cleanup', code: 'cleanup_failed', message: 'child cleanup failed' },
  );
  assertEvalResultV1(result);
});

test('package integration failure without a harness code uses the stable child failure fallback', async () => {
  const result = await runEval({ scenarioId: 'live-marker', env: { CURSOR_SUBAGENT_LIVE_E2E: '1' } }, {
    ...inertFixture,
    publishEvidence: published,
    runHarness: async (config, harnessEnv) => ({
      code: 0,
      signal: null,
      failure: null,
      childResult: childResult(config.scenario.scenario_id, {
        status: 'integration_failure',
        scenarioDigest: { sha256: harnessEnv.CURSOR_EVAL_SCENARIO_SHA256, bytes: Number(harnessEnv.CURSOR_EVAL_SCENARIO_BYTES) },
        corpusDigest,
      }),
      diagnostics: '',
    }),
  });
  assert.deepEqual(
    { status: result.eval_status, stage: result.failure_stage, code: result.error_code, message: result.message },
    { status: 'integration_failure', stage: 'runner', code: 'child_integration_failure', message: 'eval harness failed' },
  );
  assertEvalResultV1(result);
});

test('published evidence classifies a partial child proof as integration failure and normalizes optional sections', async () => {
  let evidence;
  const partialChild = { manifest: { schema_version: 1 }, provenance: { cleanup_status: 'succeeded' } };
  const result = await runEval({ scenarioId: 'live-marker', env: { CURSOR_SUBAGENT_LIVE_E2E: '1' } }, {
    ...inertFixture,
    runHarness: async () => ({ code: 0, signal: null, failure: null, childResult: partialChild, diagnostics: '' }),
    publishEvidence: async ({ makeEvidence }) => {
      evidence = makeEvidence('/tmp/partial-evidence.json');
      return '/tmp/partial-evidence.json';
    },
  });
  assert.equal(result.eval_status, 'integration_failure');
  assert.deepEqual(
    {
      skill: evidence.skill,
      transcript: evidence.transcript,
      provider: evidence.provider_oracle,
      fixture: evidence.fixture_oracle,
      manifest: evidence.manifest,
    },
    {
      skill: null,
      transcript: { calls: [], dropped_calls: 0 },
      provider: null,
      fixture: null,
      manifest: partialChild.manifest,
    },
  );
  assertEvalResultV1(result);
});

test('harness returns validated child evidence and bounded diagnostics after a successful child exit', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    runSupervisor: async () => supervisorResult({ failureDetails: [`${'😀'.repeat(3_000)}ignored`] }),
    readFile: async () => encodedChildResult('client-happy'),
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult, childResult('client-happy'));
  assert.equal(Buffer.byteLength(result.diagnostics, 'utf8') <= 8_000, true);
  assert.equal(result.diagnostics.includes('\uFFFD'), false);
});

test('harness validates configured scenario and corpus digests at the process boundary', async () => {
  const scenario = scenarioById.get('client-happy');
  const scenarioDigest = materializeScenario(scenario, { workspace: '/tmp/fixture/workspace' }).digest;
  const result = await runHarness(
    { pattern: 'scenario', test: '/tmp/test.mjs', scenario },
    {
      CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json',
      CURSOR_EVAL_SCENARIO_ID: 'client-happy',
      CURSOR_EVAL_SCENARIO_SHA256: scenarioDigest.sha256,
      CURSOR_EVAL_SCENARIO_BYTES: String(scenarioDigest.bytes),
      CURSOR_EVAL_CORPUS_SHA256: corpusDigest.sha256,
      CURSOR_EVAL_CORPUS_BYTES: String(corpusDigest.bytes),
      CURSOR_EVAL_EVALUATOR_SHA256: evaluatorDigest.sha256,
      CURSOR_EVAL_EVALUATOR_BYTES: String(evaluatorDigest.bytes),
    },
    {
      runSupervisor: async () => supervisorResult(),
      readFile: async () => encodedChildResult('client-happy'),
    },
  );
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult.manifest.materialized_scenario, scenarioDigest);
  assert.deepEqual(result.childResult.manifest.corpus, corpusDigest);
  assert.deepEqual(result.childResult.manifest.evaluator, evaluatorDigest);
});

test('harness routes its configured test through the canonical Node supervisor', async () => {
  let invocation;
  const result = await runHarness(
    { pattern: 'hosted Codex', test: fileURLToPath(new URL('./codex-client-integration.test.mjs', import.meta.url)) },
    { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' },
    { artifactRoot: '/tmp/eval-artifacts', runSupervisor: async (value) => { invocation = value; return supervisorResult(); }, readFile: async () => encodedChildResult('client-happy') },
  );
  assert.equal(result.failure, null);
  assert.deepEqual(result.childResult, childResult('client-happy'));
  assert.deepEqual({ laneName: invocation.laneName, tests: invocation.tests, testNamePattern: invocation.testNamePattern, artifactRoot: invocation.artifactRoot }, {
    laneName: 'eval', tests: ['tests/codex-client-integration.test.mjs'], testNamePattern: 'hosted Codex', artifactRoot: '/tmp/eval-artifacts',
  });
});

test('harness tolerates a canonical supervisor result without optional failure details', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy',
  }, {
    runSupervisor: async () => ({ verdict: 'passed', terminal_cause: 'close_0', child: { code: 0, signal: null } }),
    readFile: async () => encodedChildResult('client-happy'),
  });
  assert.deepEqual({ failure: result.failure, diagnostics: result.diagnostics }, { failure: null, diagnostics: '' });
});

test('harness reads child evidence through its production filesystem adapter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-child-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childResultPath = join(root, 'child-result.json');
  await writeFile(childResultPath, encodedChildResult('client-happy'));
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: childResultPath, CURSOR_EVAL_SCENARIO_ID: 'client-happy',
  }, { runSupervisor: async () => supervisorResult() });
  assert.equal(result.failure, null);
  assert.equal(result.childResult.observations.eval_status, 'pass');
});

test('harness maps child scenario evidence to a scenario-contract mismatch', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-semantic-failure' }, {
    runSupervisor: async () => supervisorResult({ verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1 }),
    readFile: async () => encodedChildResult('model-semantic-failure', { actual: 'succeeded', status: 'agent_behavior_mismatch' }),
  });
  assert.equal(result.failure, 'scenario_contract_mismatch');
  assert.deepEqual({ actual: result.childResult.observations.actual_task_outcome, reported: result.childResult.observations.reported_task_outcome }, { actual: 'succeeded', reported: 'not_checked' });
});

test('canonical supervisor infrastructure failure dominates recorded behavior mismatch', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-semantic-failure',
  }, {
    runSupervisor: async () => supervisorResult({ verdict: 'runner_error', terminal_cause: 'reporter_error', code: 1 }),
    readFile: async () => encodedChildResult('model-semantic-failure', { actual: 'succeeded', status: 'agent_behavior_mismatch' }),
  });
  assert.equal(result.failure, 'harness_infrastructure_failure');
});

test('harness distinguishes generic child failure from a scenario-contract mismatch', async () => {
  const generic = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    runSupervisor: async () => supervisorResult({ verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1 }), readFile: async () => encodedChildResult('client-happy'),
  });
  const mismatch = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
    runSupervisor: async () => supervisorResult({ verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1 }), readFile: async () => encodedChildResult('client-happy', { actual: 'failed', status: 'agent_behavior_mismatch' }),
  });
  assert.deepEqual([generic.failure, mismatch.failure], ['harness_failure', 'scenario_contract_mismatch']);
});

test('harness preserves a hosted turn interruption instead of reporting invalid child JSON', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {
    CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'model-active-followup',
  }, {
    runSupervisor: async () => supervisorResult({
      verdict: 'failed', terminal_cause: 'exit_nonzero', code: 1,
      failureDetails: ['Codex turn became terminal before follow-up anchor: {"status":"interrupted"}'],
    }),
    readFile: async () => '{}',
  });
  assert.deepEqual(
    { failure: result.failure, childResult: result.childResult },
    { failure: 'hosted_turn_interrupted', childResult: null },
  );
});

test('harness reports missing or invalid child-result evidence before exit status', async () => {
  for (const [readFailure, expected] of [[new Error('missing'), 'child_result_missing'], [null, 'child_result_invalid']]) {
    const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, { CURSOR_EVAL_CHILD_RESULT: '/tmp/result.json', CURSOR_EVAL_SCENARIO_ID: 'client-happy' }, {
      runSupervisor: async () => supervisorResult(),
      readFile: async () => { if (readFailure) throw readFailure; return '{}'; },
    });
    assert.equal(result.failure, expected);
  }
});

test('harness classifies canonical-supervisor spawn errors with a stable eval code', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {}, {
    runSupervisor: async () => supervisorResult({ verdict: 'runner_error', terminal_cause: 'spawn_error', code: null }),
    readFile: async () => { throw new Error('missing'); },
  });
  assert.equal(result.failure, 'harness_spawn_failure');
});

test('harness maps the canonical supervisor deadline without owning another kill loop', async () => {
  const result = await runHarness({ pattern: 'scenario', test: '/tmp/test.mjs' }, {}, {
    runSupervisor: async () => supervisorResult({ verdict: 'timed_out', terminal_cause: 'deadline', code: null, signal: 'SIGTERM' }),
    readFile: async () => { throw new Error('missing'); },
  });
  assert.deepEqual({ failure: result.failure, signal: result.signal }, { failure: 'harness_timeout', signal: 'SIGTERM' });
});

test('evidence publisher writes one final document outside the fixture root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureRoot = join(root, 'fixture');
  const evidenceRoot = join(root, 'evidence');
  const finalPath = await publishFinalEvidence({ evidenceRoot, fixtureRoot, makeEvidence: (ref) => ({ schema_version: 1, evidence_ref: ref }) });
  assert.deepEqual(JSON.parse(await readFile(finalPath, 'utf8')), { schema_version: 1, evidence_ref: finalPath });
});

test('evidence publisher rejects a destination inside the disposable fixture', async () => {
  await assert.rejects(publishFinalEvidence({ evidenceRoot: '/tmp/fixture/evidence', fixtureRoot: '/tmp/fixture', makeEvidence: () => ({}) }), /outside fixture root/);
});

test('evidence publisher rejects a document beyond the public evidence limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-eval-publisher-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(publishFinalEvidence({ evidenceRoot: join(root, 'evidence'), fixtureRoot: join(root, 'fixture'), makeEvidence: () => ({ payload: 'x'.repeat(1_048_576) }) }), /output limit/);
});

test('CLI emits a single runner-termination result when SIGTERM wins the race', async () => {
  const processLike = new EventEmitter();
  let resolveEvaluation;
  const evaluation = new Promise((resolve) => { resolveEvaluation = resolve; });
  const written = [];
  const running = cli({ argv: ['node', 'runner', 'model-question'], processLike, evaluate: async () => evaluation, write: (value) => written.push(value) });
  processLike.emit('SIGTERM');
  resolveEvaluation(await runEval({ scenarioId: 'model-question', env: {} }));
  await running;
  assert.equal(processLike.exitCode, 143);
  assert.deepEqual({ count: written.length, code: written[0].error_code, cleanup: written[0].cleanup_status }, { count: 1, code: 'runner_terminated', cleanup: 'failed' });
  assertEvalResultV1(written[0]);

  let resolveUnknown;
  const unknownEvaluation = new Promise((resolve) => { resolveUnknown = resolve; });
  const unknownProcess = new EventEmitter();
  const unknownWritten = [];
  const unknownRunning = cli({ argv: ['node', 'runner', 'unknown'], processLike: unknownProcess, evaluate: async () => unknownEvaluation, write: (value) => unknownWritten.push(value) });
  unknownProcess.emit('SIGTERM');
  resolveUnknown(await runEval({ scenarioId: 'unknown', env: {} }));
  await unknownRunning;
  assert.deepEqual({ count: unknownWritten.length, lane: unknownWritten[0].lane, code: unknownWritten[0].error_code }, { count: 1, lane: 'model-behavior', code: 'runner_terminated' });
  assertEvalResultV1(unknownWritten[0]);

  let resolveDefault;
  const defaultEvaluation = new Promise((resolve) => { resolveDefault = resolve; });
  const defaultProcess = new EventEmitter();
  const defaultWritten = [];
  const defaultRunning = cli({ argv: ['node', 'runner'], processLike: defaultProcess, evaluate: async () => defaultEvaluation, write: (value) => defaultWritten.push(value) });
  defaultProcess.emit('SIGTERM');
  resolveDefault(await runEval({ env: {} }));
  await defaultRunning;
  assert.deepEqual({ count: defaultWritten.length, scenario: defaultWritten[0].scenario_id, code: defaultWritten[0].error_code },
    { count: 1, scenario: 'corpus-default', code: 'runner_terminated' });
  assertEvalResultV1(defaultWritten[0]);
});

test('CLI converts an unhandled evaluation rejection to EvalResultV1', async () => {
  const processLike = new EventEmitter();
  const written = [];
  await cli({ argv: ['node', 'runner', 'live-marker'], processLike, evaluate: async () => { throw new Error('😀'.repeat(3_000)); }, write: (value) => written.push(value) });
  assert.deepEqual({ count: written.length, lane: written[0].lane, code: written[0].error_code }, { count: 1, lane: 'full-live', code: 'unhandled_runner_failure' });
  assert.equal(processLike.exitCode, 1);
  assert.equal(Buffer.byteLength(written[0].message, 'utf8') <= 8_000, true);
  assert.equal(written[0].message.includes('\uFFFD'), false);
  assertEvalResultV1(written[0]);

  const fallback = [];
  await cli({ argv: ['node', 'runner', 'unknown'], processLike: new EventEmitter(), evaluate: async () => { throw new Error('unexpected'); }, write: (value) => fallback.push(value) });
  assert.deepEqual({ count: fallback.length, lane: fallback[0].lane, code: fallback[0].error_code }, { count: 1, lane: 'model-behavior', code: 'unhandled_runner_failure' });
  assertEvalResultV1(fallback[0]);

  const defaultScenario = [];
  await cli({ argv: ['node', 'runner'], processLike: new EventEmitter(), evaluate: async () => { throw new Error('unexpected default'); }, write: (value) => defaultScenario.push(value) });
  assert.deepEqual({ count: defaultScenario.length, lane: defaultScenario[0].lane, code: defaultScenario[0].error_code },
    { count: 1, lane: 'client-integration', code: 'unhandled_runner_failure' });
  assertEvalResultV1(defaultScenario[0]);
});

test('CLI exit code reflects every enabled eval classifier while preserving one result', async () => {
  for (const [status, exitCode] of [['pass', undefined], ['skipped', undefined], ['agent_behavior_mismatch', 1], ['integration_failure', 1]]) {
    const processLike = new EventEmitter();
    const written = [];
    const result = childResult('client-happy').observations;
    await cli({ argv: ['node', 'runner', 'client-happy'], processLike,
      evaluate: async () => ({ ...result, eval_status: status }), write: (value) => written.push(value) });
    assert.equal(written.length, 1, status);
    assert.equal(processLike.exitCode, exitCode, status);
  }
});
