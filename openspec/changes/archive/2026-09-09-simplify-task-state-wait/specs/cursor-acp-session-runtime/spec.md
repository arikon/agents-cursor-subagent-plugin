## MODIFIED Requirements

### Requirement: Публичный MCP tool contract

Runtime SHALL быть единственным владельцем MCP schemas и всех response envelopes. Tools:
`cursor_list_models({})`,
`cursor_start_session({cwd,mode,model?,effort?,fast?,optimize_for?,plugin_dirs?})`,
`cursor_delegate({cwd,mode,prompt,model?,effort?,fast?,optimize_for?,plugin_dirs?})`,
`cursor_resume_session({cwd,cursor_session_id,mode,model?,effort?,fast?,optimize_for?,plugin_dirs?})`,
`cursor_set_mode({session_id,mode})`, `cursor_send_prompt({session_id,prompt})`,
`cursor_session_status({session_id})`, `cursor_read_result({session_id,turn_id,offset?})`,
`cursor_wait({session_id,turn_id,timeout_ms?})`,
`cursor_answer_question({session_id,turn_id,request_id,outcome,answers?})`,
`cursor_answer_plan({session_id,turn_id,request_id,decision})`,
`cursor_answer_permission({session_id,turn_id,request_id,decision})`,
`cursor_cancel({session_id,turn_id})`, `cursor_close_session({session_id})`.
`review` is not a mode and invalid `mode` MUST return `invalid_args` listing
`ask|plan|agent`.
Все inputs MUST быть JSON objects без additional properties. String ID/prompt/
answer fields nonempty UTF-8 strings в limits данного change; `cwd` — canonical
absolute directory, `mode` exactly `ask|plan|agent`; `decision` exactly
`accept|reject` для plan и `allow-once|reject-once` для permission. IDs opaque;
`timeout_ms` имеют ranges из «Нормативные limits runtime».

| Tool | Required input | Optional input | Success output |
|---|---|---|---|
| `cursor_list_models` | — | — | `ModelCatalog` из «Получение моделей Cursor через MCP» |
| `cursor_start_session` | `cwd`, `mode` | `model`, `effort`, `fast`, `optimize_for`, `plugin_dirs` | `SessionEnvelope` |
| `cursor_delegate` | `cwd`, `mode`, `prompt` | `model`, `effort`, `fast`, `optimize_for`, `plugin_dirs` | bootstrap `ActionEnvelope` or unchanged failed-allocation `SessionEnvelope` |
| `cursor_resume_session` | `cwd`, `cursor_session_id`, `mode` | `model`, `effort`, `fast`, `optimize_for`, `plugin_dirs` | `SessionEnvelope` |
| `cursor_set_mode` | `session_id`, `mode` | — | `ActionEnvelope` + `mode` |
| `cursor_send_prompt` | `session_id`, `prompt` | — | `ActionEnvelope` |
| `cursor_session_status` | `session_id` | — | `SessionEnvelope` |
| `cursor_wait` | `session_id`, `turn_id` | `timeout_ms` | `WaitStateEnvelope` |
| `cursor_read_result` | `session_id`, `turn_id` | `offset` | `ResultPage` |
| `cursor_answer_question` | `session_id`, `turn_id`, `request_id`, `outcome` | `answers` | `ActionEnvelope` |
| plan/permission answer | `session_id`, `turn_id`, `request_id`, `decision` | — | `ActionEnvelope` |
| `cursor_cancel` | `session_id`, `turn_id` | — | terminal `ActionEnvelope` |
| `cursor_close_session` | `session_id` | — | session `ActionEnvelope` |

`model` is a nonempty UTF-8 base-model string within the usual input limit and
MUST NOT contain `[` or `]`; bracketed installed-CLI parameter syntax is not
part of the public MCP surface. `effort` is a nonempty token matching
`^[A-Za-z0-9._-]+$`; `fast` is boolean. Runtime rejects an invalid public shape
before allocation. The version-specific adapter/golden owns exact
installed-CLI encoding; explicit model selection is preflighted by MD-6 and a
subsequent Cursor rejection is an ordinary allocated-session init failure. Upper layers
do not own or repeat provider argv syntax.

`optimize_for` is exactly `cost|balanced|intelligence`. It is admitted only with
explicit `model:"auto-smart"`, and `auto-smart` requires explicit `optimize_for`.
Omitted model, `auto`, `default`, or another model with optimize_for is
`invalid_args` before allocation. Omitted model retains the existing `auto`
behavior; `auto` and `default` remain valid without optimize_for. Runtime does
not silently choose default_optimize_for; fresh selection lookup belongs to MD-6.
The version-specific adapter/golden owns the confirmed provider encoding;
there is no public generic parameter bag; uniform effort mapping belongs to MD-6.

#### Scenario: Explicit Auto strategy
- **WHEN** caller starts, delegates or resumes with auto-smart and one admitted optimize_for value
- **THEN** runtime preserves the requested strategy through the admitted provider adapter

#### Scenario: Auto strategy mismatch
- **WHEN** optimize_for lacks explicit auto-smart, or auto-smart lacks optimize_for
- **THEN** runtime returns invalid_args before allocation, without choosing a strategy


