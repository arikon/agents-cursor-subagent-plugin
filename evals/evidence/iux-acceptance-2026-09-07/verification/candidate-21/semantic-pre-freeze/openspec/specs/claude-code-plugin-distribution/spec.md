# claude-code-plugin-distribution Specification

## Purpose
Определяет распространение существующего Cursor ACP-субагента как автономного
Claude Code plugin из marketplace этого же Git-репозитория.

## Requirements

### Requirement: Git marketplace публикует Claude Code plugin
Репозиторий SHALL содержать Claude Code marketplace catalog и один plugin с
публичным именем `cursor-acp-subagent`. Пользователь SHALL иметь возможность
добавить marketplace как GitHub repository `arikon/codex-cursor-subagent-plugin`
и установить этот plugin из него. Plugin source MUST ссылаться на содержимое,
которое cache-install получает вместе с plugin, и MUST NOT требовать файлов за
пределами install-root. Версия plugin MUST следовать Git revision marketplace,
а не отдельному вручную синхронизируемому version field.

#### Scenario: Установка из Git marketplace
- **WHEN** пользователь добавляет GitHub marketplace и устанавливает
  `cursor-acp-subagent` из него
- **THEN** Claude Code обнаруживает manifest plugin и создаёт автономную
  cache-копию, достаточную для его запуска без исходного checkout

### Requirement: Claude Code plugin предоставляет существующий interactive workflow
Установленный plugin SHALL предоставлять skill `cursor-subagent` и MCP server с
существующими `cursor_*` tools. MCP process MUST запускать bundled runtime через
`node` и путь внутри Claude plugin install-root; конфигурация MUST NOT содержать
абсолютный путь исходного checkout, конкретного Node binary или конкретного
Cursor binary. Необязательный `CURSOR_AGENT_COMMAND` остаётся environment
override пользователя; при его отсутствии runtime использует свой документированный
default `agent`.

#### Scenario: Запуск из кэшированной копии
- **WHEN** Claude Code запускает MCP server после установки plugin
- **THEN** runtime path разрешается внутри cache-копии plugin, а Cursor command
  берётся из user environment либо default `agent`

### Requirement: Упаковка не расширяет authority boundary
Claude Code packaging MUST NOT изменять Cursor ACP runtime API, state machine
или правила permission answer. Установка или включение plugin MUST NOT означать
автоматическое одобрение действий Cursor; существующий skill сохраняет
interactive ответы на вопрос, план и permission согласно текущей user authority.

#### Scenario: Cursor запрашивает permission
- **WHEN** запущенный из Claude Code Cursor runtime публикует pending permission
- **THEN** plugin возвращает существующий pending workflow и не посылает
  automatic approval только из-за факта marketplace installation
