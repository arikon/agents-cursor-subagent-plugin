## Context

См. мотивацию в `proposal.md`. Runtime уже владеет addressable turns, bounded
envelopes, pending requests и idempotent close; найденные UX-сбои возникли у
caller при переносе cursor и IDs между interactive calls. Приватный
`~/.cursor/acp-sessions` содержит полезную forensic-информацию, но не является
подтверждённым публичным контрактом и не должен стать зависимостью плагина.

## v1 Contract Baseline

**Goal.** Сделать продолжение wait и ранее созданной Cursor-сессии, recovery
stale pending request и конечного набора полностью аудируемых pre-effect
corrections existing-session calls, проверку terminal completion, экономную доставку terminal
result, явный выбор модели и recovery follow-up после active turn понятными для caller,
сохраняя coarse user-bounded delegation и current-mode write-capability gate; устранить преждевременный `timed_out` для
длительной авторизованной реализации, а также применить тот же
прямолинейный lifecycle к research/Q&A, planning, debugging и coordinator
сценариям, а не только review/implementation.
Текущее уточнение IUX-3/IUX-19 завершает проверяемую приёмку skill для
terra/high и terra/medium, устраняя смешение пользовательского отчёта и evidence.
Одобренный пользователем IUX-20 устраняет потерю хвоста длинного review: preview
остаётся bounded, весь принятый result доступен через адресуемое чтение.
Одобренная после terra/high diagnostic автоматизация связывает coverage с
проверенными product sources и делает acceptance closeout воспроизводимым через
существующих owners IUX-18/IUX-19.

**Non-goals.** Не вводить persistent registry,
Cursor archive reader, auto-approval, auto-retry/restart, prompt policy engine,
model registry, global Cursor-config writes, session listing или новые external
dependencies.
Final-only external handoff, новый versioned final-answer protocol и
универсальный natural-language judge также вне scope.

**Public-invariant index.** `IUX-1` → «Публичный MCP tool contract»; `IUX-2` → «Адресуемое ожидание состояния сессии», «Нормативные limits runtime»; `IUX-3` → «Skill workflow делегирования», «Workspace discipline делегирования»; `IUX-4` → «Явный выбор модели запуска»; `IUX-5` → «Продолжение Cursor-сессии»; `IUX-6` → «Высокоуровневое создание делегирования»; `IUX-7` → «Per-session параметры модели»; `IUX-8` → excluded as `external_adapter_drift`: installed Cursor не подтверждает отдельный public `auto_optimize_for`; `IUX-9` → «Skill workflow делегирования»; `IUX-10` → retired as overengineering: no automatic artifact cleanup; `IUX-11` → «Нормативные limits runtime», «Seamless per-session launch»; `IUX-12` → «Sparse wait and bounded progress»; `IUX-13` → «Sparse wait and bounded progress»; `IUX-14` → «Provider errors are bounded and classified»; `IUX-15` → «Seamless per-session launch»; `IUX-16` → «Режимы Cursor и ACP callbacks», «Role-neutral mode and collaboration surface»; `IUX-17` → «Role-neutral mode and collaboration surface»; `IUX-18` → `node-test-supervision` «Lane selection и coverage scope» и `cursor-plugin-distribution` «Проверяемая чистая установка», «Managed marketplace lifecycle»; `IUX-19` → `cursor-subagent-skill-evals` «Разделённые eval lanes и evidence загрузки skill», «Сценарный контракт поведения и authority-aware interaction», «Eval transcript plumbing и process verdict», «Outcome model и диагностические доказательства», «Scenario program driver и pure scenario oracle», «Immutable evidence manifest», «Cost-aware execution policy» с project-wide policy из `AGENTS.md`; `IUX-20` → runtime «Публичный MCP tool contract», «Нормативные limits runtime», «Полное чтение terminal result», facade «Skill workflow делегирования», eval «Сценарный контракт поведения и authority-aware interaction», package «Проверяемая чистая установка».

**Owner map.** `cursor-acp-session-runtime` owns additive interactive diagnostics; `cursor-task-delegation` owns caller workflow composition; `node-test-supervision` owns test process lifecycle; `cursor-subagent-skill-evals` owns behavior proof; `cursor-plugin-distribution` owns installation/discovery and the release canary semantics. Concretely, `node-test-supervision` owns every Node test process lifecycle, dedicated eval lane, coverage source binding и zero-counter audit, while `cursor-subagent-skill-evals` owns corpus admission, behavior oracle, evidence schema и acceptance closeout. `cursor-acp-session-runtime` владеет envelope, cursor,
recoverable error, terminal receipt, model/resume schema, retained full result
и его paging, а также adapter;
`cursor-task-delegation` владеет caller-facing evidence-mode, пользовательским
report guidance и использованием tool-held state для continuation, а также
единственным facade forwarding optional launch fields; `cursor-subagent-skill-evals`
владеет corpus, exact-delivery assertions, capture proof, recovery-aware audit
raw call pair и итоговым classifier
для mechanics/evidence/observable delivery, не дублируя skill workflow. Existing owner boundaries, public
session/turn state union и permission-decision policy не меняются. Runtime
получает additive internal mode-transition guard, а package owner расширяет
свой payload allowlist recording proxy; эти изменения остаются внутри
существующих owners и не создают параллельной state/authority/package policy.

**Implementation-ready exit.** Каждый invariant имеет один observable test
owner; strict и semantic gates проходят; runtime, facade и Codex behavior evals
подтверждают additive schema, точный argv model override без записи глобальной
Cursor-конфигурации, explicit resume только по previously returned opaque ID,
180-second wait cap, hour-long turn cap, admitted mode/collaboration-extension
adapter fixtures, однократную доставку
terminal preview, полное чтение длинного результата до отчёта и явный overflow
failure, отсутствие automatic permission и сохранение idempotent close,
а также focused unit invocation через тот же process/artifact supervisor без
ослабления полного coverage manifest. Keyword/substring assertions над текстом
skill не считаются behavioral proof.
Для текущего уточнения exit означает готовность документов к apply: owner
specs согласованы с tasks раздела 5, независимый critic не находит
`baseline_violation`, architect подтверждает классификации и минимальность.
Успешная hosted-приёмка является выходом реализации по tasks 5.8–5.11, а не
доказательством готовности planning artifacts.

**Future-change candidates.** Durable cross-process audit export и интеграция
с документированным Cursor session-storage API требуют отдельного change после
подтверждения публичного external contract.

**Review classification.** Замороженный baseline не расширяется находками;
каждая из них имеет ровно одну классификацию и минимальный repair owner:

