## Context

См. `proposal.md` для мотивации. `bootstrap.test.mjs` создаёт отдельный
temporary root для каждого сценария и передаёт собственный environment в
bootstrap runner. Один recovery-сценарий задаёт
`FAKE_CODEX_TIMEOUT_OPERATION`, но вызывает production default timeout 10 000
ms. В соседнем компенсационном matrix-тесте уже используется тот же public
`runPackageCommand` с test-only `timeoutMs: 100`.

`node-test-supervision` остаётся владельцем registry lane, fixed concurrency,
timeouts, deadlines, artifacts и coverage gate. Этот change лишь ссылается на
его `NTS-3`, не меняет значения registry и не добавляет второй источник policy.

## Goals / Non-Goals

**Goals:**

- Убрать реальное ожидание production timeout из одного unit-test сценария,
  сохранив проверку timeout, компенсации и recovery outcome.
- Сохранить воспроизводимый foreground unit и coverage acceptance path.

**Non-Goals:**

- Изменение production `PACKAGE_LIMITS`, bootstrap lifecycle или error codes.
- Изменение `unit`/`coverage` concurrency, test manifest, deadline, coverage
  threshold либо release lane.
- Внутрифайловая параллельность, split `bootstrap.test.mjs`, fake clock или
  scheduler abstraction.

## Decisions

### Локальная test-only timeout-инъекция

Timeout-сценарий получает `runCommand`, который делегирует существующему
`runPackageCommand` и подменяет только `timeoutMs` на короткое значение. До
выбора значения выполняется stress-run: значение допускается лишь если 25
последовательных targeted прогонов сохраняют observed partial mutation и все
recovery assertions. Начальным кандидатом является 1 000 ms: он оставляет
headroom для startup fixture, но убирает большую часть прежнего 10-second wait.
Все остальные command options, fixture env и recovery assertions остаются
прежними. Это использует уже применённый в файле паттерн и не расширяет
production API.

Альтернатива уменьшить `PACKAGE_LIMITS.timeoutMs` отклонена: она меняет
реальную надёжность install/update команд вместо скорости test fixture.
Альтернатива clock/scheduler injection отклонена: для одного command timeout
она добавляет новый seam без измеренной необходимости.

### Не менять файловую и внутрипроцессную конкуренцию

Измеренный critical path — `bootstrap.test.mjs`; при существующем `concurrency:
2` параллельный `runtime.test.mjs` уже заканчивается раньше. Увеличение
file-concurrency не сокращает этот путь. Внутри `runtime.test.mjs` существуют
process-global environment и timer patches, поэтому blanket concurrent tests
меняет изоляционную модель.

Альтернатива `concurrency: 3` отклонена до отдельного clean Node 22 benchmark
после устранения критического timeout. Split bootstrap scenarios также
отклонён из текущего v1: его безопасность и effect size ещё не подтверждены.

## Risks / Trade-offs

- [Короткий timeout перестанет вызывать нужную compensation ветвь] → targeted
  test сохраняет все текущие state/recovery assertions, затем проходит полный
  foreground unit lane.
- [Изменение fixture затронет production policy] → bootstrap/runtime product
  source исключён из task scope; допускается лишь governance registry для
  reference-only admission, а final diff review отклоняет policy-правки.
- [Шум host-нагрузки исказит результат] → до и после apply измерять минимум
  три foreground unit-прогона на Node 22 и сравнивать median при одинаковом
  `concurrency: 2`.

## Migration Plan

1. До любых source/test/registry edits собрать три foreground unit timings на
   закреплённом Node 22 и записать `duration_ms` из `result.json` как
   pre-change median/range.
2. Добавить reference-only запись change в semantic registry и fixture/test,
   затем убедиться, что semantic gate принимает complete artifact tree.
3. Добавить test-only timeout injection в bootstrap test; выполнить targeted
   stress-run и при смене timeout начать серию заново.
4. Собрать три post-change `duration_ms` на той же host/Node 22 конфигурации,
   затем выполнить unit, coverage и final changed-file review.

Rollback: удалить test-only override; production code, registry lane policy и
пользовательские команды не требуют миграции.

## v1 Contract Baseline

**Goal.** Ускорить один детерминированный timeout failure-path unit-тест без
изменения production bootstrap policy.

**Non-goals.** Изменение bootstrap/runtime product timeout или policy, lane
registry, файловой или внутрифайловой concurrency, test manifest, deadline,
coverage и release lane. Governance registry изменяется только для
reference-only admission.

**Public-invariant index.** `NTS-3` → «Lane selection и coverage scope»:
существующий owner сохраняет fixed lane policy; этот change лишь доказывает,
что оптимизация test fixture её не изменяет.

**Owner map.** `node-test-supervision` сохраняет владение runner lifecycle,
artifacts, reporting, lane registry и coverage gate. `cursor-subagent-bootstrap`
сохраняет lifecycle реализации. Этот change не создаёт нового capability owner.

**Implementation-ready exit.** Reference-only admission имеет ровно одну
валидную owner-ссылку. Выбранный timeout выдерживает 25 последовательных
targeted runs с observed partial mutation и recovery outcome. Targeted bootstrap
и semantic tests проходят; полный foreground unit и coverage завершаются
terminal pass. Coverage artifact проанализирован по lines, branches и
functions, а final changed-file inventory не содержит bootstrap/runtime
production-policy или lane-policy правки.
На закреплённом Node 22 post-change median трёх unit runs уменьшается минимум
на 6 s и выходит ниже pre-change range; иначе change не принимается и timeout
override откатывается.

**Future-change candidates.** Измеренный split независимых bootstrap scenarios
в отдельные files; точечная миграция runtime scenarios на injected environment;
повторный clean benchmark `concurrency: 3` после сокращения critical path.
