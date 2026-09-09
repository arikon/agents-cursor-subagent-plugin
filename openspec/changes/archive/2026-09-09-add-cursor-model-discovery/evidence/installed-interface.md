# Проверенный установленный интерфейс

Дата: 2026-09-09. Источник: установленный Cursor CLI, а не предположение об ACP capability. Это adapter evidence; долгоживущие требования находятся в specs.

- `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent --version`: exit 0, `2026.08.25-3e8eec8`.
- `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent --help`: `models` — `List available models for this account`; также объявлен `--list-models`. Для v1 выбран один argv: `models`.
- `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent models`: exit 0, stdout содержит `Available models`, записи `auto - Auto (default)`, `cursor-grok-4.6-high - Cursor Grok 4.6` и другие ID, затем `Tip: use --model <id> ...`. Это выборочные точные excerpts успешного вывода, не полный golden fixture. Полный credential-free golden fixture формируется в implementation task, не копирует account-specific доступность в продукт.
- На этом хосте вызов без настройки credential store ранее завершался `SecItemCopyMatching failed -50`. Плагин уже задаёт file store в своей конфигурации; discovery использует существующее окружение и не переключает auth settings самостоятельно.

Реальная диагностическая последовательность для argv `--auto-review --sandbox enabled --model grok acp`: `initialize` успешно; на `authenticate` stderr начинается `Cannot use this model: grok. Available models: ...`, затем EOF, без успешного `session/new` и turn.

Черновой исправленный runtime проверен на том же отказе: `failure_kind: init`, `terminal_reason.text` содержит `stdout EOF` и `Cursor stderr: Cannot use this model: grok`, `active_turn: null`; полученный bounded diagnostic — 5300 UTF-8 bytes, `truncated: false`. Это подтверждение исходного случая, не полная приёмка change.

Не подтверждались и не входят в v1: машинный JSON-режим списка моделей, цены, context limits, structured effort/fast capabilities, отдельный ACP list-models method или account/login API.

## Дополнительная проверка ACP model discovery

2026-09-09: живой Cursor той же версии, без `--model`, успешно выполнил `initialize` → `authenticate(cursor_login)` → `session/new` в отдельном временном cwd. Prompt не отправлялся; процесс остановлен после ответа. Полный локальный ответ: `/tmp/cursor-acp-model-discovery-result.json`.

`session/new` возвращает одновременно `models.availableModels` и `configOptions` с `category: model`, `type: select`, `options: [{value, name}]`; получено 38 вариантов. Пример точного ACP value: `grok-4.6[effort=high,fast=true]`. CLI-список использует другой ID: `cursor-grok-4.6-high`. Их взаимозаменяемость и композиция с отдельными `effort`/`fast` текущего MCP здесь не проверены.

Стандартный путь описан в https://agentclientprotocol.com/protocol/v1/session-config-options и https://agentclientprotocol.com/protocol/v1/schema#newsessionresponse: configOptions опционален и привязан к созданной сессии. Самостоятельный list-models RPC не подтверждён. Discovery через ACP фактически доступен, но требует session/new; завершение процесса не является доказательством удаления созданной provider conversation.

Это новое evidence требует пересмотра выбора CLI-источника перед implementation: текущий design фиксирует discovery без ACP-сессии. Не считать прежнее отсутствие подтверждения ACP утверждением об отсутствии такой возможности.

## Каталог параметров до создания сессии

2026-09-09, первичные источники:

- https://cursor.com/docs/sdk/typescript#cursormodelslist — `Cursor.models.list()` прямо предназначен для вызова до `Agent.create()`/`send()`. Возвращает `id`, `aliases`, `parameters[{id,values[{value}]}]`, `variants[{params[{id,value}],isDefault}]`.
- https://cursor.com/docs/cloud-agent/api/endpoints#list-models — публичный `GET https://api.cursor.com/v1/models` с Basic API-key auth, ответ `{items:[...]}`. SDK dependency для HTTP-вызова не требуется. Документация называет каталог recommended models; полнота относительно всех CLI моделей и всех сочетаний параметров не гарантирована.
- https://cursor.com/docs/sdk/typescript#the-cursor-namespace — explicit apiKey → CURSOR_API_KEY → SDK stored login. SDK не переиспользует login локального Cursor app. На этом хосте переменная CURSOR_API_KEY не задана, файла SDK login нет; авторизованный запрос к этому API не выполнялся. Публикуемая npm-версия @cursor/sdk: 1.0.31 (npm registry).

