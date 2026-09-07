# Классификация zero-counters для supervision/eval файлов

Источник: `/private/tmp/cursor-coverage-zero-counters.json`. Проверены только:

- `scripts/check-openspec-semantics.mjs`
- `scripts/eval/run-cursor-skill-eval-suite.mjs`
- `scripts/run-node-tests.mjs`

Тесты не запускались. Классификация относится к каждому zero line/branch/function из указанного snapshot. Категории: `meaningful_contract`, `realistic_failure`, `unreachable_defensive`, `dead`.

## Итог

| Категория | Zero-points | Действие |
| --- | ---: | --- |
| `meaningful_contract` | 27 | Добавить или скорректировать observable CLI/semantic tests; для suite verdict сначала исправить false-pass |
| `realistic_failure` | 6 | Добавить минимальные fail-closed/tolerance tests |
| `unreachable_defensive` | 2 | Новые unit tests не нужны; сохранить явное обоснование и отдельную foreground verification |
| `dead` | 0 | Удалять нечего |
| **Всего** | **35** | Все zero points классифицированы |

## `scripts/check-openspec-semantics.mjs`

Snapshot: 2 zero lines, 8 zero branches, 0 zero functions.

| Zero point | Категория | Обоснование | Минимальная проверка |
| --- | --- | --- | --- |
| branch L27 | `realistic_failure` | `seen.has(digest)` предотвращает бесконечный обход циклической replacement lineage. Текущий lineage test проверяет цепочку и недостижимую цель, но не цикл. | Добавить один registry graph `A -> B -> A` и недостижимый target; `replacementLineageReaches` должен завершиться и вернуть `false`. |
| branch L35 | `meaningful_contract` | `hasFixedEvalCorpusCount` должен применять запрет фиксированных counts только к двум owner requirements, иначе semantic gate даст false positive в произвольной спецификации. | В существующий table test добавить unrelated requirement с текстом `26 programmed rows` и ожидать `false`. |
| branch L146 | `unreachable_defensive` | В admitted project flow structural `openspec validate --strict` предшествует semantic gate и capability directory обязан содержать `spec.md`. Проверка защищает standalone вызов от промежуточного/повреждённого дерева, но не является отдельным product contract semantic gate. | Новый behavioral test не нужен. Если строку исключать из coverage, рядом нужно записать structural-precondition rationale; иначе оставить как классифицированный raw zero. |
| branch L177 | `realistic_failure` | `scenario ?? {}` защищает optional-field scan от `null` row в malformed corpus. Текущий malformed-row test использует `{}`, поэтому nullish branch не наблюдается. | Добавить `scenarios:[null]`; gate не должен бросать исключение и должен вернуть diagnostic `scenario row 0 lacks owner_requirements`. |
| branch L231 + lines L232-L233 | `meaningful_contract` | IUX20 row с `turn.result-read` или fault `result-overflow` обязан получить owner `Полное чтение terminal result`. Без этого corpus может обойти owner map. | В текущем tree уже есть table row `full result read` в `tests/check-openspec-semantics.test.mjs`; он должен закрыть snapshot zeros при следующем coverage run. Дополнительно добавить/сохранить отдельный `result-overflow` case только если fault alternative ещё не проверяется. |
| branches L418-L419 | `meaningful_contract` | Интеграция `interactiveAcpUx + cursor-subagent-skill-evals + hasFixedEvalCorpusCount` запрещает stale hardcoded corpus counts в modified owner spec. Direct helper tests не доказывают, что main semantic traversal применяет правило. | На fixture с role `interactiveAcpUx` подставить fixed count в соответствующий modified requirement и проверить `invalid modified capability`; один test покрывает оба conjunction branches. |
| branch L551 | `unreachable_defensive` | Coverage lane импортирует модуль, поэтому true branch CLI entrypoint guard недостижим внутри этого процесса. Соседние L548-L550 уже фиксируют причину; реальный entrypoint проверяется отдельной foreground semantic-gate командой. | Нового unit test не требуется. Сохранять отдельный foreground `node scripts/check-openspec-semantics.mjs` как доказательство CLI path; line-ignore не следует ошибочно считать branch-ignore. |

