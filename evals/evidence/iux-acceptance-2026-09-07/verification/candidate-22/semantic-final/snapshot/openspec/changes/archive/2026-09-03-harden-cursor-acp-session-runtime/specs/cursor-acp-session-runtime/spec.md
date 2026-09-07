## Purpose

Определяет надёжный и ограниченный контракт исполнения Cursor ACP-сессий,
который позволяет Codex наблюдать, ограничивать и завершать субагента.

## ADDED Requirements

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
`cursor_start_session({cwd,mode})`, `cursor_send_prompt({session_id,prompt})`,
`cursor_session_status({session_id})`, `cursor_wait({session_id,turn_id,after_event_id?,timeout_ms?})`,
`cursor_answer_question({session_id,turn_id,request_id,outcome,answers?})`,
`cursor_answer_plan({session_id,turn_id,request_id,decision})`,
`cursor_answer_permission({session_id,turn_id,request_id,decision})`,
`cursor_cancel({session_id,turn_id})`, `cursor_close_session({session_id})`.
Все inputs MUST быть JSON objects без additional properties. String ID/prompt/
answer fields nonempty UTF-8 strings в limits данного change; `cwd` — canonical
absolute directory, `mode` exactly `ask|plan|agent`; `decision` exactly
`accept|reject` для plan и `allow-once|reject-once` для permission. IDs opaque;
`after_event_id`/`timeout_ms` имеют ranges из «Нормативные limits runtime».

| Tool | Required input | Optional input | Success output |
|---|---|---|---|
| `cursor_start_session` | `cwd`, `mode` | — | `SessionEnvelope` |
| `cursor_send_prompt` | `session_id`, `prompt` | — | `TurnEnvelope` |
| `cursor_session_status` | `session_id` | — | `SessionEnvelope` |
| `cursor_wait` | `session_id`, `turn_id` | `after_event_id`, `timeout_ms` | `WaitEnvelope` |
| `cursor_answer_question` | `session_id`, `turn_id`, `request_id`, `outcome` | `answers` | `TurnEnvelope` |
| plan/permission answer | `session_id`, `turn_id`, `request_id`, `decision` | — | `TurnEnvelope` |
| `cursor_cancel` | `session_id`, `turn_id` | — | terminal `TurnEnvelope` |
| `cursor_close_session` | `session_id` | — | `SessionEnvelope` |

`cursor_send_prompt` MUST validate live session, nonempty prompt and absent active
turn before allocating `turn_id`; rejection creates no turn/event. `TurnSnapshot`
is `{turn_id,turn_status,result:null|BoundedText,terminal_reason:null|BoundedText,pending:PendingRequest[]}`.
`BoundedText` is `{text:string,truncated:boolean}`. Public input larger than 64 000
UTF-8 bytes is rejected before allocation; Cursor/OS-derived result, reason and
context text are truncated to 8 000 bytes only through `BoundedText`.
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
`failure_kind` is non-null only for a failed initialization; failure after a
started turn belongs to its `TurnEnvelope`, while the session field stays `null`.
`terminal_reason` is non-null only after terminalization. Public trace is outside
v1 scope; bounded pending context and terminal/result fields are the diagnostics.
`TurnEnvelope` extends `SessionEnvelope` with top-level `turn_id,turn_status`.
`WaitEnvelope` extends `TurnEnvelope` only with `events:RuntimeEvent[],earliest_event_id,
events_lost,wait_timeout`; it inherits `last_event_id`. Empty log has
`last_event_id=0`, `earliest_event_id=null`, `events=[]`.
Every successful tool result is `CallToolResult{isError:false,content:[{type:"text",
text:JSON.stringify(the declared envelope)}]}`; it has no `structuredContent`.
Every domain/tool error is a successful JSON-RPC result `CallToolResult` with
`isError:true` and one text content containing JSON `{error_code,message}`;
`structuredContent` and output schemas are outside v1 scope. `error_code` is exactly one of
`invalid_args|unknown_session|unknown_turn|unknown_request|resource_limit|protocol_error|scope_rejected|invalid_text_encoding`. JSON-RPC `error` with integer
code is reserved for malformed JSON-RPC or unknown method.
`RuntimeEvent.kind` is exactly `lifecycle|pending|result`.
`RuntimeEvent` is `{event_id,kind,turn_id:null|string,payload}` where lifecycle
payload is `{scope:"session"|"turn",from,to}`. Session states are exactly
`starting|live|closing|tombstone`; turn states are exactly
`running|waiting_for_input|completed|failed|timed_out|cancelled`. `from` and `to`
use the union for their scope; only turn creation uses `from:null,to:"running"`.
Other payloads are exactly pending
`{action:"added"|"removed",request_id,request_kind}`, result `{turn_status}`.
State changes emit their stated event after storing the snapshot; eviction emits none.

