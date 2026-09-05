# cursor-subagent-skill-evals Specification

## Purpose
Определяет воспроизводимую проверку фактического workflow Codex с
установленным `cursor-subagent` skill, не подменяя её unit-тестом текста skill.

## Requirements

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
Для целей этого сохранённого baseline-текста `Каждый run` означает каждый из
шести `programmed` runs; `package-canary-reference` является единственным
исключением и подтверждает только digest package-validated managed installed
skill.

Runtime остаётся единственным owner ACP lifecycle, MCP schemas, envelopes и
limits; facade requirements «Skill workflow делегирования» и «Workspace
discipline делегирования» остаются единственными owners соответствующих
workflow norms.

Для шести `programmed` rows package root MUST пройти package-owned preflight;
digest/bytes Codex cache-loaded `SKILL.md` из adapter-normalized skill-load
evidence MUST совпасть с managed installed `SKILL.md`, без требования path
containment cache внутри managed root. Для `package-canary-reference` MUST
сохраняться только digest package-validated managed installed `SKILL.md`; этот
lane MUST NOT заявлять Codex skill-load evidence, поскольку package canary
вызывает facade напрямую.

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

Для `package-canary-reference` перечисленные behavioral fields MUST считаться
удовлетворёнными ссылкой на package owner и MUST NOT копироваться в eval row;
eval harness владеет только selection, `EvalResultV1` mapping и evidence.

Authority-aware question, plan и permission semantics принадлежат modified
facade requirement «Skill workflow делегирования». Harness only observes their
scenario-specific trace. Для каждой allocated session harness MUST проверить
close attempt согласно runtime requirement «Ограниченный жизненный цикл
ACP-процесса»; идемпотентность close остаётся runtime-owned. Сценарии writing
`agent` ссылаются на facade requirement «Workspace discipline делегирования» и
не добавляют собственную worktree policy.

Scenario definitions MUST храниться только в
`evals/cursor-subagent-scenarios.v1.json`. Corpus MUST быть закрытым JSON object
с ровно `schema_version: 1` и `scenarios`, запрещать additional properties и
содержать ровно семь scenarios двух закрытых variants. Шесть client/model rows
MUST иметь `scenario_kind: "programmed"` и ровно keys `scenario_kind`,
`scenario_id`, `lane`, `owner_requirements`, `initial_input`, `prior_authority`,
`program`, `followups`, `expected_trace`, `forbidden_observations`,
`fixture_predicate`, `expected_actual_task_outcome`,
`expected_reported_task_outcome`, `expected_enabled_eval_status`.
`live-marker` MUST быть reference-only object с ровно
`scenario_kind: "package-canary-reference"`, `scenario_id: "live-marker"`,
`lane: "full-live"`, одним `owner_requirements` element
`{ "capability":"cursor-plugin-distribution",
"requirement":"Проверяемая чистая установка" }` и
`expected_enabled_eval_status: "pass"`. Programmed fields input, authority,
program, followups, trace, observations, predicate и task outcomes в нём MUST
быть запрещены: их единственным владельцем остаётся package canary.

Для каждого row `scenario_id` MUST быть уникальным kebab-case значением длиной 1–128 UTF-8
bytes. `lane` MUST быть `client-integration`, `model-behavior` или `full-live`.
`owner_requirements` MUST содержать 1–2 уникальных закрытых objects с ровно
`capability` и `requirement`, каждый 1–128 UTF-8 bytes. Эти значения MUST точно
совпадать с capability directory и requirement name authoritative main specs;
эту semantic reference validation выполняет project semantic gate. Runtime
loader MUST проверять только closed shape, bounds и uniqueness массива.

`initial_input` MUST занимать 1–8000 UTF-8 bytes. `prior_authority` MUST быть
одним закрытым variant: `{ "kind": "none" }` либо
`{ "kind": "delegated", "allowed_actions": [...] }`; `allowed_actions` MUST
содержать 1–8 уникальных закрытых objects `{ "operation": "read | write",
"path": "relative/posix/path" }`. Workspace-wide wildcard, destructive,
external и credential action kinds в v1 запрещены.

`program` MUST быть закрытым `{ "kind": "fake-acp", "steps": [...] }` с 1–8 ordered closed steps и
уникальными `step_id` длиной 1–128 UTF-8 bytes. Допустимы только следующие
точные step variants:

- question: `{ "type":"pending", "request_kind":"question", "step_id":string,
  "callback_id":string, "question_id":string, "prompt":string, "options":[...],
  "expected_callback": { "kind":"answer", "option_ids":[...] } }`;
  `step_id`, `callback_id`, `question_id` и option `id` занимают 1–128 bytes,
  `prompt` и option `label` — 1–8000 bytes; `options` содержит 1–8 уникальных
  закрытых `{ "id":string, "label":string }`, а `option_ids` — непустое
  уникальное подмножество advertised option IDs;
