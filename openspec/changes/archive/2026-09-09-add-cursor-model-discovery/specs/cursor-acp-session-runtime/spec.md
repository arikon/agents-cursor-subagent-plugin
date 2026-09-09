## ADDED Requirements

### Requirement: Получение моделей Cursor через MCP

Runtime SHALL предоставлять `cursor_list_models` как отдельную операцию без allocation ACP-сессии или turn. Вход — только пустой JSON object; дополнительные поля дают `invalid_args`. Success `ModelCatalog` — closed object `{models:[{id:string,name:string,effort?:string[],fast?:boolean[],optimize_for?:string[],default_optimize_for?:string}]}`. ID/name — точные непустые строки provider, model IDs уникальны, порядок provider сохраняется. `effort` содержит допустимые строковые значения provider effort-параметра, сопоставленного единственным resolver MD-6; `fast` присутствует только при объявленном точном ID `fast` и содержит разрешённые boolean значения, преобразованные из provider строк `"false"`/`"true"`. Unsupported параметры отсутствуют, не заменяются пустым списком. Version-specific mapping `effort`/`reasoning`/`reasoning_effort` принадлежит MD-6; значения сохраняются без синонимов. Для `auto-smart` точный provider parameter `optimize_for` возвращается в одноимённом поле; `default_optimize_for` возвращается только при единственном provider default variant с объявленным значением optimize_for. Отсутствие default variant не синтезирует default; неоднозначный либо невалидный default даёт model_discovery_failed. Другие параметры, aliases и полные variants не входят в MCP output. Модель `default` возвращается с точными id/name; её существующий alias `auto` остаётся допустимым launch ID, без общего aliases array. Это снимок базовых моделей и разрешённых значений поддержанных параметров официального recommended каталога, не гарантия всех CLI моделей, произвольных сочетаний параметров или будущего запуска. Выбор Auto описан MD-2; общего механизма произвольных model parameters нет.

Каждый вызов MUST получать актуальный каталог через официальный публичный API каталога SDK, используя исключительно `apiKey` из `~/.cursor/auth.json` текущего пользователя MCP-хоста. Runtime MUST NOT использовать fallback auth/source, запускать CLI/prompt, создавать ключ, refresh/login, писать auth/config, изменять live sessions либо создавать постоянный cache/registry. `cwd`/session ID не нужны. Account API key может отличаться от account CLI. Discovery и launch используют общий resolver MD-6; каталог не является permission gate.

Отсутствующий auth file либо отсутствующий, нестроковый или blank `apiKey` MUST давать `model_discovery_failed` с сообщением получить Cursor API KEY и записать поле `apiKey` в `~/.cursor/auth.json`. Нечитаемый/некорректный JSON auth file даёт тот же код с безопасным actionable сообщением проверить этот файл. HTTP failure, network failure, timeout, некорректные UTF-8/JSON или нарушение известной provider schema дают `model_discovery_failed`; вход и ресурсные отказы используют `invalid_args`/`resource_limit`. Ошибка включает только bounded безопасную классификацию и при наличии HTTP status, не credentials, raw auth/provider body, headers или exception text. Error не создаёт SessionEnvelope и не подставляет `auto` либо встроенный список.

Runtime MUST отменять принадлежащие запросу HTTP/stream resources и освобождать admission slot при success, failure и shutdown. Bounds и overload action принадлежат MD-3. Превышение payload bound не возвращает частичный каталог. Version-specific adapter, подтверждённый официальным SDK/API evidence и golden fixture, владеет внешней schema/auth и проекцией в `ModelCatalog`: неизвестные дополнительные поля игнорируются, malformed известные поля, duplicate model IDs и пустой каталог дают явную ошибку.

#### Scenario: Список до создания сессии
- **WHEN** caller запрашивает каталог с допустимым ключом и provider возвращает допустимый список
- **THEN** MCP возвращает нормализованные ID, имена и поддержанные effort/fast и Auto optimize_for/default_optimize_for без ACP-сессии или turn

#### Scenario: API key отсутствует
- **WHEN** auth file либо непустое строковое поле apiKey отсутствует
- **THEN** caller получает actionable model_discovery_failed с указанием получить API KEY и сохранить поле в указанном auth file, без альтернативного источника

#### Scenario: Discovery повторён после изменения каталога или ключа
- **WHEN** provider список либо apiKey изменился между последовательными вызовами
- **THEN** второй ответ использует новые данные, без persisted cache

#### Scenario: API недоступен или формат изменился
- **WHEN** HTTP запрос отклонён, зависает либо возвращает malformed известную schema
- **THEN** caller получает безопасный bounded MCP error без credentials, raw body, придуманного/частичного списка и allocation

