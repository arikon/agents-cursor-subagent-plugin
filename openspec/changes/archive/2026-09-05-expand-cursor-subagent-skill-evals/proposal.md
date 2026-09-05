## Why

Семь существующих eval-сценариев уже проверяют client, model и live lanes, но
их входы, fake-ACP stimuli и ожидаемые результаты распределены между runner,
fixtures и тестами. Это затрудняет добавление сценариев и создаёт риск
семантического дублирования. Миграция в один строгий corpus и чистый oracle
сохраняет текущее поведение, а table-driven contract layer не добавляет
process startup на каждый scenario.

## What Changes

- Перенести ровно семь существующих сценариев — `client-happy`,
  `model-question`, `model-plan`, `model-permission-covered`,
  `model-permission-expansion`, `model-semantic-failure`, `live-marker` — в
  один versioned declarative corpus без добавления новых eval cases.
- Разделить fake-ACP program driver, который выдаёт ACP stimuli и записывает
  callbacks/effects, и pure scenario oracle, который сравнивает нормализованные
  MCP/ACP/effect observations с материализованным сценарием.
- Добавить закрытый immutable evidence manifest с digest точного установленного
  skill, raw corpus, materialized scenario, фактически выбранного adapter и
  projection package-owned aggregate hash; golden оставить отдельным
  version-specific adapter contract-test evidence.
- Проверять admission/materialization семи rows, pure oracle шести programmed
  rows и plumbing одного package-canary-reference одним верхнеуровневым
  table-driven тестом в существующем test file, без application child spawn,
  сети и process-per-scenario.
- Сохранить существующие opt-in foreground команды для real-Codex,
  hosted-model и full-live, а также публичный `EvalResultV1` и supervisor
  artifacts без изменений.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `cursor-subagent-skill-evals`: уточнить сценарный контракт, добавить
  program-driver/pure-oracle boundary, private evidence manifest и
  cost-aware execution policy.

## Impact

- Затронуты `scripts/run-cursor-skill-eval.mjs`, существующие eval tests и
  fixtures, новый `evals/cursor-subagent-scenarios.v1.json`, а также
  project-wide semantic registry/gate.
- `scripts/run-node-tests.mjs` меняется только для включения нового
  `scripts/cursor-eval-scenario.mjs` в `productSources`; lane mapping, process
  lifecycle и supervisor `result.json` не меняются.
- Runtime остаётся владельцем ACP lifecycle, public IDs и MCP wire; facade —
  delegation/authority semantics; package — installation/discovery;
  `node-test-supervision` — process tree, terminal verdict и `result.json`.
- Новые dependencies, новые сценарии, новая CI-инфраструктура, credential
  automation и изменения supervisor schema не входят в change.
