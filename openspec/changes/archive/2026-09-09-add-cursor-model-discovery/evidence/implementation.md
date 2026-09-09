# Проверка реализации

**Финальная приёмка после verify repairs: READY TO ARCHIVE.** Находки V1–V4
закрыты; evaluator dependency inventory дополнен и проверен mutation tests.
Итоговые commands, artifacts, reviewer verdicts и ограничения находятся в
`verification.md`, раздел `Final assessment`. Финальный coverage: 766 pass,
1 skip; release: 15 pass, 1 skip; deterministic eval: 28 pass, 2 skips.
Все команды завершились exit 0. Полный residual audit последнего snapshot:
101 counter, 0 неклассифицированных, новых meaningful gaps нет.

## Исходный baseline — 2026-09-09

Независимая read-only проверка: source digests MD-2–MD-5 совпадают с main;
пересечение с active `simplify-task-state-wait` не требует rebase.
`node scripts/check-openspec-semantics.mjs`: exit 0, PASS, 14 changes.
`OPENSPEC_TELEMETRY=0 openspec validate add-cursor-model-discovery --strict`:
exit 0, valid. `baseline_violation` не обнаружены.

Task 4.3 уточнена как `implementation_concern`: MD-6 отвергает неизвестный ID
до allocation, поэтому live canary проверяет preflight error; исходный startup
stderr остаётся обязанностью deterministic runtime/package fixtures.
Canary использует изолированный установленный payload; managed installation
и release остаются отдельным шагом. Нормативный baseline не изменён.

## Согласованное исправление auth

Позднее пользователь явно включил исправление повторного browser-login и
удаления выбранного auth file. Baseline дополнен MD-7/MD-8; primary evidence
и согласованная конструкция записаны в `noninteractive-auth.md`.
Инициатор двух неуспешных запусков найден в указанной пользователем задаче
«Ускорить проверки на hil-stand»: два cursor_delegate завершились init_timeout
в 15:40:25 и 15:41:51 UTC без provider session/turn. Первоначальная гипотеза
о тестовой гонке как причине browser events не подтвердилась.

## Независимое review

Все найденные дефекты исправлены минимально:

| Классификация | Находка | Исправление |
|---|---|---|
| baseline_violation | Allocation после shutdown во время preflight | Повторная проверка closed до allocation |
| baseline_violation | optimize_for:null принимался как omission | Проверка явно переданного поля |
| external_adapter_drift | thinking имеет category thought_level | Подтверждённый mapping и отдельный golden |
| baseline_violation | Отсутствовала сохранённая MD-5 инструкция outcome marker | Одна строка skill |
| baseline_violation | Falsy invalid apiKey принимался как отсутствие поля | Общая проверка hasOwn |
| baseline_violation | NUL в ключе раскрывался в ошибке spawn | Проверка представимости ключа до env/HTTP |

Reviewer: APPROVE для MD-1–MD-6 и затем MD-7/MD-8, открытых blockers нет.
Architect: CLEAR; все классификации, минимальность исправлений и отсутствие
дублирования владельцев подтверждены независимым чтением кода и baseline.
Installed skill semantic audit: byte-identical repo snapshot, все MD-5
сценарии согласованы, auth-механизм в skill не продублирован. Это не
model-behavior eval. Существующий eval corpus/grammar не расширялся.

## Live acceptance

Изолированный установленный payload с настоящим Cursor выполнил discovery,
отверг неизвестный ID до allocation и создал default ask session без prompt.
Сессия и транспорт закрыты. Auth file содержал только apiKey и остался
побайтово неизменным. Ключ, его hash и содержимое файла не публиковались.

Команда: `CURSOR_MODEL_DISCOVERY_LIVE=1 CURSOR_MODEL_DISCOVERY_AGENT=/Users/arikon/.local/bin/cursor-agent NODE_NO_WARNINGS=1 node scripts/run-node-tests.mjs release --test tests/release-e2e.test.mjs --test-name-pattern 'installed live model discovery canary'`.
Supervisor: exit 0, 1/1 PASS, 16 984 ms.
Artifact: `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T15-55-53-143Z-release-231a7f66-7bbf-4a10-a05b-a30c16bca7c9/result.json`.

Границы этого canary: пользовательская installation не обновлялась; live canary
не выполнял prompt, review или реальный persisted resume. Persisted resume
с изменённой стратегией проверен deterministic fixture; успешный new не
объявляется evidence реального provider load. Другие процессы Cursor могут
изменять общий auth file независимо от этого runtime.

## Итоговые проверки

Полный foreground coverage: exit 0, 762 passed, 1 skipped, 0 failed;
lines 99.91%, branches 98.20%, functions 99.89%. Все 17 source digests
стабильны. Полный аудит 101 residual counter и их существующих behavioral
test owners находится в `coverage-initial-audit.md`; новых meaningful gaps нет.
Artifact: `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T15-57-09-347Z-coverage-c1cb839d-7f64-404e-a270-c85e184ace6a/result.json`.

После изоляции auth file в fixture subprocess повторно проверены runtime и
MCP transport: exit 0, 188/188 PASS. Artifact:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T16-06-52-237Z-unit-ac4c9e96-1969-40e1-8a32-430235386d6c/result.json`.
Отдельный release: exit 0, 15 passed, 1 opt-in live skip. Artifact:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T16-07-14-455Z-release-d3d245c9-d0c9-4a09-b167-c6df465dadd0/result.json`.

Deterministic eval после окончательной изоляции MCP fixtures: exit 0,
27 passed, 2 opt-in skipped, 0 failed. Artifact:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T16-08-50-219Z-eval-bb2b274f-a7d4-4ddc-942c-2bbb4acc2298/result.json`.
Strict и mechanical semantic gates повторно PASS; syntax и diff checks PASS.
Предшествующая незакоммиченная работа simplify-task-state-wait сохранена;
sync/archive и публикация release не выполнялись.

## Локальная установка исправления

По уточнению пользователя о повторном удалении auth file старая GitHub
регистрация marketplace заменена CLI-командами на текущий локальный checkout.
Установлена версия `0.1.0+codex.20260909160555`; это локальная dev installation,
не публикация GitHub release. Runtime, model adapter и SKILL.md в новом кэше
побайтово совпадают с проверенным checkout. Прямой MCP tools/list из нового
кэша завершился exit 0 и содержит cursor_list_models.

Семь idle MCP-процессов старого кэша остановлены SIGTERM после проверки cwd
и отсутствия дочерних процессов. Давно запущенные отдельные CLI и их сессии
не останавливались. Наличие auth.json подтверждено без чтения/публикации ключа.
Обновление MCP surface внутри ранее открытой задачи не подтверждено:
новая задача является границей загрузки обновлённых tools/skill.
