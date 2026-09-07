# Coverage queue: Cursor eval surfaces

## Evidence boundary

- Raw artifact: `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-06T21-39-41-937Z-coverage-dc062d7c-77bb-4fcb-962e-a72b94c73fdc`.
- `result.json`: overall verdict `failed` only because `tests/bootstrap.test.mjs` hit the 120000 ms timeout; 523 tests, 521 passed, 1 cancelled, 1 skipped. The eval unit file completed 56/56.
- Aggregate coverage remained above the gate: lines 96.4430%, branches 91.3969%, functions 95.7164%.
- Observed source digests, which make the line references below stable:
  - `scripts/cursor-eval-scenario.mjs`: `2fc44d038e718b080a6128c5ae174dcc5b16ba29611d8ea6349d72cb346d86b7`
  - `scripts/run-cursor-skill-eval.mjs`: `02123705abb6102e68bd5a3982c8844d20290410a6495398fe8c5b572bbfc0cd`
  - `scripts/cursor-skill-eval.mjs`: `b387c4649bfdd9fcb1ce3f2cb47981515436e4fa47d9a62cb88fda23453a1a38`
- Current tests changed after this raw artifact (for example, a SIGTERM race test now exists). Such points remain classified from the raw queue and are marked “rerun may close”.

## `scripts/cursor-eval-scenario.mjs`

No zero lines or functions. Every zero branch is classified below.

| Line(s) | Classification | Semantic path and action |
|---|---|---|
| 219, 225, 228, 259 | meaningful_contract | Trace admission rejects invalid `session.start-rejected.error_code`, mode-change error code, malformed live recovery status, and incomplete `turn.result-read`. Add one table-driven malformed-trace admission test covering these four externally admitted observation contracts. |
| 322, 328, 333, 343 | meaningful_contract | Fixture predicate admission rejects invalid terminal status, mode failure code, live recovery shape, and start rejection code. Add these four cases to the same corpus mutation table; they are independent predicate contracts but need no separate test bodies. |
| 377 | meaningful_contract | A file effect without a same-turn prompt scope check must be rejected. Add one corpus counterexample removing/reordering that prompt check. |
| 378 | meaningful_contract | Non-fixture effect paths must remain literal while the fixture path is represented by `${RESULT_FILE}` in the delegated authority clause. Add one admitted scenario mutation with a second effect path and verify its required literal authority fragment; this is polarity/target behavior, not schema mirroring. |
| 430 | meaningful_contract | `inject-mode-protocol-error-once` must include both the protocol failure and live recovery evidence. Add one mutation removing `session.mode-recovery-status`; existing mutations cover neighboring mode-fault rules, not this exact recovery half. |
| 444 | meaningful_contract | A result-overflow scenario must not claim a successful `turn.result-read`. Add one mutation inserting it into the overflow row. |
| 447 | meaningful_contract | Failed terminal state and failure-producing harness fault must be paired in both directions. Add two compact mutations: failed terminal without fault and failure fault without failed terminal. If one direction is already covered by `model-prompt-provider-failure`, retain only the uncovered direction after rerun. |
| 454 | unreachable_defensive | The two individual fault contracts require mutually exclusive fixture predicates (`mode-recovery-status` versus `mode-change-failed`), so an admitted candidate cannot reach this later pairwise guard with both faults. Keep only as locally justified defense or remove it; do not force an artificial bypass test. |
| 458 | meaningful_contract | Active-followup trace and `hold-terminal-until-followup` must be paired. The current mutation table exercises both directions; rerun may close this raw branch without a new test. |
| 473 | meaningful_contract | An initial tombstone and `reject-initialize` must be paired. Add two directions only if the existing initial-provider row mutations do not execute both after rerun; one compact paired counterexample test is sufficient. |
| 501 | meaningful_contract | A `wait-timeout` followup requires an expected timeout observation. A current corpus mutation removes that observation; rerun may close this raw branch. |
| 623 | meaningful_contract | Materialized scenario publication has a 65536-byte bound after placeholder expansion. Add one behavioral materialization test whose admitted source expands past the bound. |
| 671-672 | meaningful_contract | Default report derivation has three outcomes: terminal-token, semantic-failure fallback, and no implicit checks. The raw queue lacks the `null -> []` path and one ternary alternative. Add one pure-oracle case for a programmed non-token row without explicit checks only if that shape remains admitted; the frozen contract now indicates it should instead be rejected at corpus admission, making this fallback path unreachable after repair. |
| 688 | meaningful_contract | Duplicate captured turn index is invalid evidence. Extend the captured-finals behavior test with duplicate and, per frozen contract, missing/extra index-set cases. |
| 690 | meaningful_contract | `complete` capture requires well-formed string text. Add a compact table with non-string and lone-surrogate text. |
| 693 | meaningful_contract | `confirmed_missing` requires exactly `text: null`. Add one capture with non-null text. |
| 697 | meaningful_contract | Aggregate complete-final bytes are bounded at 1 MiB. Add a multi-final overflow case rather than repeating single-field validation. |
| 717 | unreachable_defensive | For an admitted scenario, explicit `report_checks` owns exactly one final-turn outcome (lines 526-527), while the only legacy fallback owners also synthesize an outcome. A missing outcome can only occur by calling the exported oracle with an unadmitted scenario. Keep as defensive or remove after the fallback admission repair; do not add a product behavior test that blesses bypassing corpus admission. |
| 735 | meaningful_contract | Invalid report evidence must preserve an observed actual outcome and default only when it is absent. Existing invalid-capture assertions do not assert this projection. Add one assertion using `actual_task_outcome: failed`; absence is already exercised. |
| 808 | dead, removed after classification | `FORBIDDEN` contained mismatch codes (`answer-before-pending`, `id-mismatch`, `operation-after-close`, `unexpected-effect`), not admitted trace observation kinds. The loop derives all four from real observations at lines 758-786. The redundant set and branch were removed rather than testing synthetic observations. |
| 835 | realistic_failure | Event-burst callback failure is valid untrusted runtime evidence and must produce `burst-ack-mismatch`. Add one pure-oracle counterexample with correct acknowledgements plus one `callback.failure`. |

