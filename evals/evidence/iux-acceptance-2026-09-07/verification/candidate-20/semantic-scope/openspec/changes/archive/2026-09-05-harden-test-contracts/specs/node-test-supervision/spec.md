## MODIFIED Requirements

### Requirement: Диагностика текущего прогона без console шума
Для каждого run supervisor MUST сохранять полный raw output и machine-readable
test report в новом локальном artifact directory. `result.json` MUST быть
атомарным completion marker после flush и содержать `schema_version`, `lane`,
`verdict`, `terminal_cause`, child exit code/signal, test counts/duration,
coverage (либо `null`) и относительные refs `tap`, `stderr`, `failures`.
Reporter parse/incomplete summary, stream/artifact/flush/publish failure MUST
дать `runner_error` согласно precedence table. При success console output MUST
содержать только итоговый summary и путь к artifacts. При failure,
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

Preflight и synchronous spawn failure MUST также публиковать этот `result.json`
с `runner_error`, infrastructure stage и доступными текущему прогону
diagnostics. Исключение возможно только если сама атомарная публикация
`result.json` не удалась.

#### Scenario: Synchronous spawn error оставляет completion marker
- **WHEN** создание дочернего test process завершается синхронной ошибкой
- **THEN** supervisor возвращает `runner_error` и атомарно публикует текущий
  `result.json` с `spawn` infrastructure stage до вывода failure diagnostics

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
contract evidence. Требования к качеству тестов определяются `AGENTS.md`.

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

Каждый manifest source MUST иметь валидный положительный line denominator в
своём per-file report; агрегированные counters MUST NOT компенсировать
отсутствующий из denominator source. Branch/function denominator с нулевым
значением MUST быть явно классифицирован per-file. Legacy compatibility
entrypoint MUST иметь отдельную foreground verification, если его import-only
guard исключается из unit coverage; импорт exported helper не является
доказательством CLI contract.

#### Scenario: Source исчез из line denominator
- **WHEN** per-file report содержит manifest source с отсутствующим,
  нечисловым или нулевым line denominator
- **THEN** supervisor возвращает coverage gate failure независимо от
  агрегированных metrics

#### Scenario: Compatibility CLI проверен как процесс
- **WHEN** compatibility entrypoint сохраняется в продукте
- **THEN** отдельная foreground проверка подтверждает его CLI contract
