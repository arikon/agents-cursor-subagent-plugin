# IUX-3 / IUX-19 / IUX-20 implementation verification

Status: implementation reviews cleared; final operational gates and hosted acceptance pending.

Independent reviews:

- Sol runtime/capture critic: OKAY after synchronous terminal sealing, incremental full-result accumulation, bounded capture deadline/transport budget and exact adapter shape validation. Private accumulator assertions removed.
- Operator review: CLEAR after README used the actual `result.truncated` field. Full result is read before report/follow-up/close; IDs remain tool evidence, not mandatory final prose.
- Architect IUX-19 review: CLEAR after shared closed manifest validation, exact final evidence matching, actual selected runner inventory, encoded/raw bounds, exit/signal consistency, inspection classification and portable nested references. Findings were minimal baseline repairs; no new scope or parallel lifecycle/schema owner added.
- Matrix/suite: no automatic retries; malformed/oversized/inconsistent artifacts fail closed. Suite success requires child exit zero as well as a complete green summary.

Coverage classifications in this directory retain the raw-counter queues and their disposition. A passing percentage is not used to waive meaningful uncovered behavior.

The latest full verification and frozen candidate evidence are recorded separately after completion. Historical local test failures remain diagnostic evidence, not acceptance.

## Completed local verification and focused repairs

Test-speed tasks 5.7a/5.7b are complete: eleven lifecycle tables use one fake core; two real 15-second waits are deterministic; capture timing and fresh-executable fixture races are repaired. Independent architecture and evidence reviews are CLEAR. `test-speed/final-series/closeout.json` retains 25 bootstrap + 25 loaded capture + 3 full unit + 3 full coverage results on one input inventory. Unit median is 55227 ms. All zero counters from the three complete coverage reports are classified in this directory; no denominator reduction or new exclusion was used.

The first hosted focused candidate passed file-review/long-result but exposed Russian final reports against English-only prose assertions, plus an omitted no-regeneration disclosure. Candidate 02 sets English explicitly in all 26 model prompts, admits the exact `terminal_result_limit` error code, and clarifies the existing no-retry report requirement. The architect classified the language/error-code mismatch as baseline repairs; the skill clarification is an implementation concern.

Focused 02 again passed file-review/long-result. Overflow reported both facts correctly using `full review could not be obtained` and `did not retry or regenerate`; candidate 03 admits those equivalent phrases. Its events-lost final omitted all safety facts, so the skill now states that brevity/“only confirmed result” must retain the existing safety qualifications. Independent bounded review is CLEAR; no new fact, schema, technical-word requirement or expected-outcome hint was introduced.

All earlier focused failures remain in their original directories. Candidate 02/03 product scripts match the fully covered source; their corpus/skill deltas receive targeted behavioral, release and applicable deterministic checks. The performance measurements remain tied to their original full inventory rather than being relabeled as measurements of changed prompts. Hosted acceptance is still pending.

## Accepted functional acceptance boundary (2026-09-07)

The user explicitly approved removing free-form prose semantics from the mandatory gate while retaining execution and concrete delivery checks. Corpus/fixture-owned markers must be explicitly requested by the scenario; they must not leak into the installed skill. Captured reports remain evidence. Unchecked reported semantics are recorded as `not_checked`, never inferred from actual execution. The previous prose-disclosure sensitivity probe is superseded rather than counted as passing.

Diagnostic 04 completed with 10/26 passes, 16 behavior mismatches and zero integration failures on a stable candidate. Fifteen mismatches concern only report checks; `model-launch-change` also exposes a missing final close attempt. This is diagnostic evidence under the previous contract, not acceptance under the approved replacement. Earlier phrase repairs above are historical and do not define the new gate. New candidate verification and both serial model gates remain pending.

Implementation of the accepted boundary is complete (task 5.7c). Independent Sol critic: OKAY after making report_checks mandatory with explicit empty arrays and retaining generic nonempty-final delivery; architect validated owner boundaries. Targeted oracle, runner, integration, matrix and release results are retained under candidate-05. Full unit passed: 548 tests, 547 passed, one skipped, 50986 ms. Coverage and fresh hosted gates are still pending. The removed semantic-sensitivity checks do not count as passing checks.

