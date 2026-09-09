#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeAtomic } from './run-node-tests.mjs';

const METRICS = Object.freeze(['lines', 'branches', 'functions']);
const CLASSIFICATIONS = Object.freeze([
  'external_hosted_gate',
  'observable_contract_already_owned',
  'realistic_failure_already_owned',
  'unreachable_defensive',
]);
const AUDIT_KEYS = Object.freeze([
  'schema_version', 'status', 'source_digest', 'evidence', 'classification_counts', 'totals',
  'zero_counters', 'added', 'removed', 'unclassified', 'classifications',
]);
const digestPattern = /^[a-f0-9]{64}$/;

const fail = (message) => { throw new Error(message); };
const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const portable = (path) => path.replaceAll('\\', '/');
const inside = (candidate, parent) => {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const sameMembers = (left, right) => left.length === right.length
  && [...left].sort().every((value, index) => value === [...right].sort()[index]);
const identityKey = (entry) => JSON.stringify([
  entry.path, entry.source_sha256, entry.metric, entry.line, entry.occurrence,
]);
const identityOnly = (entry) => ({
  path: entry.path,
  source_sha256: entry.source_sha256,
  metric: entry.metric,
  line: entry.line,
  occurrence: entry.occurrence,
});

function validRelativeSource(path) {
  return typeof path === 'string' && path.length > 0 && portable(path) === path && !isAbsolute(path)
    && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}
function assertDigest(value, label) {
  if (!value || Object.keys(value).sort().join(',') !== 'bytes,sha256'
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !digestPattern.test(value.sha256 || '')) {
    fail(`invalid ${label} digest`);
  }
}
function assertIdentity(entry, sourceHashes, label) {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object'
    || !validRelativeSource(entry.path) || entry.source_sha256 !== sourceHashes.get(entry.path)
    || !METRICS.includes(entry.metric) || !Number.isSafeInteger(entry.line) || entry.line < 1
    || !Number.isSafeInteger(entry.occurrence) || entry.occurrence < 1) fail(`invalid ${label} identity`);
  const expectedKeys = ['path', 'source_sha256', 'metric', 'line', 'occurrence'].sort();
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)) fail(`invalid ${label} identity fields`);
}
function assertDecision(entry, sourceHashes, label) {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') fail(`invalid ${label}`);
  const identity = identityOnly(entry);
  assertIdentity(identity, sourceHashes, label);
  if (!CLASSIFICATIONS.includes(entry.classification) || typeof entry.disposition !== 'string' || !entry.disposition.trim()) {
    fail(`invalid ${label} decision`);
  }
  const expected = [...Object.keys(identity), 'classification', 'disposition'].sort();
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expected)) fail(`invalid ${label} decision fields`);
  return { ...identity, classification: entry.classification, disposition: entry.disposition };
}

export function validateCoverageResult(result) {
  const coverage = result?.coverage;
  if (result?.schema_version !== 1 || result.lane !== 'coverage' || result.verdict !== 'passed'
    || result.terminal_cause !== 'close_0' || result.child?.code !== 0 || result.child?.signal !== null
    || result.tests?.success !== true || !Number.isSafeInteger(result.tests?.counts?.tests)
    || result.tests.counts.tests < 1 || result.tests.counts.failed !== 0 || result.tests.counts.cancelled !== 0
    || !Number.isSafeInteger(result.tests.counts.passed) || !Number.isSafeInteger(result.tests.counts.skipped)
    || !Number.isSafeInteger(result.tests.counts.todo)
    || result.tests.counts.passed + result.tests.counts.skipped + result.tests.counts.todo !== result.tests.counts.tests
    || coverage?.enabled !== true || !Array.isArray(coverage.diagnostics) || coverage.diagnostics.length !== 0
    || !Array.isArray(coverage.manifest) || !coverage.manifest.length || !Array.isArray(coverage.reported)
    || !sameMembers(coverage.manifest, coverage.reported)) fail('coverage result is not a complete passing artifact');
  if (new Set(coverage.manifest).size !== coverage.manifest.length
    || coverage.manifest.some((path) => !validRelativeSource(path))) fail('invalid coverage manifest');
  const sources = coverage.sources;
  if (!sources || Object.keys(sources).sort().join(',') !== 'algorithm,digest,files,stable'
    || sources.algorithm !== 'sha256' || sources.stable !== true || !Array.isArray(sources.files)
    || sources.files.length !== coverage.manifest.length) fail('invalid stable source snapshot');
  const sortedFiles = [...sources.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (JSON.stringify(sortedFiles) !== JSON.stringify(sources.files)) fail('source snapshot files are not sorted');
  const seen = new Set();
  for (const file of sources.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,path,sha256'
      || !validRelativeSource(file.path) || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !digestPattern.test(file.sha256 || '')) {
      fail('invalid source snapshot file');
    }
    seen.add(file.path);
  }
  if (!sameMembers([...seen], coverage.manifest)) fail('source snapshot does not cover manifest');
  assertDigest(sources.digest, 'source snapshot');
  const serialized = JSON.stringify(sortedFiles);
  if (sources.digest.bytes !== Buffer.byteLength(serialized) || sources.digest.sha256 !== sha256(serialized)) {
    fail('source snapshot digest mismatch');
  }
  const artifactDigests = coverage.artifact_digests;
  if (!artifactDigests || Object.keys(artifactDigests).sort().join(',') !== 'failures,stderr,tap') {
    fail('invalid coverage artifact digests');
  }
  for (const name of ['failures', 'tap', 'stderr']) assertDigest(artifactDigests[name], `${name} artifact`);
  return { coverage, sources, sourceHashes: new Map(sources.files.map((file) => [file.path, file.sha256])) };
}

