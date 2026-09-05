import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  checkOpenSpecSemantics,
  runOpenSpecSemanticsCli,
} from '../scripts/check-openspec-semantics.mjs';

const runtimeChange = 'fixture-runtime';
const facadeChange = 'fixture-facade';
const packageChange = 'fixture-package';
const evalChange = 'fixture-eval';
const supervisorChange = 'fixture-supervisor';
const evalScenarios = ['fixture-client', 'fixture-question', 'fixture-plan'];

const contracts = {
  [runtimeChange]: {
    capability: 'fixture-runtime-capability',
    ownerClaim: 'Этот change owns runtime requirements',
    requirements: ['Runtime fixture requirement'],
  },
  [facadeChange]: {
    capability: 'fixture-facade-capability',
    ownerClaim: 'Этот change owns only composition',
    requirements: [
      'Workspace discipline делегирования',
      'Skill workflow делегирования',
    ],
  },
  [packageChange]: {
    capability: 'fixture-package-capability',
    ownerClaim: 'Этот change owns install/discovery и release canary',
    requirements: [
      'Внешний контракт bootstrap',
      'Проверяемая чистая установка',
      'Ограниченный жизненный цикл ACP-процесса',
    ],
  },
  [evalChange]: {
    capability: 'fixture-eval-capability',
    ownerClaim: 'Этот change owns only Codex behavior-eval orchestration and',
    requirements: [
      'Eval fixture requirement',
    ],
    modifiedRequirements: ['Skill workflow делегирования'],
  },
  [supervisorChange]: {
    capability: 'fixture-supervisor-capability',
    ownerClaim: '`fixture-supervisor-capability` owns runner lifecycle, artifacts, reporting and coverage gate',
    requirementIds: ['NTS-3'],
    requirements: [
      'Supervisor fixture requirement',
    ],
  },
};

const registry = {
  changes: Object.entries(contracts).map(([id, contract]) => ({
    id,
    capability: contract.capability,
    specDirectory: contract.capability,
    ownerClaim: contract.ownerClaim,
    modified: contract.modifiedRequirements
      ? contract.modifiedRequirements.map((requirement) => ({
        capability: contracts[facadeChange].capability,
        requirement,
      }))
      : [],
  })),
  roles: {
    runtime: runtimeChange,
    facade: facadeChange,
    package: packageChange,
    eval: evalChange,
    supervisor: supervisorChange,
  },
};

