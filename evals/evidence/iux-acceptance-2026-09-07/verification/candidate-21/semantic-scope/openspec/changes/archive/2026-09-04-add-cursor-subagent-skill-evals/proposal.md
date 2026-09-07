## Why

Существующие тесты подтверждают runtime, facade и пакетный canary, но не
доказывают, что реальный Codex после discovery установленного skill выполняет
интерактивный workflow Cursor через MCP. Ручная интерпретация `SKILL.md` в
unit-тесте не заменяет это доказательство.

## What Changes

- Разделить credential-free Codex client-integration lane, credential-gated
  Codex-model behavior lane и opt-in full-live Codex+Cursor lane.
- Добавить harness, переиспользующий package-owned bootstrap/discovery proof и
  записывающий adapter-normalized evidence загрузки установленного skill,
  MCP transcript, machine-readable final contract и fixture outcome.
- Ввести сценарии normal delegation и pending question/plan/permission с
  authority-aware follow-ups; конкретные workflow-инварианты остаются
  нормативной собственностью существующей facade specification.
- Ввести независимые `eval_status`, actual task outcome и reported Codex
  outcome с исчерпывающей классификацией результатов.

## Capabilities

### New Capabilities
- `cursor-subagent-skill-evals`: Изолированная проверка фактического поведения
  Codex с установленным skill и recording MCP harness.

### Modified Capabilities

- `cursor-task-delegation`: Уточнить owner requirement «Skill workflow
  делегирования» для question, plan и permission в рамках уже существующего
  skill workflow.

## Impact

- Затронуты test fixtures, Node test suite, package-owned bootstrap/discovery
  helper, adapter golden fixtures и CI-скрипты.
- Публичные Cursor ACP, runtime MCP и bootstrap-контракты не изменяются.
- Credential-gated model и full-live lanes остаются опциональными; основной
  client-integration lane не доказывает качество или instruction-following
  hosted модели.
