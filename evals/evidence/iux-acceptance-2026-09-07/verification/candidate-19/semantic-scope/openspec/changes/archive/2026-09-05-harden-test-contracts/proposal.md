## Why

Текущие зелёные unit, coverage и release прогоны не доказывают несколько
заявленных fail-closed контрактов: ранние ошибки supervisor не оставляют
машиночитаемый итог, coverage может скрыть исключённый из denominator файл, а
интеграционный eval-oracle способен реконструировать ожидаемую трассу вместо
проверки наблюдаемой. Отдельные eval и интеграционные lanes также должны быть
переносимыми и давать однозначный process-level результат для CI.

## What Changes

- Сделать публикацию `result.json` обязательной для preflight и synchronous
  spawn failure supervisor, кроме собственной ошибки публикации.
- Ужесточить coverage gate: каждый manifest source обязан иметь валидный
  положительный line denominator в per-file report.
- Перевести eval-oracle на упорядоченную фактическую MCP-трассу и добавить
  регрессии для ошибочного порядка, чужих ID, failed/лишних вызовов и overflow.
- Определить ненулевой exit code для включённого eval с integration failure или
  scenario mismatch.
- Изолировать fake provider на назначенном ОС порту и убрать привязку
  hosted-auth lane к домашнему пути конкретного разработчика.
- Зафиксировать version-specific app-server adapter, который направляет
  credential-free fixture к её loopback provider без fallback в remote API.
- Проверять compatibility CLI отдельным foreground invocation, а не только
  импортом helper.

## Capabilities

### New Capabilities

- Нет.

### Modified Capabilities

- `node-test-supervision`: усилить артефактный и per-file coverage contracts
  supervisor, включая compatibility entrypoint.
- `cursor-subagent-skill-evals`: сделать фактический transcript и process exit
  наблюдаемыми контрактами eval, а integration fixtures — изолированными и
  переносимыми.

## Impact

- `scripts/run-node-tests.mjs`, `scripts/run-cursor-skill-eval.mjs` и legacy
  compatibility wrapper.
- Тесты supervisor, eval runner, credential-free/hosted Codex integration и
  recording MCP proxy.
- Нет новых зависимостей, сетевых сервисов или изменения публичных MCP tools.