`cursor_send_prompt` MUST validate live session, nonempty prompt and absent active
turn before allocating `turn_id`; rejection creates no turn/event. `TurnSnapshot`
is `{turn_id,turn_status,result:null|BoundedText,terminal_reason:null|BoundedText,pending:PendingRequest[]}`.
`BoundedText` is `{text:string,truncated:boolean}`. Public input larger than 64 000
UTF-8 bytes is rejected before allocation; Cursor/OS-derived result, reason and
context text use the derived-text bound only through `BoundedText`.
For a completed result this is a preview; full text is retained separately
under «Полное чтение terminal result».
`PendingRequest` is `{request_id,kind,context}`. `context` is a bounded discriminated
union: question `{title:null|BoundedText,questions:Question[]}`, plan
`{title:null|BoundedText,body:BoundedText}`, permission
`{title:BoundedText,tool_kind:null|BoundedText,choices:("allow-once"|"reject-once")[],locations?:[{path:BoundedText,line?:number}]}`. No raw Cursor payload is exposed.
`Question` is
`{id,prompt:BoundedText,options:[{id,label:BoundedText}],allow_multiple:boolean}`. Question answer is
exactly either `{outcome:"answered",answers:[{question_id,selected_option_ids}]}`
with every referenced ID advertised and multiplicity respected, or
`{outcome:"skipped"}` or `{outcome:"cancelled"}`; free text is unsupported.
Plan response maps public `accept|reject` to the admitted adapter decision; its
exact ACP wire encoding is version-specific fixture detail.
`SessionEnvelope` is `{session_id,
session_state,cwd,mode,run_mode,sandbox,failure_kind:null|"spawn"|"init"|"init_timeout",
terminal_reason:null|BoundedText,last_event_id,active_turn:TurnSnapshot|null,last_terminal_turn:TurnSnapshot|null}`.
IUX-1 additionally includes `model:string`, `effort:null|string`,
`fast:null|boolean`, `optimize_for:null|string`, `plugin_dirs:string[]` and
`cursor_session_id:null|string`: `session_id` remains the runtime opaque ID;
`model` is `"auto"` when omitted; `cursor_session_id` is null before admitted
provider creation and otherwise is its exact opaque provider ID. On resume,
the supplied conversation ID is retained and echoed even when the admitted
provider-load result omits it; null is allowed
only when caller supplied none and provider creation was not admitted.
An admitted create/load result MUST include a current mode in `ask|plan|agent`
and available mode entries covering all three values. A missing/incomplete mode
shape or an unadmitted provider mode-transition result is an initialization failure;
runtime MUST NOT declare a possibly misaligned provider session live.
`failure_kind` is non-null only for a failed initialization; failure after a
started turn belongs to its `TurnEnvelope`, while the session field stays `null`.
`terminal_reason` is non-null only after terminalization. Public trace is outside
v1 scope; bounded pending context and terminal/result fields are the diagnostics.
`TurnEnvelope` extends `SessionEnvelope` with top-level `turn_id,turn_status`.
`WaitStateEnvelope` SHALL быть closed object с обязательными
`session_id,turn_id,turn_status,session_state,wait_timeout,pending`.
`pending` содержит все актуальные normalized `PendingRequest` этого хода,
включая bounded context, или пустой массив. Для terminal turn envelope MUST
содержать `result:null|BoundedText`, `terminal_reason:null|BoundedText` и
`terminal_receipt`; retained `provider_error` добавляется при наличии.
Для running turn на timeout `progress_excerpt` MUST присутствовать ровно тогда,
когда сохранён непустой accepted agent text, и содержит текущий bounded excerpt
по «Sparse wait and bounded progress». До первого такого текста и на остальных
ветках поле MUST отсутствовать.
Envelope MUST NOT содержать `events`, `events_lost`, `earliest_event_id`,
`last_event_id`, `resume_after_event_id`, `progress_revision` или session diagnostics.
Числа внутри immutable terminal receipt сохраняют прежний evidence смысл.

