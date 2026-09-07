# Coverage review

## Candidate 18 exhaustive audit

`evals/evidence/iux-acceptance-2026-09-07/verification/candidate-18/coverage/result.json`
passed in 75,582 ms with 616 tests (615 pass, 1 intentional skip), all 16
manifest sources, 99.8999666556% lines, 98.2074263764% branches and
99.8783454988% functions. Its sibling `zero-counter-audit.json` passed with
all 93 raw zero counters classified and zero unclassified counters: 88 exact
decisions were reused, and five changed raw identities were independently
reviewed. The current source bytes still match the coverage snapshot.

The five new identities reflect Node raw sibling-order changes at existing
auditor guards; none was automatically matched to a different occurrence.
The durable `classifications-auditor.json` records their exact dispositions.
This audit closes local coverage verification, not hosted acceptance.

## Candidate 17 exhaustive audit

The latest complete-manifest run is
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
