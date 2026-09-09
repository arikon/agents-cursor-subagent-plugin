## Context

Мотивация — в `proposal.md`. Правила качества, пирамиды, дедупликации,
performance evidence и coverage определяет `AGENTS.md`, раздел
«Running tests and coverage»; этот документ задаёт только решения change.

Проверенный supervisor имеет `unit`, `coverage`, `release`, `eval`; первые два
используют один список из 16 файлов и concurrency 2. `runHarness` выбирает
admitted test через `eval --test` с pattern. У `eval` также есть package path;
его нельзя удалять как якобы дублирующий release. Новых component/integration
команд на момент proposal ещё нет.

В текущих тестах есть process-global подмены environment, timers и `Date.now`.
`runtime.test.mjs` поднимает fake ACP в настоящих процессах; простой rename
или перенос такого сценария в component lane не меняет его уровень.
У `release-e2e` и `codex-client-integration` есть чистые функции harness,
которые сейчас исполняются вместе с верхними уровнями.

Два диагностических запуска из этой сессии заняли 89,4 и 84,8 s, но завершились
56 failures при загрязнении stderr предупреждениями `UNDICI-EHPA`. Они не
являются успешным baseline. Первый run указал на runtime 53,9 s, closeout
21,0 s, bootstrap 15,4 s; внутри runtime два drain-сценария заняли около
10,2 s, capacity-сценарий — около 8,6 s. Эти числа лишь направляют измерения.

## v1 Contract Baseline

**Goal.** Реализовать выбор уровней и изоляцию live-путей по `PYR-1`/`PYR-2`,
перестроить существующие тесты без изменения product behavior и подтвердить
целевое двукратное ускорение эквивалентного полного локального набора.

**Non-goals.** Новые runtime/ACP/MCP semantics, изменение corpus или operator
skill, product limits, coverage threshold, runner lifecycle и формата artifacts;
новые зависимости, scheduler framework, remote execution, retries и кеширование
прошлого pass. Hosted модельный baseline не переснимается автоматически из-за
переноса файлов; прежние evidence не маркируются как evidence нового digest.

**Public-invariant index.** `PYR-1` → «Выбор уровня детерминированной проверки»; `PYR-2` → «Изоляция live opt-ins по выбранному eval-пути»; `NTS-1` → «Терминальный foreground verdict»; `NTS-2` → «Диагностика текущего прогона без console шума»; `NTS-3` → «Lane selection и coverage scope».

**Owner map.** `node-test-supervision` owns test-level selection and live opt-in routing.
Его прежние NTS owners сохраняют lifecycle, reporting и coverage. Runtime,
facade, package и eval сохраняют свои product contracts. Проектная governance
остаётся только в `AGENTS.md`; delta-spec добавляет лишь observable supervisor
selection/routing. Списки и mappings находятся в существующем supervisor;
evaluator dependency inventory остаётся в `scripts/cursor-skill-eval.mjs`.

**Implementation-ready exit.** Все артефакты заполнены, strict и deterministic
semantic gates проходят; независимый critic не находит baseline_violation,
architect подтверждает классификации и минимальность. Apply может начать
подготовительные задачи фиксации исходного среза и baseline; перед переносом
tests подтверждены актуальные SW surfaces, отсутствие конкурирующего writer
в выбранной рабочей копии и успешный baseline. Выпуск/archive соседнего change
не являются prerequisites. Это не заявление о пройденных acceptance tests.
Готовность к archive требует всех implementation tasks и performance acceptance
из раздела «Измерения»; заполненные документы сами по себе этого не доказывают.

**Future-change candidates.** Более широкий runtime transport injection,
адаптивный scheduler, повышение coverage baseline и пересмотр hosted corpus —
только отдельными changes при наличии доказанной необходимости.

## Goals / Non-Goals

**Goals:** простые фиксированные списки уровней, проверяемое сохранение
сценариев и более короткий полный локальный feedback loop. Физическая раскладка
тестов отделяет уровни и позволяет балансировать process integration.

**Non-Goals:** переписывать runtime ради удобных mocks, переносить business
assertions вверх, делать большой cleanup product code или менять scope
незавершённого соседнего change. Конкретное число файлов и concurrency не
являются product requirement.

## Decisions

### Один registry, совместимый агрегат

В `scripts/run-node-tests.mjs` формируются фиксированные `componentTests` и
`integrationTests`; `unitTests` вычисляется из их объединения. Один список
не копируется в другой. `coverage` использует тот же агрегат в одном runner
процессе: merge нескольких coverage reports и новый artifact format не нужны.
`component` и `integration` используют существующий `runSupervisor`, parser,
reporter и selectors. Исходные timeout/deadline bounds берутся из текущего
локального lane; concurrency подбирается в существующей конфигурации по замерам.