Минимальный набор новых tests для этого файла: cycle lineage; unrelated fixed-count requirement; null corpus row; integrated fixed-count rejection. IUX20 owner test уже присутствует в текущем tree и требует только следующего coverage подтверждения.

## `scripts/eval/run-cursor-skill-eval-suite.mjs`

Snapshot: 9 zero lines, 14 zero branches, 1 zero function.

| Zero point | Категория | Обоснование | Минимальная проверка |
| --- | --- | --- | --- |
| branch L11 + lines L12-L13 | `meaningful_contract` | CLI должен fail closed при неверной арности и напечатать стабильную usage error вместо частичного запуска suite. | Table-driven foreground spawn: отсутствует plan или output, либо есть лишний argv; assert nonzero, отсутствие output artifact, usage diagnostic. |
| branch L19 | `meaningful_contract` | Default path обязан запускать canonical `run-cursor-skill-eval-matrix.mjs`; текущий happy-path test всегда задаёт `CURSOR_EVAL_SUITE_MATRIX_RUNNER`. | В существующем happy-path test убрать `CURSOR_EVAL_SUITE_MATRIX_RUNNER`, сохранив credential-free `CURSOR_EVAL_MATRIX_RUNNER=fake-eval-matrix-child`; это проверит default composition без hosted вызова. |
| branches L21-L22 + lines L23-L24 | `meaningful_contract` | Явная concurrency и rejection значений вне 1..3 являются CLI/config contract. Сейчас покрыт только default 3. | Один valid run с `CURSOR_EVAL_SUITE_CONCURRENCY=1`; table-driven invalid values `0`, `4`, `1.5`/`text`, ожидая nonzero и отсутствие suite artifact. |
| branch L27 + lines L28-L29 | `meaningful_contract` | Plan admission должен отвергать неверную schema version, пустое name и пустой/non-array rows до spawn. | Table-driven invalid plan files; assert no row process/output directory and exact bounded diagnostic class. |
| три branches L32 + lines L33-L34 | `meaningful_contract` | Row admission защищает model token и effort enum. Три zero branches соответствуют непройденным invalid/missing alternatives в compound check. | В ту же invalid-plan table добавить unsafe/missing model, missing effort и unsupported effort; assert no child spawn/output. |
| branch L36 | `meaningful_contract` | Duplicate model/effort rows запрещены, иначе один row output path перезаписывает другой и aggregate становится неоднозначным. | Plan с двумя одинаковыми rows; nonzero до mkdir/spawn и diagnostic `duplicate plan row`. |
| branch L60 | `realistic_failure` | Matrix progress stdout может содержать повреждённую/диагностическую строку. Код намеренно не принимает её за evidence и опирается на atomic row summary. | Fake suite matrix пишет одну non-JSON progress line и затем валидный summary; suite не падает, не публикует fabricated `matrix_event`, verdict следует summary. |
| anonymous function L63 + branch L68 | `realistic_failure` | Непубликованный/corrupt row summary и stderr являются реальной child failure path. Stderr listener сейчас вообще не исполнялся; catch/fallback не проверен. | Fake suite matrix пишет stderr и не создаёт row output, затем exits nonzero; suite сохраняет bounded stderr-derived `error`, `summary:null`, failed count и nonzero exit. Отдельный вариант без stderr проверяет fallback `matrix summary was not published`. |
| branch L71 | `meaningful_contract` | `row_completed.eval_status=failed` является публичным progress verdict для непройденной row. | Покрывается тем же child-failure test; assert emitted `row_completed` имеет `failed`. |
| branch L88 + line L89 + branch L97 | `meaningful_contract` | Suite aggregate/exit failure path не покрыт и сейчас содержит реальный false-pass: green/stale JSON summary принимается даже при child `code != 0` или `signal != null`. | Сначала определить единый predicate: `process.code === 0 && process.signal === null && counts pass total && digest_stable === true`. Затем два foreground cases: child exits nonzero после green summary; child завершается signal после green summary. Оба должны дать row failed, aggregate failed, atomic suite artifact и suite exit 1. |

Нужный production repair перед закрытием coverage: использовать один predicate row success одновременно в `row_completed` и aggregate loop, включая положительные `code === 0` и `signal === null`. Иначе L71/L88/L89/L97 можно покрыть тестом, сохранив ошибочный false-pass.