`ActionEnvelope` is intentionally not a `SessionEnvelope` or `TurnEnvelope`:
it contains `session_id,session_state,last_event_id` and, for a turn-targeting
operation, `turn_id,turn_status`, plus only its operation-specific fields.
`cursor_send_prompt`, all answer tools and `cursor_cancel` return
`ActionEnvelope`; `cursor_set_mode` adds `mode`; `cursor_close_session` returns
the session-only form when already idle,
or the turn-targeting form when it terminalizes an active turn. For a live
allocation, `cursor_delegate` adds only bootstrap `cursor_session_id,model` and
supplied non-null `effort,fast,optimize_for` to its prompt ActionEnvelope. An allocated
init/spawn failure instead returns its unchanged failed-allocation
`SessionEnvelope`, without `turn_id`. Live `ActionEnvelope`
acknowledgements MUST NOT contain `cwd`,
`run_mode`, `sandbox`, `plugin_dirs`, nested snapshots, nulls or empty
collections. Full session diagnostics remain the sole responsibility of
`cursor_session_status`; `cursor_start_session` and `cursor_resume_session`
remain bootstrap `SessionEnvelope` results.
Every terminal `cursor_wait`, `cursor_cancel`, and
`cursor_close_session` result MUST additionally contain `terminal_receipt` when a retained terminal turn exists.
It is `{session_id,turn_id,turn_status,last_event_id,result_sha256:null|string,
result_truncated:boolean}`. The hash is SHA-256 of the exact bounded public result
text; it is `null` only when the terminal result is `null`. `last_event_id` is
captured after the turn's terminal result event and the complete receipt MUST
remain immutable while later turns add session events. Receipt creation MUST
NOT read Cursor-private persistent stores or write a new persistent registry.
Каждый terminal `cursor_wait` SHALL возвращать retained bounded result,
reason и immutable receipt независимо от предыдущих или параллельных reads.
Mutation acknowledgements сохраняют compact receipt без повторной передачи result.
Полный retained text остаётся доступен через `cursor_read_result`.
`ResultPage` is the closed object
`{session_id,turn_id,offset,next_offset,eof,text,total_bytes,sha256}`. Offsets
and total are nonnegative safe integers in UTF-8 bytes; `offset` defaults to
zero, `next_offset` is null exactly at EOF, `eof` is boolean, `text` is a string
and `sha256` is the lowercase full-text SHA-256 hex digest. Paging behavior
belongs to «Полное чтение terminal result», numeric bounds to
«Нормативные limits runtime».
Every successful tool result is `CallToolResult{isError:false,content:[{type:"text",
text:JSON.stringify(the declared envelope)}]}`; it has no `structuredContent`.
Every domain/tool error is a successful JSON-RPC result `CallToolResult` with
`isError:true` and one text content containing JSON `{error_code,message}`;
`structuredContent` and output schemas are outside v1 scope. `error_code` is exactly one of
`invalid_args|unknown_session|unknown_turn|unknown_request|resource_limit|protocol_error|scope_rejected|invalid_text_encoding|mode_timeout|model_discovery_failed`. JSON-RPC `error` with integer
code is reserved for malformed JSON-RPC or unknown method.
For every existing-session tool, `unknown_session` and, where applicable,
`unknown_turn` MUST be returned before tool-specific provider dispatch, state
transition or effect; bounded tombstone eviction remains independent lifecycle
housekeeping and does not turn a rejected call into a dispatched operation.
Tool-local validation errors for wait address/timeout, result-read
address/offset, set-mode session/mode and answer address/request/answer shape
MUST be returned before that call creates a waiter/timer, dispatches to the
provider, changes session/turn state or performs the requested effect. This
does not promise that every malformed nested field is rejected before an
otherwise valid session lookup, and bounded tombstone housekeeping retains the
same carveout.
For an answer-tool error caused by an unknown/stale `request_id` on a live turn,
the error MUST additionally include `recovery:{session_id,turn_id,last_event_id,
pending:[{request_id,kind}]}`. It MUST NOT include pending context, permission
locations, raw ACP payload, or an automatic decision.

`RuntimeEvent.kind` is exactly `lifecycle|pending|result|todos|task|image`.
`RuntimeEvent` is `{event_id,kind,turn_id:null|string,payload}` where lifecycle
payload is `{scope:"session"|"turn",from,to}`. Session states are exactly
`starting|live|closing|tombstone`; turn states are exactly
`running|waiting_for_input|completed|failed|timed_out|cancelled`. `from` and `to`
use the union for their scope; only turn creation uses `from:null,to:"running"`.
Other payloads are exactly pending
`{action:"added"|"removed",request_id,request_kind}`, result `{turn_status}`,
todos `{merge:boolean,todos:[{id,content:{text,truncated},status:"pending"|"in_progress"|"completed"|"cancelled"}]}`,
task `{description:{text,truncated},type?:{text,truncated},model?:{text,truncated},duration?:number}`
or image `{description?:{text,truncated},path?:{text,truncated}}`.
State changes emit their stated event after storing the snapshot; eviction emits none.

#### Scenario: Tool-local invalid input rejected before requested effect
- **WHEN** wait, result-read, set-mode or answer input fails its local validation
- **THEN** runtime returns the normalized domain error before waiter/timer
  creation, provider dispatch, state transition or the requested effect

#### Scenario: Новый prompt во время active turn
- **WHEN** `cursor_send_prompt` получает session с active turn
- **THEN** runtime возвращает MCP error без allocation другого turn или event

#### Scenario: Неизвестный pending ID получает безопасный recovery
- **WHEN** answer-tool получает неизвестный или уже removed `request_id` активного хода
- **THEN** runtime возвращает `unknown_request` с точными IDs, current `last_event_id` и only pending IDs/kinds без context и не отправляет ACP answer

#### Scenario: Concurrent answers claim pending exactly once
- **WHEN** два answer-tool calls одновременно адресуют один live pending request
- **THEN** runtime атомарно резервирует его до provider await, отправляет ровно
  один ACP response, а второй call получает `unknown_request`

