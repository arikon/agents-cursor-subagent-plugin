import test from 'node:test';
import * as support from './eval-closeout-test-support.mjs';

const { assert, spawn, createHash, once, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile, tmpdir, dirname, join, relative, fileURLToPath, canonicalJson, parseScenarioCorpus, buildCloseout, finalizeCloseout, parseFinalizeArgs, publishCloseout, repository, closeoutScript, corpusBytes, corpus, scenarios, digest, json, fixed, START, END, write, publicResult, matrixFixture, fixture, historicalReferenceFixture, snapshot, runCli, mutateIndexedEvidence, mutateIndexedFile, mutationCase, rewriteCoverage } = support;

test('closeout CLI accepts only explicit paths and publishes its proof', async (t) => {
  const { paths } = await fixture(t);
  const success = await runCli(paths);
  assert.deepEqual(parseFinalizeArgs(success.argv), paths);
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).status, 'passed');
  assert.equal(JSON.parse(await readFile(paths.output)).kind, 'CloseoutProofV1');

  const before = await snapshot(paths); const matrix = JSON.parse(await readFile(paths.high));
  matrix.results[0].process.code = 1; await writeFile(paths.high, json(matrix));
  const failure = await runCli(paths);
  assert.notEqual(failure.code, 0); assert.equal(failure.stdout, ''); assert.deepEqual(await snapshot(paths), before);
});