Минимальный test layout без дублирования: один CLI-admission table; один happy-path с default runner и explicit concurrency; один malformed-progress success; один missing-summary/stderr failure; два stale-green process failures (exit code и signal). Проверки должны быть через CLI events, atomic output JSON и exit status, без assertions на private helpers.

## `scripts/run-node-tests.mjs`

Snapshot: 0 zero lines, 1 zero branch, 0 zero functions.

| Zero point | Категория | Обоснование | Минимальная проверка |
| --- | --- | --- | --- |
| branch L56 | `realistic_failure` | File-level `test:summary` с missing/noninteger `counts.tests` не должен считаться выполненным test. False branch сейчас превращает его вклад в 0 и должен привести к fail-closed `no_tests`, даже если global summary заявляет success. | Расширить reporter fixture одним malformed file summary (`counts.tests` отсутствует или строка) и валидным global success summary; assert terminal cause `no_tests`, nonzero CLI verdict и published result. |

Этот test проверяет observable fail-closed supervisor behavior и не закрепляет внутреннее расположение `reduce` или форму private helper.

## Stop condition

Классификация завершена для всех 35 zero points. Coverage repair считается готовым после:

1. исправления suite false-pass по child code/signal;
2. добавления перечисленных минимальных observable tests;
3. следующего foreground coverage run, в котором новые counters закрыты либо оставшиеся raw zeros снова явно классифицированы;
4. отдельного foreground semantic-gate запуска для CLI guard L551.

## Closure for assigned semantic/supervisor slice

Completed in the current tree without product-code changes:

- replacement lineage cycle now terminates with an unreachable target;
- fixed corpus-count detection ignores an unrelated requirement;
- a null corpus row returns the stable missing-owner diagnostic;
- the integrated interactive change traversal rejects a fixed count in the
  modified `cursor-subagent-skill-evals` owner requirement;
- `result-overflow` requires the same `Полное чтение terminal result` owner as
  the existing `turn.result-read` table case;
- a malformed file-level `counts.tests` cannot borrow a successful global
  count and fails closed with `no_tests`;
- the pre-existing full-result-read case remains unchanged.

The two `unreachable_defensive` points remain intentionally unmodified: missing
main `spec.md` is a structural precondition path, and the CLI entrypoint guard is
proved only by the parent's separate foreground semantic command. No coverage
ignore directive was added.

Targeted verification:

`node scripts/run-node-tests.mjs unit --test tests/check-openspec-semantics.test.mjs --test tests/node-test-supervisor.test.mjs`

Result: PASS, 140/140 tests, artifact
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-06T22-00-56-089Z-unit-4248d2f8-067d-44d7-af4d-7fe4b85980f7`.

Final speed-candidate remeasurement: `test-speed/final-series/coverage/run-01/failures.jsonl`, PASS. Semantic gate has exactly the previously classified defensive branches 146 and 551, with no zero lines/functions. Reporter and supervisor have no zero counters. The foreground semantic CLI also passed after the speed changes. No new gap remains in this slice.


## Candidate 05 matrix reconciliation

The complete raw queue is retained in `candidate-05/coverage-diagnostic/zero-counters.json`. Matrix lines 142-146 and branch 141 remain the unreachable defensive fallback after normalizing any invalid child result. Branch 24 is the real default hosted driver, checked in the separate hosted lane. Branch 158 is the empty-active-set scheduling arm of the already tested interruption contract; branch 192 is unreachable with the admitted nonempty model corpus. Line 235/branch 234 defend against a non-regular entry which admitted artifact publishers never create.

Branch 128 was a meaningful integrity gap after the reported-outcome enum migration: the old wrong-final fixture became invalid before comparing two independently valid verdicts. The existing fault now changes actual_task_outcome instead. Its existing negative matrix test passes (2424 ms, artifact 2026-09-06T23-50-39-289Z-unit-6df1b267-7260-4d78-ada1-1c9c3d8f54fe). No new semantic assertion or coverage exclusion was added.

The first candidate-05 coverage command failed one supervisor readiness test even though coverage thresholds passed. Four adjacent signal tests now emit after fake spawn returns rather than before asynchronous supervisor setup completes. All 53 supervisor tests passed in 1535 ms; this is test synchronization only, with no product change. A fresh complete coverage verdict is required.