- plan: `{ "type":"pending", "request_kind":"plan", "step_id":string,
  "callback_id":string, "plan_text":string,
  "expected_callback": { "kind":"decision",
  "decision":"accept | reject" } }`, где strings bounded как question strings;
- permission: `{ "type":"pending", "request_kind":"permission",
  "step_id":string, "callback_id":string,
  "action": { "operation":"read | write", "path":string },
  "choices":["allow-once","reject-once"],
  "expected_callback": { "kind":"decision",
  "decision":"allow-once | reject-once" } }`;
- effect: `{ "type":"effect", "step_id":string, "callback_id":string,
  "operation":"write", "path":string, "text":string,
  "expected_callback": { "kind":"write-result",
  "outcome":"succeeded" } }`, где `callback_id` занимает 1–128 bytes, а
  `text` — 0–8000 bytes. Driver MUST выдать ACP write-file stimulus, дождаться
  successful response с тем же callback ID и только затем записать
  `effect.file-written`; error, missing или mismatched callback MUST быть
  recorded failure, а raw ACP mapping остаётся runtime/fixture detail;
- terminal: `{ "type":"terminal", "step_id":string,
  "turn_status":"completed", "result_text":string | null }`, где
  ненулевой `result_text` занимает 1–8000 bytes. Protocol `completed` MUST NOT
  само по себе означать semantic task success.

`followups` MUST содержать 0–2 закрытых objects
`{ "after_pending_step": string, "input": string }`; reference MUST указывать
на существующий pending `step_id`, а input занимает 1–8000 bytes.
`expected_trace` MUST содержать 1–16 closed observations следующих shapes:

- `{ "kind": K }` для `K` из `session.allocated`, `turn.started`,
  `session.close-attempted`;
- `{ "kind": K, "step_id": string }` для `K` из `pending.question`,
  `pending.plan`, `pending.permission`, `effect.file-written`,
  `turn.completed`;
- `{ "kind":"answer.question", "step_id":string, "option_ids":[...] }`;
- `{ "kind":"answer.plan", "step_id":string,
  "decision":"accept | reject" }`;
- `{ "kind":"answer.permission", "step_id":string,
  "decision":"allow-once | reject-once" }`.

Каждый trace `step_id` MUST ссылаться на существующий compatible program step:
pending/effect/terminal kind совпадает с его step type/request kind;
`answer.question` ссылается на question pending и содержит те же unique option
IDs, что expected callback; `answer.plan` и `answer.permission` ссылаются на
соответствующий pending kind и совпадают с expected callback. Trace order MUST
быть совместим с ordered program; `effect.file-written` требует matching
successful effect callback. `forbidden_observations` MUST содержать уникальные значения только из
`answer-before-pending`, `id-mismatch`, `operation-after-close`,
`unexpected-effect` и `raw-provider-payload`. Отсутствие close не является
observation: oracle отдельно требует `session.close-attempted` после allocation.

`fixture_predicate` MUST быть одним closed variant:
`{ "kind":"none" }`, `{ "kind":"terminal-token", "token":string }`,
`{ "kind":"file-text", "path":string, "text":string }` или
`{ "kind":"file-absent", "path":string }`; strings имеют те же bounds, что
соответствующие input/path/effect fields. Это единственный predicate owner.

Каждый structured `path` MUST занимать 1–4096 UTF-8 bytes и быть literal POSIX
workspace-relative path без absolute prefix, empty segment, `.`, `..`,
backslash, NUL и placeholders. Placeholders
MUST допускаться только в programmed `initial_input` и `followups[].input`; v1
allowlist содержит только `${RESULT_FILE}`. Outer MUST после собственного
`mkdtemp` всегда создать `<fixture>/workspace`; binding MUST вычисляться только
если placeholder фактически присутствует. Тогда predicate MUST быть
`file-text` или `file-absent`, а binding — absolute contained path из его
canonical path. Без placeholder binding отсутствует, а `none` и
`terminal-token` допустимы. Outer передаёт child exact workspace. Placeholder
без path-bearing predicate, unknown либо unresolved
placeholder MUST давать `integration_failure/adapter_admission` до spawn. Child
MUST использовать переданный workspace и MUST NOT создавать альтернативный
workspace. Package-canary-reference исключён: его workspace/marker остаются
package-owned.

