## Context

Мотивация приведена в proposal.md. Исходный skill: 18 883 UTF-8 байта, 2 536 слов. Runtime экспортирует 14 schemas (`scripts/cursor-subagent-mcp.mjs:970`), но descriptions содержат только имена; из схем нельзя восстановить workflow. `scripts/codex-app-server-client.mjs:234` проверяет bytes/digest доступного cached skill, а не полный inference request.

Main specs и установленный интерфейс, прочитанные при exploration, являются основанием решения. Внешний API не расширяется. Архивированный `simplify-task-state-wait` используется как существующий контракт.

## Goals / Non-Goals

**Goals:** один компактный operator flow, отсутствие повторного нормативного текста, измеренное уменьшение загружаемых инструкций при сохранении поведения.

**Non-Goals:** свободная замена exact templates, новый skill/reference, новая машина состояний, registry сессий, политика разрешений, изменение MCP descriptions/schema/result delivery, новые зависимости, автоматический запуск реализации во время proposal.

## v1 Contract Baseline

**Goal.** Редакторски сократить установленный skill и доказать сохранение текущего workflow на существующем корпусе.

**Non-goals.** Границы перечислены в Goals / Non-Goals; кроме разрешённого пользователем ниже выбора task anchors в существующем finalizer, требования не изменяются.

**Public-invariant index.** `EVAL-CLOSEOUT` → «Immutable evidence manifest»; `DLG-3` → «Skill workflow делегирования»; `DLG-2` → «Workspace discipline делегирования». Это reference labels соответствующих существующих owners; IUX-3 обозначает последующее уточнение workflow requirements, WD ниже — краткое обозначение workspace requirement.

**Owner map.** `cursor-task-delegation` сохраняет владение operator workflow и workspace discipline. Runtime сохраняет lifecycle, MCP wire, schemas, IDs, bounds и result retention; facade только компонует его операции. Package владеет доставкой/discovery установленного payload. Eval владеет scenario/oracle, measurement и доказательствами загрузки; AGENTS.md — governance и acceptance. Этот change не приобретает новых owners; он модифицирует только выбор task anchors в existing eval closeout requirement.

**Implementation-ready exit.** Все артефакты согласованы, structural и механический semantic gate проходят; независимый critic не обнаруживает baseline_violation, architect подтверждает классификации и минимальность. Открытых архитектурных развилок нет; численные результаты измеряются при реализации, а не объявляются заранее.

**Future-change candidates.** Семантические вместо literal prompt predicates с отдельным изменением requirements; условный repeated-review reference при доказанной выгоде; result delivery, исследуемая отдельно. Ни один кандидат не входит в текущий baseline.

## Decisions

### Один файл и один порядок действий

Сохранить один SKILL.md: выбор mode/launch и authority → delegate → wait → pending → полный terminal result → follow-up либо close/report. Recovery помещается в один компактный блок с адресными исключениями. Удаление повтора допускается только с указанием сохранённого места и requirement owner в implementation evidence.

| Текущая группа | Редакторская операция | Сохранённый owner/граница |
|---|---|---|
| Активация | Одна инструкция явного использования | package/skill |
| Launch/model | Удалить regex и копии signatures | runtime schema; workflow выбора, discovery, defaults и authority остаётся |
| Authority/worktree/plugin roots | Объединить повторяющиеся правила | WD/IUX-3; exact clauses и passed-through roots остаются |
| Wait/address recovery | Один блок вместо повторных запретов | runtime SW-1/SW-2; workflow intervals и правильные IDs остаются |
| Pending | Компактная таблица question/plan/permission | IUX-3; отдельный follow-up там, где он требуется |
| Full result/report/close | Один owner cleanup после чтения | IUX-3 с runtime result contract |
| Follow-up/resume/set_mode failures | Нормальный путь плюс различимые исключения | IUX-3; не превращать любую ошибку в irrecoverable |
| File/snapshot/repeated review | Две evidence формы и один условный repeat-блок | WD/IUX-3; live delta и resumed baseline различаются |
| Temporary paths | Перенести в authority | WD; создание не даёт права удаления |

Вынос repeated review отклонён для v1: он добавляет обнаружение/загрузку reference и evidence, тогда как повторный текст можно объединить в том же файле. Перенос workflow в descriptions отклонён: меняет MCP и не доказывает уменьшение общей загрузки.

