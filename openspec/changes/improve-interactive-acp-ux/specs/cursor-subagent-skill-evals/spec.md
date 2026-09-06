## MODIFIED Requirements

### Requirement: Разделённые eval lanes и evidence загрузки skill
Eval capability MUST предоставлять три отдельно классифицируемых lane:
credential-free Codex client-integration с scripted provider и fake ACP,
credential-gated Codex-model behavior с fake ACP и opt-in full-live Codex+Cursor.
Client-integration MUST проверять discovery, загрузку установленного skill и
клиентский tool loop, но MUST NOT заявлять instruction-following hosted модели.
Все lanes MUST переиспользовать package-owned bootstrap, adapter и discovery
proof, а не создавать параллельный installation/configuration path.

Каждый admitted `programmed` run MUST сохранять adapter-normalized positive
evidence загрузки точного установленного `skills/cursor-subagent/SKILL.md`:
digest/bytes Codex cache-loaded skill совпадают с managed installed skill, а
package root проходит package-owned preflight. Единственный
`package-canary-reference` сохраняет только digest package-validated managed
installed skill и MUST NOT заявлять Codex skill-load evidence, поскольку
package canary вызывает facade напрямую. Количество и lane mapping всех rows
выводятся только из validated JSON corpus; spec, runner и tests MUST NOT
повторять fixed count или полный scenario-ID allowlist. Exact Codex event,
provider и argv остаются version-specific golden-fixture detail.

Runtime остаётся единственным owner ACP lifecycle, MCP schemas, envelopes и
limits; facade requirements «Skill workflow делегирования» и «Workspace
discipline делегирования» остаются единственными owners workflow norms.
Package references are «Внешний контракт bootstrap» and «Проверяемая чистая
установка».

#### Scenario: Credential-free client-integration lane запускается
- **WHEN** CI запускает credential-free lane
- **THEN** отдельный Codex-клиент с scripted provider завершает выбранный
  corpus scenario в fixture-worktree, сохраняет exact positive skill-load
  evidence и не объявляет результат доказательством поведения hosted модели

### Requirement: Сценарный контракт поведения и authority-aware interaction
Каждый scenario MUST иметь machine-readable `scenario_id`, lane, initial user
input, prior authority, fake-ACP program, follow-ups, ссылку на применимый
facade owner requirement and any additional runtime/package owner boundary whose
semantics the row specifically asserts, expected trace, expected actual task outcome,
expected Codex-reported outcome, expected `eval_status` и evidence predicate.
Harness MUST оценивать transcript по expected trace и единым oracle invariants
только на соответствие указанным owner requirements, не переопределяя их
semantics.

Uniform cross-row oracle invariants for exact ID provenance, event ordering and
end-of-eval close/tombstone handling are eval-owner composition rules that
reference their existing runtime owners once here; they are not repeated in
every row's `owner_requirements`. Row references cover only the scenario-specific
semantic assertions beyond those uniform invariants.

Для `package-canary-reference` перечисленные behavioral fields MUST считаться
удовлетворёнными ссылкой на package owner и MUST NOT копироваться в eval row;
eval harness владеет только selection, `EvalResultV1` mapping и evidence.

Authority-aware question, plan и permission semantics принадлежат modified
facade requirement «Skill workflow делегирования». Harness only observes their
scenario-specific trace. Для каждой allocated session harness MUST проверить
close attempt согласно runtime requirement «Ограниченный жизненный цикл
ACP-процесса», кроме fixture-доказанного natural child exit после terminal
result, уже tombstoned wrapper и последующего explicit resume. Идемпотентность
close остаётся runtime-owned. Сценарии writing
`agent` ссылаются на facade requirement «Workspace discipline делегирования» и
не добавляют собственную worktree policy.

Scenario programs, prompts and expected traces MUST храниться только в
`evals/cursor-subagent-scenarios.v1.json`. Corpus MUST быть закрытым JSON object
с ровно `schema_version: 1` и `scenarios`, запрещать additional properties и
содержать 2–64 scenarios двух закрытых variants. JSON corpus является
единственным владельцем полного списка `scenario_id` и их lane mapping; loader
и этот spec не повторяют allowlist или фиксированное число programmed rows.
Client/model rows MUST иметь `scenario_kind: "programmed"` и baseline keys
`scenario_kind`,
`scenario_id`, `lane`, `owner_requirements`, `initial_input`, `prior_authority`,
`program`, `followups`, `expected_trace`,
`fixture_predicate`, `expected_actual_task_outcome`,
`expected_reported_task_outcome`, `expected_enabled_eval_status`, а также MAY
иметь `report_checks`, `harness_faults` и `skill_sensitivity`.
Ровно один row MUST быть reference-only object с ровно
`scenario_kind: "package-canary-reference"`, уникальным kebab-case `scenario_id`,
`lane: "full-live"`, одним `owner_requirements` element
`{ "capability":"cursor-plugin-distribution",
"requirement":"Проверяемая чистая установка" }` и
`expected_enabled_eval_status: "pass"`. Programmed fields input, authority,
program, followups, trace, observations, predicate и task outcomes в нём MUST
быть запрещены: их единственным владельцем остаётся package canary.

