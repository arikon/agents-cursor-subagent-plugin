# Правила проекта

## Проектирование и контракты

- Соблюдай KISS: выбирай простейшую конструкцию, которая решает
  наблюдаемую задачу, и не добавляй архитектурные уровни ради формальной
  гибкости.
- Соблюдай DRY и SSOT: не дублируй правила, lifecycle, идентификаторы,
  состояние, policy, схемы, transition table или алгоритмы. У каждого из них
  должен быть один владелец; OpenSpec design/spec/tasks и кодовые
  facade/adapter могут ссылаться на него и добавлять только свою независимую
  ответственность.
- Соблюдай SRP: каждый слой, сущность и модуль должны иметь одну независимую
  ответственность. Facade не дублирует lifecycle или состояние нижележащего
  runtime, а добавляет только собственную роль.
- Применяй SOLID по необходимости: разделяй стабильные контракты и реализации,
  не связывай клиентов с лишними возможностями и направляй зависимости к
  абстракциям только там, где это упрощает замену или тестирование. Предпочитай
  тонкие facade над существующим контрактом, а не параллельные registry и
  state machine.
- Следуй YAGNI: не вводи сущность, слой, абстракцию, зависимость или policy
  engine до появления конкретного сценария, который ими пользуется и без них
  не решается.
- Любое усложнение архитектуры MUST иметь короткое объяснение: какую
  наблюдаемую проблему оно решает, почему существующая конструкция не подходит
  и как его необходимость проверяется тестом или эксплуатационным сценарием.
- Перед тем как расширять использование внешнего или зависимого контракта,
  reviewer MUST подтвердить его актуальную версию, точную schema/API и
  применимую capability boundary по первичному источнику либо фактическому
  установленному интерфейсу. Неподтверждённые поля, методы и semantics не
  включаются в design/spec; их оставляют за узким version-specific adapter с
  golden fixture либо явно исключают из scope.

## Модели угроз и полномочия

- Проверяй модель угроз на реалистичность для обычного локального сценария
  Codex + Cursor под одним пользователем; не представляй scope validation как
  sandbox или security boundary.
- Используй технические ограничения как защиту от ошибки scope только в той
  мере, в которой они действительно ограничивают возможности процесса.
- Не вводи policy engine без явной потребности. MCP-сервер не принимает
  permission-решения автоматически; Codex должен подтверждать действия Cursor
  в рамках выданных пользователем полномочий. Не обязательно использовать
  только одноразовые подтверждения, если весь класс подтверждений уже покрыт
  выданным ранее поручением пользователя.
- Эскалируй пользователю расширение scope, destructive и внешние действия, а
  также доступ к credentials. Не включай бессрочные разрешения по умолчанию.

## OpenSpec convergence

`AGENTS.md` is the single normative owner of project-wide OpenSpec governance.
`openspec/config.yaml` may only provide supported OpenSpec configuration and a
context link; a change baseline lives in its `design.md` and indexes, rather than
repeats, normative requirements in its `spec.md`.

- Before every full review, every change MUST have a `## v1 Contract Baseline` in
  `design.md`: goal, non-goals, index of public invariants by requirement ID,
  owner map, implementation-ready exit criterion and future-change candidates.
- After baseline freeze every reviewer finding MUST be classified exactly once:
  `baseline_violation` (minimal repair in current change),
  `implementation_concern` (task/test only), `external_adapter_drift`
  (version-specific adapter/golden fixture only), `new_scope` (separate change),
  or `overengineering` (remove or exclude from v1).
- Review completeness is not capped, but number of findings never expands a
  frozen baseline. An architect MUST validate every classification, repair
  minimality and absence of new duplication; `new_scope` needs the user's
  explicit baseline update before entering a current change.
- A normative rule has one owner: runtime owns lifecycle/state/MCP wire/limits;
  facade owns only user-workflow composition; package owns install/discovery and
  one minimal release canary. Upper layers reference owner requirement IDs and
  test only their independent responsibility.
- Cursor/ACP/Codex schema, argv, flags, capability details and versions require
  primary-source or installed-interface confirmation and belong in a
  version-specific adapter/golden fixture, not a long-lived product requirement.
- `openspec validate --strict` is structural only. Before review, run the
  deterministic semantic gate: owner map, no normative duplicates, proposal /
  design / spec / tasks consistency, and no upper-layer reference to a lower
  owner’s internal details.