Пользователь 2026-09-06 явно одобрил обновление текущего change по рекомендациям
ремонта oracle/evidence. Это уточнение существующих IUX-3/IUX-19; новый invariant
или protocol не создаётся. Ниже сохраняется история review, но старые
реализационные формы report-binding заменены согласно этому решению.
Позже пользователь явно одобрил `new_scope` IUX-20: устранение runtime truncation
полного review. Его численные
лимиты, схема и retention принадлежат runtime, skill только дочитывает результат.
Пользователь 2026-09-07 также явно одобрил сокращение mandatory IUX-19
acceptance: свободные outcome/safety semantics, язык, шаблон и фразы не являются
gate; exact capture сохраняется, а semantic components записываются как
`not_checked`. Это уточнение границы существующего eval owner, без нового
runtime/facade protocol.
Пользователь 2026-09-07 затем явно одобрил recovery-aware расширение IUX-19:
eval может принять только полностью доказанный конечный класс pre-effect
correction existing-session call, сохраняя видимую runtime error и raw call
records. Это не меняет runtime API, facade authority или общий запрет loose
matching.
Пользователь 2026-09-07 также явно одобрил `new_scope`, удаляющий
`cursor_matched` и обязательную equality с последним returned event cursor.
`resume_after_event_id` остаётся рекомендуемой sparse-подсказкой;
`last_event_id` является high-water mark, а не acknowledgement чтения
предшествующих событий. Успешный wait допускает omitted=0, повторный или более ранний runtime-valid
`after_event_id`. Failed-call recovery по-прежнему требует exact causal public
state и не получает loose matching.

