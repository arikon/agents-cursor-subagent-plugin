## MODIFIED Requirements

### Requirement: Высокоуровневое создание делегирования
The `cursor_delegate` facade MUST call runtime-owned `cursor_start_session` exactly once
and call `cursor_send_prompt` exactly once only after its live result. It relies on these public runtime operations for
validation and allocation. It MUST not allocate a second session, retry
prompt after any dispatch failure, or maintain copied lifecycle metadata.
All validation/allocation semantics are owned by runtime
requirements «Response envelopes и фаза allocation» and «Публичный MCP tool
contract». For a successful first prompt, facade returns that runtime action
result plus the runtime-owned bootstrap projection
`cursor_session_id,model,effort?,fast?`; it does not reinterpret any value. A
start rejection
before session allocation remains the runtime error without cleanup; an allocated
init/spawn tombstone returns unchanged. With a live allocated session but prompt
rejection before turn allocation, facade closes once and returns that unchanged
runtime error.

IUX-6 accepts the runtime IUX-1 launch surface and forwards every exact supplied
optional field—including `model`, `effort`, `fast` and `plugin_dirs`—or
its omission for runtime defaults to that one `cursor_start_session`. It neither
duplicates the public signature, validates availability nor selects a fallback;
runtime owns validation and version-specific argv encoding.

#### Scenario: Optional launch parameters are forwarded once
- **WHEN** delegation specifies any optional runtime launch field or omits it
- **THEN** facade makes one start call with the same optional fields and retains
  the unchanged first-prompt cleanup semantics

#### Scenario: Ready session receives first prompt
- **WHEN** valid delegation starts
- **THEN** facade allocates one runtime session, sends one prompt and returns its
  action result with the runtime-owned bootstrap projection

#### Scenario: Start or first prompt fails
- **WHEN** validation, initialization or dispatch fails
- **THEN** it returns the unchanged runtime error or failed-allocation result as
  applicable and does not create another session or prompt

### Requirement: Skill workflow делегирования
The installed skill MUST use `cursor_delegate` as its primary start path and
`cursor_wait` for observation; it MUST not poll `cursor_session_status`. Every
answer-tool call includes the exact session, turn and request IDs from prior
tool results; the user-facing answer does not have to repeat them. Protocol completion is
reported without a semantic-success claim. Independent verification MUST NOT
create an unrequested provider turn after terminality; without a declared later
stage it uses only available independent evidence and reports an unverifiable
limitation instead of calling `cursor_send_prompt`. A live session remains available
after a terminal turn only while a user-declared later follow-up or review stage
remains unfinished; the skill uses `cursor_send_prompt` for that next turn. The
mere possibility of a future user message does not defer cleanup. It closes idempotently
only when delegated work is complete, abandoned/cancelled, irrecoverably failed,
or an idle wrapper needs a required launch-setting change followed immediately
by explicit resume. Answer tools and `cursor_send_prompt` are primary workflow tools;
start/status/cancel are advanced diagnosis/recovery surfaces.
Every user-required exact outcome marker MUST be copied verbatim into the
provider prompt and report it when the user requested that exact result marker.
Launch parameters remain available in tool results. When a follow-up completes the last later stage
previously declared by the user and no additional stage was declared, delegated
work is complete and the close attempt is required. Each workflow step has one
close owner; after explicit resume that same owner uses the new current runtime
`session_id` for the resumed wrapper's close attempt.
Each user-provided absolute Agent Plugin root MUST be forwarded unchanged via
`plugin_dirs`; the skill MUST NOT copy or substitute it and MUST NOT pre-empt
runtime-owned canonicalization, existence, or allowed-root validation. A
runtime `invalid_args` or `scope_rejected` result is reported without fallback.
Before a write-capable `cursor_delegate`, the skill MUST verify that the
provider prompt contains one exact `AUTHORIZED_ACTIONS` line for every
caller-authorized write plus the exact `NO_SCOPE_EXPANSION: make no other
changes; stop and report any required expansion.` line, and MUST NOT delegate
until those clauses are present. The operation token is exactly `write` for
both file creation and modification and MUST NOT be replaced by a synonym.
A terminal turn MUST NOT be treated as a terminal delegation when the user has
already declared a later decision, follow-up, or review stage. In that case the
skill MUST preserve the same live runtime `session_id`, MUST NOT close or resume
the wrapper, and, when the follow-up grants write authority after an `ask` turn,
MUST call `cursor_set_mode` with `mode:"agent"` before `cursor_send_prompt` on
that same wrapper.
Every branch MUST report the semantic result to the user. A continuing branch
MUST preserve the exact IDs and pending context from tool history for the next
operation within the same Codex task. It SHOULD retain the latest returned
resume cursor as the sparse default, but an earlier/repeated runtime-valid
cursor or omission=0 is permitted; copying these values into final JSON
is not a continuation requirement. An observation gap and a required new user decision MUST be stated
explicitly. A tool result or commentary-only message does not satisfy the
caller report and MUST NOT end that Codex turn. Terminal success MAY use normal
human-facing prose; a global machine-readable final-answer protocol is outside
the current product scope.

