## Why

Текущий `unit` смешивает проверки логики с ACP/MCP subprocess integration, а
`release` и `eval` содержат быстрые проверки вспомогательной логики. Это скрывает
стоимость обратной связи и мешает применять новые правила пирамиды из `AGENTS.md`;
наследуемые live-флаги также могут включить внешние зависимости локального прогона.

## What Changes

- Разделить детерминированные component- и integration-тесты в существующем
  supervisor, сохранив `unit` как их полный совместимый агрегат и `coverage`
  как проверку того же набора. Добавить селективные lanes `component` и
  `integration`; владельцем списков остаётся supervisor.
- Перенести чистые проверки из release/eval harnesses в нижние уровни;
  сохранить минимальный installed-package E2E и отдельные live/model paths.
  Сохранить выбор package-сценария eval harness, не дублируя lifecycle runner.
- Исключить live canaries из локального агрегата и закрыть наследование всех
  их enable-флагов; явные совместимые eval-вызовы сохраняют доступ к canaries.
- **BREAKING (только запуск тестов):** включённый live-флаг в `eval` без
  совместимого явного test-file selector теперь отклоняется до spawn.
  Существующие focused harness-вызовы сохраняются.
- Разделить тяжёлые runtime-проверки по ответственности и реальной зависимости,
  устранить подтверждённые повторные setups с сохранением assertions, заменить
  ненужные реальные ожидания управляемой синхронизацией. Изменять concurrency
  только после проверки изоляции и измерений.
- Сравнить полную одинаковую детерминированную работу до/после: целевой median
  wall time — не более половины baseline. Сохранить coverage manifest,
  содержательные failure paths и отдельные acceptance gates.

## Capabilities

### New Capabilities

Нет: новый продуктовый слой или test framework не вводится.

### Modified Capabilities

- `node-test-supervision`: добавить контракт выборочных уровней локальной
  проверки и их единого агрегата; уточнить допуск live-флагов на выбранном
  eval-пути. Существующие runner lifecycle, artifacts и coverage proof
  остаются у своих требований без копирования.

## Impact

- `scripts/run-node-tests.mjs`, его tests и документация команд; список
  evaluator inputs в `scripts/cursor-skill-eval.mjs` обновляется при переносе
  зависимостей по существующему правилу проекта.
- `tests/*.test.mjs`, `tests/fixtures/*` и необходимые общие test helpers;
  возможен перенос harness-кода из тестовых entrypoints без изменения
  runtime, facade, bootstrap и операторского skill.
- MCP/ACP semantics, product limits, provider/model selection, corpus и
  политика полномочий не меняются. Новых зависимостей нет.
- Apply начинается с фиксации стабильного исходного среза пересекающегося
  `simplify-task-state-wait` и успешного локального baseline; его release и
  archive не являются prerequisites. Текущие незакоммиченные изменения этого
  change не являются материалом для отката или старым performance baseline.
- Архивные `parallelize-node-test-lanes` и `accelerate-node-unit-tests`
  сохраняются как история. Этот change не возвращает уже удалённые издержки.