Minimal missing behavior set after deduplication: one table-driven admission test for lines 219-259 and 322-343; one file-prompt target test (377-378); one harness-fault pairing table (430, 444, 447, 473); one materialized-size test (623); one captured-final admission table (688, 690, 693, 697 plus exact index-set repair); one actual-outcome preservation assertion (735); one callback failure test (835). Lines 458 and 501 should first be remeasured because current tests already carry their counterexamples. Lines 454, 717 and 808 should not receive bypass tests; 808 is redundant dead code.

## `scripts/run-cursor-skill-eval.mjs`

Zero lines: 239-240. No zero functions. Branch queue:

| Line(s) | Classification | Semantic path and action |
|---|---|---|
| 71 | meaningful_contract | Partially specified or malformed expected digest environment must fail adapter admission. Add one table-driven `runEval` case for one-sided/invalid evaluator digest input; reuse it for the evaluator boundary below. |
| 81 | unreachable_defensive | `manifestFrom` is called only after `parseChildResult` has already required these provenance members and digests. Returning `null` cannot occur through the admitted parser result. Remove the guard or locally justify it; do not test a private impossible state. |
| 139 | meaningful_contract | Child capture `confirmed_missing` must carry `text: null`. Add to the existing child-result contract violation table. |
| 142 | meaningful_contract | Child evaluator digest must equal the configured expected evaluator digest. Add a parser test with a valid but different digest. |
| 168-169 | meaningful_contract | Default filesystem reader and canonical Node supervisor are the production adapter path. These are exercised by CLI/integration executions rather than dependency-injected unit paths; rerun after the current CLI tests before adding a duplicate unit test. |
| 172 | meaningful_contract | Optional `artifactRoot` must be forwarded to the supervisor. Add one assertion to the existing supervisor-routing test using an injected artifact root. |
| 179 | meaningful_contract | Configured evaluator digest must be forwarded into child-result verification, while absence remains allowed. The digest mismatch parser test plus one harness invocation with evaluator env covers the configured branch; current no-env harness tests cover absence. |
| 186, 197 | realistic_failure | Supervisor results may omit `failureDetails`; interruption classification and diagnostics must then remain stable. One harness test returning a minimal supervisor result without this property covers both fallbacks. |
| 221, 226 | meaningful_contract | Default scenario selection when an admitted corpus has no `client-integration` row must return bounded `unknown_scenario` for `corpus-default`, not crash. One custom admitted corpus with programmed model row plus package reference covers both lines. |
| 237-240 | realistic_failure | Evaluator inventory read failure and frozen-candidate digest mismatch must both publish `inspection/evaluator_drift`; lines 239-240 are entirely uncovered. Add one two-case behavioral test and assert no harness starts. This also covers line 71 only if the malformed-env case is retained separately, because malformed input is adapter admission before comparison. |
| 247 | realistic_failure | Initial sensitivity source read can fail. Current tests cover loss after baseline, not necessarily the first read. Add one case where the first `readSkillFile` rejects and assert `sensitivity_source_unavailable` with zero harness runs. |
| 251 | meaningful_contract | Mutation target drift/unsupported mutation at the runner boundary must become adapter admission. Direct `applySkillSensitivity` tests exist, but the runner catch remains unproved. Add one runner case with an admitted sensitivity name and a source payload missing the exact mutation target. |
| 326, 345 | meaningful_contract | A scenario using `${PLUGIN_DIR}` must derive and forward `CURSOR_EVAL_EXPECTED_PLUGIN_DIRS_SHA256`. One `runEval` harness-env assertion covers both branches. |
| 343 | meaningful_contract | `inject-mode-protocol-error-once` must map to `CURSOR_EVAL_INJECT_MODE_PROTOCOL_ERROR_ONCE=1`. Add to a table-driven harness-env projection test. |
| 344 | meaningful_contract | `accelerate-wait-timeout` must map to `FAKE_ACP_ACCELERATE_WAIT_TIMEOUT=1`. Add to the same projection table. |
| 403 | unreachable_defensive | Publication occurs only after line 386 proves `childResult.manifest`; `childResult?.manifest || null` therefore cannot select `null`. Replace with `childResult.manifest` or leave justified; no test should construct an impossible post-guard state. |
| 423 | meaningful_contract | SIGTERM must emit one bounded `runner_terminated`, set exit 143, and win the completion race. A current test now covers both known and unknown scenarios; rerun may close this raw point without more tests. |

