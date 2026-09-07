## Why

Полный unit-набор на стабильном срезе выполняется 140,9 секунды при файловой
конкурентности 1 и 87,7 секунды при конкурентности 2. Нужно использовать
подтверждённый безопасный файловый параллелизм, не меняя состав тестов,
terminal verdict, coverage gate или release-сценарий.

## What Changes

- Изменить фиксированную файловую конкурентность lane `unit` с 1 на 2.
- Изменить фиксированную файловую конкурентность lane `coverage` с 1 на 2.
- Оставить lane `release` последовательным с конкурентностью 1.
- Зафиксировать точные значения contract-тестом и синхронизировать
  документацию с lane registry.
- Усилить semantic admission для reference-only `skip_specs` change: gate
  сверяет top-level marker, существование owner requirement и отсутствие
  capability delta, не назначая нового владельца.
- Подтвердить полный `unit`, `coverage` и `release` через существующий
  foreground supervisor на неизменившемся срезе исходников.

## Capabilities

### New Capabilities

- Нет.

### Modified Capabilities

Нет. Capability `node-test-supervision` по-прежнему владеет требованием
`NTS-3` о фиксированной concurrency policy; меняется только выбранное значение
этой tooling-политики. Change использует `skip_specs: true` и не создаёт
второго владельца требования.

## Impact

- `scripts/run-node-tests.mjs`: значения concurrency для `unit` и `coverage`.
- `tests/node-test-supervisor.test.mjs`: проверка точной lane policy.
- `scripts/openspec-semantic-registry.mjs`,
  `scripts/check-openspec-semantics.mjs` и
  `tests/check-openspec-semantics.test.mjs`: проверяемая reference-only связь
  с принадлежащим `node-test-supervision` требованием.
- README и `AGENTS.md`: только синхронизация документированной matrix, если
  числовое значение там указано.
- Публичные API, runtime/facade/package/ACP semantics, test-file наборы,
  deadlines, coverage thresholds и зависимости не меняются.