async function write(root, relativePath, contents) {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function append(root, relativePath, suffix) {
  const target = join(root, relativePath);
  await writeFile(target, `${await readFile(target, 'utf8')}${suffix}`);
}

function designFor(contract) {
  const indexed = [...contract.requirements, ...(contract.modifiedRequirements ?? [])]
    .map((requirement, index) => contract.requirementIds?.[index]
      ? `\`${contract.requirementIds[index]}\` → «${requirement}»`
      : `«${requirement}»`)
    .join(', ');
  return [
    '# Design',
    '## v1 Contract Baseline',
    '**Goal.** Fixture goal.',
    '**Non-goals.** Fixture non-goals.',
    `**Public-invariant index.** ${indexed}`,
    `**Owner map.** ${contract.ownerClaim}`,
    '**Implementation-ready exit.** Fixture exit.',
    '**Future-change candidates.** None.',
    '',
  ].join('\n');
}

function specFor(contract) {
  return contract.requirements
    .map((requirement) => `### Requirement: ${requirement}\nThe fixture exercises this semantic contract.\n`)
    .join('\n');
}

function tasksFor(contract) {
  return [...contract.requirements, ...(contract.modifiedRequirements ?? [])]
    .map((requirement) => `- [ ] Verify «${requirement}»`)
    .join('\n');
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openspec-semantics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'AGENTS.md', '## OpenSpec convergence\n');
  await write(
    root,
    'openspec/config.yaml',
    'schema: spec-driven\n# Project governance is defined only in AGENTS.md.\n',
  );

  for (const [change, contract] of Object.entries(contracts)) {
    const changeRoot = `openspec/changes/${change}`;
    await write(root, `${changeRoot}/proposal.md`, `## New Capabilities\n- \`${contract.capability}\`\n`);
    await write(root, `${changeRoot}/design.md`, designFor(contract));
    await write(root, `${changeRoot}/tasks.md`, tasksFor(contract));
    await write(root, `${changeRoot}/specs/${contract.capability}/spec.md`, specFor(contract));
  }

  await write(
    root,
    `openspec/specs/${contracts[facadeChange].capability}/spec.md`,
    '### Requirement: Skill workflow делегирования\nMain capability contract.\n',
  );
  await write(
    root,
    `openspec/changes/${evalChange}/specs/${contracts[facadeChange].capability}/spec.md`,
    '## MODIFIED Requirements\n### Requirement: Skill workflow делегирования\nMain capability contract.\nModified contract.\n',
  );

  await append(root, `openspec/changes/${evalChange}/proposal.md`, `- \`${contracts[facadeChange].capability}\`\n`);
  await append(root, `openspec/changes/${evalChange}/design.md`, [
    'package-owned bootstrap reuses «Внешний контракт bootstrap», «Проверяемая чистая установка» and «Ограниченный жизненный цикл ACP-процесса».',
    '## Scenario Matrix',
    'scenario_id',
    ...evalScenarios.map((scenario) => `- \`${scenario}\``),
    '',
  ].join('\n'));
  await append(root, `openspec/changes/${evalChange}/specs/${contracts[evalChange].capability}/spec.md`, [
    'References «Skill workflow делегирования» and «Workspace discipline делегирования».',
    'Uses package-owned bootstrap.',
    'EvalResultV1 fields: schema_version actual_task_outcome reported_task_outcome fixture_assertion_outcome evidence_publication_status evidence_ref cleanup_status failure_stage not_observed not_reported.',
    '"eval_status": "pass | skipped | integration_failure | agent_behavior_mismatch",',
    'the transcript exists only inside published evidence',
    '',
  ].join('\n'));
  await append(root, `openspec/changes/${runtimeChange}/specs/${contracts[runtimeChange].capability}/spec.md`, [
    'единственный нормативный источник переходов',
    'единственным владельцем MCP schemas и всех response envelopes',
    'единственный владелец численных bounds',
    '',
  ].join('\n'));
  return root;
}

function run(root) {
  return checkOpenSpecSemantics(root, registry);
}

async function withCorpusOwnerRequirements(root, ownerRequirements) {
  const corpusPath = 'evals/cursor-subagent-scenarios.v1.json';
  await write(root, corpusPath, JSON.stringify({
    schema_version: 1,
    scenarios: [{ owner_requirements: ownerRequirements }],
  }));
  return {
    ...registry,
    changes: registry.changes.map((contract) => contract.id === evalChange
      ? { ...contract, corpusPath }
      : contract),
  };
}

function assertRejected(result, expected) {
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => new RegExp(expected).test(error)),
    `expected diagnostic ${expected}; received ${result.errors.join('; ')}`,
  );
}

function recordingOutput() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    output: {
      log: (message) => stdout.push(message),
      error: (message) => stderr.push(message),
    },
  };
}

async function replace(root, path, from, to = '') {
  const target = join(root, path);
  const source = await readFile(target, 'utf8');
  assert.ok(source.includes(from), `${path} lacks fixture token`);
  await writeFile(target, source.replaceAll(from, to));
}