#### Scenario: Terminal receipt не создаёт второй архив
- **WHEN** ход завершается и caller получает terminal wait или close envelope
- **THEN** receipt содержит bounded public result hash и не читает `~/.cursor/acp-sessions`, не пишет persistent registry и не раскрывает raw payload

#### Scenario: Mutation acknowledgement не дублирует snapshot
- **WHEN** caller starts a turn, answers pending input, switches mode,
  cancels, closes or uses the delegate facade
- **THEN** response contains only the IDs/state and operation-specific outcome
  needed for the next workflow step; only delegate includes its one-time model
  bootstrap, and full snapshots remain available through explicit status

### Requirement: Адресуемое ожидание состояния сессии

Runtime SHALL предоставлять `cursor_wait({session_id,turn_id,timeout_ms?})`
с `WaitStateEnvelope` из SW-1. Состояния и numerical bounds принадлежат
существующим runtime owners; wait не создаёт новую машину состояний.

Для адресуемого terminal turn или хода с доступным pending request call MUST
вернуть текущее состояние немедленно с `wait_timeout:false`. Для running turn
без pending call MUST ждать pending, terminality либо истечения timeout.
Необязательные progress/lifecycle/events сами по себе MUST NOT завершать wait.
По timeout runtime SHALL заново проверить состояние: actionable state получает
`wait_timeout:false`, иначе возвращается running snapshot с `wait_timeout:true`.
Wait timeout MUST NOT отменять ход или подменять terminal `timed_out`.

Read MUST NOT потреблять pending/result, продвигать consumer cursor, менять
полномочия или продлевать retention. Одновременные waits наблюдают один источник
состояния независимо в пределах существующего waiter cap. Snapshot соответствует
одному моменту наблюдения; происходящие затем ответы могут сделать request stale.
Unknown session/turn и удалённые cursor arguments MUST давать существующие domain
errors до создания waiter/timer или provider effect. Допустимые адреса и eviction
остаются в существующем runtime lifecycle; после потери адресуемости read не
восстанавливает turn и не создаёт новую session.

#### Scenario: Таймаут ожидания
- **WHEN** ход продолжает выполняться без pending до timeout
- **THEN** wait возвращает `running`, `pending:[]`, `wait_timeout:true`, оставляя ход активным

#### Scenario: Pending request ожидает решения
- **WHEN** повторный wait адресует ход с нерешённым question, plan или permission
- **THEN** он немедленно возвращает актуальные IDs и полный normalized context независимо от предыдущего read

#### Scenario: Answer и следующий wait
- **WHEN** ответ потреблён, после него caller вызывает wait только с IDs
- **THEN** решённый request не возвращается; новый pending или terminal возвращается сразу, а running без pending ожидает

#### Scenario: Повторное ожидание terminal turn
- **WHEN** caller повторяет wait после потери terminal response, пока turn retained
- **THEN** result, reason и receipt доступны повторно для каждого terminal outcome

#### Scenario: Два читателя
- **WHEN** два admitted wait одновременно наблюдают retained turn
- **THEN** ни один не потребляет результат или pending другого; каждый получает состояние на момент собственного snapshot

#### Scenario: Progress flood и граница timeout
- **WHEN** идут progress updates, затем pending или terminality возникает около регистрации waiter либо timeout
- **THEN** progress не сокращает interval, actionable состояние не теряется и видимое на финальной проверке имеет приоритет над timeout

#### Scenario: Следующий ход и eviction
- **WHEN** сразу после terminality начинается следующий turn
- **THEN** уже принятый wait завершается snapshot своего turn; новые calls к более не retained turn получают `unknown_turn`, не результат следующего turn

#### Scenario: Граница cursor
- **WHEN** caller передаёт `after_event_id` или `after_progress_revision`
- **THEN** runtime возвращает `invalid_args` без waiter, provider dispatch и изменения хода

#### Scenario: Следующее ожидание использует explicit resume cursor
- **WHEN** legacy caller пытается продолжить старый workflow с explicit resume cursor
- **THEN** применяется отказ из сценария «Граница cursor»; после обновления caller наблюдает тот же retained turn по session/turn IDs согласно SW-2, без cursor migration или нового provider effect


#### Scenario: Ход Cursor завершился
- **WHEN** ожидаемый ход успешно заканчивается
- **THEN** wait возвращает completed snapshot с result и receipt, не завершая live session

#### Scenario: Deadline хода превышен
- **WHEN** runtime terminalizes ход по его execution deadline
- **THEN** wait возвращает `timed_out` с причиной и `wait_timeout:false`

#### Scenario: Устаревший идентификатор хода
- **WHEN** ID больше не принадлежит активному или retained terminal turn
- **THEN** новый wait получает `unknown_turn` и не затрагивает следующий ход

### Requirement: Sparse wait and bounded progress

Runtime SHALL сохранять только актуальный bounded progress excerpt принятого
agent message text согласно существующим numerical limits; raw chunks, thoughts
и provider frames не публикуются. SW-1 определяет его место в response,
SW-2 — wake semantics. Excerpt на timeout MAY повторяться между calls и
не требует consumer revision. Wait SHALL оставаться компактным snapshot target
turn без полного SessionEnvelope и журнала событий.
Полный result accumulator и его overflow сохраняют отдельный существующий
контракт «Полное чтение terminal result».