Для каждого row `scenario_id` MUST быть уникальным kebab-case значением длиной 1–128 UTF-8
bytes. `lane` MUST быть `client-integration`, `model-behavior` или `full-live`.
`owner_requirements` MUST содержать 1–5 уникальных закрытых objects с ровно
`capability` и `requirement`, каждый 1–128 UTF-8 bytes. Эти значения MUST точно
совпадать с capability directory и requirement name authoritative main specs
либо delta requirements этого же active change; эту semantic reference
validation выполняет project semantic gate. Runtime
loader MUST проверять только closed shape, bounds и uniqueness массива.

`initial_input` MUST занимать 1–8000 UTF-8 bytes. `prior_authority` MUST быть
одним закрытым variant: `{ "kind": "none" }` либо
`{ "kind": "delegated", "allowed_actions": [...] }`; `allowed_actions` MUST
содержать 1–8 уникальных закрытых objects `{ "operation": "read | write",
"path": "relative/posix/path" }`. Workspace-wide wildcard, destructive,
external и credential action kinds в v1 запрещены.

Model-behavior `initial_input` and `followups[].input` MUST express only the
ordinary user goal, requested launch choices, authority and user decisions.
They MUST NOT prescribe MCP tool names, opaque IDs, wait/resume/close ordering,
stale-ID recovery, wrapper-loss recovery, timeout classification or
retention-gap safety markers. Faults that exercise those paths are introduced
only by the eval proxy/provider fixture, so the expected trace measures behavior
attributable to the selected installed skill rather than an algorithm copied
from the user prompt.

Optional `harness_faults` MUST быть непустым unique array, содержащим только
`accelerate-mode-timeout`, `accelerate-turn-timeout`,
`accelerate-wait-timeout`, `exit-after-result`,
`hold-terminal-until-followup`, `inject-mode-protocol-error-once`,
`inject-stale-question-once`,
`reject-initialize`, `reject-mode`, `reject-prompt` и `reject-resume`. Это единственный scenario-level
selector для programmed fault injection: runner, proxy и provider fixture MUST
NOT выбирать fault по `scenario_id`. Proxy MUST activate a selected fault only
when its installed process receives the complete eval handshake: an absolute
dedicated MCP evidence destination, a nonempty scenario ID and an absolute
scenario-program path. An ambient fault variable without that handshake MUST
not change any MCP request. `inject-stale-question-once` требует
question step и expected `answer.rejected-stale`; `exit-after-result` требует
expected `session.resumed`, либо `session.resume-failed` только при одновременном
`reject-resume`; `reject-resume` требует expected `session.resume-failed`;
`reject-initialize` требует initial `session.tombstoned` без `turn.started`;
`reject-prompt` требует paired terminal step `failed + null`, predicate
`terminal-status:failed` и expected `turn.failed`;
`accelerate-mode-timeout` требует predicate `mode-change-failed:mode_timeout`
и expected `session.mode-change-failed`;
`inject-mode-protocol-error-once` требует predicate
`mode-recovery-status:live:false`, expected
`session.mode-change-failed:protocol_error` и следующий
`session.mode-recovery-status:live:false`, followed by the normal final
`session.close-attempted` because the wrapper remains live;
`reject-mode` требует predicate `mode-change-failed:protocol_error`, expected
`session.mode-change-failed:protocol_error`, следующий `session.tombstoned` и
report binding `provider_error`; injected и provider-originated mode faults
взаимоисключающи;
`accelerate-turn-timeout` требует predicate
`terminal-status:timed_out` и expected `turn.timed-out`;
`accelerate-mode-timeout` сокращает только runtime-owned 15-second mode-control
deadline; `accelerate-turn-timeout` сокращает только runtime-owned one-hour turn
deadline; каждый accelerator действует лишь при своём exact fault flag и MUST
NOT менять два других timer classes;
`accelerate-wait-timeout` требует первый expected `turn.wait-timeout` с
effective `timeout_ms:30000` и `timeout_omitted:true`; fixture сокращает только
wall-clock ожидание этого default request и MUST NOT менять наблюдаемый request
shape, effective timeout contract или последующий backoff;
`hold-terminal-until-followup` требует follow-up с
`after_kind:"wait-timeout"` и expected `turn.followup-received-active`.
Pairing MUST быть двунаправленным: expected `answer.rejected-stale` допускается
ровно с `inject-stale-question-once`, expected `turn.timed-out` — ровно с
`accelerate-turn-timeout`, а expected `session.resume-failed` — ровно с парой
`exit-after-result + reject-resume`. A post-terminal `session.tombstoned`, за
которым следует resume outcome, допускается ровно с `exit-after-result`;
initial tombstone before any `turn.started` — ровно с `reject-initialize`;
expected `turn.followup-received-active` — ровно с
`hold-terminal-until-followup`.
Expected `session.mode-change-failed:protocol_error` — ровно с
одним из `inject-mode-protocol-error-once` или `reject-mode`. Injected variant,
unlike `mode_timeout`, does not terminalize the live wrapper and therefore does
not satisfy the eval-end close-attempt requirement by itself. Provider-rejected
variant MUST preserve bounded `provider_error`, tombstone the wrapper and MUST
NOT retry, send a prompt, resume or create a replacement before a new user
decision. Expected default `turn.wait-timeout` with `timeout_omitted:true` —
ровно с `accelerate-wait-timeout`.
Intentional launch-setting resume после explicit close остаётся normal workflow
и не требует provider-exit fault.

