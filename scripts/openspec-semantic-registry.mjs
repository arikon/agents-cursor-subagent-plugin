const changeIds = Object.freeze({
  runtime: "harden-cursor-acp-session-runtime",
  facade: "add-cursor-delegation-workflow",
  package: "package-cursor-subagent-plugin",
  eval: "add-cursor-subagent-skill-evals",
  supervisor: "add-durable-node-test-supervisor",
  expandedEval: "expand-cursor-subagent-skill-evals",
  parallelTestLanes: "parallelize-node-test-lanes",
  accelerateNodeUnitTests: "accelerate-node-unit-tests",
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
    Object.freeze({
      id: changeIds.expandedEval,
      capability: "cursor-subagent-skill-evals",
      specDirectory: "cursor-subagent-skill-evals",
      corpusPath: "evals/cursor-subagent-scenarios.v1.json",
      ownerClaim: "`cursor-subagent-skill-evals` owns corpus admission, selection, scenario oracle, classification and eval evidence",
      ownedRequirements: Object.freeze([
        "Scenario program driver и pure scenario oracle",
        "Immutable evidence manifest",
        "Cost-aware execution policy",
      ]),
      modified: Object.freeze([
        Object.freeze({ capability: "cursor-subagent-skill-evals", requirement: "Разделённые eval lanes и evidence загрузки skill" }),
        Object.freeze({ capability: "cursor-subagent-skill-evals", requirement: "Сценарный контракт поведения и authority-aware interaction" }),
      ]),
    }),
    Object.freeze({
      id: changeIds.parallelTestLanes,
      ownerClaim: "`node-test-supervision` сохраняет владение runner lifecycle,",
      modified: Object.freeze([]),
      references: Object.freeze([
        Object.freeze({
          ownerChange: changeIds.supervisor,
          capability: "node-test-supervision",
          requirementId: "NTS-3",
          requirement: "Lane selection и coverage scope",
        }),
      ]),
    }),
    Object.freeze({
      id: changeIds.accelerateNodeUnitTests,
      ownerClaim: "`node-test-supervision` сохраняет владение runner lifecycle,",
      modified: Object.freeze([]),
      references: Object.freeze([
        Object.freeze({
          ownerChange: changeIds.supervisor,
          capability: "node-test-supervision",
          requirementId: "NTS-3",
          requirement: "Lane selection и coverage scope",
        }),
      ]),
    }),
  ]),
  roles: changeIds,
});
