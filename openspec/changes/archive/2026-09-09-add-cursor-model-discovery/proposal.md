## Why

В рабочей сессии Codex вызов Cursor с `model: "grok"` завершился до создания turn: Cursor CLI сообщил `Cannot use this model: grok`, но MCP вернул только `failure_kind: init`. У caller нет MCP-инструмента для получения действительных идентификаторов моделей, а stderr запуска теряется.

## What Changes

- Добавить `cursor_list_models({})`: список моделей текущего Cursor account через официальный публичный API каталога SDK с `apiKey` из `~/.cursor/auth.json` на MCP-хосте, без создания ACP-сессии и turn.
- Добавить явный выбор Auto Cost/Balance/Intelligence в существующие start/delegate/resume и отразить доступные стратегии/default в каталоге.
- Согласованно выбирать полный provider variant и проверять фактические explicit model/knobs до live/prompt через общий runtime resolver.
- Возвращать ограниченную диагностику stderr при неуспешной инициализации Cursor в существующем `terminal_reason`, сохранив классификацию и cleanup.
- Научить skill получать идентификаторы через MCP, не угадывать семейные aliases и сообщать причину неуспешного запуска.
- По последующему явному запросу пользователя исправить запуск с file apiKey: не инициировать browser-login и не допускать очистку этого файла CLI; временные API-key credentials принадлежат памяти дочернего процесса.
- Зафиксировать публичную API-схему в узком version-specific adapter fixture; проверить discovery, ошибки и installed skill в credential-free lanes.

## Capabilities

### New Capabilities

Нет новых владельцев или подсистем.

### Modified Capabilities

- `cursor-acp-session-runtime`: модельный discovery tool, ограниченная HTTP-операция и stderr-диагностика запуска.
- `cursor-task-delegation`: композиция выбора модели и сообщения об ошибке через существующий MCP runtime.

## Impact

Runtime и его MCP tool declarations; version-specific Cursor adapter/fixtures; установленный `skills/cursor-subagent/SKILL.md`; runtime/transport tests, package canary и семантический аудит operator workflow. Новых dependencies, policy engine, модельного registry и изменений настройки аутентификации нет.

Change не зависит от незавершённого `simplify-task-state-wait`. Перед apply необходимо сверить пересекающиеся runtime/skill requirement blocks и минимально перебазировать delta при изменении main. Черновая доработка stderr уже присутствует в рабочем дереве, но не считается завершённой реализацией этого change.
