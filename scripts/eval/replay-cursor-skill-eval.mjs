#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, evaluateScenario, materializeScenario, parseScenarioCorpus, validRecoveryContext } from '../cursor-eval-scenario.mjs';
import { assertEvidenceManifestV1, EVAL_LIMITS, readEvaluatorInventory } from '../cursor-skill-eval.mjs';
import { observationsFromEvidence } from '../../tests/codex-client-oracle-support.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const digest = (bytes) => ({ bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') });
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = (reason) => { throw new Error(reason); };
const oraclePath = 'scripts/cursor-eval-scenario.mjs';

export async function replayMatrix(input, output, { root = repository } = {}) {
  if (resolve(input) === resolve(output)) fail('output_must_be_new');
  const originalBytes = await readFile(input);
  const original = JSON.parse(originalBytes);
  if (!Array.isArray(original.results) || !Array.isArray(original.artifacts)) fail('invalid_matrix');
  const bundle = dirname(resolve(input));
  const realBundle = await realpath(bundle);
  const artifacts = new Map(original.artifacts.map((entry) => [entry.path, entry]));
  const loadBound = async (ref) => {
    if (typeof ref !== 'string' || isAbsolute(ref)) fail('invalid_artifact_reference');
    const path = resolve(bundle, ref); const rel = relative(bundle, path);
    if (rel.startsWith('..') || rel === '') fail('invalid_artifact_reference');
    if (!(await lstat(path)).isFile()) fail('artifact_not_regular_file');
    const actual = await realpath(path); const realRelative = relative(realBundle, actual);
    if (realRelative.startsWith('..') || isAbsolute(realRelative)) fail('artifact_outside_bundle');
    const bytes = await readFile(path);
    const declared = artifacts.get(ref);
    if (!declared || !same(digest(bytes), { bytes: declared.bytes, sha256: declared.sha256 })) fail('artifact_digest_mismatch');
    return { value: JSON.parse(bytes), reference: { path: ref, ...digest(bytes) } };
  };
  const current = await readEvaluatorInventory(root);
  const corpusBytes = await readFile(resolve(root, 'evals/cursor-subagent-scenarios.v1.json'));
  const corpus = parseScenarioCorpus(corpusBytes);
  let candidate; let globalReason = null;
  try {
    candidate = (await loadBound(original.candidate_ref)).value;
    const declaration = (await loadBound(relative(bundle, resolve(bundle, dirname(original.candidate_ref), 'declaration.json')))).value;
    if (typeof original.model !== 'string' || typeof original.effort !== 'string'
      || declaration.model !== original.model || declaration.effort !== original.effort
      || !same(declaration.initial, { evaluator: candidate.payload.evaluator, corpus: candidate.payload.corpus, skill: candidate.payload.skill })) fail('declaration_mismatch');
    if (!same(digest(canonicalJson(candidate.payload)), original.candidate_digest)
      || !same(candidate.digest, original.candidate_digest)) fail('candidate_digest_mismatch');
    if (!same(digest(JSON.stringify({ files: candidate.inputs, selected_runner: candidate.selected_runner })), candidate.payload.evaluator)) fail('inventory_digest_mismatch');
    const originalSkill = candidate.inputs.find(({ path }) => path === 'skills/cursor-subagent/SKILL.md');
    if (!originalSkill || !same({ bytes: originalSkill.bytes, sha256: originalSkill.sha256 }, candidate.payload.skill)) fail('skill_digest_mismatch');
    if (!same(digest(corpusBytes), candidate.payload.corpus)) fail('corpus_changed');
    if (!Array.isArray(candidate.inputs) || candidate.inputs.length !== current.files.length
      || new Set(candidate.inputs.map(({ path }) => path)).size !== candidate.inputs.length
      || candidate.selected_runner !== current.selected_runner) fail('inventory_changed');
    for (const previous of candidate.inputs) {
      const now = current.files.find(({ path }) => path === previous.path);
      if (!now || (previous.path !== oraclePath && !same(previous, now))) fail(`input_changed:${previous.path}`);
    }
  } catch (error) { globalReason = error.message; }
  const trials = [];
  for (const [index, trial] of original.results.entries()) {
    const entry = { original_index: index, serial_index: trial.serial_index, scenario_id: trial.scenario_id,
      original_verdict: trial.eval_status, eligibility: 'fresh_hosted_required', reason: globalReason, replay_verdict: null };
    try {
      if (globalReason) fail(globalReason);
      if (!['pass', 'agent_behavior_mismatch'].includes(trial.eval_status)) fail('original_execution_incomplete');
      const bound = await loadBound(trial.evidence_ref); entry.original_evidence = bound.reference;
      const evidence = bound.value;
      assertEvidenceManifestV1(evidence.manifest);
      if (evidence.scenario_id !== trial.scenario_id || evidence.final_result.eval_status !== trial.eval_status
        || evidence.final_result.evidence_ref !== basename(trial.evidence_ref)
        || !same(evidence.manifest.evaluator, candidate.payload.evaluator)
        || !same(evidence.manifest.installed_skill, candidate.payload.skill)
        || !same(evidence.manifest.corpus, candidate.payload.corpus)
        || !same(evidence.manifest.adapter, candidate.payload.adapter)
        || evidence.manifest.installed_payload.payload_hash !== candidate.payload.package_payload
        || !same(evidence.manifest.client, candidate.payload.client)) fail('trial_provenance_mismatch');
      if (evidence.manifest.model.name !== original.model) fail('trial_model_mismatch');
      if (evidence.final_result.cleanup_status !== 'succeeded') fail('original_cleanup_incomplete');
      const saved = evidence.replay_inputs;
      if (!saved || !saved.observations || !['trace', 'callbacks', 'effects'].every((key) => Array.isArray(saved.observations[key]))
        || !Array.isArray(evidence.captured_finals) || !evidence.transcript) fail('missing_replay_capture');
      const transcript = evidence.transcript;
      const projection = saved.projection_inputs;
      if (!projection || !Array.isArray(projection.safe_evidence)
        || projection.safe_evidence.some((entry) => !entry || Array.isArray(entry) || typeof entry !== 'object')
        || !Array.isArray(projection.turn_safe_evidence_starts)
        || projection.turn_safe_evidence_starts.length !== saved.scenario.followups.length + 1
        || projection.turn_safe_evidence_starts[0] !== 0
        || projection.turn_safe_evidence_starts.some((start, index, starts) => !Number.isSafeInteger(start)
          || start < 0 || start > projection.safe_evidence.length || (index > 0 && start < starts[index - 1]))) fail('missing_or_invalid_projection_capture');
      if (!['succeeded', 'failed', 'not_observed'].includes(saved.observations.actual_task_outcome)
        || !Array.isArray(transcript.calls) || transcript.dropped_calls !== 0
        || transcript.calls.some((call) => !call || typeof call.tool !== 'string' || typeof call.response?.ok !== 'boolean')
        || (Object.keys(transcript).sort().join(',') !== 'calls,dropped_calls'
          && !validRecoveryContext(transcript, saved.scenario.followups.length + 1))
        || evidence.captured_finals.length !== saved.scenario.followups.length + 1
        || evidence.captured_finals.some((final) => final?.completeness !== 'complete')) fail('insufficient_or_invalid_capture');
      const scenario = corpus.scenarios.find(({ scenario_id }) => scenario_id === trial.scenario_id);
      const materialized = materializeScenario(scenario, { workspace: saved.workspace });
      if (!same(materialized.digest, evidence.manifest.materialized_scenario)
        || !same(materialized.materializedScenario, saved.scenario)) fail('model_facing_scenario_changed');
      const observations = observationsFromEvidence(saved.scenario,
        { ...transcript, turn_safe_evidence_starts: projection.turn_safe_evidence_starts }, projection.safe_evidence,
        { actual_task_outcome: saved.observations.actual_task_outcome });
      const verdict = evaluateScenario(saved.scenario, { ...observations,
        captured_finals: evidence.captured_finals, transcript: evidence.transcript });
      if (verdict.failure_stage === 'inspection') fail('insufficient_or_invalid_capture');
      entry.eligibility = 'replayed'; entry.reason = null; entry.replay_verdict = verdict;
    } catch (error) { entry.reason = error.message; }
    trials.push(entry);
  }
  const result = { schema_version: 1, kind: 'diagnostic_replay', new_hosted_trials: 0,
    original_model: original.model, original_effort: original.effort,
    original_matrix: { path: resolve(input), ...digest(originalBytes) },
    replay_implementation: digest(await readFile(fileURLToPath(import.meta.url))), current_evaluator: current.digest,
    original_complete: original.complete !== false, original_counts: original.counts,
    trials, counts: { total: trials.length, replayed: trials.filter(({ eligibility }) => eligibility === 'replayed').length,
      fresh_hosted_required: trials.filter(({ eligibility }) => eligibility === 'fresh_hosted_required').length } };
  const encoded = JSON.stringify(result, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > EVAL_LIMITS.evidenceBytes * Math.max(1, trials.length)) fail('replay_output_limit');
  await writeFile(output, encoded, { flag: 'wx' });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('usage: replay-cursor-skill-eval.mjs <matrix.json> <new-output.json>');
  const result = await replayMatrix(process.argv[2], process.argv[3]);
  process.stdout.write(JSON.stringify(result.counts) + '\n');
}
