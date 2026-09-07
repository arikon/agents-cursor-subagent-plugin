#!/usr/bin/env node

import { createHash } from "node:crypto";
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

export function replacementLineageReaches(registry, capability, requirement, fromDigest, targetDigest) {
  const edges = registry.changes.flatMap(({ modified = [] }) => modified)
    .filter((entry) => entry.capability === capability && entry.requirement === requirement
      && typeof entry.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(entry.sourceDigest)
      && typeof entry.replacementDigest === "string" && /^[a-f0-9]{64}$/.test(entry.replacementDigest));
  const pending = [fromDigest];
  const seen = new Set();
  while (pending.length) {
    const digest = pending.shift();
    if (digest === targetDigest) return true;
    if (seen.has(digest)) continue;
    seen.add(digest);
    for (const edge of edges) if (edge.sourceDigest === digest) pending.push(edge.replacementDigest);
  }
  return false;
}

export function hasFixedEvalCorpusCount(requirement, block) {
  if (!['Разделённые eval lanes и evidence загрузки skill', 'Cost-aware execution policy'].includes(requirement)) return false;
  return /(?:\b\d+\b|\b(?:six|seven)\b|(?:шест|сем)[а-яё]*)\s+`?(?:programmed|runs?|rows?)/iu.test(block);
}

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
    if (!changeContracts[change].capability) return [];
    const resolvedRoot = changeRoot(change);
    const specPath = `${resolvedRoot}/specs`;
    const specFile = `${specPath}/${changeContracts[change].specDirectory}/spec.md`;
    const modifiedNames = new Set(changeContracts[change].modified.map(({ requirement }) => requirement));
    return [...read(specFile).matchAll(/^### Requirement: (.+)$/gm)].map(
      ([, name]) => name,
    ).filter((name) => !modifiedNames.has(name));
  }

  function declaresSkipSpecs(resolvedRoot) {
    const markerPath = `${resolvedRoot}/.openspec.yaml`;
    if (!existsSync(resolve(root, markerPath))) return false;
    const match = read(markerPath).match(/^skip_specs:[ \t]*(true|false)[ \t]*(?:#.*)?$/m);
    return match?.[1] === "true";
  }

  function indexedRequirements(design) {
    const match = design.match(/^\*\*Public-invariant index\.\*\* (.+)$/m);
    return match ? [...match[1].matchAll(/«([^»]+)»/g)].map(([, name]) => name) : [];
  }

  function indexedRequirementMappings(design) {
    const match = design.match(/^\*\*Public-invariant index\.\*\* (.+)$/m);
    return match
      ? [...match[1].matchAll(/`([^`]+)`\s*→\s*«([^»]+)»/g)]
        .map(([, requirementId, requirement]) => ({ requirementId, requirement }))
      : [];
  }

  function indexedInvariantIds(design, admittedIds) {
    const match = design.match(/^\*\*Public-invariant index\.\*\* (.+)$/m);
    if (!match) return [];
    const admitted = new Set(admittedIds);
    return [...match[1].matchAll(/`([^`]+)`/g)].map(([, id]) => id).filter((id) => admitted.has(id));
  }

  function requirementBlock(contents, requirement) {
    const marker = `### Requirement: ${requirement}`;
    const start = [...contents.matchAll(/^### Requirement: (.+)$/gm)]
      .find(([, name]) => name === requirement)?.index ?? -1;
    if (start === -1) return "";
    const remainder = contents.slice(start);
    const next = remainder.slice(marker.length).search(/\n(?:### Requirement:|## (?:ADDED|MODIFIED|REMOVED|RENAMED) Requirements)/);
    return next === -1 ? remainder.trim() : remainder.slice(0, marker.length + next).trim();
  }

  function preservesRequirement(source, modified) {
    const sourceLines = source.split("\n").map((line) => line.trim()).filter(Boolean);
    const modifiedLines = modified.split("\n").map((line) => line.trim()).filter(Boolean);
    let cursor = 0;
    for (const line of modifiedLines) {
      if (line === sourceLines[cursor]) cursor += 1;
    }
    return cursor === sourceLines.length;
  }

  function preservesHistoricalRequirement(source, modified) {
    const paragraphs = (block) => block.split(/\n{2,}/u)
      .map((paragraph) => paragraph.trim().replace(/\s+/gu, " ")).filter(Boolean);
    const sourceParagraphs = paragraphs(source);
    const modifiedParagraphs = paragraphs(modified);
    let cursor = 0;
    for (const candidate of modifiedParagraphs) {
      if (cursor === sourceParagraphs.length) break;
      const expected = sourceParagraphs[cursor];
      if (candidate === expected || ` ${candidate} `.includes(` ${expected} `)) cursor += 1;
    }
    return cursor === sourceParagraphs.length;
  }

  function authoritativeRequirements(contract) {
    const specsRoot = resolve(root, "openspec/specs");
    const requirementsByCapability = new Map(readdirSync(specsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const specPath = `openspec/specs/${entry.name}/spec.md`;
        const requirements = existsSync(resolve(root, specPath))
          ? [...read(specPath).matchAll(/^### Requirement: (.+)$/gm)].map(([, name]) => name)
          : [];
        return [entry.name, new Set(requirements)];
      }));
    for (const ownerChange of [contract.id]) {
      const ownerRoot = changeRoot(ownerChange);
      const deltaRoot = ownerRoot && resolve(root, `${ownerRoot}/specs`);
      if (deltaRoot && existsSync(deltaRoot)) {
        for (const entry of readdirSync(deltaRoot, { withFileTypes: true }).filter((candidate) => candidate.isDirectory())) {
          const deltaPath = `${ownerRoot}/specs/${entry.name}/spec.md`;
          if (!existsSync(resolve(root, deltaPath))) continue;
          const names = [...read(deltaPath).matchAll(/^### Requirement: (.+)$/gm)].map(([, name]) => name);
          const admitted = requirementsByCapability.get(entry.name) ?? new Set();
          names.forEach((name) => admitted.add(name));
          requirementsByCapability.set(entry.name, admitted);
        }
      }
    }
    return requirementsByCapability;
  }

  function validateCorpusOwnerRequirements(contract) {
    if (!contract.corpusPath) return;
    let corpus;
    try {
      corpus = JSON.parse(read(contract.corpusPath));
    } catch (error) {
      errors.push(`${contract.corpusPath}: cannot read corpus owner requirements: ${error.message}`);
      return;
    }
    if (!Array.isArray(corpus.scenarios)) {
      errors.push(`${contract.corpusPath}: cannot inspect corpus owner requirements`);
      return;
    }
    const contractSpecsRoot = `${changeRoot(contract.id)}/specs`;
    const contractSpecs = readdirSync(resolve(root, contractSpecsRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${contractSpecsRoot}/${entry.name}/spec.md`)
      .filter((path) => existsSync(resolve(root, path)))
      .map(read);
    for (const field of ['harness_faults', 'skill_sensitivity']) {
      if (corpus.scenarios.some((scenario) => Object.hasOwn(scenario ?? {}, field)) &&
          !contractSpecs.some((spec) => spec.includes(`\`${field}\``))) {
        errors.push(`${contract.corpusPath}: programmed optional field ${field} lacks an owner-spec grammar`);
      }
    }
    const mainRequirements = authoritativeRequirements(contract);
    for (const [rowIndex, scenario] of corpus.scenarios.entries()) {
      if (!Array.isArray(scenario?.owner_requirements)) {
        errors.push(`${contract.corpusPath}: scenario row ${rowIndex} lacks owner_requirements`);
        continue;
      }
      const hasOwner = (capability, requirement) => scenario.owner_requirements.some((reference) =>
        reference?.capability === capability && reference?.requirement === requirement);
      const ownerKey = (capability, requirement) => `${capability}\0${requirement}`;
      const expectedOwners = new Set();
      const expectOwner = (capability, requirement) => expectedOwners.add(ownerKey(capability, requirement));
      const requireOwner = (capability, requirement, reason) => {
        if (!hasOwner(capability, requirement)) {
          errors.push(`${contract.corpusPath}: scenario row ${rowIndex} lacks ${requirement} owner for ${reason}`);
        }
      };
      if (scenario.scenario_kind === 'programmed') {
        expectOwner(changeContracts[facadeChange].capability, 'Skill workflow делегирования');
        if (hasOwner(changeContracts[runtimeChange].capability, 'Ограниченный жизненный цикл ACP-процесса')) {
          errors.push(`${contract.corpusPath}: scenario row ${rowIndex} repeats the uniform lifecycle owner`);
        }
      }
      const boundedFileEffectScenario = scenario?.program?.steps?.some(({ type }) => type === 'effect');
      if (boundedFileEffectScenario) {
        expectOwner(changeContracts[facadeChange].capability, 'Workspace discipline делегирования');
        expectOwner(changeContracts[runtimeChange].capability, 'Режимы Cursor и ACP callbacks');
      }
      const trace = Array.isArray(scenario?.expected_trace) ? scenario.expected_trace : [];
      const runtimeCapability = changeContracts[runtimeChange].capability;
      if (trace.some(({ kind }) => kind?.startsWith('session.mode-') || kind?.startsWith('progress.'))) {
        expectOwner(runtimeCapability, 'Role-neutral mode and collaboration surface');
      }
      if (trace.some(({ kind }) => ['session.resumed', 'session.resume-failed'].includes(kind))) {
        expectOwner(runtimeCapability, 'Продолжение Cursor-сессии');
      }
      if (trace.some((entry) => ['session.allocated', 'session.resumed'].includes(entry.kind)
          && ['model', 'effort', 'fast', 'plugin_dirs_count', 'plugin_dirs_matched'].some((key) => Object.hasOwn(entry, key)))
          || scenario?.initial_input?.includes('${MISSING_PLUGIN_DIR}')) {
        expectOwner(runtimeCapability, 'Seamless per-session launch');
      }
      if (trace.some(({ kind }) => ['turn.wait-timeout', 'turn.wait-recovered'].includes(kind))) {
        expectOwner(runtimeCapability, 'Адресуемое ожидание состояния сессии');
      }
      if (trace.some(({ kind }) => kind === 'turn.timed-out')) {
        expectOwner(runtimeCapability, 'Нормативные limits runtime');
      }
      if (trace.some(({ kind }) => kind === 'turn.events-lost')) {
        expectOwner(runtimeCapability, 'Sparse wait and bounded progress');
      }
      if (trace.some(({ kind }) => kind === 'turn.result-read') || scenario?.harness_faults?.includes('result-overflow')) {
        expectOwner(runtimeCapability, 'Полное чтение terminal result');
      }
      if (scenario?.harness_faults?.some((fault) => ['reject-initialize', 'reject-mode', 'reject-prompt', 'reject-resume'].includes(fault))) {
        expectOwner(runtimeCapability, 'Provider errors are bounded and classified');
      }
      const reasonByRequirement = new Map([
        ['Skill workflow делегирования', 'programmed workflow'],
        ['Workspace discipline делегирования', 'file effect'],
        ['Режимы Cursor и ACP callbacks', 'file callback trace'],
        ['Role-neutral mode and collaboration surface', 'mode or collaboration trace'],
        ['Продолжение Cursor-сессии', 'session resume trace'],
        ['Seamless per-session launch', 'per-session launch semantics'],
        ['Адресуемое ожидание состояния сессии', 'addressed wait trace'],
        ['Нормативные limits runtime', 'turn deadline trace'],
        ['Sparse wait and bounded progress', 'retention-gap trace'],
        ['Полное чтение terminal result', 'full result read or overflow'],
        ['Provider errors are bounded and classified', 'provider rejection fault'],
      ]);
      for (const key of expectedOwners) {
        const [capability, requirement] = key.split('\0');
        requireOwner(capability, requirement, reasonByRequirement.get(requirement));
      }
      for (const reference of scenario.owner_requirements) {
        if (scenario.scenario_kind === 'programmed'
            && !expectedOwners.has(ownerKey(reference.capability, reference.requirement))) {
          errors.push(`${contract.corpusPath}: scenario row ${rowIndex} has unexpected ${reference.requirement} owner`);
        }
      }
      for (const [referenceIndex, reference] of scenario.owner_requirements.entries()) {
        const keys = reference && typeof reference === "object" && !Array.isArray(reference)
          ? Object.keys(reference).sort()
          : [];
        const validShape = keys.length === 2 && keys[0] === "capability" && keys[1] === "requirement" &&
          typeof reference.capability === "string" && typeof reference.requirement === "string";
        if (!validShape || !mainRequirements.get(reference?.capability)?.has(reference.requirement)) {
          errors.push(`${contract.corpusPath}: invalid owner requirement at row ${rowIndex}, reference ${referenceIndex}`);
        }
      }
    }
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
  const tasks = read(`${rootPath}/tasks.md`);
  const contract = changeContracts[change];
  const references = contract.references ?? [];
  const referenceOnly = !contract.capability;
  const skipSpecs = declaresSkipSpecs(rootPath);
  const capabilityStart = proposal.indexOf("## Capabilities");
  const capabilityRemainder = capabilityStart === -1 ? "" : proposal.slice(capabilityStart);
  const capabilityEnd = capabilityRemainder.indexOf("\n## ", 1);
  const capabilitySection = capabilityEnd === -1
    ? capabilityRemainder
    : capabilityRemainder.slice(0, capabilityEnd);

  if (referenceOnly && !skipSpecs) {
    errors.push(`${rootPath}/.openspec.yaml: reference-only change must declare top-level skip_specs: true`);
  }
  if (referenceOnly && references.length === 0) {
    errors.push(`${rootPath}: reference-only skip_specs change must declare an existing owner requirement`);
  }
  if (!referenceOnly && skipSpecs) {
    errors.push(`${rootPath}: skip_specs change must be reference-only in semantic registry`);
  }
  if (referenceOnly && /^-[ \t]+`[^`]+`/m.test(capabilitySection)) {
    errors.push(`${rootPath}/proposal.md: reference-only change cannot claim a capability`);
  }
  if (referenceOnly && existsSync(resolve(root, `${rootPath}/specs`)) &&
      readdirSync(resolve(root, `${rootPath}/specs`)).length > 0) {
    errors.push(`${rootPath}: reference-only skip_specs change cannot contain capability deltas`);
  }

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
  if (!referenceOnly) {
    if (!proposal.includes(`- \`${contract.capability}\``)) {
      errors.push(`${rootPath}/proposal.md: missing capability ${contract.capability}`);
    }
    if (!read(`${rootPath}/specs/${contract.specDirectory}/spec.md`)) {
      errors.push(`${rootPath}: capability ${contract.capability} has no expected spec path`);
    }
  }

  const requirements = requirementNames(change);
  const expectedOwnedRequirements = contract.ownedRequirements;
  if (expectedOwnedRequirements && (requirements.length !== expectedOwnedRequirements.length ||
      requirements.some((requirement) => !expectedOwnedRequirements.includes(requirement)))) {
    errors.push(`${rootPath}: owned requirement labels differ from semantic-gate registry`);
  }
  const index = indexedRequirements(design);
  const modified = contract.modified;
  const expectedIndex = [
    ...requirements,
    ...modified.map(({ requirement }) => requirement),
    ...references.map(({ requirement }) => requirement),
  ];
  const indexedRequirementSet = new Set(index);
  const expectedRequirementSet = new Set(expectedIndex);
  if (indexedRequirementSet.size !== expectedRequirementSet.size ||
      [...expectedRequirementSet].some((requirement) => !indexedRequirementSet.has(requirement))) {
    errors.push(`${designPath}: Public-invariant index must equal this change's requirement set`);
  }
  if (contract.invariantIds) {
    const ids = indexedInvariantIds(design, contract.invariantIds);
    if (ids.length !== contract.invariantIds.length || new Set(ids).size !== ids.length
      || contract.invariantIds.some((id) => !ids.includes(id))) {
      errors.push(`${designPath}: Public-invariant index must map every registered invariant ID exactly once`);
    }
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
    if (!tasks.includes(`«${requirement}»`)) {
      errors.push(`${rootPath}/tasks.md: no task references requirement «${requirement}»`);
    }
  }
  for (const modification of modified) {
    const { capability, requirement, replacementReason, sourceDigest, replacementDigest, sourceChange } = modification;
    const stacked = Object.hasOwn(modification, "sourceChange");
    const replacement = typeof replacementReason === "string" && replacementReason.trim().length >= 20
      && typeof sourceDigest === "string" && /^[a-f0-9]{64}$/.test(sourceDigest)
      && typeof replacementDigest === "string" && /^[a-f0-9]{64}$/.test(replacementDigest);
    const deltaPath = `${rootPath}/specs/${capability}/spec.md`;
    const mainPath = `openspec/specs/${capability}/spec.md`;
    const deltaSpec = read(deltaPath);
    const mainSpec = existsSync(resolve(root, mainPath)) ? read(mainPath) : "";
    const sourceBlock = requirementBlock(mainSpec, requirement);
    const deltaBlock = requirementBlock(deltaSpec, requirement);
    const archived = rootPath.startsWith("openspec/changes/archive/");
    const currentMainDigest = createHash("sha256").update(sourceBlock).digest("hex");
    let historicalPredecessorPreserves = false;
    let laterArchivedReplacementReachesCurrentMain = false;
    if (archived && !replacement) {
      const changeIndex = changes.indexOf(change);
      laterArchivedReplacementReachesCurrentMain = registry.changes.slice(changeIndex + 1).some((candidate) => {
        const candidateReplacement = candidate.modified?.find((entry) =>
          entry.capability === capability && entry.requirement === requirement
          && typeof entry.replacementReason === "string" && entry.replacementReason.trim().length >= 20
          && typeof entry.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(entry.sourceDigest)
          && typeof entry.replacementDigest === "string" && /^[a-f0-9]{64}$/.test(entry.replacementDigest));
        if (!candidateReplacement) return false;
        const candidateRoot = changeRoot(candidate.id);
        return candidateRoot?.startsWith("openspec/changes/archive/")
          && replacementLineageReaches(registry, capability, requirement,
            candidateReplacement.replacementDigest, currentMainDigest);
      });
      if (laterArchivedReplacementReachesCurrentMain) {
        let predecessor = null;
        for (let index = changeIndex - 1; index >= 0 && !predecessor; index -= 1) {
          const candidate = registry.changes[index];
          if (candidate.modified?.some((entry) => entry.capability === capability && entry.requirement === requirement)) {
            predecessor = candidate;
          } else if (candidate.capability === capability) {
            const candidateRoot = changeRoot(candidate.id);
            const candidatePath = candidateRoot && `${candidateRoot}/specs/${capability}/spec.md`;
            if (!candidateRoot || candidatePath && existsSync(resolve(root, candidatePath))
              && requirementBlock(read(candidatePath), requirement)) predecessor = candidate;
          }
        }
        const predecessorRoot = predecessor ? changeRoot(predecessor.id) : null;
        const predecessorPath = predecessorRoot && `${predecessorRoot}/specs/${capability}/spec.md`;
        const predecessorBlock = predecessorPath && existsSync(resolve(root, predecessorPath))
          ? requirementBlock(read(predecessorPath), requirement) : "";
        historicalPredecessorPreserves = predecessorRoot?.startsWith("openspec/changes/archive/")
          && Boolean(predecessorBlock) && preservesHistoricalRequirement(predecessorBlock, deltaBlock);
      }
    }
    const nonReplacementPreserves = laterArchivedReplacementReachesCurrentMain
      ? historicalPredecessorPreserves : preservesRequirement(sourceBlock, deltaBlock);
    let sourceDigestMatches = !replacement || (archived
      ? replacementLineageReaches(registry, capability, requirement, replacementDigest, currentMainDigest)
      : currentMainDigest === sourceDigest);
    if (stacked) {
      const source = changeContracts[sourceChange];
      const earlier = typeof sourceChange === "string" && changes.indexOf(sourceChange) >= 0
        && changes.indexOf(sourceChange) < changes.indexOf(change);
      const sourceRoot = earlier ? changeRoot(sourceChange) : null;
      const sourcePath = sourceRoot && `${sourceRoot}/specs/${capability}/spec.md`;
      const predecessorBlock = sourcePath && existsSync(resolve(root, sourcePath))
        ? requirementBlock(read(sourcePath), requirement) : "";
      const registered = earlier && (source.modified.some((entry) =>
        entry.capability === capability && entry.requirement === requirement)
        || (source.capability === capability && sourceRoot
          && existsSync(resolve(root, `${sourceRoot}/specs/${source.specDirectory}/spec.md`))
          && requirementNames(sourceChange).includes(requirement)));
      const sourceArchived = sourceRoot?.startsWith("openspec/changes/archive/");
      sourceDigestMatches = replacement && registered && Boolean(predecessorBlock)
        && createHash("sha256").update(predecessorBlock).digest("hex") === sourceDigest
        && (archived
          ? sourceArchived && Boolean(sourceBlock)
            && replacementLineageReaches(registry, capability, requirement, replacementDigest, currentMainDigest)
          : !sourceArchived || Boolean(sourceBlock) && currentMainDigest === sourceDigest);
    }
    const replacementDigestMatches = !replacement
      || createHash("sha256").update(deltaBlock).digest("hex") === replacementDigest;
    const fixedEvalCorpusCount = change === registry.roles.interactiveAcpUx
      && capability === 'cursor-subagent-skill-evals'
      && hasFixedEvalCorpusCount(requirement, deltaBlock);
    if (Object.hasOwn(modification, "replacement") ||
        (replacementReason !== undefined && !replacement) ||
        !sourceDigestMatches ||
        !replacementDigestMatches ||
        fixedEvalCorpusCount ||
        !proposal.includes(`- \`${capability}\``) || !deltaSpec.includes("## MODIFIED Requirements") ||
        !deltaBlock || (!stacked && !sourceBlock) ||
        (!replacement && !nonReplacementPreserves)) {
      errors.push(`${rootPath}: invalid modified capability ${capability}/${requirement}`);
    }
    if (!design.includes(`«${requirement}»`) || !tasks.includes(`«${requirement}»`)) {
      errors.push(`${rootPath}: modified requirement ${requirement} lacks baseline/task traceability`);
    }
  }
  for (const { ownerChange, capability, requirementId, requirement } of references) {
    const owner = changeContracts[ownerChange];
    const ownerRoot = owner ? changeRoot(ownerChange) : null;
    const ownerMappings = ownerRoot
      ? indexedRequirementMappings(read(`${ownerRoot}/design.md`))
      : [];
    const validOwner = owner?.capability === capability &&
      requirementNames(ownerChange).includes(requirement) &&
      ownerMappings.some((mapping) =>
        mapping.requirementId === requirementId && mapping.requirement === requirement);
    if (!validOwner) {
      errors.push(`${rootPath}: invalid owner reference ${ownerChange}/${capability}/${requirementId}/${requirement}`);
    }
    if (!design.includes(`\`${requirementId}\``) || !design.includes(`«${requirement}»`) ||
        !tasks.includes(`\`${requirementId}\``) || !tasks.includes(`«${requirement}»`)) {
      errors.push(`${rootPath}: referenced requirement ${requirementId}/${requirement} lacks baseline/task traceability`);
    }
  }
  validateCorpusOwnerRequirements(contract);

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

// The coverage lane imports this module; the same CLI entrypoint is exercised
// separately by the foreground semantic-gate verification command.
/* node:coverage ignore next 3 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runOpenSpecSemanticsCli();
}
