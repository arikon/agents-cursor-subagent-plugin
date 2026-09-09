import test from 'node:test';
import * as support from './eval-closeout-test-support.mjs';

const { assert, spawn, createHash, once, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile, tmpdir, dirname, join, relative, fileURLToPath, canonicalJson, parseScenarioCorpus, buildCloseout, finalizeCloseout, parseFinalizeArgs, publishCloseout, repository, closeoutScript, corpusBytes, corpus, scenarios, digest, json, fixed, START, END, write, publicResult, matrixFixture, fixture, historicalReferenceFixture, snapshot, runCli, mutateIndexedEvidence, mutateIndexedFile, mutationCase, rewriteCoverage } = support;

test('closeout validates all gates, preserves history, and checks only tasks 5.8 through 5.11', async (t) => {
  const { root, bundle, targets, paths } = await fixture(t); const proof = await finalizeCloseout(paths);
  assert.deepEqual({ status: proof.status, tasks: proof.completed_tasks, semantics: proof.semantic_checks },
    { status: 'passed', tasks: ['5.8', '5.9', '5.10', '5.11'], semantics: 'not_checked' });
  const baseline = JSON.parse(await readFile(paths.baseline));
  assert.deepEqual(baseline.historical, Array.from({ length: 7 }, (_value, index) => ({ id: `kept-${index + 1}` })));
  assert.equal(baseline.current_acceptance.high.counts.pass, scenarios.length * 3);
  assert.equal(baseline.current_acceptance.high.execution, 'fresh');
  assert.equal(baseline.current_acceptance.high.applies_to_current_candidate, true);
  const report = await readFile(paths.report, 'utf8'); assert.match(report, /Keep this paragraph/); assert.match(report, /Current acceptance/);
  assert.match(report, /100% for mechanics, evidence, and exact delivery/); assert.match(report, /completeness disclosure: `not_checked`/);
  assert.equal(JSON.stringify(proof).includes(root), false);
  const tasks = await readFile(paths.tasks, 'utf8');
  assert.match(tasks, /- \[ \] 5\.7/); assert.match(tasks, /- \[x\] 5\.8/); assert.match(tasks, /- \[x\] 5\.11/); assert.match(tasks, /- \[ \] 5\.12/);
  assert.equal(proof.current_acceptance.coverage.totals.zero_counters, 1);
  assert.equal(proof.current_acceptance.local_verification.local_gate.path, 'verification/local-gate.json');
  assert.match(proof.current_acceptance.local_verification.local_gate.sha256, /^[a-f0-9]{64}$/);
  await rm(targets, { recursive: true });
  const moved = join(root, 'moved-bundle'); await rename(bundle, moved);
  for (const ref of Object.values(proof.published_documents)) {
    const bytes = await readFile(join(moved, ref.path)); assert.deepEqual(digest(bytes), { bytes: ref.bytes, sha256: ref.sha256 });
  }
});

test('closeout validation rejects malformed paths and evidence without mutating destinations', async (t) => {
  const { paths } = await fixture(t); const before = await snapshot(paths);
  assert.throws(() => parseFinalizeArgs(['--freeze', 'relative']), /all closeout paths|required/);
  const matrix = JSON.parse(await readFile(paths.high)); matrix.results[0].attempts.push(matrix.results[0].attempts[0]); await writeFile(paths.high, json(matrix));
  await assert.rejects(buildCloseout(paths), /invalid matrix result shape|non-passing matrix result/);
  assert.deepEqual(await snapshot(paths), before);

  matrix.results[0].attempts.pop(); matrix.results[0].scenario_id = matrix.results[1].scenario_id; await writeFile(paths.high, json(matrix));
  await assert.rejects(buildCloseout(paths), /scenario/); assert.deepEqual(await snapshot(paths), before);

  matrix.results[0].scenario_id = scenarios[0].scenario_id; matrix.results[0].process.code = 1; await writeFile(paths.high, json(matrix));
  await assert.rejects(buildCloseout(paths), /non-passing matrix result/); assert.deepEqual(await snapshot(paths), before);

  const candidateMatrix = JSON.parse(await readFile(paths.diagnostic)); candidateMatrix.candidate_digest.sha256 = '0'.repeat(64);
  await writeFile(paths.diagnostic, json(candidateMatrix));
  await assert.rejects(buildCloseout(paths), /candidate digest mismatch|candidate differs/); assert.deepEqual(await snapshot(paths), before);
});

