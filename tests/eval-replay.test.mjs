import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { replayMatrix } from '../scripts/eval/replay-cursor-skill-eval.mjs';
import { readEvaluatorInventory } from '../scripts/cursor-skill-eval.mjs';
import { canonicalJson } from '../scripts/cursor-eval-scenario.mjs';
import { scenarioById, childResult, passHarness, inertFixture } from './run-cursor-skill-eval-test-support.mjs';
import { parseChildResult, runEval } from '../scripts/run-cursor-skill-eval.mjs';

const digest = (bytes) => ({ bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') });
test('diagnostic replay retains every original trial and rejects drift or insufficient captures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'eval-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = await readEvaluatorInventory();
  for (const { path } of inventory.files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), await readFile(new URL(`../${path}`, import.meta.url)));
  }
  const corpusPath = 'evals/cursor-subagent-scenarios.v1.json';
  await mkdir(join(root, 'evals'), { recursive: true });
  const corpus = await readFile(new URL(`../${corpusPath}`, import.meta.url));
  await writeFile(join(root, corpusPath), corpus);
  const scenario = scenarioById.get('model-semantic-failure');
  const child = childResult(scenario.scenario_id);
  const inputs = structuredClone(inventory.files);
  Object.assign(inputs.find(({ path }) => path === 'scripts/cursor-eval-scenario.mjs'), digest('previous oracle'));
  const evaluator = digest(JSON.stringify({ files: inputs, selected_runner: inventory.selected_runner }));
  const skillInput = inventory.files.find(({ path }) => path === 'skills/cursor-subagent/SKILL.md');
  const skill = { bytes: skillInput.bytes, sha256: skillInput.sha256 };
  const payload = { evaluator, corpus: digest(corpus), skill,
    adapter: child.manifest.adapter, package_payload: child.manifest.installed_payload.payload_hash, client: child.manifest.client };
  const candidate = { payload, inputs, selected_runner: inventory.selected_runner, digest: digest(canonicalJson(payload)) };
  const publishedProof = async (behaviorFailure = false, repairedAddress = false) => {
    let proof;
    const result = await runEval({ scenarioId: scenario.scenario_id, env: { CURSOR_EVAL_HOSTED_CODEX: '1' } }, {
      ...inertFixture, readEvaluatorInventory: async () => ({ ...inventory, digest: evaluator }),
      runHarness: async (config, env) => {
        const harness = await passHarness(config, env);
        harness.childResult.provenance.managed_installed_skill = skill;
        harness.childResult.manifest.installed_skill = skill;
        harness.childResult.manifest.model = { provider: null, name: 'test-model' };
        const terminal = scenario.program.steps[0];
        const resultDigest = digest(terminal.result_text).sha256;
        harness.childResult.projection_inputs = { safe_evidence: [
          { event: 'prompt_result', step_id: terminal.step_id, result_sha256: resultDigest,
            preview_sha256: resultDigest, preview_truncated: false },
        ], turn_safe_evidence_starts: [0] };
        harness.childResult.transcript = structuredClone(harness.childResult.transcript);
        harness.childResult.transcript.calls[1].response.terminal_receipt = { result_sha256: resultDigest, result_truncated: false };
        harness.childResult.transcript.calls[1].response.result_read = {
          complete: true, eof: true, total_bytes: Buffer.byteLength(terminal.result_text), sha256: resultDigest,
        };
        harness.childResult.observations.private_extra = 'not-for-publication';
        if (repairedAddress) {
          const wait = harness.childResult.transcript.calls[1];
          wait.request.arguments_without_session_turn_sha256 = digest('{}').sha256;
          harness.childResult.transcript.calls.splice(1, 0, { tool: 'cursor_wait',
            request: { ...wait.request, turn_id: 'typo' }, response: { ok: false, error_code: 'unknown_turn' } });
          harness.childResult.transcript.turn_call_ranges = [{ start: 0, end: harness.childResult.transcript.calls.length }];
          harness.childResult.transcript.unexpected_input_requests = 0;
          // Historical projection attributed this addressed rejection to a
          // different turn. Replay must recompute from the captured calls.
          harness.childResult.observations.trace[2].turn_id = 'typo';
        }
        if (behaviorFailure) {
          harness.childResult.observations.trace = harness.childResult.observations.trace.filter(({ kind }) => kind !== 'session.close-attempted');
          harness.childResult.transcript.calls.pop();
        }
        const wire = structuredClone(harness.childResult);
        wire.schema_version = 1; wire.scenario_id = scenario.scenario_id;
        delete wire.observations.private_extra; delete wire.observations.captured_finals;
        wire.provenance.cache_loaded_skill = skill;
        assert.deepEqual(parseChildResult(JSON.stringify(wire), scenario.scenario_id).projection_inputs,
          harness.childResult.projection_inputs);
        return harness;
      },
      publishEvidence: async ({ makeEvidence }) => { proof = makeEvidence('/tmp/evidence.json'); return '/tmp/evidence.json'; },
    });
    assert.equal(result.eval_status, behaviorFailure || repairedAddress ? 'agent_behavior_mismatch' : 'pass');
    assert.ok(!JSON.stringify(proof.replay_inputs).includes('not-for-publication'));
    assert.deepEqual(Object.keys(proof.replay_inputs.observations).sort(), ['actual_task_outcome', 'callbacks', 'effects', 'trace']);
    return proof;
  };
  const evidence = await publishedProof();
  let counter = 0;
  const run = async (mutate = () => {}, mutateMatrix = () => {}, mutateCandidate = () => {}) => {
    const bundle = join(root, `bundle-${counter++}`); await mkdir(bundle);
    const saved = structuredClone(evidence); mutate(saved);
    const savedCandidate = structuredClone(candidate); mutateCandidate(savedCandidate);
    const candidateBytes = JSON.stringify(savedCandidate); const evidenceBytes = JSON.stringify(saved);
    const declarationBytes = JSON.stringify({ model: 'test-model', effort: 'high', initial: {
      evaluator: savedCandidate.payload.evaluator, corpus: savedCandidate.payload.corpus, skill: savedCandidate.payload.skill } });
    await writeFile(join(bundle, 'declaration.json'), declarationBytes);
    await writeFile(join(bundle, 'candidate.json'), candidateBytes); await writeFile(join(bundle, 'evidence.json'), evidenceBytes);
    const matrix = { model: 'test-model', effort: 'high', candidate_ref: 'candidate.json', candidate_digest: savedCandidate.digest, counts: { total: 2 },
      artifacts: [{ path: 'candidate.json', ...digest(candidateBytes) }, { path: 'evidence.json', ...digest(evidenceBytes) }, { path: 'declaration.json', ...digest(declarationBytes) }],
      results: [1, 2].map((serial_index) => ({ serial_index, scenario_id: scenario.scenario_id, eval_status: saved.final_result.eval_status, evidence_ref: 'evidence.json' })) };
    mutateMatrix(matrix);
    const input = join(bundle, 'matrix.json'); const output = join(bundle, 'replay.json');
    const original = JSON.stringify(matrix); await writeFile(input, original);
    const result = await replayMatrix(input, output, { root });
    assert.equal(await readFile(input, 'utf8'), original);
    assert.equal(await readFile(join(bundle, 'evidence.json'), 'utf8'), evidenceBytes);
    assert.equal(result.new_hosted_trials, 0);
    assert.equal(result.trials.length, 2);
    assert.deepEqual(result.trials.map(({ serial_index }) => serial_index), [1, 2]);
    return { result, input, output };
  };
  const green = await run();
  assert.equal(green.result.counts.replayed, 2);
  assert.equal(green.result.original_model, 'test-model');
  assert.equal(green.result.original_effort, 'high');
  assert.ok(green.result.trials.every(({ replay_verdict }) => replay_verdict.eval_status === 'pass'));
  const cli = fileURLToPath(new URL('../scripts/eval/replay-cursor-skill-eval.mjs', import.meta.url));
  const cliOutput = join(dirname(green.input), 'cli-replay.json');
  const executed = await promisify(execFile)(process.execPath, [cli, green.input, cliOutput]);
  assert.equal(JSON.parse(executed.stdout).replayed, 2);
  await assert.rejects(promisify(execFile)(process.execPath, [cli, green.input, cliOutput]), /EEXIST/);
  await assert.rejects(promisify(execFile)(process.execPath, [cli]), /usage:/);
  const failedProof = await publishedProof(true);
  const failed = await run((e) => Object.assign(e, failedProof));
  assert.equal(failed.result.counts.replayed, 2);
  assert.ok(failed.result.trials.every(({ replay_verdict }) => replay_verdict.eval_status === 'agent_behavior_mismatch'));
  const recoveredProof = await publishedProof(false, true);
  const recovered = await run((e) => Object.assign(e, recoveredProof));
  assert.ok(recovered.result.trials.every(({ original_verdict, replay_verdict }) => original_verdict === 'agent_behavior_mismatch'
    && replay_verdict?.eval_status === 'pass' && replay_verdict.recovered_calls.length === 1));
  await assert.rejects(replayMatrix(green.input, green.output, { root }), /EEXIST/);
  await assert.rejects(replayMatrix(green.input, green.input, { root }), /output_must_be_new/);
  for (const [mutate, reason] of [
    [(e) => { delete e.replay_inputs; }, 'missing_replay_capture'],
    [(e) => { e.replay_inputs.scenario.initial_input += ' changed'; }, 'model_facing_scenario_changed'],
    [(e) => { e.captured_finals[0].completeness = 'incomplete'; }, 'insufficient_or_invalid_capture'],
    [(e) => { e.final_result.cleanup_status = 'failed'; }, 'original_cleanup_incomplete'],
    [(e) => { delete e.replay_inputs.observations.actual_task_outcome; }, 'insufficient_or_invalid_capture'],
    [(e) => { e.transcript = {}; }, 'insufficient_or_invalid_capture'],
    [(e) => { e.manifest.model.name = 'different'; }, 'trial_model_mismatch'],
    [(e) => { e.manifest.client.version = 'different'; }, 'trial_provenance_mismatch'],
    [(e) => { e.captured_finals[0].text = null; }, 'insufficient_or_invalid_capture'],
    [(e) => { e.transcript.turn_call_ranges = []; }, 'insufficient_or_invalid_capture'],
    [(e) => { delete e.replay_inputs.projection_inputs; }, 'missing_or_invalid_projection_capture'],
    [(e) => { e.replay_inputs.projection_inputs.turn_safe_evidence_starts = [1]; }, 'missing_or_invalid_projection_capture'],
    [(e) => {
      e.replay_inputs.scenario.followups = [{ input: 'Continue.' }];
      e.replay_inputs.projection_inputs.turn_safe_evidence_starts = [0, e.replay_inputs.projection_inputs.safe_evidence.length + 1];
    }, 'missing_or_invalid_projection_capture'],
    [(e) => {
      e.replay_inputs.scenario.followups = [{ input: 'Continue.' }, { input: 'Continue again.' }];
      e.replay_inputs.projection_inputs.turn_safe_evidence_starts = [0, 1, 0];
    }, 'missing_or_invalid_projection_capture'],
  ]) assert.ok((await run(mutate)).result.trials.every((trial) => trial.reason === reason));
  assert.ok((await run(() => {}, (m) => { m.artifacts[1].sha256 = '0'.repeat(64); })).result.trials.every(({ reason }) => reason === 'artifact_digest_mismatch'));
  assert.ok((await run(() => {}, (m) => { m.results[0].eval_status = 'integration_failure'; })).result.trials[0].reason === 'original_execution_incomplete');
  assert.ok((await run(() => {}, (m) => { m.model = 'different'; })).result.trials.every(({ reason }) => reason === 'declaration_mismatch'));
  assert.ok((await run(() => {}, (m) => { m.effort = 'low'; })).result.trials.every(({ reason }) => reason === 'declaration_mismatch'));
  for (const key of ['results', 'artifacts']) await assert.rejects(run(() => {}, (m) => { m[key] = {}; }), /invalid_matrix/);
  for (const ref of [null, '/tmp/outside.json', '../outside.json']) {
    assert.ok((await run(() => {}, (m) => { m.results[0].evidence_ref = ref; })).result.trials[0].reason === 'invalid_artifact_reference');
  }
  const rebind = (c) => {
    c.payload.evaluator = digest(JSON.stringify({ files: c.inputs, selected_runner: c.selected_runner }));
    c.digest = digest(canonicalJson(c.payload));
  };
  for (const [mutate, reason] of [
    [(c) => { c.digest.sha256 = '0'.repeat(64); }, 'candidate_digest_mismatch'],
    [(c) => { c.inputs[0].sha256 = '0'.repeat(64); }, 'inventory_digest_mismatch'],
    [(c) => { c.payload.skill = digest('wrong skill'); c.digest = digest(canonicalJson(c.payload)); }, 'skill_digest_mismatch'],
    [(c) => { c.inputs = c.inputs.filter(({ path }) => path !== 'skills/cursor-subagent/SKILL.md'); rebind(c); }, 'skill_digest_mismatch'],
    [(c) => { c.selected_runner = 'other.mjs'; rebind(c); }, 'inventory_changed'],
  ]) assert.ok((await run(() => {}, () => {}, mutate)).result.trials.every((trial) => trial.reason === reason));
  const extended = await run((e) => {
    e.transcript.turn_call_ranges = e.captured_finals.map((_, index) => ({ start: index === 0 ? 0 : e.transcript.calls.length, end: e.transcript.calls.length }));
    e.transcript.unexpected_input_requests = 0;
  });
  assert.equal(extended.result.counts.replayed, 2);
  await assert.rejects(run(() => {}, (m) => { m.counts.untrusted_metadata = 'x'.repeat(2_100_000); }), /replay_output_limit/);
  const linked = await run();
  const linkedEvidence = join(dirname(linked.input), 'evidence.json');
  const outside = join(root, 'outside-evidence.json');
  await writeFile(outside, await readFile(linkedEvidence)); await rm(linkedEvidence); await symlink(outside, linkedEvidence);
  assert.ok((await replayMatrix(linked.input, join(dirname(linked.input), 'replay-linked.json'), { root })).trials.every(({ reason }) => reason === 'artifact_not_regular_file'));
  const ancestor = await run();
  const outsideDirectory = join(root, 'outside-directory'); await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, 'evidence.json'), await readFile(join(dirname(ancestor.input), 'evidence.json')));
  await symlink(outsideDirectory, join(dirname(ancestor.input), 'linked-directory'));
  const escapedMatrix = JSON.parse(await readFile(ancestor.input));
  escapedMatrix.artifacts.find(({ path }) => path === 'evidence.json').path = 'linked-directory/evidence.json';
  escapedMatrix.results.forEach((trial) => { trial.evidence_ref = 'linked-directory/evidence.json'; });
  const escapedInput = join(dirname(ancestor.input), 'matrix-escaped.json'); await writeFile(escapedInput, JSON.stringify(escapedMatrix));
  assert.ok((await replayMatrix(escapedInput, join(dirname(ancestor.input), 'replay-escaped.json'), { root })).trials.every(({ reason }) => reason === 'artifact_outside_bundle'));
  for (const path of ['skills/cursor-subagent/SKILL.md', 'scripts/cursor-subagent-mcp.mjs']) {
    const original = await readFile(join(root, path)); await writeFile(join(root, path), 'changed');
    assert.ok((await run()).result.trials.every(({ reason }) => reason === `input_changed:${path}`));
    await writeFile(join(root, path), original);
  }
  await writeFile(join(root, corpusPath), Buffer.concat([corpus, Buffer.from('\n')]));
  assert.ok((await run()).result.trials.every(({ reason }) => reason === 'corpus_changed'));
});