#### Scenario: Новый prompt во время active turn
- **WHEN** `cursor_send_prompt` получает session с active turn
- **THEN** runtime возвращает MCP error без allocation другого turn или event

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
Сервер SHALL предоставлять `cursor_wait(session_id, turn_id, after_event_id,
timeout_ms)` согласно единой машине состояний для конкретного хода с ограниченным таймаутом. Результат MUST
содержать ordered events, `last_event_id`, `earliest_event_id`, `events_lost`,
snapshot хода и новые pending requests. Одинаковый cursor допускает независимые
повторные wait; превышение bounded waiter cap отклоняется.
`event_id` — generated safe integer 1..9 007 199 254 740 991, первый 1;
optional `after_event_id` — safe integer 0..9 007 199 254 740 991 (omission=0).
Events находятся в одном bounded session-wide log: turn event содержит `turn_id`,
lifecycle event может не содержать его. Фильтр возвращает target events и affecting lifecycle;
ID могут иметь пропуски, `last_event_id` — high-water mark, `earliest_event_id`
— retained watermark. Future cursor — MCP error; `events_lost=true` только если
после cursor были удалены события.

#### Scenario: Ход Cursor завершился
- **WHEN** клиент ожидает активную сессию и Cursor заканчивает ход
- **THEN** ожидание возвращает `turn_status=completed`, итог хода, идентификатор события и отдельный `session_state=live` без polling полного журнала

#### Scenario: Повторное ожидание terminal turn
- **WHEN** клиент повторяет wait T1 во время active T2 до terminalization T2 или eviction
- **THEN** сервер немедленно возвращает тот же сохранённый snapshot и события после cursor без изменения состояния, даже если новых target events нет, с `wait_timeout=false`

#### Scenario: Таймаут ожидания
- **WHEN** за заданный интервал состояние сессии не изменилось
- **THEN** ожидание возвращает снимок текущего состояния с `wait_timeout=true` и не изменяет ход Cursor

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
| init timeout | fixed 15 000 ms | terminal init timeout |
| turn timeout | fixed 600 000 ms | terminal turn timeout |
| idle TTL | fixed 900 000 ms | shared shutdown |
| wait timeout | default 30 000 ms, 1 000..60 000 | MCP error |
| live slots / pending / waiters | 8 / 8 per turn / 8 per session | pre-allocation MCP error / resource_limit |
| tombstones | 64 | evict expired, then lowest `(tombstoned_at, session_id)` |
| events | 256 | FIFO: lowest `event_id`; update earliest watermark/events_lost |
| shutdown grace / tombstone retention | 5 000 / 300 000 ms | shared shutdown / unknown after retention |
| public input / derived text / FS file | 64 000 / 8 000 / 1 048 576 UTF-8 bytes | reject input / BoundedText truncation / resource_limit |
| ACP NDJSON frame / normalized pending context | 1 048 576 / 64 000 UTF-8 bytes | protocol_error / resource_limit before publication |

These are internal constants, not operator configuration. Idle TTL starts after init success and terminal completion, stops while active
turn exists, and status/wait do not reset it. Tombstone retention starts once at
`tombstoned_at` and close/read never reset it. Event IDs never wrap; exhaustion is
unreachable under the bounded local-session contract and has no public failure kind.

#### Scenario: Deterministic eviction
- **WHEN** a new tombstone exceeds cap
- **THEN** runtime evicts expired records first, otherwise lowest `(tombstoned_at, session_id)`

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

До handshake runtime MUST применить normalized capabilities: `ask|plan` —
read=true/write=false/terminal=false; `agent` — read=true/write=true/terminal=false.
Handlers use admitted adapter callbacks, canonical containment, regular-file and
strict UTF-8 checks, and the shared byte cap. Write is full create-or-replace UTF-8:
it requires matching session/capability/mode, an absolute path, existing regular
non-symlink target inside `cwd` or an existing canonical parent inside `cwd` for a
new target; directory, symlink, outside-cwd and oversized values reject. It returns
the admitted adapter success or error outcome; no atomic/no-partial promise is made.
Cursor-specific wire normalization is adapter-owned and covered by fixtures.
Эти callbacks не являются OS sandbox;
Cursor Auto-Review может самостоятельно не эскалировать action, а runtime
передаёт caller все фактически полученные ACP requests.

#### Scenario: Plan читает fixture
- **WHEN** Cursor в `plan` запрашивает text file внутри session `cwd`
- **THEN** runtime возвращает bounded content через ACP callback, но отклоняет write и terminal callback

#### Scenario: Agent пишет в workspace
- **WHEN** Cursor в `agent` запрашивает write внутри session `cwd`
- **THEN** runtime выполняет bounded write callback; write в `ask|plan` либо путь вне/symlink за `cwd` отклоняется

#### Scenario: Cap и текстовый range
- **WHEN** read-файл больше `FS file` limit, даже если adapter запрашивает малый range
- **THEN** runtime возвращает `resource_limit` до decode; malformed UTF-8 меньшего файла возвращает `invalid_text_encoding`, а `line` за EOF — пустой content

#### Scenario: Auto-review с sandbox
- **WHEN** delegate запускает v1 session through an admitted Cursor adapter
- **THEN** runtime возвращает оба immutable metadata и пересылает все фактически полученные ACP requests

### Requirement: Ограниченный контекст интерактивных запросов
Статус сессии SHALL предоставлять структурированное описание ожидающих
вопросов, планов и разрешений, достаточное для решения Codex.

#### Scenario: Запрос разрешения
- **WHEN** Cursor запрашивает выполнение действия
- **THEN** статус содержит request ID, тип действия, bounded описание, immutable session `cwd` и normalized locations, если Cursor их передал
