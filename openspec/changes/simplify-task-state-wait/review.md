# Review и минимальные исправления

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
