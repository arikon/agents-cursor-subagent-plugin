# Coverage review

## Closeout 22 exhaustive audit

`verification/candidate-22/coverage-accepted/zero-counter-audit.json` passed:
all 92 raw zero counters are classified, none is unclassified. The foreground
coverage run completed with exit 0 in 88,742 ms: 636 tests, 635 pass and one
intentional skip, across all 16 manifest sources. Coverage is 99.9017% lines,
98.2755% branches and 99.8794% functions; current source hashes match.

The review found two meaningful test gaps and repaired their existing owners.
The closeout test now changes both matrix and run concurrency before asserting
the cross-matrix refusal. The runtime capacity test waits for the provider's
excess-request rejection before closing the session. Both raw guard bodies now
have count 1. No production or evaluator input changed in these test repairs.
Eighty-five exact decisions came from the previous audit; the other seven match
independently reviewed exact source/counter identities recorded in the sidecar
and its provenance file. Earlier raw reports and the failed focused test remain
historical evidence.

The finalizer now verifies historical high against its own source freeze and
corpus, marks it `preserved-reference` with current applicability false, and
keeps current diagnostic/medium identity checks. Focused finalizer tests passed
13/13; the repaired runtime capacity test passed 1/1. Architect review is CLEAR.
Current diagnostic is 26/26 and medium is 78/78. Historical high is 78/78;
additional current high is 76/78 and remains unaccepted with both failures
retained. The hosted evaluator/corpus/skill remain the candidate-21 inputs.

## Historical candidate 21 exhaustive audit

`verification/candidate-21/coverage/result.json` passed in 87,422 ms with 636
tests (635 pass, 1 intentional skip) across all 16 manifest sources: 99.9024%
lines, 98.2132% branches and 99.8814% functions. All current source hashes match.
`verification/candidate-21/coverage-accepted/zero-counter-audit.json` classifies
all 96 raw zero counters, with none unclassified. Exact unchanged identities
retain 77 decisions; independent review supplies the other 19 decisions,
including reachable teardown races whose observable outcomes already have tests.

The early-terminal repair adds a real recorder handshake/empty-transcript test
and exercises actual-turn capture prefixes, failed/incomplete evidence and
unchanged full-pass admission. Focused recorder/parser suites passed 42/42 and
58/58; final integration passed 24 tests with 2 expected skips; release passed
12/12. Architect and independent critic found no remaining baseline blocker.
The scoped semantic gate passes; the separate `simplify-task-state-wait` change
still references the previous IUX owner block. Hosted acceptance was pending at
this snapshot; closeout 22 above records the subsequent results.

## Candidate 20 exhaustive audit

`evals/evidence/iux-acceptance-2026-09-07/verification/candidate-20/coverage-complete/2026-09-07T13-14-09-522Z-coverage-15647e79-434e-42b5-beea-8c9671851a2b/result.json`
passed in 88,083 ms with 635 tests (634 pass, 1 intentional skip) and all 16
manifest sources. The current source hashes were checked before candidate 20
was frozen. `verification/candidate-20/coverage-accepted/zero-counter-audit.json`
classifies all 95 raw zero counters; none remains unclassified.

The high carry-forward repair adds observable rejection tests for malformed
proof references and JSON, source corpus binding, source input shape, an absent
critic predicate, an unapproved README change and package drift. The successful
fixture includes the normalized package manifest and proves both package hashes
with the package owner's existing functions. Earlier candidate-20 raw reports
remain historical; their newly found meaningful paths were covered before this
final run. The nine final sidecar decisions cover existing defensive guards and
already owned runtime/package failure paths, with exact source/counter identities.

The focused closeout suite passed 13/13; release passed 12/12 in 2,427 ms.
The foreground semantic CLI passed for 12 registered changes. Architect and
independent critic accepted the narrow user-approved high carry-forward rule.
This coverage audit does not claim completion of the remaining hosted gates.

## Historical candidate 19 exhaustive audit

`evals/evidence/iux-acceptance-2026-09-07/verification/candidate-19/coverage-final/result.json`
passed in 73,162 ms with 617 tests (616 pass, 1 intentional skip), all 16
manifest sources, 99.8999499750% lines, 98.2302771855% branches and
99.8783454988% functions. Its sibling `zero-counter-audit.json` classifies all
92 raw zero counters: 84 exact decisions reused from candidate 18, plus eight
independently reviewed decisions with exact source/counter identities.
Six came from the candidate-19 delta review and two from the matching
candidate-17 auditor guards. No unclassified counter remains.

