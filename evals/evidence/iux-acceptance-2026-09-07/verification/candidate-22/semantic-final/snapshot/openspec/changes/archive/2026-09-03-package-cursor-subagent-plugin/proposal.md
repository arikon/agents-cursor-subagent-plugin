## Why

Плагин привязан к абсолютным путям текущей машины, поэтому установленная копия
не является воспроизводимым продуктом. Нужен проверяемый способ установки,
диагностики и обновления без привязки к исходному checkout.

## What Changes

- Добавить переносимый bootstrap/installer для MCP-конфигурации.
- Сделать manifest единственным источником версии MCP server.
- Добавить предflight-диагностику Node.js, Cursor Agent и аутентификации.
- Добавить credential-free fresh-install и credential-gated E2E на already-authenticated profile с fresh Codex config/install/workspace.

## Capabilities

### New Capabilities

- `cursor-plugin-distribution`: Воспроизводимая установка и проверка готовности Cursor ACP-плагина для Codex.

### Modified Capabilities

- Нет.

## Impact

- Затрагивает manifest, MCP configuration, scripts, README и тестовую автоматику.
- Не меняет семантику ACP-сессии или делегирования; release E2E зависит от
  реализации `harden-cursor-acp-session-runtime` и `add-cursor-delegation-workflow`.
