## Why

Свежий полный `unit`-прогон занимает 90,14 s, из которых 90,0 s лежат на
критическом пути одного `bootstrap.test.mjs`. Один тест намеренно ждёт
production timeout в 10 s, хотя соседние timeout-сценарии уже используют
короткую test-only инъекцию. Нужна минимальная оптимизация, которая сохраняет
производственные лимиты и диагностическую семантику тестов.

## What Changes

- Перевести конкретную bootstrap timeout-сценарий на существующую test-only
  инъекцию короткого command timeout; bootstrap/runtime production source и
  policy не меняются, допускается только governance registry source.
- Сохранить `unit` и `coverage` на файловой concurrency `2`; не вводить
  внутрипроцессную конкуренцию, новую lane, scheduler или изменение deadline.
- Зафиксировать сохранение lane policy и foreground supervisor
  acceptance-проверками.

## Capabilities

### New Capabilities

- Нет.

### Modified Capabilities

Нет. Это reference-only tooling change: capability
`node-test-supervision` сохраняет владение требованием `NTS-3` «Lane selection
и coverage scope»; публичные требования и product/runtime семантика не
меняются. Change использует `skip_specs: true` и не создаёт capability delta.

## Impact

- `tests/bootstrap.test.mjs`: test-only timeout-инъекция для одной timeout
  сценария; её observable recovery assertions сохраняются.
- `scripts/openspec-semantic-registry.mjs` и его semantic gate tests: явная
  reference-only связь с владельцем `NTS-3`.
- Публичные API, production timeouts, runtime/facade/package/ACP semantics,
  зависимости и release lane не меняются; governance registry допускается
  только для reference-only admission.
