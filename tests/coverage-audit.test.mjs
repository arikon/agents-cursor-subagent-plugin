import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCoverage, buildAudit, verifyPublishedAudit } from '../scripts/audit-node-coverage.mjs';

const script = new URL('../scripts/audit-node-coverage.mjs', import.meta.url);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sourceFile = (path, content) => ({ path, bytes: Buffer.byteLength(content), sha256: digest(content) });
const sourceSnapshot = (files) => {
  const sorted = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const serialized = JSON.stringify(sorted);
  return { algorithm: 'sha256', files: sorted,
    digest: { bytes: Buffer.byteLength(serialized), sha256: digest(serialized) }, stable: true };
};
const rawFile = (path, { lines = [], branches = [], functions = [] } = {}) => ({
  path: `/checkout/${path}`, lines, branches, functions,
});
const decision = (identity, classification = 'observable_contract_already_owned') => ({
  ...identity, classification, disposition: `reviewed ${identity.metric} behavior`,
});
const normalizedPrevious = (sources, zeroCounters, classifications) => ({
  schema_version: 1,
  source_digests: sources.files.map(({ path, sha256 }) => ({ path, sha256 })),
  zero_counters: zeroCounters,
  classifications,
  provenance: { bytes: 0, sha256: digest('') },
});
const tapContent = '1..1\n# pass 1\n';
const stderrContent = '';

function passingResult(sources) {
  const manifest = sources.files.map(({ path }) => path);
  return {
    schema_version: 1, lane: 'coverage', verdict: 'passed', terminal_cause: 'close_0',
    child: { code: 0, signal: null },
    tests: { success: true, counts: { tests: 3, passed: 2, failed: 0, cancelled: 0, skipped: 1, todo: 0 } },
    coverage: { enabled: true, manifest, reported: [...manifest].reverse(), diagnostics: [], sources,
      artifact_digests: Object.fromEntries(['failures', 'tap', 'stderr'].map((name) => [name,
        { bytes: 0, sha256: digest('') }])) },
    artifacts: { failures: 'failures.jsonl', result: 'result.json', stderr: 'stderr.txt', tap: 'tap.txt' },
  };
}

async function artifactFixture(t, { rawCoverage, sources, mutateResult, events, previous, sidecar } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'coverage-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'current'); const output = join(root, 'output');
  await mkdir(artifact, { recursive: true });
  const snapshot = sources || sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha')]);
  const result = passingResult(snapshot);
  const resultPath = join(artifact, 'result.json'); const failuresPath = join(artifact, 'failures.jsonl');
  const tapPath = join(artifact, 'tap.txt'); const stderrPath = join(artifact, 'stderr.txt');
  const failuresContent = events === null ? null : `${(events || [
    { type: 'test:coverage', data: { summary: rawCoverage || { files: [rawFile('scripts/a.mjs')] } } },
  ]).map(JSON.stringify).join('\n')}\n`;
  result.coverage.artifact_digests = {
    failures: { bytes: Buffer.byteLength(failuresContent || ''), sha256: digest(failuresContent || '') },
    tap: { bytes: Buffer.byteLength(tapContent), sha256: digest(tapContent) },
    stderr: { bytes: Buffer.byteLength(stderrContent), sha256: digest(stderrContent) },
  };
  mutateResult?.(result);
  await writeFile(resultPath, JSON.stringify(result));
  await writeFile(tapPath, tapContent);
  await writeFile(stderrPath, stderrContent);
  if (failuresContent !== null) await writeFile(failuresPath, failuresContent);
  let previousPath = null; let sidecarPath = null;
  if (previous) {
    previousPath = join(root, 'previous', 'zero-counter-audit.json');
    await mkdir(join(root, 'previous'), { recursive: true });
    await writeFile(previousPath, JSON.stringify(previous));
  }
  if (sidecar) {
    sidecarPath = join(root, 'review', 'classifications.json');
    await mkdir(join(root, 'review'), { recursive: true });
    await writeFile(sidecarPath, JSON.stringify(sidecar));
  }
  return { root, artifact, output, snapshot, result, resultPath, failuresPath, tapPath, stderrPath,
    previousPath, sidecarPath };
}

