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
expected `eval_status` и evidence predicate.
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
close attempt единого owner согласно runtime requirement «Ограниченный жизненный цикл
ACP-процесса», кроме fixture-доказанного natural child exit после terminal
result или уже tombstoned wrapper. Explicit resume не отменяет cleanup: старый
live wrapper закрывается до resume, а resumed wrapper проверяется по новому
current runtime `session_id` тем же single close owner. Идемпотентность close
остаётся runtime-owned. Сценарии writing
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
`expected_enabled_eval_status`, `report_checks`, а также MAY иметь
`harness_faults`.
Ровно один row MUST быть reference-only object с ровно
`scenario_kind: "package-canary-reference"`, уникальным kebab-case `scenario_id`,
`lane: "full-live"`, одним `owner_requirements` element
`{ "capability":"cursor-plugin-distribution",
"requirement":"Проверяемая чистая установка" }` и
`expected_enabled_eval_status: "pass"`. Programmed fields input, authority,
program, followups, trace, observations, predicate, task outcome и programmed
report fields в нём MUST
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
`mode-timeout`, `accelerate-turn-timeout`,
`accelerate-wait-timeout`, `exit-after-result`,
`hold-terminal-until-followup`, `inject-mode-protocol-error-once`,
`inject-stale-question-once`,
`reject-initialize`, `reject-mode`, `reject-prompt`, `result-overflow` и `reject-resume`. Это единственный scenario-level
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
`result-overflow` requires the same failed-terminal/predicate/trace pairing,
is mutually exclusive with `reject-prompt`, and makes the provider fixture
emit a finite agent-text stream that crosses the runtime IUX-20 retention cap.
Exact stream construction belongs to the fixture, not a second runtime limit;
`mode-timeout` требует predicate `mode-change-failed:mode_timeout`
и expected `session.mode-change-failed`;
`inject-mode-protocol-error-once` требует predicate
`mode-recovery-status:live:false`, expected
`session.mode-change-failed:protocol_error` и следующий
`session.mode-recovery-status:live:false`, followed by the normal final
`session.close-attempted` because the wrapper remains live;
`reject-mode` требует predicate `mode-change-failed:protocol_error`, expected
`session.mode-change-failed:protocol_error`, следующий `session.tombstoned` и
transcript/evidence comparison `provider_error`; injected и provider-originated mode faults
взаимоисключающи;
`accelerate-turn-timeout` требует predicate
`terminal-status:timed_out` и expected `turn.timed-out`;
`mode-timeout` проверяет runtime-owned fixed 15-second mode-control deadline без
preload acceleration; `accelerate-turn-timeout` сокращает только runtime-owned
one-hour turn deadline; каждый accelerator действует лишь при своём exact fault
flag и MUST NOT менять другие timer classes;
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
  A failed terminal MUST be paired with exactly one of `reject-prompt` or
  `result-overflow` harness
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
`answer-before-pending`, `operation-after-close` и `unexpected-effect`.
Конфиденциальность raw provider payload принадлежит
recording-proxy behavioral test, а не искусственному corpus observation.
Session-level observations require only the `session_id` actually present in
their MCP request/response; an optional `turn_id` is admissible only when that
same operation exposes it. They MUST NOT inherit a previous mutable turn ID.
Turn-level observations require both IDs from their actual call or bounded
result.

ID provenance имеет здесь одного normative eval owner. Transcript proof MUST
быть одним из двух closed shapes: legacy
`{calls,dropped_calls}` либо recovery-capable
`{calls,dropped_calls,turn_call_ranges,unexpected_input_requests}`. Legacy proof
остаётся допустимым для обычной проверки, но не может доказать recovered call.
В full proof `turn_call_ranges` MUST содержать по одному closed `{start,end}`
safe-integer range на admitted capture по owner «Eval transcript plumbing и
process verdict». Ranges без gaps или overlap MUST образовывать
полную последовательную partition `[0,calls.length)`; persisted
`unexpected_input_requests` MUST быть nonnegative safe integer. Любая другая
shape или неполная partition MUST быть отклонена как malformed transcript proof,
а не ослаблять ID oracle.

Recovery-capable proof MUST сохранять ordered raw record каждого MCP call и его
фактический normalized success/error result. Capture каждого plain-object
request MUST также сохранить lower-hex SHA-256
`arguments_without_session_turn_sha256`, вычисленный над canonical raw
arguments после удаления только `session_id` и `turn_id`; `request_id` и все
остальные properties остаются в digest domain. Этот digest служит только
детерминированной проверке equality и не является privacy или integrity
гарантией.