test('closeout rejects traversal, hash drift, incomplete finals, dropped calls, and incomplete coverage', async (t) => {
  const { paths } = await fixture(t); const before = await snapshot(paths);
  for (const kind of ['traversal', 'hash', 'process-shape', 'driver-stderr', 'supervisor', 'final', 'duplicate-turn',
    'public-result', 'dropped', 'recovery-proof', 'coverage', 'coverage-decision', 'coverage-source', 'coverage-failures',
    'freeze-coverage-digest', 'shared-source-hash', 'coverage-ref-missing']) {
    const saved = new Map();
    const save = async (path) => { if (!saved.has(path)) saved.set(path, await readFile(path)); };
    try {
      if (kind === 'traversal' || kind === 'hash' || kind === 'process-shape') {
        await save(paths.diagnostic); const matrix = JSON.parse(await readFile(paths.diagnostic));
        if (kind === 'traversal') matrix.artifacts[0].path = '../escape';
        else if (kind === 'hash') matrix.artifacts[0].sha256 = '0'.repeat(64);
        else matrix.results[0].process.extra = true;
        await writeFile(paths.diagnostic, json(matrix));
      } else if (kind === 'driver-stderr' || kind === 'supervisor') {
        const matrix = JSON.parse(await readFile(paths.diagnostic)); const root = join(dirname(paths.diagnostic), matrix.results[0].artifact_root);
        const target = join(root, kind === 'driver-stderr' ? 'driver-stderr.txt' : 'supervisor/tap.txt'); await save(target); await rm(target);
      } else if (['final', 'duplicate-turn', 'public-result', 'dropped', 'recovery-proof'].includes(kind)) {
        const index = kind === 'duplicate-turn' ? scenarios.findIndex(({ followups }) => followups.length > 0) : 0;
        const matrix = JSON.parse(await readFile(paths.diagnostic)); const evidencePath = join(dirname(paths.diagnostic), matrix.results[index].evidence_ref);
        await save(paths.diagnostic); await save(evidencePath);
        await mutateIndexedEvidence(paths.diagnostic, (evidence) => {
          if (kind === 'final') evidence.captured_finals[0].text = '';
          else if (kind === 'duplicate-turn') evidence.captured_finals[1].turn_id = evidence.captured_finals[0].turn_id;
          else if (kind === 'public-result') evidence.final_result.actual_task_outcome = 'failed';
          else if (kind === 'dropped') evidence.transcript.dropped_calls = 1;
          else delete evidence.transcript.turn_call_ranges;
        }, index);
      } else if (kind === 'coverage-failures') {
        const failures = join(dirname(paths['coverage-audit']), 'failures.jsonl'); await save(failures); await writeFile(failures, '{}\n');
      } else if (kind === 'freeze-coverage-digest' || kind === 'coverage-ref-missing') {
        await save(paths.freeze); const freeze = JSON.parse(await readFile(paths.freeze));
        if (kind === 'freeze-coverage-digest') freeze.coverage_sources_digest.sha256 = '0'.repeat(64);
        else delete freeze.verification.coverage_audit;
        await writeFile(paths.freeze, json(freeze));
      } else if (kind === 'shared-source-hash') {
        const resultPath = join(dirname(paths['coverage-audit']), 'result.json');
        await save(paths.freeze); await save(resultPath); await save(paths['coverage-audit']);
        const result = JSON.parse(await readFile(resultPath)); result.coverage.sources.files[0].sha256 = 'a'.repeat(64);
        const sourceBytes = Buffer.from(JSON.stringify(result.coverage.sources.files)); result.coverage.sources.digest = digest(sourceBytes);
        const resultContent = json(result); await writeFile(resultPath, resultContent);
        const audit = JSON.parse(await readFile(paths['coverage-audit'])); audit.source_digest = result.coverage.sources.digest;
        for (const entry of [...audit.zero_counters, ...audit.added, ...audit.classifications]) entry.source_sha256 = 'a'.repeat(64);
        Object.assign(audit.evidence.coverage_result, digest(Buffer.from(resultContent))); await writeFile(paths['coverage-audit'], json(audit));
        const freeze = JSON.parse(await readFile(paths.freeze)); freeze.coverage_sources_digest = result.coverage.sources.digest;
        await writeFile(paths.freeze, json(freeze));
      } else {
        await save(paths['coverage-audit']); const audit = JSON.parse(await readFile(paths['coverage-audit']));
        if (kind === 'coverage') { audit.status = 'unclassified'; audit.unclassified = [{}]; audit.totals.unclassified = 1; }
        else if (kind === 'coverage-decision') {
          audit.classifications = []; audit.classification_counts.observable_contract_already_owned = 0; audit.totals.classified = 0;
        } else audit.zero_counters[0].source_sha256 = '0'.repeat(64);
        await writeFile(paths['coverage-audit'], json(audit));
      }
      await assert.rejects(buildCloseout(paths)); assert.deepEqual(await snapshot(paths), before, kind);
    } finally {
      for (const [path, bytes] of saved) await writeFile(path, bytes);
    }
  }
});