#### Scenario: Параллельный запрос и закрытие MCP
- **WHEN** discovery slot занят либо MCP закрывается во время discovery
- **THEN** новый запрос не ставится в очередь, а shutdown отменяет собственный HTTP/stream и освобождает resources в пределах MD-3


### Requirement: Согласованный выбор модели до prompt

MD-6 SHALL быть единственным владельцем нормализации model selection для discovery и start/delegate/resume. Discovery возвращает базовые модели provider (не разворачивает variants в отдельные модели и не исключает модели по hardcoded list). Version-specific adapter сопоставляет публичный `effort` одному подтверждённому provider ID `effort|reasoning|reasoning_effort`; неоднозначный mapping даёт `model_discovery_failed`. Значения сохраняются буквально: нет преобразования xhigh/extrahigh или иных синонимов. Public catalog остаётся компактным MD-1; полные provider variants используются только внутри resolver.

При explicit fixed model или auto-smart runtime MUST получить свежий каталог через общий MD-1 transport/auth и MD-3 limits до allocation. Постоянный cache/registry и отдельный lifecycle resolver не создаются. Допустим только точный canonical base ID из каталога; неизвестный ID, alias или CLI preset даёт `invalid_args`. Исключение существующей default policy: omitted model, `auto` и `default` без effort/fast/optimize_for сохраняют существующее поведение без lookup. Эти default-policy IDs с knobs дают `invalid_args`; auto-smart требует optimize_for по MD-2. `false` считается явно переданным fast, не отсутствием значения.

Resolver MUST проверить каждое явно переданное значение по соответствующему provider definition без healing, игнорирования или подстановки альтернативы. Затем он фильтрует полные variants по совпадению ВСЕХ явно переданных mapped constraints. Нет кандидатов — `invalid_args`, без fallback. При единственном provider default variant каждый кандидат получает число совпадающих с default пар параметр/значение; выбирается максимальное число, при равенстве сам default, если он кандидат, иначе первый кандидат в порядке provider. Это разрешает менять только unspecified параметры для совместимости с явным выбором. Если default отсутствует, допустим только единственный кандидат; несколько кандидатов либо неоднозначный default дают `model_discovery_failed` как неоднозначные metadata. Полный выбранный variant передаётся provider с сохранением порядка params через version-specific adapter; частичное наложение knobs на default не заменяет этот алгоритм.

Для explicit selection после session/new или session/load runtime MUST сверить фактический canonical model и КАЖДЫЙ явно переданный knob с подтверждённым adapter selection evidence до объявления live и до первого delegate prompt. Несовпадение любого переданного provider параметра, для которого доступно actual evidence, также является ошибкой; отсутствие evidence обязательно является ошибкой только для canonical ID и explicit knobs. Missing/mismatch evidence даёт существующий allocated init failure с bounded причиной и cleanup, без turn или corrective ACP setters. Legacy presentation ID не заменяет подтверждённый parameterized selection. Этот контракт не обещает проверку всех скрытых unspecified параметров или модели, реально использованной для inference. Requested поля bootstrap/status не являются доказательством фактического выбора.

#### Scenario: Полный variant при явном fast
- **WHEN** выбран GPT base model с fast true, а совместимые variants имеют context, отличный от default
- **THEN** resolver выбирает совместимый полный variant по указанному порядку и сохраняет явный fast, не отклоняя выбор из-за default context

#### Scenario: Полный Grok и uniform effort
- **WHEN** caller задаёт поддержанные effort и fast для модели
- **THEN** resolver сохраняет точные значения через подтверждённый provider mapping и передаёт полный совместимый variant

#### Scenario: Неизвестный alias или недопустимое значение
- **WHEN** caller передаёт неканонический ID, неподдержанное значение или сочетание без variant
- **THEN** runtime возвращает invalid_args до allocation, не исправляя выбор автоматически

#### Scenario: Resume selection не подтверждён
- **WHEN** session/load не подтверждает canonical model либо один явно выбранный knob
- **THEN** runtime завершает init failure и cleanup без live-сессии и первого prompt


### Requirement: Неинтерактивная авторизация запуска

Runtime SHALL использовать существующую авторизацию при start/delegate/resume
без принудительного interactive login. Если выбранный auth file MD-1 содержит
валидный apiKey, version-specific adapter MUST передать его только дочернему
процессу и использовать временное хранилище credentials в памяти; запуск не
изменяет этот файл и не открывает браузер. Exact child environment принадлежит
adapter/golden, credentials не входят в argv, публичные ответы или диагностику.

При ENOENT либо объекте без apiKey launch сохраняет native CLI authentication,
но не инициирует browser-login. Эта ветка не обещает запрета native refresh
credentials. Malformed/unreadable файл или присутствующий невалидный apiKey
дают bounded actionable init failure до spawn. При отсутствии допустимой
авторизации provider отказ остаётся init failure, без prompt или fallback login.
Discovery по-прежнему требует ключ по MD-1. Общий reader не создаёт cache,
auth manager, refresh/login operation или восстановление удалённого файла.

