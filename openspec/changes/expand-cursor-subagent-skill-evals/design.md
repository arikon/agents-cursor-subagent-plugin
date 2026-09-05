## Context

См. `proposal.md`. Capability уже различает client-integration,
model-behavior и full-live lanes, публикует bounded `EvalResultV1` и использует
package-owned bootstrap. Семантика семи сценариев распределена между runner,
integration tests и fake ACP fixture. Свежий foreground unit baseline завершён
с `PASS` за 137875 мс; добавляемый слой поэтому ограничивается структурно, а не
нестабильным wall-clock SLO.

Из `ai/artifacts/skills` берутся declarative cases, strict admission,
детерминированный program driver, независимый oracle и immutable provenance.
Универсальный eval DSL, tiers, новые cases, comparison и `pass@k` в v1 не
переносятся.

## Goals / Non-Goals

**Goals:**

- Мигрировать ровно семь текущих scenarios в один закрытый JSON corpus без
  изменения наблюдаемых outcomes.
- Разделить ACP stimuli/effect recording и чистое сравнение observations.
- Связать evidence с exact scenario payload и реально выбранными harness inputs.
- Проверить семь rows одним table pass без process-per-scenario.

**Non-Goals:**

- Новые scenario IDs, tier policy, comparison или `pass@k`.
- Изменение `EvalResultV1`, runtime/facade/package contracts либо supervisor
  `result.json`, lane registry и process lifecycle.
- Копия ACP lifecycle/public-ID validator, permission policy или sandbox.
- Включение real-Codex, hosted-model либо full-live execution в unit coverage.

## Decisions

### Exact-seven corpus является data SSOT

`evals/cursor-subagent-scenarios.v1.json` хранит шесть closed `programmed`
definitions и один closed `package-canary-reference` для `live-marker`.
`owner_requirements` содержит `{capability, requirement}` и ссылается на main
specs; semantic gate проверяет эти ссылки у нормативного owner. Reference row
содержит только ID/lane/package owner/enabled result и не копирует canary input,
authority, program, trace, marker predicate или lifecycle. Runtime loader
проверяет только schema, bounds и uniqueness. Structured paths всегда literal
POSIX workspace-relative; `${RESULT_FILE}` разрешён только в programmed input
text. Новому ID нужен отдельный approved delta allowlist.

Полный пример shape из мигрируемого `model-question`:

```json
{
  "scenario_kind": "programmed",
  "scenario_id": "model-question",
  "lane": "model-behavior",
  "owner_requirements": [
    {
      "capability": "cursor-task-delegation",
      "requirement": "Skill workflow делегирования"
    },
    {
      "capability": "cursor-acp-session-runtime",
      "requirement": "Ограниченный жизненный цикл ACP-процесса"
    }
  ],
  "initial_input": "В ask делегируй проверку; после моего ответа выбери указанный option",
  "prior_authority": { "kind": "none" },
  "program": {
    "kind": "fake-acp",
    "steps": [
      {
        "type": "pending",
        "request_kind": "question",
        "step_id": "question-1",
        "callback_id": "q-1",
        "question_id": "q",
        "prompt": "Continue?",
        "options": [
          { "id": "choice-1", "label": "Yes" }
        ],
        "expected_callback": { "kind": "answer", "option_ids": ["choice-1"] }
      },
      {
        "type": "terminal",
        "step_id": "terminal-1",
        "turn_status": "completed",
        "result_text": "CURSOR_EVAL_OK"
      }
    ]
  },
  "followups": [
    { "after_pending_step": "question-1", "input": "Выбери choice-1" }
  ],
  "expected_trace": [
    { "kind": "session.allocated" },
    { "kind": "turn.started" },
    { "kind": "pending.question", "step_id": "question-1" },
    { "kind": "answer.question", "step_id": "question-1", "option_ids": ["choice-1"] },
    { "kind": "turn.completed", "step_id": "terminal-1" },
    { "kind": "session.close-attempted" }
  ],
  "forbidden_observations": ["answer-before-pending", "id-mismatch"],
  "fixture_predicate": { "kind": "terminal-token", "token": "CURSOR_EVAL_OK" },
  "expected_actual_task_outcome": "succeeded",
  "expected_reported_task_outcome": "succeeded",
  "expected_enabled_eval_status": "pass"
}
```

### Driver выдаёт stimuli, oracle сравнивает observations

