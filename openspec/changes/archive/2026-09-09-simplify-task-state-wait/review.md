# Review и минимальные исправления

## Sync/archive consistency — 2026-09-09

При переносе в main обнаружены stale paragraphs в трёх соседних runtime owners:
`events_lost` в limits; collaboration через wait в callbacks; delivery state и
preview once в full-result paging. Независимый architect классифицировал все
как `baseline_violation` уже frozen SW-1/SW-3/SW-4, не новые invariants.
Минимальный repair удаляет старые consumer обязанности и ссылается на нынешних
владельцев wait/collaboration. Limits, mode/containment, paging/retention и
остальные scenarios сохранены. Три полных delta blocks и их source/replacement
pins добавлены в существующий registry; исходные девять pins не изменены.
Baseline index и task 4.2 обеспечивают traceability всех двенадцати blocks.
Semantic gate после sync/archive проходит без изменения алгоритма gate.

## Implementation review — 2026-09-09

Повторная проверка реализации: **REQUEST CHANGES / BLOCK**. Классификации
подтверждены независимым архитектором; frozen baseline не расширяется.

| Finding | Classification | Repair owner |
| --- | --- | --- |
| Terminal wait пропускает обязательные nullable result/reason | baseline_violation | SW-1: безусловные nullable поля terminal envelope, runtime regression |
| Loss fault совмещён с другими faults; capture записывает hidden success как доставленный, oracle не сверяет полный proof/result/receipt | baseline_violation | SW-7: изолированная row, withheld_response и фактический error, единая проверка recovery и проекция только повторной доставки |
| Package acceptance не доказывает installed recovery и close/install/fresh/rollback двух поколений | implementation_concern | Existing package E2E, tasks 3.4/4.4 |
| Нет достаточных assertions concurrent snapshot, registration/timeout race, immediate T2 и всех terminal rereads | implementation_concern | Existing runtime test owners, task 2.2 |
| Two-question regression не доказывает requested two-permission old/new comparison | implementation_concern | Existing runtime owner, tasks 2.2/4.1; unique question assertions сохраняются |
| Осталось неиспользуемое присваивание terminalWaitDelivered | overengineering | Удалить dead field из runtime |

Прежние зелёные suite/hosted результаты не закрывают эти пробелы. Готовность
к archive требует исправлений и повторной проверки текущего candidate.

Повторный code review уточнил два оставшихся `baseline_violation` в SW-7:
нормализация missing/nonboolean `truncated` в `false` скрывала malformed result;
необязательный provider result digest позволял принять внутренне согласованный,
но независимо не подтверждённый result. Минимальные repairs принадлежат
существующим proxy projection и observer receipt-check: не синтезировать boolean
и требовать независимый digest на fault-specific delivery. Дополнительный
`implementation_concern` — устаревшая cursor-based oracle test matrix — исправлен
одним cursor-free timeout/recovery case с сохранением rejection и authority
assertions; production schema validator в oracle не добавляется.

После этих repairs независимые verdict: code/spec reviewer **APPROVE**,
architect **CLEAR**, открытых findings нет. Повторно проверены 23 изменённых/
новых файла и связанные owners; evaluator inventory покрывает новые зависимости.
Это review исправлений, а не замена полного coverage и acceptance: их terminal
результаты фиксируются отдельно в `validation.md`.

### Закрытие полного implementation/coverage review

Финальные независимые verdict: **code/spec APPROVE, architect CLEAR**.
Все найденные blockers и material risks исправлены; новые production layers,
dependencies, lifecycle или policy owners не добавлены. Полная классификация
raw counters и сохранённые test owners: `evidence/coverage-review.md`.

Дополнительные `implementation_concern` закрыты targeted repairs существующих
тестов: readiness перед deadline, early/active cancellation, failure cleanup
proxy target, malformed adapter/evidence values, deadline между страницами и
равные timestamps при eviction. Удалены только подтверждённые dead fallback
expressions (`overengineering`). Finding о missing captured request относится
к `baseline_violation` SW-7: его guard восстановлен, malformed record даёт
отсутствие recovery proof без исключения и без изменения raw evidence.
Синхронные искусственные Writable throw cases удалены; реальные EPIPE/close и
cancellation assertions сохранены. Evaluator dependency inventory проверен
независимым reviewer, включая transitive import release-generation fixture.
Generated preloads остаются в своих deterministic test owners и не являются
зависимостями исполняемого evaluator.

