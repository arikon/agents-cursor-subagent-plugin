## Why

Сейчас интерактивный Cursor ACP-субагент доступен только из Codex, хотя его
MCP tools и workflow не зависят от конкретного host. Пользователь выбрал
установку Claude Code плагина из этого же Git-репозитория; она должна работать
после cache-install, а не только из исходного checkout.

## What Changes

- Добавить Claude Code plugin manifest и marketplace catalog в этот
  репозиторий.
- Опубликовать один Claude plugin, который запускает уже существующий MCP
  runtime из собственного install-root и предоставляет существующий skill.
- Использовать переносимый путь `${CLAUDE_PLUGIN_ROOT}` и обычный `node`; не
  закреплять в распространяемом артефакте пути конкретного checkout, приложения
  или Cursor binary.
- Добавить детерминированную проверку структуры и opt-in local marketplace
  canary через установленный Claude Code CLI.

## Capabilities

### New Capabilities

- `claude-code-plugin-distribution`: Claude Code marketplace distribution
  существующего Cursor ACP MCP runtime из того же Git-репозитория.

### Modified Capabilities

- Нет.

## Impact

- `.claude-plugin/plugin.json` и `.claude-plugin/marketplace.json`;
- существующие `scripts/cursor-subagent-mcp.mjs` и
  `skills/cursor-subagent/SKILL.md` как содержимое Claude plugin source;
- документация установки и отдельные проверки packaging/canary;
- runtime API, Cursor ACP adapter, permission policy и Codex package contract
  не меняются.
