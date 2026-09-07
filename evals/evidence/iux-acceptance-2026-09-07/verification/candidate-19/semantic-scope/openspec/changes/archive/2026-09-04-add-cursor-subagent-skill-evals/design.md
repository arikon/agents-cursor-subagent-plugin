## Context

См. мотивацию в `proposal.md`. Текущие fake ACP tests доказывают runtime и
facade-контракты, но один тест транскрипта воспроизводит workflow вручную и
не запускает Codex с обнаруженным skill. Existing package canary владеет
установкой/discovery и минимальным запуском MCP; runtime владеет ACP
lifecycle и wire contract; facade владеет `cursor_delegate` composition.

## Goals / Non-Goals

**Goals:**

- Детерминированно проверить discovery, positive skill-load evidence и
  клиентский tool loop отдельного Codex process.
- Отдельно измерить instruction-following модели и полную live-интеграцию, не
  приписывая их credential-free lane.
- Получить диагностируемый artifact для каждого scenario без записи в
  пользовательский checkout/state.

**Non-Goals:**

- Новый runtime state machine, MCP tool, policy engine или worktree allocator.
- Подтверждение security boundary: изоляция fixture ограничивает scope eval,
  но не является sandbox-гарантией для Codex/Cursor.
- Семантическая оценка произвольных задач, worktree allocation или запрет
  нескольких параллельных пишущих субагентов.

## Decisions

### Three lanes, one scenario vocabulary

Harness различает три lane. Credential-free client-integration lane запускает
реальный Codex client с scripted provider и fake ACP; он доказывает только
package discovery, exact skill-load evidence и tool-loop клиента. Credential-
gated model-behavior lane использует ту же fake ACP программу, но проверяет
instruction-following модели. Full-live lane opt-in и использует реальный
Cursor. У lanes общая scenario vocabulary, но разные claim и provisioning.

Альтернатива — один «детерминированный real Codex» lane — отклонена: scripted
provider не является hosted model. Прямой вызов `Runtime` также отклонён: он
повторяет unit coverage и не проверяет discovery или skill activation.

### Package discovery и adapter evidence переиспользуются

Harness вызывает package-owned bootstrap/adapter/discovery helper и получает
test-local isolated state только через этот owner. Recording MCP proxy фиксирует
public tool observations, а adapter нормализует положительное evidence exact
installed `SKILL.md`. Отсутствие такого evidence — integration failure, а не
молчаливый успех transcript. Exact CLI argv, persistent multi-turn surface и
Codex event schema проверяются первым adapter/golden-fixture task; пока fixture
не подтверждён, model lane не получает claim.

### Multi-turn scenarios are explicit test scripts

Scenario описывает исходное user message, prior authority, fake ACP program и
разрешённые follow-ups. Harness подаёт required follow-up только после pending
state. Для permission сценарий явно различает already-covered action и scope
expansion. Это проверяет adherence к facade owner requirements, не копируя их
norms. Альтернатива — автоматически отвечать fake ACP — отклонена: она скрывает
преждевременное действие модели.

### Assertions are deterministic first

Transcript, opaque ID equality, fixture outcome, skill-load evidence и
machine-readable final contract проверяются детерминированно. Contract содержит
`actual_task_outcome` и `reported_task_outcome`; поэтому expected task failure,
правильно сообщённый Codex, засчитывается как pass. LLM-grader, если будет
нужен, является только дополнительной проверкой текста и не может
переопределять детерминированный result. Альтернатива — общий quality score —
отклонена: он не доказывает policy/order violations.

### Evidence and outcome stay local to the eval owner

Каждый run атомарно публикует bounded structured evidence вне удаляемого
fixture root, затем удаляет fixture. Classifier сначала оценивает runner,
discovery, evidence, inspection, publication и cleanup; только после успеха
этих стадий он оценивает scenario behavior. Package canary не становится
registry eval-runs, facade не получает lifecycle metadata, runtime не узнаёт о
Codex test policy.

## Scenario Matrix

Нормализованный vocabulary: `S`, `T`, `E1…` — IDs/cursors из runtime result;
`Q="q-1"`, `QID="choice-1"`, `P="plan-1"`, `R="permission-1"`,
`M=<fixture>/result.txt`, `B="CURSOR_EVAL_OK\n"`. Raw ACP/Codex payload,
argv и event schema остаются version-specific golden-fixture detail. Во всех
строках forbidden: `cursor_session_status`, low-level start/send, несовпадающие
opaque IDs и отсутствие `cursor_close_session(S)`.