| Finding | Classification | Current repair |
| --- | --- | --- |
| Mandatory isolated worktree for every write-capable delegation | `baseline_violation` | IUX-3 делает worktree рекомендацией для concurrent/risky writes; task 4.2 |
| Substring operator-skill tests вместо поведения Codex | `implementation_concern` | Scenario eval corpus и hosted behavior oracle; tasks 4.5/4.8 |
| `cursor_send_prompt` diagnostics-only одновременно с normal next turn и unconditional close | `baseline_violation` | Explicit reusable live-session lifecycle; task 4.3 |
| File/snapshot review и timeout guidance расходятся | `baseline_violation` | Mutually exclusive templates и bounded timeout workflow; task 4.4 |
| Facade не передаёт `plugin_dirs` | `implementation_concern` | Exact optional forwarding и integration tests |
| Trace теряет `model`/`effort`/`fast` evidence | `implementation_concern` | Turn-local binding checks в behavior evals |
| `cursor_set_mode` может ждать provider без bound | `implementation_concern` | 15-second provider bound и `mode_timeout` |
| Public error enum не содержит `mode_timeout` | `baseline_violation` | Additive runtime/MCP error contract |
| Installed ACP provenance не доказана | `external_adapter_drift` | Pinned installed-interface golden fixture with source hashes |
| Scenario count/ID allowlists повторяются вне corpus | `overengineering` | Corpus остаётся единственным ID/lane owner |
| Unbounded semantic replacement bypass и forwarded owner map | `overengineering` | Source-digest-bound current-change replacement only |
| Hosted eval fallback подменяет observed skill behavior | `implementation_concern` | Diagnostic fallback removed; fail-closed hosted lane |
| README смешивает portable runtime и pinned development Node | `implementation_concern` | Раздельные runtime/development requirements |
| Sensitivity без fresh baseline и exact mismatch | `implementation_concern` | Linked baseline plus corpus-owned mismatch |
| Fault injection выбирается hardcoded scenario IDs | `overengineering` | Corpus-owned `harness_faults` metadata |
| Programmed scenario без facade owner | `baseline_violation` | Every programmed row references its facade workflow owner |
| Archive replacement сравнивается с mutable current main | `overengineering` | Immutable source/replacement digests validate active and archived artifacts separately |
| Sensitivity baseline и mutation читают разные source/corpus payloads | `implementation_concern` | Exact source, corpus, scenario and loaded-skill digest pairing with retained baseline evidence |
| Hosted archive failure swallowed during cleanup | `implementation_concern` | Cleanup failure remains an integration failure with explicit provenance |
| `subagentType` accepted arbitrary strings beyond pinned interface | `external_adapter_drift` | Versioned golden enumerates admitted literals and custom-object fallback |
| Package canary hardcodes corpus scenario ID | `overengineering` | Package selects the sole corpus-owned `package-canary-reference` by kind |
| Critic delta-only after wrapper loss assumes restored history | `baseline_violation` | Same-session delta-only; resumed review re-establishes bounded baseline or is unverifiable |
| Skill repeats lifecycle policy in separate rules | `overengineering` | One state-based reusable-session rule owns continue/resume/close guidance |
| Collaboration owner promises exact settlement although a closed transport cannot confirm delivery | `baseline_violation` | Require one synchronous response attempt while transport is writable; a pre-write closed/synchronous rejection is locally abandoned, while later async EPIPE keeps the existing fail-closed transport path |
| Sensitivity evidence omits the exact observed mismatch | `implementation_concern` | Published outer oracle includes the exact recomputed mismatch |
| Write-capable behavior row does not observe worktree recommendation | `implementation_concern` | Ordinary canonical-checkout eval requires natural recommendation, coordination-risk and runtime-boundary evidence without seeding expected wording |
| Package release tests duplicate runtime lifecycle semantics | `overengineering` | Keep one install/discovery/facade canary; runtime and eval owners test lifecycle behavior |
| Main eval requirements retain fixed six/seven-row counts and forbid the new supervisor lane | `baseline_violation` | Complete replacements derive counts from corpus and admit the supervisor-owned explicit eval lane |
| `plugin_dirs` rejection guidance has no Codex behavior recovery row | `implementation_concern` | Ordinary missing-directory scenario observes exact rejection and absence of copy/root/config fallbacks |
| Artifact preservation row is self-fulfilled by an explicit no-delete prompt | `implementation_concern` | Ordinary create-only authority leaves cleanup uninstructed and observes preserved file/path |
| Eval spec has conflicting placeholder/predicate allowlists after start-rejection addition | `baseline_violation` | One canonical grammar includes the missing-directory placeholder and predicate; unknown placeholders remain rejected |
| Per-row `forbidden_observations` and synthetic raw-payload injection duplicate existing oracle owners | `overengineering` | Global oracle owns runtime-invariant mismatches; recording-proxy behavior test exclusively owns payload-confidentiality proof |
| Delegate init tombstone shape, envelope prohibition, operator recovery, eval grammar and proxy evidence are inconsistent | `baseline_violation` | Admit unchanged failed-allocation `SessionEnvelope`; scope sparse-field prohibitions to live `ActionEnvelope`; report normalized failed state and error code without wait, retry, resume or fallback; keep exact diagnostics in transcript evidence; synchronize grammar; retain only bounded public provider error without raw data; prove one hosted scenario |
| Terminal eval grammar describes independent status/result unions that admission rejects | `baseline_violation` | Specify the intentional closed variants `completed + string`, `failed + null` and `timed_out + null` enforced by loader and behavioral corpus |
| Eval observer fabricates prior `turn_id` on session-level mode/close operations | `implementation_concern` | Require actual call provenance: session-level observations use observed `session_id` and only an optional same-operation `turn_id`; turn-level observations still require both IDs |
| Runtime-only model/effort grammar is absent from discoverable MCP contract | `baseline_violation` | Keep the admitted base-model and effort-token boundary, expose exact JSON Schema patterns, and document it in owner spec, skill and README |
| `provider_error` report binding accepts only one field of a structured error | `implementation_concern` | Atomic equality остаётся в transcript evidence; final-copy binding снят уточнением IUX-19 |
| UTF-8 byte truncation can retain a lone surrogate at a multibyte boundary | `implementation_concern` | Normalize internal strings, truncate by Unicode code point, and regress exact boundary cases for terminal result, progress, provider error, eval result and bootstrap diagnostics |
| Blanket artifact-preservation rule overrides already granted delete authority | `baseline_violation` | Treat artifact creation as no delete grant, but honor existing exact or bounded explicit deletion authority without redundant confirmation |
| Returned launch echo is described as provider-confirmed effective model | `baseline_violation` | Report only requested/forwarded launch parameters; provider model resolution is outside the admitted surface |
| Live-turn provider rejection has no operator recovery or hosted behavior row | `implementation_concern` | Report failure and required new decision; exact receipt stays in evidence, prove no automatic retry/resume/redelegation |
| Artifact report promises discovery of every provider-internal path | `baseline_violation` | Preserve only Cursor-created temporary paths returned or observed through the bounded caller surface |
| Artifact eval forbids truthful negative wording such as not deleted | `implementation_concern` | Let the file predicate prove preservation; avoid style-sensitive forbidden fragments |
| Hosted cleanup resolves immediately after SIGKILL without observing child close | `implementation_concern` | Wait for the process close event under a separate final bound and fail cleanup provenance when closure is unconfirmed |
| Terminal report checks accept an unassociated receipt word or digest | `implementation_concern` | Exact receipt относится к evidence owner; пользовательский outcome проверяется отдельно по IUX-19 |
| Prompt-failure report can fabricate a terminal reason | `implementation_concern` | Evidence сохраняет bounded reason; report не выдумывает причину и не копирует полный объект |
| Failed resume lacks an explicit operator terminal branch | `baseline_violation` | Retain tool-held identities, report failure and required new decision; no wait, repeated resume or replacement |
| Mode-transition timeout has no operator recovery or hosted behavior row | `implementation_concern` | Report normalized failure, allocate no prompt, and require a new user decision before any retry/resume/replacement |
| File-review prompt omits the internal-memory half of its own boundary | `baseline_violation` | Use one exact read-only boundary phrase covering private/internal memory and transcript retrieval, with positive and opposite eval checks |
| Active-turn follow-up is sent after any terminal status, including tombstone | `baseline_violation` | Send only after completed plus live; failed, timed-out, cancelled or tombstoned outcomes require a new post-failure user decision |
| Active-follow-up eval relies on a wall-clock delay, so hosted model latency can erase the active-state precondition | `implementation_concern` | Hold the first fake-ACP terminal behind a harness gate and release it only after the separate Codex follow-up turn has observably started |
| Cost-aware eval policy freezes exact test/module paths and a literal timeout without adding observable behavior | `overengineering` | Keep one table-driven pass, a finite runaway bound and a side-effect-free scenario-contract surface normative; retain current paths/value only as task-level implementation details |
| Structured or scalar report fields can be assembled from unrelated prose or sibling objects | `implementation_concern` | Exact atomic bindings проверяются по transcript; обязательная JSON-форма final удалена уточнением IUX-3/IUX-19 |
| Ambient stale-answer fault variable can mutate an ordinary installed MCP request | `implementation_concern` | Require the complete eval-only evidence, scenario and program-path handshake before proxy fault activation |
| Credential-free runner/provider cleanup errors lose cleanup precedence or wait unbounded after SIGKILL | `implementation_concern` | Accumulate cleanup failure separately, publish failed cleanup provenance and bound final close confirmation |
| File effects observed after a later terminal wait inherit that wait's later Codex turn authority | `implementation_concern` | Snapshot safe-evidence position before every follow-up turn and bind each effect to its causal Codex turn |
| Task label `debugging` selects write-capable agent mode without write authority | `baseline_violation` | Use ask for read-only diagnosis/debugging and agent only when current user authority covers write-capable work |
| Installed recording proxy is absent from the package-owner payload allowlist | `implementation_concern` | Add the already required eval proxy to the package owner allowlist and hash domain |
| Installed proxy can weaken runtime frame, UTF-8 and output-flush guarantees | `implementation_concern` | Preserve normal frames byte-for-byte, bound both directions, use fatal decoding only for observation and await stdout flush |
| Every mode-change error is treated as wrapper loss even when runtime kept a live or unexpected wrapper | `baseline_violation` | Branch on exact public error plus one-shot status: preserve live idle state, report an unexpected active state without an unproved provider operation, and reserve new-decision recovery for provider failure/tombstone |
| `per-action authority` wording overstates the coarse cwd/mode write gate | `baseline_violation` | Describe user-bounded delegation and current-mode write capability explicitly; do not claim an exact policy engine or OS sandbox |
| Report binding rejects caller-held session/model state in later Codex turns, making a valid multi-turn scenario impossible | `implementation_concern` | Resolve only session-scoped launch bindings from the latest observed allocate/resume segment; keep terminal/error evidence atomic to the exact current turn and reject older segments |
| README presents marketplace snapshot refresh as an installed-plugin update | `implementation_concern` | Document the verified upgrade, remove and add sequence; package tests prove the adapter-visible cached version and payload digests change |
| Integration child asserts the behavior verdict before serializing complete proof | `implementation_concern` | Build the complete child result before the verdict assertion so mismatch exits remain classifiable and publishable by the outer eval runner |
| Current-version golden обнаружил vendor-specific privileged control, который ошибочно был вынесен в публичный контракт | `overengineering` | Удалить публичный special case; закрытая launch schema единообразно отклоняет все unlisted controls, а точное vendor evidence остаётся только в versioned golden |
| Current-change hosted eval policy was promoted into a mandatory project-wide future-change rule | `overengineering` | Keep AGENTS owner-neutral: choose credential-free package E2E and/or scenario evals per surface, then inspect the installed skill contract before release |
| Fault metadata prose under-specifies terminal timeout status and active-followup reverse pairing | `baseline_violation` | Specify `terminal-status:timed_out` and exact bidirectional active-followup fault/trace pairing in the eval owner |
| Sensitivity wrapper relabels an integration-failed baseline as a scenario mismatch | `implementation_concern` | Preserve the baseline's exact failure stage, code, message, cleanup and publication evidence; reserve `sensitivity_baseline_failed` for behavior mismatch |
| Authority oracle skips checks when Codex-turn provenance is absent | `implementation_concern` | Require a positive safe-integer Codex turn index for every permission answer and file effect; missing or invalid provenance is an authority mismatch |
| Placeholder grammar запрещает уже используемые prompt-check fragments | `baseline_violation` | Разрешить known placeholders только в initial/follow-up inputs и prompt-check fragment lists; materialize все разрешённые fields и reject unresolved values |
| Production corpus ожидает default wait timeout без wall-clock accelerator fault | `implementation_concern` | Pair every omitted 30-second wait trace with the corpus-owned accelerator and admit the production JSON directly in regression tests |
| Provider `session/set_mode` rejection не имеет behavior-eval recovery row | `implementation_concern` | Add provider-owned reject-mode scenario with exact bounded `provider_error`, tombstone and no retry/prompt/resume/replacement before a new decision |
| Resume guidance восстанавливает semantic context только для critic role | `baseline_violation` | Require minimal bounded context for every history-dependent role-neutral turn after resume; retain baseline-plus-delta as the critic specialization |
| Fake ACP принимает любой write response как successful effect | `implementation_concern` | Admit only the exact empty write result and exact read-content result; malformed response records callback failure and no effect |
| Runtime не применяет FS byte cap на write callback | `implementation_concern` | Add the direct fsBytes guard and prove the current tighter framed transport rejects an oversized callback without file mutation |
| JSON-RPC response одновременно с `result` и `error` классифицируется provider error | `implementation_concern` | Require exactly one response payload field; dual/empty payload is malformed transport evidence without `provider_error` |
| IUX-8 исключён из implementation, но пропущен frozen invariant index | `baseline_violation` | Index IUX-8 explicitly as `external_adapter_drift` without adding unconfirmed `auto_optimize_for` to v1 |
| Model prompts предписывают close/retry/replacement algorithm и self-fulfil recovery eval | `baseline_violation` | Keep model inputs as ordinary user goals, move lifecycle expectations to trace/oracle and reject opaque runtime/lifecycle imperatives at admission |
| Operator lifecycle rule не называет public close operation | `baseline_violation` | Name `cursor_close_session({session_id})` once in the state-based close rule and keep close/resume branches unchanged |
| Main mode-specific capability requirement conflicts with fixed process capabilities needed by `cursor_set_mode` | `baseline_violation` | Replace the full owner requirement with fixed initialize capabilities plus current-mode write gate; Role-neutral requirement references that owner |
| Design claims all runtime/authority/package mechanics are unchanged | `baseline_violation` | Preserve only owner boundaries, public state union and permission policy while explicitly admitting the internal mode-transition guard and package allowlist change |
| Per-response evidence publication can reject before child close as an unhandled promise | `implementation_concern` | Attach an immediate rejection latch/failProxy handler, avoid retrying failed publication and prove controlled failure plus observed child close |
| File-review template expands exact read authority to the whole checkout | `baseline_violation` | Bound read/search to user-authorized paths/class, use checkout-wide scope only when granted and carry exact read plus no-expansion clauses |
| Corpus admission enforces same-turn authority prompt only for write effects | `implementation_concern` | Apply the prompt-scope/polarity guard to read effects and add negative mutations for missing read grant and opposite checkout-wide permission |
| Report binding accepts stale prior-turn IDs and diagnostics from the same runtime segment | `implementation_concern` | Resolve only five retained launch bindings from the current segment; all turn IDs, cursors, pending and failure diagnostics come from the exact Codex-turn call range |
| One-to-two owner-reference cap makes composite behavior rows misattribute asserted semantics | `baseline_violation` | Admit a closed bound of up to five row-specific owners, derive the exact owner set from effects/trace/fault semantics, and keep uniform cross-row ID/order/close invariants owned once by eval composition |
| Shared timeout preload accelerates unrelated wait, mode and turn deadlines | `implementation_concern` | Gate preload independently for only the one-hour turn deadline and omitted 30-second wait; exercise mode timeout against the real fixed 15-second runtime deadline, forward admitted flags only into the installed MCP runtime environment, and regress all three timer classes independently |
| Skill body требует explicit request, но metadata разрешает implicit invocation | `implementation_concern` | Set `allow_implicit_invocation:false` so discovery policy and operator contract agree |
| Proposal promises collaboration acknowledgement delivery beyond the writable-transport contract | `baseline_violation` | Promise one synchronous empty-result response attempt while writable and state explicitly that delivery is not guaranteed |
| Ordinary rows repeat the lifecycle owner despite uniform eval-owned close composition | `overengineering` | Remove row-level lifecycle refs and reject future copies in the semantic gate |
| Proposal omits close-plus-resume when launch-only settings change | `baseline_violation` | Add the setting-change branch to the live-session lifecycle summary |
| Exact-seven prose calls a preserved scenario title an identifier | `baseline_violation` | Keep the lineage title without inventing a corpus scenario ID |
| README omits close-plus-resume for launch-only setting changes | `baseline_violation` | Distinguish in-place mode transition from launch-only close plus explicit resume |
| Semantic gate rejects only known governed extras, not every non-derived valid owner | `implementation_concern` | For programmed rows reject every authoritative reference outside the exact derived owner set |
| Operator contract requires a caller-visible final report before the close tool call | `baseline_violation` | Retain semantic result, perform required close, then report result and limitations; exact receipt остаётся в tool evidence |
| Authority oracle can consume future grants or decreasing turn provenance | `implementation_concern` | Rebuild authority per observation from immutable initial grants and reached follow-up turns; require bounded nondecreasing Codex-turn indexes |
| Runtime requirement promises every ACP request is forwarded to the caller | `baseline_violation` | Expose only normalized pending and admitted collaboration evidence; execute filesystem callbacks behind runtime checks and reject/ignore unsupported or malformed requests without false permission observability |
| Effect before a failed or timed-out terminal can bypass authority provenance | `implementation_concern` | Require exactly one authority-bearing trace observation for every programmed effect and project safe effects before every terminal status |
| Late failed/timed-out wait races between `closing` and `tombstone` | `implementation_concern` | Normalize both wrapper states to the same ordered terminal plus receipt evidence and retain explicit close as the lifecycle observation |
| Operator contract leaves first-wait cursor optional while behavior rows require an exact match | `baseline_violation` | Историческая форма superseded: user-approved cursor baseline ниже удаляет обязательную equality |
| Model-goal admission omits answer/cancel tools and retention markers | `implementation_concern` | Keep one complete public-tool token set plus timeout/retention control markers and reject them in ordinary model inputs |
| Narrow file-review effect omits its facade Workspace owner reference | `implementation_concern` | Reference Workspace discipline for every read/write effect row and enforce it generically in the semantic gate |
| One stochastic baseline/mutation pair is described as causal proof | `baseline_violation` | Superseded 2026-09-07: prose-only sensitivity mutation удалена; causal claim и replacement fake green отсутствуют |
| Best-effort acknowledgement wording treats asynchronous EPIPE as a harmless pre-write closure | `baseline_violation` | Abandon only a pre-write non-writable/synchronous rejection; preserve normal transport-failure terminalization for async EPIPE after write acceptance |
| First completed terminal wait can carry wrapper-loss tombstone needed for direct resume | `implementation_concern` | Order completed terminal and receipt first, then preserve tombstone from either the same wait or a later old-wrapper observation; suppress only failed/timed-out shutdown-state races |
| Long-lived specs duplicate an excluded vendor flag already owned by the adapter golden | `overengineering` | Keep closed-schema rejection generic and retain exact flag semantics only in current-version golden/design evidence |
| Prose report разрешён одновременно с обязательной копией IDs/receipt/model/decision JSON | `baseline_violation` | IUX-3: один пользовательский report contract; task 5.2 |
| Overall mismatch при зелёных применимых components | `baseline_violation` | IUX-19: единый classifier mechanics/evidence/exact delivery; task 5.4; прежний derived outcome superseded 2026-09-07 |
| Удаление disclosure bindings пропускает голый success marker при events_lost | `baseline_violation` | Историческая форма superseded 2026-09-07: свободный disclosure не scored; trace остаётся mechanical evidence |
| Проверяемый final удаляется, omission неотличим от extraction failure | `baseline_violation` | IUX-19: publish capture proof до cleanup; task 5.1 |
| Точные Codex phase/items/pagination semantics не подтверждены | `external_adapter_drift` | Installed-interface review и version-specific golden; task 5.1 |
| Mandatory final-only ID handoff без production consumer | `overengineering` | Continuation по existing MCP trace; отдельный protocol исключён |
| Candidate fingerprint не включает oracle/adapter, baseline находится в temp | `baseline_violation` | IUX-19: manifest реально использованных inputs и durable bundle; task 5.6 |
| Новый полный baseline после каждого targeted pass без диагностического gate | `baseline_violation` | IUX-19 Cost-aware policy; tasks 5.7–5.11 |
| Candidate identity смешивает payload и разные high/medium run settings | `baseline_violation` | Immutable manifest отделяет candidate digest от run record; task 5.6 |
| Automatic scenario retry скрывает первый non-pass при acceptance | `baseline_violation` | Одна попытка на scenario/run; повтор только новым run после diagnostic gate в owner Cost-aware execution policy; tasks 5.7/5.9 |
| README сохраняет старые model gate и retry semantics | `implementation_concern` | Синхронизировать до candidate freeze; task 5.11 после hosted gates меняет только baseline/summary/bundles |
| File-review fallback требует полное предложение provider вместо user marker | `baseline_violation` | `FILE_REVIEW_OK` остаётся exact interaction marker; outcome inference superseded 2026-09-07 |
| Final outcome owner не определён для multi-turn и checks без outcome | `baseline_violation` | Superseded 2026-09-07: reported outcome всегда `not_checked`; exact checks только interaction |
| Pure report scorer не получает captured finals по turn | `implementation_concern` | Captured finals сохранены; scorer проверяет только mandatory nonempty final и exact delivery |
| Actual outcome или marker используется как reported outcome | `baseline_violation` | Никогда не фабриковать report evidence: `reported_task_outcome` всегда `not_checked` |
| Language/template/phrase mining для свободного report | `overengineering` | Удалить из mandatory acceptance; exact requested tokens не являются language template |
| Prose-only `events_lost` sensitivity mutation | `overengineering` | Удалить без replacement marker или fake green; mechanical trace scenario остаётся |
| Mandatory free-prose scoring | `new_scope` | Одобренное 2026-09-07 сокращение baseline: проверять только mechanics/evidence/exact delivery и сохранять capture |
| Unconditional mismatch oracle rejects a safely rejected and corrected existing-session call | `new_scope` | Одобренный пользователем recovery-aware baseline: finite typed address/wait-state/set-mode classes с нулём или более contiguous pure current-session status reads внутри каждого disjoint recovery span; raw error/calls сохраняются, остальные mismatches остаются failures |
| Recovery-aware eval relies on an undeclared pre-action lookup guarantee | `baseline_violation` | Declare once in runtime owner «Публичный MCP tool contract» that existing-session `unknown_session | unknown_turn` lookup fails before tool-specific provider dispatch/state/effect; eval only references that owner and bounded tombstone eviction remains housekeeping |
| Single-ID/strict-adjacency implementation excludes other user-approved proven pre-effect corrections | `baseline_violation` | Replace the narrow pair with one finite eval-owned taxonomy for address, wait state and set mode; keep ungrounded read/answer repairs as mismatch, fresh-wait unknown-request recovery distinct, and reopen task 5.7d |
| Coverage result не связан с exact product sources, а zero-counter review переносится вручную | `new_scope` | Одобрено пользователем после terra/high diagnostic: IUX-18 owner добавляет coverage-only source proof и deterministic audit CLI; task 5.7e |
| Ручной closeout может смешать candidates, потерять history или отметить tasks до проверки evidence | `new_scope` | Одобрено пользователем после terra/high diagnostic: IUX-19 owner добавляет один deterministic finalizer с atomic per-file publication и tasks-last; task 5.7f |
| Event high-water ошибочно трактуется как read acknowledgement и требует latest event cursor equality | `new_scope` | Одобрено пользователем: удалить `cursor_matched` без replacement tracker; latest resume cursor остаётся рекомендацией, а runtime-valid earlier/repeated/omitted cursor не является mismatch; task 5.7g |
| Harness теряет complete early terminal и требует capture для ещё не начатых planned turns | `baseline_violation` | IUX-19: capture всех фактически начатых turns, missing planned suffix как scenario mismatch; pass/acceptance сохраняют полный count; task 5.7h |
| Последовательный high→medium задерживает явно разрешённую независимую проверку medium | `new_scope` | Пользователь разрешил параллельные high/medium после diagnostic на одном candidate; прежний high 78/78 сохраняется, дополнительных автоматических high reruns нет |
| Пользователь подтвердил ранее зафиксированный high после изменения harness/corpus | `new_scope` | IUX-19 сохраняет high как historical reference с исходными inputs и явным отсутствием применимости к текущему candidate; current diagnostic/medium остаются строгими |
| Неиспользованный carry-forward engine доказывает эквивалентность, которая больше не требуется | `overengineering` | Заменить на проверку historical reference против его собственных freeze/corpus; удалить README/package compatibility machinery |

