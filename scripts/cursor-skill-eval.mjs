#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const EVAL_LIMITS = Object.freeze({ stdoutBytes: 16_384, evidenceBytes: 1_048_576, fieldBytes: 128, evidenceRefBytes: 4_096, messageBytes: 8_000 });
const STATUSES = new Set(['pass', 'skipped', 'integration_failure', 'agent_behavior_mismatch']);
const LANES = new Set(['client-integration', 'model-behavior', 'full-live']);
const ACTUAL = new Set(['succeeded', 'failed', 'not_observed']); const REPORTED = new Set(['succeeded', 'failed', 'not_reported']);
const ASSERTION = new Set(['pass', 'fail', 'not_observed']); const PUBLICATION = new Set(['published', 'failed', 'not_attempted']);
const CLEANUP = new Set(['succeeded', 'failed', 'not_required']);
const STAGES = new Set([null, 'runner', 'adapter_admission', 'discovery', 'skill_load', 'transport', 'scenario', 'inspection', 'publication', 'cleanup']);
const KEYS = ['schema_version', 'scenario_id', 'lane', 'eval_status', 'actual_task_outcome', 'reported_task_outcome', 'fixture_assertion_outcome', 'evidence_publication_status', 'evidence_ref', 'cleanup_status', 'failure_stage', 'error_code', 'message'];
const bytes = (value) => Buffer.byteLength(value, 'utf8');

function text(value, name, limit, nullable = false) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || bytes(value) > limit) throw new Error(`invalid EvalResultV1 ${name}`);
}

export function assertEvalResultV1(result) {
  if (!result || Array.isArray(result) || typeof result !== 'object' || Object.keys(result).sort().join('\0') !== [...KEYS].sort().join('\0')) throw new Error('EvalResultV1 has unexpected properties');
  if (result.schema_version !== 1 || !LANES.has(result.lane) || !STATUSES.has(result.eval_status) || !ACTUAL.has(result.actual_task_outcome) || !REPORTED.has(result.reported_task_outcome) || !ASSERTION.has(result.fixture_assertion_outcome) || !PUBLICATION.has(result.evidence_publication_status) || !CLEANUP.has(result.cleanup_status) || !STAGES.has(result.failure_stage)) throw new Error('EvalResultV1 has invalid enum value');
  text(result.scenario_id, 'scenario_id', EVAL_LIMITS.fieldBytes); text(result.lane, 'lane', EVAL_LIMITS.fieldBytes);
  text(result.error_code, 'error_code', EVAL_LIMITS.fieldBytes, true); text(result.message, 'message', EVAL_LIMITS.messageBytes, true); text(result.evidence_ref, 'evidence_ref', EVAL_LIMITS.evidenceRefBytes, true);
  if ((result.evidence_publication_status === 'published') !== (result.evidence_ref !== null)) throw new Error('EvalResultV1 evidence_ref does not match publication status');
  if (result.eval_status === 'skipped' && (result.actual_task_outcome !== 'not_observed' || result.reported_task_outcome !== 'not_reported' || result.failure_stage !== null)) throw new Error('skipped EvalResultV1 must be pre-run');
  if (result.eval_status === 'pass' && (result.cleanup_status !== 'succeeded' || result.fixture_assertion_outcome !== 'pass' || result.failure_stage !== null)) throw new Error('passing EvalResultV1 requires complete evidence and cleanup');
  if (result.eval_status === 'integration_failure' && result.failure_stage === null) throw new Error('integration_failure requires failure_stage');
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

export function classifyScenario({ enabled, integrationFailure = null, expectedActual, actual, expectedReported, reported }) {
  return classifyEval({ enabled, integrationFailure, behaviorMatches: expectedActual === actual && expectedReported === reported });
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