Эти требования остаются operator guidance владельца IUX-3. Mandatory IUX-19
acceptance не оценивает свободную формулировку outcome или safety disclosure:
они записываются как `not_checked`. Eval owner проверяет в final только exact
пользовательские данные, явно заданные corpus/fixture, включая marker/result
token, вопрос с видимыми options и plan; MCP mechanics проверяются по trace.

Runtime tool results remain the source of exact receipts, hashes, provider
diagnostics and IDs. The skill MUST NOT require their duplication in the
human-facing report. Incorrect address or runtime-invalid cursor fields in a subsequent tool
call remain a continuation failure unless corrected under the finite recovery
proof owned by «Сценарный контракт поведения и authority-aware interaction».
The normal wait workflow MUST distinguish a rejected call with incorrect
arguments from wrapper loss observed through correctly addressed public state.
Local argument repair MUST NOT trigger resume, delegation, or a new prompt;
it does not admit guessed or historical IDs. False semantic
success, a hidden observation gap and a missing required
new user decision are report failures. A consumer restricted to final-only
external handoff is outside this change; no new handoff protocol is introduced.

When a wait returns `events_lost:true`, the report MUST explicitly disclose the
observation gap, state that missing history was not reconstructed, and bound
its conclusions to the current normalized state.
If `cursor_delegate` returns a failed-allocation result without `turn_id`, the
skill MUST report normalized failed state and error code and explicitly require
a new user decision; exact diagnostics remain in transcript evidence.
It MUST NOT call `cursor_wait`, retry, resume or create a fallback delegation.

Для pending question skill MUST показать нормализованный вопрос и доступные
options без потери смысла вопроса, различий между вариантами и необходимости
решения. Формат MAY быть prose, списком или JSON; внутренние IDs не обязательны
в сообщении пользователю. Skill MUST сопоставить выбор пользователя с точной
option и request ID из tool result, не из самостоятельно сгенерированных IDs,
и MUST NOT
вызвать answer до отдельного user follow-up с выбором,
skip или cancel. После follow-up answer response продолжает тот же delegated
turn: следующий wait SHOULD использовать его `last_event_id` как sparse
`after_event_id` и MUST сохранять later-wait `timeout_ms:60000`. Более ранний
или повторный runtime-valid cursor либо omission=0 не является continuation
failure и не перезапускает first-wait schedule из-за нового Codex turn;
то же правило действует для fresh wait после stale/unknown answer. Для pending
decision follow-up MUST быть потреблён только соответствующим answer tool и
MUST NOT одновременно пересылаться через `cursor_send_prompt`; только отдельная
новая provider-задача после terminality начинает следующий delegated turn. Для
pending plan skill MUST NOT отправить `accept` до явного
одобрения пользователя и MUST NOT отправить `reject` до явного отклонения или
отмены пользователя. Для permission, точно покрытого текущим поручением,
skill MUST использовать только `allow-once` без повторного подтверждения.
Для permission вне текущих полномочий skill MUST NOT отправлять answer до
явного follow-up; после него разрешены только `allow-once` или `reject-once`.
Расширение scope, destructive/external action или доступ к credentials MUST
NOT выводиться из неявного контекста.