test('closeout rejects symlinked bundle roots and matrix artifact parents', async (t) => {
  const parent = await fixture(t); const before = await snapshot(parent.paths);
  const artifactRoot = `${parent.paths.diagnostic}.artifacts`; const outside = join(parent.root, 'outside-artifacts');
  await rename(artifactRoot, outside); await symlink(outside, artifactRoot, 'dir');
  await assert.rejects(buildCloseout(parent.paths), /symlink|artifact root/); assert.deepEqual(await snapshot(parent.paths), before);

  const rootCase = await fixture(t); const alias = join(rootCase.root, 'bundle-alias'); await symlink(rootCase.bundle, alias, 'dir');
  const aliased = Object.fromEntries(Object.entries(rootCase.paths).map(([name, path]) => [name,
    path.startsWith(rootCase.bundle) ? `${alias}${path.slice(rootCase.bundle.length)}` : path]));
  await assert.rejects(buildCloseout(aliased), /bundle root/);
});

test('closeout rejects each CLI, bundle, JSON, and artifact boundary before publication', async (t) => {
  const { root, bundle, paths } = await fixture(t); const argv = Object.entries(paths).flatMap(([name, path]) => [`--${name}`, path]);
  assert.throws(() => parseFinalizeArgs(['--unknown', paths.freeze, ...argv.slice(2)]), /invalid closeout arguments/);
  assert.throws(() => parseFinalizeArgs(['freeze', paths.freeze, ...argv.slice(2)]), /invalid closeout arguments/);
  assert.throws(() => parseFinalizeArgs(argv.slice(0, -1)), /invalid closeout arguments/);
  const repeated = [...argv]; repeated[2] = '--freeze';
  assert.throws(() => parseFinalizeArgs(repeated), /invalid closeout arguments/);
  assert.throws(() => parseFinalizeArgs(argv.map((value, index) => index === 1 ? 'relative.json' : value)), /--freeze must be absolute/);
  const duplicate = [...argv]; duplicate[3] = duplicate[1];
  assert.throws(() => parseFinalizeArgs(duplicate), /closeout paths must be distinct/);
  const outside = { ...paths, freeze: join(root, 'outside.json') }; await writeFile(outside.freeze, '{}');
  await assert.rejects(buildCloseout(outside), /authoritative path escapes the output bundle/);
  const before = await snapshot(paths);
  const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await assert.rejects(buildCloseout(paths, { lstat: async (path) => path === bundle ? missing() : lstat(path) }), /output bundle root must be a real directory/);
  await assert.rejects(buildCloseout(paths, { lstat: async (path) => path === dirname(paths.freeze) ? missing() : lstat(path) }), /authoritative path has a symlink or invalid parent/);
  await assert.rejects(buildCloseout(paths, { realpath: async (path) => path === dirname(paths.freeze) ? root : realpath(path) }), /authoritative path escapes the real output bundle/);
  assert.deepEqual(await snapshot(paths), before);
  const candidateParent = dirname(paths.freeze); const realCandidateParent = `${candidateParent}.real`;
  await rename(candidateParent, realCandidateParent); await symlink(realCandidateParent, candidateParent, 'dir');
  try { await assert.rejects(buildCloseout(paths), /authoritative path has a symlink or invalid parent/); }
  finally { await rm(candidateParent); await rename(realCandidateParent, candidateParent); }
  await mutationCase(paths, [paths.freeze], () => writeFile(paths.freeze, '{'), /invalid JSON/);
  const artifactRoot = `${paths.diagnostic}.artifacts`;
  await assert.rejects(buildCloseout(paths, { lstat: async (path) => path === artifactRoot ? missing() : lstat(path) }), /invalid artifact root/);
  assert.deepEqual(await snapshot(paths), before);
  const badLeaf = join(artifactRoot, 'unsupported-link'); await symlink(join(artifactRoot, 'candidate.json'), badLeaf);
  try { await assert.rejects(buildCloseout(paths), /unsupported artifact entry/); assert.deepEqual(await snapshot(paths), before); }
  finally { await rm(badLeaf); }
});