### Literal contract сохраняется

Имена MCP/поля/enum принадлежат runtime. Exact пользовательские paths, content, choices, markers и delta остаются данными поручения. `AUTHORIZED_ACTIONS`, `NO_SCOPE_EXPANSION`, operation `write`, review clauses и repeat labels остаются в текущем виде, поскольку закреплены main spec и corpus. Удаляется только повторное изложение/проверка тех же условий; oracle не ослабляется ради размера.

Существующий drift canonical-checkout disclosure исправляется минимально в skill: вместо требования произвольной формулировки используется exact sentence из WD. Main spec не переписывается. Проверка смысла остальных reports остаётся предметом независимого review: текущие свободные outcome/safety формулировки в eval — `not_checked`.

### Измерение в существующем eval fixture

Минимальная инструментальная правка ограничена `tests/fixtures/fake-ollama-responses.mjs` и существующим `tests/codex-client-integration.test.mjs`: в изолированном scripted-provider request измерить переданные skill instructions, отдельно tools и прочий fixture context. Никакого нового provider/API, tokenizer dependency или общего benchmark framework.

Перед правкой skill сохранить исходный payload/digest. На одном и том же установленном клиенте и одинаковом fixture выполнить исходный и candidate варианты с одинаковыми tools, входными данными и последовательностью шагов. Поиск skill блока должен подтвердить полное соответствие installed bytes; если клиент преобразует обёртку, сохранить явный version-specific extraction и fixture, не выдавать cache-file digest за request evidence. Измерение недоступного блока считается пробелом проверки, а не нулём байтов. Не сохранять raw request: только размеры, digests и occurrence counts из изолированного fixture.

Основная метрика: UTF-8 bytes фактически переданного skill body на первом запросе; цель candidate ≤ 70% исходного. Дополнительно сравнить суммарные skill bytes с повторными включениями за одинаковый сценарий, tool schemas bytes и количество calls. Не допускать роста числа provider turns или загрузок инструкций для достижения метрики. Размер файла и строки — диагностика. Tokens/hosted usage сообщать только если их точная семантика подтверждена установленным интерфейсом; bytes не называть токенами и не использовать неподтверждённый коэффициент пересчёта.

Measurement сначала проверяется на исходном skill, затем на candidate с неизменным измерителем. Baseline/candidate повторить три раза для проверки стабильности состава контекста. Если цель 30% несовместима с сохранением требований, сохранить замер и не ослаблять поведение: критерий остаётся невыполненным, а пересмотр baseline — отдельное решение пользователя.

Существующий fixture сначала выполняет warmup, затем evaluated turn. Для основной метрики использовать первый request evaluated turn; warmup учитывать отдельно и включать в общий объём обоих turns, сопоставляя одинаковые индексы. Pure extraction/counting проверки размещаются на deterministic component уровне без real-Codex opt-in, реальные transport/load assertions остаются integration. Допустим один маленький eval-only helper при необходимости совместного использования, с существующим inventory owner. Безопасные aggregate measurements экспортируются до fixture cleanup в change-local evidence с run/scenario, installed skill и evaluator digests; временного provider evidence недостаточно.

### Поведенческое доказательство

Переиспользовать текущие сценарии и их владельцев; зафиксировать mapping до редакции. Обязательные группы: обычный ask, bounded file/snapshot review, write authority, model/plugin choices, pending question/plan/permission и stale request, timeout/lost wait/local ID repair, terminal/allocation/mode failures, полный paged result/overflow, declared follow-up/mode change, live critic delta и resumed baseline, final close и temporary-path authority.

Не создавать новые копии всей матрицы. Новые component assertions нужны только для измерителя и реально отсутствующего поведения (например exact canonical disclosure); сначала сверить существующие bodies. Scripted client доказывает загрузку/transport, hosted model с fake ACP — следование инструкциям. Hosted diagnostic предшествует новому baseline; действующие правила series/model selection и closeout находятся в AGENTS.md и eval main spec, а не дублируются здесь. Старые failures не удаляются.

Measurement не заменяет package proof, behavioral eval или coverage. При изменении evaluator inputs обновить единственный EVALUATOR_INPUTS и digest-mutation тесты по AGENTS.md. Не менять стабильный evidence envelope без необходимости: measurement можно записать в отдельный change-local verification artifact, связанный digests с прогоном.

