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
For a completed TurnSnapshot result this remains a diagnostic preview; full text is retained separately
under «Полное чтение terminal result». Terminal wait uses ResultPage as specified below;
the derived-text BoundedText limit does not bound ResultPage.
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
содержать `result_page:null|ResultPage`, `terminal_reason:null|BoundedText` и
`terminal_receipt`; retained `provider_error` добавляется при наличии. Поле
`result` в WaitStateEnvelope MUST отсутствовать. Ненулевой result_page MUST
содержать первую страницу адресованного turn по RP-2, с session_id/turn_id,
совпадающими с envelope. При отсутствии terminal result result_page MUST быть
null; это не пустой успешный результат. На nonterminal ветках result_page MUST
отсутствовать.
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
result_truncated:boolean}`. The hash remains SHA-256 of the exact bounded diagnostic preview
text, including its existing truncation suffix; it is `null` only when the terminal result is `null`.
`result_truncated` continues to describe that preview. Neither field describes
ResultPage bytes, EOF or the full-result digest; consumers MUST NOT substitute
the page/full digest for the preview digest. A complete first page may coexist
with `result_truncated:true`. `last_event_id` is
captured after the turn's terminal result event and the complete receipt MUST
remain immutable while later turns add session events. Receipt creation MUST
NOT read Cursor-private persistent stores or write a new persistent registry.
Каждый terminal `cursor_wait` SHALL возвращать первую retained страницу или null,
reason и immutable receipt независимо от предыдущих или параллельных reads.
Mutation acknowledgements сохраняют compact receipt без повторной передачи result.
Диагностический TurnSnapshot сохраняет прежний preview; wait MUST NOT дополнительно
передавать его текст. Полный retained text остаётся доступен через `cursor_read_result`.
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

#### Scenario: Первая страница вместо preview
- **WHEN** caller получает terminal wait с непустым retained result
- **THEN** envelope содержит один result_page по RP-2, без result/дублирующего preview; immutable receipt сохраняет прежний смысл независимо от EOF страницы

#### Scenario: Пустой и отсутствующий результат
- **WHEN** terminal outcome содержит пустой успешный текст либо не содержит результата
- **THEN** wait возвращает соответственно пустую EOF-страницу по RP-2 либо result_page:null; это разные outcomes

### Requirement: Полное чтение terminal result
Runtime MUST retain the exact concatenated normalized ACP agent-message text
up to the retained-result bound, rather than truncating the accumulator to
preview size. Thinking, tools and private archives are not result sources.
This is the existing public agent-text stream, not a claim of provider-side
final-phase separation. Diagnostic preview and immutable terminal receipt сохраняют смысл по RP-1.
`ResultPage.sha256` describes the full retained result. Empty completed text is a valid full result.

`cursor_read_result` MUST synchronously read only the addressed retained last
terminal turn with a non-null result. It MUST NOT call the provider, create a
turn/event, or refresh idle/retention timers. It
MUST использовать одно правило для public read и первой страницы terminal wait:
если оставшийся от offset текст не превышает максимальный result-page bound RP-3,
страница содержит весь остаток; иначе она содержит наибольший whole-code-point
prefix в пределах номинального result-page bound RP-3. Текст страницы MUST быть
точным срезом retained текста без синтетического suffix и без Unicode normalization.
Точный следующий offset равен offset плюс числу UTF-8 bytes возвращённого текста,
либо null на EOF. Sequential pages от нуля до EOF воспроизводят результат и его
полный digest без пропусков или дублирования. Для доступного retained turn первая
страница wait MUST совпадать со всеми полями cursor_read_result(offset:0).
Уже принятый wait сохраняет свой адресованный turn по RP-4; это не расширяет
адресуемость последующих public reads.
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
- **THEN** terminal wait exposes the first ResultPage according to RP-1; only necessary continuation
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

#### Scenario: Полный результат близок к номинальной странице
- **WHEN** результат превышает nominal bound, но не превышает maximum bound RP-3
- **THEN** terminal wait и read с нуля возвращают весь результат с EOF; отдельное чтение хвоста не требуется

#### Scenario: Остаток объединяется с последней страницей
- **WHEN** после первой страницы оставшийся текст не превышает maximum bound RP-3
- **THEN** read по возвращённому next_offset отдаёт весь остаток, включая часть сверх nominal bound, с EOF

#### Scenario: Верхняя граница объединения
- **WHEN** остаток равен maximum bound RP-3 либо превышает его
- **THEN** при равенстве возвращается весь остаток; при превышении возвращается только nominal whole-code-point prefix с continuation, без повышения maximum

#### Scenario: Потеря адресуемости между страницами
- **WHEN** после wait retained turn заменён либо session evicted до следующего read
- **THEN** read возвращает существующий unknown_turn либо unknown_session; runtime не восстанавливает результат и не возвращает страницу другого turn

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
| retained result per turn | 1 048 576 UTF-8 bytes | explicit terminal failure |
| result page nominal / maximum | 8 000 / 10 000 UTF-8 bytes | Unicode-safe page / объединение остатка только по RP-2 |
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

#### Scenario: Отдельная граница результата
- **WHEN** runtime возвращает расширенную result page
- **THEN** её размер MUST не превышать result page maximum; derived-text, pending/context, retained-result и остальные bounds остаются независимыми и неизменными

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
- **THEN** result_page (включая null), reason и receipt доступны повторно для каждого terminal outcome по RP-1, без учёта предыдущей доставки

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
- **THEN** wait возвращает completed snapshot с result_page и receipt по RP-1, не завершая live session

#### Scenario: Deadline хода превышен
- **WHEN** runtime terminalizes ход по его execution deadline
- **THEN** wait возвращает `timed_out` с причиной и `wait_timeout:false`

#### Scenario: Устаревший идентификатор хода
- **WHEN** ID больше не принадлежит активному или retained terminal turn
- **THEN** новый wait получает `unknown_turn` и не затрагивает следующий ход

#### Scenario: Принятый wait сохраняет страницу своего turn
- **WHEN** принятый wait завершается после terminality, а более новый turn уже стал retained last terminal
- **THEN** этот wait возвращает страницу своего захваченного turn; новый read прежнего turn получает существующий unknown_turn без переноса страницы нового turn
