## MODIFIED Requirements

### Requirement: Публичный MCP tool contract

Runtime SHALL быть единственным владельцем MCP schemas и всех response envelopes. Tools:
`cursor_start_session({cwd,mode,model?,effort?,fast?,plugin_dirs?})`,
`cursor_delegate({cwd,mode,prompt,model?,effort?,fast?,plugin_dirs?})`,
`cursor_resume_session({cwd,cursor_session_id,mode,model?,effort?,fast?,plugin_dirs?})`,
`cursor_set_mode({session_id,mode})`, `cursor_send_prompt({session_id,prompt})`,
`cursor_session_status({session_id})`, `cursor_read_result({session_id,turn_id,offset?})`,
`cursor_wait({session_id,turn_id,after_event_id?,after_progress_revision?,timeout_ms?})`,
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
`after_event_id`/`timeout_ms` имеют ranges из «Нормативные limits runtime».

| Tool | Required input | Optional input | Success output |
|---|---|---|---|
| `cursor_start_session` | `cwd`, `mode` | `model`, `effort`, `fast`, `plugin_dirs` | `SessionEnvelope` |
| `cursor_delegate` | `cwd`, `mode`, `prompt` | `model`, `effort`, `fast`, `plugin_dirs` | bootstrap `ActionEnvelope` or unchanged failed-allocation `SessionEnvelope` |
| `cursor_resume_session` | `cwd`, `cursor_session_id`, `mode` | `model`, `effort`, `fast`, `plugin_dirs` | `SessionEnvelope` |
| `cursor_set_mode` | `session_id`, `mode` | — | `ActionEnvelope` + `mode` |
| `cursor_send_prompt` | `session_id`, `prompt` | — | `ActionEnvelope` |
| `cursor_session_status` | `session_id` | — | `SessionEnvelope` |
| `cursor_wait` | `session_id`, `turn_id` | `after_event_id`, `after_progress_revision`, `timeout_ms` | `WaitDeltaEnvelope` |
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
installed-CLI encoding; model-specific availability is not prevalidated and a
Cursor rejection is an ordinary allocated-session init failure. Upper layers
do not own or repeat provider argv syntax.

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
`fast:null|boolean`, `plugin_dirs:string[]` and
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
`WaitDeltaEnvelope` is intentionally not a `SessionEnvelope` or `TurnEnvelope`:
it contains only `session_id,turn_id,turn_status,session_state,last_event_id,
resume_after_event_id,wait_timeout,events_lost` plus its changed nonempty delta
fields. `resume_after_event_id` equals `last_event_id` and is the cursor for a
following wait. A nonempty `pending` delta contains the complete normalized
`PendingRequest`, including its bounded `context`; this is the primary workflow
delivery path and MUST NOT require a diagnostic status call. Empty events,
pending, result, receipt, nulls and unrelated session diagnostics are omitted.
`ActionEnvelope` is intentionally not a `SessionEnvelope` or `TurnEnvelope`:
it contains `session_id,session_state,last_event_id` and, for a turn-targeting
operation, `turn_id,turn_status`, plus only its operation-specific fields.
`cursor_send_prompt`, all answer tools and `cursor_cancel` return
`ActionEnvelope`; `cursor_set_mode` adds `mode`; `cursor_close_session` returns
the session-only form when already idle,
or the turn-targeting form when it terminalizes an active turn. For a live
allocation, `cursor_delegate` adds only bootstrap `cursor_session_id,model` and
supplied non-null `effort,fast` to its prompt ActionEnvelope. An allocated
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
The first terminal `cursor_wait` for a target turn delivers its bounded result
and receipt exactly once; repeated waits for that same retained turn omit both.
Subsequent mutation acknowledgements MAY carry the compact immutable receipt of
the affected or most recently delivered terminal turn, but MUST omit
`last_terminal_turn` and MUST NOT redeliver its bounded result. The full retained
snapshot preview is otherwise available only through explicit
`cursor_session_status`; full text is read through `cursor_read_result`.
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
`invalid_args|unknown_session|unknown_turn|unknown_request|resource_limit|protocol_error|scope_rejected|invalid_text_encoding|mode_timeout`. JSON-RPC `error` with integer
code is reserved for malformed JSON-RPC or unknown method.
For every existing-session tool, `unknown_session` and, where applicable,
`unknown_turn` MUST be returned before tool-specific provider dispatch, state
transition or effect; bounded tombstone eviction remains independent lifecycle
housekeeping and does not turn a rejected call into a dispatched operation.
Tool-local validation errors for wait address/cursors/timeout, result-read
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
наблюдает normalized pending question/plan/permission requests и admitted
collaboration projections через wait; filesystem callbacks выполняются и
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
  normalized pending/collaboration evidence, and does not claim that every
  provider callback becomes a caller-visible permission request

