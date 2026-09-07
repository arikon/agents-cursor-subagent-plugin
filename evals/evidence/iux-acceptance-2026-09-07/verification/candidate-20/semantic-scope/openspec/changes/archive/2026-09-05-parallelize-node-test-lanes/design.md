## Context

См. `proposal.md` для мотивации. Владелец `node-test-supervision` уже
определяет `NTS-3`: один неизменяемый lane registry задаёт фиксированные
test-file наборы, concurrency policy, individual timeout и suite deadline.
Текущая design-матрица выбирает конкурентность 1 для всех lanes; сам
requirement не закрепляет конкретное числовое значение.

На одном неизменившемся content-hash полный набор из 320 тестов дал:

| File concurrency | Duration | Результат |
| ---: | ---: | --- |
| 1 | 140,9 s | 320/320 pass |
| 2 | 87,7 s | 320/320 pass |
| 4 | 89,4 s | 320/320 pass |

Unit-файлы выполняются в отдельных Node process-isolation workers. Внутри
отдельных файлов остаётся process-global состояние, включая `process.env`,
`process.kill` и timer mocks, поэтому внутрипроцессный параллелизм не входит в
допустимую границу.

## Goals / Non-Goals

**Goals:**

- Выбрать минимальную измеренно эффективную файловую конкурентность 2 для
  `unit` и `coverage`.
- Сохранить один registry owner, terminal foreground verdict и полную
  fail-closed coverage-проверку.
- Доказать отсутствие регрессии на стабильном срезе исходников.

**Non-Goals:**

- Параллельные subtests либо изменение state isolation внутри test-файлов.
- Изменение test-file наборов, timeout/deadline, coverage thresholds или
  artifact/reporting contract.
- Изменение `release`, hosted/live lanes, runtime/facade/package/ACP semantics.
- Scheduler/clock injection, уменьшение production-таймаутов или новый
  `fast`-lane.

## Decisions

### Фиксированная конкурентность 2 только для unit и coverage

Lane registry остаётся единственным источником истины. `unit` и `coverage`
получают `concurrency: 2`; `coverage` по-прежнему использует тот же точный
test-file набор, что `unit`. `release` сохраняет `concurrency: 1`, поскольку
его последовательный интеграционный lifecycle не участвовал в измерительной
матрице.

Альтернатива `concurrency: 4` отклонена: на том же срезе она была на 1,7 s
медленнее и добавляет process contention без наблюдаемой выгоды. Динамический
выбор по числу CPU отклонён: он сделал бы lane policy зависимой от машины и
ослабил воспроизводимость.

### Только файловый параллелизм Node test runner

Change использует существующий `--test-concurrency` и process isolation. Он не
добавляет scheduler, worker pool или второй registry. Contract-тест проверяет
точные argv выбранного lane, включая `2` для `unit`/`coverage` и `1` для
`release`.

Альтернатива параллельным subtests отклонена: несколько test-файлов изменяют
process-global состояние, безопасное только в границах отдельного worker
process.

### Stable-snapshot evidence как условие приёмки

Стабильный snapshot включает все tracked и все non-ignored untracked файлы,
которые возвращает `git ls-files --cached --others --exclude-standard`; `.git`
и ignored runtime artifacts в него не входят. Digest вычисляется одинаковой
командой непосредственно перед первым и сразу после последнего acceptance
lane:

```sh
set -o pipefail
git ls-files --cached --others --exclude-standard -z |
  xargs -0 shasum -a 256 -- |
  shasum -a 256
```

Оба digest записываются в verification evidence и должны быть буквально
равны; вся pipeline выполняется в одной zsh-сессии с exit code `0` и без read
errors. `pipefail` не позволяет последнему `shasum` скрыть ошибку предыдущей
стадии. Это проверка качества измерения, а не новый runtime механизм
supervisor.

### Reference-only semantic admission

Этот change не владеет новым или изменённым capability requirement, поэтому
использует `skip_specs: true` и ссылается на принадлежащее predecessor change
требование `NTS-3` «Lane selection и coverage scope». Semantic registry хранит
эту явную связь, а gate проверяет top-level marker, точное соответствие
requirement ID→title в baseline owner change, capability, traceability в
design/tasks и отсутствие delta-spec. Ссылка участвует в public-invariant
index, но не добавляется в owner map как новое владение.

Более общий policy engine для произвольных связей отклонён: текущему сценарию
достаточна одна проверяемая reference-only запись и негативные fixtures для
отсутствующего/противоречащего marker, пустой и неверной owner-ссылки,
неверного requirement ID, traceability drift и delta-spec.

## Risks / Trade-offs

- [Параллельные процессы повышают CPU/I/O pressure] → ограничить значение
  двумя и не вычислять его динамически.
- [Скрытый общий ресурс между test-файлами создаст flake] → выполнить полные
  `unit` и `coverage`, сохранить serial `release`; при регрессии rollback
  состоит только в возврате двух значений registry к 1.
- [Рабочая копия меняется во время длинного прогона] → сравнивать content-hash
  до и после acceptance matrix и не принимать evidence разных срезов.

## Migration Plan

1. Изменить два значения в существующем lane registry.
2. Обновить один contract-test точной concurrency matrix и только те
   документы, где указаны числовые значения.
3. Зафиксировать reference-only связь в semantic registry и подтвердить её
   positive/negative fixtures.
4. Выполнить foreground `unit`, `coverage`, `release`, strict OpenSpec
   validation, semantic gate и `git diff --check` на стабильном срезе.

Rollback: вернуть `unit` и `coverage` к `concurrency: 1`; schema, artifacts и
пользовательские команды остаются совместимыми.

## v1 Contract Baseline

**Goal.** Сократить wall-clock обязательных локальных Node test lanes через
измеренно безопасный файловый параллелизм.

**Non-goals.** Новые lanes, timer abstraction, внутрипроцессный параллелизм,
изменение тестового состава, thresholds, deadlines или продуктовой семантики.

**Public-invariant index.** `NTS-3` «Lane selection и coverage scope» →
владелец фиксированной lane selection и concurrency policy; этот change меняет
только выбранные значения registry и не создаёт нового requirement owner.

**Owner map.** `node-test-supervision` сохраняет владение runner lifecycle,
artifacts, reporting, lane registry и coverage gate. Node test runner владеет
process isolation. Этот change не вводит новый capability owner.

**Implementation-ready exit.** Semantic gate доказывает корректность
reference-only admission и owner-ссылки; contract-test подтверждает точную
matrix `unit=2`, `coverage=2`, `release=1`; полные foreground lanes завершаются
с terminal pass между буквально равными snapshot digest. Для coverage после
`result.json` разобрано последнее событие `test:coverage` в `failures.jsonl`, а
каждая точка с нулевым `count` классифицирована и разрешена согласно `AGENTS.md`.
Любая содержательная правка аннулирует evidence; финальная полная matrix
проходит повторно без последующих source/test/spec-изменений. Strict
validation, semantic gate и diff check проходят.

**Future-change candidates.** Детерминированное тестирование реальных
timeout/grace intervals после отдельного профилирования.
