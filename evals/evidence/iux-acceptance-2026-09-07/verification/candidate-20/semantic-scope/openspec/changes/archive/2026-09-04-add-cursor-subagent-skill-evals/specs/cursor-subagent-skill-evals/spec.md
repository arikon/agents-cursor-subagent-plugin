## Purpose

Определяет воспроизводимую проверку фактического workflow Codex с
установленным `cursor-subagent` skill, не подменяя её unit-тестом текста skill.

## ADDED Requirements

### Requirement: Разделённые eval lanes и evidence загрузки skill
Eval capability MUST предоставлять три отдельно классифицируемых lane:
credential-free Codex client-integration с scripted provider и fake ACP,
credential-gated Codex-model behavior с fake ACP и opt-in full-live Codex+Cursor.
Первый lane MUST проверять только discovery, загрузку установленного skill и
клиентский tool loop, но MUST NOT заявлять доказательство instruction-following
hosted модели. Все lanes MUST переиспользовать package-owned bootstrap,
adapter и discovery proof, а не создавать параллельный installation/configuration
path. Каждый run MUST сохранять adapter-normalized positive evidence загрузки
точного установленного `skills/cursor-subagent/SKILL.md`; exact Codex event,
provider и argv остаются version-specific golden-fixture detail.
Package references are «Внешний контракт bootstrap» and «Проверяемая чистая установка».

Runtime остаётся единственным owner ACP lifecycle, MCP schemas, envelopes и
limits; facade requirements «Skill workflow делегирования» и «Workspace
discipline делегирования» остаются единственными owners соответствующих
workflow norms.

#### Scenario: Credential-free client-integration lane запускается
- **WHEN** CI запускает credential-free lane
- **THEN** отдельный Codex-клиент с scripted provider завершает сценарий в
  fixture-worktree, сохраняет positive skill-load evidence и не объявляет
  результат доказательством поведения hosted модели

### Requirement: Сценарный контракт поведения и authority-aware interaction
Каждый scenario MUST иметь machine-readable `scenario_id`, lane, initial user
input, prior authority, fake-ACP program, follow-ups, ссылку на применимый
facade owner requirement, allowed/forbidden observations, expected actual task
outcome, expected Codex-reported outcome, expected `eval_status` и evidence
predicate. Harness MUST оценивать transcript только на соответствие указанным
facade requirements, не переопределяя их workflow semantics.

Authority-aware question, plan и permission semantics принадлежат modified
facade requirement «Skill workflow делегирования». Harness only observes their
scenario-specific trace. Для каждой allocated session harness MUST проверить
close attempt согласно runtime requirement «Ограниченный жизненный цикл
ACP-процесса»; идемпотентность close остаётся runtime-owned. Сценарии writing
`agent` ссылаются на facade requirement «Workspace discipline делегирования» и
не добавляют собственную worktree policy.

#### Scenario: Scenario с pending authority проверяется по facade owner
- **WHEN** scenario содержит covered или scope-expansion permission
- **THEN** harness сравнивает trace с requirement «Skill workflow
  делегирования», не вводя собственного permission policy

### Requirement: Outcome model и диагностические доказательства
Каждый eval run MUST написать в stdout ровно один `EvalResultV1` JSON object;
diagnostics MUST идти только в stderr. `EvalResultV1` имеет schema version 1,
запрещает additional properties и содержит:

```json
{
  "schema_version": 1,
  "scenario_id": "string",
  "lane": "client-integration | model-behavior | full-live",
  "eval_status": "pass | skipped | integration_failure | agent_behavior_mismatch",
  "actual_task_outcome": "succeeded | failed | not_observed",
  "reported_task_outcome": "succeeded | failed | not_reported",
  "fixture_assertion_outcome": "pass | fail | not_observed",
  "evidence_publication_status": "published | failed | not_attempted",
  "evidence_ref": "string | null",
  "cleanup_status": "succeeded | failed | not_required",
  "failure_stage": "null | runner | adapter_admission | discovery | skill_load | transport | scenario | inspection | publication | cleanup",
  "error_code": "string | null",
  "message": "string | null"
}
```

`scenario_id` and `error_code` are at most 128 UTF-8 bytes, `evidence_ref` at
most 4,096 bytes, `message` at most 8,000 bytes, stdout JSON at most 16,384
bytes and a published evidence artifact at most 1,048,576 UTF-8 bytes.
`evidence_ref` is non-null if and only if publication status is `published`;
the transcript exists only inside published evidence. `skipped` and pre-spawn
failures use `not_observed` and `not_reported`; publication failure still emits
the complete `EvalResultV1` to stdout with a null `evidence_ref`.

Classifier MUST apply precedence: explicitly disabled optional lane —
`skipped`; runner, adapter admission, discovery, skill load, transport,
inspection, publication or cleanup failure — `integration_failure`; after
complete evidence and successful cleanup a scenario-contract violation —
`agent_behavior_mismatch`; expected scenario behavior — `pass`.

#### Scenario: Ожидаемый semantic failure честно сообщён
- **WHEN** fixture assertion фиксирует expected failed task outcome, а Codex
  сообщает именно этот outcome согласно scenario contract
- **THEN** harness возвращает `pass`, а не `agent_behavior_mismatch`

#### Scenario: Evidence cleanup конфликтует с behavior mismatch
- **WHEN** harness одновременно наблюдает workflow mismatch и не может
  опубликовать evidence либо завершить cleanup
- **THEN** harness возвращает `integration_failure` по precedence classifier

#### Scenario: Реальный live lane выключен
- **WHEN** live integration lane не включён явной конфигурацией
- **THEN** этот lane возвращает `skipped`, не меняя итог локального
  детерминированного behavior-eval
