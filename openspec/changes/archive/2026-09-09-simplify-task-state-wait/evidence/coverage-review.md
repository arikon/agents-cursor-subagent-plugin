# Raw coverage review — repair candidate

Исходная очередь: последний `test:coverage` из неуспешного запуска
`2026-09-09T21-03-28-065Z-coverage-22b8c35d-b3b6-4246-949d-1550e03f105f`.
Этот запуск не является pass: bootstrap readiness и file timeout завершились
ошибками. После repairs требуется полный успешный запуск и сверка новой очереди.
Номера ниже относятся к исходному снимку, а не к будущим смещениям строк.

## Runtime: классификация независимого reviewer

| Точки в `scripts/cursor-subagent-mcp.mjs` | Классификация | Владелец минимального repair |
| --- | --- | --- |
| 127 | meaningful contract: null external session/load response | lifecycle admission |
| 130,138,140,142,143,149,159,162,163,165,174,180,182 | realistic malformed provider input | existing collaboration adapter value matrix |
| 183,186 | meaningful image projection: empty and description-only forms | collaboration adapter |
| 217,221,224,238,239 | realistic invalid pending request | interaction normalization |
| 229 | meaningful empty optional plan body | interaction normalization |
| 340,342 | realistic successful await completion after shutdown | admission lifecycle |
| 364 | realistic late stderr | admission diagnostics |
| 453,457,467,471,616,633,634 | realistic pipe failure and answer/close races | transport and interaction |
| 539,543 | meaningful idless/idle callback handling | lifecycle callbacks |
| 708 | realistic invalid auth JSON root | model discovery |
| 782,794 | meaningful already-shutdown admission | model discovery/admission |
| 779 | meaningful equal-timestamp retention ordering | callback/result capacity |
| 29,168 | dead redundant fallback | removed; normalized callers/admitted type already establish the value |
| 86,88 | unreachable defensive | same immutable adapter args already validated by version admission |
| 101 | unreachable in admitted installed package | package owns manifest integrity; no runtime mutation fixture |
| 271 | unreachable defensive | receipt exists synchronously before terminal projection |
| 294 | unreachable repeated state transition | existing lifecycle serialization and idempotent close |
| 550 | unreachable catch for decoded plain JSON | explicit malformed-value admission returns null; no throwing-object fixture |
| 576 | unreachable due to ACP frame cap | existing narrow exclusion and no-mutation transport test |
| 629 | unreachable second pending lookup miss | public lookup and record lookup have no intervening await |
| 654 | unreachable status alternative after active identity match | terminalization clears active synchronously; late result is tested at earlier boundary |
| 621 | unreachable pending alternative | onResult rejects pending before completion |
| 460 | unreachable synchronous Writable throw | actual pipe error is callback/error event, whose realistic path needs coverage |
| 761–764 | split classification required | reader cancellation rejection is realistic; changed controller identity is unreachable until finally releases slot |
| 578 | realistic filesystem failure | existing filesystem-errors owner: real deletion between validation/read, ENOENT normalized to protocol_error, no result content, healthy turn |

Defensive classifications do not justify excluding whole regions or suppressing
coverage counters. No coverage directives were added for these runtime points.
Runtime behavioral repairs закрыты существующими lifecycle, interaction,
admission, model-discovery и capacity owners. Искусственные synchronous-write
throw cases удалены: retained реальные closed-pipe, async EPIPE и cancellation
проверки не заменяются monkeypatch исключением.

Точная V8-проверка `discoverModels` установила, что zero counter на 761 —
единственный пробел между `catch` и `finally` (offsets 50189–50190), а не
ветка отмены. `finally` выполнен 108 раз; reader cancellation/release проверены.
Evidence: `/private/tmp/state-wait-v8.lYWdXr/coverage-23350-1788988823729-0.json`.
V8-проверка 224 отдельно обнаружила duplicate-option throw; соответствующий
malformed-input case добавлен в существующую interaction матрицу.

## Остальные owners

| Owner / исходные точки | Классификация и результат |
| --- | --- |
| scenario 243,246,811,814 | meaningful timeout/recovery input: existing component mutations и later-turn recovery |
| scenario 445,456,760 | redundant guards после полного admission: удалены |
| scenario exactArgumentProjection | missing request достижим для malformed set_mode record: fail-closed guard сохранён, regression без throw |
| proxy malformed handshake/result и backpressure | realistic capture/pipe paths: existing proxy tests расширены |
| proxy repeated failure/stop и late I/O | realistic shutdown races: controlled readiness, no leaked output/calls, atomic publication и target cleanup |
| audit 48,96 | realistic malformed digest: расширена existing descriptor matrix |
| audit 58,152,238 | defensive: closed identity, count+membership+uniqueness, comparator уникальных ключей |
| audit 426,429 | defensive при стабильных входных файлах: validated leaf paths; не security guarantee против concurrent mutation |
| audit 370 | dead fallback дочернего artifact path: удалён |
| semantic 627 | существующий entrypoint instrumentation residual; отдельный foreground semantic gate |
| app-server 152,162,191 | meaningful deadline between pages/polls: controlled clock tests, slow-request assertions сохранены |
| bootstrap 24,391,405,421,501,677 | defensive: normalized errors, validated topology, существующий journal и parser errors |
| bootstrap 441,450 | meaningful optional adapter message: existing preflight test проверяет normalized fallback |
| finalizer 158,159 | dead fallback после validated nonempty artifact root: удалён |
| matrix 141–146 | defensive revalidation после admitted result и controlled transformations; искусственный internal-invalid result не добавляется |
| matrix 192 | defensive empty-results alternative: corpus непустой, interrupted run не публикует aggregate |
| matrix 73,158,176 | distinct early/active interruption boundaries: no spawn после early cancellation и reaped active child |
| matrix 234–235 | realistic unsupported artifact symlink: refusal without aggregate |
| matrix 24 / runner 164 | meaningful default composition; принадлежит отдельным foreground CLI acceptance, не injected unit runner |

Полный finalizer historical/reference и malformed-evidence behavior уже имел
владельца `eval-closeout.test.mjs`; нули неуспешного исходного coverage были
следствием file timeout. Отдельный успешный запуск и следующие полные coverage
подтвердили это; дублирующие тесты не добавлены.

Итоговый raw artifact и terminal verdict указываются в `../validation.md`.

## Финальная очередь

Завершённый coverage `2026-09-09T21-32-57-145Z-coverage-2d26bae0-ac0d-4a5a-9525-de0370cb4613`:
798/798 pass; zero counters сверены со всеми классификациями выше.

| Файл | Остаточные zero branch lines |
| --- | --- |
| audit-node-coverage | 58,152,238,426,429 |
| check-openspec-semantics | 627 |
| cursor-subagent-bootstrap | 24,391,405,501,677 (два counters) |
| cursor-subagent-mcp | 86,88,101,271,294,460,550,576,621,629,654,761 |
| run-cursor-skill-eval-matrix | 24,141,192; также defensive zero lines 142–146 |
| run-cursor-skill-eval | 164 |

Итого 28 branch counters, 5 lines, 0 functions; **unclassified = 0**.
Реальные filesystem, option-duplication, shutdown, deadline и proxy race gaps
отсутствуют в финальной очереди. Default composition points matrix24/runner164
проверены отдельными real-Codex/hosted CLI acceptance; остальные строки таблицы
имеют приведённые выше defensive/instrumentation объяснения.
