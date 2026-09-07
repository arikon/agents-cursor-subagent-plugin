## Context

См. [proposal.md](proposal.md). Runtime, skill и Codex package уже находятся в
корне репозитория. Claude Code кэширует plugin как отдельную копию, поэтому
ссылка marketplace на каталог, зависящий от sibling-файлов исходного checkout,
неприемлема. Активный `improve-interactive-acp-ux` меняет Cursor ACP UX и не
является владельцем Claude distribution.

## v1 Contract Baseline

**Goal.** Дать Claude Code устанавливаемый из данного GitHub repository plugin,
который запускает существующий Cursor ACP MCP runtime из собственного cache-root
и сохраняет текущий workflow/authority boundary.

**Non-goals.** Не добавлять Claude как provider-субагента, второй runtime,
перевод ACP на Claude protocol, новый permission policy engine, зависимости,
автоматические approvals или глобальную настройку Cursor.

**Public-invariant index.** `CCD-1` → «Git marketplace публикует Claude Code plugin»; `CCD-2` → «Claude Code plugin предоставляет существующий interactive workflow»; `CCD-3` → «Упаковка не расширяет authority boundary».

**Owner map.** `claude-code-plugin-distribution` owns only Claude catalog, cache-safe plugin launch and packaging verification. `cursor-acp-session-runtime`
продолжает владеть MCP schemas, lifecycle, limits и permission transport;
`cursor-task-delegation` — caller workflow и authority semantics;
`cursor-plugin-distribution` — существующим Codex package contract.

**Implementation-ready exit.** Manifest и catalog проходят strict
Claude validation; тесты подтверждают public layout и отсутствие абсолютных
runtime paths; isolated marketplace install запускает MCP server из cache-copy,
обнаруживает skill и не меняет runtime permission behavior.

**Future-change candidates.** Отдельный Claude-native subagent provider,
другая схема versioning или выделение компактного distribution-only repository.

## Goals / Non-Goals

**Goals:** добавить один cache-safe Claude Code plugin и Git marketplace в
существующий repository без копирования runtime и без изменения public
`cursor_*` contract.

**Non-Goals:** не менять Codex `.mcp.json`, не объединять Claude и Codex
manifest schemas, не делать проектный `.claude/settings.json`, не устанавливать
marketplace глобально в ходе обычных test lanes.

## Decisions

### Один repository является и marketplace, и plugin source

`.claude-plugin/marketplace.json` публикует `cursor-acp-subagent` с GitHub
source этого же repository. Claude cache-копирует Git source целиком, поэтому
runtime и skill остаются внутри install-root без дублирования production files.
Отдельный `plugins/` subtree отклонён: он потребовал бы копировать или
синхронизировать runtime и skill.

### Claude manifest использует inline MCP configuration

Claude manifest владеет своим `mcpServers` inline и вызывает `node` с
`${CLAUDE_PLUGIN_ROOT}/scripts/cursor-subagent-mcp.mjs`. Это не переиспользует
Codex `.mcp.json`, чья модель relative entrypoint и metadata принадлежат Codex.
`CURSOR_AGENT_COMMAND` не записывается в manifest: пользователь может передать
его environment override, либо runtime запустит `agent`.

### Оставить runtime и skill едиными владельцами поведения

Claude manifest явно раскрывает существующий `skills/` directory. Он не
создаёт Claude-specific copies skill или новых tools; packaging добавляет лишь
host registration. Это исключает расхождение authority instructions.

## Risks / Trade-offs

- [Один Git source кэширует repository шире минимального plugin bundle] →
  repository мал, зато не появляется копия runtime; выделение package возможно
  только отдельным будущим change.
- [Claude Code schema или cache behavior дрейфуют] → strict CLI validation и
  versioned isolated install canary являются release evidence.
- [`node` или `agent` отсутствуют в окружении Claude Code] → preflight/canary
  сообщает diagnosable failure; plugin не скачивает executables и не меняет
  user PATH.
- [Установка ошибочно воспринимается как permission grant] → skill и runtime
  не меняются, а canary покрывает pending permission без automatic answer.

## Migration Plan

1. Добавить Claude manifest, marketplace catalog, документацию и tests.
2. Выполнить strict validation и isolated local marketplace install в отдельном
   Claude plugin cache.
3. После merge пользователь добавляет marketplace через
   `claude plugin marketplace add arikon/codex-cursor-subagent-plugin` и
   устанавливает `cursor-acp-subagent`.
4. Rollback: удалить plugin из marketplace catalog в следующей Git revision;
   уже установленные пользователи выключают или удаляют его стандартным Claude
   Code CLI. Codex plugin и Cursor runtime остаются независимыми.
