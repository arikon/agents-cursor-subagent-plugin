# Проверка готовности к apply

## Текущая проверка после review — 2026-09-09

SW-1/SW-5 сохраняют синхронизированный model discovery: инструменты, параметры,
envelopes, model preflight и caller workflow. Два source pins берут MD blocks
из main; четыре остальных — archived IUX, три SW-6 — main. В SW-7 устранено
противоречие обязательного close после proven natural tombstone.

Итог: **specification-ready и ready to apply**. Повторные независимые verdict:
critic **APPROVE**, architect **CLEAR**, открытых findings нет. Task 1.1 закрыта;
implementation/release tasks 2–4 остаются открытыми.

- `node scripts/check-openspec-semantics.mjs`: exit 0, 14 changes.
- `OPENSPEC_TELEMETRY=0 openspec validate simplify-task-state-wait --strict`: exit 0, valid.
- `git diff --check`: exit 0; новые Markdown также проверены на whitespace.
- Все девять replacement digests сверены с фактическими delta blocks.
- `openspec instructions apply --change simplify-task-state-wait --json`: state ready.

Доказательство относится к спецификации на текущем checkout; source drift
требует повторных reconciliation/gates/review, а не автоматического обновления pins.
Product tests не нужны для этих spec/digest правок и не запускались.

## Проверка source rebase — 2026-09-09 (история)

Semantic gate выявил source drift SW-7 после завершения predecessor.
В successor перенесены три inherited исправления archived source: ranges по
admitted captures, final только фактически начатых ходов и остановка follow-up
при завершении текущего хода раньше anchor. Обновлены только source/replacement
digests этого блока в registry; алгоритм gate не менялся.

- `node scripts/check-openspec-semantics.mjs`: exit 0, 14 changes.
- `OPENSPEC_TELEMETRY=0 openspec validate simplify-task-state-wait --strict`: exit 0, valid, без прежнего archive INFO.
- `git diff --check`: exit 0.

Predecessor уже архивирован; gate подтвердил совпадение archived source с main.
Product tests не запускались: исправлены delta spec и digest metadata.

## Проверка 2026-09-07 (история)

Исправлены семь находок предыдущего review; mapping и минимальные repairs
записаны в `review.md`. Привязка baseline зарегистрирована: шесть blocks имеют
`sourceChange: improve-interactive-acp-ux`, три SW-6 берут source из main;
source/replacement digests принадлежат только semantic registry.

`node scripts/check-openspec-semantics.mjs` проходит для всех 12 changes.
Focused supervisor unit проверки semantic gate прошли 101/101, exit 0:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-07T12-22-35-167Z-unit-23d23c70-23a4-4090-a4ae-76d22bbc2755`.

Итог 2026-09-07: **готов к apply**. Независимые verdict: critic APPROVE,
architect CLEAR; классификации и минимальность repairs подтверждены.
Planning tasks 1.1–1.3 завершены, implementation tasks 2–4 остаются открытыми.

Финальная targeted проверка governance tooling: 102/102, exit 0,
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-07T12-34-03-593Z-unit-5deb1509-3d56-40fc-8e32-d42881a81d3c`.
Проверен также fail-closed missing source file: существующая structural read
завершает gate с ENOENT. Strict validation valid; semantic gate — 12 changes.

Дополнительно был выполнен избыточный для planning scope полный coverage:
630 passed, 1 skipped, 0 failed; lines 99.90%, branches 98.22%, functions 99.88%.
Результат и аудит всех 93 zero counters сохранены в
`evals/evidence/state-wait-planning-2026-09-07/coverage/`; unclassified = 0.
Это evidence текущего tooling/checkout, а не реализации нового wait.
Запуски использовали `NODE_OPTIONS=--disable-warning=UNDICI-EHPA`: отключено
только экспериментальное предупреждение proxy, без изменения proxy или assertions.
Первый полный запуск без этой настройки был неуспешным из-за warning в CLI output.

Archive readiness отдельна: predecessor ещё active, поэтому OpenSpec сообщает
INFO об отсутствующем main requirement; sourceChange gate проверяет эти blocks
из active predecessor. Перед apply повторяется digest gate; перед archive
необходимо завершить/sync/archive predecessor в установленном порядке.

## Исходная проверка draft (история)

Дата: 2026-09-07.

- `openspec validate simplify-task-state-wait --strict`: exit 0, valid.
- `openspec status --change simplify-task-state-wait`: все четыре planning artifacts созданы.
- `git diff --check`: exit 0 для tracked diff; новые Markdown дополнительно проверены на trailing whitespace.
- `node scripts/check-openspec-semantics.mjs`: exit 1, новый active change отсутствует в semantic registry. Регистрация предусмотрена task 1.2 после sync предшественника; этот результат не является pass.
- Strict CLI отдельно предупреждает, что archive сейчас невозможен: modified requirement «Sparse wait and bounded progress» пока отсутствует в main specs. Оно, как и «Role-neutral mode and collaboration surface», ещё объявлено в активном `improve-interactive-acp-ux`.

Это draft последовательного follow-up. Реализация, архивирование, specification-ready verdict и полный review не выполнены. Existing runtime/skill/registry и artifacts предшественника не изменялись. Product tests не запускались: в этом поручении создаются только planning documents.

## Предварительная проверка связности

Все 9 изменённых требований имеют ссылки в baseline и tasks; 7 Markdown-файлов проверены на trailing whitespace.

| Finding | Classification | Repair |
| --- | --- | --- |
| State-machine, isolation и lifecycle сохраняли обязательства публичного event/cursor чтения | baseline_violation | Полные MODIFIED blocks SW-6 согласованы с SW-1/SW-2; transitions и retention сохранены |
| Eval owner продолжал требовать cursor dataflow, progress revision и events-lost observations | baseline_violation | Полный MODIFIED block SW-7 обновляет прежние assertions; обычная проверка causal IDs сохраняется |

Обе находки получены от независимого critic и исправлены в draft. Итоговый critic verdict и подтверждение классификаций архитектором не получены; preliminary findings не заменяют review из task 1.3. Финальные strict/status проверки после этих правок повторены с указанными выше результатами.
