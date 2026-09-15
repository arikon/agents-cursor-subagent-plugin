## Context

Мотивация — proposal.md. На исходном checkout `bounded()` в `scripts/cursor-subagent-mcp.mjs` добавляет искусственное многоточие, `waitEnvelope` возвращает эту проекцию, а `readResult` независимо строит точную страницу из полного текста. `skills/cursor-subagent/SKILL.md:132` начинает чтение с нуля. Текущий runtime и main specs, а не старые event arguments из исторической сессии, являются источником API.

Архивный `openspec/changes/archive/2026-09-09-add-cursor-model-discovery/evidence/cursor-verification.md` имеет 8 353 UTF-8 байта и SHA-256 `54c847eb7c47507f49cc997658038abed05206dbf4a4291cd5a93813243fb636`. Текущая preview-проекция этого текста — 7 999 байт, включая 3 байта многоточия. Это основание расчёта, не выполненный benchmark новой реализации. `simplify-task-state-wait` уже архивирован и не расширяется.

## Goals / Non-Goals

**Goals:** единая проекция страницы для первого и последующих reads, минимальный operator flow и проверяемая полнота без повторного чтения начала; общий предзапусковой порядок skill для mode, bounded context и exact text.

**Non-Goals:** scope exclusions перечислены в proposal; дополнительно не меняются состав accepted ACP agent-text stream, диагностический BoundedText, смысл receipt, хранение результата и process authority. Новый wire не обещает доставку отдельной provider final phase или долговечный артефакт. Skill не получает fixture literals, runtime schema или отдельный policy engine.

## v1 Contract Baseline

**Goal.** Доставлять точный результат через первую страницу terminal wait и только необходимые последующие reads, объединяя близкий к размеру страницы остаток; перед каждым prompt применять единый компактный preflight.

**Non-goals.** Границы Goals / Non-Goals и proposal; никакого one-shot delivery state, адаптивной operator policy, fixture-specific prose или копии runtime mechanics в skill.

**Public-invariant index.** `RP-1` → «Публичный MCP tool contract»; `RP-2` → «Полное чтение terminal result»; `RP-3` → «Нормативные limits runtime»; `RP-4` → «Адресуемое ожидание состояния сессии»; `RP-5` → «Skill workflow делегирования»; `RP-6` → «Eval transcript plumbing и process verdict»; `RP-7` → «Сценарный контракт поведения и authority-aware interaction».

**Owner map.** `cursor-acp-session-runtime` owns wire, paging и limits; RP-1–RP-4 уточняют существующие requirements, не вводят второго владельца lifecycle. `cursor-task-delegation` owns only composition RP-5, включая prompt preparation, без копирования page algorithm или runtime mechanics. `cursor-subagent-skill-evals` owns delivered-evidence proof и scenario projection RP-6/RP-7; package сохраняет installation/discovery и один minimal canary. AGENTS.md остаётся владельцем governance. Normative replacements привязаны к main через существующий semantic registry; они не ссылаются на runtime internals из верхнего spec.

**Implementation-ready exit.** Source/replacement digests соответствуют main/deltas; structural и mechanical semantic gates проходят; независимый critic не находит baseline_violation, architect подтверждает классификации и минимальность. Связь с compact проверена, архитектурных развилок нет. Реализация и её acceptance остаются открытыми tasks.

**Future-change candidates.** Миграция receipt на full digest, summary + artifact и настройка размеров страниц; только отдельные changes при самостоятельном сценарии. Повторные wait не оптимизируются через delivery state. Новые mode/prompt policies требуют самостоятельного operator scenario.

## Decisions

### Первая страница и короткий хвост

RP-1–RP-3 определяют wire и алгоритм. Реализация выделяет существующую UTF-8 нарезку из `readResult` в один маленький построитель над переданным terminal turn. Public read сохраняет свою admission/retention проверку; wait использует захваченную ссылку turn. Это защищает уже принятый wait от подмены или ошибочного отказа при немедленном следующем turn. Построитель не резолвит повторно session.last и не создаёт state/cache.

Номинальная и максимальная page bounds в RP-3 — фиксированные runtime constants, не параметры tools. Порог выбран по предложению пользователя: разрешить ограниченное увеличение страницы для исчезновения хвоста. Он не гарантирует отсутствие любого маленького хвоста за жёсткой границей.

| Вариант | Решение |
|---|---|
| Продолжать по длине preview | Отклонён: многоточие не принадлежит тексту, требуется специальная реконструкция |
| Preview и ResultPage вместе | Отклонён: два текста в одном ответе |
| Переиспользовать имя result для другой формы | Отклонён: маскирует несовместимость старого BoundedText consumer |
| result_page и existing read | Выбран: явно новый terminal output, один page contract |
| Всегда возвращать весь результат | Отклонён: теряется предсказуемая граница ответа |
| Summary + полный артефакт | Вне scope: нужен самостоятельный контракт summary, storage/access и completeness |