#### Scenario: Повторный progress
- **WHEN** после принятого непустого agent text два waits заканчиваются timeout без нового текста
- **THEN** оба возвращают одинаковый последний excerpt в пределах runtime bound

#### Scenario: Idle timeout has no repeated context
- **WHEN** два running waits заканчиваются timeout до первого непустого accepted agent text
- **THEN** оба snapshots не содержат `progress_excerpt` и full session context

#### Scenario: Pending context reaches the primary workflow
- **WHEN** primary workflow наблюдает pending request
- **THEN** применяется единственная pending delivery из SW-1/SW-2; отдельный diagnostic read или второй механизм доставки не нужен

#### Scenario: Event eviction
- **WHEN** internal event log вытеснил ранние события
- **THEN** wait по-прежнему возвращает актуальное состояние target turn без cursor recovery и без обещания восстановления истории


### Requirement: Role-neutral mode and collaboration surface

`cursor_set_mode({session_id,mode})` SHALL accept exact `ask|plan|agent` only
for a live session without an active turn. It forwards the admitted adapter
mode operation, returns `ActionEnvelope` plus the effective mode, and never allocates a
turn/session or changes launch model or plugin roots. Same mode is a
no-op; active/tombstone and provider-error paths leave state unambiguous. One
mode transition is exclusive per session: while its provider request is in
flight, another mode transition and `cursor_send_prompt` are rejected without
allocation. Idle TTL is suspended for the in-flight transition and rearmed only
after a committed successful mode. The provider transition is bounded by the
runtime-owned control-plane initialization timeout; a provider that never
replies terminalizes only that wrapper and returns `mode_timeout` rather than
leaving the session permanently transition-locked.
Fixed initialize capabilities and the current-mode write gate are owned by the
modified requirement «Режимы Cursor и ACP callbacks»; this requirement adds
only the between-turn transition behavior that lets an `ask → agent` workflow
reuse the same provider conversation.

Admitted version-specific nonblocking collaboration requests SHALL become
bounded typed events in the existing log.
Their projection contains only user-facing todo/task/image metadata defined by
the adapter; it excludes raw prompts, image bytes, filesystem content and raw
provider data. For every recognized request with an `id`, runtime SHALL make
exactly one synchronous empty-result response attempt while the provider
transport is writable, including for malformed or unadmitted data. Delivery is
not guaranteed: an already non-writable transport or synchronous send rejection
abandons that acknowledgement locally without retry or rewriting the already
established session/turn outcome. An asynchronous EPIPE after the frame was
accepted by `stdin.write` remains an ordinary runtime transport failure and
follows the existing fail-closed terminalization path. Malformed or unadmitted
data itself is ignored without terminalizing a healthy turn.
The versioned adapter/golden is the sole owner of the pinned Cursor version,
exact request/response wire keys and their mapping to internal bounded todo/task/image
evidence. Runtime tests MUST consume every golden variant, reject missing
required or additional wire keys, and prove that raw prompt, agent identity,
image references and other provider data are never published.

#### Scenario: Planning progress reaches the caller
- **WHEN** a plan or research turn publishes todos and a subagent completion
- **THEN** runtime retains their compact typed events internally; wait follows SW-2
  and does not report terminal or semantic completion until the prompt result arrives

#### Scenario: Ask переходит к implementation в той же session
- **WHEN** an idle `ask` session changes to `agent` and its next turn requests a
  contained write
- **THEN** the write callback succeeds; the same callback before the mode
  transition is rejected and creates no file

#### Scenario: Mode transition serializes the turn boundary
- **WHEN** provider mode change is still in flight and concurrent callers try a
  prompt or another mode change
- **THEN** both concurrent operations are rejected, provider receives only the
  original transition, and idle TTL restarts after its successful commit

#### Scenario: Provider не отвечает на mode transition
- **WHEN** admitted mode request remains unanswered through the runtime-owned
  control-plane timeout
- **THEN** the operation returns `mode_timeout`, the wrapper becomes a
  tombstone, and no prompt or second transition is allocated

### Requirement: Единая машина состояний runtime
Этот requirement — единственный нормативный источник переходов `session_state`,
`turn_status` и terminalization; `cursor_wait` владеет state observation/wake semantics,
а конфигурация runtime — TTL и limits. Design, facade и package MUST ссылаться
на соответствующего владельца, а не дублировать transition semantics.

