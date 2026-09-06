# Coverage review

Fresh complete-manifest evidence: `node scripts/run-node-tests.mjs coverage`
passed with 501 tests (500 pass, 1 intentional skip), 100% lines, 96.4234%
branches and 99.8347% functions. Supervisor artifacts:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-06T07-39-18-739Z-coverage-673ea743-af9e-4dc4-8d54-945254309d6b`.

The raw `test:coverage` event, rather than only aggregate thresholds, is the
work queue below. Every residual zero counter is classified exactly once.

## Meaningful public or admission contracts

These are short-circuit alternatives inside closed validation, projection and
failure-mapping expressions. Their observable contracts are covered by the
table-driven invalid-corpus, runtime, transport, bootstrap, supervisor and eval
tests; a zero raw branch means that one internal Boolean operand did not become
the deciding operand, not that the public scenario lacks a behavioral test.

- `scripts/check-openspec-semantics.mjs` branches 27, 35, 177, 414, 415.
- `scripts/cursor-eval-scenario.mjs` branches 219, 225, 228, 318, 324, 329,
  339, 373, 374, 426, 438, 445, 449, 471, 474, 502, 626, 725, 747.
- `scripts/cursor-subagent-bootstrap.mjs` branches 24, 387, 401, 413, 437,
  446, 482, 497, 673 (three counters on line 673).
- `scripts/cursor-subagent-mcp.mjs` branches 24, 42, 81, 83, 96, 128, 131,
  139, 141, 143, 144, 150, 160, 163, 164, 166, 169, 175, 181, 183, 184,
  187, 223, 226, 240, 241, 269, 292, 297, 298 (two counters), 307, 308,
  323, 521, 525, 532, 558, 560, 582, 597, 601, 602, 622, 657 (two
  counters), 658, 671, 674 and 737.
- `scripts/recording-mcp-proxy.mjs` branches 44, 47, 101, 102, 103, 104,
  116, 117, 118, 159, 199.
- `scripts/run-cursor-skill-eval.mjs` branches 71, 81, 152, 153, 156, 177,
  201, 219, 223, 298, 313, 314, 315, 369, 389.
- `scripts/run-node-tests.mjs` branch 55.

Primary behavioral owners are `tests/check-openspec-semantics.test.mjs`,
`tests/run-cursor-skill-eval.test.mjs`, `tests/runtime.test.mjs`,
`tests/mcp-transport.test.mjs`, `tests/bootstrap.test.mjs`,
`tests/node-test-supervisor.test.mjs` and `tests/cursor-skill-eval.test.mjs`.
The new owner-map tests specifically force missing mode/collaboration,
continuation and addressed-wait owners; the timeout-preload tests separately
exercise the 1-hour, 15-second and 30-second timer contracts.

## Realistic dependency, transport and ordering paths

- `scripts/cursor-subagent-mcp.mjs` branches 445, 449, 452, 459 and 463 are
  closed stdin, synchronous/asynchronous write failure, rejected RPC and
  shutdown acknowledgement paths. Runtime and transport tests inject these
  failures and assert fail-closed state.
- `scripts/recording-mcp-proxy.mjs` branches 172, 183, 186, 206, 250 and 262,
  plus anonymous function `@183`, are output callback settlement, duplicate
  failure/stop notifications and cleanup races. Behavioral tests pause the
  consumer, assert that the proxy cannot exit while its large final response is
  backpressured, resume it, and verify the complete response and evidence.
  Node's observed pipe scheduling completes the individual write callback
  before the child-close handler, so the promise resolver at line 183 remains
  a raw zero even though the externally observable flush boundary is exercised.

These remain admitted realistic paths and are not coverage-excluded.

## Genuinely unreachable defensive counters in the admitted coverage flow

- `scripts/check-openspec-semantics.mjs` branch 146 is the filesystem TOCTOU
  guard for a delta `spec.md` disappearing after its parent directory was
  enumerated. Ordinary immutable test fixtures cannot take this branch without
  an unrelated concurrent destructive mutation.
- `scripts/check-openspec-semantics.mjs` branch 547 is the CLI-entry guard while
  the coverage lane imports the module. The same entrypoint is exercised
  separately by the foreground `node scripts/check-openspec-semantics.mjs`
  command; the adjacent narrow line exclusion documents the import-only
  limitation, while Node 22 still reports the guard's raw branch counter.

No additional exclusion is added for either branch.

## Dead code

None. The final report has no uncovered product lines. No source was removed
from the manifest, and no residual counter was classified as dead code.
