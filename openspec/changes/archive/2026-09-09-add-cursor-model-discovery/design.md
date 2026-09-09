## Context

См. `proposal.md`. Проверенный текущий runtime запускает CLI из существующего environment MCP и использует один version-specific `ADAPTER`. Официальный каталог SDK доступен через публичный REST API; пользователь выбрал `apiKey` из `~/.cursor/auth.json` как единственный источник credentials для discovery. Реальный отказ неподдерживаемой модели приходит в stderr во время authenticate и заканчивается EOF, а не JSON-RPC error. Подтверждения интерфейса — `evidence/installed-interface.md`.

## v1 Contract Baseline

**Goal.** Дать caller компактный каталог и согласованно перенести явный выбор модели/параметров в Cursor до prompt, сохранив причину неуспешного запуска.

**Non-goals.** Запуск ревью в рамках discovery; смена модели, логина, глобальной конфигурации или полномочий; auto-retry, постоянный кэш, модельный registry, подбор «лучшей» модели; смена wait/lifecycle contract; новый diagnostics API; публикация релиза в рамках planning.

**Public-invariant index.** `MD-1` → «Получение моделей Cursor через MCP»; `MD-2` → «Публичный MCP tool contract»; `MD-3` → «Нормативные limits runtime»; `MD-4` → «Provider errors are bounded and classified»; `MD-5` → «Skill workflow делегирования»; `MD-6` → «Согласованный выбор модели до prompt»; `MD-7` → «Неинтерактивная авторизация запуска»; `MD-8` → «Продолжение Cursor-сессии».

**Owner map.** `cursor-acp-session-runtime` owns model discovery, HTTP bounds and startup diagnostics; `cursor-task-delegation` owns caller workflow composition. MD-1–MD-4 и MD-6–MD-8 принадлежат runtime; MD-5 — facade/skill. Package по существующему контракту проверяет установку и обнаружение инструмента, не повторяет runtime lifecycle. Eval использует существующий corpus owner; новой capability для него нет.

**Implementation-ready exit.** Все MD-index requirements согласованы с proposal/design/tasks, source/replacement blocks зарегистрированы, strict и semantic gates проходят; независимый critic не находит `baseline_violation`, architect подтверждает классификации и минимальность. Это readiness спецификации, не завершение черновой реализации или live-релиза.

**Future-change candidates.** Дополнительные сведения о ценах и расширение launch input другими параметрами; фильтрация и ранжирование моделей; другие providers; MCP account/login management; кэш/TTL; discovery-specific model-behavior eval grammar. Они не входят в v1.

## Goals / Non-Goals

Граница дизайна — одна request-scoped HTTP операция рядом с существующим ACP adapter и дополнение bounded failure text. Не создаётся общий subprocess framework и не расширяются права Cursor. Scope validation остаётся защитой от ошибок выбора workspace, а не OS sandbox.

## Decisions

### Уточнение baseline по запросу пользователя: авторизация запуска

2026-09-09 пользователь потребовал исправить два browser-login при попытках
ревью. Установленный Cursor проверяет LOGIN при startup и в ACP authenticate;
наличие apiKey в file store способно вызвать clearAuthentication и удаление
auth.json. Одного пропуска RPC недостаточно. Подтверждённый adapter передаёт
file key дочернему процессу через CURSOR_API_KEY вместе с memory credential
store, исключает inherited CURSOR_AUTH_TOKEN и не вызывает interactive login.
Токены остаются в памяти процесса; нового auth lifecycle или восстановления
credentials нет. Token-only ветка сохраняет native CLI auth без принудительного
login. MD-7 владеет поведением, MD-8 лишь ссылается на общий startup путь.
Проверка необходимости: fixture сохранности файла и прямой live init без prompt
при файле только с apiKey. Exact env/schema evidence — version-specific adapter.

### Один runtime tool, без ACP-сессии

MD-1 реализуется в существующем runtime dispatcher. Источник — официальный публичный каталог SDK `Cursor.models.list()`: в проверенном `@cursor/sdk` 1.0.31 цепочка `listCloudModels → CloudApiClient.listModels → GET /v1/models`. Используем его REST endpoint напрямую через встроенный fetch, без новой SDK dependency: наблюдаемая задача — один GET, а transport adapter обеспечивает те же schema/auth contract и bounded streaming. Это явное решение о способе вызова официального API, не внутренний RPC. Evidence: `evidence/public-sdk-catalog.md`.

Runtime читает только `apiKey` из `~/.cursor/auth.json` текущего пользователя MCP-хоста (`homedir()/.cursor/auth.json` на каждой платформе). Нет fallback к environment, accessToken, CLI или внутреннему API; нет выпуска ключей, refresh/login и записи auth. Каталог относится к аккаунту API key; совпадение с аккаунтом последующего CLI launch не гарантируется. Отсутствующий файл либо отсутствующий/blank ключ даёт actionable MD-1 error. Смена ключа применяется следующим вызовом без кэша.

У каждого запроса свой результат. Runtime держит один transient admission flag/AbortController; это не реестр моделей и не новая session state machine. При занятом слоте — немедленный MD-3 error без очереди. Cleanup отменяет HTTP/stream и освобождает slot, включая shutdown. Таймер охватывает чтение credentials, HTTP и body; превышение byte bound не возвращает частичный каталог.