| Trigger | `session_state` / `turn_status` | Required result | Emitted events |
|---|---|---|---|
| start/init success | `starting → live` / absent | session ready | `lifecycle` |
| init failure | `starting → closing → tombstone` / absent | `failure_kind`, без turn fields | lifecycle for each session transition |
| prompt | `live` / `running` | создаётся active turn | `lifecycle` |
| first ACP request | `live` / `running → waiting_for_input` | pending принадлежит turn | `pending`, then `lifecycle` |
| additional ACP request | `live` / `waiting_for_input` | pending принадлежит turn | `pending` |
| answer при remaining pending | `live` / `waiting_for_input` | turn остаётся waiting | `pending` removal |
| answer последнего pending | `live` / `waiting_for_input → running` | ACP получает answer | pending removal, then lifecycle |
| ACP result without pending | `live` / `completed` | terminal turn retained | `result{turn_status:"completed"}` |
| ACP result with pending | `live → closing → tombstone` / `failed` | protocol violation; shared shutdown settles pending | `result{failed}`, lifecycle transitions |
| first-prompt dispatch failure после allocation | `live → closing → tombstone` / `failed` | shared shutdown | `result{turn_status:"failed"}`, lifecycle transitions |
| child error/exit/stdout EOF/child-stdin EPIPE before result | `live → closing → tombstone` / `failed` | поздний exit snapshot не меняет | `result{failed}`, lifecycle transitions |
| child exit после ACP result | `live → closing → tombstone` / `completed` | completed snapshot сохраняется | lifecycle transitions |
| turn deadline | `live → closing → tombstone` / `timed_out` | shared shutdown | `result{timed_out}`, lifecycle transitions |
| cancel/close/MCP EOF/SIGINT/SIGTERM active turn | `live → closing → tombstone` / `cancelled` | shared shutdown | `result{cancelled}`, lifecycle transitions |
| close/MCP EOF/SIGINT/SIGTERM during starting | `starting → closing → tombstone` / absent | late init result игнорируется | lifecycle transitions |
| close/MCP EOF/SIGINT/SIGTERM live без active turn | `live → closing → tombstone` / last terminal or absent | shared shutdown | lifecycle transitions |
| repeat close in closing | `closing` / unchanged | joins same shutdown promise | none |
| close tombstone | `tombstone` / unchanged | idempotent same snapshot | none |
| idle TTL без active turn | `live → closing → tombstone` / last terminal or absent | shared shutdown | lifecycle transitions |
| tombstone TTL/cap | `tombstone → unknown` | eviction | none; record and its log are gone |

Runtime MUST хранить active turn и один last-terminal turn: T1 остаётся
доступным во время active T2 и заменяется лишь terminalization T2 либо eviction.
Turn text/result/pending изолированы. `cursor_cancel` применяет эту таблицу:
cancel retained target returns it unchanged and does not affect active turn;
cancel active target terminalizes it as `cancelled` and atomically replaces the
previous `last_terminal_turn`; неизвестный turn ID даёт MCP error.

#### Scenario: Одна машина для всех потребителей
- **WHEN** runtime, facade или package наблюдают lifecycle одной session
- **THEN** они применяют только этот requirement к transition/terminalization; wait, limits, envelopes и operations берут свои правила у соответствующих requirements

### Requirement: Изолированное состояние ходов и событий
Сервер SHALL реализовать turn isolation и события согласно единой машине
состояний. Все answer operations MUST проверять `session_id`, `turn_id`,
`request_id`; они ссылаются на state-machine owner для terminalization и очистки
pending. События SHALL оставаться внутренним bounded evidence runtime; публичное
наблюдение состояния определяется SW-1/SW-2 и не требует event cursor.

#### Scenario: Последовательные ходы
- **WHEN** в одной сессии выполнены два последовательных запроса
- **THEN** итог и текст второго хода не содержат фрагменты первого хода

#### Scenario: Устаревший курсор
- **WHEN** клиент передаёт прежний event cursor в wait после eviction событий
- **THEN** runtime отклоняет удалённый аргумент по SW-2; повторный call без cursor наблюдает retained turn независимо от event retention

#### Scenario: Идемпотентная отмена retained turn
- **WHEN** T1 completed, T2 running, а клиент вызывает `cursor_cancel(session_id, T1)`
- **THEN** сервер возвращает compact terminal `ActionEnvelope` с immutable receipt T1 без result и сохраняет T2 running; cancel active turn ждёт tombstone и возвращает compact cancelled `ActionEnvelope` по SW-1

#### Scenario: Поздний ответ прошлого хода
- **WHEN** request хода A отвечает после cancel, timeout или terminalization и уже начат ход B
- **THEN** сервер отклоняет ответ и не передаёт его ACP для хода B

#### Scenario: Поздний ACP result
- **WHEN** отменённый или timed-out prompt поздно возвращает ACP result
- **THEN** shared shutdown закрывает process; поздний result не меняет terminal turn или другой ход

### Requirement: Ограниченный жизненный цикл ACP-процесса
Сервер SHALL обрабатывать ошибку запуска дочернего процесса, таймауты
инициализации и хода, отмену, idle TTL, stdin EOF, EPIPE и закрытие сессии.
Он MUST ограничивать live sessions, pending requests, waiters и tombstones
зафиксированными internal constants. Process lifecycle выполняет side effects
shared shutdown, а state transitions, tombstone и eviction принадлежат единой
машине состояний.

