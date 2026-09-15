## Why

Terminal wait передаёт preview, после которого skill повторно читает полный результат с нуля. Для сохранённого ответа 8 353 UTF-8 байта это означает 16 352 байта текста и три вызова получения результата; первая полноценная страница в wait с объединением короткого хвоста позволяет передать тот же ответ одним вызовом.

## What Changes

- **BREAKING**: заменить `result` на `result_page:null|ResultPage` только в terminal `cursor_wait`; использовать существующий контракт страницы без второго экземпляра текста.
- В единственном runtime-построителе страницы использовать номинальные 8 000 UTF-8 байт и возврат всего остатка, если он не превышает 10 000 байт. Правило одинаково для wait и `cursor_read_result`.
- Сохранить state-oriented повторяемость wait, точную адресацию turn, UTF-8, retention, полноту и failure semantics. Не вводить delivery state, registry или новый lifecycle.
- Сохранить прежний preview digest в immutable terminal receipt и диагностическом status. Full-result digest остаётся у ResultPage; его нельзя сравнивать с preview digest.
- Изменить ветку получения результата в skill: принять первую страницу и дочитывать по `next_offset` перед verification, новым turn и close; вынести общий prompt preflight для mode, bounded context и exact text к каждому действию prompt.
- Адаптировать существующее completeness/lost-response evidence и operator eval к новому dataflow; сравнить объём и число вызовов на одинаковых результатах.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `cursor-acp-session-runtime`: terminal envelope, согласованное чтение страниц и предел объединения хвоста.
- `cursor-task-delegation`: получение полного результата из terminal wait и последующих страниц.
- `cursor-subagent-skill-evals`: доказательство полноты из доставленной первой страницы и хвоста, с сохранением отдельного receipt proof и recovery потерянного ответа.

## Impact

Реализация затронет `scripts/cursor-subagent-mcp.mjs`, `skills/cursor-subagent/SKILL.md`, существующие recorder/oracle и соответствующие runtime, MCP, eval и package проверки. Planning регистрируется в существующем `scripts/openspec-semantic-registry.mjs`; main specs и архивированные changes на этом этапе не изменяются. Новые зависимости и внешние API не нужны.

`compact-cursor-subagent-skill` редакторски сокращает skill при прежнем wire contract и отдельно измеряет skill context. Предпочтительный порядок интеграции: завершить его сравнение и acceptance, затем применить этот change к сокращённому skill. Это порядок интеграции, а не runtime prerequisite; подробное пересечение, альтернативный порядок и правила сравнения описаны в design. Второй change и его worktree здесь не редактируются.

Summary/artifact, миграция смысла receipt, batch permissions, steering, multi-wait и push вне scope. `simplify-task-state-wait` остаётся архивированным. Proposal не запускает реализацию, hosted eval или публикацию.
