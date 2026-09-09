## MODIFIED Requirements

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
`inject-stale-question-once`, `lose-terminal-wait-response-once`,
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
`lose-terminal-wait-response-once` допускается только при одном terminal step
`completed` с непустым result и expected `turn.wait-response-recovered`.
Он взаимоисключающ с остальными `harness_faults`: это проверка одной потери
response, а не комбинации независимых отказов. Прокси получает первый успешный
terminal `cursor_wait` response от runtime, сохраняет его через существующую
bounded response projection как `withheld_response` того же captured call и
передаёт caller вместо него `CallToolResult{isError:true,content:[{type:"text",
text:JSON.stringify({error_code:"eval_wait_response_lost",message:"cursor_wait response unavailable"})}]}`.
Это test-only marker, сохранённый в обычной error projection; production runtime
не получает нового error code. Это fault на границе доставки,
не runtime domain error; он не меняет runtime state и не пересылает новый prompt.
Caller-visible error остаётся обычным `response` этого call; raw result text
не добавляется в evidence. Fault действует ровно один раз, все следующие
responses доставляются неизменёнными. Отсутствие фактического trigger либо
неполная запись любой стороны доставки MUST NOT считаться успешной инъекцией.
Expected `turn.wait-response-recovered` допускается ровно с этим fault.

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

Finite recovery taxonomy допускает ровно два класса:

- `address`: у existing-session tool изменяется непустое подмножество только
  `session_id`/`turn_id`, включая missing, malformed или несколько неверных IDs;
  success использует current causal public IDs, non-address arguments digests
  exact equal, а rejected error равен применимому
  `invalid_args | invalid_text_encoding | unknown_session | unknown_turn`;
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
`address | set_mode`; отдельный count или corrected-fields list не
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
close MUST оставаться mismatch. После natural tombstone применяется
существующий close-or-proven-natural-tombstone rule; repeated closes являются mismatch.

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
Successful waits MUST использовать state-oriented runtime contract SW-1/SW-2;
eval проверяет causal IDs, а не event/progress cursor dataflow. Новый wrapper
заменяет старый segment; неподтверждённые IDs не допускаются. Missing IDs in final prose alone are not a failure.
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
  1000–180000, boolean `timeout_omitted`; `timeout_omitted:true` is valid only with
  effective `timeout_ms:30000`, while explicit retries use `false`;
- `turn.wait-response-recovered` с terminal `step_id`, `matched:true` и
  one-based `lost_call_index`, `repeated_call_index`. Observation допустим
  только после фактического повторного `cursor_wait`: оба call имеют одинаковые
  causal session/turn IDs и проходят runtime-owned admission SW-1/SW-2;
  допустимый timeout может отличаться, поскольку он не меняет адресуемый ход.
  Repeated call непосредственно следует за lost call в том же complete Codex turn range.
  Full proof MUST иметь `dropped_calls:0`, `unexpected_input_requests:0` и
  ровно один `withheld_response`, принадлежащий lost call выбранного fault.
  Его compact terminal response и repeated response MUST содержать одинаковые
  result projection и immutable receipt; caller-visible lost response MUST
  соответствовать injected failure. Обычные IDs, receipt и result проверки
  применяются к repeated response. Только при полном таком proof lost error
  пропускается при semantic trace projection, сохраняясь в raw calls; это не
  `recovered_calls` argument correction и не расширяет её два класса.
  Observation предшествует обычным terminal/receipt observations repeated call;
  withheld result сам по себе не порождает terminal/receipt observations и
  не доказывает доставку caller. Provider effects, иной interleaving,
  missing proof и повторная потеря остаются mismatch; неизвестный адрес не
  допускает нового prompt/session/resume. `withheld_response` MUST отсутствовать
  во всех остальных calls и fault variants;
- `turn.receipt` with a terminal `step_id`, `matched:true` and boolean
  `result_truncated`;
- `turn.result-read` with `complete:true`, emitted only after actual
  `cursor_read_result` calls reach EOF from offset zero using returned
  continuation values for that turn; it proves workflow composition and does
  not define a second paging/hash/retention algorithm;
- `prompt.contract` with a prompt-check `step_id` and `matched:true`;
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
session ID was used. Wait recovery MUST сохранять causal session/turn IDs по SW-5; отдельного
wait-cursor correction класса нет, ошибки IDs покрывает существующий address correction. Every receipt and progress observation MUST reference its
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
- **WHEN** первый wait возвращает resumable timeout с bounded progress, затем
  turn завершается и ACP child независимо исчезает, tombstoning the wrapper
- **THEN** следующий wait использует те же runtime IDs и увеличенный timeout
  по SW-5 без cursor arguments. Evidence проверяет immutable terminal receipt и
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
  `address | set_mode` и только contiguous successful pure
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
- **THEN** exact delegate request содержит эти launch choices, trace доказывает
  покрытый write effect и terminal receipt, после чего workflow закрывается;
  internal collaboration events проверяются только runtime owner и не ожидаются
  в публичном wait или eval trace

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
- **WHEN** caller продолжает state-oriented wait по retained session/turn IDs
- **THEN** eval проверяет только current state/terminal delivery без event history
  assertions; влияние internal event eviction проверяется сценарием SW-3

#### Scenario: Потерянный terminal response читается повторно
- **WHEN** выбранный `lose-terminal-wait-response-once` скрывает первый terminal wait response после его фактического получения от runtime
- **THEN** следующий wait адресует тот же retained turn без повторного provider effect; oracle доказывает `turn.wait-response-recovered`, затем обычные terminal/receipt delivery и required close, а caller получает исходный result

#### Scenario: Потеря response не подменяется потерей evidence
- **WHEN** в таком scenario отсутствует withheld response, полный raw transcript, либо повторный wait изменяет адрес или выполняется после другого effect
- **THEN** oracle отклоняет proof; program/expected trace не восстанавливает недостающий факт и первый скрытый result не считается доставленным
