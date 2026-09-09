## ADDED Requirements

### Requirement: Выбор уровня детерминированной проверки

Supervisor MUST предоставлять lanes `component` и `integration` для раздельного
запуска детерминированных уровней, классифицированных по `AGENTS.md`.
`unit` MUST сохраняться как совместимый полный локальный агрегат: его набор
MUST быть объединением этих двух непересекающихся наборов без повторного
исполнения одного test entrypoint. `coverage` MUST исполнять тот же агрегат.
Выбор уровня MUST NOT исключать тест из полного агрегата только из-за его
стоимости; отдельные package/live acceptance runs остаются вне этого агрегата.

Новые lanes MUST использовать контракт «Терминальный foreground verdict» и
контракт «Диагностика текущего прогона без console шума». Их selectors и
фиксированные политики MUST следовать «Lane selection и coverage scope»:
`component` и `integration` принимают только свои canonical test-file selectors
и один непустой name pattern; недопустимый selector отклоняется до spawn,
а выбор без исполненных тестов не даёт success. Правила `coverage` и его
product-source proof остаются у «Lane selection и coverage scope».

#### Scenario: Полный локальный прогон после разделения файлов
- **WHEN** caller запускает `unit` после переноса сценариев между уровнями
- **THEN** выполняется объединение component и integration entrypoints без
  дублей; перенос между уровнями не убирает сценарий из локальной проверки

#### Scenario: Быстрая выборочная проверка
- **WHEN** caller выбирает `component` с допустимым test-file selector
- **THEN** выполняется выбранный component entrypoint через тот же supervisor,
  а process-integration entrypoints не запускаются

#### Scenario: Selector принадлежит другому уровню
- **WHEN** caller передаёт integration-only файл в `component` или наоборот
- **THEN** supervisor отклоняет вызов до spawn с `invalid_invocation`

#### Scenario: Pattern не выбрал ни одного теста
- **WHEN** допустимый focused вызов нового lane не исполняет ни одного теста
- **THEN** supervisor возвращает failure по существующему zero-test контракту

#### Scenario: Coverage после реорганизации
- **WHEN** caller запускает `coverage`
- **THEN** исполняется полный детерминированный агрегат, а проверки manifest,
  counters и source/artifact proofs выполняются существующим coverage owner

### Requirement: Изоляция live opt-ins по выбранному eval-пути

Supervisor MUST исключать enable-флаги настоящих CLIs, credentials и внешних
provider calls из `unit`, `component`, `integration`, `coverage` и `release`.
Это относится ко всем admitted live canaries, включая Claude marketplace и
Cursor model discovery. Детерминированные loopback fixtures не являются live
opt-in и сохраняют собственный локальный integration path.

В `eval` supervisor MUST сохранять enable-флаг только при явном выборе
совместимого admitted test-file через selector и явной передаче этого флага.
Включённый флаг без такого выбора или для несовместимого test-file MUST
приводить к `invalid_invocation` до spawn. При выборе нескольких test files
каждый выбранный файл MUST быть совместим со всеми сохраняемыми enable-флагами;
иначе вызов MUST быть отклонён до spawn. Отсутствие флага MUST NOT включать live
режим автоматически. Эта проверка маршрута не выдаёт полномочий на действия.

Детерминированный package-сценарий MUST оставаться доступным для явного выбора
eval harness; его допуск не включает live режим и не создаёт отдельный runner
lifecycle. Состав разрешённых flags и test-file mappings имеет одного владельца
в supervisor; test entrypoints используют соответствующие opt-ins.

#### Scenario: Унаследованные live flags в локальном прогоне
- **WHEN** окружение содержит включённые live flags и caller запускает
  `unit`, `component`, `integration`, `coverage` или `release`
- **THEN** они отсутствуют в окружении child; настоящий CLI/provider не
  запускается вследствие этих flags

#### Scenario: Явный совместимый live canary
- **WHEN** caller выбирает в `eval` файл нужного canary и передаёт его enable-флаг
- **THEN** supervisor сохраняет этот флаг и использует существующий lifecycle
  для выбранного canary

#### Scenario: Несовместимый или невыбранный live canary
- **WHEN** включённый live-флаг передан `eval` без test-file selector либо
  хотя бы один выбранный файл несовместим с ним
- **THEN** вызов отклоняется до запуска дочернего процесса

#### Scenario: Package evidence без live режима
- **WHEN** eval harness явно выбирает admitted package E2E без live-флагов
- **THEN** исполняется детерминированный installed-package сценарий с обычными
  supervisor artifacts и без автоматического включения внешнего canary