Oracle MAY признать recovery только по full proof с `dropped_calls:0` и
`unexpected_input_requests:0`. В одном complete `turn_call_ranges` segment MAY
быть ноль или больше непересекающихся recovery spans. Каждый span содержит
ровно один rejected call и один corrected successful call того же tool; между
ними MAY находиться ноль или больше contiguous successful
`cursor_session_status` с exact pure request `{session_id:current}` без других
arguments в пределах bounded transcript. Иной interleaving внутри span и
overlap запрещены; второй rejection до corrected success оставляет первый call
unrecovered. Дополнительных user inputs быть не может. Raw calls и
normalized error сохраняются; corrected success всё равно MUST пройти обычные
trace, ordering, authority, callback, effect и exact-delivery checks.

Finite recovery taxonomy допускает ровно три класса:

- `address`: у existing-session tool изменяется непустое подмножество только
  `session_id`/`turn_id`, включая missing, malformed или несколько неверных IDs;
  success использует current causal public IDs, non-address arguments digests
  exact equal, а rejected error равен применимому
  `invalid_args | invalid_text_encoding | unknown_session | unknown_turn`;
- `wait_state`: у `cursor_wait` изменяется непустое подмножество
  `session_id`, `turn_id`, `after_event_id`, `after_progress_revision`; success
  использует current IDs и exact latest public event/progress cursors, timeout
  остаётся identical. Digest каждого call MUST совпасть с canonical
  reconstruction его captured wait non-ID arguments; hidden/invalid extras
  запрещены. Rejected error равен применимому
  `invalid_args | invalid_text_encoding | unknown_session | unknown_turn`.
  Переход от captured `{}` к current IDs плюс latest `after_event_id` является
  допустимым вариантом;
- `set_mode`: rejected `cursor_set_mode` имеет `invalid_args`, success использует
  current session ID, а отсутствующий/non-enum mode исправлен на admitted enum;
  address MAY быть исправлен одновременно. Обычный expected trace MUST доказать
  exact authorized mode transition.

Launch/delegate/start/resume, result-read offset и local answer-shape repair,
direct `request_id` correction, historical/ungrounded IDs,
`resource_limit | scope_rejected | protocol_error | mode_timeout` или provider
errors, prompt mutation, other tool/turn и любая delta вне соответствующего
typed класса MUST оставаться mismatch. Без full four-key proof recovery нет.

Oracle MUST recompute `recovered_calls` как массив closed records
`{failed_call_index,successful_call_index,codex_turn_index,tool,error_code,correction_kind}`
с one-based indexes и `correction_kind` exactly
`address | wait_state | set_mode`; отдельный count или corrected-fields list не
хранится, authoritative delta выводится из indexed raw calls. Observer MAY
пропустить semantic trace projection failed call только для verified pair;
каждый иной raw lookup/validation failure остаётся mismatch, даже если
normalized trace его не спроецировал. Это recovery evidence, а не доказательство
истинности свободного prose, которое остаётся `not_checked`.

`unknown_request` не входит в эту adjacent-pair exception: existing
`answer.rejected-stale` contract сохраняет distinct fresh wait, repeated pending
и единственный admitted answer с returned current `request_id`.
Отсутствие close не является observation: oracle отдельно применяет
close-or-proven-natural-tombstone rule, определённый выше.
Exact complete full-result reread с теми же session/turn IDs, page chain, total
и digest MAY быть схлопнут как idempotent trace variation даже после close, пока
result retained. Invalid/partial reread и первый complete read только после
close MUST оставаться mismatch. После natural tombstone сохраняется один
required idempotent close observation; repeated closes являются mismatch.

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

The programmed rows MUST remain owned by the existing facade/runtime
requirements and MUST be evaluated from actual Codex MCP calls and safe fixture
effects, never from substring or regular-expression inspection of `SKILL.md`.
Each programmed row has the baseline exact keys including `report_checks`, plus
optional `harness_faults` under the closed grammars above. `report_checks` проверяет
только exact user-visible delivery, явно заданную corpus/program/fixture.

`report_checks` contains 0–9 closed objects with exact keys
`turn_index`, `category`, `required_fragments`, `forbidden_fragments`.
`turn_index` is in 1..`followups.length + 1`; `category` is exactly
`interaction`; the pair is unique within a scenario. `required_fragments`
contains 1–12 unique nonempty 1–256-byte literal strings;
`forbidden_fragments` contains 0–12 unique nonempty 1–256-byte literal strings.
Matching is case-sensitive literal containment over the captured text. Every
fragment MUST be exact requested/user-visible data supplied by the corpus,
program or fixture: marker/result token, pending question, visible option label
or plan content. Alternative arrays, author-created paraphrases, language or
template conditions, safety/outcome phrases, negation semantics, regex, fuzzy
matching, translation, model judging and JSON parsing are not admitted. An
empty array selects only the generic mandatory nonempty-final delivery check;
omitting `report_checks` is an admission failure.