- A change is specification-ready when an independent critic finds no
  `baseline_violation`; `implementation_concern`, `external_adapter_drift` and
  future scope do not invalidate the frozen v1 contract.

## Review

- Перед реализацией проверяй каждый контракт на избыточные сущности,
  непроверяемые гарантии, ложные security-утверждения и реалистичные failure
  paths обычного использования.
- Не ограничивай ревьюера по времени, количеству замечаний или размеру
  verdict: review MUST перечислить все найденные блокеры и существенные риски,
  а не только наиболее приоритетные.
- Не прерывай и не перезапускай ревьюера до его verdict. Это допустимо только
  при доказанном зависании или клинче: ревьюер явно не способен выдать
  ожидаемый результат после проверки его фактического состояния. Таймаут
  наблюдения и кратковременные сетевые ошибки сами по себе не являются таким
  доказательством. Если сетевые ошибки повторяются несколько раз подряд в
  течение заметного времени (минут), проблему можно признать доказанной.

## Запуск тестов и coverage

- Не снижать покрытие продуктового кода тестами. Поддерживай его около 90% или
  выше по lines, branches и functions в полном fail-closed manifest
  согласованного product scope: source не может исчезнуть из знаменателя только
  потому, что перестал загружаться тестами.
  Каждый тест MUST проверять наблюдаемое поведение, публичный контракт или
  реалистичный failure path. Не закрепляй внутреннюю структуру, конкретные
  строки, приватные helper-ы, способ реализации либо конфигурационные детали,
  если сами они не являются документированным внешним контрактом. Coverage
  сам по себе не является основанием для теста.
  Для тестов соблюдай DRY, SSOT и SRP: у каждого наблюдаемого сценария и
  контракта есть один тестовый владелец на подходящем слое. Не повторяй одну
  семантическую проверку в unit, transport, smoke, facade или e2e-тесте;
  вышележащий тест добавляет только собственную интеграционную ответственность.
  Перед добавлением теста и при review набора тестов MUST сверять существующие
  сценарии, удалять смысловые дубликаты и переносить общую fixture/помощник к
  единственному владельцу, не создавая test-only API в продуктовом коде.
  Не добавляй искусственные тесты незначимых веток только ради метрики:
  исключение допустимо лишь для реально недостижимого defensive-кода и должно
  быть локально обосновано рядом с исключением либо в review.
- Запускай тесты в foreground и считай прогон успешным только после завершения
  команды с exit code `0` и её финального TAP summary. Не используй `&`, не
  перенаправляй проверочный прогон в фоновый лог и не считай частичный вывод
  доказательством pass.
- Для обычной unit-проверки используй supervisor lane:

  ```sh
  node scripts/run-node-tests.mjs unit
  ```

- Для того же fixed набора с coverage используй `node
  scripts/run-node-tests.mjs coverage` (старый `run-unit-coverage.mjs` остаётся
  только compatibility entrypoint). Для release-проверки используй `node
  scripts/run-node-tests.mjs release`. Supervisor владеет process group,
  ожидает `close`, печатает terminal verdict и сохраняет `tap.txt`, `stderr.txt`,
  `failures.jsonl` и атомарный `result.json` в выведенном artifact directory.
  При non-pass verdict сначала читай `result.json`, затем указанные в нём refs.
  При verdict `coverage_gate` после `result.json` читай последнее событие
  `test:coverage` в `failures.jsonl`: его per-file `lines`, `branches` и
  `functions` с нулевым `count` — первичный источник для поиска непокрытых
  строк, веток и функций. Весь raw отчёт MUST быть рабочей очередью review,
  а не необязательной диагностикой: до завершения change каждую непокрытую
  точку классифицируй как осмысленный контракт, реалистичный failure path,
  действительно недостижимую защитную ветвь или мёртвый код. Для первых двух
  MUST добавить или расширить поведенческий тест; мёртвый код MUST удалить;
  исключить можно только действительно недостижимый defensive-код с локальным
  обоснованием рядом с исключением или в review. Порог 90% — только
  минимальный fail-closed gate, а не цель, не критерий готовности и не причина
  прекращать анализ: прохождение агрегатного процента при неразобранных
  осмысленных ветках или строках является незавершённой работой. Новые тесты
  всё равно должны проверять наблюдаемый контракт или реалистичный failure
  path, а не конкретную строку либо конфигурацию.
- Release, real-Codex и hosted-auth lanes запускай отдельными foreground
  командами. Они не входят в unit coverage и не могут подменять его результат.