async function addReferenceOnlyToolingChange(root, {
  marker = 'schema: spec-driven\nskip_specs: true\n',
  registryRequirementId = 'NTS-3',
  registryRequirement = 'Supervisor fixture requirement',
  registryOwnerChange = supervisorChange,
  artifactRequirementId = registryRequirementId,
  artifactRequirement = registryRequirement,
  withReferences = true,
  withDelta = false,
  capabilityClaim = false,
} = {}) {
  const toolingChange = 'fixture-tooling';
  const toolingOwner = '`fixture-supervisor-capability` retains tooling ownership';
  const changeRoot = `openspec/changes/${toolingChange}`;
  if (marker !== null) await write(root, `${changeRoot}/.openspec.yaml`, marker);
  await write(root, `${changeRoot}/proposal.md`, capabilityClaim
    ? '## Capabilities\n\n- `fixture-tooling-capability`\n'
    : '## Capabilities\n\nNo capability changes.\n');
  await write(root, `${changeRoot}/design.md`, [
    '# Design',
    '## v1 Contract Baseline',
    '**Goal.** Fixture tooling goal.',
    '**Non-goals.** Fixture tooling non-goals.',
    `**Public-invariant index.** \`${artifactRequirementId}\` → «${artifactRequirement}»`,
    `**Owner map.** ${toolingOwner}`,
    '**Implementation-ready exit.** Fixture exit.',
    '**Future-change candidates.** None.',
    '',
  ].join('\n'));
  await write(root, `${changeRoot}/tasks.md`, `- [ ] Verify \`${artifactRequirementId}\` «${artifactRequirement}».\n`);
  if (withDelta) {
    await write(root, `${changeRoot}/specs/unexpected/spec.md`, '### Requirement: Unexpected delta\n');
  }
  return {
    ...registry,
    changes: [...registry.changes, {
      id: toolingChange,
      ownerClaim: toolingOwner,
      modified: [],
      references: withReferences ? [{
        ownerChange: registryOwnerChange,
        capability: contracts[supervisorChange].capability,
        requirementId: registryRequirementId,
        requirement: registryRequirement,
      }] : [],
    }],
  };
}

test('semantic gate accepts a complete five-change contract tree', async (t) => {
  const root = await fixture(t);
  const result = run(root);
  assert.deepEqual(result, { ok: true, errors: [], checkedChanges: 5 });
});

test('semantic gate accepts corpus owner requirements from authoritative main specs', async (t) => {
  const root = await fixture(t);
  const corpusRegistry = await withCorpusOwnerRequirements(root, [{
    capability: contracts[facadeChange].capability,
    requirement: 'Skill workflow делегирования',
  }]);
  assert.deepEqual(checkOpenSpecSemantics(root, corpusRegistry), {
    ok: true,
    errors: [],
    checkedChanges: 5,
  });
});

test('semantic gate rejects drift in an exact owned requirement label', async (t) => {
  const root = await fixture(t);
  const exactLabelRegistry = {
    ...registry,
    changes: registry.changes.map((contract) => contract.id === evalChange
      ? { ...contract, ownedRequirements: ['Eval fixture requirement'] }
      : contract),
  };
  await replace(
    root,
    `openspec/changes/${evalChange}/specs/${contracts[evalChange].capability}/spec.md`,
    'Eval fixture requirement',
    'Renamed eval fixture requirement',
  );
  assertRejected(
    checkOpenSpecSemantics(root, exactLabelRegistry),
    'owned requirement labels differ from semantic-gate registry',
  );
});

for (const { name, ownerRequirements } of [
  {
    name: 'unknown corpus owner capability',
    ownerRequirements: [{ capability: 'missing-capability', requirement: 'Skill workflow делегирования' }],
  },
  {
    name: 'unknown corpus owner requirement',
    ownerRequirements: [{ capability: contracts[facadeChange].capability, requirement: 'Missing requirement' }],
  },
  {
    name: 'expanded corpus owner reference shape',
    ownerRequirements: [{ capability: contracts[facadeChange].capability, requirement: 'Skill workflow делегирования', scenario_id: 'not-semantic-owner-data' }],
  },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t);
    const corpusRegistry = await withCorpusOwnerRequirements(root, ownerRequirements);
    assertRejected(checkOpenSpecSemantics(root, corpusRegistry), 'invalid owner requirement');
  });
}