async function assertNoAuditPublished(output) {
  await assert.rejects(readFile(join(output, 'zero-counter-audit.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(output, 'zero-counters.json')), { code: 'ENOENT' });
}

test('coverage audit reuses exact reviewed identities and classifies every new ordered zero counter', async (t) => {
  const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha'), sourceFile('scripts/b.mjs', 'beta')]);
  const aHash = sources.files[0].sha256;
  const rawCoverage = { files: [
    rawFile('scripts/a.mjs', {
      lines: [{ line: 3, count: 0 }],
      branches: [{ line: 8, count: 0 }, { line: 7, count: 0 }, { line: 7, count: 0 }],
      functions: [{ line: 9, count: 0, name: 'work' }, { line: 9, count: 0, name: 'renamed' }],
    }),
    rawFile('scripts/b.mjs'),
  ] };
  const identities = [
    { path: 'scripts/a.mjs', source_sha256: aHash, metric: 'lines', line: 3, occurrence: 1 },
    { path: 'scripts/a.mjs', source_sha256: aHash, metric: 'branches', line: 7, occurrence: 1 },
    { path: 'scripts/a.mjs', source_sha256: aHash, metric: 'branches', line: 7, occurrence: 2 },
    { path: 'scripts/a.mjs', source_sha256: aHash, metric: 'branches', line: 8, occurrence: 1 },
    { path: 'scripts/a.mjs', source_sha256: aHash, metric: 'functions', line: 9, occurrence: 1 },
    { path: 'scripts/a.mjs', source_sha256: aHash, metric: 'functions', line: 9, occurrence: 2 },
  ];
  const previous = { schema_version: 1, manifest: { source_digests: [...sources.files].reverse() },
    classifications: [decision(identities[0])] };
  const sidecar = { schema_version: 1, entries: identities.slice(1).map((identity, index) =>
    decision(identity, index === 4 ? 'realistic_failure_already_owned' : 'unreachable_defensive')) };
  const result = passingResult(sources);
  const built = buildAudit({ result, rawCoverage, previous, sidecar,
    evidence: { coverage_result: { path: 'result.json', bytes: 1, sha256: 'a'.repeat(64) },
      failures: { path: 'failures.jsonl', bytes: 1, sha256: 'b'.repeat(64) } } });
  assert.equal(built.audit.status, 'passed');
  assert.deepEqual(built.zeroCounters.counters, identities);
  assert.deepEqual(built.audit.classifications.map(({ source }) => source),
    ['previous', 'sidecar', 'sidecar', 'sidecar', 'sidecar', 'sidecar']);
  assert.deepEqual(built.audit.classification_counts, {
    external_hosted_gate: 0, observable_contract_already_owned: 1,
    realistic_failure_already_owned: 1, unreachable_defensive: 4,
  });
  assert.deepEqual(built.audit.unclassified, []);

  const fixture = await artifactFixture(t, {
    sources, rawCoverage,
    events: [
      { type: 'test:coverage', data: { summary: { files: [rawFile('scripts/a.mjs', { lines: [{ line: 99, count: 0 }] }), rawFile('scripts/b.mjs')] } } },
      { type: 'test:coverage', data: { summary: rawCoverage } },
    ],
    previous,
    sidecar,
  });
  const first = await auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
    previousPath: fixture.previousPath, classificationsPath: fixture.sidecarPath });
  const firstAudit = await readFile(join(fixture.output, 'zero-counter-audit.json'), 'utf8');
  const firstQueue = await readFile(join(fixture.output, 'zero-counters.json'), 'utf8');
  const second = await auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
    previousPath: fixture.previousPath, classificationsPath: fixture.sidecarPath });
  assert.equal(first.status, 'passed'); assert.deepEqual(second, first);
  assert.equal(await readFile(join(fixture.output, 'zero-counter-audit.json'), 'utf8'), firstAudit);
  assert.equal(await readFile(join(fixture.output, 'zero-counters.json'), 'utf8'), firstQueue);
  assert.equal(first.evidence.coverage_result.sha256, digest(await readFile(fixture.resultPath)));
  assert.equal(first.evidence.failures.sha256, digest(await readFile(fixture.failuresPath)));
  assert.equal(first.evidence.tap.sha256, digest(await readFile(fixture.tapPath)));
  assert.equal(first.evidence.stderr.sha256, digest(await readFile(fixture.stderrPath)));
  assert.equal(first.evidence.previous.sha256, digest(await readFile(join(fixture.output, 'previous-review.json'))));
  assert.equal(first.evidence.classifications.sha256, digest(await readFile(fixture.sidecarPath)));
  assert.deepEqual(Object.fromEntries(Object.entries(first.evidence).map(([key, value]) => [key, value.path])), {
    coverage_result: 'result.json', failures: 'failures.jsonl', tap: 'tap.txt', stderr: 'stderr.txt',
    previous: 'previous-review.json', classifications: 'classifications.json',
  });

  const moved = join(fixture.root, 'moved-bundle');
  await cp(fixture.output, moved, { recursive: true });
  await rm(fixture.artifact, { recursive: true });
  await rm(join(fixture.root, 'previous'), { recursive: true });
  await rm(join(fixture.root, 'review'), { recursive: true });
  await rm(fixture.output, { recursive: true });
  const reauditOutput = join(fixture.root, 'reaudit');
  const movedAudit = await auditCoverage({ coverageResultPath: join(moved, 'result.json'), outputDir: reauditOutput,
    previousPath: join(moved, 'previous-review.json'), classificationsPath: join(moved, 'classifications.json') });
  assert.equal(movedAudit.status, 'passed');
  assert.deepEqual(movedAudit.totals, first.totals);
  const bundledPrevious = JSON.parse(await readFile(join(moved, 'previous-review.json'), 'utf8'));
  assert.equal(verifyPublishedAudit({ audit: movedAudit, result,
    rawCoverage, previous: bundledPrevious }), movedAudit);
  const tamperedDelta = structuredClone(movedAudit);
  tamperedDelta.added = [];
  tamperedDelta.totals.added = 0;
  assert.throws(() => verifyPublishedAudit({ audit: tamperedDelta, result,
    rawCoverage, previous: bundledPrevious }), /delta does not match previous review/);
  for (const mutate of [
    (audit) => { audit.totals.classified = -1; },
    (audit) => { audit.classifications[0].source = 'invented'; },
    (audit) => { audit.classifications.push(structuredClone(audit.classifications[0])); },
  ]) {
    const malformed = structuredClone(movedAudit);
    mutate(malformed);
    assert.throws(() => verifyPublishedAudit({ audit: malformed, result,
      rawCoverage, previous: bundledPrevious }));
  }

  const withoutPrevious = buildAudit({ result, rawCoverage, evidence: {} }).audit;
  assert.equal(verifyPublishedAudit({ audit: withoutPrevious, result, rawCoverage }), withoutPrevious);
  assert.deepEqual(withoutPrevious.added, identities);
  assert.deepEqual(withoutPrevious.removed, []);

  const reusedOwnAudit = buildAudit({ result, rawCoverage, previous: first, evidence: {} });
  assert.equal(reusedOwnAudit.audit.status, 'passed');
  assert.deepEqual(reusedOwnAudit.audit.classifications.map(({ source }) => source), identities.map(() => 'previous'));
});

