# Raw coverage review

## Evidence

Foreground `node scripts/run-node-tests.mjs coverage` completed successfully:
406 tests passed; lines 99.93%, branches 98.32%, functions 100%.
The completion marker is
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T16-43-21-075Z-coverage-991cc3f1-736f-4e5d-a472-94cdf6971020/result.json`.

The threshold result is not a readiness verdict. The raw `test:coverage` event
is the authoritative work queue below.

## Residual-counter disposition

| Owner | Raw counters with zero V8 count | Disposition and independent evidence |
| --- | --- | --- |
| `check-openspec-semantics.mjs` | 83, 389; lines 390–391 | 83 is impossible after the caller’s exact-marker admission; 389–391 are the import-only CLI guard. `runOpenSpecSemanticsCli` is covered by its foreground CLI test and `node scripts/check-openspec-semantics.mjs harden-test-contracts`. |
| `cursor-subagent-bootstrap.mjs` | 24, 358, 379, 393, 405, 429, 438, 474, 489, 566, 665×3 | Public executable-topology, Node-version, managed-root symlink, and repeated overflow/timeout kill-reason behavior are covered. 379 is individually unreachable on portable filesystems: a symlink is classified as `foreign` at 378; a canonical directory makes `realpath(managedRoot) === managedRoot`. The remaining zero counts are nullish input, normalized `BootstrapError`, adapter fallback, recovery-journal and non-`Error` defensive branches. |
| `cursor-subagent-mcp.mjs` | 22, 59, 61, 120, 123, 128, 137–138, 153, 158, 233, 237, 240, 247, 251, 319, 340, 352, 354–355, 371, 406, 494 | The public child-exit and closed-stdin failures are covered. 128 is the private default of `normalizePending`: protocol callback dispatch admits only `question`, `plan`, or `permission`, so it is not selectable through the public wire. Remaining zero counts are private nullish/TOCTOU, derived callback fields rejected through the same public error result, reentrancy, stream-write-race and eviction-tie guards. 494 is separately proved by foreground temporary-package child-process tests; parent V8 coverage does not merge child coverage. |
| `recording-mcp-proxy.mjs` | 103 | Repeated stop signal is proved by the foreground signal-race proxy scenario. The proxy is itself a child process, so its V8 coverage is not merged into the parent unit report. |
| `run-cursor-skill-eval.mjs` | 56, 258 | Both fallbacks are post-validation impossible: successful child parsing guarantees required provenance and the surrounding branch requires `childResult.manifest`. |
| `run-node-tests.mjs` | 38, 226 | 38 belongs to the locally documented, unreachable stage-error guard. 226 is the raw-stderr fallback guarded with a narrow local Node-runtime exclusion. |

No residual counter is treated as dead code. Meaningful public failure paths
have one test owner above; remaining zero counts are V8 process-isolation or
defensive private-implementation guards. The product coverage exclusions are
the narrow defensive expression in `run-node-tests.mjs`, its raw-stderr
fallback, and the documented import-only CLI guard in `run-unit-coverage.mjs`;
each has an adjacent rationale and an independent foreground observable test.