### Receipt сохраняет свою область хеширования

RP-1 сохраняет preview receipt, доступный также mutation acknowledgements, и существующую status-проекцию. Новый wait не передаёт preview. Полнота проверяется по RP-2, а не по receipt.result_truncated: результат между прежним preview bound и новой максимальной страницей уже может полностью поместиться в wait, хотя receipt описывает усечённый preview.

Миграция receipt на full hash расширила бы изменения на cancel/close/status и их независимые consumers. Выбранный вариант сохраняет смысл уже существующих доказательств. Eval сверяет receipt с independently observed bounded provider projection; page proof имеет отдельный полный digest. Operator skill не получает инструкцию вычислять preview, снимать многоточие или перепроверять receipt hash вручную.

### Минимальный skill и единый evidence path

Изменяется только ветка получения результата по RP-5. Численные bounds, копия ResultPage schema и тестовые механики в skill не переносятся. Missing result/недоступная страница сохраняют явное ограничение полноты; failed/timeout/authority recovery остаются прежними.

### Prompt preparation в skill

Повторяющиеся failures mode transition, resumed context, exact authorization и
verbatim report имеют одну причину: правила были разнесены по terminal и
follow-up веткам, поэтому модель пропускала их непосредственно перед prompt.
RP-5 переносит их в единый короткий preflight: вывести target mode из
семантики этапа, переключить live wrapper при необходимости, восстановить
minimal bounded context после resume, затем проверить exact text и authority
boundary. Для repeated critic review после resume сохраняется его полный
baseline; только неизменённый live critic conversation с тем же digest может
заменить baseline точной delta-ссылкой.

Это изменяет operator composition, а не runtime lifecycle. Существующие tool
names, recovery branches и result paging остаются у своих владельцев. Skill
не включает имена eval scenarios, fixture values или проверочную механику:
оператору нужны только действия перед prompt и material recovery boundary.

`scripts/recording-mcp-proxy.mjs` сегодня начинает accumulation только с read offset zero. Его existing proof расширяется на доставленную wait-page по RP-6. Withheld response остаётся loss evidence и не увеличивает delivered bytes. Повтор offset zero начинает проверку новой последовательности; пропуски, конфликтующие metadata и несовпадение IDs/digest не превращаются в complete. Финальный digest доказывается по фактически доставленному тексту, а не только совпадению объявленных metadata.

Compact recorder сохраняет page metadata плюс text byte count/digest, без raw текста. `scripts/cursor-eval-scenario.mjs` и `tests/codex-client-oracle-support.mjs` адаптируют existing loss/result observers; full proof и receipt proof остаются разными. Существующий overflow scenario сохраняет отсутствие successful result-read. При переходе на новый terminal output проверяются все прямые consumers result, а не только long-result scenario. Изменения dependency inventory принадлежат существующему EVALUATOR_INPUTS; новый evidence registry не нужен.

Implementation concern из независимого review: `tests/fixtures/fake-acp.mjs:134` сейчас записывает только full-result digest, а старый observer использует preview из response. При удалении этого текста existing provider evidence дополняется отдельным preview digest/truncation по фактически отправленному accepted agent-text stream (включая progress). Это единственный test evidence owner ожидаемой preview-проекции; full digest не переименовывается и не используется вместо preview digest. Проверяются короткий и truncated случаи; новый product API ради oracle не вводится.

### Связь с compact-cursor-subagent-skill

На 2026-09-10 прочитаны proposal/design/tasks/review из worktree `/Users/arikon/.codex/worktrees/8be5/codex-cursor-subagent-plugin/openspec/changes/compact-cursor-subagent-skill`. Это reviewed planning без реализации; skill и main specs в обоих worktrees совпадали. Compact proposal исключает runtime/wire/result delivery, design предусматривает последующую интеграцию в точке полного результата перед verification/new turn/close. Это свидетельство текущего состояния, перед apply оно проверяется заново.

| Пересечение | Интеграция |
|---|---|
| skills/cursor-subagent/SKILL.md | После compact targeted hunk ветки результата; сохранить его authority/recovery/disclosure |
| tests/codex-client-integration.test.mjs | Сохранить compact request measurement и добавить/обновить только delivery observations |
| scripts/cursor-skill-eval.mjs | Объединить изменения единственного EVALUATOR_INPUTS, сохранить все transitive inputs |
| scripts/openspec-semantic-registry.mjs | Сохранить обе registrations; не копировать registry целиком из другой ветки |
| Runtime/main specs | Их изменения принадлежат delivery; compact остаётся редакторским change |