The delta review found a missing combined failure path: closing an interactive
pending request after the ACP request pipe has closed. The existing runtime
close-pending test now covers both open and closed pipes; public close reaches
tombstone and the turn is cancelled. The fresh raw report records count 1 for
the previously uncovered cancellation-send catch at runtime line 649.
No product code changed for this repair. Source bytes matched this coverage
snapshot at candidate 19 freeze; its earlier coverage runs remain historical.

## Candidate 18 exhaustive audit

`evals/evidence/iux-acceptance-2026-09-07/verification/candidate-18/coverage/result.json`
passed in 75,582 ms with 616 tests (615 pass, 1 intentional skip), all 16
manifest sources, 99.8999666556% lines, 98.2074263764% branches and
99.8783454988% functions. Its sibling `zero-counter-audit.json` passed with
all 93 raw zero counters classified and zero unclassified counters: 88 exact
decisions were reused, and five changed raw identities were independently
reviewed. Source bytes matched the snapshot at that candidate's freeze.

The five new identities reflect Node raw sibling-order changes at existing
auditor guards; none was automatically matched to a different occurrence.
The durable `classifications-auditor.json` records their exact dispositions.
This audit closes local coverage verification, not hosted acceptance.

## Candidate 17 exhaustive audit

The complete-manifest run for candidate 17 is
`evals/evidence/iux-acceptance-2026-09-07/verification/candidate-17/coverage-04/result.json`.
It passed in 75,328 ms with 616 tests (615 pass, 1 intentional skip), all 16
manifest sources, 99.8999666556% lines, 98.1856990395% branches and
99.8783454988% functions.

The sibling `zero-counter-audit.json` completed with status `passed`: all 94
exact raw zero counters are classified and `unclassified` is zero. Twenty-six
decisions were reused only against matching source hashes and counter
identities; the other 68 were independently reviewed and published through the
current sidecar. This completes the exhaustive audit of the coverage-04 raw
snapshot without hiding any counter.

Independent recovery and automation review is retained at
`evals/evidence/iux-acceptance-2026-09-07/verification/candidate-17/recovery-automation-review.json`.
The durable candidate-17 eval and release lanes also passed in 5,571 ms and
2,183 ms respectively. The final unit lane passed in 66,996 ms. Independent
review verdicts are `OKAY` and `CLEAR` for the recovery and automation scope.

After coverage-04 was recorded, focused auditor-03 passed 49 tests in 578 ms and
added the opposite-ordering behavioral case against the same auditor source.
That later focused run is supplemental evidence: it is not retroactively part
of the coverage-04 raw counters, and a fifth full coverage run is not required
solely to exercise the alternate operand after the exhaustive snapshot was
classified.

## Historical candidate 16 audit

Fresh complete-manifest evidence: `node scripts/run-node-tests.mjs coverage`
passed in 62,234 ms with 554 tests (553 pass, 1 intentional skip), 99.8800%
lines, 97.8762% branches and 99.8538% functions. All 14 manifest files were
reported and the coverage gate emitted no diagnostic. Durable supervisor
artifacts and the exact work queue are under
`evals/evidence/iux-acceptance-2026-09-07/verification/candidate-16/coverage-final/`:
`result.json`, `tap.txt`, `stderr.txt`, `failures.jsonl`,
`zero-counters.json` and `zero-counter-audit.json`.

The last raw `test:coverage` event is the owner of this audit. It contains six
zero-count lines, 85 raw zero-count branches and one zero-count function across
seven files. The aggregate branch denominator has 83 uncovered branches because
the narrow exclusions next to `check-openspec-semantics.mjs:551` and
`cursor-subagent-mcp.mjs:571` remove their executable lines while Node 22 still
emits raw branch records. `zero-counter-audit.json` retains every repeated
counter with an occurrence number, the 14 coverage-time source digests and
hashes of the durable evidence files.

## Observable contracts already owned by behavioral tests

These counters are short-circuit or projection operands inside public
contracts already exercised through runtime, transport, golden-fixture and
capture tests. Another assertion aimed only at the deciding operand would
duplicate the same observable outcome.

- `scripts/codex-app-server-client.mjs` branch 152: polling returns the latest
  bounded absent, nonterminal or confirmed-missing capture.
- `scripts/cursor-subagent-mcp.mjs` branches 83, 85, 98, 130, 133, 141, 143,
  145, 146, 152, 162, 165, 166, 168, 177, 183, 185, 186, 189, 225,
  228, 242, 243, 294, 299, 300 (two counters), 309, 310, 325, 684
  (two counters), 685, 698, 701 and 786. The owned outcomes are invalid adapter
  and manifest data, collaboration and pending-request admission, bounded
  envelope variants, deterministic eviction, launch limits and addressed-wait
  validation. The former zero counters at branches 221 and 233 are covered in
  this run.

## Realistic dependency, transport and ordering paths already owned