for (const { name, content, expected } of [
  { name: 'malformed corpus owner document', content: '{', expected: 'cannot read corpus owner requirements' },
  { name: 'corpus without scenarios', content: JSON.stringify({ schema_version: 1 }), expected: 'cannot inspect corpus owner requirements' },
  { name: 'corpus row without owner requirements', content: JSON.stringify({ schema_version: 1, scenarios: [{}] }), expected: 'lacks owner_requirements' },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t);
    const corpusRegistry = await withCorpusOwnerRequirements(root, []);
    await write(root, 'evals/cursor-subagent-scenarios.v1.json', content);
    assertRejected(checkOpenSpecSemantics(root, corpusRegistry), expected);
  });
}

test('semantic gate accepts a registered skip-specs tooling change without a capability delta', async (t) => {
  const root = await fixture(t);
  const toolingRegistry = await addReferenceOnlyToolingChange(root);
  assert.deepEqual(checkOpenSpecSemantics(root, toolingRegistry), {
    ok: true,
    errors: [],
    checkedChanges: 6,
  });
});

for (const { name, options, expected } of [
  {
    name: 'reference-only change without skip_specs marker',
    options: { marker: null },
    expected: 'reference-only change must declare top-level skip_specs: true',
  },
  {
    name: 'reference-only change with conflicting skip_specs marker',
    options: { marker: 'schema: spec-driven\nskip_specs: false\n' },
    expected: 'reference-only change must declare top-level skip_specs: true',
  },
  {
    name: 'reference-only change with an invalid owner reference',
    options: { registryRequirement: 'Missing owner requirement' },
    expected: 'invalid owner reference',
  },
  {
    name: 'reference-only change with a missing owner change',
    options: { registryOwnerChange: 'missing-owner-change' },
    expected: 'invalid owner reference',
  },
  {
    name: 'reference-only change without an owner reference',
    options: { withReferences: false },
    expected: 'must declare an existing owner requirement',
  },
  {
    name: 'reference-only change with artifact traceability drift',
    options: { artifactRequirement: 'Different artifact requirement' },
    expected: 'Public-invariant index|lacks baseline/task traceability',
  },
  {
    name: 'reference-only change with an invalid requirement ID',
    options: { registryRequirementId: 'NTS-999' },
    expected: 'invalid owner reference',
  },
  {
    name: 'reference-only change with a capability delta',
    options: { withDelta: true },
    expected: 'cannot contain capability deltas',
  },
  {
    name: 'reference-only change with a capability claim',
    options: { capabilityClaim: true },
    expected: 'reference-only change cannot claim a capability',
  },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t);
    const toolingRegistry = await addReferenceOnlyToolingChange(root, options);
    assertRejected(checkOpenSpecSemantics(root, toolingRegistry), expected);
  });
}

test('semantic gate rejects skip_specs on a capability-owning change', async (t) => {
  const root = await fixture(t);
  await write(
    root,
    `openspec/changes/${supervisorChange}/.openspec.yaml`,
    'schema: spec-driven\nskip_specs: true\n',
  );
  assertRejected(run(root), 'skip_specs change must be reference-only');
});

test('CLI contract publishes a terminal success verdict', async (t) => {
  const root = await fixture(t);
  const recording = recordingOutput();
  assert.equal(runOpenSpecSemanticsCli(root, recording.output, registry), 0);
  assert.deepEqual(recording.stderr, []);
  assert.match(recording.stdout.join('\n'), /passed for 5 changes/);
});

test('CLI contract publishes every semantic failure and a non-zero verdict', async (t) => {
  const root = await fixture(t);
  await write(root, 'AGENTS.md', 'No project governance.\n');
  await append(root, 'openspec/config.yaml', 'v1_baseline: duplicated\n');
  const recording = recordingOutput();
  assert.equal(runOpenSpecSemanticsCli(root, recording.output, registry), 1);
  assert.equal(recording.stdout.length, 0);
  assert.match(recording.stderr.join('\n'), /OpenSpec semantic gate failed/);
  assert.match(recording.stderr.join('\n'), /AGENTS\.md/);
  assert.match(recording.stderr.join('\n'), /unsupported v1_baseline/);
});