Live Claude test убирается из локального агрегата и допускается в `eval`.
Тест live model discovery может оставаться в release entrypoint с очищенным
флагом в `release` и явным enable только при focused `eval`. Compatibility
проверка принадлежит этому живому пути; его чистые classifiers и cleanup
helpers переносятся вниз. Names/patterns в harness корректируются вместе с
переносом, сохраняя сценарный package route и единственный lifecycle.

Достаточно небольшой явной таблицы admitted flags → test files рядом с LANES.
Пустые/выключенные flags не включают canary. Для включённых комбинаций
проверяется совместимость с выбранными файлами, после чего формируется child
env. Это защита от ошибочного запуска, не sandbox и не policy engine.

Начальная таблица для текущих installed entrypoints (реализация имеет одного
владельца в supervisor, здесь зафиксирован план миграции):

| Enable-флаг со значением `1` | Совместимый focused `eval --test` |
| --- | --- |
| `CURSOR_EVAL_REAL_CODEX`, `CURSOR_EVAL_HOSTED_CODEX` | `tests/codex-client-integration.test.mjs` |
| `CURSOR_SUBAGENT_LIVE_E2E`, `CURSOR_MODEL_DISCOVERY_LIVE` | `tests/release-e2e.test.mjs` |
| `CLAUDE_MARKETPLACE_CANARY` | `tests/claude-marketplace-canary.test.mjs` |

При сохранении текущих файлов эти mappings проверяются без настоящих credentials
через наблюдаемый child env и pre-spawn rejection. `full-live` передаёт только
свой флаг и не считается проверкой model discovery; discovery выбирается
отдельно. Изменение имён entrypoints сопровождается переносом mapping и callers,
без самостоятельного списка в helper-модулях.

Отдельно проверяются tests, вызывающие установленный CLI без opt-in guard:
например, текущий `credential-free Codex client observes only the
package-bootstrap-installed skill` реально запускает Codex. При extraction он
остаётся в отдельном real-Codex пути с соответствующим explicit enable; из
deterministic baseline он исключён. Одного удаления inherited flags для этого
недостаточно.

Альтернативы: заменить `unit` чистым component-only набором — отклонено, так
старый полный gate незаметно потеряет integration coverage; ввести второй
runner — отклонено, он дублирует NTS lifecycle.

### Разделение тестовых owners

До перемещения составляется одна change-local таблица сценариев в
`evidence/scenario-map.md`: исходный test/подсценарий, сохраняемый observable
контракт, уровень, новый test owner, операция keep/move/merge/remove и причина.
Это временное evidence рефакторинга, не второй исполняемый registry. Для
каждого merge/remove записывается оставшийся владелец уникальных assertions.

| Текущая группа | Направление переноса |
| --- | --- |
| facade, pure schema/oracle/classifier checks | Component, с существующими injected doubles |
| runtime spawn/admission/diagnostics и launch argv | Process integration, отдельная cohesive группа |
| runtime callbacks, questions/plans/permissions, mode changes, collaboration | Process integration, отдельная cohesive группа |
| runtime lifecycle, capacity, cancellation, TTL, resume | Process integration, отдельно от дорогих startup drains |
| runtime result/paging/wait/progress | Process integration; чистая validation без процесса выделяется в component |
| bootstrap, app-server, supervisor, matrix, closeout | Разделить pure cases и реальные process/filesystem boundary cases по телам тестов |
| release/client eval helpers | Извлечь нижнеуровневые проверки; сохранить только собственную integration/acceptance ответственность наверху |
| installed package, real Codex, hosted model, Claude | Сохранить отдельные acceptance paths; live test не входит в локальный агрегат |

Первые четыре runtime-группы из сессии давали примерно 11–16 s каждая, но
измерены на неуспешном общем run. После level split баланс проверяется заново.
Общие runtime fixture/env/wait helpers имеют один тестовый модуль без top-level
регистрации tests; экспорт из test entrypoint ради переиспользования исключён.
Та же граница применяется к извлечению release/client harness helpers. Если
переносимый helper остаётся тестовой инфраструктурой, он не становится новым
production API.

### Ограниченная дедупликация

Подтверждённые в сессии кандидаты перепроверяются на стабилизированном checkout:

- `MCP tools/call wires one complete session through stdio JSON-RPC` — удалить
  только после mapping assertions на `MCP wires cursor_read_result through the
  public tool boundary`, interactive transport и runtime retention/late-answer
  owners. Его повторный default-timeout call также учитывается в mapping.
- `wait returns an already pending request without consuming its timeout` и
  `repeated pending observation omits the progress excerpt` — объединить,
  сохранив status, pending equality, wait_timeout и отсутствие progress.
  Первый сейчас использует `withFake`, второй — `withInjectedFake`; до merge
  проверяется, не теряется ли самостоятельная проверка adapter/env boundary.
  Если теряется, сначала сохраняется её собственный owner, либо merge отменяется.

Ожидаемая экономия этих двух сокращений — лишь доли секунды по старому run.
Они не являются обоснованием ×2. Real supervisor execution не заменяется
injected invocation test; turns/items pagination, eviction/retention,
pending/terminal и installed package/direct runtime не считаются дублями по
общему error code или одинаковой цепочке вызовов.

