## Why

Основной flow `cursor-subagent` смешан с копиями схем, повторными recovery-запретами и повторяющимися review-шаблонами. Skill занимает 18 883 UTF-8 байта; это увеличивает обязательный контекст даже для простого делегирования.

## What Changes

- Уплотнить один `skills/cursor-subagent/SKILL.md` вокруг delegate → wait → pending → полный результат → follow-up/close.
- Удалить дублирование синтаксиса MCP и повторения инструкций; сохранить mode/authority, существенные recovery-ветки, полноту результата и текущие обязательные prompt literals.
- Согласовать существующее расхождение skill с требованием exact canonical-checkout disclosure в пользу действующей main spec, без изменения requirement.
- Добавить минимальное измерение фактически передаваемого skill-контекста в существующую изолированную eval-инфраструктуру и сравнить исходный и сокращённый payload на одинаковых сценариях.
- Проверить сохранение поведения существующим corpus; не создавать второй lifecycle, registry, evaluator или матрицу сценариев.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `cursor-subagent-skill-evals`: после пользовательского поручения «Внеси правки и добей Acceptance» разрешён минимальный `--task-ids` существующего финализатора с прежним default; delta меняет только выбор task anchors в «Immutable evidence manifest». Oracle исправляет соблюдение уже существующей permission boundary. Ослабление exact-template требований не входит в change.

## Impact

Основная реализация затронет `skills/cursor-subagent/SKILL.md`; измерение — существующие client-integration fixture/harness и их evidence, при необходимости inventory `EVALUATOR_INPUTS`. Точные пути и доказательство ограничены design/tasks.

Для регистрации планирования добавляется reference-only запись в `scripts/openspec-semantic-registry.mjs` и только метки ссылок DLG-2/DLG-3 в индекс исходного archived facade design. Текст его requirements и архивированный wait change не изменяются.

MCP schemas, runtime, result delivery, package lifecycle и зависимости не меняются. Нормативное расширение ограничено выбором task anchors в существующем eval finalizer; main spec синхронизируется при последующем archive. `simplify-task-state-wait` остаётся архивированным. Новый hosted baseline создаётся только после диагностического подтверждения и по действующим правилам проекта; прежние результаты сохраняются.