Minimal missing behavior set after deduplication: evaluator boundary table (71, 142, 179, 237-240); child confirmed-missing parser mutation (139); supervisor forwarding/default-result table (168-172, 186, 197); no-client default corpus test (221, 226); first-read sensitivity failure plus mutation-drift runner case (247, 251); harness-env projection table (326, 343-345). Re-run before adding SIGTERM coverage. Lines 81 and 403 should be simplified, not covered.

## `scripts/cursor-skill-eval.mjs`

The raw queue contains no zero lines, branches, or functions. No missing behavioral test is indicated for this file by this artifact.

## Recommended order

1. Apply the frozen-contract repair for explicit `report_checks` and exact captured-final turn set; these change reachability at 671-672 and add the missing capture-set behavior around 688.
2. Remove or locally justify dead/unreachable branches at scenario line 808 and runner lines 81/403 before writing tests.
3. Rerun targeted eval coverage because current tests already appear to cover scenario 458/501 and runner 423.
4. Add only the remaining behavior groups above, then rerun full coverage and reclassify the new raw zero queue. The bootstrap timeout is independent of these eval files and prevents using this artifact as a complete green verdict.

## Final green coverage closure — 2026-09-07

This section supersedes the earlier work queue above. It preserves that queue as audit history and classifies every counter still at zero in `/private/tmp/cursor-coverage-final-counters.json` after the green 107.8-second coverage run.