test('closeout reaches matrix index, evidence, supervisor, capture, set, and summary guards', async (t) => {
  const { paths } = await fixture(t); const matrixPath = paths.diagnostic; const base = dirname(matrixPath);
  const matrixOnly = async (mutate, error) => mutationCase(paths, [matrixPath], async () => {
    const matrix = JSON.parse(await readFile(matrixPath)); mutate(matrix); await writeFile(matrixPath, json(matrix));
  }, error);
  await matrixOnly((matrix) => { matrix.schema_version = 2; }, /invalid matrix contract/);
  await matrixOnly((matrix) => { matrix.initial.skill.sha256 = '0'.repeat(64); }, /matrix input drift/);
  await matrixOnly((matrix) => { matrix.results.pop(); }, /matrix result count mismatch/);
  await matrixOnly((matrix) => { matrix.runs = []; }, /matrix serial count mismatch/);
  await matrixOnly((matrix) => { delete matrix.artifacts; }, /matrix artifact index missing/);
  await matrixOnly((matrix) => { matrix.artifacts[0].bytes = -1; }, /invalid matrix artifact index/);
  await matrixOnly((matrix) => { matrix.candidate_ref = 'not-indexed.json'; }, /candidate reference is not indexed/);
  await matrixOnly((matrix) => { matrix.results[0].evidence_ref = matrix.candidate_ref; }, /unindexed result evidence/);
  await matrixOnly((matrix) => { matrix.counts.pass -= 1; }, /matrix aggregate mismatch/);
  await matrixOnly((matrix) => { matrix.runs[0].pass_rate = 0; }, /matrix run summary mismatch/);

  const matrix = JSON.parse(await readFile(matrixPath)); const result = matrix.results[0]; const attempt = join(base, result.artifact_root);
  const evidencePath = join(base, result.evidence_ref); const driverOut = join(attempt, 'driver-stdout.txt'); const driverErr = join(attempt, 'driver-stderr.txt');
  const outsideArtifact = join(base, 'outside-artifact.json');
  await mutationCase(paths, [matrixPath, outsideArtifact], async () => {
    const file = await write(outsideArtifact, '{}\n'); const current = JSON.parse(await readFile(matrixPath));
    current.artifacts.push({ path: relative(base, file.path), bytes: file.bytes, sha256: file.sha256 }); await writeFile(matrixPath, json(current));
  }, /artifact outside matrix root/);
  const unindexed = join(`${matrixPath}.artifacts`, 'unindexed.txt');
  await mutationCase(paths, [unindexed], () => write(unindexed, 'extra'), /unindexed matrix artifacts/);
  const candidatePath = join(base, matrix.candidate_ref);
  await mutationCase(paths, [matrixPath, candidatePath], () => mutateIndexedFile(matrixPath, candidatePath, (value) => { value.payload.adapter.sha256 = 'a'.repeat(64); }), /candidate digest mismatch/);
  for (const [file, message] of [[evidencePath, /unindexed result evidence/], [driverOut, /unindexed result evidence/], [driverErr, /unindexed result evidence/]]) {
    await mutationCase(paths, [matrixPath, file], async () => {
      const current = JSON.parse(await readFile(matrixPath)); const ref = relative(base, file);
      current.artifacts = current.artifacts.filter(({ path }) => path !== ref); await rm(file); await writeFile(matrixPath, json(current));
    }, message);
  }
  const supervisor = join(attempt, 'supervisor'); const supervisorFiles = ['result.json', 'failures.jsonl', 'tap.txt', 'stderr.txt'].map((name) => join(supervisor, name));
  await mutationCase(paths, [matrixPath, ...supervisorFiles], async () => {
    const current = JSON.parse(await readFile(matrixPath)); const refs = new Set(supervisorFiles.map((file) => relative(base, file)));
    current.artifacts = current.artifacts.filter(({ path }) => !refs.has(path)); await Promise.all(supervisorFiles.map((file) => rm(file)));
    await writeFile(matrixPath, json(current));
  }, /missing supervisor artifacts/);
  await mutationCase(paths, [matrixPath, join(supervisor, 'result.json')], () => mutateIndexedFile(matrixPath, join(supervisor, 'result.json'), (value) => { value.verdict = 'failed'; }), /non-passing supervisor artifacts/);
  const secondSupervisor = join(attempt, 'supervisor-2');
  const secondSupervisorFiles = ['result.json', 'failures.jsonl', 'tap.txt', 'stderr.txt'].map((name) => join(secondSupervisor, name));
  await mutationCase(paths, [matrixPath, ...secondSupervisorFiles], async () => {
    await cp(supervisor, secondSupervisor, { recursive: true }); const current = JSON.parse(await readFile(matrixPath));
    for (const name of ['result.json', 'failures.jsonl', 'tap.txt', 'stderr.txt']) {
      const file = await readFile(join(secondSupervisor, name)); current.artifacts.push({ path: relative(base, join(secondSupervisor, name)), ...digest(file) });
    }
    await writeFile(matrixPath, json(current));
  }, /missing supervisor artifacts/);
  await mutationCase(paths, [matrixPath, evidencePath], () => mutateIndexedEvidence(matrixPath, (value) => { value.captured_finals = {}; }), /incomplete final capture/);
  await mutationCase(paths, [matrixPath, evidencePath], () => mutateIndexedEvidence(matrixPath, (value) => { value.captured_finals[0].text = null; }), /incomplete final capture/);
  await mutationCase(paths, [matrixPath, evidencePath], () => mutateIndexedEvidence(matrixPath, (value) => { value.captured_finals[0].text = 'x'.repeat(1_048_577); }), /incomplete final capture/);

  await mutationCase(paths, [matrixPath], async () => {
    const current = JSON.parse(await readFile(matrixPath)); current.results[0] = structuredClone(current.results[1]); await writeFile(matrixPath, json(current));
  }, /scenario set mismatch/);
});