`required_bindings` is no longer admitted in a report check. Existing corpus
rows MUST migrate explicitly: final-copy ID/receipt/launch checks move to their
existing transcript/evidence owner. The loader MUST reject unmigrated bindings.
Full JSON, prose and list answers remain acceptable when their text contains the
same exact requested data. No derived fallback outcome exists. `FILE_REVIEW_OK`
is an exact interaction-delivery marker and never evidence of reported outcome.

Захват final и completeness proof определены в «Eval transcript plumbing и
process verdict»; report assertions используют только этот admitted capture.
Final каждого фактически начатого model-behavior Codex turn MUST существовать
и быть непустым даже при пустом
`report_checks`: `confirmed_missing` и complete empty
final являются `agent_behavior_mismatch` компонента interaction delivery, а
incomplete capture является `integration_failure`.

Continuation within the same Codex task MUST be checked from actual MCP
dataflow under the existing trace/ID invariants: next calls consume the
previously returned active IDs and pending request in their causal order.
Successful waits MAY omit `after_event_id` or use any earlier/repeated
runtime-valid value; latest `resume_after_event_id` is a recommended sparse
default, not read acknowledgement evidence. A new wrapper supersedes the old
segment; future or invalid values are
not valid candidates. Missing IDs in final prose alone are not a failure.
No final-only external consumer or new handoff protocol is admitted here.

Evidence integrity reuses existing runtime/provider observations, including
the receipt-to-result comparison, rather than a second shape-only algorithm.
Missing or corrupt required evidence, dropped calls and unconfirmed extraction
are inspection failures. A correctly observed runtime operation violating its
contract remains an execution failure; it MUST NOT be hidden as an
infrastructure error. Exact receipt, reason and provider-error values remain
atomic and turn-scoped in evidence; hashes are compared with independently
observed bounded provider results where the scenario requires that comparison.
An absent receipt is valid only for a branch whose runtime contract does not
return one. Provider `error.data` stays excluded.

Компоненты и итоговая классификация определены в «Outcome model и
диагностические доказательства»; corpus задаёт ожидания, а не второй classifier.

#### Scenario: Exact token не зависит от оформления report
- **WHEN** complete final содержит exact запрошенный token
- **THEN** interaction delivery проходит независимо от prose/list/JSON
  оформления; continuation и receipt проверяются только evidence checks

#### Scenario: File review сообщает user marker без provider sentence
- **WHEN** complete final содержит `FILE_REVIEW_OK` в корректном prose, но не
  повторяет полное предложение provider result
- **THEN** exact interaction check проходит, а reported outcome остаётся
  `not_checked`

#### Scenario: Длинный review дочитывается до отчёта
- **WHEN** обычная review-задача возвращает truncated preview с user-required
  marker только в хвосте полного runtime result
- **THEN** Codex использует runtime IUX-20 read path до final report/close,
  сообщает marker из прочитанного хвоста и не запускает provider regeneration;
  eval проверяет composition, не дублирует paging/лимиты runtime

#### Scenario: Overflow результата не выдаётся за полное review
- **WHEN** runtime завершает review через IUX-20 overflow failure
- **THEN** eval проверяет failed terminal, отсутствие regeneration и required
  close/recovery mechanics по trace; свободный prose о полноте не оценивается

#### Scenario: Неполное извлечение не обвиняет модель
- **WHEN** final находится за первой страницей или capture не завершён
- **THEN** adapter читает оставшиеся items либо сохраняет inspection failure;
  только подтверждённое отсутствие final классифицируется как report omission

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
`turn.wait-timeout`. Harness MUST wait until either the anchor or the exact
current Codex turn becomes terminal. After an anchor it waits for and captures
that exact turn before starting the follow-up as a distinct Codex user turn.
If a completed terminal appears first, it MUST capture that turn and MUST NOT
start the planned follow-up or any later turn.

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
- for `session.allocated | session.resumed`, omitted expected `effort` or `fast`
  leaves that observed field unconstrained; when declared it MUST match exactly.
  This exception does not relax kind/order, exact `mode`/`model` presence and
  value, required `matched`, runtime-session identity or plugin-root proof;
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
  1000–180000, boolean `timeout_omitted` and
  `progress_revision_matched:true`; `timeout_omitted:true` is valid only with
  effective `timeout_ms:30000`, while explicit retries use `false`;
- `turn.events-lost` with `events_lost:true`, derived
  from the actual sparse wait response rather than expected scenario prose;
- `turn.receipt` with a terminal `step_id`, `matched:true` and boolean
  `result_truncated`;
- `turn.result-read` with `complete:true`, emitted only after actual
  `cursor_read_result` calls reach EOF from offset zero using returned
  continuation values for that turn; it proves workflow composition and does
  not define a second paging/hash/retention algorithm;
