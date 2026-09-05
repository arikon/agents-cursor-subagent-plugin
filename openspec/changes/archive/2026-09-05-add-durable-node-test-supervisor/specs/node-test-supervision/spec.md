## Purpose

Определяет надёжный и диагностируемый запуск всех поддерживаемых Node.js test
lanes без ложного успеха от неполного console output или оставшихся процессов.

## ADDED Requirements

### Requirement: Терминальный foreground verdict
Test supervisor MUST запускать выбранный Node test lane как foreground run.
Один `terminal_cause` latch MUST принимать первый deadline, SIGINT, SIGTERM,
reporter-error или artifact-error; последующий `close`, включая exit code `0`,
не может его отменить. Supervisor MUST возвращать `passed` только после
`close(0)`, полного reporter summary, успешного coverage gate (если применим),
flush streams и атомарной публикации `result.json`. Supervisor MUST различать
`failed`, `timed_out`, `interrupted` и `runner_error`; CLI exit code MUST быть
`0` только для `passed` и `1` для каждого иного verdict. Supervisor MUST NOT
использовать принудительный выход Node test runner как нормальный путь
завершения.

| Наблюдение | Verdict | `terminal_cause` |
| --- | --- | --- |
| clean `close(0)` плюс successful reporter/gate/flush/publish | `passed` | `close_0` |
| nonzero exit | `failed` | `exit_nonzero` |
| unsolicited child signal | `failed` | `child_signal` |
| coverage manifest/threshold failure | `failed` | `coverage_gate` |
| deadline инициировал остановку | `timed_out` | `deadline` |
| SIGINT/SIGTERM инициировал остановку | `interrupted` | received signal |
| preflight/spawn failure | `runner_error` | infrastructure stage |
| reporter/stream/artifact/flush/publish failure | `runner_error` | первый cause сохраняется; infrastructure stage записан отдельно |

Infrastructure error имеет абсолютный verdict precedence, но не стирает
первоначальный `terminal_cause`. Если атомарная публикация `result.json` сама
не удалась, отсутствие completion marker ожидаемо: console обязан вывести
stage/path/error и вернуть CLI exit `1`.

#### Scenario: Все тесты завершились успешно
- **WHEN** выбранный lane завершает test runner с exit code `0`
- **THEN** supervisor после `close` публикует компактный success summary и
  возвращает success

#### Scenario: Test runner вернул failure
- **WHEN** test runner завершился с ненулевым exit code
- **THEN** supervisor публикует `failed`, возвращает failure и не требует
  повторного запуска для показа обнаруженных ошибок

#### Scenario: Истёк общий deadline
- **WHEN** test runner не завершился до deadline выбранного lane
- **THEN** supervisor на POSIX завершает только принадлежащее этому run process
  tree, ожидает его terminal state и возвращает `timed_out`

### Requirement: Диагностика текущего прогона без console шума
Для каждого run supervisor MUST сохранять полный raw output и machine-readable
test report в новом локальном artifact directory. `result.json` MUST быть
атомарным completion marker после flush и содержать `schema_version`, `lane`,
`verdict`, `terminal_cause`, child exit code/signal, test counts/duration,
coverage (либо `null`) и относительные refs `tap`, `stderr`, `failures`.
Reporter parse/incomplete summary, stream/artifact/flush/publish failure MUST
дать `runner_error` согласно precedence table. При success console output
MUST содержать только итоговый summary и путь к artifacts. При failure,
interruption или runner error console output MUST содержать все failure details,
которые предоставил Node test runner для текущего run, и путь к полным
artifacts. Успешные individual tests MUST NOT заполнять console output.

#### Scenario: Test assertion не прошёл
- **WHEN** Node test runner сообщает один или несколько test failures
- **THEN** supervisor выводит имя, location и error/cause каждого failure из
  этого run и сохраняет полный report без повторного test execution

#### Scenario: Runner аварийно завершился до test failure event
- **WHEN** Node test runner завершился ошибкой или сигналом без нормального
  failure report
- **THEN** supervisor выводит terminal reason и captured raw diagnostics,
  сохраняя полный raw output в artifacts

### Requirement: Lane selection и coverage scope
Supervisor MUST предоставлять документированные lanes `unit`, `coverage` и
`release`; каждый lane MUST иметь фиксированный список test files, concurrency
policy, individual timeout и deadline. `coverage` MUST измерять только точный
manifest product source scope, а не test files, и MUST публиковать lines,
branches и functions. Отсутствующий, новый незарегистрированный или не
появившийся в per-file report manifest source MUST завершать gate failure.
Coverage gate MUST не позволять снижать зафиксированный minimum baseline
90.00%; manifest-complete clean run MUST иметь не менее 90.00% по каждой
метрике. Повышение baseline требует отдельного change с воспроизводимым
contract evidence. Требования к
качеству тестов определяются `AGENTS.md`.

#### Scenario: Coverage run завершился на minimum baseline или выше
- **WHEN** coverage lane завершает test suite и metrics не ниже 90.00%
- **THEN** supervisor возвращает success и публикует coverage summary

#### Scenario: Coverage run снизил minimum baseline
- **WHEN** lines, branches или functions product source scope ниже
  зафиксированного minimum baseline 90.00%
- **THEN** supervisor возвращает failure с coverage diagnostics

#### Scenario: Release lane не смешивается с unit coverage
- **WHEN** пользователь запускает `release` lane
- **THEN** supervisor выполняет его отдельный тестовый набор и не приписывает
  его результат unit/coverage verdict