Установленный Cursor CLI 2026.08.25-3e8eec8 подтверждает, что данные технически доступны без ACP-сессии: в `865.index.js`, модуле `./src/commands/models.ts`, `handleModelsList` вызывает `fetchModels`, но использует только `availableModels/defaultModel/usableModelsError`. В том же chunk `./src/models/fetch-models.ts` получает `parameterizedModels` через внутренний `availableModels` RPC с `useModelParameters:true, doNotUseMarkdown:true`; модель содержит `parameterDefinitions` и `variants`. Человекочитаемый вывод команды эти поля теряет. `models --help` не объявляет формат JSON. Прямой внутренний RPC или импорт minified bundle не является публичным стабильным API; в продукт не добавлялся.

Граница точности: значения параметров модель-специфичны; `effort`, `reasoning`, `reasoning_effort` нельзя молча считать одним wire ID. `variants` содержит конкретные допустимые наборы; ни полнота списка наборов, ни допустимость произвольного декартова произведения `parameters.values` из документации не следуют. Исходная форма `cursor_list_models → {id,name}` недостаточна для нового требования параметров; изменение design/spec требует отдельной согласованной доработки baseline после выбора источника/auth.

## Прямой RPC с текущим file auth: подтверждён

2026-09-09: выполнен `POST https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels` через Node fetch, `Content-Type: application/json`, `Connect-Protocol-Version: 1`, Bearer accessToken из существующего CLI file auth, `x-cursor-client-version: cli-2026.08.25-3e8eec8`, `x-ghost-mode: true`; body `{useModelParameters:true,doNotUseMarkdown:true}`. Ответ HTTP 200: 38 моделей, 32 с parameterDefinitions, 38 с variants. Сессия не создавалась. Raw catalog без credentials: `/tmp/cursor-direct-model-catalog.json`.

Пример grok-4.6: effort low/medium/high/xhigh, fast false/true, 8 concrete variants. Это фактический прямой доступ без API key, SDK login и патча bundle. Предыдущая формулировка о сложности самостоятельного RPC была чрезмерной: для этого unary RPC сервер принимает обычный JSON. Python urllib получил HTTP403 error1010; Node fetch успешно выполнил тот же RPC. Причина различия клиентов не установлена.

Адрес и schema взяты из установленного Cursor bundle (AiService, service-urls, models fetch). Это внутренний provider API, не публичный стабильный контракт. Проверена текущая работоспособность, не обновление истёкшего accessToken и не будущая совместимость. Требование нового API key относится к публичному api.cursor.com, а не к этому проверенному endpoint.

Публичный endpoint проверен тем же CLI file-auth accessToken по прямому запросу пользователя: `GET https://api.cursor.com/v1/models`, `Authorization: Bearer <accessToken>` → HTTP 401, `{"code":"error","message":"Invalid User API Key"}`. Для сравнения внутренний AvailableModels ранее принял этот token (HTTP200). Поэтому текущий file-auth token не заменяет API key для проверенного публичного Bearer-вызова. Credentials не выводились и не сохранялись в evidence.

## Выбранный публичный источник с apiKey из CLI file auth

Пользователь добавил apiKey в ~/.cursor/auth.json и явно выбрал это поле как источник авторизации discovery. Живой GET https://api.cursor.com/v1/models с Bearer apiKey: HTTP200, верхний объект {items}; 39 моделей, 396 variants. В записи реально присутствуют id, displayName, optional aliases, parameters, variants. Parameters: id/displayName/values; variants: params/displayName/isDefault. Compact JSON 72679 bytes, pretty artifact186294 bytes (это не замер wire body). Публичный каталог содержит все38 ID предыдущего internal snapshot плюс default; это сравнение снимков, не гарантия будущей полноты.

Подтверждено официальным @cursor/sdk1.0.31: Cursor.models.list вызывает listCloudModels и CloudApiClient.listModels с GET /v1/models. Прямой HTTP использует этот официальный API без зависимости SDK. Auth key не печатался и в evidence не копировался.

Признаков isCursorModel/provider/vendor публичный ответ не содержит. Grok отображается как Cursor Grok 4.6/4.5, Composer как Composer2.5; по label нельзя вводить нормативную классификацию владельца модели.