## ADDED Requirements

### Requirement: Явный выбор модели запуска
IUX-1 owns public `model` input, its forwarded `auto` default and envelope
representation. IUX-4 owns only the resulting per-session launch behavior.

Runtime MUST NOT проверять availability через отдельный provider discovery,
выбирать fallback, заменять model value, читать или писать глобальную Cursor
конфигурацию. Model availability и точный CLI argv остаются
version-specific adapter/golden-fixture evidence для admitted Cursor version.
Если Cursor отвергает значение при запуске, session завершается штатной init
failure с echo `model` в envelope; другой session не затрагивается.

#### Scenario: Явная модель изолирована от глобальной конфигурации
- **WHEN** caller запускает session с `model: "grok-4.6"`
- **THEN** runtime applies exact `grok-4.6` only to that ACP process and does
  not write global Cursor configuration

#### Scenario: Auto запускается только для текущей сессии
- **WHEN** caller omits `model`
- **THEN** runtime launches per-session `auto` without reading or writing a
  global Cursor default or creating a model registry

### Requirement: Per-session параметры модели
IUX-1 owns optional `effort` and `fast`, their validation and envelope fields;
when omitted both envelope fields are `null`. IUX-7 owns only their per-session
launch behavior: runtime SHALL forward exact supplied values without model-specific
availability checks, defaults, fallback, global-config read or write. Exact
parameterized-model argv encoding belongs to the version-specific adapter/golden
fixture.

#### Scenario: Effort и fast применяются только к одной сессии
- **WHEN** caller supplies `effort` and/or `fast`
- **THEN** only that ACP process receives their adapter-defined override; a
  different session retains its own values

### Requirement: Продолжение Cursor-сессии
`cursor_resume_session` schema, `cursor_session_id` representation and
`SessionEnvelope` fields are owned by IUX-1. Resume applies the same validated
`mode` and optional model-parameter override semantics as a new runtime session.

Resume MUST создать новый runtime-owned MCP `session_id`, canonicalize `cwd` и
проверить allowed roots до spawn. После обычных initialize/authenticate runtime
вызывает version-specific adapter load operation с provided opaque
`cursor_session_id` и validates the admitted load result. Exact load params and
result shape are
version-specific adapter/golden-fixture evidence, not a long-lived product
schema. Resume MUST NOT allocate a turn or send a prompt, enumerate provider sessions,
read Cursor-private storage, rewrite global configuration, or fall back to
new provider session creation when provider load fails.

Provider load failure terminalizes only the allocated runtime session with the
ordinary init/protocol failure semantics and echoes the supplied
`cursor_session_id`; it MUST NOT prove history was restored or semantic task
success. An unexpected result-side ID is adapter drift and a protocol failure, not a second provider
ID. A live runtime session is continued with existing `cursor_send_prompt`, not
this tool.

#### Scenario: Continuation starts a new MCP wrapper around an old Cursor session
- **WHEN** caller invokes `cursor_resume_session` with a previously returned
  `cursor_session_id`
- **THEN** runtime returns a new opaque MCP `session_id`, preserves the same
  provider ID, sends no prompt, and later permits `cursor_send_prompt` after
  successful provider load

#### Scenario: Provider session cannot be resumed
- **WHEN** Cursor rejects or cannot load the supplied `cursor_session_id`
- **THEN** runtime reports only the allocated session's ordinary bounded
  failure, does not list/archive-search or silently create a replacement session

## MODIFIED Requirements