- Final aggregate: lines `99.88083416087389%`, branches `97.31182795698925%`, functions `99.85443959243085%`; the coverage gate passed.
- Current source digests at classification:
  - `scripts/cursor-eval-scenario.mjs`: `592b7de640615e4e61d15985cc48396fc85556d3a8d95914c513f5a8aa11f0b6`
  - `scripts/run-cursor-skill-eval.mjs`: `5c1868db76a2f187371dfb945a3853fd93197c40157c14ae3d0f68bf893f47a5`
  - `scripts/cursor-skill-eval.mjs`: `02f6b6aec2fd109c545534dff77012fa6857b2c97011cea9b3e8dce755f1eae1`
- No zero lines or functions remain in these three files. `scripts/cursor-skill-eval.mjs` has no zero branches.

### Current `scripts/cursor-eval-scenario.mjs` zero branches

| Current line | Classification | Closure |
|---|---|---|
| 224 | meaningful_contract | Invalid `session.mode-change-failed.error_code` was previously intercepted by fault-pair checks. An isolated no-fault trace counterexample now reaches and verifies the trace admission owner. |
| 321 | meaningful_contract | Invalid terminal predicate status now has an isolated no-fault corpus counterexample. |
| 327 | meaningful_contract | Invalid mode-failure predicate code now has an isolated no-fault corpus counterexample. |
| 453 | unreachable_defensive | The one-shot recovery fault requires `mode-recovery-status`, while provider rejection requires `mode-change-failed`; their individual guards at lines 426–434 reject the opposite fixture before this pairwise guard. No bypass test is valid. |
| 457 | meaningful_contract | A counterexample now removes only `hold-terminal-until-followup` while preserving wait acceleration, so the active-followup pairing owner is reached directly. |
| 472 | meaningful_contract | A no-fault scenario now injects an initial tombstone, exercising the trace-to-`reject-initialize` pairing direction without being intercepted by the fault-specific guard. |
| 500 | meaningful_contract | A non-timeout scenario followup is changed to `wait-timeout` without adding timeout trace evidence, directly exercising the followup owner. |
| 672–673 | unreachable_defensive | Corpus admission permits omitted `report_checks` only for terminal-token or the named semantic-failure fallback. The `null` arm and empty-check return cannot occur for an admitted scenario. |
| 719 | unreachable_defensive | Explicit checks admit exactly one final-turn outcome, and both permitted fallback forms synthesize one. Missing outcome diagnostics require bypassing corpus admission. |
| 737 | meaningful_contract | Malformed capture evidence without an observed actual outcome now verifies the required `not_observed` projection; the existing companion verifies preservation of an observed failure. |

### Current `scripts/run-cursor-skill-eval.mjs` zero branches

| Current line | Classification | Closure |
|---|---|---|
| 161 | meaningful_contract | A harness test now reads a real temporary child-result file through the default filesystem adapter. |
| 162 | meaningful_contract | A narrow harness test now invokes the canonical supervisor on one admitted deterministic integration test and verifies the resulting child contract. |
| 244 | unreachable_defensive | The caught call is `applySkillSensitivity`; every supported failure from that function carries `evalCode: adapter_admission`. The `|| 'adapter_admission'` fallback cannot be selected through the admitted string input path. Parent-owned runner may simplify this redundant fallback; no artificial throw injection belongs in product tests. |
| 417 | meaningful_contract | The SIGTERM race test now includes invocation without a scenario argument and verifies `corpus-default`, exit 143 and the single `runner_terminated` result. |

The added behavior was verified independently with:

`node scripts/run-node-tests.mjs unit --test tests/run-cursor-skill-eval.test.mjs`