Candidate 05 final coverage passed in 59201 ms: lines 99.87765089722676%, branches 97.84607302337798%, functions 99.85163204747775%. Its complete raw queue is retained at `candidate-05/coverage-final/zero-counters.json`. Relative to the preceding pass, optional-digest branch 71 is now covered; bootstrap branches 429/430 reappear and retain their existing classification. Runtime, capture, bootstrap and proxy product sources were unchanged by the accepted eval delta; their previously audited queue classifications remain applicable. The eval scorer's single remaining branch 451 is classified in the eval note; the runner/shared contract have no uncovered counters. The matrix wrong-final path is now covered. No product scope was removed from the denominator and no new exclusion was added.

Frozen executable inputs: `../candidate/frozen-inputs-05.json`. Independent Sol critic OKAY and architect CLEAR; strict/semantic, full unit, final coverage, targeted deterministic eval and release checks are complete. Hosted diagnostic and the two serial acceptance gates remain pending.


## Diagnostic 05 disposition and candidate 06

Diagnostic 05 completed 24/26 with zero integration failures and stable candidate identity. Every final-delivery check passed, including the repaired last-stage resumed cleanup. Long-result failed because the task requested a marker only in the caller report while the fixture required it in the delegated prompt; 17 analogous non-file prompt-check requirements now explicitly ask Cursor to return their exact marker in the corpus task. No marker rule was restored to the skill. Critic-delta failed only because the caller selected an admitted optional effort while the expected allocation omitted that field. The architect classified the overly strict omission inference as an implementation concern. Matching now leaves only undeclared effort/fast unconstrained on allocated/resumed events; all declared values, model/mode, scope proof and event order remain strict. Regression checks cover both permitted and rejected variations. Independent Sol bounded review: OKAY. Full local verification and fresh hosted diagnostic remain pending for candidate 06.

Candidate 06 local gates passed: full unit 51904 ms (549 tests, 548 pass, one skip), coverage 58196 ms (99.87789987789988% lines, 97.90136411332634% branches, 99.85185185185185% functions), deterministic integration 5511 ms with required local bind permission. Complete coverage queue has no new zero counters relative to the already classified candidate-05 queue. Installed skill/runtime/release paths are unchanged from candidate-05 release PASS. Frozen inputs are recorded in frozen-inputs-06.json; diagnostic remains pending.

## Diagnostics 06/07 and candidate 07

Diagnostic 06: 23/26 pass, zero behavior mismatches, three plugin-list timeouts before model execution at concurrency 8. Diagnostic 07 preserved the same candidate at concurrency 4: 24/26 pass, one identical pre-model timeout and one missing final resumed-wrapper close. No failed attempt was hidden or retried within either matrix.

The version-specific Codex 0.153.4 adapter now filters plugin list by the admitted marketplace, supported by installed help plus absent/installed fixture observations. Legacy 0.152.1 argv remains unchanged. The skill's single cleanup owner now retains wrappers only for explicitly declared unfinished stages; mere possible future messages no longer defer close. No protocol hint or marker was added to the corpus or skill. Independent Sol critic OKAY after removing one duplicate keepalive rule; strict/semantic and diff checks passed.

Candidate 07 bootstrap suite passed 76/76 in 38110 ms; release passed in 1887 ms. Results are copied into candidate-07. Product JS is unchanged from candidate-06 coverage and its classified raw queue. Frozen inputs: ../candidate/frozen-inputs-07.json. Diagnostic 08 uses concurrency 8: the fix removes unrelated remote marketplace discovery, rather than relying on lower concurrency. Both subsequent serial gates must use this same candidate and concurrency.

## Diagnostic 08 and candidate 08

Diagnostic 08 completed 24/26, two behavior mismatches, zero infrastructure failures, stable digests, 163664 ms. Launch-change cleanup passed. Question recovery omitted the required 60000-ms wait after stale rejection; permission expansion closed before a declared decision stage. Both remain recorded failures. Architect classified narrowed skill provider-stage wording as baseline_violation; it now matches the normative decision/follow-up/review stage owner. Corpus explicitly states the two user stages without tool hints or advance write authorization. Stale recovery now has one colocated operator instruction with explicit wait parameters and full pending context; duplicate prose was removed. Oracle/fake/expected trace were not weakened. Independent Sol review OKAY for both repairs.

Candidate 08 oracle unit passed 3385 ms and release 1909 ms. No product JS changes since candidate-06 coverage. Frozen inputs are recorded in frozen-inputs-08.json; diagnostic 09 uses concurrency 8. Historical failures remain diagnostic, never relabeled as acceptance.

## Diagnostic 09 and candidate 09