test('closeout reconstructs coverage evidence and rejects each inconsistent boundary', async (t) => {
  const { paths } = await fixture(t); const base = dirname(paths['coverage-audit']);
  const auditPath = paths['coverage-audit']; const resultPath = join(base, 'result.json'); const failuresPath = join(base, 'failures.jsonl'); const previousPath = join(base, 'previous-review.json');
  const auditOnly = async (mutate, error) => mutationCase(paths, [auditPath], async () => {
    const audit = JSON.parse(await readFile(auditPath)); mutate(audit); await writeFile(auditPath, json(audit));
  }, error);
  await auditOnly((audit) => { delete audit.evidence.tap; }, /coverage audit evidence is incomplete/);
  await auditOnly((audit) => { audit.evidence = null; }, /coverage audit evidence is incomplete/);
  await auditOnly((audit) => { audit.evidence.extra = audit.evidence.tap; }, /coverage audit evidence is incomplete/);
  await auditOnly((audit) => { audit.evidence.tap.bytes = 'bad'; }, /coverage audit evidence is incomplete/);
  await mutationCase(paths, [auditPath, resultPath], async () => {
    await writeFile(resultPath, '{'); const audit = JSON.parse(await readFile(auditPath)); Object.assign(audit.evidence.coverage_result, digest(Buffer.from('{'))); await writeFile(auditPath, json(audit));
  }, /coverage JSON evidence is invalid/);
  await mutationCase(paths, [auditPath, previousPath], async () => {
    await writeFile(previousPath, '{'); const audit = JSON.parse(await readFile(auditPath)); Object.assign(audit.evidence.previous, digest(Buffer.from('{'))); await writeFile(auditPath, json(audit));
  }, /coverage JSON evidence is invalid/);
  await mutationCase(paths, [auditPath, resultPath], () => rewriteCoverage(paths, (result) => { result.artifacts.tap = 'wrong.txt'; }), /coverage supervisor artifacts do not match audit evidence/);
  await mutationCase(paths, [auditPath, resultPath], () => rewriteCoverage(paths, (result) => { result.coverage.artifact_digests.tap.sha256 = '0'.repeat(64); }), /coverage supervisor artifacts do not match audit evidence/);
  await mutationCase(paths, [auditPath, resultPath, failuresPath], () => rewriteCoverage(paths, null, '{\n'), /coverage failures evidence is invalid/);
  await mutationCase(paths, [auditPath, resultPath, failuresPath], () => rewriteCoverage(paths, null, `${JSON.stringify({ type: 'test:summary', data: {} })}\n`), /coverage failures evidence lacks the final raw queue/);
  await auditOnly((audit) => {
    audit.status = 'unclassified'; audit.classifications = []; audit.classification_counts.observable_contract_already_owned = 0;
    audit.unclassified = [...audit.zero_counters]; audit.totals.classified = 0; audit.totals.unclassified = 1;
  }, /coverage audit is incomplete/);
  await mutationCase(paths, [paths.freeze], async () => {
    const freeze = JSON.parse(await readFile(paths.freeze)); freeze.verification.coverage_audit = 'coverage/result.json'; await writeFile(paths.freeze, json(freeze));
  }, /coverage audit does not match frozen verification reference/);
});