- `prompt.contract` with a prompt-check `step_id` and `matched:true`;
- `progress.todos`, `progress.task` and `progress.image` with the matching
  notification `step_id`;
- `effect.file-read` for the admitted read effect.
- `turn.timed-out` for an observed terminal runtime status correlated with a
  fixture-armed terminal step, never reconstructed from `expected_trace`;
- `turn.failed` for an observed failed terminal runtime status correlated with
  its fixture-armed failed terminal step and selected fault; overflow evidence
  uses the IUX-20 reason, not a fabricated provider error, and MUST NOT include
  a successful `turn.result-read`;
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
- **THEN** следующий wait использует те же runtime IDs, returned progress
  revision и увеличенный timeout; event cursor может быть latest, earlier
  runtime-valid или omitted=0. Evidence проверяет immutable terminal receipt и
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

#### Scenario: Typed pre-effect correction проверяется прозрачно
- **WHEN** full raw transcript содержит один или несколько disjoint spans класса
  `address | wait_state | set_mode` и только contiguous successful pure
  current-session status reads внутри каждого span complete range того же turn
- **THEN** oracle сохраняет rejected calls, recomputes один typed
  `recovered_calls` record на span и проверяет каждый successful call по обычным trace,
  authority, effect и delivery invariants

#### Scenario: Safe rejection без достаточного grounding остаётся mismatch
- **WHEN** transcript содержит result-read offset или answer-shape correction,
  overlapping/unfinished span, repeated rejection до success,
  non-pure/noncontiguous status либо неполный proof
- **THEN** oracle сохраняет raw evidence и возвращает mismatch без recovery

#### Scenario: Полный retained result reread схлопывается идемпотентно
- **WHEN** trace повторяет exact complete page chain с теми же IDs, total и
  digest, включая retained reread после close
- **THEN** oracle схлопывает повтор; partial/invalid либо первый post-close read
  и repeated close остаются mismatch

#### Scenario: Launch options и collaboration progress наблюдаемы
- **WHEN** user явно выбирает agent model settings, локальный `plugin_dirs` bundle
  и одну покрытую запись
- **THEN** exact delegate request содержит эти launch choices, wait доставляет
  admitted todo/task/image progress, write effect и terminal receipt, после
  чего workflow закрывается

#### Scenario: Invalid plugin directory не вызывает fallback
- **WHEN** ordinary user goal выбирает отсутствующий Agent Plugin directory
- **THEN** exact delegate/start evidence содержит normalized `error_code`
  `scope_rejected`, а trace не копирует skill, не расширяет allowed roots, не
  инжектит raw provider configuration и не запускает provider; captured final
  проверяется только как generic nonempty delivery, свободный prose не оценивается

#### Scenario: Initial provider failure не вызывает wait или fallback
- **WHEN** an ordinary delegation receives an allocated init tombstone without
  `turn_id`
- **THEN** actual failure, exact IDs и provider diagnostics остаются в evidence,
  которое не содержит wait, retry, resume или replacement delegation;
  свободное объяснение и reported outcome не оцениваются

#### Scenario: Prompt provider failure не вызывает automatic recovery
- **WHEN** a live allocated turn is rejected by the provider
- **THEN** exact MCP evidence yields `turn.failed` and a null-result terminal
  receipt, actual outcome is failed, reported outcome is `not_checked`, and
  evidence contains no retry, resume or
  replacement delegation

#### Scenario: Mode timeout не запускает prompt или automatic recovery
- **WHEN** the provider does not answer an idle between-turn mode transition
- **THEN** exact MCP evidence yields `session.mode-change-failed` with
  `mode_timeout`, actual outcome is failed, reported outcome is `not_checked`, and no prompt,
  repeated transition, resume or replacement delegation occurs before a new
  user decision

#### Scenario: Pre-provider mode rejection preserves a live wrapper
- **WHEN** a between-turn mode call receives `protocol_error` while the wrapper
  remains live and idle
- **THEN** exact trace/status evidence contains one diagnostic status read with
  the live/no-active-turn state, no prompt, no replacement or resume, and a final
  close of that still-live runtime session; free prose is not scored

#### Scenario: Active follow-up не переживает failed terminal автоматически
- **WHEN** a user follow-up arrives after a wait timeout but the addressed
  active turn then terminalizes as failed
- **THEN** evidence contains no second `turn.started` or prompt contract, the
  tool transcript preserves exact failure evidence; fake ACP releases that failure only
  after observable start of the separate Codex follow-up turn, and another
  provider operation requires a new post-failure user decision