Diagnostic 09 completed 25/26, one behavior mismatch and zero infrastructure failures in 232029 ms with stable digests. Both question recovery and permission-expansion repairs passed. Active-followup omitted the retained progress revision from its next wait; all other workflow/effects/delivery checks passed. Skill step 2 now explicitly passes the retained revision as after_progress_revision whenever available. This closes implicit dataflow wording without changing the oracle, corpus, cursor or timeout policy. Independent Sol bounded review OKAY; semantic and diff checks passed; release passed 1927 ms. Candidate frozen-inputs-09.json receives diagnostic 10 at unchanged concurrency 8. Acceptance remains pending.

Diagnostic 10: 25/26, one repeated permission early-close behavior failure, zero infrastructure failures, 181910 ms, stable inputs. Architect classified explicit reject-once versus unfinished stage distinction as minimal baseline repair. Candidate 10 adds that distinction only to skill cleanup owner; corpus/oracle unchanged. Sol review OKAY, semantic/diff checks passed; release 1956 ms. New diagnostic 11 remains required before either acceptance series.

## Diagnostic 11 and acceptance 01 high

Diagnostic 11 passed 26/26 in 194127 ms with candidate digest 216efcaf0516d1b3f3eb1a94a383c4d8249d04540fcac72558a0ce62fc166374. Task 5.8 completed. Acceptance-01 high retained all three serial runs: 18/26, 24/26, 26/26; aggregate 68/78, two behavior mismatches and eight infrastructure failures, 781352 ms, stable candidate. This is non-green evidence, not reproducible acceptance. Medium has not run.

The eight first-run infrastructure failures reached the 180-second hosted observation deadline while exact turns remained inProgress and thread/read kept responding. All corresponding second-run scenarios terminalized within the same deadline. Two diagnostic stderr tails show remote catalog/download trouble; a single upstream cause is not proven. No timeout expansion or hidden retry is justified by this evidence.

Second-run behavior failures: permission-expansion closed before the declared later stage and created a fresh delegation; resume-failure created a replacement conversation after a later request to continue the unavailable original. Third-run success does not erase these failures. Minimal skill cleanup and explicit conversation-identity boundary are reviewed before a new frozen candidate; corpus/oracle remain unchanged.

Candidate 11 replaces repeated cleanup prose with reviewed exact-state first-match branches and clarifies failed-resume conversation identity without a temporal-consumption claim. Completed tombstone remains a completed outcome with retained provider identity; it is not generic failure. Sol bounded review OKAY, semantic/diff checks pass, release 3263 ms. Frozen inputs are frozen-inputs-11.json. Diagnostic 12 and both future serial gates use concurrency 4 to reduce simultaneous hosted load after the first acceptance-series stalls; this is an operational mitigation, not a proven causal diagnosis. Task 5.8 reopened for the changed candidate. Earlier diagnostic11 remains a historical pass, acceptance01 remains non-green.

Diagnostic12 completed24/26 in368033ms at concurrency4 with zeroinfra. Both recovery failures are classified implementation_concern: observer synthesized a second tombstone from an idempotent close even though wait already observed it. Skill behavior and subsequent resume were correct. Candidate12 guards same-session prior tombstone in evidence projection; scorer/corpus/skill unchanged, actual duplicate tombstone and replacement delegation remain rejected. Focused regression260ms and full deterministic eval6438ms passed. Historical diagnostic12 remains unmodified; fresh diagnostic required.

Diagnostic13 completed25/26 in357370ms, noinfra, stable candidate; both tombstone recovery scenarios passed. Permission-expansion again closed live wrapper early. Architect approves corpus followup task-state clarification as implementation_concern: rejection is only currentwrite and second decisionstage remainsahead; no tool/ID/keep-open hint or write grant. Oracle/expectedtrace/skill unchanged. Prior failure staysreal. Candidate13 oracleunit4484ms and semantic/diff checks passed; newdiagnostic14 atconcurrency4 required.

Diagnostic14 passed26/26 at concurrency4, no behavior/infrastructure failures, 363382ms, stable candidate digest6e68d368488f24c9ff87acd4cd9869568a68c3d0358f240dce3ac5a678c906db (559bytes). Task5.8 complete on frozen-inputs-13. Acceptance-02 high starts a fresh required three-run series with the same candidate and concurrency4; acceptance-01 failures remain separately retained.

## Acceptance 02 disposition