Для read-only review skill MUST вызывать `cursor_delegate` с допустимым
`mode:"ask"` (либо `mode:"plan"`, когда результатом нужен план), а не с
`mode:"review"`. Если пользователь явно указал model parameters, skill MUST
передать optional `model`, `effort` и `fast` без изменения
глобальной Cursor-конфигурации. Если model не указан, skill MUST его опустить
для runtime default `auto`; skill не выбирает explicit model и не вызывает
model-listing. Если report упоминает model parameters, он описывает их
только как requested/forwarded launch parameters; skill MUST
NOT представлять их как provider-confirmed resolved/effective model.

Terminal `turn_status:"failed"`, including a tombstoned envelope that still
carries `turn_id`, MUST быть сообщён как failure с содержательным объяснением
доступной причины; полные diagnostics остаются в tool results.
Skill MUST NOT автоматически retry, resume или redelegate
после такого terminal failure; дальнейшая provider operation требует нового
решения пользователя.
Report MUST NOT выдумывать причину failure или подменять её успешным исходом.

После terminal close skill MAY продолжить работу только через явный
`cursor_resume_session` с exact previously returned `cursor_session_id`,
caller-selected canonicalized permitted `cwd`, user-authorized `mode` и optional user-selected model
parameters.
Он MUST сохранить отдельно новый MCP `session_id` и старый provider ID; при
resume failure skill сообщает failure и не создаёт replacement session без
нового поручения. Живая session продолжает следующий turn через
`cursor_send_prompt`, без resume tool.
Если between-turn `cursor_set_mode` завершается error, skill MUST сообщить
нормализованный error code и его смысл без обязательной JSON-сериализации.
`invalid_args` допускает только исправление
локально malformed call при однозначном уже авторизованном intended mode.
`protocol_error` требует one-shot `cursor_session_status`: live idle wrapper
сохраняется без close и prompt и без вымышленной state transition; report MUST
state the observed live-idle result. Observed active turn на этом serial
between-turn path только сообщается без дальнейшей provider
operation. Только `mode_timeout`, другая provider-transition
failure или observed tombstone запрещает retry/resume/replacement и требует
новое user decision перед следующей provider operation. Report MUST явно
объяснить необходимость нового решения; имя технического поля и boolean JSON
не обязательны. Recoverable live-idle ветка MUST NOT выдумывать это требование.
Explicit follow-up, полученный во время active turn, MUST быть отправлен через
`cursor_send_prompt` только после observed `turn_status:"completed"` вместе с
`session_state:"live"`. `failed|timed_out|cancelled` либо tombstone MUST перейти
в соответствующую terminal recovery ветку без send; pre-failure follow-up не
заменяет новое post-failure user decision.

