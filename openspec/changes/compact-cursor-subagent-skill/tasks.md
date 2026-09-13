## 1. Зафиксировать сохранённое поведение и исходное измерение

Владелец сохраняемых требований: `DLG-3` «Skill workflow делегирования» и `DLG-2` «Workspace discipline делегирования» в cursor-task-delegation (с последующими уточнениями IUX-3); задачи ниже реализуют только их редакторское уплотнение и проверку.

- [x] 1.1 Сохранить исходный skill/payload digest и mapping «группа инструкций → requirement → существующий scenario/test owner» в evidence change; сверить bodies, assertions и реальные failure paths, отдельно зафиксировать canonical-checkout disclosure drift.
- [x] 1.2 Реализовать request-level measurement в существующем scripted-provider fixture/harness по design; component-проверки без real-Codex opt-in подтверждают полный skill match, повторное включение и fail-closed отсутствие блока, integration проверяет реальную загрузку/transport. Не менять public EvalResult envelope; проверка проходит через supervisor на admitted lane.
- [x] 1.3 Обновить существующий EVALUATOR_INPUTS только для новых transitive inputs измерителя и соответствующие digest-mutation проверки; подтвердить смену evaluator digest без смены skill digest от каждого нового non-skill input.
- [x] 1.4 Выполнить три исходных client-integration измерения с установленным payload и одним fixture; сохранить версии, digests, выбранный scenario, bytes, occurrence counts, tools и calls. Разделить warmup, первый evaluated request и общий объём; экспортировать safe aggregates с run/scenario/skill/evaluator bindings до удаления fixture. Проверить одинаковый состав контекста; не считать cache-file proof измерением inference request.

## 2. Уплотнить operator skill

- [x] 2.1 Targeted hunks объединить launch/authority, wait/pending, result/close и follow-up/recovery; удалить копии schema и повторные инструкции. Для каждого удаления mapping 1.1 указывает сохранённое правило; exact templates, пользовательские данные и все существенные ветки остаются.
- [x] 2.2 Согласовать canonical-checkout disclosure с действующим WD requirement; проверить exact sentence и сохранение разрешённой работы в canonical checkout. Новую проверку добавлять только при отсутствии существующего owner, не дублировать сценарий целиком.
- [x] 2.3 Провести независимый operator-contract review установленного skill относительно IUX-3/WD и runtime schemas: сохранить authority, file/snapshot distinction, result completeness, failure/live-idle различия и close ownership; все findings классифицировать по AGENTS.md и исправить baseline violations минимально.

- [x] 2.4 Исправить permission decision boundary существующего oracle, уточнить operator workflow и реализовать разрешённый выбор task IDs в «Immutable evidence manifest»; сохранить старый CLI default и counterexamples без ослабления gates.
- [x] 2.5 Добавить безопасные лексические признаки missing prompt fragments в существующий fixture и его test owner, чтобы диагностировать intermittent mismatch без сохранения prompt и без изменения oracle; проверить ограничения признаков и отсутствие приватного текста.

## 3. Доказать экономию и совместимость

- [x] 3.1 Тем же измерителем и fixture выполнить три candidate client-integration прогона; таблица baseline/candidate подтверждает ≥30% уменьшения фактически загруженного skill body, отсутствие роста provider turns/загрузок и показывает суммарные bytes за сценарий. Недостижение цели зафиксировать как невыполненный критерий, не ослабляя поведение; неподтверждённые tokens не публиковать.
- [x] 3.2 Выполнить необходимые focused checks через `node scripts/run-node-tests.mjs`, затем полную deterministic suite `unit` и `coverage`; сохранить terminal verdicts и классификацию всех raw zero counters по AGENTS.md. Проверки измерителя и exact disclosure не заменяют полную behavioral coverage.
- [x] 3.3 Выполнить credential-free package `release` и соответствующий client-integration eval через supervisor; подтвердить installed payload, discovery и неизменный MCP. Отдельный live Cursor canary не нужен для редакции без изменения adapter/runtime.
- [ ] 3.4 Выполнить hosted diagnostic на существующем corpus, затем новый baseline по текущим AGENTS.md и eval Cost-aware execution policy; сохранить все серии, counts, digests, model/effort, actual concurrency и failures. Не подменять hosted instruction-following scripted-provider результатами.
- [ ] 3.5 Сверить evaluator import/read/spawn paths с единственным inventory, результаты 3.1–3.4 и полноту свободных final reports независимым review; записать evidence и ограничения. Запустить `openspec validate compact-cursor-subagent-skill --strict` и `node scripts/check-openspec-semantics.mjs`; archive/release выполнять только отдельным последующим действием.