Expected outcome fields MUST использовать существующие `EvalResultV1` enums;
`expected_enabled_eval_status` для всех семи rows MUST быть `pass`. Для
`model-plan` expected callback и trace decision MUST быть `accept`. Disabled
optional lane `skipped` остаётся runner-owned и MUST NOT дублироваться в row.
Corpus v1 MUST содержать только `client-happy`, `model-question`, `model-plan`,
`model-permission-covered`, `model-permission-expansion`,
`model-semantic-failure` и `live-marker`. Malformed corpus, duplicate scenario
ID, invalid shape/bound/path/reference format или placeholder MUST давать
`integration_failure/adapter_admission`. Запрошенный ID, отсутствующий после
admission, MUST давать `integration_failure/runner/unknown_scenario`.

#### Scenario: Scenario с pending authority проверяется по facade owner
- **WHEN** scenario содержит covered или scope-expansion permission
- **THEN** harness сравнивает trace с requirement «Skill workflow
  делегирования», не вводя собственного permission policy

#### Scenario: Corpus v1 мигрирует существующие cases
- **WHEN** loader успешно принимает corpus v1
- **THEN** доступны ровно семь перечисленных существующих scenario IDs, а их
  outcomes совместимы с текущими eval contracts

#### Scenario: Corpus содержит дублирующийся ID
- **WHEN** два scenario используют один `scenario_id`
- **THEN** admission завершается `integration_failure/adapter_admission` до
  запуска Codex или Cursor

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

### Requirement: Scenario program driver и pure scenario oracle
Fake-ACP program driver MUST только выдавать materialized pending/effect/
terminal stimuli и записывать bounded normalized callback/effect observations.
Driver MUST NOT валидировать public MCP IDs, порядок вызовов, authority policy
или runtime lifecycle. Pure scenario oracle MUST вызываться только для шести
`programmed` rows и принимать materialized scenario, recorded normalized MCP
trace, callback/effect observations и reported outcome и MUST возвращать
детерминированное сравнение без child process, сети или изменения внешнего
состояния.

Oracle MUST обнаруживать answer до pending, несовпадающие public session/turn/
request IDs, operation after close, unexpected effect и отсутствие обязательной
close attempt как scenario mismatch. Runtime остаётся единственным владельцем
немедленного отклонения invalid public IDs/order; отсутствие close observation
для oracle является отсутствующим наблюдением. Mismatch после полного evidence
и успешного cleanup MUST классифицироваться как `agent_behavior_mismatch` на
стадии `scenario`.

#### Scenario: Pending request получает коррелированный ответ
- **WHEN** driver публикует pending stimulus, а recorded MCP trace содержит
  answer с соответствующими opaque IDs и expected callback payload
- **THEN** pure oracle принимает observation и продолжает проверку до terminal
  outcome и close attempt

#### Scenario: Ответ записан прежде pending
- **WHEN** normalized trace содержит answer до соответствующего pending
- **THEN** pure oracle возвращает scenario mismatch, не исправляя trace и не
  присваивая driver роль runtime validator

### Requirement: Immutable evidence manifest
Существующий private published evidence object каждого scenario с полным
validated proof MUST сохранить прежние transcript/oracle/result fields и получить
ровно одно новое поле `manifest`. Его значение MUST быть закрытым
`EvidenceManifestV1` с `schema_version: 1`, `hash_algorithm: "sha256"`,
`hash_encoding: "lowercase-hex"`, digest objects `installed_skill`, `corpus`,
`materialized_scenario`, `adapter`, closed `installed_payload`, `client` и
`model`, без additional properties. Closure относится только к manifest
subobject и MUST NOT переопределять существующий evidence envelope. При
pre-proof failure durable evidence MUST NOT публиковаться: используется
существующий `EvalResultV1` с `evidence_publication_status:"not_attempted"` и
`evidence_ref:null`, без nullable variant manifest.

Digest object MUST иметь ровно `{ "sha256": string, "bytes": integer }`;
digest — 64 lowercase hexadecimal characters, `bytes` — positive safe integer
не больше 1,048,576. `installed_payload` MUST иметь ровно
`{ "marker_format":1, "payload_hash":string, "artifact_hash":string,
"manifest_version":string }`; оба hashes имеют digest format, а version
занимает 1–256 UTF-8 bytes. `client` MUST иметь ровно bounded nonempty
`name/version`; `model` — ровно bounded `provider/name`, каждое string 1–256
bytes либо null.