For the first wait of every turn, the skill SHOULD pass the `last_event_id`
returned by `cursor_delegate` or `cursor_send_prompt` as `after_event_id`.
For following waits it SHOULD use the most recent `resume_after_event_id` as
the sparse default. Runtime omission=0 and an earlier or repeated runtime-valid
`after_event_id` remain valid and are not continuation failures. When the caller explicitly limits observation to one wait
interval, the skill MUST stop the later-wait schedule after the first
`wait_timeout:true`, report that work remains in progress, end that Codex turn,
and leave the Cursor turn active; continuation uses the retained tool results.
When a terminal preview is truncated, the skill MUST call `cursor_read_result`
through the runtime-owned «Полное чтение terminal result» read path before final verification/reporting
or starting another turn. It MUST retain the complete result before required
close, without provider regeneration, repeated wait or private archive access.
If result retention failed or data is unavailable, report the completeness
limitation; a partial review is not a complete verdict.
At a required close boundary the skill MUST retain the semantic result and
limitations, attempt close, then deliver the caller-visible final report.
For read-only review
the skill MUST choose one explicit evidence mode before delegation: `file review`
permits only read/search of the exact or bounded user-authorized scope inside
the supplied checkout (the full checkout only when already authorized) and forbids writes, network,
credentials and internal memory/transcript retrieval; `snapshot review` forbids
tools and supplies all required evidence in the prompt. The skill MUST NOT forbid
local file inspection while requiring a file review. On `unknown_request`, the
context-free recovery summary is diagnostics only: the skill MUST perform a
fresh `cursor_wait`, consume its complete normalized pending context and only
then use the returned current ID. It MUST NOT guess a `request_id`, answer from
the recovery summary, automatically re-delegate, or automatically expand
authority. This request-ID recovery is distinct from the eval-owned rejected
session/turn lookup correction above.

For an active turn the skill MUST NOT invent an active-turn steering call: the
pinned Cursor ACP interface exposes none. If the user already supplied a
follow-up, the skill waits for terminality and uses `cursor_send_prompt` only
after observed `completed + live`; every other terminal state follows its
recovery branch. Otherwise it explains the capability gap and waits for a
user-directed normal follow-up.

#### Scenario: Интерактивное делегирование
- **WHEN** Cursor creates a pending request or completes a turn
- **THEN** the skill observes it with `cursor_wait`, addresses any answer by full
  IDs, keeps the live session only for an explicitly declared unfinished next
  stage, and closes at the delegated-work terminal path

#### Scenario: Initial allocation failure не вызывает wait или fallback
- **WHEN** `cursor_delegate` returns an allocated init/spawn tombstone without
  `turn_id`
- **THEN** the skill reports the normalized failure and need for a new decision, and stops without
  wait, retry, resume or replacement delegation

#### Scenario: Question и plan ожидают явный выбор
- **WHEN** Cursor публикует question или plan
- **THEN** skill показывает нормализованный pending context и не отправляет
  answer до соответствующего explicit user follow-up

#### Scenario: Permission покрыт текущим поручением
- **WHEN** Cursor запрашивает действие, точно покрытое current user authority
- **THEN** skill отвечает только `allow-once` без дополнительного user turn

#### Scenario: Permission расширяет scope
- **WHEN** Cursor запрашивает действие вне current user authority, destructive,
  external или credential action
- **THEN** skill не отвечает до explicit user follow-up и использует только
  `allow-once` либо `reject-once` после него

#### Scenario: File review имеет непротиворечивый scope
- **WHEN** skill делегирует read-only review по файлам checkout
- **THEN** prompt разрешает local read/search и запрещает только writes, network, credentials и internal retrieval, без tool-free требования

#### Scenario: Review использует допустимый mode и явную модель
- **WHEN** пользователь просит file review с model `grok-4.6`
- **THEN** skill вызывает `cursor_delegate` с `mode:"ask"` и
  `model:"grok-4.6"` без mutation глобальной Cursor-конфигурации;
  при упоминании модели report не выдаёт launch echo за resolved model

#### Scenario: Закрытая Cursor-сессия продолжается явно
- **WHEN** пользователь просит продолжить ранее закрытую session и предоставляет
  returned `cursor_session_id`
- **THEN** skill вызывает `cursor_resume_session` с exact provider ID, сохраняет
  new MCP session ID и не делает скрытый поиск или replacement delegation

#### Scenario: Следующий turn продолжает live conversation
- **WHEN** предыдущий turn terminal, session остаётся live и пользователь просит
  следующий этап ревью с прежними launch options
- **THEN** skill вызывает `cursor_send_prompt` с тем же runtime `session_id`,
  сохраняет provider conversation и не создаёт или resume-ит другую session