#### Scenario: В файле только API key
- **WHEN** auth file содержит только валидный apiKey
- **THEN** Cursor new/load использует его без browser-login и изменения файла; временные токены остаются в памяти процесса

#### Scenario: Existing CLI login без API key
- **WHEN** apiKey отсутствует и CLI имеет native authentication
- **THEN** runtime использует её без принудительного interactive login; при auth-required возвращает bounded init failure

#### Scenario: Некорректный auth file
- **WHEN** файл нечитаем, содержит malformed JSON либо невалидное присутствующее поле apiKey
- **THEN** launch не создаёт child process, сообщает безопасную actionable причину и не выбирает другой источник молча

## MODIFIED Requirements

### Requirement: Публичный MCP tool contract

Runtime SHALL быть единственным владельцем MCP schemas и всех response envelopes. Tools:
`cursor_list_models({})`,
`cursor_start_session({cwd,mode,model?,effort?,fast?,optimize_for?,plugin_dirs?})`,
`cursor_delegate({cwd,mode,prompt,model?,effort?,fast?,optimize_for?,plugin_dirs?})`,
`cursor_resume_session({cwd,cursor_session_id,mode,model?,effort?,fast?,optimize_for?,plugin_dirs?})`,
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
| `cursor_list_models` | — | — | `ModelCatalog` из «Получение моделей Cursor через MCP» |
| `cursor_start_session` | `cwd`, `mode` | `model`, `effort`, `fast`, `optimize_for`, `plugin_dirs` | `SessionEnvelope` |
| `cursor_delegate` | `cwd`, `mode`, `prompt` | `model`, `effort`, `fast`, `optimize_for`, `plugin_dirs` | bootstrap `ActionEnvelope` or unchanged failed-allocation `SessionEnvelope` |
| `cursor_resume_session` | `cwd`, `cursor_session_id`, `mode` | `model`, `effort`, `fast`, `optimize_for`, `plugin_dirs` | `SessionEnvelope` |
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
`invalid_args|unknown_session|unknown_turn|unknown_request|resource_limit|protocol_error|scope_rejected|invalid_text_encoding|mode_timeout|model_discovery_failed`. JSON-RPC `error` with integer
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

При неуспешной инициализации Cursor runtime MUST сохранять доступную stderr-диагностику CLI в существующем `terminal_reason: BoundedText`, вместе с исходной причиной runtime. Это относится к version probe и ACP startup до live-сессии; прежняя классификация `failure_kind` и отсутствие turn сохраняются. Непустой stderr сам по себе не означает отказ успешной операции. JSON-RPC provider errors продолжают использовать описанный выше `provider_error`.

Диагностика MUST укладываться в derived-text bound MD-3, корректно обрабатывать UTF-8 между chunks и отмечать обрезку через `truncated`. После успешного init либо tombstone runtime MUST прекращать накопление startup stderr; опубликованное terminal_reason не изменяется поздними байтами. Дочитывание stderr при exit/EOF MUST быть ограничено shutdown grace MD-3; удерживаемый наследником pipe не блокирует завершение и освобождение собственных stream resources. Runtime MUST NOT добавлять в диагностику environment, credentials или JSON-RPC error.data; текст stderr считается данными provider, а не исполняемой инструкцией.

#### Scenario: Неверная модель отклонена до turn
- **WHEN** CLI завершает startup и сообщает в stderr, что выбранная модель недоступна
- **THEN** failed-allocation envelope содержит `failure_kind: init` и bounded причину отказа модели, без создания turn или автоматического повторного запуска

#### Scenario: Последний stderr приходит после exit
- **WHEN** stderr дописывается после exit/EOF либо pipe остаётся открытым
- **THEN** доступные до grace deadline байты входят в bounded diagnostic, операция завершается в ограниченное время, а поздние байты не изменяют terminal response

#### Scenario: Ошибка version probe
- **WHEN** CLI version probe завершается с ошибкой и stderr
- **THEN** failed-allocation envelope сохраняет bounded stderr вместе с причиной ошибки probe

#### Scenario: Шумный успешный startup
- **WHEN** startup пишет предупреждение в stderr, но корректно создаёт live session
- **THEN** предупреждение не превращается в failure и его startup buffer освобождается


### Requirement: Продолжение Cursor-сессии
`cursor_resume_session` schema, `cursor_session_id` representation and
`SessionEnvelope` fields are owned by IUX-1. Resume applies the same validated
`mode` and optional model-parameter override semantics as a new runtime session.

Resume MUST создать новый runtime-owned MCP `session_id`, canonicalize `cwd` и
проверить allowed roots до spawn. После общего startup по MD-7 runtime
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
