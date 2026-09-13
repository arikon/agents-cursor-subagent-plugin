## MODIFIED Requirements

### Requirement: Immutable evidence manifest
Существующий private published evidence object каждого scenario с полным
validated proof MUST сохранить transcript/oracle/result fields и report capture
из «Eval transcript plumbing и process verdict». Поле `manifest` MUST быть закрытым
`EvidenceManifestV1` с `schema_version: 1`, `hash_algorithm: "sha256"`,
`hash_encoding: "lowercase-hex"`, digest objects `installed_skill`, `corpus`,
`materialized_scenario`, `adapter`, `evaluator`, closed `installed_payload`, `client` и
`model`, без additional properties. Closure относится только к manifest
subobject и MUST NOT переопределять существующий evidence envelope. При
pre-proof failure validated durable evidence MUST NOT публиковаться: используется
существующий `EvalResultV1` с `evidence_publication_status:"not_attempted"` и
`evidence_ref:null`, без nullable variant manifest.

На управляемом hosted failure harness MUST до cleanup попытаться атомарно
сохранить один diagnostic-only sidecar с уникальным именем
`hosted-failure-<UUID>.json` во внешний evidence root, переданный outer runner.
Success не создаёт этот sidecar. Он сохраняет bounded снимки уже
compact MCP trace и fake-ACP safe evidence, включая malformed/partial content,
и bounded projections lifecycle, client/server request metadata. Каждый source
сохраняет не больше 1,048,576 исходных bytes (при превышении — tail); полные
размер/hash вычисляются потоково. Каждая metadata collection сохраняет не больше
20 entries, IDs/methods/statuses — не больше 256 исходных UTF-8 bytes на string,
error message — 8000, turn error — 4000, read/publication error — 1000;
stderr tail — не больше 4000 characters. JSON escaping и UTF-8 replacement
могут увеличить serialized размер; общий лимит файла 1 MiB не обещается. Raw request
params, prompt/model text, provider payload и private history MUST NOT
добавляться в эти projections. Для каждого source фиксируются status
(`captured`, `truncated`, `missing` или `read_error`), доступные исходные
bytes/hash и retained bytes/content; truncation обозначается явно.
Ссылка path/bytes/hash MUST быть префиксом bounded failure diagnostics
после child и outer fixture cleanup. Publication failure MUST быть явно
отмечен, сохраняя исходную причину и все cleanup attempts. Abrupt process loss
не гарантирует сохранения sidecar.
Этот sidecar не является `EvidenceManifestV1`, не заполняет `evidence_ref`,
не подтверждает acceptance и не меняет verdict, proof admission или cleanup
precedence. Existing matrix artifact index владеет его переносимым хранением.

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
по существующему classifier precedence; pre-proof failure не публикует validated durable
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
Results из отдельно выбранных series MUST NOT собираться в одну зелёную серию. До первого child matrix сохраняет declaration выбранных candidate, corpus, model/effort, serial count, concurrency и режима остановки. Pause после первого успешного полного run и resume допустимы только внутри этой же declaration с проверкой неизменности inputs, settings и всей сохранённой истории; failed series не возобновляется ради отбора успешных runs. Исторические
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