function normalizeZeroCounterReport(summary, sources) {
  if (!summary || !Array.isArray(summary.files) || summary.files.length !== sources.files.length) {
    fail('invalid raw coverage report');
  }
  const sourceHashes = new Map(sources.files.map((file) => [file.path, file.sha256]));
  const mapped = new Set();
  const counters = [];
  const legacyAmbiguousKeys = new Set();
  for (const file of summary.files) {
    if (!file || typeof file.path !== 'string' || !isAbsolute(file.path)) fail('coverage source path must be absolute');
    const normalized = portable(resolve(file.path));
    const matches = sources.files.map((source) => source.path)
      .filter((path) => normalized.endsWith(`/${path}`));
    if (matches.length !== 1 || mapped.has(matches[0])) fail('coverage source path is unknown, ambiguous or duplicated');
    const path = matches[0]; mapped.add(path);
    for (const metric of METRICS) {
      if (!Array.isArray(file[metric])) fail(`invalid ${metric} counters`);
      const occurrences = new Map();
      const groupSizes = new Map();
      for (const counter of file[metric]) {
        if (!counter || !Number.isSafeInteger(counter.line) || counter.line < 1
          || !Number.isSafeInteger(counter.count) || counter.count < 0
          || (metric === 'functions' && typeof counter.name !== 'string')) fail(`invalid ${metric} counter`);
        const groupKey = String(counter.line);
        groupSizes.set(groupKey, (groupSizes.get(groupKey) || 0) + 1);
      }
      for (const counter of file[metric]) {
        const occurrenceKey = String(counter.line);
        const occurrence = (occurrences.get(occurrenceKey) || 0) + 1;
        occurrences.set(occurrenceKey, occurrence);
        if (counter.count !== 0) continue;
        const identity = { path, source_sha256: sourceHashes.get(path), metric, line: counter.line, occurrence };
        counters.push(identity);
        if (groupSizes.get(occurrenceKey) > 1) legacyAmbiguousKeys.add(identityKey(identity));
      }
    }
  }
  if (mapped.size !== sources.files.length) fail('raw coverage report does not capture every source');
  counters.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    const metric = METRICS.indexOf(left.metric) - METRICS.indexOf(right.metric);
    return metric || left.line - right.line || left.occurrence - right.occurrence;
  });
  return { counters, legacyAmbiguousKeys };
}

export function normalizeZeroCounters(summary, sources) {
  return normalizeZeroCounterReport(summary, sources).counters;
}

