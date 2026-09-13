## Why

Основной flow `cursor-subagent` смешан с копиями схем, повторными recovery-запретами и повторяющимися review-шаблонами. Skill занимает 18 883 UTF-8 байта; это увеличивает обязательный контекст даже для простого делегирования.

## What Changes

- Уплотнить один `skills/cursor-subagent/SKILL.md` вокруг delegate → wait → pending → полный результат → follow-up/close.
- Удалить дублирование синтаксиса MCP и повторения инструкций; сохранить mode/authority, существенные recovery-ветки, полноту результата и текущие обязательные prompt literals.
- Согласовать существующее расхождение skill с требованием exact canonical-checkout disclosure в пользу действующей main spec, без изменения requirement.
- Добавить минимальное измерение фактически передаваемого skill-контекста в существующую изолированную eval-инфраструктуру и сравнить исходный и сокращённый payload на одинаковых сценариях.
- Проверить сохранение поведения существующим corpus; не создавать второй lifecycle, registry, evaluator или матрицу сценариев.
- По разрешённому ремонту Luna high уточнить сохранение требований в critic follow-up и диагностику progress/install timeout в существующих eval owners; MCP wire и критерии PASS не ослабляются.
- По прямому одобрению пользователя экономить hosted quota: объявленная series включает diagnostic как первый run, останавливает будущие runs после failure и допускает проверяемый diagnostic replay полного сохранённого oracle input без новых модельных вызовов.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `cursor-subagent-skill-evals`: после пользовательского поручения «Внеси правки и добей Acceptance» разрешён минимальный `--task-ids` существующего финализатора с прежним default; «Immutable evidence manifest» меняет выбор task anchors. Дополнительное поручение от 2026-09-12 расширяет «Cost-aware execution policy»: подтверждённый `usageLimitExceeded` останавливает всю текущую приёмку с сохранением неполных результатов. Oracle исправляет соблюдение уже существующей permission boundary. Ослабление exact-template требований не входит в change.

## Impact

Основная реализация затронет `skills/cursor-subagent/SKILL.md`; измерение — существующие client-integration fixture/harness и их evidence, при необходимости inventory `EVALUATOR_INPUTS`. Точные пути и доказательство ограничены design/tasks.

Для регистрации планирования добавляется reference-only запись в `scripts/openspec-semantic-registry.mjs` и только метки ссылок DLG-2/DLG-3 в индекс исходного archived facade design. Текст его requirements и архивированный wait change не изменяются.

MCP schemas, runtime, result delivery, package lifecycle и зависимости не меняются. Разрешённое нормативное расширение остаётся у existing eval owners: task anchors, quota stop, объявленная series и проверка replay. Main spec синхронизируется при последующем archive. `simplify-task-state-wait` остаётся архивированным. Новый hosted baseline создаётся с review первого diagnostic run по действующим правилам проекта; прежние результаты сохраняются.
