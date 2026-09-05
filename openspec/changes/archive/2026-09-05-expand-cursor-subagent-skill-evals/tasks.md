## 1. Exact-seven corpus

- [x] 1.1 Создать `evals/cursor-subagent-scenarios.v1.json` с точным closed
  shape и семью IDs из Scenario Matrix; мигрировать текущие inputs, exact
  authority action objects, programs, observations, predicates и enabled
  outcomes требования «Сценарный контракт поведения и authority-aware
  interaction» без новых cases.
- [x] 1.2 Создать единственный product module
  `scripts/cursor-eval-scenario.mjs` с pure admission, materialization и oracle;
  loader проверяет только shape/bounds/uniqueness/path/placeholders, а semantic
  gate проверяет `{capability,requirement}` по authoritative main specs.
  Negative cases покрывают empty/absolute/dot/`..`/backslash/NUL/4097-byte path
  и `${RESULT_FILE}` без path-bearing predicate.
- [x] 1.3 Перевести `scripts/run-cursor-skill-eval.mjs` с `SCENARIOS`, outcome
  switch и `transcriptIsCorrelated` на corpus selection; сохранить CLI, disabled
  `skipped`, lane mapping, classifier и publisher contracts.

## 2. Driver и oracle

- [x] 2.1 Добавить в `tests/fixtures/fake-acp.mjs` explicit opt-in program mode
  через `CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH`; без opt-in сохранить весь текущий
  `FAKE_ACP_*` fault behavior. Regression проверяет неизменные legacy question и
  filesystem-write modes, а program mode — materialized steps.
- [x] 2.2 Реализовать «Scenario program driver и pure scenario oracle» в
  `scripts/cursor-eval-scenario.mjs`; table-driven проверить correct trace,
  answer-before-pending, ID mismatch, operation-after-close, unexpected effect
  и missing required close observation только для шести programmed rows; для
  effect проверить matching success, error, missing и wrong callback ID.
- [x] 2.3 Оставить `scripts/recording-mcp-proxy.mjs` единственным владельцем
  normalized MCP recording и `tests/runtime.test.mjs` владельцем invalid public
  ID/order rejection; удалить старую eval correlation matrix.

## 3. Exact evidence binding

- [x] 3.0 Реализовать разделение «Разделённые eval lanes и evidence загрузки
  skill»: programmed rows сравнивают cache-loaded и managed installed skill
  digests после package preflight, package reference сохраняет только managed
  installed digest и не заявляет Codex skill-load evidence.
- [x] 3.1 Добавить ровно поле `manifest` в существующий evidence envelope и
  реализовать «Immutable evidence manifest» с digests skill/corpus/scenario/
  выбранного adapter и closed projection package marker/tree hash. Adapter
  fixture возвращает digest своих raw bytes, golden независимо сверяет его и
  Codex version; generic runner не выводит source из argv. Не добавлять
  ordinal/module list.
- [x] 3.2 Для programmed row outer создаёт exact workspace, принимает corpus и
  только при наличии `${RESULT_FILE}` требует path-bearing predicate, вычисляет
  binding, materializes payload и передаёт
  child workspace+payload+digest; child не создаёт альтернативный workspace.
- [x] 3.3 Провести все client/model terminal branches через единый finalizer;
  child вызывает package-owned `runBootstrap(["preflight", ...])`, не копирует
  marker/treeHash traversal, захватывает proof/observations, выполняет cleanup и
  всегда пишет child-result. Outer сверяет exact scenario/corpus digests и
  closed shape/bounds adapter/projection; fixture/golden и package preflight
  остаются владельцами фактической сверки. При pre-proof failure outer не
  публикует durable evidence; иначе после cleanup он как единственный publisher
  пишет immutable evidence. Проверить cleanup/publication precedence.
- [x] 3.4 В `tests/release-e2e.test.mjs` передать `runLiveCanary` только outer
  package-canary-reference/digest; до удаления layout захватить observations и
  package proof, после package cleanup записать в outer-owned child-result
  consumed digest, normalized canary status и cleanup outcome; outer проверяет
  result, выполняет собственный cleanup и затем публикует evidence без
  копирования canary semantics.

## 4. Один быстрый table pass

- [x] 4.1 В существующем `tests/run-cursor-skill-eval.test.mjs` добавить один
  top-level test с `{ timeout: 2000 }` для требования «Cost-aware execution
  policy»: получить counts `admission=7`, `materialization=7`, `oracle=6`,
  `package-reference=1`, не вызывая oracle для live reference; duration/count
  вывести только TAP diagnostics.
- [x] 4.3 Cheap injected spawn/env contract проверить исключение real-Codex,
  hosted-model и full-live из unit/coverage mapping без запуска вложенных suites
  и без изменений supervisor `result.json`/lane schema.
- [x] 4.4 Для новых или изменённых этим change eval/driver tests с реальным
  filesystem/process I/O использовать отдельный `mkdtemp` и injected env без
  shared `process.env` mutation; inert no-I/O path strings оставить допустимыми.

## 5. Coverage и global owner gate

- [x] 5.1 Добавить `scripts/cursor-eval-scenario.mjs` в `productSources`
  `scripts/run-node-tests.mjs`, не менять unit test-file set, и поведенчески
  покрыть module в существующем eval test file.
- [x] 5.2 Registry хранит active/reference owner metadata без scenario IDs и
  без `skipSpecs`; semantic gate читает authoritative `.openspec.yaml`,
  запрещает capability claims/deltas у reference-only change и проверяет corpus
  `owner_requirements` по main specs без дублирования DSL.
- [x] 5.3 Проверить точные labels «Разделённые eval lanes и evidence загрузки skill», «Сценарный контракт поведения и authority-aware interaction», «Scenario program driver и pure scenario oracle», «Immutable evidence manifest» и «Cost-aware execution policy», полный MODIFIED delta и отсутствие второго semantic owner.

## 6. Acceptance и review

- [x] 6.1 Запустить targeted tests, затем ровно по одному foreground `node
  scripts/run-node-tests.mjs unit` и `node scripts/run-node-tests.mjs coverage`;
  принять только exit code 0/terminal summary и разобрать meaningful uncovered
  points по `AGENTS.md`.
- [x] 6.2 Запустить `openspec validate expand-cursor-subagent-skill-evals
  --strict`, `openspec validate --changes --strict` и global
  `node scripts/check-openspec-semantics.mjs`.
- [x] 6.3 Провести полный critic review, передать весь verdict architect,
  применить только подтверждённые минимальные repairs и повторять gates/review
  до отсутствия `baseline_violation` и подтверждения owner uniqueness.