test('coverage audit invalidates previous classifications when the source hash changes', () => {
  const current = sourceSnapshot([sourceFile('scripts/a.mjs', 'new')]);
  const old = sourceSnapshot([sourceFile('scripts/a.mjs', 'old')]);
  const previousIdentity = { path: 'scripts/a.mjs', source_sha256: old.files[0].sha256,
    metric: 'branches', line: 4, occurrence: 1 };
  const currentIdentity = { ...previousIdentity, source_sha256: current.files[0].sha256 };
  const result = passingResult(current);
  const rawCoverage = { files: [rawFile('scripts/a.mjs', { branches: [{ line: 4, count: 0 }] })] };
  const previous = normalizedPrevious(old, [previousIdentity], [decision(previousIdentity)]);
  const built = buildAudit({ result,
    rawCoverage,
    previous,
    evidence: {},
  });
  assert.equal(built.audit.status, 'unclassified');
  assert.deepEqual(built.audit.unclassified, [currentIdentity]);
  assert.deepEqual(built.audit.added, [currentIdentity]);
  assert.deepEqual(built.audit.removed, [previousIdentity]);
  assert.equal(verifyPublishedAudit({ audit: built.audit, result, rawCoverage, previous }), built.audit);
  const malformedRemoved = structuredClone(built.audit);
  malformedRemoved.removed[0].extra = true;
  assert.throws(() => verifyPublishedAudit({ audit: malformedRemoved, result, rawCoverage, previous }),
    /delta does not match previous review/);
  const wrongRemovedTotal = structuredClone(built.audit);
  wrongRemovedTotal.totals.removed += 1;
  assert.throws(() => verifyPublishedAudit({ audit: wrongRemovedTotal, result, rawCoverage, previous }),
    /totals do not match evidence/);
});