#### Scenario: Terminal timeout не маскируется wait timeout
- **WHEN** runtime terminalizes an active turn as `timed_out`
- **THEN** exact MCP evidence yields `turn.timed-out`, actual task outcome is
  failed, while reported outcome remains `not_checked`

#### Scenario: Failed resume не создаёт replacement delegation
- **WHEN** a dead wrapper is followed by a provider load rejection
- **THEN** evidence contains an exact-ID `session.resume-failed`, actual outcome
  is failed, reported outcome is `not_checked`, and no replacement delegation occurs

#### Scenario: Cursor artifact остаётся для user decision
- **WHEN** authorized agent work creates a temporary file without delete authority
- **THEN** the workspace predicate proves the file still exists after close and
  the report names it only when the exact path token is explicitly requested

#### Scenario: Launch-only settings change through explicit resume
- **WHEN** a later user turn requests different model settings for the retained
  provider ID
- **THEN** Codex closes the live wrapper, explicitly resumes with the new
  settings, verifies the next result, and never starts an independent delegation

#### Scenario: Retention gap не реконструируется
- **WHEN** a real wait reports `events_lost:true` after bounded-log eviction
- **THEN** trace confirms the retention gap and subsequent operations consume
  only current normalized state and terminal evidence; free prose is not scored

### Requirement: Eval transcript plumbing и process verdict
Eval harness MUST передавать pure scenario oracle фактическую bounded
упорядоченную MCP trace. Trace MUST сохранять порядок вызовов, opaque IDs,
успех/ошибку каждого вызова и факт отброшенных bound-ом вызовов. Harness MUST
NOT реконструировать ожидаемые observations из scenario program.

Включённый eval с `integration_failure` или `agent_behavior_mismatch` MUST
напечатать один валидный `EvalResultV1` в stdout и завершиться ненулевым exit
code. Только `pass` и явно выключенный `skipped` MUST завершаться с exit code
`0`.


Each report check MUST use only the final message of its exact Codex turn;
commentary, tool output and later-turn messages are not substitutes. The
version-specific Codex adapter owns exact item/phase/schema interpretation.
The harness MUST capture the complete final before follow-up or cleanup and
publish the evaluated text, Codex turn identity, observed phase, extraction
source and completeness status in local evidence. Every required page/item
MUST be read within bounded capture limits. A confirmed complete turn with no
final is a report failure; failed/incomplete extraction, unsupported adapter
shape or capture-limit overflow is `integration_failure`, not model omission.
Truncated text MUST NOT be scored as a complete report. Golden fixtures MUST
cover final extraction, including late/paginated items and a truly absent final.
Only the isolated eval report is retained; credentials, request parameters,
private history and raw provider prompts MUST NOT be added to diagnostics.

Admitted captures MUST form a nonempty contiguous prefix `turn_index:1..N`
containing every actually started Codex turn. A smaller count than
`followups.length + 1` is admitted only after a fully observed early completed
terminal and only for `agent_behavior_mismatch`; pass requires the full count.
No capture may be invented for an unstarted turn. Missing recorder proof, an
uncaptured started turn, malformed/gapped prefix or incomplete extraction
remains `integration_failure` under the outcome classifier.

#### Scenario: Early terminal before the required anchor
- **WHEN** the exact current Codex turn completes before its required anchor
- **THEN** harness captures its final, starts no follow-up, and publishes only
the actual-turn prefix; a zero-call range requires a published recorder artifact
and proof of the selected MCP server's live connection. With complete evidence
and successful cleanup the missing planned continuation is
`agent_behavior_mismatch`, while missing recorder/connection proof or an
uncaptured started turn is `integration_failure`.

#### Scenario: Transcript передаётся без реконструкции
- **WHEN** harness передаёт trace в pure oracle
- **THEN** trace сохраняет фактически observed порядок, IDs, outcomes и
dropped-call evidence без program-driven additions

#### Scenario: Включённый eval завершается ошибкой
- **WHEN** включённый eval классифицирован как `integration_failure` или
`agent_behavior_mismatch`
- **THEN** stdout содержит один `EvalResultV1`, а процесс завершается nonzero

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
  "reported_task_outcome": "not_checked",
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
failures use `not_observed` and `not_checked`; publication failure still emits
the complete `EvalResultV1` to stdout with a null `evidence_ref`.

Classifier MUST apply precedence: explicitly disabled optional lane —
`skipped`; runner, adapter admission, discovery, skill load, transport,
inspection, publication or cleanup failure — `integration_failure`; after
complete evidence and successful cleanup a scenario-contract violation —
`agent_behavior_mismatch`; expected scenario behavior — `pass`.