function previousReview(value) {
  if (!value || value.schema_version !== 1 || !Array.isArray(value.classifications)) fail('invalid previous audit');
  let sourceHashes;
  let zeroCounters;
  if (Array.isArray(value.manifest?.source_digests)) {
    sourceHashes = previousSourceHashes(value.manifest.source_digests, false);
    zeroCounters = value.classifications.map(identityOnly);
  } else if (Array.isArray(value.source_digests) && Array.isArray(value.zero_counters)) {
    if (Object.keys(value).sort().join(',') !== 'classifications,provenance,schema_version,source_digests,zero_counters') {
      fail('invalid normalized previous audit fields');
    }
    assertDigest(value.provenance, 'previous provenance');
    sourceHashes = previousSourceHashes(value.source_digests, true);
    zeroCounters = value.zero_counters.map(identityOnly);
  } else if (Object.keys(value).sort().join(',') === [...AUDIT_KEYS].sort().join(',')
    && Array.isArray(value.zero_counters)) {
    sourceHashes = new Map();
    for (const entry of value.zero_counters) {
      if (!validRelativeSource(entry?.path) || !digestPattern.test(entry?.source_sha256 || '')) {
        fail('invalid previous source digest');
      }
      if (sourceHashes.has(entry.path) && sourceHashes.get(entry.path) !== entry.source_sha256) {
        fail('conflicting previous source digest');
      }
      sourceHashes.set(entry.path, entry.source_sha256);
    }
    zeroCounters = value.zero_counters.map(identityOnly);
  } else fail('unsupported previous audit schema');
  const decisions = new Map();
  for (const raw of value.classifications) {
    const pathHash = sourceHashes.get(raw.path);
    if (!digestPattern.test(pathHash || '')) fail('invalid previous source digest');
    const acceptedHashes = new Map([[raw.path, pathHash]]);
    const decision = assertDecision({ ...identityOnly(raw), source_sha256: pathHash,
      classification: raw.classification, disposition: raw.disposition }, acceptedHashes, 'previous');
    const key = identityKey(decision);
    if (decisions.has(key)) fail('duplicate previous classification');
    decisions.set(key, decision);
  }
  const identities = [];
  const identityKeys = new Set();
  for (const raw of zeroCounters) {
    const sourceHash = raw.source_sha256 || sourceHashes.get(raw.path);
    if (!digestPattern.test(sourceHash || '')) fail('invalid previous counter source digest');
    const identity = { ...raw, source_sha256: sourceHash };
    assertIdentity(identity, new Map([[identity.path, sourceHash]]), 'previous counter');
    const key = identityKey(identity);
    if (identityKeys.has(key)) fail('duplicate previous counter');
    identityKeys.add(key);
    identities.push(identity);
  }
  return { decisions, identities, sourceHashes,
    legacy: Array.isArray(value.manifest?.source_digests) };
}

function previousSourceHashes(entries, closed) {
  const sourceHashes = new Map();
  for (const entry of entries) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object'
      || (closed && Object.keys(entry).sort().join(',') !== 'path,sha256')
      || !validRelativeSource(entry.path) || !digestPattern.test(entry.sha256 || '')
      || sourceHashes.has(entry.path)) fail('invalid previous source digest');
    sourceHashes.set(entry.path, entry.sha256);
  }
  return sourceHashes;
}

