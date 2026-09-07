## 1. Runtime owners

- [x] 1.1 Реализовать один `SessionRecord` и transition/terminalization path по requirements «Единая машина состояний runtime», «Ограниченный жизненный цикл ACP-процесса», «Изолированное состояние ходов и событий» и «Нормативные limits runtime»; покрыть каждую строку transition table, late init/result, retention и eviction.
- [x] 1.2 Реализовать allocation boundary по requirement «Response envelopes и фаза allocation» и tools, typed envelopes и normalized evidence по requirement «Публичный MCP tool contract»; fake ACP проверяет все schema/error branches.
- [x] 1.3 Реализовать ID-addressed prompt/answer/cancel и filtered wait по requirements «Turn operations и permission options» и «Адресуемое ожидание состояния сессии»; проверить retained T1 при active T2.

## 2. Scope, callbacks и диагностика

- [x] 2.1 Реализовать scope guard по requirement «Проверка scope рабочего каталога»; проверить roots, realpath и отсутствие spawn при rejection.
- [x] 2.2 Реализовать admitted version-specific Cursor adapter fixtures и normalized callbacks по requirement «Режимы Cursor и ACP callbacks»; проверить plan read, agent write, fixture-local plan encoding, permission/question/plan normalization и cancellation settlement без проекции успеха.
- [x] 2.3 Реализовать bounded interactive context по requirement «Ограниченный контекст интерактивных запросов»; проверить aggregate frame/context caps и UTF-8 truncation boundaries.

## 3. Проверка

- [x] 3.1 Создать fake ACP executable и table-driven lifecycle/schema tests, включая invariant: accepted ACP request ровно один раз сохранён и settled, либо немедленно rejected; terminalization закрывает admission, settles pending, затем cancel → grace → kill.
- [x] 3.2 Запустить `node --test tests/*.test.mjs` и fake-ACP набор; credential-gated live E2E остаётся owner-ом package change.
