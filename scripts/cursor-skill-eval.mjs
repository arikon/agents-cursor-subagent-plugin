#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVAL_LIMITS = Object.freeze({ stdoutBytes: 16_384, evidenceBytes: 1_048_576, fieldBytes: 128, evidenceRefBytes: 4_096, messageBytes: 8_000 });

// One inventory for the executable eval candidate. Installed payload validation
// remains package-owned; these source digests bind each child to its evaluator.
const EVALUATOR_INPUTS = Object.freeze([
  '.codex-plugin/plugin.json', 'README.md',
  'scripts/codex-app-server-client.mjs', 'scripts/cursor-eval-scenario.mjs',
  'scripts/cursor-skill-eval.mjs', 'scripts/cursor-subagent-bootstrap.mjs',
  'scripts/cursor-subagent-mcp.mjs', 'scripts/cursor-model-adapter.mjs', 'scripts/eval/run-cursor-skill-eval-matrix.mjs',
  'scripts/node-test-reporter-v22.mjs', 'scripts/recording-mcp-proxy.mjs',
  'scripts/run-cursor-skill-eval.mjs', 'scripts/run-node-tests.mjs',
  'skills/cursor-subagent/SKILL.md', 'skills/cursor-subagent/agents/openai.yaml',
  'tests/codex-client-integration.test.mjs', 'tests/codex-client-oracle-support.mjs', 'tests/release-e2e.test.mjs', 'tests/release-e2e-oracle-support.mjs', 'tests/fixtures/accelerate-turn-timeout.mjs',
  'tests/fixtures/codex-app-server-v01534.golden.json',
  'tests/fixtures/codex-app-server-v01521.golden.json', 'tests/fixtures/node-test-reporter-v22.23.1.golden.json',
  'tests/fixtures/codex-v01521-adapter.mjs', 'tests/fixtures/codex-v01521-adapter.golden.json',
  'tests/fixtures/codex-v01534-adapter.mjs', 'tests/fixtures/codex-v01534-adapter.golden.json',
  'tests/fixtures/cursor-agent-v20260825.golden.json', 'tests/fixtures/fake-acp.mjs',
  'tests/fixtures/fake-ollama-responses.mjs', 'tests/fixtures/fake-codex-adapter.mjs', 'tests/fixtures/fake-codex-adapter-core.mjs', 'tests/fixtures/fake-mcp-version.mjs',
  'tests/fixtures/release-fake-acp.mjs',
  'tests/fixtures/release-generation-acp.mjs',
  'tests/fixtures/release-model-discovery-preload.mjs', 'tests/fixtures/cursor-eval-model-catalog.json',
  'tests/fixtures/cursor-model-catalog-1.0.31.json', 'tests/fixtures/fake-codex-cli-v01521.mjs',
].sort());
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
export async function readEvaluatorInventory(root = sourceRoot, load = readFile, runner = process.env.CURSOR_EVAL_MATRIX_RUNNER) {
  const selectedRunner = relative(root, runner ? resolve(root, runner) : resolve(root, 'scripts/run-cursor-skill-eval.mjs'));
  if (!selectedRunner || selectedRunner.startsWith('..') || isAbsolute(selectedRunner)) throw new Error('eval runner must be a repository-relative input');
  const paths = [...new Set([...EVALUATOR_INPUTS, selectedRunner])].sort();
  const files = await Promise.all(paths.map(async (path) => {
    const content = Buffer.from(await load(resolve(root, path)));
    return { path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  }));
  const encoded = Buffer.from(JSON.stringify({ files, selected_runner: selectedRunner }));
  return { files, selected_runner: selectedRunner, digest: { bytes: encoded.length, sha256: createHash('sha256').update(encoded).digest('hex') } };
}
const STATUSES = new Set(['pass', 'skipped', 'integration_failure', 'agent_behavior_mismatch']);
const LANES = new Set(['client-integration', 'model-behavior', 'full-live']);
const ACTUAL = new Set(['succeeded', 'failed', 'not_observed']); const REPORTED = new Set(['not_checked']);
const ASSERTION = new Set(['pass', 'fail', 'not_observed']); const PUBLICATION = new Set(['published', 'failed', 'not_attempted']);
const CLEANUP = new Set(['succeeded', 'failed', 'not_required']);
const STAGES = new Set([null, 'runner', 'adapter_admission', 'discovery', 'skill_load', 'transport', 'scenario', 'inspection', 'publication', 'cleanup']);
const KEYS = ['schema_version', 'scenario_id', 'lane', 'eval_status', 'actual_task_outcome', 'reported_task_outcome', 'fixture_assertion_outcome', 'evidence_publication_status', 'evidence_ref', 'cleanup_status', 'failure_stage', 'error_code', 'message'];
const EVIDENCE_MANIFEST_KEYS = ['schema_version', 'hash_algorithm', 'hash_encoding', 'installed_skill', 'corpus', 'materialized_scenario', 'adapter', 'evaluator', 'installed_payload', 'client', 'model'];
const bytes = (value) => Buffer.byteLength(value, 'utf8');

function text(value, name, limit, nullable = false) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || (value.isWellFormed && !value.isWellFormed()) || bytes(value) > limit) throw new Error(`invalid EvalResultV1 ${name}`);
}

