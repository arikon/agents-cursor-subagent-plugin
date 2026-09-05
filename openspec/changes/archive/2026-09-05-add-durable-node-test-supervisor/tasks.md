## 1. Контракт supervisor и diagnostics

- [x] 1.1 Для `NTS-3` «Lane selection и coverage scope» добавить неизменяемый lane registry `unit`, `coverage`, `release`, точную matrix/exclusions, единственный child-env scrub-list `CURSOR_EVAL_REAL_CODEX`, `CURSOR_EVAL_HOSTED_CODEX`, `CURSOR_SUBAGENT_LIVE_E2E` и argument validation; проверить contract tests fixed file sets, concurrency, individual timeout/deadlines и отсутствие трёх opt-ins во всех child lanes.
- [x] 1.2 Для `NTS-2` «Диагностика текущего прогона без console шума» добавить Node-v22.23.1 reporter adapter, golden fixture event shapes/destination pairing, streaming TAP/stderr/failures и атомарный `result.json`; проверить success без individual tests и failure одного run со всеми error/cause без rerun.
- [x] 1.3 Для `NTS-1` «Терминальный foreground verdict» добавить foreground supervisor, first-terminal-cause latch и результат `close`; table-driven проверить success, nonzero exit, child signal, spawn error, incomplete reporter output, stream/ENOSPC error и CLI mapping, включая deadline→ENOSPC, close(0)→publish failure и nonzero→reporter failure.

## 2. Bounded lifecycle

- [x] 2.1 Для `NTS-1` «Терминальный foreground verdict» реализовать POSIX process-group ownership и signal forwarding; проверить, что timeout/SIGINT/SIGTERM затрагивают только test-owned parent/child tree и supervisor ждёт terminal state.
- [x] 2.2 Для `NTS-1` «Терминальный foreground verdict» реализовать deadline, TERM grace и KILL escalation без `--test-force-exit`; проверить `timed_out`, сохранённую причину и отсутствие surviving owned child.
- [x] 2.3 Для `NTS-1` «Терминальный foreground verdict» добавить platform admission: на неподдерживаемой ОС fail closed `runner_error` до spawn; не заявлять Windows tree semantics.

## 3. Lanes и coverage gate

- [x] 3.1 Для `NTS-3` «Lane selection и coverage scope» перенести существующий unit coverage invocation на supervisor `coverage` lane; проверить полный `scripts/*.mjs` product manifest, включая versioned reporter, fail-closed equality с per-file report, новый production source и отсутствие test files в gate.
- [x] 3.2 Для `NTS-3` «Lane selection и coverage scope» meaningful boundary/regression tests доводят каждый metric manifest-complete clean run до постоянного minimum baseline 90.00%; проверить success, missing/new/unloaded source и искусственно пониженную metric.
- [x] 3.3 Для `NTS-3` «Lane selection и coverage scope» добавить `release` lane поверх существующего release/eval test owner с очищенными hosted/live opt-ins; проверить отдельный verdict и отсутствие влияния на unit coverage.

## 4. Документация и полная верификация

- [x] 4.1 Для `NTS-1` «Терминальный foreground verdict» и `NTS-2` «Диагностика текущего прогона без console шума» заменить устаревшие прямые команды в README и AGENTS.md на supervisor commands, terminal verdict и artifact-reading procedure; проверить ссылки и команды статически.
- [x] 4.2 Для `NTS-3` «Lane selection и coverage scope» запустить foreground `unit`, `coverage` и `release` lanes, дождаться terminal verdict каждого и сохранить artifact references; проверить manifest-complete coverage не ниже 90.00% по каждой метрике.
- [x] 4.3 Для `NTS-1` «Терминальный foreground verdict», `NTS-2` «Диагностика текущего прогона без console шума» и `NTS-3` «Lane selection и coverage scope» выполнить strict validation, semantic gate и diff check; исправить все findings до apply-ready состояния.

## Verification evidence

- `unit`: PASS, artifact
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-04T22-33-28-588Z-unit-ae811c48-58b1-44b4-a94a-81105bed9aa9`.
- `coverage`: PASS, artifact
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-04T22-42-48-657Z-coverage-0f94d663-25ef-4bc3-904b-c25b2a7293ad`; lines 99.826%, branches 95.117%, functions 98.942%, manifest diagnostics отсутствуют.
- `release`: PASS, artifact
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-04T22-35-45-539Z-release-25bcd579-9f01-410a-8431-a48ecfc39d63`.
