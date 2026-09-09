# Проверка реализации и готовности к archive

## Release candidate `0.1.0+codex.20260909214543`

Sync/archive выполнены по явному запросу пользователя. Три adjacent stale
requirements согласованы с existing SW owners; все 12 replacement blocks
имеют проверенные source/replacement pins. Strict archive validation — 15/15,
mechanical semantic gate — 15 changes, `git diff --check` — pass.
Штатный plugin-creator validator проходит через offline cached PyYAML;
зависимости проекта не добавлялись.

- Unit: 798/798, exit 0, 32.877 s;
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T21-54-08-549Z-unit-6253f2e6-8e2b-4134-afa3-eb0a715b6689`.
- Coverage: 798/798, exit 0, 36.828 s, lines 99.92%, branches 99.50%,
  functions 100%, source digests stable;
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T21-55-11-815Z-coverage-fe4891fe-540d-45dd-94dc-20f795d4d868`.
  Все raw zero counters совпадают с классифицированной final queue в
  `evidence/coverage-review.md`: 28 branches, 5 lines, 0 functions,
  unclassified = 0. Denominator сохранён.
- Package release: 14 pass / 1 opt-in skip, exit 0;
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T21-50-58-394Z-release-aeeb3fb3-ba0d-4515-848a-4e581abdd86d`.
- Real Codex: pass, actual loaded skill and cleanup;
  `/private/tmp/state-wait-release-20260909214543-real/0b0393e0-761e-4f7f-b6cb-679fc51bbd9e.json`.
- Hosted: 27/27 pass, one run, concurrency 12, 196.906 s, stable digests;
  `/private/tmp/state-wait-release-20260909214543-hosted.json` и соседний
  `.artifacts/` каталог. Evaluator digest:
  `96b92c75ecce7d8c01a414f15aeabc5639dda5fb78fed855697db9d4a92c6bdc`.

Первый release-unit `21-50-23-992Z` сохранён как failed: owner-loss test имел
недетерминированный ESRCH polling. Он заменён реальным completion signal через
inherited stdout/close с точным readiness и early cleanup, без увеличения
timeout. Независимый reviewer: APPROVE, findings 0. Product behavior не менялся.

## Итоговая приёмка исправлений — 2026-09-09

Независимые verdict: **code/spec APPROVE, architect CLEAR**. Frozen v1 baseline
сохранён. Change синхронизирован с main specs и архивирован 2026-09-09;
подготовлен релиз `0.1.0+codex.20260909214543`.

Полный deterministic unit после заключительного filesystem-race regression:
**798/798 pass**, 0 skips/cancellations, exit 0, 34.659 s, Node 22.23.1,
macOS, supervisor concurrency 4. Artifact directory:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T21-32-09-490Z-unit-f2ef9319-be3f-45fd-a46e-ecf1197b841e`.
Полный coverage на том же неизменяемом product candidate: **798/798 pass**,
exit 0, 38.275 s, concurrency 4, manifest всех 17 product sources сохранён,
source digests stable. **Lines 99.92%, branches 99.50%, functions 100%**.
Artifact directory:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T21-32-57-145Z-coverage-2d26bae0-ac0d-4a5a-9525-de0370cb4613`.
Последний raw `test:coverage` прочитан полностью: все 28 zero branch counters,
5 zero lines и 0 zero functions классифицированы; unclassified = 0.
Meaningful gaps закрыты tests/отдельными acceptance owners; остаточные
defensive/instrumentation points описаны в `evidence/coverage-review.md`.
Новые coverage exclusions и уменьшение denominator не применялись.

Итог: **implementation complete, 16/16 tasks; ready to archive**.
Приведённые времена — стоимость отдельных verification runs, не заявление
о воспроизводимом performance speedup.

Отдельные завершённые acceptance:

- Package release: **14 pass, 1 explicit live skip**, exit 0, 4.225 s.
  Artifact directory: `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T21-29-10-828Z-release-c7340a29-85b6-4b49-9cce-b1377021d299`.
  Реально установлены previous/current/rollback pairs: old schema до close,
  отсутствие прежних ACP/MCP PID перед update, current schema и managed skill,
  loss/repeat на package boundary. Проверка managed bytes сама по себе не
  выдаётся за loaded task cache.
- Credential-free eval integration: **22 pass, 2 explicit opt-in skips**,
  exit 0, 6.963 s. Artifact directory:
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T21-27-16-121Z-eval-c2ac89b9-7757-45e4-8fd9-24c71a474a9c`.
- Real Codex: **pass**, fresh Codex CLI 0.153.4 task с реально загруженным
  skill (`skill_context_seen:true`), delegate/wait/close/final и cleanup.
  Atomic evidence: `/private/tmp/state-wait-verified-real-codex/2d577d06-c2df-4040-917c-6c891ca52b93.json`.
- Hosted `gpt-5.6-sol low`: **27/27 pass**, 0 mismatch/integration failure/skip,
  concurrency 12, один полный run, 217.791 s, `digest_stable:true`.
  Atomic aggregate: `/private/tmp/state-wait-verified-hosted.json`; все 27
  per-run evidence и supervisor artifacts сохранены рядом в
  `/private/tmp/state-wait-verified-hosted.json.artifacts/`.
  Это scoped acceptance обновлённого corpus, **не новая reproducibly-green
  трёхсерийная model baseline**. Изолированный terminal-loss scenario прошёл
  без retry provider effect, с полным independently verified delivery proof.

Real-Codex и hosted подтверждают один evaluator digest
`d6905765974bf7358af7bce275febd76b5d4b6e9aa43173a6a54d035e7594b53`,
skill digest `63c1a4b7dc0e46158344e86663cfb4b76b8779357521f4d854417866f0571902`
и corpus digest `493618061d0e0875b7ac4dd8d29623a23e61c2de5a0cea3c7ad14d118e0db16d`.
Package generation proof и отдельная fresh-task проверка вместе закрывают 4.4.
Breaking close/restart/rollback notice находится в README.

Static/structural проверки: `node --check` для всех изменённых `.mjs`,
`git diff --check`, strict OpenSpec validation и mechanical semantic gate
(15 changes) — exit 0. Main source digests и archived references не изменялись.
Отдельных package lint/TypeScript configurations в проекте нет; LSP reviewer
недоступен (`Transport closed`), поэтому его результат не заявляется как pass.

Неуспешные результаты сохранены, а не скрыты retries:
initial coverage `21-03-28-065Z` не прошёл из-за readiness/file timeout;
последующие readiness repairs сохраняют реальные kill/pipe checks.
`/private/tmp/state-wait-final-hosted.json` — 2 pass / 25 evaluator_drift,
`digest_stable:false`: evaluator был исправлен во время запуска после нового
review finding. Этот run не используется как acceptance нового candidate;
повторный полный run записан в другой aggregate выше.

## Отзыв прежней readiness — 2026-09-09 (история)

**Archive readiness отозвана:** implementation review выявил нарушения SW-1
и SW-7, а также незавершённые runtime/package acceptance assertions. Все findings
и их классификации перечислены в `review.md`; исправления выполняются без
изменения frozen baseline. Ни planning verdict ниже, ни прежний hosted pass
не являются доказательством исправленного candidate.

## Planning-проверка после review — 2026-09-09 (история)

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
