## Why

Низкоуровневый ACP API требует от Codex вручную создавать сессию, отправлять
задачу и циклически читать статус. Нужен единый контракт делегирования, который
сохраняет интерактивные границы полномочий, но делает Cursor практическим
субагентом для обычной задачи.

## What Changes

- Добавить высокоуровневое делегирование Cursor; изолированный worktree обязателен только для пишущего режима `agent`.
- Добавить skill workflow поверх `cursor_delegate` и runtime-owned `cursor_wait`.
- Сохранить низкоуровневые runtime-инструменты как advanced API.

## Capabilities

### New Capabilities

- `cursor-task-delegation`: Высокоуровневое делегирование задачи Codex в Cursor с явным workspace scope и наблюдаемым результатом.

### Modified Capabilities

- Нет.

## Impact

- Затрагивает MCP API, skill Cursor и документацию.
- Зависит от change `harden-cursor-acp-session-runtime`.
- Не включает переносимую установку плагина.