test('coverage audit occurrences identify raw sibling counters before zero filtering', () => {
  const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'same-source')]);
  const sourceHash = sources.files[0].sha256;
  const previouslyZeroSecond = { path: 'scripts/a.mjs', source_sha256: sourceHash,
    metric: 'branches', line: 7, occurrence: 2 };
  const built = buildAudit({ result: passingResult(sources), rawCoverage: { files: [rawFile('scripts/a.mjs', {
    branches: [{ line: 7, count: 0 }, { line: 7, count: 1 }],
  })] }, previous: normalizedPrevious(sources, [previouslyZeroSecond], [decision(previouslyZeroSecond)]),
  evidence: {} });
  assert.deepEqual(built.audit.unclassified, [{ path: 'scripts/a.mjs', source_sha256: sourceHash,
    metric: 'branches', line: 7, occurrence: 1 }]);
  assert.deepEqual(built.audit.classifications, []);
  const orderedSources = sourceSnapshot([sourceFile('scripts/a.mjs', 'a'), sourceFile('scripts/b.mjs', 'b')]);
  const ordered = buildAudit({ result: passingResult(orderedSources), rawCoverage: { files: [
    rawFile('scripts/b.mjs', { lines: [{ line: 2, count: 0 }] }),
    rawFile('scripts/a.mjs', { lines: [{ line: 3, count: 0 }] }),
  ] }, evidence: {} });
  assert.deepEqual(ordered.audit.zero_counters.map(({ path }) => path), ['scripts/a.mjs', 'scripts/b.mjs']);
  const alreadyOrdered = buildAudit({ result: passingResult(orderedSources), rawCoverage: { files: [
    rawFile('scripts/a.mjs', { lines: [{ line: 3, count: 0 }] }),
    rawFile('scripts/b.mjs', { lines: [{ line: 2, count: 0 }] }),
  ] }, evidence: {} });
  assert.deepEqual(alreadyOrdered.audit.zero_counters.map(({ path }) => path), ['scripts/a.mjs', 'scripts/b.mjs']);
});

