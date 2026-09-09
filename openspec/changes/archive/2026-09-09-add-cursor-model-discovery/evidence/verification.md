# Verification Report: add-cursor-model-discovery

**Текущий статус: READY TO ARCHIVE.** Все V1–V4 и связанный пробел evaluator
inventory закрыты; открытых CRITICAL/WARNING/SUGGESTION нет. Финальная приёмка
и её ограничения приведены в `Final assessment`. Ниже сохранён исходный review
с причинами исправлений; его отрицательный verdict больше не является текущим.

## Repair plan — 2026-09-09

Пользователь поручил исправить находки и довести change до ready to archive.
Все V1–V4 остаются `implementation_concern`; frozen MD baseline не расширяется.
Минимальный план: согласовать eval-only catalog/picker и проверить существующие
explicit-model start/resume; добавить behavioral tests MD-6 tie-break и MD-4
нефатального ACP stderr; удалить необязательную глобальную tmp-копию skill.
Затем targeted lanes, полный coverage с raw audit, release, deterministic eval,
strict/semantic gates и независимое review. Archive не входит в эту цель.

Дата: 2026-09-09. Schema: `spec-driven`. Проверка текущего checkout по
`openspec-verify-change`; исправления product/tests и archive не выполнялись.

## Initial review summary (closed)

| Dimension | Status |
|---|---|
| Completeness | 13/13 checkboxes; 8/8 requirements имеют реализацию |
| Correctness | 49 именованных scenarios сопоставлены; дефект eval integration и два пробела behavioral coverage |
| Coherence | Owner map и frozen v1 baseline соблюдены; новых product layers и дублирования lifecycle нет |

## CRITICAL

### V1. Existing explicit-model eval harness несовместим с MD-6

Классификация: `implementation_concern` (test harness). Это препятствует
закрытию приёмки реализации, но не изменяет frozen product baseline.

`tests/codex-client-integration.test.mjs:25` подключает public catalog golden,
а hosted `configureFakeAgent` в `:1753` не включает actual picker fixture.
`tests/fixtures/fake-acp.mjs:52` в этом случае возвращает отсутствующие
`configOptions`, которые корректно отклоняет MD-6 verification.
Дополнительно corpus использует synthetic `sonnet-4.0`, которого нет в
подключённом каталоге: `evals/cursor-subagent-scenarios.v1.json:609`, `:806`,
`:994`. Затронуты `model-runtime-recovery`, `model-launch-progress`,
`model-launch-change`.

Независимый reviewer воспроизвёл credential-free отказ с текущими fixture:
`grok-4.6/high/true` даёт init tombstone с отсутствующим подтверждением
selection; `sonnet-4.0/high/true` даёт `invalid_args` до allocation.
Architect независимо подтвердил wiring и классификацию.

Reproducer reviewer создавал `Runtime` с `readModelAuth` fixture key,
`fetchModels` из текущего golden и `CURSOR_SUBAGENT_ADAPTER_ARGS` pointing to
`tests/fixtures/release-fake-acp.mjs`; затем вызывал `cursor_resume_session`
для обоих IDs с `effort:high, fast:true` и закрывал runtime. Actual stdout:

```json
{"model":"grok-4.6","state":"tombstone","reason":{"text":"Cursor did not confirm the requested model selection","truncated":false}}
{"model":"sonnet-4.0","error_code":"invalid_args","message":"Unsupported canonical model or model parameter combination"}
```

Это диагностическое воспроизведение с обработанными ошибками, не supervisor
lane PASS; shell exit 0 не означает успешного resume. Реальный CLI/HTTP не
использовался, отдельный artifact reproducer не публиковался.

Рекомендация: один общий eval fixture owner должен предоставлять согласованные
synthetic catalog и actual picker для существующих corpus IDs/knobs. Сохранить
семантику corpus; не выдавать synthetic entries за primary-source golden.
Добавить credential-free интеграционную проверку explicit start и changed-model
resume через реальное harness wiring. Новая grammar, product API и hosted
inference для воспроизведения не требуются.

