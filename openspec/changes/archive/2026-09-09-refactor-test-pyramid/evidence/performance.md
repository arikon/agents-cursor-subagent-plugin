# Performance evidence

## Stabilized source

- Source identity: `3ad6dd1b96a3482ac5f1212e126ecd5c679f1a62`.
- Runtime: Node `v22.23.1` at `/Users/arikon/.hermes/node/bin/node`.
- The working tree was clean before the baseline. The three pre-baseline
  regressions found by the first run were repaired with their focused owner
  tests before accepting any measurement.
- `NODE_USE_ENV_PROXY=1` emits Node's experimental `UNDICI-EHPA` warning.
  Every measured supervisor command uses `env -u NODE_USE_ENV_PROXY`; its
  child `stderr.txt` is empty. This changes only the host runtime environment,
  not CLI assertions or product behavior.

## Baseline protocol

The baseline product source is `3ad6dd1b96a3482ac5f1212e126ecd5c679f1a62` in an
isolated worktree. Four test-only fixture corrections are overlaid there to
make that fixed source runnable on the current Node: stdout/stderr parity in
the fake adapter, its two recorded adapter digests, and the current corpus-row
expectation in `eval-matrix.test.mjs`, and the matching stderr-parity
assertion in `bootstrap.test.mjs`. No `scripts/**` product input differs
from the fixed source.

Each baseline sequence runs the legacy deterministic aggregate followed by one
focused supervisor eval invocation:

```sh
env -u NODE_USE_ENV_PROXY node scripts/run-node-tests.mjs unit
env -u NODE_USE_ENV_PROXY node scripts/run-node-tests.mjs eval --test tests/codex-client-integration.test.mjs --test tests/release-e2e.test.mjs --test-name-pattern 'credential-free app-server adapter pins|hosted app-server config|hosted credential resolution|live canary admits at most one exact-path permission|live result classifier covers every terminal outcome deterministically'
```

The second command admits exactly the five lower-level scenarios that later
move into component owners. The candidate aggregate executes these assertions
under their new owners; the remaining candidate-only tests cover the split and
new supervisor routes. Unguarded installed-Codex plus real/hosted/Claude
canaries remain excluded from both performance sequences.

## Runs

| Run | Legacy aggregate artifact | Whitelist artifact | Result | Sequence wall time | Executed / skipped | Concurrency |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-51-00-482Z-unit-fcc5c7c0-6e39-4a84-82b9-0d378ce75517` | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-52-49-147Z-eval-47598a54-8204-4545-ae4f-89bd48553b8f` | pass | 92.089 s | 772 / 1 | 2, 1 |
| 2 | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-52-53-642Z-unit-4c3586cb-d712-4cb1-a4a6-ac535c08e90c` | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-54-35-926Z-eval-d5a91570-241b-46f6-93ce-ce9c493d2e5d` | pass | 91.465 s | 772 / 1 | 2, 1 |
| 3 | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-54-39-612Z-unit-5c4c880b-683a-4b96-9ddb-b6408e1ad613` | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-56-24-559Z-eval-32aefb6e-cef0-4e6d-9018-758ebacf3de6` | pass | 90.784 s | 772 / 1 | 2, 1 |

The baseline median is **91.465 s**; the range is **90.784–92.089 s**. Each
legacy aggregate records 767 passed tests and one intentional skipped
live-Claude scenario; each whitelist invocation records the five extracted
helper tests as passed.

## Candidate after the split

The selected registry keeps `concurrency: 4` after a direct comparison: the
same aggregate took 95.387 s at 2 and 68.436 s at 4 before the bootstrap file
split. The final split removes the single bootstrap entrypoint from the
critical path. After final review repairs, the same Node and scrubbed host
environment ran the final 777-test aggregate with concurrency 4:

| Run | Artifact | Result | Wall time | Executed / skipped | Concurrency |
| --- | --- | --- | --- | --- | --- |
| 1 | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-43-13-388Z-unit-16e9a9a2-8c2d-4e40-801b-646cfce7368b` | pass | 42.448 s | 777 / 0 | 4 |
| 2 | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-44-06-032Z-unit-c2f338a7-9d57-4a3f-aabc-a2d96ae1298d` | pass | 43.632 s | 777 / 0 | 4 |
| 3 | `/private/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T19-45-00-935Z-unit-1ca8e303-309c-48c7-93d7-dca8f7e61d44` | pass | 43.400 s | 777 / 0 | 4 |

The candidate median is **43.400 s** and range **42.448–43.632 s**. It is
below half of the 91.465 s baseline median (45.733 s); its range does not
overlap the baseline range. Earlier candidate measurements are diagnostics
from before final review repairs and are not used for the conclusion.

The final component, integration, coverage, release, and deterministic eval
runs remain separate gates. The final coverage result reports 777 tests,
empty child stderr, and 99.907% lines, 98.118% branches, and 99.887%
functions.

## Mapping and timing decisions

- The stdio complete-session transport test remains its own owner: its public
  JSON-RPC framing and default wait are not duplicated by runtime tests.
  Runtime owns retained result and stale-answer behavior.
- The two repeated-pending tests remain separate: `withFake` exercises the
  process environment adapter while `withInjectedFake` proves an injected
  environment boundary. Merging them would remove that independent boundary.
- The late-stderr fixture now closes only through a writer-ready test seam.
  The recording-proxy backpressure case waits for its writer marker instead of
  sleeping. The deadline process-tree test already advances its controlled
  clock only after the child publishes readiness.
- A repeated SIGTERM may win the proxy process exit race. The test now accepts
  that terminal form only while still proving its target PID is gone; this
  removes an incidental scheduler assertion without weakening target cleanup.