| Runtime preview truncation необратимо теряет часть review | `new_scope` | Явно одобрено пользователем: IUX-20 retained full result и bounded read; tasks 5.0a/5.0b |
| Legacy delivery/progress wording не различает preview и retained full result | `baseline_violation` | Согласовать owner references и краткое baseline описание с IUX-20 |
| `turn.failed` исключает runtime overflow и предполагает provider rejection | `baseline_violation` | Observed failed terminal с соответствующим armed fault; без fabricated provider error |
| Skill называет read path, но не public read tool | `baseline_violation` | Один operator-facing `cursor_read_result`, с runtime-owned schema |
| Для long-result row предложен дополнительный padding hook | `overengineering` | Existing terminal `progress_text` + `result_text` уже пересекают preview bound; task 5.0b фиксирует fixture construction |
| Preview receipt и full result digest можно смешать в evaluator | `implementation_concern` | Task 5.4 явно разделяет две разные области evidence comparison |

## Goals / Non-Goals

**Goals:** сохранять корректный session/turn address и рекомендовать sparse
resume hint без read-ack semantics, исключить неподдерживаемый review mode в
нормальном tool loop, сделать ошибочный pending ID восстанавливаемым, дать bounded evidence
terminal result без raw provider payload, разрешить явный per-session model
override без mutation глобальной конфигурации и продолжить уже созданную
Cursor-сессию без скрытого поиска её архива.