Malformed/oversized ACP framing during init follows the table's init-failure
transition; during an active turn it follows its failed/shared-shutdown transition;
with no active turn it follows the live-close transition. Invalid/oversized callback
context, unsupported options and a pending-cap overflow are rejected by the admitted
adapter without publishing pending or terminalizing the turn. Exact wire errors are
fixture-local.

#### Scenario: Команда Cursor недоступна
- **WHEN** syntactically admitted Cursor executable is missing, non-executable or rejected by the OS at launch
- **THEN** it occurs after allocation and produces the allocated init tombstone with `failure_kind:"spawn"`; MCP-сервер продолжает обслуживать другие сессии

#### Scenario: Init failure освобождает slot
- **WHEN** spawn или init завершается ошибкой
- **THEN** process lifecycle освобождает child и live-session slot и передаёт init failure в state-machine owner

#### Scenario: Закрытие активной сессии
- **WHEN** клиент закрывает сессию с активным ходом
- **THEN** сервер закрывает admission, atomically removes each pending request and attempts exactly once its adapter-owned cancellation response; closed transport/EPIPE means locally abandoned with no retry. Затем он cancels process, ждёт grace и эскалирует до TERM/KILL; state-machine owner создаёт tombstone, а повторный close присоединяется к тому же завершению

#### Scenario: Результат после завершения процесса
- **WHEN** Cursor-процесс уже завершён, но result-retention TTL не истёк
- **THEN** status возвращает диагностический tombstone, а wait — retained terminal snapshot по SW-1/SW-2, без top-level event cursor

#### Scenario: Неожиданное завершение процесса
- **WHEN** active turn не получил ACP result до child error, exit, stdout EOF или child-stdin EPIPE
- **THEN** turn становится `failed`, сессия проходит shared shutdown в tombstone, а поздний exit не меняет terminal snapshot

#### Scenario: Явная остановка
- **WHEN** active turn останавливается cancel, close, MCP stdin EOF, SIGINT или SIGTERM
- **THEN** turn становится `cancelled`, затем shared shutdown создаёт tombstone; idle TTL применяется только при отсутствии active turn

#### Scenario: Истёк tombstone-retention TTL
- **WHEN** клиент обращается к записи после удаления tombstone
- **THEN** сервер возвращает unknown session и не запускает новый процесс

### Requirement: Нормативные limits runtime
Этот requirement — единственный владелец численных bounds. Все значения
inclusive; overflow/вне диапазона public arg даёт MCP error без mutation.
Runtime MUST применять следующую таблицу.

| Name | Value / range | Overflow action |
|---|---|---|
| model discovery slots | 1 per MCP runtime | resource_limit без очереди |
| model discovery total timeout | 15 000 ms | model_discovery_failed, abort HTTP/stream |
| model discovery response payload | 1 048 576 bytes | resource_limit, abort HTTP/stream; separate from public input bound |
| init timeout | fixed 15 000 ms | terminal init timeout |
| turn timeout | fixed 3 600 000 ms | terminal turn timeout |
| idle TTL | fixed 900 000 ms | shared shutdown |
| wait timeout | default 30 000 ms, 1 000..180 000 | MCP error |
| progress excerpt | fixed 512 UTF-8 bytes | retain newest bounded excerpt |
| live slots / pending / waiters | 8 / 8 per turn / 8 per session | pre-allocation MCP error / resource_limit |
| tombstones | 64 | evict expired, then lowest `(tombstoned_at, session_id)` |
| events | 256 | FIFO: lowest `event_id` |
| shutdown grace / tombstone retention | 5 000 / 300 000 ms | shared shutdown / unknown after retention |
| public input / derived text / FS file | 64 000 / 8 000 / 1 048 576 UTF-8 bytes | reject input / BoundedText truncation / resource_limit |
| retained result per turn / result page | 1 048 576 / 8 000 UTF-8 bytes | explicit terminal failure / Unicode-safe page |
| ACP NDJSON frame / normalized pending context | 1 048 576 / 64 000 UTF-8 bytes | protocol_error / resource_limit before publication |

These are internal constants, not operator configuration. Idle TTL starts after init success and terminal completion, stops while active
turn exists, and status/wait/read do not reset it. Tombstone retention starts once at
`tombstoned_at` and close/read never reset it. Event IDs never wrap; exhaustion is
unreachable under the bounded local-session contract and has no public failure kind.

#### Scenario: Deterministic eviction
- **WHEN** a new tombstone exceeds cap
- **THEN** runtime evicts expired records first, otherwise lowest `(tombstoned_at, session_id)`

These values are not operator settings.

#### Scenario: Three-minute wait cap
- **WHEN** caller supplies integer `timeout_ms` in 1 000..180 000
- **THEN** runtime admits it, while a value above 180 000 is rejected without
  allocation or state mutation

### Requirement: Режимы Cursor и ACP callbacks
Runtime SHALL expose the normalized `mode=ask|plan|agent` and immutable process
policy metadata `run_mode=auto_review`, `sandbox=enabled`. A version-specific
Cursor adapter fixture admits a process only when it proves the required mode and
callback capabilities; admission failure is init failure. Exact argv, ACP methods,
payload encoding and version belong only to that fixture.