Acceptance02 high completed25/26,24/26,24/26 at concurrency4; aggregate73/78, three behavior mismatches and two infrastructure failures,1444912ms, stable candidate. Every attempt is retained; this is non-green evidence. Serial1 mode-timeout failed initialization after110ms because the mode accelerator matched the unrelated15-second initialization timer. Serial2 launch-progress and serial3 runtime-recovery each corrupted one character of a runtime UUID; serial2 launch-change omitted finalclose. Serial3 permission-covered completed576ms after the final180-second observation poll, too late for published childproof; it remains infrastructure failure.

Approved minimal repairs: remove only15-second mode acceleration and retain real mode timeout; rename the fixture fault honestly to mode-timeout; extend hosted instrumentation observation budget to300s (runtime wait180s unchanged); generate shorter private128-bit base64url runtime IDs without schema/entropy reduction; clarify only final launch-change followup as concluding stage. Corpus trace and exact-ID validation stay fail-closed. Scope classifications and bounded reviews are retained in session history.

Coverage evidence correction: the10 runtime/evaluator scripts matched candidate06, but coverage-owned semantic registry changed later. Earlier broad unchanged-product phrasing is superseded. Fresh full coverage with complete zero-counter audit is required after current repairs; no stale coverage claim establishes archive readiness.

## Candidate 14 local verification continuation

Bounded Sol critic reviewed capture shape-test initialization and 1000ms I/O budgets plus the bootstrap overflow test startup budget: OKAY, no material findings or weakened deadline/overflow assertions. Strict OpenSpec and semantic gates passed. A sandbox full-unit run encountered EPERM in the owned POSIX process-group existence probe; that focused test passed outside sandbox (373ms). The following outside-sandbox full unit had no EPERM but failed with ENOSPC while copying the 108MiB Node fixture and persisting an artifact; free disk was448MiB. These failed runs are retained under candidate-14 and do not establish a unit pass. Independent host load included unrelated browser renderers and another build; no unrelated processes or data were modified.

Fresh deterministic eval passed9969ms (outside sandbox for admitted loopback fixtures), release passed3118ms. Complete artifacts are retained under candidate-14/eval and candidate-14/release. Full coverage and successful full unit remain required; candidate14 has not yet been frozen and no new hosted series has started.

Fresh complete coverage passed88798ms (548pass/1skip,14/14scope; lines99.8779%,branches97.7982%,functions99.8521%); subsequent unit passed89754ms (548pass/1skip). Both complete artifacts retained under candidate-14. These loaded-host timings are not a replacement performance benchmark. Raw coverage audit remains pending before freeze.

Candidate14 raw audit complete:93/93 occurrences classified exactly once; no meaningful uncovered scenarios or dead code.14/14 source digests and artifact hashes verified. Strict/semantic/diff gates pass. Frozen inputs: frozen-inputs-14.json. Diagnostic15 uses concurrency4; prior acceptance02 remains non-green.

Diagnostic15 completed24/26,2behavior/0infra,515792ms,stable candidate6de16788e2ee83dc14f1345b3686516f17bfa7513fa29c27bc51e2acb82ec3c3,concurrency4. Question first answer omitted outcome and selected no option, preventing admitted stale recovery; runtime-recovery omitted finalclose after correct resume/result. Both are real failures, not projector errors. Architect approved skill step3 user-choice→answer composition clarification (baseline_violation minimal repair) and corpus-only final recovery-stage clarification (implementation_concern). Runtime/schema/trace/oracle unchanged. Newcandidate15 requires independent bounded review and fresh release/targeted corpus check; full candidate14 product coverage remains current because no product source changed.

Candidate15 bounded Sol critic OKAY; targeted oracleunit4243ms and release3008ms passed, strict/semantic/diff pass. Product source unchanged vs candidate14 complete unit/coverage/eval and93-point audit. Frozen inputs15 published; diagnostic16 concurrency4, one attempt per scenario.

Diagnostic16 passed26/26,0behavior/0infra,401340ms,concurrency4,stable candidatef198bdcd9da7cc069227360ae50a9f641d1149b0de70dd9726e50960504ea310. Task5.8 complete for frozen-inputs15. Acceptance03 high begins fresh3-run series on samecandidate/concurrency; prior failures retained.

## Acceptance 03 disposition and pending decision