Один новый `scripts/cursor-eval-scenario.mjs` владеет admission,
materialization и pure oracle. Existing `tests/fixtures/fake-acp.mjs` исполняет
materialized program только в explicit opt-in mode; без него legacy
`FAKE_ACP_*` fault matrix остаётся неизменной. В program mode fixture выдаёт
pending/terminal stimuli; для effect-write выдаёт
ACP request с bounded callback ID, ждёт matching success и только затем пишет
effect record. `scripts/recording-mcp-proxy.mjs` остаётся владельцем normalized MCP
recording. Driver не отвергает public calls и не принимает authority decisions.

Oracle получает scenario, MCP trace, callbacks/effects и reported outcome. Он
классифицирует order/ID/effect/close mismatch; runtime сохраняет фактическое
отклонение invalid public ID/order. `completed` означает protocol termination,
а semantic success определяется отдельными expected outcomes/predicate.

### Outer materializes exact payload и публикует manifest

Для programmed row outer runner создаёт `<fixture>/workspace`. Только если input
содержит `${RESULT_FILE}`, predicate обязан иметь path, из которого вычисляется
contained binding; pathless predicate без placeholder допустим. Затем outer
читает/admit corpus, materializes payload и передаёт child exact
workspace+payload+digest.
Child не создаёт другой workspace и проверяет digest до исполнения. Для
programmed rows он после package preflight сравнивает cache-loaded и managed
installed skill digests; для package reference сохраняет только managed skill
digest без Codex skill-load claim. До разрушения layout child захватывает
observations/proof, затем выполняет свой cleanup и всегда пишет child-result.
Package-canary-reference передаётся release harness только как reference+digest;
canary workspace/marker остаются package-owned. Outer сверяет digest, adapter и
closed projection package-owned marker/tree hash, выполняет свой cleanup,
формирует final result и только затем публикует evidence. Public bootstrap
envelope не меняется.
Golden остаётся отдельным
version-specific adapter contract-test, поскольку scenario run его не читает.
Adapter fixture отдаёт normalized digest собственных raw implementation bytes,
а golden независимо сверяет digest и Codex version; generic runner не угадывает
source из command argv.

Существующий evidence envelope получает одно closed поле `manifest`. Его
semantic-input map одинаково мал для всех lanes: exact installed `SKILL.md`, raw
corpus, outer-materialized scenario, фактически выбранный version-specific
adapter и projection package marker `{marker_format,payload_hash,artifact_hash,
manifest_version}`. Package `artifact_hash` уже покрывает managed tree и
generated `.mcp.json`; перечень внутренних harness modules не сохраняется.

### Fast layer имеет один process boundary

Один top-level table-driven test в существующем
`tests/run-cursor-skill-eval.test.mjs` с `{ timeout: 2000 }` принимает и
materializes семь rows, вызывает oracle для шести programmed и проверяет
reference plumbing для `live-marker` без oracle: exact counts
`admission=7/materialization=7/oracle=6/package-reference=1`. Runaway bound не
проверяется отдельным stopwatch assertion. Imports чистые; instrumentation
видит ноль application spawns/network. Duration и row count — TAP diagnostics.

Supervisor mapping проверяется injected spawn/env contract без nested suites.
Полные foreground unit и coverage запускаются по одному разу в acceptance.
Tests с реальным I/O используют отдельные `mkdtemp` roots и не мутируют shared
`process.env`; inert paths в no-I/O stubs допустимы.

## Scenario Matrix

| `scenario_id` | Lane | Единственный мигрируемый owner наблюдения |
| --- | --- | --- |
| `client-happy` | client-integration | client tool-loop и positive skill-load evidence |
| `model-question` | model-behavior | question callback trace |
| `model-plan` | model-behavior | plan callback trace |
| `model-permission-covered` | model-behavior | exact covered action trace |
| `model-permission-expansion` | model-behavior | exact scope-expansion action trace |
| `model-semantic-failure` | model-behavior | honest failed outcome reporting |
| `live-marker` | full-live | eval selection/result/evidence для package-owned canary |

## Exact Migration Map

- `scripts/cursor-eval-scenario.mjs`: единственный новый product module для
  corpus admission, materialization и pure oracle; добавить в `productSources`.
- `scripts/run-cursor-skill-eval.mjs`: удалить `SCENARIOS`, expected-outcome
  switch и `transcriptIsCorrelated`; сохранить CLI selection, enable mapping,
  classification/publication и outer-owned materialization.
- `tests/run-cursor-skill-eval.test.mjs`: единственный test owner admission,
  selection, oracle, classification/publication; удалить correlation duplicate.