## Risks / Trade-offs

- Сжатие стирает условие recovery → перед каждым удалением сопоставить сохранённое правило; проверить failure и live-idle различия.
- Exact шаблоны ограничивают размер → сохранить их; смысловая либерализация вне baseline.
- Меньший файл не означает меньший контекст → request-level measurement, отдельные bytes/tools/calls, без ложных token claims.
- Fake provider не доказывает свободный текст report → независимый review полноты, смысла failure и authority; hosted evidence не расширяет охват oracle.
- Изменение общей инфраструктуры ради метрики → существующие fixture/harness, без новых dependencies, runtime hooks и registry.

## Migration Plan

Во время реализации сначала сохранить исходные digests и измерение, затем targeted hunks skill и необходимые проверки. После acceptance обычная package-доставка изменённого skill; публикация релиза не входит в этот change. Rollback возвращает прежний skill через существующий package workflow, без migration сессий. Точка будущей интеграции result delivery — получение полного результата перед verification, новым turn и close; текущий paging сохраняется.


## Baseline update — acceptance repairs, 2026-09-10

Пользователь после отчёта об обнаруженных проблемах и конкретного предложения finalizer поручил «Внеси правки и добей Acceptance». Архитектор подтвердил это как разрешение ранее выделенного new_scope: optional task IDs вместо жёсткой привязки к историческим задачам. Owner остаётся «Immutable evidence manifest»; точный контракт находится только в delta spec. Ни новый workflow engine, ни новые proof schemas не вводятся. Старый CLI default сохраняется; для этого change finalizer завершает 3.4, независимый review 3.5 остаётся отдельным действием.

Oracle permission boundary — implementation_concern существующего сценария: использовать сохранённый индекс пользовательского turn и corresponding follow-up; ранний reject-once не должен проходить. Полностью разрешённый allow-once остаётся немедленным. Counterexample принадлежит существующему component owner, corpus не расширяется.

Skill уточняется локально: оба permission decisions вне authority требуют отдельного user follow-up; объявленный будущий этап удерживает live wrapper до поступления входа; обязательные terminal disclosures собраны в одном report-блоке. Это восстановление однозначности текущего operator contract, без eval literals и новых branches. Цель экономии ≥30% и все behavioral gates сохраняются. Старые failed measurements/evals неизменны; после ремонта создаются новый freeze и свежие серии.

## Baseline update — allocation close and error split, 2026-09-10

Пользователь поручил диагностический A/B и явное изменение frozen baseline: убрать обязательный extra caller close после failed allocation. Owner остаётся DLG-3 «Skill workflow делегирования». Main spec scenario «Initial allocation failure не вызывает wait или fallback» уже требует только report + new decision и запрет wait/retry/resume/replacement; runtime requirement «Единая машина состояний» уже закрывает allocated init/spawn в tombstone. Повторный `cursor_close_session` сохраняет то же состояние и не является caller obligation.

A/B `model-initial-provider-failure` (три high и три medium на исходном и текущем skill) не доказал, что пропуск close/new-decision есть регрессия сокращения: исходный skill закрывал 6/6, candidate 5/6; самовольного retry/resume не было ни в одном из 12; формулировка нового решения присутствовала во всех 12 этого A/B и отсутствовала в отдельных исторических V10 finals. Это надёжность следования инструкции, не дефект runtime.

Два требования к ошибке разделены без нового owner:
- нет автоматического wait/retry/resume/replacement — поведенческое ограничение, уже проверяемое `expected_trace` сценария;
- явное сообщение о необходимости нового решения — требование к пользовательскому отчёту; существующий oracle держит `outcome_report: not_checked`, а `REPORT_CATEGORIES` допускает только `interaction`. Расширение evaluator outcome-категорией или exact report literal не входит в этот baseline: оно добавило бы новый exact template и отдельную schema-ветку. Пока report остаётся предметом независимого review, automatic PASS не утверждает его.

Skill больше не требует caller close для init/spawn tombstone без `turn_id`. Close после allocated turn с `turn_id` не меняется. Цель ≥30% и запрет ослаблять no-retry gates сохраняются.