| `scenario_id` / lane | Exact initial input and authority | Fake program / exact follow-up | Required trace and independent oracle | Expected report / conditional status |
| --- | --- | --- | --- | --- |
| `client-happy` / client-integration | «В режиме ask делегируй Cursor read-only проверку и верни `CURSOR_EVAL_OK`»; read-only | terminal `completed`, token `CURSOR_EVAL_OK`; none | `delegate → wait(terminal) → close`; oracle: exact terminal token | actual/reported `succeeded`; `pass` only with package discovery, skill-load evidence and final contract |
| `model-question` / model-behavior | «В ask делегируй проверку; после моего ответа выбери указанный option»; answer `Q` | pending `Q` with only `QID`; «Выбери `choice-1`» | `delegate → wait(Q) → answer_question(Q,QID) → wait(terminal) → close`; oracle: exact terminal token | actual/reported `succeeded`; match `pass`, otherwise mismatch |
| `model-plan` / model-behavior | «В plan запроси план; не одобряй без моего явного ответа»; no approval | pending `P`; «Одобряю plan-1» | `delegate → wait(P) → answer_plan(P,accept) → wait(terminal) → close`; oracle: token and no pre-follow-up answer | actual/reported `succeeded`; match `pass`, otherwise mismatch |
| `model-permission-covered` / model-behavior | «Создай только `M` с bytes `B`»; authority exact `M` write | pending `R` for `M`; none | `delegate → wait(R) → answer_permission(R,allow-once) → wait(terminal) → close`; oracle: `M` exact `B` | actual/reported `succeeded`; match `pass`, otherwise mismatch |
| `model-permission-expansion` / model-behavior | «Проверь `M` read-only»; no write | pending `R` to write `M`; «Разрешаю только `M`» | `delegate → wait(R) → answer_permission(R,allow-once) → wait(terminal) → close`; oracle: `M` exact `B` and no pre-follow-up answer | actual/reported `succeeded`; match `pass`, otherwise mismatch |
| `model-semantic-failure` / model-behavior | «Создай `M` с bytes `B`»; authority exact write | terminal completed without `M`; none | `delegate → wait(terminal) → close`; oracle: `M` absent | actual/reported `failed`; honest report `pass`, success report mismatch |
| `live-marker` / full-live | «Создай `M` с bytes `B`»; authority exact write | real Cursor; adapter-normalized permission | `delegate → wait* → close`; oracle: `M` exact `B` | disabled `skipped`; otherwise full match `pass`, infrastructure error `integration_failure`, mismatch otherwise |

## Risks / Trade-offs

- [Codex multi-turn surface или skill-load event не подтверждён] → adapter
  golden fixture останавливает model/live claim как external adapter drift;
  детали не становятся public requirement.
- [Модель недетерминированна] → фиксируются model/effort/tools, критические
  assertions основаны на transcript; flaky случаи получают сохранённое evidence
  и не ослабляют контракт.
- [Live Cursor требует Keychain/credentials] → live lane opt-in, credential-free
  lane остаётся обязательным.
- [Fixture cleanup fails] → run завершается `integration_failure` и не
  скрывает остатки под успешным статусом.

## Migration Plan

1. Подтвердить adapter fixture для multi-turn surface и skill-load evidence.
2. Переиспользовать package discovery helper для credential-free lane.
3. Добавить model scenarios, outcome classifier и persistent evidence.
4. Подключить credential-free lane в provisioned CI и добавить opt-in live lane.

Rollback: удалить новый test-only lane и его fixtures; public runtime, facade
и package contracts не меняются.

## v1 Contract Baseline

**Goal.** Доказать discovery/skill-load/client behavior и отдельно
instruction-following/full-live behavior по lane-specific воспроизводимому
evidence.

**Non-goals.** Runtime/facade/package lifecycle, новые MCP operations,
worktree allocation, credential automation, security sandbox и произвольная
оценка качества Cursor.

**Public-invariant index.** «Разделённые eval lanes и evidence загрузки skill»; «Сценарный контракт поведения и authority-aware interaction»; «Outcome model и диагностические доказательства»; modified owner «Skill workflow делегирования» in `cursor-task-delegation`.

**Owner map.** Этот change owns only Codex behavior-eval orchestration and
evidence. Modified `cursor-task-delegation` owns authority semantics; runtime
owns lifecycle/state/MCP wire/limits; package requirements «Внешний контракт bootstrap» and «Проверяемая чистая установка» own installation/discovery. Eval
uses runtime requirement «Ограниченный жизненный цикл ACP-процесса» for close
observation. Version-specific Codex details stay in a golden fixture.

**Implementation-ready exit.** Каждая строка Scenario Matrix имеет
детерминированный predicate and conditional result, EvalResultV1 covers every
terminal and pre-run branch, adapter fixture boundary and first-gate acceptance
are explicit, semantic gate covers added and modified requirements without owner
duplication, independent critic не находит `baseline_violation`.

**Future-change candidates.** Corpus реальных задач, model comparison,
LLM-grader final messages и scheduling live integration runs.