#### Scenario: Snapshot review не нуждается в file search
- **WHEN** skill выбирает tool-free snapshot review
- **THEN** prompt содержит достаточные review artifacts и явно запрещает tools без последующего запроса локального поиска

#### Scenario: Unknown pending ID восстанавливается без угадывания
- **WHEN** answer-tool возвращает recovery для unknown/stale request
- **THEN** skill получает complete normalized context через fresh wait и не
  отправляет answer из context-free recovery summary или с выдуманным ID

#### Scenario: Явный active-turn follow-up ждёт terminality
- **WHEN** user sends a separate follow-up while exact Cursor turn is active
- **THEN** skill waits for terminality and sends the already supplied text as
  the next turn only after `completed + live`; failed, timed-out, cancelled or
  tombstoned state sends nothing before a new post-failure user decision

After any explicit resume, provider acceptance of `cursor_session_id` does not
prove retained semantic history. If the next turn depends on prior semantic
history, the skill MUST repeat the minimal bounded context and constraints
needed by that turn, or MUST report the result as unverifiable rather than
assuming provider memory.

For repeated critic review, skill SHALL create one compact manifest of artifact
paths, digest and frozen baseline. While the same runtime session remains live
and the manifest digest is unchanged, a follow-up MUST send only changed paths
and their delta; it MUST NOT resend a full unchanged snapshot.
The same-live-session repeat prompt MUST encode them as exact
`BASELINE_DIGEST=<retained digest>`, `CHANGED_PATHS=<bounded changed paths>` and
`DELTA=<exact bounded delta>` lines, and MUST omit the unchanged baseline body.
After wrapper
loss or explicit resume, provider acceptance of `cursor_session_id` does not
prove retained semantic history: the next critic prompt MUST re-establish the
full bounded baseline or snapshot together with the delta, or the skill MUST
NOT use the same-live delta-only template and MUST
report the review as unverifiable when that evidence is unavailable. Bounded
waits use increasing intervals capped by the runtime maximum and always retain
exact `session_id` and `turn_id`; they SHOULD retain the latest resume cursor as
the next sparse default. This is workflow
composition only: no further critic/session tool, session registry or automatic retry is
introduced.

#### Scenario: Повторное ревью использует delta
- **WHEN** prior critic verdict requires a minimal artifact repair
- **THEN** next prompt contains the prior digest and only changed artifacts,
  while subsequent tool calls use the retained session IDs and a runtime-valid
  event cursor, preferably the latest resume hint

#### Scenario: Resume повторно устанавливает critic context
- **WHEN** runtime wrapper потерян между critic turns и provider conversation
  продолжается через retained `cursor_session_id`
- **THEN** resumed prompt содержит bounded baseline/snapshot и новый delta либо
  skill явно сообщает, что semantic review unverifiable; delta-only запрещён

#### Scenario: Resume role-neutral turn не предполагает provider memory
- **WHEN** любой research, Q&A, planning, debugging или coordinator turn после
  explicit resume семантически зависит от предшествующего разговора
- **THEN** skill повторяет минимальный bounded context и constraints для этого
  turn либо сообщает результат как unverifiable

#### Scenario: Универсальный интерактивный happy path
- **WHEN** задача проходит фазы research, planning и explicit implementation
- **THEN** skill starts `ask`, uses `plan` when approval is needed and uses
  `agent` only for authorized work; it preserves one live session through
  `cursor_set_mode`, prefers returned resume cursors for sparse waits and
  reports compact progress
  events without treating them as completion

#### Scenario: Long implementation remains observable
- **WHEN** explicitly authorized local implementation runs longer than one
  regular wait interval
- **THEN** skill normally passes the turn-start `last_event_id` on the first wait, leaves
  that wait at runtime's 30-second timeout default, then uses 60/120/180-second
  bounded waits, preserves and passes each returned progress revision, and
  prefers each returned resume cursor while accepting earlier/repeated
  runtime-valid or omitted=0 event cursors,
  reports only a new bounded excerpt, and distinguishes
  `timed_out` from a resumable work-in-progress rather than restarting it

