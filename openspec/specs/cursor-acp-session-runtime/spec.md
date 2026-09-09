# cursor-acp-session-runtime Specification

## Purpose
Определяет надёжный и ограниченный контракт исполнения Cursor ACP-сессий,
который позволяет Codex наблюдать, ограничивать и завершать субагента.

## Requirements

### Requirement: Единая машина состояний runtime
Этот requirement — единственный нормативный источник переходов `session_state`,
`turn_status` и terminalization; `cursor_wait` владеет cursor/wake semantics,
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

### Requirement: Response envelopes и фаза allocation
Этот requirement владеет только границей allocation. До allocation
`session_id` (args, cwd/scope и capacity validation) MUST вернуть MCP error
без session/envelope. После session allocation schemas принадлежат «Публичный MCP
tool contract»; после turn allocation тот же owner добавляет turn fields. A failed
`spawn()` after allocation is a runtime failure, not a static precheck.
`cursor_start_session` awaits ACP initialization up to the fixed init limit: it
returns only `live` on success or a tombstone envelope on allocated init/spawn
failure; it never exposes `starting` to a tool caller. The live slot is released
only after the terminal tombstone snapshot is stored.

#### Scenario: Отказ до allocation
- **WHEN** девятая start, malformed args или cwd/scope/capacity precheck rejection происходят до session allocation
- **THEN** runtime возвращает MCP error без spawn, session ID или facade envelope

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

### Requirement: Turn operations и permission options
`prompt`, `answer` и `cursor_cancel(session_id, turn_id)` MUST адресоваться IDs
и применять state-machine requirement. Pending permission хранит bounded adapter
options с opaque ID и user-facing label. Runtime normalizes only the one-time
allow/reject choices as `allow-once` and `reject-once`; missing or ambiguous
choice is rejected without creating pending. The adapter maps the semantic choice
back to its opaque ID; exact upstream option schema is fixture-local.

#### Scenario: Ответ на permission
- **WHEN** Codex выбирает доступный `allow-once` для pending request
- **THEN** runtime отправляет сохранённый ACP option ID, а не semantic label

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

### Requirement: Изолированное состояние ходов и событий
Сервер SHALL реализовать turn isolation и события согласно единой машине
состояний. Все answer operations MUST проверять `session_id`, `turn_id`,
`request_id`; они ссылаются на state-machine owner для terminalization и очистки
pending. Клиент MUST
иметь возможность получить события после переданного курсора
и MUST быть уведомлён, если ранние события были удалены по лимиту хранения.

#### Scenario: Последовательные ходы
- **WHEN** в одной сессии выполнены два последовательных запроса
- **THEN** итог и текст второго хода не содержат фрагменты первого хода

#### Scenario: Устаревший курсор
- **WHEN** клиент запрашивает события после курсора, который уже вышел за пределы retention
- **THEN** сервер сообщает о потере событий и возвращает самый ранний доступный курсор

#### Scenario: Идемпотентная отмена retained turn
- **WHEN** T1 completed, T2 running, а клиент вызывает `cursor_cancel(session_id, T1)`
- **THEN** сервер возвращает неизменённый final snapshot T1 и сохраняет T2 running; cancel active turn ждёт tombstone и возвращает cancelled snapshot

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
- **THEN** status и wait возвращают tombstone с итогом, terminal reason и последним event ID

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

### Requirement: Проверка scope рабочего каталога
Сервер SHALL проверять все параметры независимо от MCP-схемы. Сессия MUST
создаваться только в существующем каноническом каталоге; optional allowed roots
служат защитой от ошибки scope, а не sandbox-изоляцией процесса.

#### Scenario: Каталог вне разрешённого root
- **WHEN** клиент передаёт `cwd` вне разрешённых roots
- **THEN** сервер отклоняет создание сессии до запуска Cursor

#### Scenario: Семантика roots
- **WHEN** `CURSOR_SUBAGENT_ALLOWED_ROOTS` отсутствует, пуст или malformed
- **THEN** отсутствие выключает scope guard, пустой JSON-массив отклоняет все `cwd`, а malformed конфигурация останавливает сервер до handshake

`CURSOR_SUBAGENT_ALLOWED_ROOTS`, when present, MUST be a JSON array of nonempty
absolute strings whose `realpath` is an existing directory. Runtime canonicalizes,
deduplicates equal paths and tests membership by path components; invalid member
fails before handshake.

#### Scenario: Недопустимый параметр инструмента
- **WHEN** клиент передаёт параметр неверного типа или значение вне контракта
- **THEN** сервер возвращает MCP-ошибку и не изменяет состояние сессии

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

### Requirement: Ограниченный контекст интерактивных запросов
Статус сессии SHALL предоставлять структурированное описание ожидающих
вопросов, планов и разрешений, достаточное для решения Codex.

#### Scenario: Запрос разрешения
- **WHEN** Cursor запрашивает выполнение действия
- **THEN** статус содержит request ID, тип действия, bounded описание, immutable session `cwd` и normalized locations, если Cursor их передал

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