ACP session/new отвергнута: discovery работает до выбора модели и не создаёт provider-сессию. Shell-команда в skill отвергнута пользователем; skill вызывает только MCP.

### Version-specific источник и разбор

Проверенный официальный API: `GET https://api.cursor.com/v1/models`, `Authorization: Bearer <apiKey>`, без редиректов и retries. HTTP 200 с текущим ключом вернул `{items:[...]}`: 39 моделей, 396 variants, 72 679 байт compact JSON. Это recommended catalog, не обещание всех CLI-моделей. Provider schema/auth и golden fixture принадлежат узкому adapter; долгоживущий нормализованный `ModelCatalog` принадлежит MD-1.

Пользователь явно включил Auto в baseline: базовый каталог MD-1 содержит effort/fast и для Auto optimize_for/default_optimize_for, а MD-2 допускает явный выбор стратегии в start/delegate/resume. Это решает конкретный сценарий запуска Auto Cost/Balance/Intelligence, который прежний launch input не мог выразить; необходимая проверка — каждый путь передаёт выбранную стратегию, invalid сочетания отклоняются до allocation.

Единственный resolver MD-6 обслуживает compact discovery и explicit launch. Version-specific adapter владеет подтверждённым uniform effort mapping и полными variants; MCP не получает общий parameter bag. Все базовые модели сохраняются без hardcoded exclusions. Explicit launch использует fresh MD-1 lookup; обычная default policy без knobs остаётся прежней.

Из установленного Cursor model-selection усвоен constrained выбор полного variant: совпадение всех explicit constraints, затем максимальная близость к provider default и provider order для различий только unspecified полей. Healing invalid values и fallback из Cursor не переносим. Наблюдаемая необходимость: GPT fast=true требует context272k, тогда как default context1m; простое наложение на default ошибочно отклоняет допустимый выбор. Полный Grok variant также устраняет неподтверждённость частичного кодирования. Единственным нормативным владельцем алгоритма и ошибок остаётся MD-6.

После new/load adapter проверяет actual canonical model и explicit knobs перед live/prompt. Parameterized picker служит evidence; legacy models.currentModelId может вводить в заблуждение. Exact metadata/encoding закрепляются version-specific fixture. Проверка не обещает знание скрытых unspecified параметров или фактического inference routing, не добавляет corrective setters, registry или cache.


### Bounded failures

MD-4 использует существующий `terminal_reason`. Для startup stderr сохраняется ограниченный префикс байтов; итог декодируется и ограничивается существующим BoundedText. Сообщение runtime и stderr разделены текстовой меткой. Буфер не продолжает расти после успешного init или завершения failed allocation.

Exit и EOF могут прийти до последнего stderr chunk. Cleanup дочитывает stderr только до существующего grace deadline, затем освобождает собственные stream resources. Наследник, удерживающий pipe, не должен задерживать ответ без границы. Ошибка metadata/version probe также сохраняет её stderr; stdout версии не смешивается с ним. Для discovery HTTP/network/auth failures используются собственные фиксированные bounded сообщения и безопасный HTTP status, без raw response body, headers, exception text или credentials; SessionEnvelope не создаётся.

Не добавляются logs с environment/credentials, error.data или новые диагностические инструменты. Произвольный текст CLI не становится инструкцией caller. Ограничение объёма не является обещанием универсальной очистки provider stderr от любых чувствительных данных.

### Проверка без дублирования

- Runtime tests владеют нормализованным списком, ресурсными bounds, ошибками и stderr drain/UTF-8. Отказ модели — сценарий без turn; проверка не привязана к текущему списку моделей аккаунта.
- Adapter golden fixture владеет публичной API-схемой/auth; авторизованный GET canary проверяет только реальную совместимость и не заменяет deterministic tests.
- Package E2E проверяет вызов discovery через установленный MCP: success и failure до allocation, совместимость выбранного fixture ID с launch input, доставку startup-причины через транспорт. Эта проверка не повторяет parser/resource edge cases.
- Независимый семантический аудит установленного skill сверяет MD-5 с фактическим tool inventory, default/explicit выбором, error/close/resume guidance и отсутствием shell обхода. Это проверка operator contract, не доказательство реального выбора инструмента моделью. Новые discovery events/eval grammar и hosted model comparison не требуются для v1; такое автоматическое behavior evidence остаётся future-change candidate.

## Risks / Trade-offs

- Публичный API меняет известную схему → узкий adapter/golden fixture и явный error; дополнительные неизвестные поля не расширяют публичный MCP output.
- Каталог зависит от account и времени → без persisted cache и без гарантий будущей доступности модели.
- Длинный stderr/незакрытый pipe → MD-3/MD-4, bounded cleanup и regression tests; поздние байты не меняют опубликованный результат.
- Параллельный `simplify-task-state-wait` меняет MD-2/MD-5 → этот change основан на текущем main; перед apply/release сверить source digests, при landing другого change минимально rebase. Никаких изменений wait semantics сюда не переносится.

## Migration Plan

Реализовать после readiness; сверить черновой stderr patch с MD-4 и довести все task/test checks. Runtime, tool inventory и skill поставляются согласованно. Обновить установленный плагин штатным способом и проверить fresh MCP handshake/skill discovery; существующим процессам не обещается горячее появление инструмента. Откат возвращает предыдущую согласованную версию без миграции session state. Коммит, release и установка выполняются отдельным запрошенным шагом после проверки реализации.
