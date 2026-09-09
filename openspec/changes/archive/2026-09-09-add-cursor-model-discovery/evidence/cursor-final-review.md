## Вердикт: **OKAY**

Замороженный контракт MD-1…MD-6 закрывает цель: **явные `model`/knobs не подменяются до prompt**. Это не обещание inference identity и не обещание сохранить модель на default-policy resume. Внутренних `baseline_violation` в переданном тексте нет. Live `GET /v1/models` с полными `parameters`/`variants`/`isDefault` (39/396, включая `auto-smart`) согласован с тем, что compact MCP — только проекция. Constrained candidate scoring вместо strict overlay обоснован GPT `fast`/`context`. Точные HTTP/CLI/ACP schema, argv и metadata остаются у version-specific adapter/golden.

Чужой fail global semantic gate (`simplify-task-state-wait`) к этому baseline не относится.

---

## Material findings

### 1. `implementation_concern`
Явный запуск **только canonical base ID без knobs** — не default policy (`omitted`/`auto`/`default`). MD-6 делает lookup, считает все variants кандидатами и требует уникальный default **либо** ровно один variant; иначе `model_discovery_failed`.

В evidence у `grok-4.6` указаны 8 variants и значения `effort`/`fast`, но **не** единственный `isDefault`. Поле `isDefault` в payload доказано, уникальный default на каждую multi-variant модель — нет. CLI по evidence принимает и полный variant, и legacy slug (голый ID).

Если golden/fixture закрывают только пути с knobs, ID-only старт/resume/delegate может оказаться мёртвым или флапать на metadata. Нужно явно закрыть этот путь: уникальный default в fixture **или** наблюдаемый fail-closed, **или** пропускать голый canonical ID как slug после проверки существования в каталоге (это уже умеет CLI). Это не дыра в цели: fail-closed ≠ тихая подмена.

### 2. `implementation_concern`
«Неоднозначный mapping `effort|reasoning|reasoning_effort` → `model_discovery_failed`» не фиксирует blast radius: падает весь `cursor_list_models` или только проекция `effort` у одной модели.

Сейчас params model-specific и не синонимы; ни один ID с двумя effort-like полями в snapshot не показан. Но формулировка допускает, что один плохой row роняет весь каталог. Это нужно зафиксировать в adapter/golden: per-model omit/fail vs abort всего list. На запуск с уже валидной проекцией не влияет.

### 3. `implementation_concern`
Фраза «несовпадение любого переданного provider параметра, для которого есть actual evidence» шире явных knobs: при полном encoded variant и эхе лишнего поля (например `context`) расхождение даёт allocated init failure.

Это согласовано с уже требуемым mismatch любого encoded поля; hidden singleton omission по-прежнему допустим. Риск — хрупкость, если Cursor эхоит не тот unspecified param, который закодировал resolver. Golden new/load должны сравнивать evidence с **encoded** полями, а не с default overlay; legacy `currentModelId` не evidence. К цели не противоречит (лишний fail-closed, не silent success).

---

## Проверено и не является finding

- Upstream не compact: 39 моделей / 396 variants, полные params и `isDefault`; MCP `{id,name,effort?,fast?,optimize_for?,default_optimize_for?}` — проекция. Исторические CLI exclusions, ranking, pagination, aliases array, generic parameter bag в v1 не входят.
- Default policy `omitted`/`auto`/`default` без knobs — без lookup, прежняя semantics start и resume; retain старой модели не обещан. Те же ID с knobs — `invalid_args`. `false` для `fast` — явное значение. `auto-smart` требует `optimize_for`; `default_optimize_for` в каталоге не подставляется в launch.
- Скоринг: фильтр по **всем** явным mapped constraints → max совпадений с единственным default → tie default, иначе первый в порядке provider. Нет healing, нет fallback, нет strict overlay. Явные knobs не меняются; unspecified могут (GPT `fast=true` / `context=272k`). Нет кандидатов — `invalid_args`; грязные metadata — `model_discovery_failed`.
- Evidence check после `session/new` и `session/load` до live и до первого delegate prompt; requested bootstrap/status не proof. Нет evidence для canonical ID и explicit knobs — init failure + cleanup, без turn и ACP setters. Hidden unspecified не обязаны иметь evidence.
- Bracketed model на MCP уже запрещён; argv/encoding/parameterized picker — adapter. Имена вроде `parameterizedModelPicker` не public API.
- Auth только `apiKey` из `~/.cursor/auth.json`, без fallback/cache/CLI/login/записи. Каталог не permission gate; расхождение API-key vs CLI лечится ordinary allocated init failure, не подменой `auto`.
- Ошибки discovery: `model_discovery_failed` / `invalid_args` / `resource_limit`, без SessionEnvelope, credentials, raw body и частичного списка. Слот 1, timeout 15s, payload 1MiB без partial. Cancel HTTP/stream на success/fail/shutdown.
- Tasks (как задано): golden Grok/GPT/Gemini, persisted resume (пустой intelligence + `-32602` не evidence), authoritative new/load в init deadline, teardown failure, mismatch encoded поля, hidden singleton omission. Это закрывает probe-дыры, а не дыры baseline.
- `optimize_for` closed enum на MCP и provider-literal в каталоге сейчас совпадают (`cost|balanced|intelligence`); лишние будущие значения отсечёт shape, отсутствующие — MD-6. Отдельный public API не нужен.

---

`implementation_concern` не ломает freeze. К реализации: в golden явно закрыть ID-only и blast radius mapping; сверять encoded поля с parameterized evidence, не с legacy presentation.
