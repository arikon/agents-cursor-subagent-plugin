const changeIds = Object.freeze({
  runtime: "harden-cursor-acp-session-runtime",
  facade: "add-cursor-delegation-workflow",
  package: "package-cursor-subagent-plugin",
  eval: "add-cursor-subagent-skill-evals",
  supervisor: "add-durable-node-test-supervisor",
});

export const PROJECT_SEMANTIC_REGISTRY = Object.freeze({
  changes: Object.freeze([
    Object.freeze({
      id: changeIds.runtime,
      capability: "cursor-acp-session-runtime",
      specDirectory: "cursor-acp-session-runtime",
      ownerClaim: "Этот change owns runtime requirements",
      modified: Object.freeze([]),
    }),
    Object.freeze({
      id: changeIds.facade,
      capability: "cursor-task-delegation",
      specDirectory: "cursor-task-delegation",
      ownerClaim: "Этот change owns only composition",
      modified: Object.freeze([]),
    }),
    Object.freeze({
      id: changeIds.package,
      capability: "cursor-plugin-distribution",
      specDirectory: "cursor-plugin-distribution",
      ownerClaim: "Этот change owns install/discovery и release canary",
      modified: Object.freeze([]),
    }),
    Object.freeze({
      id: changeIds.eval,
      capability: "cursor-subagent-skill-evals",
      specDirectory: "cursor-subagent-skill-evals",
      ownerClaim: "Этот change owns only Codex behavior-eval orchestration and",
      modified: Object.freeze([
        Object.freeze({ capability: "cursor-task-delegation", requirement: "Skill workflow делегирования" }),
      ]),
    }),
    Object.freeze({
      id: changeIds.supervisor,
      capability: "node-test-supervision",
      specDirectory: "node-test-supervision",
      ownerClaim: "`node-test-supervision` owns runner lifecycle, artifacts, reporting and coverage gate",
      modified: Object.freeze([]),
    }),
  ]),
  roles: changeIds,
  evalScenarioIds: Object.freeze([
    "client-happy",
    "model-question",
    "model-plan",
    "model-permission-covered",
    "model-permission-expansion",
    "model-semantic-failure",
    "live-marker",
  ]),
});