Raw installed `SKILL.md`, corpus и выбранный adapter implementation MUST
хешироваться как фактически прочитанные bytes без newline normalization.
Materialized scenario MUST хешироваться как UTF-8 canonical JSON: object keys
рекурсивно сортируются по ASCII, array order сохраняется, serialization
использует `JSON.stringify` без whitespace; canonical scenario не больше 65,536
bytes. Raw provider/model payload MUST не сохраняться. Version-specific golden
остаётся отдельным adapter contract-test evidence и MUST NOT входить в per-run
manifest. Admitted version-specific adapter fixture MUST вернуть normalized
`implementation_sha256`/`implementation_bytes` своих raw implementation bytes;
golden contract-test MUST независимо сверить их с fixture и Codex version.
Generic runner MUST NOT выводить digest source эвристикой из argv/path.

Outer runner MUST до spawn прочитать/admit corpus, выбрать ID, materialize
scenario, вычислить canonical payload/digest и передать child именно этот
bounded payload с ожидаемым digest. Child MUST проверить digest до исполнения,
через package-owned validation захватить marker projection, exact managed skill
digest и programmed-only cache-loaded skill evidence до разрушения layout,
выполнить собственный transport/package cleanup и на управляемых
client/model/package terminal branches через finalizer записать bounded
child-result в outer-owned path, включая cleanup status. Abrupt process loss
остаётся pre-proof missing-result integration failure. Outer MUST сверить exact
scenario и raw corpus digests и MUST проверить closed shape/bounds adapter и
aggregate package projection. Adapter fixture/golden владеет фактической
сверкой adapter bytes/version, package preflight — фактической сверкой package
proof; outer MUST NOT повторять admission, выводить adapter source из argv/path
или обходить package tree. Outer MUST попытаться удалить собственный fixture,
затем сформировать окончательный `EvalResultV1` и только после обеих cleanup
attempts опубликовать immutable evidence с final result только при полном
validated proof. Cleanup failure MUST быть отражён в published failure evidence
по существующему classifier precedence; pre-proof failure не публикует durable
evidence. Publication failure после cleanup сохраняет существующую
classification. Public bootstrap envelope MUST не изменяться. Missing или
mismatched owned digest либо malformed proof MUST давать `integration_failure`
до behavior verdict. Manifest MUST NOT содержать run ordinal, temp roots или
перечень внутренних harness modules.

#### Scenario: Evidence связано с точным payload
- **WHEN** outer запускает выбранный scenario и получает child-result
- **THEN** scenario/raw-corpus digests совпадают, adapter/package proof
  корректной closed формы захвачен до cleanup, а outer публикует один вложенный
  manifest только при полном proof

### Requirement: Cost-aware execution policy
Corpus admission и canonical materialization семи rows, pure-oracle evaluation
шести `programmed` rows и reference/selection/result/evidence plumbing одного
`package-canary-reference` MUST выполняться одним top-level table-driven test в
существующем `tests/run-cursor-skill-eval.test.mjs`. Test body MUST иметь
runaway bound `{ timeout: 2000 }`, который MUST NOT трактоваться как standalone
wall-clock SLO. Единственный новый product module
`scripts/cursor-eval-scenario.mjs` MUST экспортировать pure admission,
materialization и oracle functions; imports MUST не создавать child process,
сеть или credentials. Test body MUST вызывать только эти pure operations, без
runner/harness и process-per-scenario, и иметь counts `admission=7`,
`materialization=7`, `oracle=6`, `package-reference=1`, без отдельного test
file или process-per-scenario; pure oracle MUST NOT вызываться для package
reference.

Real-Codex client-integration, hosted-model и full-live runs MUST оставаться
отдельными foreground командами и MUST NOT входить в unit coverage как scenario
executions. Supervisor mapping MUST проверяться cheap injected spawn/env
contract test без вложенного `unit` или `coverage`. Полные foreground `unit` и
`coverage` MUST выполняться ровно один раз в acceptance. Duration и scenario
count MAY выводиться только как TAP diagnostics. Change MUST NOT модифицировать
`node-test-supervision` `result.json` или lane schema.

Новые или изменённые этим change eval/driver tests с реальным filesystem/process
I/O MUST использовать per-test `mkdtemp` и не разделять mutable state между
files; no-I/O contract tests MAY использовать inert injected path strings. Такие
eval/driver tests MUST NOT изменять shared `process.env`.

#### Scenario: Exact-seven corpus проверяется дешёвым слоем
- **WHEN** выполняется unit contract test
- **THEN** один table-driven test принимает и материализует семь rows, оценивает
  oracle-ом шесть programmed rows и проверяет plumbing одной package reference
  без runner/harness и process-per-scenario

#### Scenario: Hosted scenario не включён явно
- **WHEN** запускается обычный unit или coverage lane без hosted/live opt-in
- **THEN** cheap contract подтверждает command mapping без запуска real-Codex,
  hosted-model или full-live process
