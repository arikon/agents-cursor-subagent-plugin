#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const changes = [
  "harden-cursor-acp-session-runtime",
  "add-cursor-delegation-workflow",
  "package-cursor-subagent-plugin",
  "add-cursor-subagent-skill-evals",
  "add-durable-node-test-supervisor",
];
const changeContracts = {
  "harden-cursor-acp-session-runtime": {
    capability: "cursor-acp-session-runtime",
    specDirectory: "cursor-acp-session-runtime",
    ownerClaim: "Этот change owns runtime requirements",
  },
  "add-cursor-delegation-workflow": {
    capability: "cursor-task-delegation",
    specDirectory: "cursor-task-delegation",
    ownerClaim: "Этот change owns only composition",
  },
  "package-cursor-subagent-plugin": {
    capability: "cursor-plugin-distribution",
    specDirectory: "cursor-plugin-distribution",
    ownerClaim: "Этот change owns install/discovery и release canary",
  },
  "add-cursor-subagent-skill-evals": {
    capability: "cursor-subagent-skill-evals",
    specDirectory: "cursor-subagent-skill-evals",
    ownerClaim: "Этот change owns only Codex behavior-eval orchestration and",
    modified: [{ capability: "cursor-task-delegation", requirement: "Skill workflow делегирования" }],
  },
  "add-durable-node-test-supervisor": {
    capability: "node-test-supervision",
    specDirectory: "node-test-supervision",
    ownerClaim: "`node-test-supervision` owns runner lifecycle, artifacts, reporting and coverage gate",
  },
};
const baselineFields = [
  "**Goal.**",
  "**Non-goals.**",
  "**Public-invariant index.**",
  "**Owner map.**",
  "**Implementation-ready exit.**",
  "**Future-change candidates.**",
];
const errors = [];

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function changeRoot(change) {
  const active = `openspec/changes/${change}`;
  if (existsSync(resolve(root, active))) return active;
  const archive = resolve(root, "openspec/changes/archive");
  const matches = existsSync(archive)
    ? readdirSync(archive).filter((entry) => entry.endsWith(`-${change}`))
    : [];
  if (matches.length === 1) return `openspec/changes/archive/${matches[0]}`;
  errors.push(`cannot resolve exactly one active or archived change root for ${change}`);
  return active;
}

function requireText(relativePath, text) {
  if (!read(relativePath).includes(text)) {
    errors.push(`${relativePath}: missing ${text}`);
  }
}

function requirementNames(change) {
  const specPath = `${changeRoot(change)}/specs`;
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
  const modified = contract.modified || [];
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

for (const change of [
  "add-cursor-delegation-workflow",
  "package-cursor-subagent-plugin",
]) {
  const rootPath = changeRoot(change);
  const specArtifact = change === "add-cursor-delegation-workflow"
    ? "specs/cursor-task-delegation/spec.md"
    : "specs/cursor-plugin-distribution/spec.md";
  for (const artifact of ["proposal.md", "design.md", "tasks.md", specArtifact]) {
    const contents = read(`${rootPath}/${artifact}`);
    for (const internal of ["SessionRecord", "RuntimeEvent", "pendingRequests", "failure_kind"]) {
      if (contents.includes(internal)) {
        errors.push(`${change}/${artifact}: references runtime internal ${internal}`);
      }
    }
  }
}

const evalRoot = changeRoot("add-cursor-subagent-skill-evals");
const evalSpec = read(`${evalRoot}/specs/cursor-subagent-skill-evals/spec.md`);
const evalDesign = read(`${evalRoot}/design.md`);
const evalTasks = read(`${evalRoot}/tasks.md`);
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
for (const scenario of ["client-happy", "model-question", "model-plan", "model-permission-covered", "model-permission-expansion", "model-semantic-failure", "live-marker"]) {
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

const facadeSpec = read(
  `${changeRoot("add-cursor-delegation-workflow")}/specs/cursor-task-delegation/spec.md`,
);
for (const wireTerm of ["CallToolResult", "SessionEnvelope", "TurnEnvelope", "DelegateError", "delegated:true"]) {
  if (facadeSpec.includes(wireTerm)) {
    errors.push(`facade spec: runtime owns MCP wire term ${wireTerm}`);
  }
}

const runtimeSpec = read(
  `${changeRoot("harden-cursor-acp-session-runtime")}/specs/cursor-acp-session-runtime/spec.md`,
);
for (const claim of [
  "единственный нормативный источник переходов",
  "единственным владельцем MCP schemas и всех response envelopes",
  "единственный владелец численных bounds",
]) {
  if (!runtimeSpec.includes(claim)) {
    errors.push(`runtime spec: missing SSOT ownership claim: ${claim}`);
  }
}

if (errors.length > 0) {
  console.error("OpenSpec semantic gate failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`OpenSpec mechanical semantic gate passed for ${changes.length} changes; independent critic establishes semantic readiness.`);
}