Acceptance03 high finished25/26,24/26,26/26:75/78,three behavior-classified mismatches,0infrastructure,1249090ms,stable candidatef198bdcd9da7cc069227360ae50a9f641d1149b0de70dd9726e50960504ea310,concurrency4. Serial1/2 long-result are verified harness false negatives: full valid read precedes close, followed by allowed valid retained rereads. Serial2 active-followup firstclose omitted one ID character, received unknown_session without effects, then immediately closed correctly; this remains real exact-ID failure under the frozen contract. Original aggregate and attempts remain unchanged; no retrospective pass relabeling.

Architect and independent Sol critic approved a minimal integration projector repair: emit only first verified complete result-read per turn, retaining all invalid EOF/digest and failed-call evidence; first complete only after close still fails. Applied only after the three-run series completed. Raw transcript/runtime/scorer/corpus/skill unchanged. Regression cases extend the existing observer owner. Task5.8 reopened for changed evaluator input;5.9–5.11 remain incomplete.

## Recovery-aware baseline supersession

The pending decision above is superseded by the user's explicitly approved recovery-aware IUX-19 baseline. Acceptance may recover only a raw adjacent pre-action `unknown_session | unknown_turn` failure/success pair for the same existing-session tool in one Codex turn when complete persisted call ranges, zero dropped calls, zero unexpected input requests, one correction to the current causal public ID, and equality of every other canonical raw argument are proven. The failed call and visible error remain audited; the successful call still passes normal trace, authority and effect checks. All other ID lookup failures remain mismatches, and `unknown_request` keeps its distinct fresh-wait recovery. Acceptance03 artifacts and historical counts remain unchanged; the changed candidate must pass tasks 5.8–5.11 anew.

Historical state before the recovery-aware approval (superseded): a separate user decision was pending on whether safely rejected and immediately corrected tool-input errors can be admitted with separate reporting. Architect classifies this as new_scope requiring explicit baseline update; current exact-ID gate is unchanged. Do not silently relax it or replace128-bit IDs with lower-entropy tokens. Medium has not been run because high gate remains non-green.

Historical projector-only verification before recovery-aware implementation: focused observer202ms and complete deterministic eval9510ms passed; strict/semantic/diff checks passed. Regression scenario now explicitly includes existing expected actual/enabled verdict fields required by evaluateScenario (previous trace-only fixture omitted them). Artifacts under candidate16; no new hostedfreeze/series while baseline selfcorrection decision pending. Product source, skill and corpus remain byte-identical to candidate15; candidate14 full product coverage applies.

Acceptance03 integrity verifier PASS (acceptance remains FAILED):547/547 hashed artifacts,78 one-attempt scenario-run pairs,78 published evidence/cleanup success/not_checked,120 complete nonempty finals; full audit candidate15/acceptance03-high-integrity.json. Raw origin diagnostic strings are non-authoritative; all authoritative references remain relative/contained. Current implementation has reviewed+tested projector repair, but no frozen-inputs16 and no new hostedrun. Required user baseline selfcorrection decision is pending; goal is not complete and archive is not ready.

## Candidate 16: recovery-aware implementation ready

The user-approved recovery-aware repair is implemented and independently reviewed: Sol critic OKAY; architect CLEAR after the runtime normative owner acquired the existing pre-action lookup guarantee. Evidence: `candidate-16/recovery-review.json`. The pure oracle owns all pair admission rules; the recorder retains full-argument equality digests, the child boundary persists closed recovery proof, and the outer oracle recomputes the decision. No runtime API, corpus, skill-marker or free-prose judge changes were introduced by this repair. Task 5.7d is complete.

Fresh unit passed 552/553 with one admitted skip in 54865ms. Oracle assertions were then moved from the integration projection test to their unit owner without duplication; both focused tests passed. Final full coverage passed 553/554 with one admitted skip in 62234ms; lines99.8800%, branches97.8762%, functions99.8538%, 14/14 sources. Its raw audit has unclassified=0, meaningful_uncovered=[], dead_code=[]; see `candidate-16/coverage-final/zero-counter-audit.json`. Deterministic eval passed 35/37 with two admitted skips; release passed in2158ms. Structural/semantic/diff gates passed.

`../candidate/frozen-inputs-16.json` binds the final candidate (evaluator e7047494d7a34c578828f18f056bc58e78bcd07e244e383422229fc1710a83ee). Diagnostic17 terra/high started with concurrency4, serial1 and one attempt per scenario. Hosted verdict is pending; tasks5.8-5.11 remain open. Acceptance03 remains immutable.