function exactObject(value, keys) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function evidenceText(value, nullable = false) {
  return (value === null && nullable) || (typeof value === 'string' && value.length > 0
    && (!value.isWellFormed || value.isWellFormed()) && bytes(value) <= 256);
}

function evidenceDigest(value) {
  return exactObject(value, ['bytes', 'sha256']) && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= EVAL_LIMITS.evidenceBytes;
}

export function assertEvidenceManifestV1(manifest) {
  const payload = manifest?.installed_payload;
  const client = manifest?.client;
  const model = manifest?.model;
  if (!exactObject(manifest, EVIDENCE_MANIFEST_KEYS)
    || manifest.schema_version !== 1 || manifest.hash_algorithm !== 'sha256' || manifest.hash_encoding !== 'lowercase-hex'
    || !['installed_skill', 'corpus', 'materialized_scenario', 'adapter', 'evaluator'].every((key) => evidenceDigest(manifest[key]))
    || !exactObject(payload, ['artifact_hash', 'manifest_version', 'marker_format', 'payload_hash'])
    || payload.marker_format !== 1 || !/^[a-f0-9]{64}$/.test(payload.payload_hash) || !/^[a-f0-9]{64}$/.test(payload.artifact_hash)
    || !evidenceText(payload.manifest_version)
    || !exactObject(client, ['name', 'version']) || !evidenceText(client.name) || !evidenceText(client.version)
    || !exactObject(model, ['name', 'provider']) || !evidenceText(model.name, true) || !evidenceText(model.provider, true)) {
    throw new Error('EvidenceManifestV1 has an invalid contract');
  }
  return manifest;
}

export function assertEvalResultV1(result) {
  if (!result || Array.isArray(result) || typeof result !== 'object' || Object.keys(result).sort().join('\0') !== [...KEYS].sort().join('\0')) throw new Error('EvalResultV1 has unexpected properties');
  if (result.schema_version !== 1 || !LANES.has(result.lane) || !STATUSES.has(result.eval_status) || !ACTUAL.has(result.actual_task_outcome) || !REPORTED.has(result.reported_task_outcome) || !ASSERTION.has(result.fixture_assertion_outcome) || !PUBLICATION.has(result.evidence_publication_status) || !CLEANUP.has(result.cleanup_status) || !STAGES.has(result.failure_stage)) throw new Error('EvalResultV1 has invalid enum value');
  text(result.scenario_id, 'scenario_id', EVAL_LIMITS.fieldBytes); text(result.lane, 'lane', EVAL_LIMITS.fieldBytes);
  text(result.error_code, 'error_code', EVAL_LIMITS.fieldBytes, true); text(result.message, 'message', EVAL_LIMITS.messageBytes, true); text(result.evidence_ref, 'evidence_ref', EVAL_LIMITS.evidenceRefBytes, true);
  if ((result.evidence_publication_status === 'published') !== (result.evidence_ref !== null)) throw new Error('EvalResultV1 evidence_ref does not match publication status');
  if (result.eval_status === 'skipped' && (result.actual_task_outcome !== 'not_observed' || result.reported_task_outcome !== 'not_checked' || result.failure_stage !== null)) throw new Error('skipped EvalResultV1 must be pre-run');
  if (result.eval_status === 'pass' && (result.cleanup_status !== 'succeeded' || result.fixture_assertion_outcome !== 'pass' || result.failure_stage !== null)) throw new Error('passing EvalResultV1 requires complete evidence and cleanup');
  if (result.eval_status === 'integration_failure' && result.failure_stage === null) throw new Error('integration_failure requires failure_stage');
  if (bytes(JSON.stringify(result)) + 1 > EVAL_LIMITS.stdoutBytes) throw new Error('EvalResultV1 exceeds serialized stdout limit');
  return result;
}

export function evalResult(input) { return assertEvalResultV1({ schema_version: 1, error_code: null, message: null, evidence_ref: null, ...input }); }

export function writeEvalResult(result, output = process.stdout) {
  const encoded = JSON.stringify(assertEvalResultV1(result));
  output.write(`${encoded}\n`);
}

export function classifyEval({ enabled, integrationFailure = null, behaviorMatches = false }) {
  if (!enabled) return 'skipped';
  if (integrationFailure) return 'integration_failure';
  return behaviorMatches ? 'pass' : 'agent_behavior_mismatch';
}

export function classifyScenario({ enabled, integrationFailure = null, expectedActual, actual }) {
  return classifyEval({ enabled, integrationFailure, behaviorMatches: expectedActual === actual });
}

function contained(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && path !== '..' && !isAbsolute(path));
}

export async function publishEvidence({ evidenceRoot, fixtureRoot, evidence }) {
  const destination = resolve(evidenceRoot); const fixture = resolve(fixtureRoot);
  if (contained(destination, fixture)) throw new Error('evidence root must be outside fixture root');
  const encoded = JSON.stringify(evidence);
  if (bytes(encoded) > EVAL_LIMITS.evidenceBytes) throw new Error('evidence exceeds output limit');
  await mkdir(destination, { recursive: true });
  const finalPath = resolve(destination, `${randomUUID()}.json`); const temporaryPath = `${finalPath}.tmp`;
  await writeFile(temporaryPath, encoded, { encoding: 'utf8', flag: 'wx' }); await rename(temporaryPath, finalPath);
  return finalPath;
}