- `scripts/codex-app-server-client.mjs` branches 162 and 191 map exhausted
  turns/items page budgets to `capture_timeout`; positioned slow-page tests own
  the public source and error-code outcomes.
- `scripts/cursor-subagent-bootstrap.mjs` branch 175 is the repeated-kill
  idempotence arm. The first-kill-reason and simultaneous stdout/stderr overflow
  tests prove one stable terminal result; which callback attempts the second
  kill is scheduler-dependent.
- `scripts/cursor-subagent-mcp.mjs` branches 447, 451, 534, 538, 545, 573, 628,
  629 and 653 cover closed/asynchronously failing transport, late or malformed
  callbacks, filesystem callback failure, answer-write ordering and
  best-effort cancellation response. Injected EPIPE, closed-transport,
  post-completion callback and exactly-once tests own these outcomes.
- `scripts/eval/run-cursor-skill-eval-matrix.mjs` branch 158 is the empty
  active-child set at interrupt delivery. The foreground interruption test
  sends SIGTERM and SIGINT and proves one exit 130 without a partial aggregate.
- `scripts/recording-mcp-proxy.mjs` branches 213 and 224 plus anonymous function
  `@224` belong to the output-flush boundary. Real backpressure tests prove that
  accepted output and the final response are fully flushed before exit. In this
  run Node completed the write callback before child close, so the alternate
  promise arm remained raw-zero.

These paths remain admitted and are not coverage-excluded.

## Genuinely unreachable defensive counters in the admitted flow

- `scripts/check-openspec-semantics.mjs` branches 146 and 551: a delta
  `spec.md` disappearing after directory enumeration is a filesystem TOCTOU
  defense; the CLI entry guard is import-only in coverage and is separately
  owned by the foreground semantic-gate command.
- `scripts/cursor-eval-scenario.mjs` branch 451: the two mode protocol faults
  require mutually exclusive single fixture predicates, and their earlier
  per-fault admission checks reject any conjunction before this pairwise guard.
- `scripts/cursor-subagent-bootstrap.mjs` branches 24, 387, 401, 437, 446, 497
  and 673 (two counters): normalized diagnostics, canonical topology,
  versioned adapter messages, recovery-journal provenance and typed
  `BootstrapError` provenance close these fallback arms.
- `scripts/cursor-subagent-mcp.mjs` branches 26, 171, 271, 454, 461, 465, 571,
  611, 616, 624 and 649. These are normalized-string fallback, admitted task
  type, guarded receipt, synchronous stream throws after a writable precheck,
  an above-frame-size filesystem write, synchronous prompt dispatch after live
  admission, stale completion, missing already-claimed pending request and
  repeated terminalization. Same-batch response/error, late-result,
  cancellation and transport tests prove the surrounding public invariants.
- `scripts/eval/run-cursor-skill-eval-matrix.mjs` lines 142-146 and 235 plus
  branches 141, 192 and 234: the first group is the bounded fallback after a
  locally synthesized result is revalidated; the admitted model corpus is
  nonempty; owned artifact publishers create regular files and directories.
- `scripts/recording-mcp-proxy.mjs` branches 42, 51, 200, 227, 247, 291 and
  303: JSON-decoded MCP arguments cannot have a null prototype; pending values
  are checked before compaction; validated call provenance, a closed handshake
  shape, duplicate failure/stop guards and late callbacks after terminal failure
  cannot add a separate public outcome.

No new exclusion was added.

## External integration owner

- `scripts/eval/run-cursor-skill-eval-matrix.mjs` branch 24 selects the real
  default evaluator driver. Credential-free unit coverage deliberately injects
  a fingerprinted child; the authenticated hosted matrix is the integration
  owner for this branch. This is an existing acceptance gate, not a local
  coverage repair.

## Fully covered files and dead code

The other seven manifest files have no zero counters:
`scripts/cursor-skill-eval.mjs`, `scripts/openspec-semantic-registry.mjs`,
`scripts/node-test-reporter-v22.mjs`, `scripts/run-cursor-skill-eval.mjs`,
`scripts/run-node-tests.mjs`, `scripts/run-unit-coverage.mjs` and
`scripts/eval/run-cursor-skill-eval-suite.mjs`.

No residual counter is dead code and no meaningful contract or realistic
failure path lacks a behavioral owner in this snapshot. The only remaining
coverage evidence dependency is the already-required hosted default-driver
gate above.

This final snapshot includes the current semantic-registry digest
`204de80c...9cee` and the recovery bridge assertions at their unit-test owner.
Relative to the preceding candidate-16 snapshot, the oracle function at 772 and
branches 774/775 are now covered. Runtime branch 653 reappeared under scheduler
ordering and retains its candidate-14 classification against the unchanged
runtime source hash.