test('closeout validates freeze, documents, local refs, snapshots, and publication destinations', async (t) => {
  const { bundle, paths } = await fixture(t);
  const mutateFile = (path, mutate, error) => mutationCase(paths, [path], async () => {
    const value = JSON.parse(await readFile(path)); mutate(value); await writeFile(path, json(value));
  }, error);
  await mutationCase(paths, [paths.report], () => writeFile(paths.report, `${START}\nfirst\n${START}\nsecond\n${END}\n`), /report closeout block is malformed/);
  await mutationCase(paths, [paths.report], () => writeFile(paths.report, `${START}\nmissing end\n`), /report closeout block is malformed/);
  await mutationCase(paths, [paths.report], () => writeFile(paths.report, `${START}\nfirst\n${END}\n${END}\n`), /report closeout block is malformed/);
  await mutationCase(paths, [paths.tasks], async () => {
    const value = (await readFile(paths.tasks, 'utf8')).replace('- [ ] 5.8 diagnostic\n', ''); await writeFile(paths.tasks, value);
  }, /task 5.8 anchor is missing or duplicated/);
  await mutationCase(paths, [paths.tasks], async () => {
    const value = await readFile(paths.tasks, 'utf8'); await writeFile(paths.tasks, `${value}- [ ] 5.8 duplicate\n`);
  }, /task 5.8 anchor is missing or duplicated/);
  await mutateFile(paths.freeze, (freeze) => { freeze.schema_version = 2; }, /invalid frozen inputs/);
  await mutateFile(paths.freeze, (freeze) => { delete freeze.verification; }, /invalid frozen inputs/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.files[0].bytes = 0; }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.files.push(freeze.evaluator.files[0]); }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.selected_runner = 'missing.mjs'; }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.files.reverse(); }, /invalid frozen evaluator inventory/);
  await mutateFile(paths.freeze, (freeze) => { freeze.evaluator.digest.sha256 = '0'.repeat(64); }, /frozen evaluator digest mismatch/);
  await mutateFile(paths.freeze, (freeze) => { freeze.corpus.sha256 = '0'.repeat(64); }, /current corpus differs from freeze/);
  await mutateFile(paths.freeze, (freeze) => { freeze.verification.local_gate = '../escape'; }, /invalid frozen verification reference/);
  await mutateFile(paths.freeze, (freeze) => { freeze.verification.local_gate = 'verification/missing.json'; }, /not a regular file/);

  await mkdir(paths.output);
  try { await assert.rejects(buildCloseout(paths), /--output must be a regular proof file/); }
  finally { await rm(paths.output, { recursive: true }); }
  const outputTarget = join(bundle, 'output-target'); await writeFile(outputTarget, 'target'); await symlink(outputTarget, paths.output);
  try { await assert.rejects(buildCloseout(paths), /--output must be a regular proof file/); }
  finally { await rm(paths.output); }
  const localPath = join(bundle, 'verification', 'local-gate.json'); const parkedLocal = `${localPath}.real`; await rename(localPath, parkedLocal); await symlink(parkedLocal, localPath);
  try { await assert.rejects(buildCloseout(paths), /not a regular file/); }
  finally { await rm(localPath); await rename(parkedLocal, localPath); }

  await mutationCase(paths, [paths.high], async () => {
    const matrix = JSON.parse(await readFile(paths.high)); matrix.concurrency = 5; for (const run of matrix.runs) run.concurrency = 5; await writeFile(paths.high, json(matrix));
  }, /acceptance matrices do not share one candidate and concurrency/);
  const highMatrix = JSON.parse(await readFile(paths.high)); const highBase = dirname(paths.high);
  const highCandidatePath = join(highBase, highMatrix.candidate_ref);
  const highEvidencePaths = highMatrix.results.map(({ evidence_ref: ref }) => join(highBase, ref));
  await mutationCase(paths, [paths.high, highCandidatePath, ...highEvidencePaths], async () => {
    const matrix = JSON.parse(await readFile(paths.high)); const candidate = JSON.parse(await readFile(highCandidatePath));
    candidate.payload.adapter.sha256 = 'a'.repeat(64); const payloadBytes = Buffer.from(canonicalJson(candidate.payload)); candidate.digest = digest(payloadBytes);
    const candidateBytes = Buffer.from(json(candidate)); await writeFile(highCandidatePath, candidateBytes);
    Object.assign(matrix.artifacts.find(({ path }) => path === matrix.candidate_ref), digest(candidateBytes));
    matrix.candidate_digest = candidate.digest; for (const run of matrix.runs) run.candidate_digest = candidate.digest;
    for (const result of matrix.results) {
      const evidencePath = join(highBase, result.evidence_ref); const evidence = JSON.parse(await readFile(evidencePath)); evidence.manifest.adapter = candidate.payload.adapter;
      const evidenceBytes = Buffer.from(json(evidence)); await writeFile(evidencePath, evidenceBytes);
      Object.assign(matrix.artifacts.find(({ path }) => path === result.evidence_ref), digest(evidenceBytes));
    }
    await writeFile(paths.high, json(matrix));
  }, /acceptance matrices do not share one candidate and concurrency/);
  const snapshotRoot = join(bundle, 'closeout-proof.json.inputs'); await writeFile(snapshotRoot, 'file');
  try { await assert.rejects(buildCloseout(paths), /closeout snapshot root is invalid/); }
  finally { await rm(snapshotRoot); }
  const colliding = { ...paths, baseline: join(snapshotRoot, 'baseline.json') };
  await mkdir(snapshotRoot, { recursive: true }); await writeFile(colliding.baseline, await readFile(paths.baseline));
  try { await assert.rejects(buildCloseout(colliding), /closeout publication destinations collide/); }
  finally { await rm(snapshotRoot, { recursive: true }); }
});

