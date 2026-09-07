## 1. Claude Code distribution layout

- [x] 1.1 Реализовать `CCD-2` «Claude Code plugin предоставляет существующий
  interactive workflow»: добавить `.claude-plugin/plugin.json` для
  `cursor-acp-subagent` с
  единственным existing `skills/` source и inline MCP server, который вызывает
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/cursor-subagent-mcp.mjs`; проверить
  `claude plugin validate --strict .`.
- [x] 1.2 Реализовать `CCD-1` «Git marketplace публикует Claude Code plugin»:
  добавить `.claude-plugin/marketplace.json` с GitHub marketplace
  entry `cursor-acp-subagent`, указывающим на этот же repository без отдельного
  version field; проверить его strict Claude validation и отсутствие ссылок за
  пределами plugin install-root.

## 2. Packaging evidence и документация

- [x] 2.1 Проверить `CCD-2` «Claude Code plugin предоставляет существующий
  interactive workflow» и `CCD-3` «Упаковка не расширяет authority boundary»:
  добавить детерминированный Node test public manifest layout: имя
  plugin, skill source, `${CLAUDE_PLUGIN_ROOT}` runtime path, отсутствие
  absolute checkout/Node/Cursor paths и отсутствие automatic permission
  configuration; проверить targeted `node --test`.
- [x] 2.2 Документировать `CCD-1` «Git marketplace публикует Claude Code
  plugin»: дополнить README инструкциями Git marketplace add/install/update,
  prerequisites `node`/`agent` и границей authority; проверить команды и
  public plugin identifier against catalog.
- [x] 2.3 Проверить `CCD-1` «Git marketplace публикует Claude Code plugin» и
  `CCD-2` «Claude Code plugin предоставляет существующий interactive workflow»:
  добавить explicit opt-in isolated local marketplace canary, который
  устанавливает `cursor-acp-subagent` в temporary Claude plugin cache, доказывает
  cache-local runtime/skill discovery и не использует исходный checkout после
  installation; проверить canary с authenticated local Claude Code только по
  явному запуску.

## 3. Contract verification

- [x] 3.1 Обновить semantic registry при необходимости и выполнить
  `openspec validate add-claude-code-marketplace-plugin --strict` вместе с
  `node scripts/check-openspec-semantics.mjs`; проверить, что owner map не
  дублирует lifecycle или permission policy.
- [x] 3.2 Выполнить foreground `node scripts/run-node-tests.mjs unit`,
  `node scripts/run-node-tests.mjs coverage` и
  `node scripts/run-node-tests.mjs release`; прочитать result artifacts и
  классифицировать все residual coverage counters по правилам проекта.