## WARNING

### V2. Не закреплён provider-order tie-break MD-6

Классификация: `implementation_concern` (test only).
Правило задано в runtime delta spec `:40` и реализовано в
`scripts/cursor-model-adapter.mjs:81`. Текущие launch cases в
`tests/model-discovery.test.mjs:183` имеют одного кандидата либо единственный
максимальный score; равные лучшие non-default кандидаты не проверены.
Дефекта алгоритма не обнаружено.

Рекомендация: один параметризованный behavioral launch test с исключённым
default и двумя равноценными кандидатами; перестановка provider order должна
менять выбранный полный variant. Использовать существующую fixture без нового
product API и дублирования в package E2E. Architect подтвердил минимальность.

### V3. Шумный успешный ACP startup не проверен

Классификация: `implementation_concern` (test only). Найдено Cursor и
независимо подтверждено native reviewer после уточнения первоначального mapping.
`tests/runtime.test.mjs:248` проверяет только шумный version probe;
`tests/fixtures/fake-acp.mjs:387` с `FAKE_ACP_STARTUP_STDERR` всегда завершает
ACP с exit 1. Сценарий предупреждения перед успешным `session/new` отсутствует.
Очистка реализована в `scripts/cursor-subagent-mcp.mjs:373`; дефект кода не установлен.

Рекомендация: один runtime test с warning перед успешным ACP new подтверждает
`live`, отсутствие init failure и отсутствие старого warning в последующей
диагностике close/failure. Не проверять приватный buffer напрямую.

## SUGGESTION

### V4. Общий путь временной копии skill в live canary

Классификация: `implementation_concern` (test-only artifact isolation).
`tests/release-e2e.test.mjs:470` перезаписывает один
`tmpdir()/cursor-model-installed-skill.md` при каждом прогоне. Параллельные
canaries могут заменить snapshot друг друга; это не дефект auth или runtime.

Рекомендация: при необходимости сохранять копию использовать уникальный
per-run evidence path, иначе оставить digest в diagnostic без глобальной копии.

## Requirement mapping

| Requirement | Implementation | Scenario evidence |
|---|---|---|
| MD-1, 5 scenarios | runtime:722,746,852; adapter:11 | model-discovery tests:19,35,57,68,80,92,99,138,421 |
| MD-2, 8 scenarios | runtime:240,299,850,918,984 | model tests:199,233,350; runtime tests:373,411,485,884,1901,2132,2159,2472,2502,2578,2594; mcp-transport:72 |
| MD-3, 2 scenarios | LIMITS:11; runtime:746,799,905 | model tests:121,138,405; runtime tests:538,1493,2073 |
| MD-4, 5 scenarios | runtime:354,379,390,657,683 | runtime tests:173,199,248,260,271,2455; release-e2e:474; ACP noisy-success gap — V3 |
| MD-5, 20 scenarios | skills/cursor-subagent/SKILL.md steps 1–6 | operator-guidance audit и existing corpus; V1 ограничивает integration evidence трёх сценариев |
| MD-6, 4 scenarios | adapter:64,86; runtime:438,787 | model tests:183,233,307,315,328,357,380; дополнительное правило tie-break — V2 |
| MD-7, 3 scenarios | runtime:354,438,722,735 | model tests:467,490,505,523,548,560; prior live canary |
| MD-8, 2 scenarios | runtime:443,813 | runtime tests:2438,2455; model tests:199,357; eval integration — V1 |

Ссылки `runtime` означают `scripts/cursor-subagent-mcp.mjs`, `adapter` —
`scripts/cursor-model-adapter.mjs`, `model tests` — `tests/model-discovery.test.mjs`.
Modified requirements включают сохранённые main scenarios; они проверены вместе
с добавленными сценариями, не объявлены новым scope.

## Verification evidence

Свежие `openspec validate --strict`, mechanical semantic gate для 14 changes и
`git diff --check`: PASS. Все contextFiles прочитаны; baseline присутствует.
Независимые native reviewer и architect перечитали текущий code/spec, не
переносили прежний APPROVE автоматически.