До handshake runtime MUST применить fixed process capabilities
read=true/write=true/terminal=false, потому что admitted mode может меняться
между turns без перезапуска ACP process. Handler всё равно MUST допускать write
только при current `mode=agent`; тот же callback в `ask|plan` возвращает
`scope_rejected`. Handlers use admitted adapter callbacks, canonical containment,
regular-file and strict UTF-8 checks, and the shared byte cap. Write is full
create-or-replace UTF-8: it requires matching session/capability/current mode, an
absolute path, existing regular non-symlink target inside `cwd` or an existing
canonical parent inside `cwd` for a new target; directory, symlink, outside-cwd
and oversized values reject. It returns the admitted adapter success or error
outcome; no atomic/no-partial promise is made. Cursor-specific wire normalization
is adapter-owned and covered by fixtures. Эти callbacks не являются OS sandbox;
Cursor Auto-Review может самостоятельно не эскалировать safe action. Caller
наблюдает normalized pending question/plan/permission requests через wait;
collaboration evidence определяется «Role-neutral mode and collaboration surface».
Filesystem callbacks выполняются и
получают response только через runtime mode/cwd/text/limit checks. Unsupported
callbacks получают bounded provider error, а malformed/unadmitted collaboration
requests отклоняются или acknowledged-and-ignored согласно их owner contract,
но не объявляются caller-visible requests.

#### Scenario: Plan читает fixture
- **WHEN** Cursor в `plan` запрашивает text file внутри session `cwd`
- **THEN** runtime возвращает bounded content через ACP callback, но отклоняет write и terminal callback

#### Scenario: Agent пишет в workspace
- **WHEN** Cursor после перехода в `agent` запрашивает write внутри session `cwd`
- **THEN** runtime выполняет bounded write callback без нового ACP process; write в `ask|plan` либо путь вне/symlink за `cwd` отклоняется

#### Scenario: Cap и текстовый range
- **WHEN** read-файл больше `FS file` limit, даже если adapter запрашивает малый range
- **THEN** runtime возвращает `resource_limit` до decode; malformed UTF-8 меньшего файла возвращает `invalid_text_encoding`, а `line` за EOF — пустой content

#### Scenario: Auto-review с sandbox
- **WHEN** delegate запускает v1 session through an admitted Cursor adapter
- **THEN** runtime возвращает оба immutable metadata, exposes only admitted
  normalized pending evidence and handles collaboration according to
  «Role-neutral mode and collaboration surface», and does not claim that every
  provider callback becomes a caller-visible permission request

### Requirement: Полное чтение terminal result
Runtime MUST retain the exact concatenated normalized ACP agent-message text
up to the retained-result bound, rather than truncating the accumulator to
preview size. Thinking, tools and private archives are not result sources.
This is the existing public agent-text stream, not a claim of provider-side
final-phase separation. The bounded preview and its immutable terminal receipt
remain compatible: receipt hash describes preview bytes, `ResultPage.sha256`
describes the full retained result. Empty completed text is a valid full result.

`cursor_read_result` MUST synchronously read only the addressed retained last
terminal turn with a non-null result. It MUST NOT call the provider, create a
turn/event, or refresh idle/retention timers. It
returns the largest whole-code-point prefix from `offset` within the page
bound, with exact next offset; concatenating sequential pages from zero to EOF
reproduces the result and its full digest without omission or duplication.
At `offset = total_bytes` return empty text and EOF. A negative, noninteger,
out-of-range or non-code-point-boundary offset returns `invalid_args`.
Unknown session/turn uses existing errors; an active turn or null result uses
`protocol_error`. Repeating a read is idempotent. A retained previous terminal
result remains readable while a newer turn runs, until that newer turn becomes
the retained last terminal. Close preserves reads only within existing
tombstone retention/eviction; expired or replaced data is not reconstructed.
No disk spool, persistent registry, separate result lifecycle or archive API is
introduced: storage belongs to the existing active and last-terminal turns.

If accepted text would exceed the retained-result limit, runtime MUST stop that
turn through the existing failed-turn shutdown path with bounded reason
`terminal_result_limit`, null result and no full-result digest. Partial text
MUST NOT be published as a complete result or silently clipped to success.
A prefix is not recovered by asking the provider to regenerate the answer.

#### Scenario: Long review remains completely readable
- **WHEN** a completed review exceeds the preview bound within the retained limit
- **THEN** terminal wait exposes the bounded preview according to «Публичный MCP tool contract»; sequential explicit
  reads recover every finding including the tail, with a matching full digest

#### Scenario: UTF-8 page and retention boundaries
- **WHEN** pages cross multibyte characters, a page is repeated, or the caller
  reads after close while the terminal turn remains retained
- **THEN** exact text and stable offsets/digest are preserved without provider
  calls, events or timer extension; replaced/evicted IDs use existing errors

#### Scenario: Result exceeds the storage limit
- **WHEN** agent text crosses the retained-result cap
- **THEN** the turn fails with `terminal_result_limit` and null result; caller
  cannot mistake a partial preview or digest for complete review evidence