function normalizedPreviousReview(value, rawContent) {
  const previous = previousReview(value);
  const preservedProvenance = Array.isArray(value?.source_digests)
    ? value.provenance
    : { bytes: rawContent.length, sha256: sha256(rawContent) };
  const sourceDigests = [...previous.sourceHashes].map(([path, sourceSha256]) => ({ path, sha256: sourceSha256 }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    schema_version: 1,
    source_digests: sourceDigests,
    zero_counters: previous.identities,
    classifications: [...previous.decisions.values()],
    provenance: preservedProvenance,
  };
}

function classificationSidecar(value, needed, sourceHashes) {
  if (!value || value.schema_version !== 1 || !Array.isArray(value.entries)
    || Object.keys(value).sort().join(',') !== 'entries,schema_version') fail('invalid classification sidecar');
  const decisions = new Map();
  for (const raw of value.entries) {
    const decision = assertDecision(raw, sourceHashes, 'sidecar');
    const key = identityKey(decision);
    if (decisions.has(key)) fail('duplicate sidecar classification');
    decisions.set(key, decision);
  }
  const neededKeys = new Set(needed.map(identityKey));
  if (decisions.size !== neededKeys.size || [...decisions].some(([key]) => !neededKeys.has(key))) {
    fail('classification sidecar contains stale, extra or missing decisions');
  }
  return decisions;
}

export function buildAudit({ result, rawCoverage, previous = null, sidecar = null, evidence }) {
  const { sources, sourceHashes } = validateCoverageResult(result);
  const normalized = normalizeZeroCounterReport(rawCoverage, sources);
  const zeroCounters = normalized.counters;
  const currentByKey = new Map(zeroCounters.map((entry) => [identityKey(entry), entry]));
  const prior = previous ? previousReview(previous) : { decisions: new Map(), identities: [], legacy: false };
  const reused = new Map([...prior.decisions].filter(([key, decision]) => currentByKey.has(key)
    && sourceHashes.get(decision.path) === decision.source_sha256
    && !(prior.legacy && normalized.legacyAmbiguousKeys.has(key))));
  const needed = zeroCounters.filter((entry) => !reused.has(identityKey(entry)));
  const supplied = sidecar ? classificationSidecar(sidecar, needed, sourceHashes) : new Map();
  const classifications = zeroCounters.flatMap((identity) => {
    const key = identityKey(identity);
    const decision = reused.get(key) || supplied.get(key);
    return decision ? [{ ...decision, source: reused.has(key) ? 'previous' : 'sidecar' }] : [];
  });
  const unclassified = needed.filter((entry) => !supplied.has(identityKey(entry)));
  const previousKeys = new Set(prior.identities.map(identityKey));
  const added = zeroCounters.filter((entry) => !previousKeys.has(identityKey(entry)));
  const removed = prior.identities.filter((entry) => !currentByKey.has(identityKey(entry)));
  const classificationCounts = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification,
    classifications.filter((entry) => entry.classification === classification).length]));
  return {
    zeroCounters: { schema_version: 1, source_digest: sources.digest, counters: zeroCounters },
    audit: {
      schema_version: 1,
      status: unclassified.length ? 'unclassified' : 'passed',
      source_digest: sources.digest,
      evidence,
      classification_counts: classificationCounts,
      totals: { zero_counters: zeroCounters.length, classified: classifications.length,
        unclassified: unclassified.length, added: added.length, removed: removed.length },
      zero_counters: zeroCounters,
      added,
      removed,
      unclassified,
      classifications,
    },
  };
}

export function verifyPublishedAudit({ audit, result, rawCoverage, previous = null }) {
  const { sources, sourceHashes } = validateCoverageResult(result);
  const expected = normalizeZeroCounters(rawCoverage, sources);
  if (!audit || Object.keys(audit).sort().join(',') !== [...AUDIT_KEYS].sort().join(',')
    || audit.schema_version !== 1 || !['passed', 'unclassified'].includes(audit.status)
    || JSON.stringify(audit.source_digest) !== JSON.stringify(sources.digest)
    || !audit.evidence || Array.isArray(audit.evidence) || typeof audit.evidence !== 'object'
    || !Array.isArray(audit.zero_counters) || JSON.stringify(audit.zero_counters) !== JSON.stringify(expected)
    || !Array.isArray(audit.added) || !Array.isArray(audit.removed) || !Array.isArray(audit.unclassified)
    || !Array.isArray(audit.classifications)) fail('published coverage audit does not match raw coverage');
  const totalKeys = ['added', 'classified', 'removed', 'unclassified', 'zero_counters'];
  if (!audit.totals || Object.keys(audit.totals).sort().join(',') !== totalKeys.sort().join(',')
    || !audit.classification_counts
    || Object.keys(audit.classification_counts).sort().join(',') !== [...CLASSIFICATIONS].sort().join(',')
    || [...Object.values(audit.totals), ...Object.values(audit.classification_counts)]
      .some((count) => !Number.isSafeInteger(count) || count < 0)) fail('invalid published coverage audit totals');
  const expectedKeys = new Set(expected.map(identityKey));
  const prior = previous ? previousReview(previous) : { identities: [] };
  const previousKeys = new Set(prior.identities.map(identityKey));
  const expectedAdded = expected.filter((entry) => !previousKeys.has(identityKey(entry)));
  const expectedRemoved = prior.identities.filter((entry) => !expectedKeys.has(identityKey(entry)));
  if (JSON.stringify(audit.added) !== JSON.stringify(expectedAdded)
    || JSON.stringify(audit.removed) !== JSON.stringify(expectedRemoved)) {
    fail('published coverage audit delta does not match previous review');
  }
  const decisionKeys = new Set();
  for (const raw of audit.classifications) {
    if (!['previous', 'sidecar'].includes(raw?.source)) fail('invalid published coverage classification source');
    const { source, ...entry } = raw;
    const decision = assertDecision(entry, sourceHashes, 'published');
    const key = identityKey(decision);
    if (!expectedKeys.has(key) || decisionKeys.has(key)) fail('published classifications do not match zero counters');
    decisionKeys.add(key);
  }
  const expectedUnclassified = expected.filter((entry) => !decisionKeys.has(identityKey(entry)));
  if (JSON.stringify(audit.unclassified) !== JSON.stringify(expectedUnclassified)
    || audit.status !== (expectedUnclassified.length ? 'unclassified' : 'passed')) {
    fail('published unclassified counters do not match decisions');
  }
  for (const entry of audit.added) assertIdentity(entry, new Map([[entry?.path, entry?.source_sha256]]), 'published added');
  for (const entry of audit.removed) assertIdentity(entry, new Map([[entry?.path, entry?.source_sha256]]), 'published removed');
  const classificationCounts = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification,
    audit.classifications.filter((entry) => entry.classification === classification).length]));
  if (JSON.stringify(audit.classification_counts) !== JSON.stringify(classificationCounts)
    || audit.totals.zero_counters !== expected.length || audit.totals.classified !== decisionKeys.size
    || audit.totals.unclassified !== expectedUnclassified.length || audit.totals.added !== audit.added.length
    || audit.totals.removed !== audit.removed.length) fail('published coverage audit totals do not match evidence');
  return audit;
}