test('per-file publisher leaves a recoverable prefix and an idempotent rerun repairs it', async (t) => {
  const { paths } = await fixture(t); const staged = await buildCloseout(paths); let calls = 0;
  await assert.rejects(publishCloseout(staged, { rename: async (from, to) => {
    calls += 1; if (calls === 9) throw new Error('interrupted'); return rename(from, to);
  } }), /interrupted/);
  assert.match(await readFile(paths.report, 'utf8'), /Current acceptance/);
  await assert.rejects(readFile(paths.output), { code: 'ENOENT' });
  assert.match(await readFile(paths.tasks, 'utf8'), /- \[ \] 5\.8/);
  const repaired = await buildCloseout(paths); await publishCloseout(repaired);
  const first = await readFile(paths.output, 'utf8'); const repeated = await buildCloseout(paths); await publishCloseout(repeated);
  assert.equal(repeated.proof, repaired.proof); assert.equal(await readFile(paths.output, 'utf8'), first);
  assert.match(await readFile(paths.tasks, 'utf8'), /- \[x\] 5\.11/);
  let cleanupCalls = 0;
  await assert.rejects(publishCloseout(await buildCloseout(paths), {
    rename: async () => { throw new Error('publication failed'); },
    rm: async () => { cleanupCalls += 1; throw new Error('cleanup failed'); },
  }), /publication failed/);
  assert.ok(cleanupCalls > 0);
});

test('closeout preserves historical high without claiming acceptance of the current candidate', async (t) => {
  const { paths } = await historicalReferenceFixture(t);
  const historical = await readFile(paths.high); const matrix = JSON.parse(historical);
  const artifactBytes = await Promise.all(matrix.artifacts.map(({ path }) => readFile(join(dirname(paths.high), path))));
  const proof = await finalizeCloseout(paths);
  assert.equal(proof.current_acceptance.high.execution, 'preserved-reference');
  assert.equal(proof.current_acceptance.high.applies_to_current_candidate, false);
  assert.deepEqual(proof.current_acceptance.high.reference, JSON.parse(await readFile(paths.freeze)).high_reference);
  assert.notDeepEqual(matrix.candidate_digest, JSON.parse(await readFile(paths.medium)).candidate_digest);
  assert.equal(proof.current_acceptance.high.counts.pass, scenarios.length * 3);
  assert.equal(proof.current_acceptance.high.concurrency, 4);
  assert.equal(proof.current_acceptance.medium.concurrency, 12);
  const report = await readFile(paths.report, 'utf8');
  assert.match(report, /preserved-reference/); assert.match(report, /different candidate|not.*current candidate/i);
  assert.deepEqual(await readFile(paths.high), historical);
  assert.deepEqual(await Promise.all(matrix.artifacts.map(({ path }) => readFile(join(dirname(paths.high), path)))), artifactBytes);
  const published = await snapshot(paths); await finalizeCloseout(paths); assert.deepEqual(await snapshot(paths), published);
});