Scenario evidence для successful и failed evaluation MUST сохранять exact materialized scenario и достаточные normalized observations, фактически переданные pure oracle, в существующих bounds publication. Transcript и captured finals сохраняют своих прежних owners; replay связывает эти данные с manifest и исходными artifact hashes. Отсутствующий или повреждённый replay input не восстанавливается из ожидаемого результата и не проходит replay admission. Raw credentials, environment dumps и произвольные model payloads не входят в этот capture. Legacy artifacts остаются immutable и могут быть признаны недостаточными для replay.

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
--output <acceptance-bundle-root/closeout-proof.json> [--task-ids <id,id,...>]` MUST быть единственным deterministic closeout
consumer. Он принимает один frozen input manifest, successful high
diagnostic, одну high series из трёх serial runs, одну medium series из трёх
serial runs и один current successful coverage audit. Для новой серии `--diagnostic` указывает на тот же matrix, что `--high`: diagnostic выводится из её первого serial run после проверки полной matrix и ссылается на тот же hash. Отдельный исторический serial=1 diagnostic поддерживается. Incomplete aggregate или run summary MUST отклоняться; общий diagnostic не создаёт четвёртый trial. До любой target mutation
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
checkboxes из явно выбранного `--task-ids` непустого списка уникальных существующих
числовых dot-separated IDs. Без аргумента сохраняется default `5.8,5.9,5.10,5.11`.
Каждый выбранный anchor MUST существовать ровно один раз; остальные task
checkboxes и текст MUST остаться неизменными. Список выбирает только задачи,
которые доказываются этим closeout; он не утверждает independent review.
Один resolved список MUST использоваться для нормализации tasks, проверки,
публикации и существующего `completed_tasks` в proof; отдельная схема или
автоматическое угадывание задач не вводится. Каждая target file заменяется атомарно, повтор с теми же
inputs идемпотентен, tasks записываются последними. Любая validation failure до
начала публикации MUST оставить proof, baseline, Markdown report и tasks без изменений.
Межфайловая транзакция не обещается: interruption во время публикации может
оставить корректный prefix, который идемпотентный повтор восстанавливает до
полного набора. Finalizer не архивирует OpenSpec change, не создаёт generic
workflow engine/registry и не выдаёт critic или architect approval.

#### Scenario: Failure diagnostics переживают fixture cleanup
- **WHEN** hosted execution завершается управляемой ошибкой до полного proof
- **THEN** diagnostic-only sidecar остаётся доступен после обеих cleanup attempts,
  partial/missing/unreadable sources имеют явный status, а bounded failure
  diagnostics сохраняют его reference; forbidden raw fields не добавляются
- **AND** ошибка публикации сохраняет исходную причину и не пропускает cleanup;
  ни один из путей не превращает sidecar в accepted evidence

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
  additive baseline, summary и последними только выбранные task checkboxes (исторический default без `--task-ids`)

#### Scenario: Неуспешная validation не меняет acceptance records
- **WHEN** любой required input, hash, count, capture, publication или cleanup
  не проходит проверку до начала output publication
- **THEN** finalizer не изменяет baseline, Markdown report или tasks и не
  архивирует change

#### Scenario: Прерванная публикация восстанавливается повтором
- **WHEN** публикация прерывается после атомарной замены части target files
- **THEN** уже записанные файлы остаются валидным prefix, tasks не опережают
  остальные outputs, а повтор с теми же inputs идемпотентно завершает closeout

#### Scenario: Closeout нового change выбирает существующую задачу
- **WHEN** finalizer получает полный proof и `--task-ids 3.4` для tasks с единственным anchor 3.4
- **THEN** он завершает только 3.4, сохраняет 3.5 и остальные строки, а повтор с теми же inputs идемпотентен

#### Scenario: Некорректные task IDs не публикуют closeout
- **WHEN** выбранный список пуст, содержит дубли или некорректный ID, либо anchor отсутствует или встречается несколько раз
- **THEN** validation завершается до изменения proof, baseline, report и tasks

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
reproductions. После freeze первый полный run заранее объявленной series служит hosted diagnostic выбранной конфигурации и засчитывается в baseline по `AGENTS.md`. Его reports/traces MUST быть проверены до продолжения той же series; самостоятельный successful diagnostic не переносится задним числом в другую series.
После baseline failure следующий запуск MUST иметь конкретную проверяемую
гипотезу и соответствующее изменение либо подтверждённое восстановление
инфраструктуры; повторять behavior trials только ради удачного pass запрещено.
Если новый дефект не локализован, публикуется непринятый результат с evidence,
а не очередное обещание «финального» прогона. После обычного failure matrix завершает текущий full run, затем не запускает следующие serial runs и сохраняет incomplete aggregate с причиной и числом незапущенных scenarios. Режим полного распределения MUST выбираться до execution; он сохраняет обычные failures и выполняет оставшиеся runs. Подтверждённая quota-stop ветка ниже останавливает оба режима немедленно.

Matrix MUST NOT автоматически повторять scenario после failure любого класса.
Каждый запланированный scenario в serial run имеет одну попытку; любой non-pass
делает этот run непринятым. После подтверждённого восстановления инфраструктуры
или repair допускается новая отдельно объявленная series через её первый diagnostic run; предыдущий failed run остаётся историческим evidence.
Перед новым hosted запуском для oracle/capture-only изменения MUST проверяться возможность deterministic replay. Replay MUST связывать исходные hashed artifacts, исходную trial identity и новый evaluator digest, не изменять исходный verdict и не выдаваться за новый independent run. Требуются достаточные исходные observations и подтверждённо неизменные model-facing inputs/materialized scenario по «Immutable evidence manifest»; отсутствие данных, skill/runtime/adapter drift или невозможность доказать equivalence дают `fresh_hosted_required`. Expected fixture output не восстанавливает отсутствующий capture. Derived diagnostic artifact сохраняет все исходные scenarios, в том числе ineligible/failed, и не публикует принятый baseline. Новый
baseline требует high и medium three-run series frozen candidate,
кроме явно одобренного historical high reference из «Immutable evidence manifest».

Candidate provenance и долговечное хранение определены в «Immutable evidence
manifest»; этот execution policy использует тот же manifest без второй схемы.
После review первого diagnostic run high three-run series (свежая либо указанный
historical reference) и свежая medium three-run series являются независимыми
gates. По явному указанию пользователя fresh high и current medium MAY
выполняться параллельно на одном frozen candidate; внутри каждой конфигурации
три runs остаются serial. Historical reference проверяется против собственных
inputs и не является текущим запуском; его validation MAY перекрываться с medium.
Только после них deterministic finalizer из
того же owner requirement может выполнить closeout; он не повторяет runs и не
создаёт отдельный approval gate.

#### Scenario: Изменение oracle обесценивает прежний acceptance
- **WHEN** oracle или capture изменены при прежних skill и corpus
- **THEN** прежние counts остаются историческим evidence; replay проверяет полный capture и неизменность model-facing inputs, сохраняет derived verdict либо причину `fresh_hosted_required`, не создавая нового hosted trial

#### Scenario: Diagnostic является первым run объявленной series
- **WHEN** первый полный run заранее объявленной baseline series проходит review
- **THEN** продолжение проверяет declaration и сохранённые inputs/history, выполняет только оставшиеся runs; отдельные успешные series не объединяются

#### Scenario: Обычный failure экономит последующие runs
- **WHEN** полный run default acceptance series содержит non-pass
- **THEN** следующие serial runs не запускаются, aggregate остаётся incomplete; заранее выбранный distribution mode сохраняет полное распределение, но также прекращается при quota

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

При подтверждённом structured hosted `usageLimitExceeded` вся текущая acceptance MUST остановиться: matrix не начинает новые scenarios/serial runs, suite не начинает другие configurations и останавливает свои уже запущенные evaluations через существующий cleanup path. Неподтверждённый текст prompt/report/stderr MUST NOT служить quota signal. Quota signal MUST сохраняться даже при отдельной cleanup/publication failure; прежний приоритет ошибок cleanup не ослабляется.

После quota matrix и suite MUST дождаться завершения собственных children, сохранить доступные evidence и атомарно опубликовать явно неполный non-passing aggregate. Незапущенные scenarios MUST NOT становиться фиктивными attempts или PASS; успешное подмножество MUST NOT считаться полным baseline. Остановка не затрагивает unrelated processes. Автоматический fallback на другую model/effort и автоматический retry запрещены. Возобновление требует подтверждённого восстановления квоты либо нового явного решения пользователя; старый partial run остаётся неизменным.

#### Scenario: Quota stops acceptance across configurations
- **WHEN** owned hosted evaluation returns confirmed usageLimitExceeded while sibling evaluations are running or queued
- **THEN** no further scenario, serial run or configuration starts, owned running children finish cleanup, and completed evidence is retained in an explicitly incomplete failed aggregate

#### Scenario: Other failures preserve the full series
- **WHEN** a scenario fails without confirmed quota
- **THEN** the existing one-attempt policy and planned series continue without automatic retry