The classifier MUST expose evidence admission, execution (including actual
continuation), interaction delivery, outcome report and safety disclosure from
one evaluation result. `actual_task_outcome` is independently observed from
fixture/runtime evidence. `reported_task_outcome` MUST always be `not_checked`;
expected metadata, actual outcome, marker presence and free prose MUST NOT
populate it. Components `outcome_report` and `safety_disclosure` MUST always be
`not_checked`. Interaction delivery is `pass | fail | not_applicable` and checks
only exact admitted report fragments plus the mandatory nonempty model final.
No new `EvalResultV1` status is introduced. Evidence failure maps to
`integration_failure` with the existing inspection stage; admitted evidence
with a mechanics or exact-delivery violation maps to
`agent_behavior_mismatch`; only all applicable checks passing maps to `pass`.
Confirmed missing or complete empty model final is an interaction-delivery
mismatch when `report_checks` is empty; incomplete capture is an
inspection `integration_failure`. `terminal_result_matched` MUST describe only
the result/receipt comparison. Diagnostics MUST distinguish capture/evidence,
mechanics/continuation and exact-delivery failures without inferring prose
semantics.

#### Scenario: Ожидаемый semantic failure честно сообщён
- **WHEN** fixture assertion независимо фиксирует expected failed task outcome
- **THEN** harness может вернуть `pass` при зелёных mechanics/evidence/exact
  delivery, а `reported_task_outcome` остаётся `not_checked`

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
или runtime lifecycle. Pure scenario oracle MUST вызываться для всех admitted
`programmed` rows и принимать materialized scenario, recorded normalized MCP
trace, callback/effect observations и exact interaction checks и MUST возвращать
детерминированное сравнение без child process, сети или изменения внешнего
состояния.

Oracle MUST обнаруживать answer до pending, operation after close, unexpected
effect и отсутствие обязательной close attempt как scenario mismatch. Для
public session/turn/request IDs oracle MUST применить только recovery-aware
provenance rule и `recovered_calls` schema из owner «Сценарный контракт
поведения и authority-aware interaction»; любой mismatch вне доказанной pair
остаётся scenario mismatch. Runtime остаётся единственным владельцем
немедленного отклонения invalid public IDs/order; отсутствие close observation
для oracle является отсутствующим наблюдением. Mismatch после полного evidence
и успешного cleanup MUST классифицироваться как `agent_behavior_mismatch` на
стадии `scenario`.


Итоговая классификация и постоянный `not_checked` reported outcome определены owner
«Outcome model и диагностические доказательства»; driver не вычисляет второй
verdict и не подставляет expected outcome вместо наблюдения.

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
validated proof MUST сохранить transcript/oracle/result fields и report capture
из «Eval transcript plumbing и process verdict». Поле `manifest` MUST быть закрытым
`EvidenceManifestV1` с `schema_version: 1`, `hash_algorithm: "sha256"`,
`hash_encoding: "lowercase-hex"`, digest objects `installed_skill`, `corpus`,
`materialized_scenario`, `adapter`, `evaluator`, closed `installed_payload`, `client` и
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
bytes. Raw provider/model payload MUST не сохраняться, кроме exact isolated final,
который является report capture по его owner requirement. Version-specific golden
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
до behavior verdict. Per-scenario manifest MUST NOT содержать run ordinal или temp roots.
`evaluator` is the digest object of canonical candidate module inventory:
repository-relative paths and raw-byte digests of the actually loaded
oracle/harness/runtime/package/adapter/golden inputs, in deterministic path
order. The inventory is retained once in the candidate bundle; each child
proves its consumed inventory digest. It contains no credentials, environment
dump or absolute host paths. Existing package proof owns installed payload
validation; this digest does not create a second package scanner.


До hosted acceptance MUST быть зафиксирован один candidate manifest для
skill, corpus, исполняемого oracle/harness, runtime/package payload и
version-specific adapter/golden и версии Codex client. Candidate identity
включает только эти неизменные payload inputs. Отдельный run record ссылается
на candidate digest и сохраняет model, effort, serial, фактическую concurrency
и attempts; high и medium отличаются run settings, не candidate identity.
Manifest MUST описывать реально использованные
байты каждого child, а не только digest исходников до/после matrix. Drift любого
входа делает acceptance непригодной. Число repeats и условие reproducibly green
имеют единственного owner в `AGENTS.md`; counts выводятся из admitted corpus.
Results разных runs MUST NOT собираться в одну зелёную серию. Исторические
retry-containing artifacts сохраняют все attempts, но не принимаются как
доказательство нового acceptance policy.

Принятый baseline MUST иметь self-contained durable evidence bundle вне
автоматически очищаемых temp-каталогов: aggregate, per-run/per-attempt artifacts,
проверенные final reports и manifest. References внутри bundle относительные,
целостность проверяется digest; индекс baseline указывает этот bundle.
Markdown summary и JSON index MUST отражать один и тот же принятый candidate;
старые descriptive snapshots не подменяются новым acceptance verdict и не
выдаются за current evidence. Bundle не требует нового runtime registry или
external storage service. Supervisor остаётся owner process/cleanup mechanics.