test('historical high rejects missing authorization and broken or ambiguous references before publishing', async (t) => {
  const { paths, sourceFreezePath, sourceCorpusPath, authorizationPath } = await historicalReferenceFixture(t);
  for (const kind of ['missing-source', 'hash-mismatch', 'invalid-source-json', 'invalid-source-freeze', 'invalid-corpus',
    'source-corpus-binding', 'unknown-reference-key', 'malformed-reference', 'nested-reference', 'nested-carry',
    'legacy-carry', 'both-fields', 'missing-authorization', 'missing-authorization-file']) {
    await mutationCase(paths, [paths.freeze, sourceFreezePath, sourceCorpusPath, authorizationPath], async () => {
      const freeze = JSON.parse(await readFile(paths.freeze)); const source = JSON.parse(await readFile(sourceFreezePath));
      if (kind === 'missing-source') await rm(sourceFreezePath);
      else if (kind === 'hash-mismatch') freeze.high_reference.source_freeze.sha256 = 'b'.repeat(64);
      else if (kind === 'unknown-reference-key') freeze.high_reference.unexpected = true;
      else if (kind === 'malformed-reference') freeze.high_reference.source_freeze.sha256 = 'bad';
      else if (kind === 'missing-authorization') delete freeze.verification.high_reference_authorization;
      else if (kind === 'missing-authorization-file') await rm(authorizationPath);
      else if (kind === 'legacy-carry' || kind === 'both-fields') {
        freeze.high_carry_forward = freeze.high_reference;
        if (kind === 'legacy-carry') delete freeze.high_reference;
      } else {
        if (kind === 'nested-reference') source.high_reference = freeze.high_reference;
        else if (kind === 'nested-carry') source.high_carry_forward = freeze.high_reference;
        else if (kind === 'invalid-source-freeze') source.evaluator.digest = fixed('b');
        else if (kind === 'source-corpus-binding') source.corpus = fixed('b');
        else if (kind === 'invalid-corpus') {
          const bytes = Buffer.from('{}'); await writeFile(sourceCorpusPath, bytes);
          Object.assign(freeze.high_reference.source_corpus, digest(bytes)); source.corpus = digest(bytes);
        }
        const bytes = Buffer.from(kind === 'invalid-source-json' ? '{' : json(source)); await writeFile(sourceFreezePath, bytes);
        Object.assign(freeze.high_reference.source_freeze, digest(bytes));
      }
      await writeFile(paths.freeze, json(freeze));
    }, /reference|source|corpus|digest|freeze|carry|authorization|regular|JSON/i);
  }
});

test('historical high retains full evidence validation and current diagnostic and medium remain strict', async (t) => {
  const { paths } = await historicalReferenceFixture(t);
  for (const [lane, kind] of [['high', 'nonpass'], ['diagnostic', 'candidate'], ['medium', 'candidate'], ['medium', 'concurrency']]) {
    await mutationCase(paths, [paths[lane]], async () => {
      const matrix = JSON.parse(await readFile(paths[lane]));
      if (kind === 'nonpass') matrix.results[0].process.code = 1;
      else if (kind === 'candidate') matrix.candidate_digest = fixed('a');
      else { matrix.concurrency = 4; for (const run of matrix.runs) run.concurrency = 4; }
      await writeFile(paths[lane], json(matrix));
    }, kind === 'concurrency' ? /acceptance matrices do not share one candidate and concurrency/ : /matrix|candidate|concurrency|run/i);
  }
  const matrix = JSON.parse(await readFile(paths.high));
  const evidencePath = join(dirname(paths.high), matrix.results[0].evidence_ref);
  for (const kind of ['capture', 'cleanup']) {
    await mutationCase(paths, [paths.high, evidencePath], () => mutateIndexedEvidence(paths.high, (evidence) => {
      if (kind === 'capture') evidence.captured_finals[0].completeness = 'incomplete';
      else evidence.final_result.cleanup_status = 'failed';
    }), /evidence|final|capture/i);
  }
});