for (const { name, path, from, to = '', expected } of [
  { name: 'missing project convergence policy', path: 'AGENTS.md', from: '## OpenSpec convergence', expected: 'missing single normative OpenSpec convergence policy' },
  { name: 'unsupported schema', path: 'openspec/config.yaml', from: 'schema: spec-driven', to: 'schema: custom', expected: 'must select the spec-driven schema' },
  { name: 'duplicated project governance', path: 'openspec/config.yaml', from: 'defined only in AGENTS.md', to: 'defined here', expected: 'must point to, not duplicate' },
  { name: 'missing baseline field', path: `openspec/changes/${supervisorChange}/design.md`, from: '**Future-change candidates.** None.', expected: 'baseline missing' },
  { name: 'missing capability declaration', path: `openspec/changes/${supervisorChange}/proposal.md`, from: `- \`${contracts[supervisorChange].capability}\``, expected: 'missing capability' },
  { name: 'duplicated requirement ownership', path: `openspec/changes/${facadeChange}/specs/${contracts[facadeChange].capability}/spec.md`, from: 'Workspace discipline делегирования', to: 'Runtime fixture requirement', expected: 'multiple owners' },
  { name: 'modified requirement without task traceability', path: `openspec/changes/${evalChange}/tasks.md`, from: '«Skill workflow делегирования»', expected: 'modified requirement Skill workflow делегирования lacks baseline/task traceability' },
  { name: 'normative keyword outside delta spec', path: `openspec/changes/${supervisorChange}/proposal.md`, from: '## New Capabilities', to: '## New Capabilities\nMUST remain normative.', expected: 'normative keyword belongs only in its delta spec' },
  { name: 'runtime internal leaked into facade artifacts', path: `openspec/changes/${facadeChange}/proposal.md`, from: '## New Capabilities', to: '## New Capabilities\nSessionRecord', expected: 'references runtime internal SessionRecord' },
  { name: 'missing facade owner reference', path: `openspec/changes/${evalChange}/specs/${contracts[evalChange].capability}/spec.md`, from: '«Workspace discipline делегирования»', expected: 'missing facade owner reference' },
  { name: 'missing scenario matrix contract', path: `openspec/changes/${evalChange}/design.md`, from: '## Scenario Matrix', expected: 'missing deterministic scenario matrix' },
  { name: 'future multi-delegate scope in current tasks', path: `openspec/changes/${evalChange}/tasks.md`, from: '- [ ] Verify', to: 'повторного пишущего delegate\n- [ ] Verify', expected: 'multi-delegate orchestration is future scope' },
  { name: 'runtime wire term leaked into facade spec', path: `openspec/changes/${facadeChange}/specs/${contracts[facadeChange].capability}/spec.md`, from: 'The fixture exercises this semantic contract.', to: 'CallToolResult\nThe fixture exercises this semantic contract.', expected: 'runtime owns MCP wire term CallToolResult' },
  { name: 'missing runtime SSOT claim', path: `openspec/changes/${runtimeChange}/specs/${contracts[runtimeChange].capability}/spec.md`, from: 'единственный владелец численных bounds', expected: 'missing SSOT ownership claim' },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await replace(root, path, from, to);
    assertRejected(run(root), expected);
  });
}

test('semantic gate resolves a registered change from the archive', async (t) => {
  const root = await fixture(t);
  const active = join(root, `openspec/changes/${packageChange}`);
  const archived = join(root, `openspec/changes/archive/2026-09-04-${packageChange}`);
  await mkdir(dirname(archived), { recursive: true });
  await rename(active, archived);
  assert.deepEqual(run(root), { ok: true, errors: [], checkedChanges: 5 });
});

test('semantic gate diagnoses missing and ambiguous roots for every registered role', async (t) => {
  for (const change of [runtimeChange, facadeChange, packageChange, evalChange]) {
    for (const archiveDates of [[], ['2026-09-03', '2026-09-04']]) {
      const root = await fixture(t);
      await rm(join(root, `openspec/changes/${change}`), { recursive: true });
      for (const date of archiveDates) {
        await write(root, `openspec/changes/archive/${date}-${change}/placeholder`, 'fixture');
      }
      const result = run(root);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.includes(`cannot resolve exactly one active or archived change root for ${change}`)));
    }
  }
});