### Requirement: Адресуемое ожидание состояния сессии
Сервер SHALL предоставлять `cursor_wait(session_id, turn_id, after_event_id?,
after_progress_revision?, timeout_ms?)` согласно единой машине состояний для
конкретного хода с ограниченным таймаутом. Результат MUST
быть sparse `WaitDeltaEnvelope`, определённым requirement «Sparse wait and
bounded progress»: mandatory адресные/state/cursor fields плюс только changed
nonempty events, complete normalized pending context, result, receipt и progress.
Одинаковый cursor допускает независимые повторные wait; превышение bounded
waiter cap отклоняется.
`event_id` — generated safe integer 1..9 007 199 254 740 991, первый 1;
optional `after_event_id` — safe integer 0..9 007 199 254 740 991 (omission=0).
Events находятся в одном bounded session-wide log: turn event содержит `turn_id`,
lifecycle event может не содержать его. Фильтр возвращает target events и affecting lifecycle;
ID могут иметь пропуски, `last_event_id` — high-water mark, `earliest_event_id`
— retained watermark. Future cursor — MCP error; `events_lost=true` только если
после cursor были удалены события.
Result MUST additionally contain
`resume_after_event_id`, equal to its `last_event_id`, and that value MUST be a
valid cursor for the next wait for the same turn.

#### Scenario: Ход Cursor завершился
- **WHEN** клиент ожидает активную сессию и Cursor заканчивает ход
- **THEN** ожидание возвращает `turn_status=completed`, итог хода, идентификатор события и отдельный `session_state=live` без polling полного журнала

#### Scenario: Повторное ожидание terminal turn
- **WHEN** клиент повторяет wait T1 после одноразовой доставки terminal result
- **THEN** сервер возвращает только mandatory sparse fields и genuinely new
  retained events, не дублируя terminal snapshot/result

#### Scenario: Таймаут ожидания
- **WHEN** за заданный интервал состояние сессии не изменилось
- **THEN** ожидание возвращает sparse state/cursor fields с `wait_timeout=true`
  и не изменяет ход Cursor

#### Scenario: Deadline хода превышен
- **WHEN** активный ход превышает сконфигурированный deadline выполнения
- **THEN** сервер отменяет ход и сохраняет терминальное состояние `timed_out` с причиной превышения deadline

#### Scenario: Устаревший идентификатор хода
- **WHEN** клиент ожидает или отменяет `turn_id`, который не является ни активным, ни сохранённым последним terminal turn этой session/tombstone
- **THEN** сервер отклоняет операцию и не затрагивает следующий ход той же сессии

#### Scenario: Граница cursor
- **WHEN** `after_event_id` больше session high-water mark
- **THEN** сервер возвращает MCP error без изменения state; `after_event_id=0` сообщает `events_lost=false`, пока после него не было eviction

#### Scenario: Pending request ожидает решения
- **WHEN** Cursor публикует question, plan или permission request
- **THEN** `cursor_wait` возвращает `waiting_for_input`, pending ID и контекст, а ход не завершается

#### Scenario: Следующее ожидание использует explicit resume cursor
- **WHEN** `cursor_wait` возвращает timeout, pending или terminal snapshot
- **THEN** `resume_after_event_id` равен returned `last_event_id` и может быть передан следующему wait без повторного устаревшего cursor

### Requirement: Нормативные limits runtime
Этот requirement — единственный владелец численных bounds. Все значения
inclusive; overflow/вне диапазона public arg даёт MCP error без mutation.
Runtime MUST применять следующую таблицу.

| Name | Value / range | Overflow action |
|---|---|---|
| init timeout | fixed 15 000 ms | terminal init timeout |
| turn timeout | fixed 3 600 000 ms | terminal turn timeout |
| idle TTL | fixed 900 000 ms | shared shutdown |
| wait timeout | default 30 000 ms, 1 000..180 000 | MCP error |
| progress excerpt | fixed 512 UTF-8 bytes | retain newest bounded excerpt |
| live slots / pending / waiters | 8 / 8 per turn / 8 per session | pre-allocation MCP error / resource_limit |
| tombstones | 64 | evict expired, then lowest `(tombstoned_at, session_id)` |
| events | 256 | FIFO: lowest `event_id`; update earliest watermark/events_lost |
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