Result: `PASS unit: 1103ms`; artifact `2026-09-06T22-12-22-087Z-unit-c4034745-e9f0-41b5-a4f7-fe0d66241b33`.

No further meaningful or realistic eval behavior gap remains in this final zero queue. A subsequent full coverage run may still display the four scenario defensive branches and the runner sensitivity fallback until product simplification removes them; they must not be covered with unadmitted fixtures or injected impossible failures.

## Frozen final series run 1 reconciliation

Source: `verification/test-speed/final-series/coverage-zero-counters.json`; the corresponding coverage run passed in 63.664 seconds. No code or test changes were made during this reconciliation.

The prior current-zero queue converged from 11 scenario branches and four runner branches to exactly four branches:

| File and line | Classification | Reachability proof |
|---|---|---|
| `scripts/cursor-eval-scenario.mjs:453` | unreachable_defensive | `inject-mode-protocol-error-once` is admitted only with a `mode-recovery-status` predicate, while `reject-mode` is admitted only with a `mode-change-failed` predicate. The individual guards reject a combined candidate before this mutual-exclusion guard. |
| `scripts/cursor-eval-scenario.mjs:673` | unreachable_defensive | The empty derived-check return requires neither explicit `report_checks`, nor terminal-token, nor the named semantic-failure row. Corpus admission rejects exactly that state before the pure oracle receives it. |
| `scripts/cursor-eval-scenario.mjs:719` | unreachable_defensive | Explicit report checks admit exactly one final-turn outcome; both permitted fallback forms synthesize an outcome. `diagnostics` therefore cannot lack an outcome for an admitted scenario. |
| `scripts/run-cursor-skill-eval.mjs:244` | unreachable_defensive | The catch surrounds only `applySkillSensitivity`, whose supported failure always carries `evalCode: adapter_admission`; the fallback after `error.evalCode ||` cannot be selected for its admitted string input. |

These files have zero uncovered lines and zero uncovered functions. `scripts/cursor-skill-eval.mjs` also has zero uncovered branches. Frozen run 1 confirms that every meaningful or realistic eval path identified in the earlier queue is covered; the remaining counters must not be converted into artificial bypass tests.

## Candidate 05 coverage diagnostic reconciliation

Source: `verification/candidate-05/coverage-diagnostic/zero-counters.json`. The run collected complete coverage counters and exceeded all aggregate thresholds (lines `99.87765089722676%`, branches `97.79353821907013%`, functions `99.85163204747775%`), but its overall verdict was `failed` because of one unrelated supervisor-test race. This note classifies only the current eval-source queue; it does not treat that run as a green full-coverage verdict.

- `scripts/cursor-eval-scenario.mjs` source SHA-256: `ae73148f5835ac0a5d5bd707a0674ff1331ee833afe28467e683743668aa433e`.
- `scripts/run-cursor-skill-eval.mjs` source SHA-256: `e2df3b1778ebbae0e24578f23d6128aa8f4662e0fbd5c96c039addc818cf4c25`.
- `scripts/cursor-skill-eval.mjs` source SHA-256: `ac4e06e7cfc0fd4f9fed27f019ccdcffb1c1c959975ba69385ccb0222eed2562`.
- The runner and shared eval contract have no uncovered lines, branches, or functions.

| File and current line | Classification | Reachability proof |
|---|---|---|
| `scripts/cursor-eval-scenario.mjs:451` | unreachable_defensive | This is the same mutual-exclusion guard previously recorded at line 453. `inject-mode-protocol-error-once` requires a `mode-recovery-status` predicate, while `reject-mode` requires a `mode-change-failed` predicate. Their earlier individual admission guards reject either incompatible combined fixture before both booleans can be true here. An artificial bypass test would exercise an unadmitted corpus shape, so no test or source change is required. |

The accepted oracle simplification removed the former report-fallback and semantic-grading zero branches. Candidate 05 therefore leaves no meaningful contract or realistic failure path uncovered in these three eval files.
