# Project rules

## Design and contracts

- Follow KISS: choose the simplest construction that solves the observable problem; do not add architectural layers for formal flexibility alone.
- Follow DRY and SSOT: do not duplicate rules, lifecycle, identifiers, state, policy, schemas, transition tables, or algorithms. Each must have one owner; OpenSpec design/spec/tasks and code facades/adapters may refer to that owner and add only their independent responsibility.
- Follow SRP: every layer, entity, and module has one independent responsibility. A facade does not duplicate the lifecycle or state of the underlying runtime; it adds only its own role.
- Apply SOLID where needed: separate stable contracts from implementations, do not couple clients to unnecessary capabilities, and direct dependencies towards abstractions only where that makes replacement or testing simpler. Prefer thin facades over an existing contract rather than parallel registries and state machines.
- Follow YAGNI: do not introduce an entity, layer, abstraction, dependency, or policy engine until a concrete scenario needs it and cannot be solved without it.
- Any architectural complexity MUST have a brief explanation of the observable problem it solves, why the existing construction is insufficient, and how its necessity is validated by a test or operational scenario.
- Before expanding use of an external or dependency contract, a reviewer MUST confirm its current version, exact schema/API, and applicable capability boundary from a primary source or the installed interface. Unconfirmed fields, methods, and semantics do not belong in the design/spec: keep them behind a narrow version-specific adapter with a golden fixture, or explicitly exclude them from scope.
- Modify existing files with targeted patch hunks. Do not delete and recreate an
  entire file when the requested result can be achieved with local edits; full
  replacement is allowed only for a new file or when the user explicitly asks
  for a complete rewrite.

## Threat model and authority

- Check that the threat model is realistic for an ordinary local Codex + Cursor scenario under one user; do not portray scope validation as a sandbox or security boundary.
- Use technical constraints as protection against scope mistakes only to the degree that they actually constrain process capabilities.
- Do not introduce a policy engine without an explicit need. The MCP server does not make permission decisions automatically; Codex must confirm Cursor actions within authority granted by the user. Do not require one-time-only confirmation when the user has already authorized the full class of actions.
- Escalate scope expansion, destructive and external actions, and credential access to the user. Do not grant indefinite permissions by default.

## OpenSpec convergence

`AGENTS.md` is the single normative owner of project-wide OpenSpec governance. `openspec/config.yaml` may only provide supported OpenSpec configuration and a context link; a change baseline lives in its `design.md` and indexes, rather than repeats, normative requirements in its `spec.md`.

- Before every full review, every change MUST have a `## v1 Contract Baseline` in `design.md`: goal, non-goals, index of public invariants by requirement ID, owner map, implementation-ready exit criterion, and future-change candidates.
- After baseline freeze, every reviewer finding MUST be classified exactly once: `baseline_violation` (minimal repair in the current change), `implementation_concern` (task/test only), `external_adapter_drift` (version-specific adapter/golden fixture only), `new_scope` (separate change), or `overengineering` (remove or exclude from v1).
- Review completeness is not capped, but the number of findings never expands a frozen baseline. An architect MUST validate every classification, repair minimality, and absence of new duplication; `new_scope` needs an explicit user baseline update before entering the current change.
- A normative rule has one owner: runtime owns lifecycle/state/MCP wire/limits; facade owns only user-workflow composition; package owns installation/discovery and one minimal release canary. Upper layers reference owner requirement IDs and test only their independent responsibility.
- Cursor/ACP/Codex schemas, argv, flags, capability details, and versions require primary-source or installed-interface confirmation and belong in a version-specific adapter/golden fixture, not a long-lived product requirement.
- `openspec validate --strict` is structural only. Before review, run the deterministic semantic gate: owner map, no normative duplicates, proposal/design/spec/tasks consistency, and no upper-layer reference to a lower owner's internal details.
- A change is specification-ready when an independent critic finds no `baseline_violation`; `implementation_concern`, `external_adapter_drift`, and future scope do not invalidate the frozen v1 contract.

## Review