Приёмочные команды повторно не запускались: проверены atomic results из
`implementation.md` и совпадение текущих 17 product source SHA-256 с coverage
snapshot. SHA-256 coverage tap/stderr/failures также совпали.

| Lane | Проверенный результат |
|---|---|
| Coverage 15:57:09 | exit 0; 762 pass, 1 skip; lines 99.91%, branches 98.20%, functions 99.89% |
| Runtime/transport 16:06:52 | exit 0; 188 pass |
| Release 16:07:14 | exit 0; 15 pass, 1 opt-in skip |
| Deterministic eval 16:08:50 | exit 0; 27 pass, 2 opt-in skips |
| Isolated live canary 15:55:53 | exit 0; 1 pass; new session без prompt |

Эти результаты остаются действительными в своём scope. Пропущенная hosted
ветка не подтверждает исправность V1. Полное branch coverage adapter также не
доказывает отдельное правило V2. Raw residual audit не заменяет semantic
scenario coverage.

Hosted model comparison не запускался. Реальный persisted provider resume и
inference routing не подтверждались и не объявляются обязательным новым scope.
Discovery model-behavior grammar исключена из v1; operator skill проверен
семантически. GitHub publication и archive не выполнялись.

## Cursor parallel review

Отдельная read-only проверка через установленный Cursor skill завершилась
`completed`; `mode:ask`, omitted model (`auto` requested policy), без заявления
о фактической inference model. Полный результат прочитан через public paging
после truncated preview и сохранён в `cursor-verification.md` (8 353 UTF-8 bytes,
SHA-256 `54c847eb7c47507f49cc997658038abed05206dbf4a4291cd5a93813243fb636`).
Сессия закрыта, `tombstone`. Writes product/tests не выполнялись.

Cursor не нашёл отсутствующих реализаций и указал дополнительные ограничения.
Его результат не подменяет итоговую интеграционную оценку:

| Cursor finding | Единственная классификация | Disposition |
|---|---|---|
| Result artifacts вне его scope | implementation_concern | Закрыто leader: atomic results и source/artifact digests проверены выше; повторный прогон без изменений не нужен |
| Возможный drift после landing simplify-task-state-wait | implementation_concern | Текущие source digests проверены свежим gate; условный rebase уже предусмотрен design/tasks, текущего конфликта нет |
| ACP noisy-success coverage | implementation_concern | Принято как V3, подтверждено независимым чтением |
| Глобальная tmp skill copy | implementation_concern | Принято как V4, низкоприоритетная изоляция test artifact |
| Discovery model-behavior expansion | new_scope | Исключено из v1 согласно frozen baseline; исправления V1 не расширяют grammar |

Eval corpus не был включён в file-review scope Cursor; V1 установлен native
reviewer и подтверждён architect/leader. Поэтому отсутствие этой находки в
Cursor verdict не опровергает воспроизведённую несовместимость harness.

## Final assessment

**READY TO ARCHIVE — 0 открытых findings.** 13/13 tasks завершены; 8 требований
и 49 именованных scenarios сопоставлены, выявленные gaps закрыты. Frozen
baseline сохранён. Архивирование и публикация не выполнялись.

| Finding | Проверенное исправление |
|---|---|
| V1 | Общие fakeCursorPreload/configureFakeAgent используют synthetic eval catalog и actual picker. Новый credential-free installed regression реально выполняет sonnet/high/true delegate, сохраняет conversation и resume с grok/low/true. Corpus/grammar и primary golden не изменены |
| V2 | Один параметризованный launch test меняет provider order двух равноценных non-default variants и проверяет выбранный полный argv/подтверждённый live selection |
| V3 | Nonfatal ACP warning fixture; test проверяет successful live и отсутствие старого warning в публичных terminal diagnostics |
| V4 | Необязательная глобальная tmp-копия удалена; installed skill digest остаётся в diagnostic |
| V1 evidence closure | В существующий EVALUATOR_INPUTS добавлены model adapter, discovery preload, synthetic catalog, primary golden и fake CLI новой регрессии. Расширенный mutation test доказывает изменение aggregate digest при независимом изменении каждого input и неизменном skill digest |