**Non-Goals:** не менять публичный union session/turn states, не дублировать lifecycle в facade,
не гарантировать семантический успех по protocol completion.

## Decisions

### Additive resume hint вместо нового wait API

`resume_after_event_id` дублирует value high-water mark намеренно как
caller-facing next-step hint. Existing `after_event_id` semantics и event log
остаются единственным runtime owner; новый field не хранит независимое state.
Latest hint является рекомендуемым sparse default; high-water mark не является
acknowledgement чтения предшествующих событий. Успешный wait принимает также omitted=0, повторный или более ранний
runtime-valid `after_event_id`, и eval не выводит из него `cursor_matched`.
Отдельный `cursor_resume` для wait отвергнут: он добавил бы API без новой
наблюдаемой возможности. Это не относится к принятому
`cursor_resume_session`, который пытается продолжить provider conversation
через admitted version-specific load operation после terminal close.

### Wait допускает трёхминутный bounded backoff

IUX-2 заменяет только верхнюю public границу `timeout_ms` на 180 000 мс. Это
сохраняет default 30 секунд, минимум 1 секунду и bounded waiter cap, но убирает
лишние timeouts для длительного read-only review без polling или новой session.

### Recovery summary без pending context

Unknown/stale answer возвращает only opaque request IDs/kinds и current cursor.
Это достаточно для исправления caller loop, но не раскрывает permission title,
locations или raw ACP data через error path. Автоматическое повторение answer
или `allow-once` отвергнуто как нарушение authority boundary.