## Исторический результат acceptance V2

Полные diagnostic/high3/medium3 выполнены, evidence сохранён в [acceptance-v2.md](evidence/acceptance-v2.md). High79/81; medium81/81 по oracle, но independent review выявил premature permission answer и report deviations. Задачи3.4/3.5 остаются открытыми: accepted baseline и финальный successful closeout не получены. Цикл проверки завершён с отрицательным результатом; archive/release не выполнялись.

## Текущий результат после A/B и baseline close-revision

[A/B `model-initial-provider-failure`](evidence/hosted/ab-failed-allocation/results.md): 12/12 automatic PASS; retry не было. Исходный skill close 6/6, candidate 5/6; new-decision report 12/12 в этом A/B. Compaction regression не доказана. Frozen baseline обновлён: extra caller close после init/spawn tombstone без `turn_id` снят с operator-контракта.

[Измерение V11](evidence/measurement-v11.md): 13191 bytes, **30.14%**, три bound client-happy PASS, requests/occurrences/tools совпадают с baseline. [Focused allocation](evidence/hosted/focused-v11/results.md): 6/6 automatic, 0 retry; close больше не fail; medium/run-2 без new-decision — review note. [Diagnostic high](evidence/hosted/diagnostic-high-v11.json): **26/27**, mismatch в `model-active-followup` (двойной `cursor_delegate`), не allocation. Serial high/medium не запускался. 3.4/3.5 остаются открытыми.

## Текущий результат V13 (token_usage + новый evaluator digest)

- [x] 4.1 По «Cost-aware execution policy» реализовать разрешённую остановку всей acceptance при подтверждённом usageLimitExceeded через harness/runner/matrix/suite, сохранив cleanup, completed evidence и явную неполноту; проверить focused и complete deterministic coverage. [Доказательства](../../../evals/evidence/acceptance-review-2026-09-12/quota-verification.json): final coverage 836/836, raw audit 49/49, architect CLEAR; hosted acceptance 3.4/3.5 остаётся открытой.
- [x] 4.2 Разобрать все 11 поведенческих сбоев Spark medium по исходным inputs/traces/reports, отделить корневые нарушения от следствий и пробелов oracle; сохранить ссылки без изменения исторических verdicts. [Разбор](../../../evals/evidence/acceptance-review-2026-09-12/spark-behavior-review.md) проверен независимым architect: implementation_concern, без расширения baseline.

Coverage audit [v13](evidence/coverage-audit-v13/zero-counter-audit.json): **passed**, 48 zeros, 0 unclassified. Повтор 2026-09-10 23:11: unit PASS, coverage PASS (817), release PASS, `openspec validate --strict` PASS. [Измерение V13](evidence/measurement-v13.md): skill 13191 / **30.14%**, evaluator `8dbe14e07fa2540c498c810147a33d84c8f3b48dff20b0af9a51f3317fc11838`. Diagnostic/serial V12 с `ad62b4db…` нельзя reuse. Codex quota до **2026-09-16 13:36** (probe 23:11). Inventory: [evaluator-inventory-v13.md](evidence/hosted/evaluator-inventory-v13.md). [Resume](evidence/hosted/resume-after-quota.md). **3.4/3.5 открыты; closeout/archive не выполнялись.**

## Hosted baseline GPT-5.6 Luna (`gpt-reserve`)