Исходный независимый verdict: `REQUEST CHANGES`, architect `BLOCK`.
Классификации подтверждены архитектором; текущий пользовательский goal разрешает
исправления и повторную проверку до готовности planning к apply.

| ID | Classification | Finding | Минимальное исправление | Owner |
| --- | --- | --- | --- | --- |
| R1 | baseline_violation | Удалённый wait_state оставался допустимым классом | Ровно address и set_mode в taxonomy, enum и scenario | SW-7 |
| R2 | baseline_violation | Internal collaboration events ожидались публично | Internal projection; public notification/event-burst/progress observations удалены; adapter/golden/ack tests сохранены | SW-4, SW-7 |
| R3 | baseline_violation | Lost terminal response нельзя выразить в eval | Один lose-terminal-wait-response-once fault, bounded withheld response и proof повторного wait; без provider retry/facade state machine | SW-7 со ссылкой на SW-2 |
| R4 | baseline_violation | Progress на timeout можно всегда omit | Условное обязательное presence после accepted text и absence до него; повторяемый excerpt | SW-1, SW-3 |
| R5 | implementation_concern | User-visible progress не проверялся exact data | Existing recovery row с unique progress_text в required_fragments; без новой schema | Task 3.3 |
| R6 | implementation_concern | File update не доказывал смену MCP process | Явный close/restart boundary и package acceptance двух поколений | Task 4.4 |
| R7 | implementation_concern | Cancel scenario называл compact receipt snapshot | Формулировка compact terminal ActionEnvelope/immutable receipt | SW-6 |

Ранее исправленные owner violations SW-6/SW-7 подтверждены архитектором как
минимальные и закрытые. Новый sourceChange admission — подготовка project
semantic gate к проверке existing active source, а не расширение product
baseline: existing registry остаётся единственным владельцем digest/lineage.
Обоснование и границы записаны в design decision 7; tests проверяют
source drift, owner admission и порядок archive.

## Повторная проверка

2026-09-07: независимый critic — **APPROVE**, architect — **CLEAR**.
Новых blockers и material findings нет. Architect отдельно подтвердил
классификации R1–R4 как baseline_violation и R5–R7 как implementation_concern,
минимальность repairs и отсутствие новой нормативной дубликации.
Baseline specification-ready; strict и semantic gates проходят.
Реализация runtime/skill/eval из tasks 2–4 остаётся следующим этапом apply.

## Scoped source rebase — 2026-09-09

Finding: SW-7 сохранял три устаревших inherited paragraphs после изменения
source перед archive. Classification: `baseline_violation`.
Repair: перенесены только три source corrections (admitted capture ranges,
final фактически начатого turn, early terminal до follow-up anchor), затем
обновлены source/replacement digests существующей записи registry.
Независимый architect: **CLEAR**, новых findings нет; минимальность,
сохранение SW baseline и отсутствие нормативного дублирования подтверждены.
Strict validation и semantic gate (14 changes) проходят.

## Review fixes — 2026-09-09

Последний полный review: REQUEST CHANGES / BLOCK.

| Finding | Classification | Minimal repair |
| --- | --- | --- |
| Два полных SW replacement блока не сохраняли MD | implementation_concern | MCP и skill blocks согласованы с уже синхронизированным MD; существующие source/replacement pins берут эти два блока из main, без нового owner или gate logic |
| После natural tombstone одновременно требовался и запрещался close | baseline_violation | Обязательный close заменён ссылкой на существующий close-or-proven-natural-tombstone rule; соседние reread и repeated-close правила сохранены |

Классификации и минимальность подтверждены архитектором предыдущего review.
Повторное независимое review: critic **APPROVE**, architect **CLEAR**; открытых findings нет. Оба подтвердили сохранение MD, минимальность close repair, отсутствие нового ownership и готовность к apply. Новые
permission regression/evidence и scripted acceptance остаются implementation
concern существующего SW-2; расширения функционального baseline нет.