### Recovery-aware correction остаётся видимой и аудируемой

Runtime requirement «Публичный MCP tool contract» остаётся владельцем
pre-effect rejection, а facade «Skill workflow делегирования» использует current
causal public IDs, cursors, pending context и mode из tool-held state.
Единственная finite grammar и classifier proof допустимой correction pair
принадлежат eval requirement «Сценарный контракт поведения и authority-aware
interaction»; driver и верхние слои только ссылаются на него.

Эта граница не скрывает MCP error и не разрешает loose matching. Evidence
сохраняет raw rejected/corrected calls и normalized error; canonical digest
служит только проверке разрешённой typed delta и не является privacy или
integrity гарантией. Свободный prose остаётся `not_checked` и не доказывает
recovery.

### Receipt формируется из public bounded result

Terminal receipt создаётся из already-admitted result text и добавляется в
terminal envelopes. SHA-256 делает receipt пригодным для отчёта без второго
persistent store. Read/parse `~/.cursor/acp-sessions` отвергнуты из-за private,
version-unstable schema и риска захватить неограниченный чувствительный data.

### Evidence mode выбирается skill до delegate

Skill документирует mutually exclusive `file review` и `snapshot review`.
Это исправляет противоречивые prompts без runtime policy layer и не меняет
existing permission semantics.

### Модель передаётся только при запуске новой сессии

Опциональные model parameters принимают schema-owned `cursor_start_session` и
`cursor_resume_session`, а facade-owned `cursor_delegate` forwards их; runtime
normalizes the forwarded value to `"auto"`, сохраняет values в session
envelope и всегда запускает per-session model selection. Он не вызывает
отдельный provider discovery, не строит registry, не выбирает fallback и не
читает или пишет глобальную provider configuration. Недопустимое для
установленного CLI значение
завершается его обычной init failure, а caller получает model из envelope для
диагностики. Exact CLI encoding принадлежит только version-specific
adapter/golden fixture admitted Cursor version. Это устраняет
временную смену global config, не создавая второго владельца model availability.

### Review — назначение, а не режим ACP

`file review` и `snapshot review` — шаблоны skill, а не значение `mode`.
Skill запускает read-only review с допустимым `mode: "ask"` (либо `plan`, когда
нужен план); runtime error для иного mode перечисляет допустимые значения.
Так сохраняется единственный ACP union `ask|plan|agent` и устраняется ошибка
первого вызова без нового API.

### Effort и fast — параметры сессии

`effort?:string` и `fast?:boolean` — public fields IUX-1 с `null` при omission.
IUX-7 передаёт exact supplied overrides новой ACP session, не проверяет
model-specific availability, не задаёт fallback и не меняет global Cursor
config. Exact CLI encoding и допустимые комбинации для установленной версии
остаются единственным контрактом version-specific adapter/golden fixture.

### Resume использует выданный Cursor ID, а не private archive

IUX-1 owns the exact `cursor_resume_session` schema, including optional launch
parameters. The operation создаёт новый
runtime-owned MCP session и запускает новый ACP процесс, который вызывает
version-specific admitted load operation с exact previously returned opaque
`cursor_session_id`. Новый runtime `session_id` и все новые `turn_id` остаются
локальными opaque IDs; provider ID возвращается в каждом SessionEnvelope только
для последующего explicit resume. Runtime повторно проверяет canonical `cwd`,
allowed roots и requested `mode`; load не делает prompt, а optional model
parameters влияют только на argv нового ACP-процесса, не на provider-load input или
version probe, и не выполняет fallback `session/new`.