- [x] 4.5 Реализовать разрешённую экономию quota: объявленная series с первым diagnostic run, pause/review/resume без смешивания trials, остановка будущих serial runs после non-pass и заранее выбранный distribution mode; согласовать finalizer и проверить негативные scenarios.
- [x] 4.6 Сохранить exact oracle inputs для successful/failed artifacts и реализовать diagnostic replay с проверкой достаточности capture, input drift и hashes; originals и hosted trial counts неизменны. Проверить текущую legacy series без восстановления отсутствующих данных. Capture включает исходную safe evidence и границы ходов для повторного построения projection. [Проверка](../../../evals/evidence/luna-high-repair-2026-09-12/process-review.md): critic OKAY, coverage 852/852, raw audit 50/50.
- [x] 4.7 После v4 pre-model `plugin list` timeout устранить слишком широкий `plugin list` при default matrix concurrency 16: version-specific 0.154 adapter использует подтверждённый `--marketplace` argv, без изменения timeout или retry policy. Проверить golden argv и lifecycle через injected adapter runner.

- [x] 4.3 Исправить Luna high по разбору: уточнить live critic delta без потери требований пользователя; сохранить фактически доставленный progress и разделить причины mismatch; сохранить bounded install-timeout diagnostics. Проверить focused, полный coverage/raw audit и installed skill contract. [Raw audit](../../../evals/evidence/luna-high-repair-2026-09-12/coverage-audit/final/zero-counter-audit.json): 840/840, 49/49 counters; release PASS, architect CLEAR. Hosted доказательство отдельно в 4.4.
- [ ] 4.4 На разрешённой пользователем Luna high выполнить focused active-followup/critic-delta ×3, review всех reports; только при PASS продолжить diagnostic и baseline по «Cost-aware execution policy». При quota остановить всю эту приёмку, сохранить failures и не переключать модель.

Текущий v4: focused 6/6 и независимый review CLEAR; первый полный run 25 PASS / 2 install-timeout до модели / 0 behavioral mismatch. Оставшиеся 54 trials не запускались, baseline не принят. Полный capture подтвердил replay 25/25 без модели; incomplete trials сохранены. [Результат и ограничения](../../../evals/evidence/luna-high-repair-2026-09-12/baseline-v4-review.md).

Первый repaired candidate: focused 6/6, diagnostic 27/27, baseline 78/81 (25/27, 26/27, 27/27), без инфраструктурных ошибок; [review всех 81](../../../evals/evidence/luna-high-repair-2026-09-12/baseline-review.md). Приёмка открыта. Follow-up уточняет ask→agent перед разрешённой записью и по запросу пользователя сохраняет безопасную причину invalid_args в recorder; исходную причину malformed resume это задним числом не восстанавливает. Доказательства нового candidate хранятся отдельно.

Актуальный разбор 2026-09-12: [единый acceptance report](../../../evals/cursor-skill-eval-acceptance-2026-09-12.md). Завершённый Luna high78/81; Spark medium18/81 и high0/81 разделены на quota/install failures и нарушения поведения. Xhigh без атомарного агрегата не принят. Новых проверок или изменений продукта в рамках сводки нет; 3.4/3.5 остаются открытыми.

Published owner: [evals/cursor-skill-eval-baseline-gpt-5.6-luna-2026-09-11.md](../../../evals/cursor-skill-eval-baseline-gpt-5.6-luna-2026-09-11.md). English corpus serial×3: high 79/81, xhigh 79/81, max 81/81. Не accepted 81/81. Mismatch: `model-critic-delta`, `model-active-followup`, `model-runtime-recovery`.

После уточнения keep-live / `cursor_set_mode` / close-after-last-stage focused hosted `gpt-reserve` high (по одному прогону, critic-delta дважды): pass `model-multiturn-review`, `model-mode-timeout`, `model-critic-delta`, `model-permission-expansion`, `model-active-followup-provider-failure`. Полный 81×3 не перезапускался.

## Предыдущий результат V12 (oracle launch_args)

Coverage audit [v11 sidecar](evidence/coverage-audit-v11/zero-counter-audit.json): **passed**, 34 zeros. [Измерение V12](evidence/measurement-v12.md): evaluator `ad62b4db…`. [Diagnostic high V12](evidence/hosted/diagnostic-high-v12.json): **27/27**. [High serial V12](evidence/hosted/high-v12.json): **13/81**, 68× `usageLimitExceeded`. Medium не запускался.