Новый frozen input manifest MUST связать owner proof без второй source schema:
`coverage_sources_digest` exact равен `coverage.sources.digest`, а mandatory
`verification.coverage_audit` является root-relative path к exact
`zero-counter-audit.json`, опубликованному owner CLI. Пересечение
coverage-source paths и evaluator inventory MUST быть непустым; для каждого
общего path `bytes` и `sha256` exact совпадают. До записи нового freeze creator
MUST перечитать и сверить current bytes/hash всех entries coverage manifest
(16 для этого candidate). Исторические freeze files остаются immutable; эти
bindings не вводят all-lane source snapshot или registry.

`scripts/eval/finalize-cursor-skill-eval.mjs --freeze <frozen-inputs.json>
--diagnostic <highserial1.json> --high <highserial3.json> --medium
<mediumserial3.json> --coverage-audit <zero-counter-audit.json> --baseline
<existingbaseline.json> --report <existingMarkdown.md> --tasks <tasks.md>
--output <acceptance-bundle-root/closeout-proof.json>` MUST быть единственным deterministic closeout
consumer. Он принимает один frozen input manifest, ровно один successful high
diagnostic run, одну high series из трёх serial runs, одну medium series из трёх
serial runs и один current successful coverage audit. До любой target mutation
он MUST проверить один candidate во всех current eval inputs; явно одобренный
historical high reference ниже проверяется против собственных inputs. Exact corpus-owned
scenario-ID set без duplicates или omissions и admitted-corpus counts в каждом
run; process code `0`, null signal, `eval_status:pass`, одну retained attempt,
published evidence, successful cleanup и complete nonempty final capture
каждого scenario. Каждая artifact reference обязана быть относительной,
оставаться внутри своего bundle, указывать на regular file и иметь совпадающий
indexed hash. Coverage audit проверяется как отдельный local proof; его
reference/hash не доказывает source binding hosted candidate и не разрешает
автоматически завершать pre-freeze tasks 5.7/5.7a–5.7f.
Finalizer MUST собрать переносимый acceptance bundle в общем root каталоге
output proof file:
authoritative evidence references в closeout proof относительны, содержатся
внутри этого bundle и не зависят от исходных абсолютных CLI paths. Seed
baseline/report/tasks и их опубликованные версии сохраняются рядом как
проверяемые snapshots без превращения копий в отдельный source of truth.
Новый freeze использует только references от этого общего bundle root;
предыдущие freeze artifacts остаются immutable historical evidence.

По прямому указанию пользователя finalizer MAY сохранить ранее reproducibly
green high three-run series как `preserved-reference`. Frozen manifest тогда
содержит closed `high_reference` object с `source_freeze` и `source_corpus`:
каждый является relative hashed regular-file reference `{path, bytes, sha256}`
внутри общего bundle. `verification.high_reference_authorization` MUST ссылаться
на сохранённое указание пользователя; finalizer проверяет наличие evidence,
но не интерпретирует natural language как permission policy. Source freeze
MUST быть валиден и не содержать nested `high_reference` или legacy
`high_carry_forward`; legacy field в current freeze также отклоняется.
Finalizer MUST проверить полные исходные high artifacts против исходного
freeze и hash-bound corpus тем же matrix validator. Текущие diagnostic и medium
MUST использовать один frozen candidate и одну concurrency. Исходный high
сохраняет candidate, concurrency, counts и verdicts. JSON proof MUST обозначать
`execution: preserved-reference`, `applies_to_current_candidate: false` и
reference; Markdown MUST показывать оба candidate и обе concurrency и не
утверждать current-high reproducibility. Fresh high проверяется на том же
candidate/concurrency и имеет `applies_to_current_candidate: true`.
Reference не доказывает совместимость разных evaluator/corpus/package inputs;
compatibility engine не вводится. Дополнительные failed high runs остаются
неизменными evidence и не становятся accepted runs.

При полном proof finalizer MUST сначала вычислить и подготовить все outputs,
затем детерминированно записать один closeout proof, additive JSON baseline и
Markdown summary с сохранением всей истории, а также изменить только task
checkboxes 5.8–5.11. Каждая target file заменяется атомарно, повтор с теми же
inputs идемпотентен, tasks записываются последними. Любая validation failure до
начала публикации MUST оставить proof, baseline, Markdown report и tasks без изменений.
Межфайловая транзакция не обещается: interruption во время публикации может
оставить корректный prefix, который идемпотентный повтор восстанавливает до
полного набора. Finalizer не архивирует OpenSpec change, не создаёт generic
workflow engine/registry и не выдаёт critic или architect approval.