test('coverage audit rejects incomplete, drifting and ambiguously referenced artifacts', async (t) => {
  const cases = [
    ['nonpass', { mutateResult: (result) => { result.verdict = 'failed'; } }],
    ['unstable snapshot', { mutateResult: (result) => { result.coverage.sources.stable = false; } }],
    ['invalid snapshot digest', { mutateResult: (result) => { result.coverage.sources.digest.sha256 = '0'.repeat(64); } }],
    ['invalid snapshot digest byte count', { mutateResult: (result) => { result.coverage.sources.digest.bytes = -1; } }],
    ['open snapshot shape', { mutateResult: (result) => { result.coverage.sources.extra = true; } }],
    ['invalid source file metadata', { mutateResult: (result) => { result.coverage.sources.files[0].bytes = -1; } }],
    ['invalid source file digest', { mutateResult: (result) => { result.coverage.sources.files[0].sha256 = 'bad'; } }],
    ['invalid manifest path', { mutateResult: (result) => {
      result.coverage.manifest = ['../escape']; result.coverage.reported = ['../escape'];
    } }],
    ['manifest differs from source snapshot', { mutateResult: (result) => {
      result.coverage.manifest = ['scripts/other.mjs']; result.coverage.reported = ['scripts/other.mjs'];
    } }],
    ['invalid artifact digest descriptors', { mutateResult: (result) => { delete result.coverage.artifact_digests.stderr; } }],
    ['invalid artifact digest bytes', { mutateResult: (result) => { result.coverage.artifact_digests.tap.bytes = -1; } }],
    ['invalid artifact digest hash', { mutateResult: (result) => { result.coverage.artifact_digests.tap.sha256 = 'bad'; } }],
    ['missing artifact reference', { mutateResult: (result) => { delete result.artifacts.failures; } }],
    ['escaping artifact reference', { mutateResult: (result) => { result.artifacts.failures = '../failures.jsonl'; } }],
    ['nested artifact reference', { mutateResult: (result) => { result.artifacts.failures = 'nested/failures.jsonl'; } }],
    ['missing artifact', { events: null }],
    ['missing last coverage', { events: [{ type: 'test:summary', data: {} }] }],
    ['unknown raw source', { rawCoverage: { files: [rawFile('scripts/missing.mjs')] } }],
    ['raw report file count differs', { rawCoverage: { files: [] } }],
    ['raw report path is relative', { rawCoverage: { files: [{ ...rawFile('scripts/a.mjs'), path: 'scripts/a.mjs' }] } }],
    ['raw report metric is missing', { rawCoverage: { files: [{ path: '/checkout/scripts/a.mjs', lines: [], branches: [] }] } }],
    ['negative raw counter', { rawCoverage: { files: [rawFile('scripts/a.mjs', { branches: [{ line: 1, count: -1 }] })] } }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async (caseT) => {
      const fixture = await artifactFixture(caseT, options);
      await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }));
      await assertNoAuditPublished(fixture.output);
    });
  }

  await t.test('duplicate raw source', async (caseT) => {
    const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha'), sourceFile('scripts/b.mjs', 'beta')]);
    const fixture = await artifactFixture(caseT, { sources,
      rawCoverage: { files: [rawFile('scripts/a.mjs'), rawFile('scripts/a.mjs')] } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }), /duplicated/);
  });

  await t.test('source snapshot files are not sorted', async (caseT) => {
    const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha'), sourceFile('scripts/b.mjs', 'beta')]);
    const fixture = await artifactFixture(caseT, { sources,
      rawCoverage: { files: [rawFile('scripts/a.mjs'), rawFile('scripts/b.mjs')] },
      mutateResult: (result) => { result.coverage.sources.files.reverse(); } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /source snapshot files are not sorted/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('source snapshot contains a duplicate path', async (caseT) => {
    const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha'), sourceFile('scripts/b.mjs', 'beta')]);
    const fixture = await artifactFixture(caseT, { sources,
      rawCoverage: { files: [rawFile('scripts/a.mjs'), rawFile('scripts/b.mjs')] },
      mutateResult: (result) => { result.coverage.sources.files[1] = { ...result.coverage.sources.files[0] }; } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /invalid source snapshot file/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('artifact bytes differ from the supervisor digest', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    await writeFile(fixture.tapPath, 'changed after result publication');
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /tap artifact digest mismatch/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('output directory symlink', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    const target = join(fixture.root, 'output-target');
    await mkdir(target);
    await symlink(target, fixture.output);
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /output directory must be a real directory/);
  });

  await t.test('output parent symlink', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    const target = join(fixture.root, 'parent-target');
    const linkedParent = join(fixture.root, 'linked-parent');
    await mkdir(target);
    await symlink(target, linkedParent);
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath,
      outputDir: join(linkedParent, 'output') }), /output parent must be a real directory/);
  });

  await t.test('missing output parent', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    const output = join(fixture.root, 'missing-parent', 'output');
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: output }),
      /output parent is missing/);
    await assertNoAuditPublished(output);
  });

  await t.test('open previous audit schema', async (caseT) => {
    const fixture = await artifactFixture(caseT, { previous: {
      schema_version: 1, zero_counters: [], classifications: [], unexpected: true,
    } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      previousPath: fixture.previousPath }), /unsupported previous audit schema/);
  });

  await t.test('open normalized previous audit schema', async (caseT) => {
    const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha')]);
    const previous = { ...normalizedPrevious(sources, [], []), unexpected: true };
    const fixture = await artifactFixture(caseT, { sources, previous });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      previousPath: fixture.previousPath }), /normalized previous audit fields/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('invalid previous audit root shape', async (caseT) => {
    const fixture = await artifactFixture(caseT, { previous: { schema_version: 2, classifications: [] } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      previousPath: fixture.previousPath }), /invalid previous audit/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('symlinked previous audit input', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    const source = join(fixture.root, 'previous-source.json');
    const linked = join(fixture.root, 'previous-link.json');
    await writeFile(source, JSON.stringify(normalizedPrevious(fixture.snapshot, [], [])));
    await symlink(source, linked);
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      previousPath: linked }), /previous audit must be a regular file/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('previous audit input is a directory', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      previousPath: fixture.root }), /previous audit must be a regular file/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('malformed review decisions', async (caseT) => {
    const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha')]);
    const identity = { path: 'scripts/a.mjs', source_sha256: sources.files[0].sha256,
      metric: 'lines', line: 1, occurrence: 1 };
    const variants = [null, { ...decision(identity), classification: 'invented' },
      { ...decision(identity), disposition: ' ' }, { ...decision(identity), extra: true },
      decision({ ...identity, occurrence: 0 })];
    for (const entry of variants) {
      const fixture = await artifactFixture(caseT, { sources,
        rawCoverage: { files: [rawFile('scripts/a.mjs', { lines: [{ line: 1, count: 0 }] })] },
        sidecar: { schema_version: 1, entries: [entry] } });
      await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
        classificationsPath: fixture.sidecarPath }));
      await assertNoAuditPublished(fixture.output);
    }
  });

  await t.test('snapshot destination already contains different bytes', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    await mkdir(fixture.output);
    await writeFile(join(fixture.output, 'tap.txt'), 'stale');
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /snapshot destination already has different content/);
    assert.equal(await readFile(join(fixture.output, 'tap.txt'), 'utf8'), 'stale');
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('snapshot destination is a symlink', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    await mkdir(fixture.output);
    await symlink(fixture.tapPath, join(fixture.output, 'tap.txt'));
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /snapshot destination is not a regular file/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('duplicate supervisor artifact destinations', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    fixture.result.artifacts.tap = fixture.result.artifacts.failures;
    fixture.result.coverage.artifact_digests.tap = fixture.result.coverage.artifact_digests.failures;
    await writeFile(fixture.resultPath, JSON.stringify(fixture.result));
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /snapshot destination collision/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('result artifact reference names a different file', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    fixture.result.artifacts.result = 'other-result.json';
    await writeFile(fixture.resultPath, JSON.stringify(fixture.result));
    await writeFile(join(fixture.artifact, 'other-result.json'), '{}');
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /result artifact reference does not name the supplied result/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('supervisor artifact collides with an audit output', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    fixture.result.artifacts.tap = 'zero-counter-audit.json';
    await writeFile(fixture.resultPath, JSON.stringify(fixture.result));
    await writeFile(join(fixture.artifact, 'zero-counter-audit.json'), tapContent);
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output }),
      /snapshot collides with audit output/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('source artifacts already in the output directory are retained', async (caseT) => {
    const fixture = await artifactFixture(caseT);
    const originalResult = await readFile(fixture.resultPath);
    const canonicalArtifact = await realpath(fixture.artifact);
    const completed = await auditCoverage({ coverageResultPath: join(canonicalArtifact, 'result.json'),
      outputDir: canonicalArtifact });
    assert.equal(completed.status, 'passed');
    assert.deepEqual(await readFile(fixture.resultPath), originalResult);
  });

  await t.test('extra sidecar decision', async (caseT) => {
    const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha')]);
    const identity = { path: 'scripts/a.mjs', source_sha256: sources.files[0].sha256,
      metric: 'lines', line: 99, occurrence: 1 };
    const fixture = await artifactFixture(caseT, { sources,
      sidecar: { schema_version: 1, entries: [decision(identity)] } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      classificationsPath: fixture.sidecarPath }), /stale, extra or missing/);
  });

  await t.test('open classification sidecar shape', async (caseT) => {
    const fixture = await artifactFixture(caseT, { sidecar: { schema_version: 1, entries: [], unexpected: true } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      classificationsPath: fixture.sidecarPath }), /invalid classification sidecar/);
    await assertNoAuditPublished(fixture.output);
  });

  await t.test('duplicate sidecar decision', async (caseT) => {
    const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha')]);
    const identity = { path: 'scripts/a.mjs', source_sha256: sources.files[0].sha256,
      metric: 'lines', line: 1, occurrence: 1 };
    const entry = decision(identity);
    const fixture = await artifactFixture(caseT, { sources,
      rawCoverage: { files: [rawFile('scripts/a.mjs', { lines: [{ line: 1, count: 0 }] })] },
      sidecar: { schema_version: 1, entries: [entry, entry] } });
    await assert.rejects(auditCoverage({ coverageResultPath: fixture.resultPath, outputDir: fixture.output,
      classificationsPath: fixture.sidecarPath }), /duplicate sidecar/);
  });
});