test('semantic gate rejects an empty capability spec', async (t) => {
  const root = await fixture(t);
  await write(
    root,
    `openspec/changes/${supervisorChange}/specs/${contracts[supervisorChange].capability}/spec.md`,
    '',
  );
  assertRejected(run(root), 'capability fixture-supervisor-capability has no expected spec path');
});

for (const { name, path, from, to = '', expected } of [
  { name: 'missing modified delta', path: `openspec/changes/${evalChange}/specs/${contracts[facadeChange].capability}/spec.md`, from: '## MODIFIED Requirements', expected: 'invalid modified capability' },
  { name: 'orphaned authority rule', path: `openspec/changes/${evalChange}/specs/${contracts[facadeChange].capability}/spec.md`, from: '### Requirement: Skill workflow делегирования', expected: 'invalid modified capability' },
  { name: 'incomplete modified requirement copy', path: `openspec/changes/${evalChange}/specs/${contracts[facadeChange].capability}/spec.md`, from: 'Main capability contract.', expected: 'invalid modified capability' },
  { name: 'incomplete EvalResultV1', path: `openspec/changes/${evalChange}/specs/${contracts[evalChange].capability}/spec.md`, from: 'failure_stage', expected: 'EvalResultV1 missing failure_stage' },
  { name: 'unconditional transcript', path: `openspec/changes/${evalChange}/specs/${contracts[evalChange].capability}/spec.md`, from: 'the transcript exists only inside published evidence', expected: 'transcript must remain conditional' },
  { name: 'invalid external adapter eval status', path: `openspec/changes/${evalChange}/specs/${contracts[evalChange].capability}/spec.md`, from: '"eval_status": "pass | skipped | integration_failure | agent_behavior_mismatch",', to: '"eval_status": "external_adapter_drift",', expected: 'external_adapter_drift is adapter classification' },
  { name: 'inaccurate owner reference', path: `openspec/changes/${evalChange}/specs/${contracts[evalChange].capability}/spec.md`, from: 'package-owned bootstrap', expected: 'must reuse package-owned bootstrap' },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await replace(root, path, from, to);
    const result = run(root);
    assertRejected(result, expected);
  });
}

test('semantic gate rejects an unregistered active directory without a baseline', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'openspec/changes/unregistered-without-baseline'));
  const result = run(root);
  assertRejected(result, 'active change is absent from semantic-gate registry');
});

test('semantic gate rejects an unregistered active directory with a baseline', async (t) => {
  const root = await fixture(t);
  await write(
    root,
    'openspec/changes/unregistered-with-baseline/design.md',
    '## v1 Contract Baseline\n',
  );
  const result = run(root);
  assertRejected(result, 'active change is absent from semantic-gate registry');
});

test('semantic gate rejects a registered active change without a baseline', async (t) => {
  const root = await fixture(t);
  await replace(root, `openspec/changes/${supervisorChange}/design.md`, '## v1 Contract Baseline');
  const result = run(root);
  assertRejected(result, 'registered active change is missing v1 Contract Baseline');
});

for (const { name, path, from, expected } of [
  { name: 'missing node-supervisor owner', path: `openspec/changes/${supervisorChange}/design.md`, from: contracts[supervisorChange].ownerClaim, expected: 'owner map does not declare' },
  { name: 'broken NTS id mapping', path: `openspec/changes/${supervisorChange}/design.md`, from: '«Supervisor fixture requirement»', expected: 'Public-invariant index must equal' },
  { name: 'missing NTS task trace', path: `openspec/changes/${supervisorChange}/tasks.md`, from: '«Supervisor fixture requirement»', expected: 'no task references requirement' },
]) {
  test(`semantic gate rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await replace(root, path, from);
    const result = run(root);
    assertRejected(result, expected);
  });
}
