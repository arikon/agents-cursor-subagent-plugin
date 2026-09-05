#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_SEMANTIC_REGISTRY } from "./openspec-semantic-registry.mjs";
const baselineFields = [
  "**Goal.**",
  "**Non-goals.**",
  "**Public-invariant index.**",
  "**Owner map.**",
  "**Implementation-ready exit.**",
  "**Future-change candidates.**",
];

export function checkOpenSpecSemantics(rootPath = process.cwd(), registry = PROJECT_SEMANTIC_REGISTRY) {
  const root = resolve(rootPath);
  const errors = [];
  const changes = registry.changes.map(({ id }) => id);
  const changeContracts = Object.fromEntries(registry.changes.map((contract) => [contract.id, contract]));
  const { runtime: runtimeChange, facade: facadeChange, package: packageChange, eval: evalChange } = registry.roles;
  const resolvedRoots = new Map();

  function read(relativePath) {
    return readFileSync(resolve(root, relativePath), "utf8");
  }

  function changeRoot(change) {
    if (resolvedRoots.has(change)) return resolvedRoots.get(change);
    const active = `openspec/changes/${change}`;
    if (existsSync(resolve(root, active))) {
      resolvedRoots.set(change, active);
      return active;
    }
    const archive = resolve(root, "openspec/changes/archive");
    const matches = existsSync(archive)
      ? readdirSync(archive).filter((entry) => entry.endsWith(`-${change}`))
      : [];
    if (matches.length === 1) {
      const archived = `openspec/changes/archive/${matches[0]}`;
      resolvedRoots.set(change, archived);
      return archived;
    }
    errors.push(`cannot resolve exactly one active or archived change root for ${change}`);
    resolvedRoots.set(change, null);
    return null;
  }

  function requirementNames(change) {
    const resolvedRoot = changeRoot(change);
    const specPath = `${resolvedRoot}/specs`;
    const specFile = `${specPath}/${changeContracts[change].specDirectory}/spec.md`;
    return [...read(specFile).matchAll(/^### Requirement: (.+)$/gm)].map(
      ([, name]) => name,
    );
  }

  function indexedRequirements(design) {
    const match = design.match(/^\*\*Public-invariant index\.\*\* (.+)$/m);
    return match ? [...match[1].matchAll(/«([^»]+)»/g)].map(([, name]) => name) : [];
  }

  const requirementOwners = new Map();

const agents = read("AGENTS.md");
if (!agents.includes("## OpenSpec convergence")) {
  errors.push("AGENTS.md: missing single normative OpenSpec convergence policy");
}

const config = read("openspec/config.yaml");
if (!config.includes("schema: spec-driven")) {
  errors.push("openspec/config.yaml: must select the spec-driven schema");
}
if (!config.includes("defined only in AGENTS.md")) {
  errors.push("openspec/config.yaml: must point to, not duplicate, project governance");
}
if (/^v1_baseline:/m.test(config)) {
  errors.push("openspec/config.yaml: unsupported v1_baseline key is not a semantic gate");
}

const activeChanges = readdirSync(resolve(root, "openspec/changes"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "archive")
  .map((entry) => entry.name);
for (const change of activeChanges) {
  const designPath = `openspec/changes/${change}/design.md`;
  if (!changes.includes(change)) {
    errors.push(`openspec/changes/${change}: active change is absent from semantic-gate registry`);
  } else if (!existsSync(resolve(root, designPath)) || !read(designPath).includes("## v1 Contract Baseline")) {
    errors.push(`${designPath}: registered active change is missing v1 Contract Baseline`);
  }
}

for (const change of changes) {
  const rootPath = changeRoot(change);
  if (!rootPath) continue;
  const designPath = `${rootPath}/design.md`;
  const design = read(designPath);
  const proposal = read(`${rootPath}/proposal.md`);
  const contract = changeContracts[change];

  if (!design.includes("## v1 Contract Baseline")) {
    errors.push(`${designPath}: missing v1 Contract Baseline`);
  }
  for (const field of baselineFields) {
    if (!design.includes(field)) {
      errors.push(`${designPath}: baseline missing ${field}`);
    }
  }

  if (!design.includes(contract.ownerClaim)) {
    errors.push(`${designPath}: owner map does not declare ${contract.ownerClaim}`);
  }
  if (!proposal.includes(`- \`${contract.capability}\``)) {
    errors.push(`${rootPath}/proposal.md: missing New Capability ${contract.capability}`);
  }
  if (!read(`${rootPath}/specs/${contract.specDirectory}/spec.md`)) {
    errors.push(`${rootPath}: capability ${contract.capability} has no expected spec path`);
  }

  const requirements = requirementNames(change);
  const index = indexedRequirements(design);
  const modified = contract.modified;
  const expectedIndex = [...requirements, ...modified.map(({ requirement }) => requirement)];
  if (new Set(index).size !== index.length || index.length !== expectedIndex.length ||
      expectedIndex.some((requirement) => !index.includes(requirement))) {
    errors.push(`${designPath}: Public-invariant index must equal this change's requirement set`);
  }
  for (const requirement of requirements) {
    const previousOwner = requirementOwners.get(requirement);
    if (previousOwner) {
      errors.push(`requirement «${requirement}» has multiple owners: ${previousOwner}, ${change}`);
    } else {
      requirementOwners.set(requirement, change);
    }
    if (!design.includes(`«${requirement}»`)) {
      errors.push(`${designPath}: baseline does not index requirement «${requirement}»`);
    }
    if (!read(`${rootPath}/tasks.md`).includes(`«${requirement}»`)) {
      errors.push(`${rootPath}/tasks.md: no task references requirement «${requirement}»`);
    }
  }
  for (const { capability, requirement } of modified) {
    const deltaPath = `${rootPath}/specs/${capability}/spec.md`;
    const mainPath = `openspec/specs/${capability}/spec.md`;
    if (!proposal.includes(`- \`${capability}\``) || !read(deltaPath).includes("## MODIFIED Requirements") ||
        !read(deltaPath).includes(`### Requirement: ${requirement}`) || !read(mainPath).includes(`### Requirement: ${requirement}`)) {
      errors.push(`${rootPath}: invalid modified capability ${capability}/${requirement}`);
    }
    if (!design.includes(`«${requirement}»`) || !read(`${rootPath}/tasks.md`).includes(`«${requirement}»`)) {
      errors.push(`${rootPath}: modified requirement ${requirement} lacks baseline/task traceability`);
    }
  }

  for (const artifact of ["proposal.md", "design.md", "tasks.md"]) {
    const path = `${rootPath}/${artifact}`;
    if (/\b(?:MUST|SHALL)\b/.test(read(path))) {
      errors.push(`${path}: normative keyword belongs only in its delta spec`);
    }
  }
}

for (const change of [facadeChange, packageChange]) {
  const rootPath = changeRoot(change);
  if (!rootPath) continue;
  const specArtifact = `specs/${changeContracts[change].specDirectory}/spec.md`;
  for (const artifact of ["proposal.md", "design.md", "tasks.md", specArtifact]) {
    const contents = read(`${rootPath}/${artifact}`);
    for (const internal of ["SessionRecord", "RuntimeEvent", "pendingRequests", "failure_kind"]) {
      if (contents.includes(internal)) {
        errors.push(`${change}/${artifact}: references runtime internal ${internal}`);
      }
    }
  }
}

const evalRoot = changeRoot(evalChange);
const evalSpec = evalRoot ? read(`${evalRoot}/specs/${changeContracts[evalChange].specDirectory}/spec.md`) : '';
const evalDesign = evalRoot ? read(`${evalRoot}/design.md`) : '';
const evalTasks = evalRoot ? read(`${evalRoot}/tasks.md`) : '';
for (const facadeRequirement of ["«Skill workflow делегирования»", "«Workspace discipline делегирования»"]) {
  if (!evalSpec.includes(facadeRequirement)) {
    errors.push(`skill eval spec: missing facade owner reference ${facadeRequirement}`);
  }
}
if (!evalSpec.includes("package-owned bootstrap") || !evalDesign.includes("package-owned bootstrap") ||
    !evalDesign.includes("«Внешний контракт bootstrap»") || !evalDesign.includes("«Проверяемая чистая установка»") ||
    !evalDesign.includes("«Ограниченный жизненный цикл ACP-процесса»")) {
  errors.push("skill eval artifacts: must reuse package-owned bootstrap rather than create a parallel install path");
}
if (!evalDesign.includes("## Scenario Matrix") || !evalDesign.includes("scenario_id")) {
  errors.push("skill eval design: missing deterministic scenario matrix");
}
for (const scenario of registry.evalScenarioIds) {
  if (!evalDesign.includes(`\`${scenario}\``)) errors.push(`skill eval design: scenario matrix missing ${scenario}`);
}
for (const field of ["schema_version", "actual_task_outcome", "reported_task_outcome", "fixture_assertion_outcome", "evidence_publication_status", "evidence_ref", "cleanup_status", "failure_stage", "not_observed", "not_reported"]) {
  if (!evalSpec.includes(field)) errors.push(`skill eval spec: EvalResultV1 missing ${field}`);
}
if (evalTasks.includes("повторного пишущего delegate")) {
  errors.push("skill eval tasks: multi-delegate orchestration is future scope, not this v1 baseline");
}
if (!evalSpec.includes("the transcript exists only inside published evidence")) {
  errors.push("skill eval spec: transcript must remain conditional on published evidence");
}
if (/eval_status[^\n]{0,160}external_adapter_drift|external_adapter_drift[^\n]{0,160}eval_status/.test(evalSpec)) {
  errors.push("skill eval spec: external_adapter_drift is adapter classification, not EvalResultV1 eval_status");
}

const facadeRoot = changeRoot(facadeChange);
const facadeSpec = facadeRoot
  ? read(`${facadeRoot}/specs/${changeContracts[facadeChange].specDirectory}/spec.md`)
  : '';
for (const wireTerm of ["CallToolResult", "SessionEnvelope", "TurnEnvelope", "DelegateError", "delegated:true"]) {
  if (facadeSpec.includes(wireTerm)) {
    errors.push(`facade spec: runtime owns MCP wire term ${wireTerm}`);
  }
}

const runtimeRoot = changeRoot(runtimeChange);
const runtimeSpec = runtimeRoot
  ? read(`${runtimeRoot}/specs/${changeContracts[runtimeChange].specDirectory}/spec.md`)
  : '';
for (const claim of [
  "единственный нормативный источник переходов",
  "единственным владельцем MCP schemas и всех response envelopes",
  "единственный владелец численных bounds",
]) {
  if (!runtimeSpec.includes(claim)) {
    errors.push(`runtime spec: missing SSOT ownership claim: ${claim}`);
  }
}

  return {
    ok: errors.length === 0,
    errors,
    checkedChanges: changes.length,
  };
}

export function runOpenSpecSemanticsCli(rootPath = process.cwd(), output = console, registry = PROJECT_SEMANTIC_REGISTRY) {
  const result = checkOpenSpecSemantics(rootPath, registry);
  if (!result.ok) {
    output.error("OpenSpec semantic gate failed:");
    for (const error of result.errors) output.error(`- ${error}`);
    return 1;
  }
  output.log(`OpenSpec mechanical semantic gate passed for ${result.checkedChanges} changes; independent critic establishes semantic readiness.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runOpenSpecSemanticsCli();
}
