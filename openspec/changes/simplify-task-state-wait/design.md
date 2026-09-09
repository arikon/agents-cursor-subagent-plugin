## Context

См. `proposal.md`. Проверенная локальная реализация хранит terminal delivery flag, принимает event/progress cursors и отдаёт event delta. Уже существующий turn snapshot содержит состояние, pending и retained result; его достаточно для нового наблюдения.

## v1 Contract Baseline

**Goal.** Убрать зависимость обычного wait/answer workflow от позиции чтения событий и факта предыдущей доставки результата.

**Non-goals.** Durable delivery, восстановление после потери runtime, новый task registry, изменения authority, новые ACP capabilities, публичный event-reader и автоматический retry provider operations.

**Public-invariant index.** `SW-1` → «Публичный MCP tool contract»; `SW-2` → «Адресуемое ожидание состояния сессии»; `SW-3` → «Sparse wait and bounded progress»; `SW-4` → «Role-neutral mode and collaboration surface»; `SW-5` → «Skill workflow делегирования»; `SW-6` → «Единая машина состояний runtime», «Изолированное состояние ходов и событий», «Ограниченный жизненный цикл ACP-процесса»; `SW-7` → «Сценарный контракт поведения и authority-aware interaction».

**Owner map.** `cursor-acp-session-runtime` owns wait schemas, observation, retention and progress; `cursor-task-delegation` owns only caller composition. `cursor-subagent-skill-evals` owns только observable workflow evidence и удаление прежних cursor assertions; package owner сохраняет существующую integration responsibility без нового normative delta. Numerical limits and full-result paging remain with their existing runtime requirements.

**Implementation-ready exit.** Все девять replacement blocks привязаны точными digest к проверенному checkout: четыре — к blocks archived `improve-interactive-acp-ux`, пять — к main specs (три SW-6 и два пересечения с синхронизированным `add-cursor-model-discovery`). Strict и semantic gates проходят на этом checkout; необходимые predecessor runtime/skill/eval surfaces присутствуют и проверены. Независимый critic не находит baseline_violation, architect подтверждает классификации и минимальность. У каждого изменённого observable поведения есть один test owner и конкретная task. После любого source drift готовность отзывается до rebase и повторного gate/review; archive readiness проверяется отдельно.

**Future-change candidates.** Публичная диагностика event log — только при подтверждённом operator scenario; durable cross-process observation и version-negotiated compatibility — отдельные changes.

## Goals / Non-Goals

**Goals:** использовать существующий turn как единственный источник наблюдаемого состояния; сохранить различие protocol completion и результата пользовательской задачи.

**Non-Goals:** новая машина состояний, очередь consumer delivery, delivery acknowledgements или восстановление пропущенных событий.

## Decisions

1. Сохранить имя `cursor_wait`, но выпустить breaking schema вместе с обновлённым skill. Скрытый cursor отвергнут: он сохраняет зависимость от доставки и конкуренцию читателей. Второй wait tool создаёт два operator workflows и не нужен для согласованного обновления локального пакета.
2. Реализовать SW-2 через предикат существующего turn и bounded waiter. После регистрации ожидания повторно проверить предикат, а после каждого wake проверить его снова. Это устраняет lost wakeup и ранний возврат из-за несущественного события; новый журнал или revision counter не нужны. Ожидающий call удерживает ссылку на свой turn до завершения, чтобы немедленный следующий prompt не подменил ответ другим ходом.
3. Terminal preview и receipt воспроизводятся из retained turn. Полный текст остаётся за существующим `cursor_read_result`; новый буфер результата не создаётся. Повторное чтение может повторить bounded preview: это цена восстановления после потерянного tool response без delivery protocol.
4. Внутренние events и их IDs сохраняются для текущих runtime обязанностей. Wait не читает их как consumer; не переносим event fields в новый snapshot. Existing action/status receipts могут по-прежнему содержать IDs событий как evidence, но они не являются параметрами следующего wait.
5. Progress остаётся последним bounded excerpt принятого agent text. Повтор на timeout допустим; потоки progress не пробуждают wait. Typed collaboration events остаются внутренними; гарантированное чтение каждого todo/task/image вне v1.
6. Единственный новый eval fault моделирует потерю caller-visible terminal wait response после его получения от runtime. Existing compact capture сохраняет withheld response и реально доставленный error, а SW-7 сверяет повторное чтение с ними. Этот proof нужен, потому что обычный timeout не доказывает восстановление потерянного terminal result. Новый provider retry, facade state machine и внешний handoff protocol не вводятся.
7. Existing project semantic registry получает optional `sourceChange` в replacement entry. Без него source остаётся main; с ним source — exact block ранее зарегистрированного change. Изначально это требовалось для шести predecessor contracts. После sync `add-cursor-model-discovery` MCP contract и skill workflow перебазированы на main; четыре остальные predecessor references сохранены. Gate проверяет объявленного владельца и source/replacement digests; source drift отзывает readiness. После archive источника active successor обязан совпадать source digest с main; archive successor требует archived source и прежнюю проверку replacement lineage. Это локальная связь в существующем registry, без нового OpenSpec metadata schema или dependency engine. Fail-closed fixture tests проверяют active/archived source, отсутствие block, неверную ссылку и drift.

## Risks / Trade-offs

- Старый skill присылает удалённые аргументы → явный `invalid_args`, согласованная установка runtime и skill; без молчаливого legacy режима.
- Pending повторяется до решения → caller показывает его пользователю и отвечает только по текущему полномочию; не крутит wait в tight loop.
- Retention ограничен → повторяемость действует только для адресуемого retained turn, не обещает archive/durable storage.
- Меняется source block в main или predecessor → sourceChange/digest gate непосредственно перед apply, rebase при drift; source документы этим change не правятся. Apply использует проверенный checkout с готовыми predecessor surfaces и одного владельца записи в пересекающиеся product files.

## Migration Plan

Для apply проверить pinned predecessor/main source blocks, strict/semantic gates и присутствие predecessor implementation surfaces в выбранном checkout. Изменить runtime и consumers одним release; проверить installed operator workflow и package E2E. Перед установкой завершить старые делегирования и MCP process; после установки открыть чистую задачу с заново загруженными skill и tools. Одна лишь замена package files не является restart. Package acceptance проверяет эту границу поколений. Откат проходит ту же close/restart границу и возвращает согласованную предыдущую версию runtime и skill, без миграции persistent state.

Archive имеет отдельную проверку: `improve-interactive-acp-ux` и `add-cursor-model-discovery` уже синхронизированы и архивированы. Перед archive этого change проверить exact source digests текущего main и archived references; при отличии сначала rebase successor и повторные проверки. Завершённость predecessor не заменяет implementation/release acceptance самого SW.