### Requirement: Workspace discipline делегирования
For write-capable or concurrent delegation the skill SHALL recommend a verified
isolated worktree. Canonical checkout MAY be used when the user authorized the
changes and caller accepts the coordination risk. Neither facade nor runtime
creates, detects, or verifies a VCS worktree: this is an operational
recommendation, not a security or permission boundary. Runtime owns cwd/mode and
callback enforcement. The skill/facade owns the delegated prompt boundary: every
write-capable prompt, and every file-review prompt whose read/search scope is
narrower than the full checkout, MUST include `AUTHORIZED_ACTIONS` with every exact or
bounded user-authorized operation/path and any exact content constraint using
`AUTHORIZED_ACTIONS: <operation> <path-or-bounded-class> [with exact content
<content>] only.`, plus the exact sentence `NO_SCOPE_EXPANSION: make no other
changes; stop and report any required expansion.` This is coordination evidence, not an exact policy engine
or OS sandbox claim. A terminal report for an authorized canonical-checkout
write MUST include the exact sentence `An isolated worktree was recommended;
the caller accepted the coordination risk; the runtime does not verify the
worktree.`
Before `cursor_delegate` for a bounded file review, the skill MUST verify that
the prompt contains the exact `AUTHORIZED_ACTIONS: read <path> only.` and
`NO_SCOPE_EXPANSION` lines plus the exact sentences `bounded local read/search
is allowed` and `writes, network access, credentials, and private/internal
memory or transcript retrieval are forbidden`.

#### Scenario: Write prompt carries the granted boundary
- **WHEN** initial authority or a later explicit user follow-up grants one exact
  write before a Cursor prompt
- **THEN** that same prompt carries the exact authorized path/content clause and
  the no-expansion stop/report clause, and contains no opposite permission to
  modify outside the grant or continue after required expansion

#### Scenario: Narrow file review carries the granted read boundary
- **WHEN** user authority covers only one file or another bounded read/search
  class inside `cwd`
- **THEN** the file-review prompt carries that exact bounded
  `AUTHORIZED_ACTIONS` clause and the no-expansion stop/report clause; it does
  not grant read/search of the rest of `cwd`

#### Scenario: Пишущая задача
- **WHEN** Codex delegates `agent`
- **THEN** skill recommends an isolated worktree and facade forwards the supplied
  canonical checkout or worktree path unchanged to runtime validation

#### Scenario: Пишущая задача в canonical checkout
- **WHEN** пользователь явно разрешил bounded local changes в canonical checkout
- **THEN** skill предупреждает о coordination risk, но не блокирует delegation
  только из-за отсутствия isolated worktree

The v1 skill SHALL NOT infer deletion authority from a Cursor-created temporary
artifact. It SHALL pass only the closed public launch fields and SHALL NOT
emulate unlisted provider controls; exact current-version exclusions belong to
the adapter/golden. Neither facade nor runtime claims an exact per-action policy
engine. If exact deletion or a bounded deletion class is
not already explicitly covered by user authority, it preserves each
Cursor-created temporary path returned or observed by the caller and reports it
for a separate decision; it does not claim discovery of provider-internal paths
absent from the bounded runtime surface. Existing explicit deletion authority
MUST NOT require a redundant one-time confirmation.

#### Scenario: Временный артефакт сохраняется
- **WHEN** Cursor создал временный path, но current user authority не включает
  его удаление, и path возвращён либо наблюдается caller
- **THEN** skill не удаляет path автоматически и сообщает его пользователю

#### Scenario: Provider rejection завершает turn без автоматического recovery
- **WHEN** live turn terminalizes with `turn_status:"failed"` after a bounded
  provider rejection
- **THEN** skill follows «Skill workflow делегирования» failure reporting and
  recovery; workspace discipline adds no separate receipt-copy requirement
