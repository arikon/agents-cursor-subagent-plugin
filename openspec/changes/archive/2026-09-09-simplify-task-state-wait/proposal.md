## Why

Обычному workflow требуется текущее состояние хода, но `cursor_wait` заставляет переносить event/progress cursors между wait и answer. Однократная выдача terminal result дополнительно делает повторное чтение зависимым от истории доставки ответа.

## What Changes

- **BREAKING**: заменить cursor-based `cursor_wait` наблюдением состояния по `session_id`, `turn_id` и optional `timeout_ms`.
- Возвращать актуальные pending-запросы с контекстом и повторяемый terminal result в пределах существующего retention, без скрытого consumer cursor или delivery flag.
- Пока ход выполняется, ждать actionable состояния либо timeout; на timeout выдавать ограниченный актуальный progress без revision bookkeeping.
- Оставить bounded event log внутренним runtime evidence; новый публичный `get_events` не вводить.
- Упростить operator skill и обновить проверки поведения, сохранив authority, multi-turn workflow и чтение полного результата.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `cursor-acp-session-runtime`: wait schema, ожидание состояния, повторяемая terminal delivery и bounded progress.
- `cursor-task-delegation`: композиция wait/answer без переноса cursors.
- `cursor-subagent-skill-evals`: заменить нормативные cursor/loss observations доказательством state-oriented workflow.

## Impact

Runtime: `scripts/cursor-subagent-mcp.mjs`; operator contract: `skills/cursor-subagent/SKILL.md`, README; проверки: runtime/transport tests, package E2E и существующий eval corpus/driver. Новые зависимости и изменения Cursor ACP API не нужны.

Это последовательный follow-up к архивированным `improve-interactive-acp-ux` и `add-cursor-model-discovery`, без изменения их baseline. Четыре delta blocks привязаны через существующий `sourceChange` к IUX, пять — к main: три SW-6 и два пересечения с синхронизированным MD. MD-инструменты, launch-поля и workflow сохраняются; SW меняет только ожидание. Source drift требует rebase и повторных gates/review. Структурная готовность сама по себе не означает specification-ready; итог проверок фиксируется в `validation.md`.

Источник идеи: обсуждение «Упростить ожидание задачи», conversation ID `6a9e9960-68e4-83eb-8559-44e13da2f0e0`. Доступная запись обрывается на примере повторных wait; конкретные решения ниже зафиксированы в этом change.
