Coverage closure for matrix/suite
Source: coverage 2026-09-06T22-05-24-837Z, exact raw counters in cursor-coverage-final-counters.json.
Matrix raw zero lines: 138,139,140,141,142,231. Raw zero branches:14 twice,24,137,152,154,188,230. No zero functions.
- 14 (twice): meaningful CLI omissions. Tests now invoke actually missing model/effort/output (earlier helper appended output). Requires final coverage remeasure.
- 24: default production driver selection. Real hosted matrix owns this integration path; cheap unit composition uses an explicitly fingerprinted substitute. The default path must be proven by the forthcoming hosted runs, not a fake coverage-only driver.
- 137 and lines138-142 (current140-145): defensive validation of a synthesized failure after admitted child-result validation. A bounded fallback preserves a valid public verdict if an unexpected filesystem/dependency diagnostic violates the public encoding limit. Existing malformed/missing/outside evidence tests exercise actual failure behavior; this final defensive fallback is not a reason to inject impossible private state.
- 152: repeated interrupt, realistic operator action; existing interruption test now sends SIGTERM and SIGINT and requires single terminal exit130/no partial summary.
- 154: empty active-child set during interrupted post-child inventory read. Same observable interruption contract is tested; exact delivery timing is scheduler-dependent, no private synchronization API warranted.
- 188: zero model rows. Unreachable for the retained admitted project corpus (26 model rows); fallback remains fail-closed, never establishes a candidate or green acceptance.
- 230 + line231: non-file/non-directory artifact. Admitted supervisor/driver publishers create regular files/directories only. Defensive fail-closed check rejects an unsupported filesystem entry; no product scenario creates a socket/FIFO/symlink inside the owned artifact tree.
Suite: final raw report has no zero lines, branches, or functions. CLI admission and failed/signalled child verdicts are covered through the CLI; rowPassed is the single verdict owner.
No exclusions added. Final coverage remeasure is required after the last bounds/admission test changes.

Final speed-candidate remeasurement: `test-speed/final-series/coverage/run-01/failures.jsonl`, PASS, 63664 ms. Exact zero queue: `test-speed/final-series/coverage-zero-counters.json`.
- Lines 142–146 and branch 141 are the previously classified defensive synthesized-result fallback.
- Branch 24 remains the actual default matrix driver integration, assigned to the required hosted matrix gate; it is not claimed proven by unit coverage.
- Branch 158 is the empty active-child set at interrupt delivery, the already-owned observable interruption contract.
- Branch 192 is the unreachable empty-model-corpus fallback for the admitted 26-row corpus.
- Line 235 and branch 234 are the defensive unsupported artifact-entry guard.
- Earlier CLI-omission and repeated-interrupt gaps are covered. No matrix functions and no suite lines/branches/functions have zero count.

No new unclassified point was introduced by the speed changes. Hosted default-driver proof remains required by task 5.9/5.10 before overall acceptance.