- Before implementation, check every contract for unnecessary entities, unverifiable guarantees, false security claims, and realistic failure paths in ordinary use.
- Do not cap a reviewer's time, number of findings, or verdict size: the review MUST list every discovered blocker and material risk, not only the highest-priority ones.
- Do not interrupt or restart a reviewer before its verdict. This is allowed only for a proven hang or deadlock: the reviewer is explicitly unable to provide the expected result after its actual state has been checked. A timeout observation or transient network errors alone are not such proof. If network errors repeat several times over a meaningful period (minutes), the problem may be considered proven.

## Running tests and coverage

- Do not reduce product-code coverage with tests. Keep it at approximately 90% or higher for lines, branches, and functions in a complete fail-closed manifest of the agreed product scope: source must not disappear from the denominator merely because tests no longer load it. Every test MUST verify observable behavior, a public contract, or a realistic failure path. Do not lock in internal structure, specific lines, private helpers, implementation details, or configuration details unless they are a documented external contract. Coverage alone is not a reason to add a test. Follow DRY, SSOT, and SRP in tests: every observable scenario and contract has one test owner at the appropriate layer. Do not repeat one semantic assertion in unit, transport, smoke, facade, or e2e tests; an upper-layer test adds only its own integration responsibility. Before adding a test and when reviewing a test suite, check existing scenarios, remove semantic duplicates, and move a shared fixture/helper to its single owner without creating a test-only API in product code. Do not add artificial tests for insignificant branches merely for the metric: an exclusion is permitted only for genuinely unreachable defensive code and must be justified locally next to the exclusion or in the review.
- Exclude individual lines from Node coverage only after classifying them as genuinely unreachable in the admitted product flow. Prefer the narrowest supported directive, `/* node:coverage ignore next */` or `/* node:coverage ignore next N */`; use `/* node:coverage disable */` / `/* node:coverage enable */` only for one minimal contiguous region that cannot be expressed clearly with `ignore next`. Every exclusion MUST have an adjacent rationale stating why the code cannot execute under the supported contract and how the relevant surrounding behavior is verified. An import-only coverage limitation may justify excluding a CLI entrypoint guard only when that same entrypoint is exercised by a separate foreground verification command. Never exclude a meaningful contract, a realistic dependency/error/race path, dead code, a whole product file, or code solely to satisfy a percentage threshold: add or extend a behavioral test for the first two and remove dead code. Treat line and branch exclusion as independent evidence: on the supported Node 22 runtime an ignore directive can remove executable lines from the line denominator while the corresponding zero-count branch remains in the raw report. After changing an exclusion, rerun the full coverage lane, inspect lines, branches, and functions separately, and classify every residual zero-count counter; passing aggregate thresholds alone does not validate the exclusion.
- Run tests in the foreground and consider a run successful only after the command finishes with exit code `0` and its final TAP summary. Do not use `&`, redirect a verification run to a background log, or treat partial output as pass evidence.
- For ordinary unit verification, use the supervisor lane:

  ```sh
  node scripts/run-node-tests.mjs unit
  ```

- For the same fixed suite with coverage, use `node scripts/run-node-tests.mjs coverage` (the legacy `run-unit-coverage.mjs` remains only as a compatibility entrypoint). For release verification, use `node scripts/run-node-tests.mjs release`. The supervisor owns the process group, waits for `close`, prints a terminal verdict, and writes `tap.txt`, `stderr.txt`, `failures.jsonl`, and an atomic `result.json` to the reported artifact directory. For a non-pass verdict, read `result.json` first, then the references listed there. For a `coverage_gate` verdict, after `result.json` read the last `test:coverage` event in `failures.jsonl`: its per-file `lines`, `branches`, and `functions` with zero `count` are the primary source for locating uncovered lines, branches, and functions. The complete raw report MUST be the review work queue, not optional diagnostics: before completing the change, classify every uncovered point as a meaningful contract, realistic failure path, genuinely unreachable defensive branch, or dead code. For the first two, MUST add or extend a behavioral test; dead code MUST be removed; only genuinely unreachable defensive code may be excluded, with a local justification next to the exclusion or in the review. The 90% threshold is only the minimum fail-closed gate, not the goal, readiness criterion, or reason to stop analysis: passing the aggregate percentage while meaningful branches or lines remain unexamined is incomplete work. New tests must still verify an observable contract or realistic failure path, not a specific line or configuration.
- Run release, real-Codex, and hosted-auth lanes as separate foreground commands. They are not part of unit coverage and cannot substitute for it.