test('coverage audit CLI exits one with a published review queue and zero only after exact classification', async (t) => {
  const sources = sourceSnapshot([sourceFile('scripts/a.mjs', 'alpha')]);
  const identity = { path: 'scripts/a.mjs', source_sha256: sources.files[0].sha256,
    metric: 'branches', line: 7, occurrence: 1 };
  const fixture = await artifactFixture(t, { sources,
    rawCoverage: { files: [rawFile('scripts/a.mjs', { branches: [{ line: 7, count: 0 }] })] },
    sidecar: { schema_version: 1, entries: [decision(identity)] } });
  const runCommand = async (args) => {
    const child = spawn(process.execPath, [fileURLToPath(script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
    const [code] = await once(child, 'close');
    return { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  };
  const run = (args) => runCommand([fixture.resultPath, ...args]);
  const incomplete = await run([fixture.output]);
  assert.equal(incomplete.code, 1); assert.match(incomplete.stderr, /unclassified: 1/);
  assert.equal(JSON.parse(await readFile(join(fixture.output, 'zero-counter-audit.json'))).status, 'unclassified');
  const complete = await run([fixture.output, '--classifications', fixture.sidecarPath]);
  assert.equal(complete.code, 0); assert.match(complete.stdout, /passed: 0/);
  assert.equal(JSON.parse(await readFile(join(fixture.output, 'zero-counter-audit.json'))).status, 'passed');
  const malformed = await run([fixture.output, '--unknown', fixture.sidecarPath]);
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /coverage audit failed: usage:/);
  const missing = await runCommand([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /coverage audit failed: usage:/);
  const duplicate = await run([fixture.output, '--classifications', fixture.sidecarPath,
    '--classifications', fixture.sidecarPath]);
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /coverage audit failed: usage:/);
  const duplicatePrevious = await run([fixture.output, '--previous', fixture.sidecarPath,
    '--previous', fixture.sidecarPath]);
  assert.equal(duplicatePrevious.code, 2);
  assert.match(duplicatePrevious.stderr, /coverage audit failed: usage:/);
});