- `tests/codex-client-integration.test.mjs`: удалить hard-coded prompts,
  follow-ups/outcomes и `assertCorrelatedPendingTranscript`; сохранить discovery,
  Codex/app-server/tool-loop и normalized observations; принимать exact
  outer-owned workspace/payload/digest вместо создания workspace; все terminal
  branches провести через единый child-result-before-cleanup finalizer.
- `tests/release-e2e.test.mjs`: `runLiveCanary` принимает только outer
  package-canary-reference/digest, до удаления package layout захватывает bounded
  observations и package proof, после package cleanup пишет child-result с
  consumed digest, normalized canary status и cleanup outcome в outer-owned path;
  outer проверяет digest, выполняет собственный cleanup и затем публикует
  evidence с окончательным final result, включая cleanup failure.
- `tests/fixtures/fake-acp.mjs`: добавить explicit opt-in materialized-program
  branch, сохранить legacy fault modes и не валидировать public MCP IDs/policy.
- `scripts/recording-mcp-proxy.mjs`: сохранить владельцем normalized recording.
- `tests/runtime.test.mjs`: сохранить runtime invalid-ID/order rejection.
- semantic registry/gate: active/reference registration, baselines, owner refs,
  полный MODIFIED delta и corpus owner references; не дублировать scenario DSL.
- `scripts/run-node-tests.mjs`: только добавить новый product source; не менять
  unit test-file set, lanes, process lifecycle или `result.json`.

## Risks / Trade-offs

- [Corpus становится универсальным DSL] → exact-seven allowlist и только
  используемые variants; новый ID требует отдельного delta.
- [Driver копирует runtime] → driver лишь выдаёт stimuli/records; rejection
  остаётся runtime-owned.
- [Manifest не доказывает executed row] → outer передаёт canonical payload,
  child подтверждает consumed digest, outer fail-closed сверяет его.
- [Coverage теряет новый module] → explicit `productSources` task и behavioral
  test в существующем file.
- [Файловый parallelism создаёт flake] → per-test real-I/O roots и injected env.

## Migration Plan

1. Добавить exact-seven corpus и единый pure scenario module.
2. Перевести existing fake driver/runner/tests на outer-materialized payload.
3. Провести terminal branches через child finalizer и outer-only publisher.
4. Добавить scenario module в coverage manifest, не меняя test-file registry.
5. Выполнить targeted checks, по одному foreground unit/coverage, global gates
   и последовательный critic → architect review.

Rollback: вернуть hard-coded definitions и удалить corpus/scenario module.
Public runtime, facade, package, eval result и supervisor contracts совместимы.

## v1 Contract Baseline

**Goal.** Мигрировать семь существующих skill eval scenarios в exact-seven
corpus с отдельными program driver/pure oracle, проверяемым provenance и одним
структурно дешёвым обязательным table pass.

**Non-goals.** Новые scenario IDs/tier policy, comparison, `pass@k`, lifecycle
или permission owner, изменение public contracts/supervisor artifacts и
обязательные credentials.

**Public-invariant index.** `EVAL-LANES-2` → «Разделённые eval lanes и evidence загрузки skill»; `EVAL-SCENARIO-2` → «Сценарный контракт поведения и authority-aware interaction»; `EVAL-ORACLE-2` → «Scenario program driver и pure scenario oracle»; `EVAL-EVIDENCE-2` → «Immutable evidence manifest»; `EVAL-COST-2` → «Cost-aware execution policy».

**Owner map.** `cursor-subagent-skill-evals` owns corpus admission, selection, scenario oracle, classification and eval evidence. Runtime owns ACP lifecycle/state/MCP wire/public-ID validation/limits; facade owns delegation/workspace/authority semantics; package-owned bootstrap owns installation/discovery and requirements «Внешний контракт bootstrap» and «Проверяемая чистая установка»; runtime requirement «Ограниченный жизненный цикл ACP-процесса» остаётся lifecycle owner; `node-test-supervision` owns process tree, terminal verdict, artifacts and coverage gate; adapter owns confirmed Codex mapping.

**Implementation-ready exit.** Exact schema/example, semantic-input map и
migration map не оставляют новых design decisions; global strict/semantic gates
проходят; critic не находит baseline violation, architect подтверждает
minimality и owner uniqueness.

**Future-change candidates.** Новые scenario IDs, diversify/regression taxonomy,
PR/current/previous/no-skill comparison, model-only `pass@k`, timing trends, CI
publication и дополнительный LLM grader.