#### Scenario: Evidence связано с точным payload
- **WHEN** outer запускает выбранный scenario и получает child-result
- **THEN** scenario/raw-corpus digests совпадают, adapter/package proof
  корректной closed формы захвачен до cleanup, а outer публикует один вложенный
  manifest только при полном proof

#### Scenario: Новый freeze связан с coverage owner proof
- **WHEN** freeze creator принимает current coverage result/audit и evaluator
  inventory для нового candidate
- **THEN** он до записи сверяет все 16 coverage source files, exact digest,
  непустое path overlap с identical bytes/hashes и root-relative exact audit
  reference, не изменяя historical freezes

#### Scenario: Closeout публикуется только после полного proof
- **WHEN** finalizer получает frozen input manifest, high diagnostic,
  high/medium three-run series и current coverage audit одного candidate
- **THEN** он сначала проверяет exact scenario sets, process verdicts,
  hashes/counts/attempts/captures/publication/cleanup и containment regular
  artifact files, затем атомарно по одному файлу и идемпотентно пишет proof,
  additive baseline, summary и последними только task checkboxes 5.8–5.11

#### Scenario: Неуспешная validation не меняет acceptance records
- **WHEN** любой required input, hash, count, capture, publication или cleanup
  не проходит проверку до начала output publication
- **THEN** finalizer не изменяет baseline, Markdown report или tasks и не
  архивирует change

#### Scenario: Прерванная публикация восстанавливается повтором
- **WHEN** публикация прерывается после атомарной замены части target files
- **THEN** уже записанные файлы остаются валидным prefix, tasks не опережают
  остальные outputs, а повтор с теми же inputs идемпотентно завершает closeout

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

До candidate freeze MUST пройти детерминированная проверка изменённого oracle на
admitted corpus и сохранённых report examples вместе с targeted focused
reproductions. После freeze hosted диагностика MUST предшествовать новому
acceptance baseline и состоять из одного полного diagnostic run выбранной
конфигурации. Diagnostic pass не заменяет baseline по `AGENTS.md`.
После baseline failure следующий запуск MUST иметь конкретную проверяемую
гипотезу и соответствующее изменение либо подтверждённое восстановление
инфраструктуры; повторять behavior trials только ради удачного pass запрещено.
Если новый дефект не локализован, публикуется непринятый результат с evidence,
а не очередное обещание «финального» прогона. Уже начатый baseline сохраняет
полное распределение согласно `AGENTS.md`.

Matrix MUST NOT автоматически повторять scenario после failure любого класса.
Каждый запланированный scenario в serial run имеет одну попытку; любой non-pass
делает этот run непринятым. После подтверждённого восстановления инфраструктуры
или repair допускается новый отдельно идентифицированный запуск через
diagnostic gate; предыдущий failed run остаётся историческим evidence.
Повторная оценка сохранённого trace допускается только как diagnostic analysis
и MUST NOT изменять его исходный verdict или выдавать его за новый run. Новый
baseline требует свежих high и medium three-run series frozen candidate,
кроме явно одобренного historical high reference из «Immutable evidence manifest».

Candidate provenance и долговечное хранение определены в «Immutable evidence
manifest»; этот execution policy использует тот же manifest без второй схемы.
После diagnostic pass high three-run series (свежая либо указанный
historical reference) и свежая medium three-run series являются независимыми
gates. По явному указанию пользователя fresh high и current medium MAY
выполняться параллельно на одном frozen candidate; внутри каждой конфигурации
три runs остаются serial. Historical reference проверяется против собственных
inputs и не является текущим запуском; его validation MAY перекрываться с medium.
Только после них deterministic finalizer из
того же owner requirement может выполнить closeout; он не повторяет runs и не
создаёт отдельный approval gate.

#### Scenario: Изменение oracle обесценивает прежний acceptance
- **WHEN** skill и corpus неизменны, но oracle или adapter отличаются от candidate
- **THEN** прежние counts остаются историческим evidence; новый candidate
  проходит diagnostic и отдельный acceptance, без переноса зелёных runs

#### Scenario: Пользователь сохраняет ранее принятый high как reference
- **WHEN** пользователь явно сохраняет historical high по
  «Immutable evidence manifest» после изменения candidate
- **THEN** исходные high artifacts проверяются против собственных inputs,
  verdicts остаются неизменными и обозначаются `preserved-reference` без
  применимости к текущему candidate; diagnostic и medium проходят свежие runs

#### Scenario: Неудачная диагностика не запускает цикл baseline
- **WHEN** полный diagnostic run содержит mismatch
- **THEN** причина и проверенный report сохраняются для targeted repair;
  baseline не начинается до устранения диагностированного нарушения

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