Предпочтительно сначала завершить compact A/B и acceptance на одном wire, затем интегрировать delivery в принятый skill. Hard prerequisite или sourceChange на compact не вводится: он не изменяет нормативный source block. Если delivery идёт первым, последующее compact сравнение начинается заново на одном новом runtime/wire для baseline и candidate; reference к актуальному result contract пересматривается перед его реализацией. Сравнение старого wire baseline с новым candidate не доказывает редакторское сокращение.

Экономия skill-body context (цель compact) и экономия result payload/calls (цель delivery) учитываются отдельно. Baselines привязаны к своим skill/runtime/evaluator digests и не подтверждают другую комбинацию. Финальная согласованная комбинация получает собственное acceptance; старые artifacts сохраняются. Чужой worktree этим proposal не изменяется.

### Измерение и test owners

Ниже расчёт исходного и предлагаемого числа terminal wait + result reads, без pending waits, JSON overhead и provider turns. ASCII строки используются там, где размер явно обозначен как ASCII; UTF-8 фактические границы проверяются отдельно.

| Сценарий | Текст сейчас → candidate, bytes | Calls сейчас → candidate |
|---|---:|---:|
| Пустой/короткий до preview bound | Без сокращения текста | 1 → 1 |
| Архивный 8 353 bytes | 16 352 → 8 353 | 3 → 1 |
| ASCII 16 353 bytes | 24 353 → 16 353 | 4 → 2 |
| ASCII 18 000 bytes | 26 000 → 18 000 | 4 → 2 |
| ASCII 18 001 bytes | 26 001 → 18 001 | 4 → 3 |

Acceptance измеряет обе версии на одних fixtures и одинаковом порядке действий, отдельно исключая intentional lost-response replay из обычного no-duplication сценария. Сохраняются environment/runtime version, выбранные scenarios, executed/skipped, concurrency, bytes текста и сериализованных MCP responses, call counts и digests. Три завершённых одинаковых прогона baseline и candidate проверяют стабильность; latency/token claims без соответствующего измерения не делаются. Новый tokenizer или общий benchmark framework не нужен.

| Test owner | Проверка |
|---|---|
| tests/runtime-callbacks-results.test.mjs | Страницы, empty/null, UTF-8, границы nominal/max, overflow, retention, без side effects |
| tests/runtime-lifecycle.test.mjs | Повтор/parallel wait, pinned turn race, неизменный receipt |
| tests/mcp-transport.test.mjs | Один transport scenario первой страницы и read, closed terminal envelope |
| tests/cursor-skill-eval.test.mjs | Recorder completeness, фактические bytes, gaps/replays/withheld/metadata corruption |
| tests/codex-client-oracle-component.test.mjs и tests/cursor-skill-eval-component.test.mjs | Existing full-result/loss proof и domain separation; без копии page boundary matrix |
| tests/codex-client-integration.test.mjs | Реальная composition evidence из installed client, включая long tail marker |
| tests/release-e2e.test.mjs | Минимальный installed payload canary: coalesced result и единый runtime/skill generation |

## Risks / Trade-offs

- Mixed old skill/new runtime → breaking release, согласованная установка и перезапуск; без dual output/legacy mode.
- Receipt больше не хеширует видимый wait text → RP-1 явно разделяет digest domains; consumers и loss oracle проверяются отдельно.
- Максимальная страница больше derived-text bound → это отдельный result-page limit, не повышение всех diagnostics/pending bounds.
- Общий helper повторно разрешает retained ID → использовать захваченный turn для admitted wait; новые public reads сохраняют старые errors.
- Последний retained turn заменён между страницами → обычное ограничение полноты, без pinning API, таймерного продления или нового хранения.
- Compact merge возвращает offset-zero workflow → связанный review обеих веток и acceptance конечной пары.

## Migration Plan

Перед apply проверить main/source digests и актуальный статус compact; при drift минимально rebase deltas и повторить gates/review. В этом proposal main specs не sync-ятся, archived artifacts не редактируются.

Реализацию runtime, skill и всех consumers подготовить одной совместимой версией. Перед установкой завершить старые делегирования и закрыть старый MCP process; после установки загрузить tools/skill в чистой задаче. Замена файлов сама по себе не перезапускает MCP. Откат возвращает прежнюю согласованную пару тем же close/restart путём; persistent migration отсутствует.

Structural/semantic validation относится к плану. Foreground deterministic/coverage, package и admitted model-behavior acceptance выполняются при реализации по AGENTS.md; historical baseline не подменяет итоговую проверку новой комбинации. Архивирование и публикация — отдельные действия.