async function readRegular(path, label, { parseJson = true } = {}) {
  const absolute = resolve(path);
  let metadata;
  try { metadata = await lstat(absolute); } catch { fail(`${label} is missing`); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`);
  const content = await readFile(absolute);
  return { absolute, content, ...(parseJson ? { json: JSON.parse(content.toString('utf8')) } : {}) };
}
function strictArtifactRef(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || portable(value) !== value
    || basename(value) !== value) fail(`invalid ${label} artifact reference`);
  return value;
}
function evidenceRecord(path, content, outputDir) {
  return { path: portable(relative(outputDir, path)),
    bytes: content.length, sha256: sha256(content) };
}
async function preflightSnapshots(snapshots, outputDir) {
  const destinations = new Set();
  for (const snapshot of snapshots) {
    if (!inside(snapshot.destination, outputDir) || destinations.has(snapshot.destination)) fail('snapshot destination collision');
    destinations.add(snapshot.destination);
    if (snapshot.source && snapshot.source === snapshot.destination) { snapshot.skip = true; continue; }
    try {
      const metadata = await lstat(snapshot.destination);
      if (!metadata.isFile() || metadata.isSymbolicLink()) fail('snapshot destination is not a regular file');
      if (!Buffer.from(await readFile(snapshot.destination)).equals(snapshot.content)) fail('snapshot destination already has different content');
      snapshot.skip = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
async function publishSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.skip) continue;
    await mkdir(dirname(snapshot.destination), { recursive: true });
    await writeAtomic(snapshot.destination, snapshot.content);
  }
}

async function validateOutputDirectory(destination) {
  const parent = dirname(destination);
  let parentMetadata;
  try { parentMetadata = await lstat(parent); } catch { fail('output parent is missing'); }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) fail('output parent must be a real directory');
  const canonicalDestination = resolve(await realpath(parent), basename(destination));
  try {
    const metadata = await lstat(destination);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || await realpath(destination) !== canonicalDestination) fail('output directory must be a real directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return canonicalDestination;
}

export async function auditCoverage({ coverageResultPath, outputDir, previousPath = null, classificationsPath = null }) {
  const resultFile = await readRegular(coverageResultPath, 'coverage result');
  validateCoverageResult(resultFile.json);
  const artifactRoot = dirname(resultFile.absolute);
  const artifactRefs = resultFile.json.artifacts;
  if (!artifactRefs || Object.keys(artifactRefs).sort().join(',') !== 'failures,result,stderr,tap') {
    fail('invalid supervisor artifact references');
  }
  const artifacts = {};
  const canonicalArtifactRoot = await realpath(artifactRoot);
  for (const key of ['result', 'failures', 'tap', 'stderr']) {
    const ref = strictArtifactRef(artifactRefs[key], key);
    const path = resolve(artifactRoot, ref);
    if (!inside(path, artifactRoot)) fail(`${key} artifact escapes coverage artifact root`);
    if (key === 'result' && path !== resultFile.absolute) fail('result artifact reference does not name the supplied result');
    const file = key === 'result' ? resultFile : await readRegular(path, `${key} artifact`, { parseJson: false });
    if (!inside(await realpath(file.absolute), canonicalArtifactRoot)) fail(`${key} artifact escapes coverage artifact root`);
    artifacts[key] = { ...file, ref };
  }
  for (const key of ['failures', 'tap', 'stderr']) {
    const expected = resultFile.json.coverage.artifact_digests[key];
    if (artifacts[key].content.length !== expected.bytes || sha256(artifacts[key].content) !== expected.sha256) {
      fail(`${key} artifact digest mismatch`);
    }
  }
  const failuresFile = artifacts.failures;
  const events = failuresFile.content.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const rawCoverage = events.filter((event) => event?.type === 'test:coverage').at(-1)?.data?.summary;
  if (!rawCoverage) fail('last test:coverage event is missing');
  const previousFile = previousPath ? await readRegular(previousPath, 'previous audit') : null;
  const sidecarFile = classificationsPath ? await readRegular(classificationsPath, 'classification sidecar') : null;
  const destination = await validateOutputDirectory(resolve(outputDir));
  const normalizedPrevious = previousFile
    ? Buffer.from(`${JSON.stringify(normalizedPreviousReview(previousFile.json, previousFile.content), null, 2)}\n`)
    : null;
  const snapshots = Object.values(artifacts).map((file) => ({ source: file.absolute,
    destination: resolve(destination, file.ref), content: file.content }));
  if (normalizedPrevious) snapshots.push({ source: null, destination: resolve(destination, 'previous-review.json'), content: normalizedPrevious });
  if (sidecarFile) snapshots.push({ source: sidecarFile.absolute, destination: resolve(destination, 'classifications.json'), content: sidecarFile.content });
  for (const reserved of ['zero-counters.json', 'zero-counter-audit.json']) {
    if (snapshots.some(({ destination: path }) => path === resolve(destination, reserved))) fail('snapshot collides with audit output');
  }
  await preflightSnapshots(snapshots, destination);
  const evidence = {
    coverage_result: evidenceRecord(resolve(destination, artifacts.result.ref), artifacts.result.content, destination),
    failures: evidenceRecord(resolve(destination, artifacts.failures.ref), artifacts.failures.content, destination),
    tap: evidenceRecord(resolve(destination, artifacts.tap.ref), artifacts.tap.content, destination),
    stderr: evidenceRecord(resolve(destination, artifacts.stderr.ref), artifacts.stderr.content, destination),
    ...(normalizedPrevious ? { previous: evidenceRecord(resolve(destination, 'previous-review.json'), normalizedPrevious, destination) } : {}),
    ...(sidecarFile ? { classifications: evidenceRecord(resolve(destination, 'classifications.json'), sidecarFile.content, destination) } : {}),
  };
  const built = buildAudit({ result: resultFile.json, rawCoverage, previous: previousFile?.json,
    sidecar: sidecarFile?.json, evidence });
  await mkdir(destination, { recursive: true });
  await publishSnapshots(snapshots);
  await writeAtomic(resolve(destination, 'zero-counters.json'), `${JSON.stringify(built.zeroCounters, null, 2)}\n`);
  await writeAtomic(resolve(destination, 'zero-counter-audit.json'), `${JSON.stringify(built.audit, null, 2)}\n`);
  return built.audit;
}

export function parseAuditArgs(argv) {
  const usage = 'usage: audit-node-coverage.mjs <coverage-result.json> <output-dir> [--previous <audit.json>] [--classifications <sidecar.json>]';
  if (argv.length < 2) fail(usage);
  const [coverageResultPath, outputDir, ...rest] = argv;
  let previousPath = null; let classificationsPath = null;
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index]; const value = rest[index + 1];
    if (!value || !['--previous', '--classifications'].includes(option)) fail(usage);
    if (option === '--previous') { if (previousPath) fail(usage); previousPath = value; }
    else { if (classificationsPath) fail(usage); classificationsPath = value; }
  }
  return { coverageResultPath, outputDir, previousPath, classificationsPath };
}

export async function cli({ argv = process.argv.slice(2), processLike = process } = {}) {
  try {
    const audit = await auditCoverage(parseAuditArgs(argv));
    const stream = audit.status === 'passed' ? processLike.stdout : processLike.stderr;
    stream.write(`${audit.status}: ${audit.totals.unclassified} unclassified zero counters\n`);
    return audit.status === 'passed' ? 0 : 1;
  } catch (error) {
    processLike.stderr.write(`coverage audit failed: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await cli();
