# Test runtime verification

Implementation follows the user-approved `/private/tmp/cursor-test-speed-research.md` plan and OpenSpec tasks 5.7a–5.7b.

- Two runtime deadline tests invoke the scheduled 15000 ms callback deterministically; production limits and child shutdown remain unchanged.
- Eleven bootstrap lifecycle tables use the same fake-adapter core as the real CLI wrapper: seven from the initial plan and four subsequently requested by the user. Parity covers success, negative, partial, timeout, overflow and reread failure, including persisted state. Real process/wire/kill/close tests remain.
- Capture polling uses injectable clock functions, with real production defaults and separate real transport deadlines.
- The nested process-boundary fixture uses a stable executable through a symlink, retaining real argv, PID, kill and overflow checks. Bootstrap executable admission tests still use regular executable files.
- Supervisor concurrency remains 2; test and coverage manifests are unchanged.

Independent architect verdict: CLEAR. All changes are implementation concerns within the existing verification baseline.

## Initial measured series (before the additional four tables)

| Series | Result |
| --- | --- |
| Runtime deadline pair | 2/2 pass, 252 ms |
| Bootstrap parity and migrated tables | 25/25 supervisor runs pass, 2233–2617 ms |
| Capture with one bounded CPU-load child | 25/25 supervisor runs pass, 1777–2153 ms |
| Full unit | 3/3 pass: 64271, 55599, 53637 ms |
| Unit median | 55599 ms; maximum 64271 ms, meeting median ≤60000 / maximum ≤70000 |
| Full coverage | Failed: two scheduler-sensitive fixture cases; retained in `coverage-before-stability-fixes.json` and repaired before the final series |

Each full unit run reports 556 tests: 555 pass, one pre-existing skip, no failures or cancellations. Compared with the retained pre-change 92113 ms unit observation, median wall time decreased by 39.6%. This comparison is a local measurement, not a guarantee for every host load.

`bootstrap.json`, `capture.json`, `unit.json` and `coverage.json` retain every attempt, source digest, exit code, supervisor result and source-stability check. Completed artifact directories contain final TAP, stderr, raw reporter events and the atomic result. Source was unchanged within each series; the targeted nested-process fixture repair occurred between the focused series and the full series. Full unit/coverage digests also include file modes.

The bootstrap/capture repeats are explicit stability measurements, not hidden hosted-eval retries. Hosted terra acceptance remains a separate gate.

## Final series

The final series follows the additional four-table change and the two targeted fixture repairs. `final-series/*.json` includes the complete source inventory (including root README, plugin manifest and corpus), median/maximum, explicit gate booleans, and hashed relative references to every durable supervisor artifact. The runner refuses to overwrite an existing series.

| Final series | Result |
| --- | --- |
| Bootstrap parity + eleven lifecycle tables | 25/25 pass |
| Capture under controlled CPU load | 25/25 pass |
| Full unit | 3/3 pass: 60988, 55227, 54336 ms; 555 pass / 1 skip each |
| Unit median / maximum | 55227 / 60988 ms; both speed gates passed |
| Full coverage | 3/3 pass: 63664, 65714, 74676 ms; full manifest retained |

All 56 completed final-series runs use one identical full source inventory. All 224 copied artifacts have verified sizes and SHA-256 digests. The final unit median is 40.0% below the retained pre-change 92113 ms observation. Host-dependent real process tests still contribute timing variation.

Coverage is 99.88098% lines, at least 97.80612% branches, and 99.85465% functions. Every raw zero counter from all three runs is classified in the parent verification reports. Run 2 adds only two already-owned runtime callback branches; run 3 adds no counter beyond run 1. No coverage exclusion or manifest reduction was introduced. The matrix default-driver path still requires the separate hosted acceptance gate.

`final-series/closeout.json` records the aggregate gates, exact median/maximum, common source digest and references. Independent evidence review verified the full inventory and all pre-coverage artifacts; parent verification extended the same hash/result checks through all coverage runs. Release also passed (2898 ms), with its complete artifact directory retained under `final-series/release`.

The initial measurement digest covered scripts/tests/skills; it did not include the root README and plugin manifest. Those measurements are retained as historical performance evidence, while the final source-invariance claim uses the expanded inventory.