## ADDED Requirements

### Requirement: Seamless per-session launch

Runtime SHALL admit `plugin_dirs?:string[]` only in `cursor_start_session`,
`cursor_delegate` and `cursor_resume_session`. `plugin_dirs` contains nonempty absolute local directories
canonicalized under the same allowed roots as `cwd`, de-duplicated in caller
order, and forwards the canonical roots through the version-specific adapter
only to that child. The SessionEnvelope returns `plugin_dirs`. The closed public
schemas reject every unlisted launch control before allocation; exact excluded
provider flags and their current semantics remain version-specific
adapter/golden evidence, not a product requirement.

#### Scenario: Plugin bundle is local and scoped
- **WHEN** caller supplies an Agent Plugin root containing skills and `mcp.json`
- **THEN** exactly that canonical root is passed through the adapter; runtime
  neither copies files nor mutates provider configuration

### Requirement: Sparse wait and bounded progress

`cursor_wait` SHALL return `WaitDeltaEnvelope`, not a SessionEnvelope-derived
snapshot. It always contains session ID, target turn ID/status, session state,
`last_event_id`, `resume_after_event_id`, `wait_timeout` and `events_lost`.
`events`, complete normalized pending requests with bounded context, result,
reason, receipt, `progress_revision` and
`progress_excerpt` appear only when nonempty or changed for this wait; normal
wait output MUST omit model, run mode, sandbox, full nested snapshots, nulls and
empty arrays. `cursor_session_status` remains the full diagnostic owner.
On a timeout `after_progress_revision?:safe integer` selects a delta from
accepted `agent_message_chunk` text only. The reply contains the current revision
and at most 512 UTF-8 bytes only when it advanced; it never exposes thought,
tool payload, transcript archive or provider frame.
Progress state is independent from the bounded terminal-result accumulator:
each accepted nonempty chunk advances the monotonic revision after the
preview saturates while the retained full result remains within its cap;
crossing that cap terminalizes through «Полное чтение terminal result».
Progress retains only the newest bounded
512-byte excerpt, so multiple updates between waits MAY coalesce; it MUST NOT
retain an array of raw chunks.

#### Scenario: Idle timeout has no repeated context
- **WHEN** two waits time out without a new accepted message chunk
- **THEN** the second output has no `progress_excerpt`, no empty events/pending
  arrays and no duplicated terminal snapshot

#### Scenario: Pending context reaches the primary workflow
- **WHEN** Cursor publishes a question, plan or permission request
- **THEN** the next `cursor_wait` returns its exact request ID, kind and bounded
  normalized context without a `cursor_session_status` call

### Requirement: Provider errors are bounded and classified

For an outstanding provider RPC, a structurally valid JSON-RPC `error` SHALL
be normalized to bounded `provider_error:{code,message}` without `error.data`.
It is additive diagnostics, never a new public `error_code`: immediate tool
errors retain `protocol_error`; envelope paths retain their existing operation
classification.
Init, prompt and load errors retain their operation classification and
terminalize only the affected starting session or active turn. Malformed frames,
EOF and spawn remain distinct transport/init failures. Late response/error after
terminality is ignored and cannot resurrect state.

#### Scenario: Provider rejects session load
- **WHEN** the admitted provider rejects a load operation
- **THEN** the new wrapper becomes terminal with bounded provider code/message,
  and runtime does not create a replacement provider session

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
exact request/response wire keys and their mapping to the public todo/task/image
projection. Runtime tests MUST consume every golden variant, reject missing
required or additional wire keys, and prove that raw prompt, agent identity,
image references and other provider data are never published.

#### Scenario: Planning progress reaches the caller
- **WHEN** a plan or research turn publishes todos and a subagent completion
- **THEN** a following wait returns their compact typed events, but does not
  report terminal or semantic completion until the prompt result arrives

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
turn/event, change wait delivery state, or refresh idle/retention timers. It
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
- **THEN** terminal wait delivers a truncated preview once; sequential explicit
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
