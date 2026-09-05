## Why

Долгие Node.js прогоны сейчас могут давать неполный console output, смешивать
успешные сообщения с диагностикой и требовать повторного точечного запуска для
получения всех ошибок. Нужен единый foreground supervisor, который даёт
доказуемый terminal verdict, сохраняет полный output текущего прогона и не
скрывает утечки процессов принудительным завершением test runner.

## What Changes

- Добавить единый Node test-supervisor с lane `unit`, `coverage` и `release`.
- Сохранять для каждого run полный TAP/raw output и failure-only report в
  отдельном локальном artifact directory; успешный run печатает компактный
  summary, не поток успешных tests.
- Ограничить run deadline, корректно останавливать owned process group при
  timeout или сигнале и ждать фактического `close` перед terminal verdict.
- Включить coverage только для product source scope, применять согласованные
  минимальные thresholds около 90% и не считать test code частью product
  coverage.
- Заменить разрозненные инструкции запуска на supervisor commands и добавить
  их contract tests.

## Capabilities

### New Capabilities

- `node-test-supervision`: Воспроизводимый foreground запуск Node test lanes с
  terminal verdict, process cleanup, failure diagnostics и product coverage.

### Modified Capabilities

- Нет.

## Impact

- Новый test-only supervisor и custom Node test reporter в `scripts/`.
- [AGENTS.md](/Users/arikon/projects/codex-cursor-subagent-plugin/AGENTS.md) и README получают единственный способ запуска unit, coverage и release lanes.
- Runtime MCP, facade, Cursor ACP contract, package install/discovery и Codex
  eval semantics не меняются.