Владение persistence остаётся у Cursor: plugin не читает private provider
storage, не вызывает private session listing, не строит registry и не
утверждает, что provider хранит session бессрочно. Недоступный или отклонённый
provider ID даёт обычную init/protocol failure с тем же opaque ID в bounded
envelope; caller сам решает создать новую сессию.

### Close не повторяет уже доставленный terminal result

Первый `cursor_wait` для завершившегося target turn — единственный штатный
delivery path compact terminal preview и его receipt; повторный wait для
того же turn не возвращает их снова. Последующие mutation acknowledgements
могут вернуть только тот же compact immutable receipt, но не
`last_terminal_turn`; обычные waits другого/active turn его не дублируют. Close
redacts retained snapshot. Так progress и close сохраняют idempotence и
diagnosability без повторного расхода context; diagnostic preview snapshot
доступен по явному status, полный retained текст — только через
`cursor_read_result`.

### Mutation acknowledgement не является диагностическим snapshot

`cursor_delegate`, prompt/answer, mode, cancel и close возвращают flat
`ActionEnvelope`: IDs, текущее state, cursor и только operation-specific
outcome/receipt. У `cursor_delegate` один раз добавляются requested/forwarded
`model`, default-normalized non-null overrides и provider ID как bootstrap для caller; другие actions не повторяют эти static
поля. Вложенные turn/session snapshots, `null` и пустые collections остаются у
start/resume и явного `cursor_session_status`. Это сохраняет exact IDs для
следующего wait без повторной передачи уже известных данных.

### Active-turn follow-up использует подтверждённый lifecycle

Подтверждённый public runtime не предоставляет отдельного active-turn steering
tool. Поэтому новый steering tool не вводится: уже переданный
user follow-up ждёт terminality текущего turn и запускается через
`cursor_send_prompt` в той же session только после `completed + live`.
Failed/timed-out/cancelled/tombstoned state требует нового post-failure user
decision. Это использует подтверждённый session lifecycle и не создаёт
fake-only adapter capability.

### Один lifecycle для ролей, не новые role-tools

`ask`, `plan` и `agent` остаются единственным mode union Cursor ACP. Новый
`cursor_set_mode` only forwards the admitted adapter mode operation в live idle
session. Поэтому researcher может начать с Q&A, перейти к plan approval, а
после explicit authority — к implementation/debugging, сохранив provider
conversation и opaque IDs. Active turn и tombstone отклоняются до wire
dispatch; same mode is a no-op. Новый tool не меняет model or plugin roots
или permission policy.

ACP client capabilities фиксируются при initialize, поэтому процесс
advertises bounded read/write callbacks сразу. Это не даёт права на запись:
runtime допускает write callback только при текущем `mode:"agent"` и
fail-closed отклоняет его в `ask|plan`. Иначе обещанный переход
research → implementation в той же provider conversation был бы технически
невозможен после read-only initialize.

### Collaboration progress — event, не result

Version-specific admitted nonblocking collaboration requests нормализуются
только в bounded typed projection
существующего event log: todo IDs/content/status и merge flag, task
description/type/model/duration, image description/path. Raw prompts, image
data, arbitrary nested payloads и provider frames отбрасываются. Malformed или
unadmitted request игнорируется, а не terminalizes healthy turn. Для каждого
recognized request с ID runtime делает ровно одну synchronous empty-result
response attempt, пока transport writable. Уже non-writable transport или
synchronous send rejection означает локальный abandonment без retry и без
изменения уже установленного session/turn outcome; asynchronous EPIPE после
принятого `stdin.write` остаётся normal fail-closed transport failure и может
terminalize active turn. Delivery acknowledgement не гарантируется. Проекция —
только progress hint, не terminal receipt и не semantic success.

Version-specific adapter/golden является единственным владельцем точных Cursor
wire keys, request/response формы и их проекции в эти public progress fields.
Golden извлекается из pinned installed interface; runtime tests обязаны
потреблять каждый admitted variant и отклонять пропущенные required либо extra
wire fields. Верхние слои не повторяют эти version-sensitive детали.

### Focused tests не обходят supervisor

`run-node-tests.mjs` остаётся единственным Node test entrypoint: `unit`,
`release` и `eval` могут принять только входящие в фиксированный список своего
lane canonical test-file selectors и один name pattern, но всё равно используют
тот же child process group, deadline и atomic artifacts.
`coverage` намеренно не принимает selector: его complete product manifest —
единственный источник coverage-gate. Проверка действует как на CLI parser, так
и на экспортированный supervisor, поэтому library caller не может случайно
создать частичный coverage result.

Coverage source binding и zero-counter audit принадлежат тому же IUX-18 owner
requirement «Lane selection и coverage scope». Eval closeout только принимает и
хэширует готовый local audit proof; он не объявляет его доказательством hosted
candidate source binding и не присваивает semantic classifications.

### Operator surface получает user-level доказательство

Любое расширение публичных skill/MCP happy paths сопровождается scenario eval в
реальном Codex agent context. Eval загружает установленный skill и проверяет
observable tool/effect trace, IDs, pending handoff и close/continuation policy.
Package E2E owns точные установленные байты, discovery и один минимальный facade
canary; eval owns mandatory mechanics/evidence/exact delivery behavior proof. Substring
или regex по `SKILL.md` отвергнуты: они доказывают наличие слов, а не поведение.

### Mandatory acceptance проверяет mechanics и exact delivery

IUX-19 использует существующие capture, transcript, pure oracle и
`EvalResultV1`. Каждая programmed row задаёт `report_checks`; пустой массив
выбирает generic nonempty-final delivery. Непустые checks имеют только category
`interaction` и проверяет exact literal данные из corpus/program/fixture:
marker/result token, вопрос, видимые option labels или plan content. Он не
выводит outcome/safety semantics, не задаёт язык, шаблон или авторские фразы и
не использует alternatives, fuzzy matching или LLM judge.

Current same-task continuation проверяется фактическими calls; exact receipt,
IDs, progress revision, authority/effects и IUX-20 read проверяются
trace/evidence. Event high-water остаётся runtime state и рекомендуемой
следующей sparse-позицией, но не read acknowledgement или обязательной
continuation equality. Version-specific
capture сохраняет exact final, turn, phase, source и completeness. Каждый model
final обязан существовать и быть непустым: confirmed missing/complete empty —
interaction mismatch, incomplete extraction — integration failure.
`actual_task_outcome` наблюдается независимо. `reported_task_outcome` всегда
`not_checked`; components `outcome_report` и `safety_disclosure` также всегда
`not_checked`. Один aggregate verdict включает все применимые mechanics,
evidence, capture и exact-delivery checks.