Optional `skill_sensitivity` MUST иметь ровно
`{ "mutation":"omit-events-lost",
"expected_mismatch":"reported-outcome-mismatch" }`, допускаться только для
lane `model-behavior`, требовать `event-burst` step, expected trace
`turn.events-lost` и `report_checks` и быть единственным owner выбора этой
mutation и её expected oracle mismatch. Runner MUST NOT выбирать sensitivity
по `scenario_id`.

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
  "operation":"read | write", "path":string, "text":string,
  "expected_callback": { "kind":"read-result | write-result",
  "outcome":"succeeded" } }`, где `callback_id` занимает 1–128 bytes, а
  `text` — 0–8000 bytes. Driver MUST выдать соответствующий ACP read-file или
  write-file stimulus, дождаться successful response с тем же callback ID и
  только затем записать `effect.file-read` или `effect.file-written`; error,
  missing или mismatched callback MUST быть
  recorded failure, а raw ACP mapping остаётся runtime/fixture detail;
- terminal is exactly one conditional variant: `{ "type":"terminal",
  "step_id":string, "turn_status":"completed", "result_text":string }` or
  `{ "type":"terminal", "step_id":string, "turn_status":"failed",
  "result_text":null }` or
  `{ "type":"terminal", "step_id":string, "turn_status":"timed_out",
  "result_text":null }`; a completed `result_text` occupies 1–8000 bytes.
  A failed terminal MUST be paired exactly with the `reject-prompt` harness
  fault; protocol `completed` MUST NOT само по себе означать semantic task
  success.

Expected trace MAY содержать closed
`{ "kind":"session.start-rejected", "error_code":"invalid_args | scope_rejected" }`
без session/turn IDs только когда launch отвергнут до allocation. Predicate
`{ "kind":"start-rejected", "error_code":"invalid_args | scope_rejected" }`
считает actual outcome failed только при observed `cursor_delegate` response с
тем же normalized error code; никакой close после отсутствующей session не
требуется.

`followups` and `expected_trace` MUST use the single closed grammars defined
below; `expected_trace` MUST содержать 1–16 closed observations. The old
`after_pending_step` and baseline-only trace shapes are not admitted.

Каждый trace `step_id` MUST ссылаться на существующий compatible program step:
pending/effect/terminal kind совпадает с его step type/request kind;
`answer.question` ссылается на question pending и содержит те же unique option
IDs, что expected callback; `answer.plan` и `answer.permission` ссылаются на
соответствующий pending kind и совпадают с expected callback. Trace order MUST
быть совместим с ordered program; `effect.file-written` требует matching
successful effect callback. Oracle глобально и без per-row policy отклоняет
`answer-before-pending`, `id-mismatch`, `operation-after-close` и
`unexpected-effect`. Конфиденциальность raw provider payload принадлежит
recording-proxy behavioral test, а не искусственному corpus observation.
Session-level observations require only the `session_id` actually present in
their MCP request/response; an optional `turn_id` is admissible only when that
same operation exposes it. They MUST NOT inherit a previous mutable turn ID.
Turn-level observations require both IDs from their actual call or bounded
result.
Отсутствие close не является observation: oracle отдельно применяет
close-or-proven-natural-tombstone rule, определённый выше.

`fixture_predicate` MUST быть одним closed variant:
`{ "kind":"none" }`, `{ "kind":"terminal-token", "token":string }`,
`{ "kind":"file-text", "path":string, "text":string }`,
`{ "kind":"file-absent", "path":string }`,
`{ "kind":"terminal-status", "status":"failed | timed_out" }` или
`{ "kind":"resume-failed" }`, либо
`{ "kind":"mode-change-failed", "error_code":"mode_timeout | protocol_error" }`, либо
`{ "kind":"mode-recovery-status", "session_state":"live",
"active_turn":false }`, либо
`{ "kind":"delegate-init-failed", "failure_kind":"init" }`, либо
`{ "kind":"start-rejected", "error_code":"invalid_args | scope_rejected" }`;
strings имеют те же bounds, что
соответствующие input/path/effect fields. Это единственный predicate owner.

Каждый structured `path` MUST занимать 1–4096 UTF-8 bytes и быть literal POSIX
workspace-relative path без absolute prefix, empty segment, `.`, `..`,
backslash, NUL и placeholders. Placeholders MUST допускаться только в
programmed `initial_input`, `followups[].input` и fragment lists
`program.steps[type=prompt-check].required_fragments|forbidden_fragments`; v1
allowlist содержит `${RESULT_FILE}`, `${PLUGIN_DIR}` и
`${MISSING_PLUGIN_DIR}`. Outer MUST после
собственного `mkdtemp` всегда создать `<fixture>/workspace`; binding MUST
вычисляться только если placeholder фактически присутствует. `${RESULT_FILE}`
требует `file-text` или `file-absent` predicate и связывается с absolute
contained path из его canonical path. `${PLUGIN_DIR}` связывается только с
canonical `<workspace>/plugin-bundle`, создаваемым outer, и не требует file
predicate. `${MISSING_PLUGIN_DIR}` связывается с deterministic absolute
`<workspace>/missing-plugin-bundle`, который не создаётся и проверяет
fail-closed start rejection без provider launch. Без placeholders binding отсутствует, а `none` и `terminal-token`
допустимы. Outer передаёт child exact workspace. Unknown либо unresolved
placeholder и `${RESULT_FILE}` без path-bearing predicate MUST давать
`integration_failure/adapter_admission` до spawn. Child MUST использовать
переданный workspace и MUST NOT создавать альтернативный workspace.
Materialization MUST заменить каждый известный placeholder во всех разрешённых
fields, включая prompt-check fragments, а затем отклонить любой оставшийся
placeholder; остальные corpus fields не получают placeholder semantics.
Package-canary-reference исключён: его workspace/marker остаются package-owned.

Expected outcome fields MUST использовать существующие `EvalResultV1` enums;
`expected_enabled_eval_status` для всех rows MUST быть `pass`. Disabled
optional lane `skipped` остаётся runner-owned и MUST NOT дублироваться в row.
Malformed corpus, duplicate scenario
ID, invalid shape/bound/path/reference format или placeholder MUST давать
`integration_failure/adapter_admission`. Запрошенный ID, отсутствующий после
admission, MUST давать `integration_failure/runner/unknown_scenario`.

#### Scenario: Scenario с pending authority проверяется по facade owner
- **WHEN** scenario содержит covered или scope-expansion permission
- **THEN** harness сравнивает trace с requirement «Skill workflow
  делегирования», не вводя собственного permission policy

#### Scenario: Corpus v1 мигрирует существующие cases
- **WHEN** loader успешно принимает corpus v1
- **THEN** доступны все уникальные scenario IDs, объявленные самим corpus, а их
  lanes и outcomes совместимы с текущими eval contracts

#### Scenario: Corpus содержит дублирующийся ID
- **WHEN** два scenario используют один `scenario_id`
- **THEN** admission завершается `integration_failure/adapter_admission` до
  запуска Codex или Cursor

#### Scenario: Paired mutation sensitivity records an associated behavior difference
- **WHEN** a hosted sensitivity invocation first executes a fresh unchanged
  baseline, then installs the same payload with only the `events_lost` safety
  instruction removed and executes the same ordinary-goal retention-gap
  scenario
- **THEN** sensitivity passes only when the fresh baseline passes and the
  mutated run becomes `agent_behavior_mismatch` with exactly the corpus-owned
  `reported-outcome-mismatch`; final evidence links the baseline evidence and
  records one snapshotted corpus/scenario digest pair, the mutation name, the
  common pre-mutation skill digest and exact digests of both actually loaded
  baseline/mutated skills; source, corpus, scenario or loaded-payload drift is
  an `integration_failure`, never a valid paired result; the public sensitivity
  `EvalResultV1` maps this expected single
  underlying oracle failure to meta-assertion
  `fixture_assertion_outcome:"pass"` and `eval_status:"pass"`, while preserving
  the underlying `agent_behavior_mismatch`, failed assertion and exact mismatch
  in published evidence. If the fresh baseline fails, the outer failure MUST
  retain its already published baseline `evidence_ref` rather than orphan it.
  Because the hosted model run has no fixed seed or deterministic replay, this
  single baseline/mutation pair records a mutation-associated behavioral
  difference only; it MUST NOT be reported as proof that the removed
  instruction caused that difference. Replicated/control causal estimation is
  outside v1 scope.


The programmed rows MUST remain owned by the existing facade/runtime
requirements and MUST be evaluated from actual Codex MCP calls and safe fixture
effects, never from substring or regular-expression inspection of `SKILL.md`.
Each programmed row has the baseline exact keys plus optional `report_checks`,
`harness_faults` and `skill_sensitivity` under the closed grammars above.
When present, `report_checks` contains 1–3 unique closed objects with
`turn_index` in 1..`followups.length + 1`, 1–12 unique bounded
`required_fragments`, 0–12 unique bounded `forbidden_fragments`, and optional
1–12 unique `required_bindings` from `session_id`, `turn_id`,
`pending_request_id`, `cursor_session_id`, `resume_after_event_id`, `model`,
`effort`, `error_code`, `failure_kind`, `fast`, `plugin_dir`, `provider_error`,
`next_provider_operation_requires_new_user_decision`, `observation_gap`,
`history_reconstructed`, `evidence_scope`, `work_in_progress` and
`terminal_reason`, `terminal_receipt`, `terminal_result_sha256`. `plugin_dir` is the exact materialized canonical
fixture root and is admitted only when the same request has digest-matched
`plugin_dirs`; `provider_error` is the recording proxy's bounded public
`{code,message:{text,truncated}}` projection and never includes provider
`error.data`. All required bindings for one report check MUST occur inside one
parseable JSON evidence object. Scalar bindings use their exact field names,
except `pending_request_id` maps to `request_id`, `terminal_result_sha256` maps
to `terminal_receipt.result_sha256`, and `plugin_dir` maps to membership in
`plugin_dirs`; `next_provider_operation_requires_new_user_decision`,
`work_in_progress`, and `observation_gap` bind only to exact boolean `true`;
`history_reconstructed` binds only to exact boolean `false`, and
`evidence_scope` binds only to exact string `current_normalized_state`.
Structured `provider_error` binding requires exact full-object
equality with one observed error, with no missing, extra or cross-object fields.
`terminal_receipt` is likewise atomic over one observed bounded receipt and
requires exact full-object equality for its `session_id`, `turn_id`,
`turn_status`, `last_event_id`, nullable `result_sha256` and
`result_truncated`; a word such as
`terminal_receipt` or an unassociated digest is insufficient.
`terminal_reason` requires exact full-object equality for `text` and
`truncated`. Values found only in unrelated objects or prose are never
candidates. A report check matches only the terminal
`final_answer` (or legacy null-phase final) of that exact Codex turn; every
fragment and every turn-scoped value selected from the bounded MCP call range
of that exact Codex turn MUST occur, and every forbidden fragment MUST be
absent. Within that exact range, `session_id` and `turn_id` resolve from the
latest call carrying the respective value, so a close/resume sequence cannot
bind the abandoned wrapper while a newer wrapper is the reported outcome.
Session-scoped retained bindings `cursor_session_id`, `model`, `effort`,
`fast` and `plugin_dir` instead MUST resolve only from the latest
observed successful allocate/resume call before the report boundary: this is
the current runtime-session segment provenance, not arbitrary prior report
text. A newer allocate/resume supersedes the closed/tombstoned segment, so its
IDs or launch values are not candidates. Values from a later Codex turn are
never candidates; `terminal_receipt`, `terminal_reason` and `provider_error`
remain exact current-turn atomic bindings. Thus caller-held state continuity is
provable without accepting fixture prose or stale values. Without `report_checks`,
reported outcome keeps the last-terminal safe-token rule; the semantic-failure
token is exactly `CURSOR_EVAL_FAILED`. A missing or mismatched report contract
gives `not_reported` even when MCP trace and fixture effect are correct.

The `followups` array contains 0–2 unique closed objects. A follow-up MAY carry
1–8 unique closed `granted_actions` with the same action grammar as
`prior_authority`; the oracle applies them only from that distinct user turn.
Every observed `effect.file-*` and `answer.permission` record MUST carry a
positive safe-integer `codex_turn_index`; absence or an invalid value is an
authority mismatch rather than permission to skip provenance validation. Its
value MUST be at most `followups.length + 1` and MUST NOT decrease across
authority-scoped observations. Для каждой observation oracle заново строит
authority из immutable initial grants и только тех distinct follow-up turns,
 чей index уже достигнут; future-turn grants и глобально мутирующая authority
запрещены.
Every programmed effect step MUST have exactly one compatible
`effect.file-read | effect.file-written` observation in `expected_trace`, and
the observer MUST project each successful safe-evidence effect into the causal
turn trace before its terminal observation regardless of whether that turn
becomes `completed`, `failed` or `timed_out`. Separate effect/callback records
cannot substitute for that authority-bearing trace observation.
A pending or terminal anchor is exactly
`{after_kind:"pending | terminal",after_step,input,granted_actions?}`
and MUST reference a compatible program step. A timeout anchor is exactly
`{after_kind:"wait-timeout",input}` and requires a preceding expected
`turn.wait-timeout`. Harness MUST wait for the anchor, then for the exact current
Codex turn to become terminal, capture that turn's final report, and only then
start the follow-up as a distinct Codex user turn.

Harness still requires a close attempt for every allocated live session unless
the fixture proves that its ACP child independently exited after a terminal
result and the wrapper was already tombstoned. That recovery case MUST retain
the provider ID and use explicit resume; it MUST NOT manufacture a redundant
close solely to satisfy the oracle.

An effect step MAY use `operation:"read"` with an expected
`{ "kind":"read-result", "outcome":"succeeded" }` callback, or the existing
write form. Its admitted trace kind is respectively `effect.file-read` or
`effect.file-written`. A `session.allocated` trace MAY additionally carry
`mode:"ask | plan | agent"` when a scenario owns an exact mode assertion;
`session.mode-changed` MUST carry the exact requested mode and has no step ID.
A `prompt-check` program step owns bounded required/forbidden fragments for one
actual ACP prompt. The fake provider MUST retain only
`prompt.contract:{step_id,matched:boolean}` safe evidence, never raw prompt text;
the trace requires `matched:true`, so the oracle rejects a prompt that omitted
the operator constraints even when the MCP tool sequence is otherwise correct.
A programmed
scenario MAY contain multiple terminal steps and multiple `turn.started`
observations in one runtime session, but every started turn MUST have a distinct
opaque turn ID and all observations MUST retain the same runtime session ID.

The closed program shape MAY contain
`resume_step_index`, a safe integer from 1 through `steps.length - 1`; the
indexed step MUST be `prompt-check` and starts the resumed provider program.
The exact step variants additionally admit:

- `prompt-check`: exact keys `type`, `step_id`, `required_fragments` and
  `forbidden_fragments`; the required list contains 1–12 unique 1–256-byte
  strings and the forbidden list 0–12 such strings;
- `notification`: exact keys `type`, `step_id`, `notification_kind`, where
  kind is exactly `todos | task | image`;
- `event-burst`: exact keys `type`, `step_id`, `count`, where `count` is a safe
  integer from 257 through 512. The fixture MUST emit that many admitted
  collaboration requests with distinct provider request IDs and acknowledge
  every request; ordinary agent-message chunks do not satisfy this step;
- `terminal` MAY additionally carry `delay_ms`, a safe integer 1–5000, and
  `progress_text`, a 1–512-byte string.

The closed trace grammar admits:

- `session.allocated` with optional exact `mode`, `model:string`,
  `effort:string`, `fast:boolean`,
  `plugin_dirs_count` in 1–16 and `plugin_dirs_matched:true`; the latter is a
  digest comparison against the materialized canonical `${PLUGIN_DIR}`, not a
  retained path;
- `session.resumed` with exact `matched:true`, optional exact `model:string`,
  `effort:string` and `fast:boolean`, and a new runtime session ID;
- `session.resume-failed` with exact `matched:true`, a new terminal runtime
  session ID and no replacement delegation;
- `session.mode-change-failed` with exact `error_code:"mode_timeout"` or
  `error_code:"protocol_error"`, the runtime session ID observed on the failed
  set-mode request and no fabricated turn ID; an injected live-wrapper
  protocol-error variant is followed by `session.mode-recovery-status` with
  exact `session_state:"live"` and `active_turn:false`, while a provider
  rejection is followed by `session.tombstoned` and bounded `provider_error`;
- `session.tombstoned` after an observed old-wrapper response with exact
  `session_state:"tombstone"`;
- `turn.wait-timeout` and `turn.wait-recovered` with exact `timeout_ms` in
  1000–180000, boolean `timeout_omitted`, `cursor_matched:true` and
  `progress_revision_matched:true`; `timeout_omitted:true` is valid only with
  effective `timeout_ms:30000`, while explicit retries use `false`;
- `turn.events-lost` with `events_lost:true` and `cursor_matched:true`, derived
  from the actual sparse wait response rather than expected scenario prose;
- `turn.receipt` with a terminal `step_id`, `matched:true` and boolean
  `result_truncated`;
- `prompt.contract` with a prompt-check `step_id` and `matched:true`;
- `progress.todos`, `progress.task` and `progress.image` with the matching
  notification `step_id`;
- `effect.file-read` for the admitted read effect.
- `turn.timed-out` for an observed terminal runtime status correlated with a
  fixture-armed terminal step, never reconstructed from `expected_trace`;
- `turn.failed` for an observed provider-rejected terminal runtime status
  correlated with its fixture-armed failed terminal step;
- `answer.rejected-stale` with a pending step and exact
  `error_code:"unknown_request"`; a later repeated pending observation plus the
  admitted answer proves that Codex performed a fresh wait before retrying.

`session.resumed` and terminal `session.resume-failed` are the only observations
allowed after a close and reset the
runtime-session identity while proving the same returned opaque provider
session ID was used. Wait recovery MUST preserve the returned event cursor and
progress revision. Every receipt and progress observation MUST reference its
compatible program step; all existing ID, ordering, close and forbidden
observation rules continue to apply.
For the wait that first provides `failed | timed_out` terminal evidence,
`session_state:"closing"` and `session_state:"tombstone"` are normalized to the
same ordered terminal plus receipt evidence. The transient/final wrapper state
MUST NOT insert a `session.tombstoned` observation or make an otherwise
identical failure scenario scheduling-dependent; an explicit close attempt
remains the eval-end lifecycle observation. For a completed turn,
`session_state:"tombstone"` is wrapper-loss evidence and MUST be ordered after
the terminal receipt, whether it arrives in that first terminal wait or a later
old-wrapper call, so an explicit resume can follow directly.

#### Scenario: File review доказывает read-only effect
- **WHEN** hosted Codex следует установленному skill для `model-file-review`
- **THEN** exact evidence содержит `delegate → wait → close`, один admitted
  `effect.file-read` с successful callback и ни одного write effect; delegated
  prompt связывает этот read с exact prior authority через
  `AUTHORIZED_ACTIONS: read <bounded-path> only.` и `NO_SCOPE_EXPANSION`, не
  разрешая read/search остальных paths в `cwd`

#### Scenario: Snapshot review остаётся tool-free
- **WHEN** hosted Codex следует установленному skill для
  `model-snapshot-review`
- **THEN** exact evidence подтверждает allocation в `ask`, terminal result и
  close без file effect или дополнительного runtime operation

#### Scenario: Multi-turn review сохраняет live session
- **WHEN** первый review turn terminal и требуется следующий stage с иной mode
- **THEN** exact evidence содержит `cursor_set_mode`, затем
  `cursor_send_prompt` и второй terminal turn с тем же session ID, после чего
  выполняется единственный close; новая delegation и resume отсутствуют

#### Scenario: Critic repeat передаёт delta, а не baseline повторно
- **WHEN** hosted Codex выполняет `model-critic-delta` в одной live session
- **THEN** safe prompt predicates подтверждают baseline digest на обоих turns,
  exact changed path/delta на втором turn и отсутствие неизменившегося snapshot;
  raw prompt в evidence не сохраняется

#### Scenario: Wait, receipt и resume проверяются одной recovery цепочкой
- **WHEN** первый wait возвращает resumable timeout с progress revision, затем
  turn завершается и ACP child независимо исчезает, tombstoning the wrapper
- **THEN** следующий wait использует returned event cursor и progress revision
  с увеличенным timeout, evidence проверяет immutable terminal receipt и
  observable old-wrapper tombstone, а
  `cursor_resume_session` attempts the retained provider ID in a new runtime
  session без fallback delegation; successful load itself is not semantic
  history proof

#### Scenario: Active-turn follow-up ждёт подтверждённую terminality
- **WHEN** user sends a separate Codex follow-up after the first Codex turn
  reported a resumable wait timeout while Cursor remained active
- **THEN** Codex ждёт terminal result и затем использует `cursor_send_prompt` в
  той же live session; fake ACP причинно удерживает terminality до observable
  start отдельного follow-up turn, а не полагается на wall-clock delay;
  несуществующий public steering tool не вызывается

#### Scenario: Stale pending ID требует fresh wait
- **WHEN** отдельный user follow-up сначала использует заведомо stale request ID
- **THEN** trace содержит `answer.rejected-stale`, затем повторный pending из
  fresh `cursor_wait` и ровно один admitted answer с актуальным ID

#### Scenario: Launch options и collaboration progress наблюдаемы
- **WHEN** user явно выбирает agent model settings, локальный `plugin_dirs` bundle
  и одну покрытую запись
- **THEN** exact delegate request содержит эти launch choices, wait доставляет
  admitted todo/task/image progress, write effect и terminal receipt, после
  чего workflow закрывается

#### Scenario: Invalid plugin directory не вызывает fallback
- **WHEN** ordinary user goal выбирает отсутствующий Agent Plugin directory
- **THEN** Codex сообщает exact `scope_rejected`, не копирует skill, не расширяет
  allowed roots, не инжектит raw provider configuration и не запускает provider

#### Scenario: Initial provider failure не вызывает wait или fallback
- **WHEN** an ordinary delegation receives an allocated init tombstone without
  `turn_id`
- **THEN** Codex reports exact `session_id`, `failure_kind` and bounded
  `provider_error`, while evidence contains no wait, retry, resume or replacement
  delegation

#### Scenario: Prompt provider failure не вызывает automatic recovery
- **WHEN** a live allocated turn is rejected by the provider
- **THEN** exact MCP evidence yields `turn.failed` and a null-result terminal
  receipt, actual and reported outcomes are failed, the report binds the exact
  bounded `provider_error`, and evidence contains no retry, resume or
  replacement delegation

#### Scenario: Mode timeout не запускает prompt или automatic recovery
- **WHEN** the provider does not answer an idle between-turn mode transition
- **THEN** exact MCP evidence yields `session.mode-change-failed` with
  `mode_timeout`, actual and reported outcomes are failed, and no prompt,
  repeated transition, resume or replacement delegation occurs before a new
  user decision

#### Scenario: Pre-provider mode rejection preserves a live wrapper
- **WHEN** a between-turn mode call receives `protocol_error` while the wrapper
  remains live and idle
- **THEN** the skill performs one diagnostic status read, reports the exact
  live/no-active-turn state, sends no prompt, and does not claim wrapper loss or
  require a new user decision; after the evaluation stage is complete it closes
  that still-live runtime session

#### Scenario: Active follow-up не переживает failed terminal автоматически
- **WHEN** a user follow-up arrives after a wait timeout but the addressed
  active turn then terminalizes as failed
- **THEN** evidence contains no second `turn.started` or prompt contract, the
  report preserves exact failure evidence, fake ACP releases that failure only
  after observable start of the separate Codex follow-up turn, and another
  provider operation requires a new post-failure user decision

#### Scenario: Terminal timeout не маскируется wait timeout
- **WHEN** runtime terminalizes an active turn as `timed_out`
- **THEN** exact MCP evidence yields `turn.timed-out`, actual task outcome is
  failed, and the Codex report calls the outcome interrupted rather than success

#### Scenario: Failed resume не создаёт replacement delegation
- **WHEN** a dead wrapper is followed by a provider load rejection
- **THEN** evidence contains an exact-ID `session.resume-failed`, actual and
  reported workflow outcomes are failed, and no replacement delegation occurs

#### Scenario: Cursor artifact остаётся для user decision
- **WHEN** authorized agent work creates a temporary file without delete authority
- **THEN** the workspace predicate proves the file still exists after close and
  the Codex report names it as preserved

#### Scenario: Launch-only settings change through explicit resume
- **WHEN** a later user turn requests different model settings for the retained
  provider ID
- **THEN** Codex closes the live wrapper, explicitly resumes with the new
  settings, verifies the next result, and never starts an independent delegation

#### Scenario: Retention gap не реконструируется
- **WHEN** a real wait reports `events_lost:true` after bounded-log eviction
- **THEN** Codex reports the gap, uses only current normalized state and terminal
  evidence, and does not claim reconstructed intermediate history

### Requirement: Cost-aware execution policy
Corpus admission, canonical materialization, pure-oracle evaluation всех
`programmed` rows и reference/selection/result/evidence plumbing единственного
`package-canary-reference` MUST выполняться одним top-level table-driven unit
test. Test body MUST иметь finite runaway bound, который MUST NOT трактоваться
как standalone wall-clock SLO. Количества admission/materialization/oracle MUST вычисляться из
admitted corpus; fixed row/programmed counts и полный scenario-ID allowlist вне
corpus запрещены. Pure oracle MUST NOT вызываться для package reference.

Одна side-effect-free scenario-contract module surface MUST предоставлять pure
admission, materialization и oracle functions; imports MUST не создавать
child process, сеть или credentials. Table-driven test вызывает только эти pure
operations, без runner/harness и process-per-scenario. Real-Codex
client-integration, hosted-model и full-live runs остаются отдельными foreground
commands и не входят в unit coverage как scenario executions. Owner
`node-test-supervision` MAY предоставлять dedicated `eval` lane и focused
selection для этих explicit opt-in commands; eval capability не дублирует его
process lifecycle, result artifacts или lane schema. Supervisor mapping
проверяется cheap injected spawn/env contract test без вложенного `unit` или
`coverage`. Полные foreground `unit` и `coverage` выполняются по одному разу в
acceptance; duration и scenario count MAY быть только TAP diagnostics.

Новые или изменённые eval/driver tests с реальным filesystem/process I/O MUST
использовать per-test `mkdtemp` и не разделять mutable state между files;
no-I/O contract tests MAY использовать inert injected path strings. Такие
eval/driver tests MUST NOT изменять shared `process.env`.

#### Scenario: Corpus проверяется дешёвым динамическим слоем
- **WHEN** выполняется unit contract test
- **THEN** один table-driven test принимает и материализует каждый admitted
  row, оценивает oracle-ом каждый programmed row и проверяет plumbing одной
  package reference без runner/harness, fixed counts и process-per-scenario

#### Scenario: Exact-seven corpus проверяется дешёвым слоем
- **WHEN** legacy scenario name проверяется после расширения corpus
- **THEN** `Exact-seven` трактуется только как сохранённое имя scenario, а test
  выводит все counts из admitted corpus и не требует legacy cardinality

#### Scenario: Hosted scenario не включён явно
- **WHEN** запускается обычный unit или coverage lane без hosted/live opt-in
- **THEN** cheap contract подтверждает command mapping без запуска real-Codex,
  hosted-model или full-live process