### Управляемые ожидания и ограниченная concurrency

Сначала стабилизируются fixtures и источник stderr interference, затем
оптимизируется измеренный critical path. Для drain/deadline сценариев
используется локальный test-only контроль срабатывания таймера после явного
подтверждения готовности writer; реальные EPIPE, late diagnostics, child close
и cleanup assertions остаются. Product `LIMITS` не меняются. Повторное
сокращение timeout, уже сделанное архивным change, не выдаётся за новый выигрыш.

Для файлов с global mutations сохраняется последовательное исполнение.
Между изолированными integration-файлами сравниваются concurrency 2 и 4;
выбирается измеренно устойчивый вариант в существующем registry, без нового
автотюнера. Для closeout проверяется bounded parallel подготовка независимых
fixture files; mutations одного bundle остаются последовательными. Перенос
значимой матрицы ошибок в shared mutable session не используется.

### Измерения и acceptance

На стабильном рабочем срезе фиксируются checkout/source identity, Node и
окружение. Для baseline и дальнейших edits используется рабочая копия без
конкурирующих writers; при необходимости — отдельная изолированная копия
проверенного среза с сохранением незакоммиченных SW изменений. Сначала
создаётся scenario map; перед изменением executable/tests
собираются три успешных baseline runs. Из baseline исключаются внешние canaries,
но не будущие нижнеуровневые сценарии: чистые/harness проверки, извлекаемые из
release/eval, выбираются существующими supervisor selectors дополнительно к
старому `unit`. Выбор задаётся точным whitelist имён детерминированных tests,
а не запуском всего `codex-client-integration.test.mjs`: его unguarded real-Codex
canary не входит в baseline. Whitelist сверяется с фактическими subprocess
dependencies и executed scenarios, включая подtests. Точная
последовательность команд и её суммарное wall time
сохраняются в `evidence/performance.md` вместе с refs на атомарные results.
Baseline не изменяет тесты ради замера.

Независимые изменения SW/product/tests после фиксации среза, не входящие в patch
этого рефакторинга, отзывают сопоставимость: перед продолжением повторяются
mapping, gates и baseline. Ожидаемые изменения самого рефакторинга сверяются
с map и не подменяют исходный baseline. Чекбоксы соседнего change не заменяют
успешные результаты локальной проверки.

После переноса выполняются три успешных candidate runs полного `unit` с тем
же набором observable сценариев; удалённые дубли сопоставлены с сохраняющим
их owner. Сравнивается median полного elapsed time baseline command sequence
и candidate command sequence на том же host/Node и при сопоставимой нагрузке.
В evidence сохраняются все runs, диапазоны, skips, actual concurrency и
per-file timings; failure не скрывается автоматическим retry. Успех ×2:
candidate median ≤ 0,5 × baseline median и диапазоны не пересекаются. Если
цель не достигнута, change не объявляется завершённым: остаётся bounded
профилирование в принятом scope; выход за него требует нового решения.

Coverage измеряется отдельно тем же полным агрегатом; сравниваются product
scope и все три метрики, применяется существующий raw-zero audit. Отдельно
фиксируется время package release и необходимых real-Codex checks, чтобы
ускорение local feedback не выдавалось за такое же сокращение всех gates.
Hosted/live provider time не входит в local ×2 metric. Новые microbenchmarks,
performance framework и временные assertions в обычных тестах не добавляются.

## Risks / Trade-offs

- [Source drift от `simplify-task-state-wait`] → стабильная рабочая копия и
  повторные mapping/gates/baseline при независимом drift; внешний release и
  archive не задерживают подготовку рефакторинга.
- [Потеря test при переносе] → scenario map, один executable membership owner,
  behavioral selector tests и полный агрегат с coverage.
- [Повторная регистрация tests при import helper] → helper-модули без test
  declarations, актуализация всех import/read/spawn consumers и evaluator digest.
- [Неустойчивость concurrency или часов] → readiness/cleanup assertions,
  независимые dirs/env, контролируемые deadline races и повторные полные runs.
- [×2 недостижимо локальными изменениями] → честный незавершённый performance
  acceptance, без урезания coverage, сценариев или расширения product scope.

## Migration Plan

1. Зафиксировать рабочий срез SW surfaces, исключить конкурирующие записи и
   проверить mapping/успешный baseline до test edits, не ожидая release/archive.
2. Добавить level lists и focused routes в существующий supervisor с его tests.
3. Перенести сценарии и helpers, закрыть live isolation; обновить callers,
   документацию команд и существующий evaluator inventory.
4. Применить ограниченную дедупликацию и измеренные оптимизации; проверить
   полный local aggregate, coverage, package/eval integration и performance.
5. Провести independent review и archived readiness проверку.

Rollback относится только к patch этого change: возвращаются прежние списки,
imports, fixtures и docs; изменения predecessor и исходные evidence не
откатываются. Внешних установок и миграции persistent state здесь нет.