100% pass означает functional acceptance mechanics, trace, IDs,
authority/effects, capture, exact delivery и IUX-20. Он не сертифицирует
корректность свободного prose, safety disclosure, язык, стиль или противоречия
вне exact requested tokens; в частности, наличие и истинность свободного
disclosure о неполноте остаются `not_checked`.

Порядок завершения находится в tasks раздела 5: детерминированный repair,
диагностика high, затем high и medium; по прямому указанию пользователя
дополнительный high07 и medium07 выполнялись параллельно на текущем candidate.
Зафиксированный `acceptance-05/high.json`
78/78 сохраняется без изменения или переименования. Пользователь подтвердил
`new_scope`: принять этот high как historical reference с исходным candidate,
без утверждения его применимости к текущим harness/corpus. Единственный owner
проверки и маркировки reference — IUX-19 «Immutable evidence manifest»;
current diagnostic/medium используют один candidate. Неиспользованный узкий
carry-forward engine удаляется как избыточный для этого решения. Финальные
повторы наследуют project-wide `AGENTS.md`; неизвестный behavior mismatch
требует локализации и не разрешает дополнительный автоматический high run. Новые результаты
не сравниваются с историческими counts как с неизменной системой, а digest
manifest и durable bundle связывают их с конкретным кандидатом.
После pre-freeze проверок один IUX-19 finalizer проверяет diagnostic, high и
medium series и immutable references, затем обновляет closeout proof, additive
baseline, Markdown summary и последними tasks 5.8–5.11. Это узкий consumer
существующих artifacts, без нового workflow engine, registry или approval.

### Live session живёт дольше одного turn

Terminal turn завершает только адресуемый prompt, а не обязательно весь
delegated workflow. Только если явно объявленный пользовательский follow-up или
следующий этап ревью с теми же launch options остаётся незавершённым, skill сохраняет live runtime session и
вызывает `cursor_send_prompt` после `completed + live`. `cursor_set_mode` допустим
между turns и сохраняет provider conversation. Close выполняется только при
workflow completion, abandonment/cancel или irrecoverable failure; смена
launch-only options требует close и explicit resume по provider ID. Возможность
будущего сообщения сама по себе не откладывает close. Один workflow step имеет
одного close owner; после resume он закрывает resumed wrapper по новому current
runtime `session_id`.

### Isolated worktree — operational recommendation

Для write-capable/concurrent work isolated worktree предпочтителен, потому что
снижает риск конфликтов. Он не является security boundary и не проверяется
runtime/facade. Canonical checkout допустим при явной user authority и принятом
coordination risk. Skill не выводит delete authority из создания artifact:
без уже выданной exact/bounded delete authority он сохраняет
path и сообщает его пользователю для отдельного решения, а при существующей
explicit authority не запрашивает повторное подтверждение. Это исключает destructive operator path,
для которого в frozen v1 corpus нет самостоятельного behavior scenario.

### Hosted prose не является mandatory gate

Историческая focused verification показала false negatives из-за English
assertions над Russian prose. Поэтому corpus и skill не навязывают язык,
шаблон или тестовые фразы. Mandatory oracle проверяет только exact данные,
которые пользователь или fixture действительно требует доставить.

### Verification runtime, user-authorized 2026-09-07

Успешный unit run занял 92,1 секунды: bootstrap file — 91,95 секунды,
runtime file — 63,6 секунды, включая два реальных ожидания по 15 секунд.
Пользователь поручил применить исследованный план ускорения до candidate freeze.
Это implementation concern существующей verification, без нового публичного
runtime invariant или изменения admission/acceptance corpus.

Общий test-only fake-adapter core нужен, чтобы убрать сотни повторных Node
startups из lifecycle tables через существующий `runCommand` seam. Он имеет
одного владельца fake state/fault semantics; CLI wrapper использует тот же core
и сохраняет process/wire boundary. Parity и отдельные real kill/timeout/overflow
тесты проверяют, что смена test transport не скрыла поведение bootstrap.
Управляемое время убирает реальные ожидания в deadline tests; production limits
и transport deadlines сохраняются. Concurrency остаётся 2. Tasks 5.7a–5.7b
владеют реализацией и проверкой ускорения; hosted attempt policy не меняется.

## Risks / Trade-offs

Принятый риск: 100% mandatory acceptance может сосуществовать с вводящим в
заблуждение свободным prose вне exact requested tokens. Сохранённый exact final
делает такой текст доступным для inspection, но не превращает его в scored
semantic proof. Универсальная semantic оценка потребовала бы отдельного
подтверждённого judge contract и остаётся вне v1.

- [Additive envelope fields не попадут в часть старых consumers] → fields
  additive; existing fields и schemas сохраняются, adapter/golden fixtures
  обновляются как version-specific evidence.
- [Receipt ошибочно примут за semantic success] → skill явно разделяет protocol
  completion и semantic verification.
- [Recovery summary раскроет context] → contract допускает только IDs/kinds,
  а tests покрывают отсутствие context/locations.
- [Consumer ожидает terminal snapshot от close/progress] → единственный
  automatic preview delivery path — terminal wait; для явной диагностики
  сохранён preview `cursor_session_status`, для полного текста —
  `cursor_read_result`, а regression tests фиксируют redaction.
- [Cursor version не поддерживает steering extension] → extension исключён из
  v1; follow-up ждёт terminality и использует подтверждённый `session/prompt`
  только после `completed + live`, иначе требуется новое user decision.

## Migration Plan

Новой пользовательской миграции нет. Обновлённый skill начинает использовать
resume hint сразу после установки; прежние callers могут продолжать использовать
`last_event_id`. Добавляется opt-in `cursor_resume_session`; wait cap становится
180 секунд, persistent data не меняются.
Rollback — откат change.


### IUX-20: Полный результат при компактном preview
Наблюдаемый дефект — Grok завершил review, но terminal preview потерял часть
findings, и доступные wait/status не могли вернуть хвост. Простое увеличение
preview расходует контекст и оставляет ту же потерю на новой границе. Один
runtime-owned read tool поверх уже удерживаемого turn сохраняет compact wait
и даёт caller полный результат без повторной генерации.

Нормативные schema, paging, failure и retention находятся только в runtime
owner requirements из индекса. Новый persistent artifact/registry не нужен.
Runtime tests доказывают полноту и лимиты; один Codex behavior scenario доказывает
только чтение хвоста перед report/close; отдельная recovery row проверяет failed
terminal, отсутствие regeneration и close по trace, сохраняет capture, а свободный
prose не оценивает. Package canary проверяет discovery дополнительного tool через
существующий installation owner, не повторяя семантику paging.
