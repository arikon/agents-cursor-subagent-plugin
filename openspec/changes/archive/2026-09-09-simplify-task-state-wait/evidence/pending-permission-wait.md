# Оставшийся permission после answer

Дата наблюдения: 2026-09-09. Источник разбора — задача
[Оптимизировать флоу cursor-subagent](codex://threads/01a086fd-df86-7ec0-9d0d-f0edb8d255e2).
Первичная трасса — [Implement cursor model discovery](codex://threads/01a086c8-16c2-7630-b14b-7bf6ee4919e6).
Показатели и нижеуказанные поля повторно сверены с первичной трассой.

## Наблюдение

В одном session/turn последовательность была такой:

1. `cursor_answer_permission(request_id:"6", decision:"allow-once")` вернул
   `turn_status:"waiting_for_input"`, `last_event_id:28`.
2. Следующий `cursor_wait` получил `after_event_id:28`,
   `after_progress_revision:135`, `timeout_ms:60000`.
3. После ожидания timeout ответ содержал `wait_timeout:true`,
   `turn_status:"waiting_for_input"`, неизменный `last_event_id:28` и
   оставшийся permission `request_id:"7"`.

Итого: **answer request 6 → waiting_for_input → wait 60 s → request 7**.
Внешний интервал этого tool call по timestamps составил 63 574 мс
(1788970906881–1788970970455); он включает обслуживание вызова, поэтому
не равен чистому runtime wait. Настроенный timeout — 60 000 мс.
Новых событий для обнаружения уже существующего pending не требовалось.

Исходный замер всего взаимодействия: **30 MCP-вызовов, 14 waits,
34 606 байт JSON-текста ответов MCP** (UTF-8 первого text content каждого
ответа). Это объём ответов, не число токенов и не прогноз ускорения.

## Связь с существующим контрактом

Классификация — `implementation_concern`: SW-2 уже требует наблюдать текущее
состояние адресуемого turn. Два одновременно pending permissions, answer
первого и отсутствие новых событий конкретизируют task 2.2. Ожидаемый новый
wait возвращает второй pending с `wait_timeout:false` до истечения timeout.
Normative owner остаётся SW-2, test owner — существующий runtime suite.

В приёмке старый и новый wait сравниваются на одном scripted input и порядке
событий: существующий pending не ждёт timeout, caller не ведёт event/progress
cursors. Проверка использует контролируемую синхронизацию/время существующего
harness, а не live latency threshold. Объём ответов — дополнительное измерение;
никакой конкретный выигрыш по времени или байтам не обещан.

## Контролируемое сравнение реализации (2026-09-09)

Проверен настоящий baseline `b8a1e5c90cc6bc82362a7c174e42ff49e649e40d`,
материализованный через `git archive`, и текущий runtime. Исходник диагностики —
`compare-pending-wait.mjs`, полный machine-readable результат —
`controlled-pending-wait.json`. Это диагностический replay, не benchmark и не
новая зависимость deterministic suite от Git/history.

```sh
git archive b8a1e5c90cc6bc82362a7c174e42ff49e649e40d | tar -x -C <empty-baseline-root>
node openspec/changes/simplify-task-state-wait/evidence/compare-pending-wait.mjs <baseline-root> <current-root>
```

Оба runtime получают одинаковые две admitted permission callbacks, первый answer
и затем ни одного нового события. Callback transport подтверждён контролируемым
`sendConfirmed`; реальный fixture process удерживает prompt. Baseline получает
актуальный event cursor из answer boundary: wait остаётся незавершённым до явного
срабатывания управляемого таймера на 1000 ms и возвращает `wait_timeout:true`.
Candidate без cursor возвращает полный второй pending сразу в microtask queue,
не регистрирует таймер, clock advance равен 0, `wait_timeout:false`.
У обоих ровно один provider answer и ноль новых events после answer.
Команда завершилась exit 0; миллисекунды — контролируемое время, не live latency.

Постоянный regression owner — `tests/runtime-lifecycle.test.mjs`, сценарий
`remaining permission is immediately observable without another event or clock advance`.
Он запрещает регистрацию timeout и сравнивает полный retained permission context;
старое поведение не копируется в product или постоянный test harness.

## Границы

Не включаются пакетные/pre-authorized permissions, pending в ActionEnvelope
answer, устранение preview duplication при paging, единый agent ID, multi-wait,
steering, push delivery и выделение final из ACP-потока. Это отдельные contracts
или неподтверждённые внешние возможности. Model discovery сохраняется при
существующей baseline-reconciliation (task 1.1), без переноса его ownership в SW.