Все исправления — `implementation_concern`, подтверждены architect; два
последовательных независимых source-review verdict — APPROVE, новых замечаний
нет. По явному уточнению пользователя правило dependency inventory закреплено
в `AGENTS.md:56`; отдельные evidence owners не дублируются.

Финальные foreground results (прочитаны atomic result.json и TAP summary):

| Lane | Result | Artifact directory under system `codex-node-test-artifacts` |
|---|---|---|
| Coverage | exit 0; 766 pass, 1 skip; lines 99.91%, branches 98.20%, functions 99.89% | `2026-09-09T16-43-12-332Z-coverage-94922a89-1f12-49bc-94ff-f4d6121fd0ac` |
| Release | exit 0; 15 pass, 1 opt-in skip | `2026-09-09T16-40-28-677Z-release-c5f35d7c-2dc6-47d8-bce3-9296aaef3ec0` |
| Deterministic eval | exit 0; 28 pass, 2 opt-in skips | `2026-09-09T16-45-37-104Z-eval-ba80a24b-50f5-4048-a89b-d22c9908f873` |

Artifact root:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts`.
Все 17 текущих product source digests совпадают с последним coverage snapshot;
полный residual audit находится в `coverage-initial-audit.md`. Финальная
inventory-правка не меняла release test или установленный runtime payload.
Syntax и diff checks PASS; strict/semantic gates PASS. LSP diagnostics
недоступны (`Transport closed`), поэтому отдельный typecheck PASS не заявляется.

Новый hosted model baseline не строился; deterministic harness regression
проверяет его исправленный fixture wiring без model inference. Прежний live
canary сохраняет силу для неизменённых runtime/adapter/skill; его результаты
не расширяются до реального persisted resume или inference routing. Повторный
Cursor review после исправлений не запускался; его находки проверены native
reviewer и закрыты тестами. Эти границы не требуют расширять v1.

## Archive and release verification — 2026-09-09

Main specs synced (3 added and 5 modified requirements); all 13 tasks complete. Archived as `2026-09-09-add-cursor-model-discovery`. The release index excludes the unfinished `simplify-task-state-wait` registry and planning artifacts; its two overlapping blocks were separately rebased in the working tree. The isolated index export passed the semantic gate for 13 changes and strict validation for all 6 main specs.

Release-tree coverage: `2026-09-09T16-58-07-574Z-coverage-80cdc220-cb62-4e53-82eb-043817dc41fe`, 766 passed, 1 opt-in skip, exit 0. Release lane: `2026-09-09T17-01-09-984Z-release-0596b211-55d5-4914-b0ec-841f0de8db60`, 15 passed, 1 opt-in skip, exit 0. Artifact directories remain under the same temporary `codex-node-test-artifacts` root listed above.

An initial export run selected Node 26.8.1 from PATH and failed only the reporter fixture's exact-runtime equality. The successful full coverage run used Node 22.23.1 explicitly. At the user's subsequent request, the unnecessary equality was removed and the test name clarified; its golden events and expected JSONL remain unchanged. Focused reporter runs passed on both Node versions (2 tests each), and the existing real-reporter integration passed (1 test). Product sources did not change after coverage. Independent review approved this bounded correction; AGENTS.md now requires explicit brittleness review and immediate repair. These checks do not claim general Node 26 support. Original Cursor review text is retained byte-for-byte, including Markdown hard-break spaces.

Independent release-export residual audit classified all 101 raw-zero counters (36 meaningful contract, 23 realistic failure, 42 unreachable defensive); all 17 source hashes matched, no new meaningful gaps. Final deterministic client eval: `2026-09-09T17-02-39-568Z-eval-9ce6ff91-7a1e-455c-af7e-c10099c83169`, PASS, hosted/real-Codex opt-ins disabled. An earlier sandboxed eval attempt was interrupted by an egress restriction and is not acceptance evidence.
