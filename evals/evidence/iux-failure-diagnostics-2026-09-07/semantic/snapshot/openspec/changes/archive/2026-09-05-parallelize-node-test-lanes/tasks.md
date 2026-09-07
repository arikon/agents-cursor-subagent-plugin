## 1. Reference-only semantic admission

- [x] 1.1 Для ссылки на принадлежащее `node-test-supervision` требование
  `NTS-3` «Lane selection и coverage scope» обновить semantic registry и gate:
  top-level `skip_specs: true`, существующий owner change/capability и точное
  соответствие requirement ID→title, traceability design/tasks и отсутствие
  delta-spec проверяются механически, а ownership требования не переносится в
  этот change.
- [x] 1.2 Добавить одну положительную fixture и отрицательные fixtures для
  отсутствующего marker, противоречащего marker, пустой и неверной owner-ссылки,
  неверного requirement ID, traceability drift и capability delta;
  `node --test tests/check-openspec-semantics.test.mjs` завершается pass.

## 2. Concurrency policy

- [x] 2.1 Добавить один table-driven spawn-capture contract-test точной lane
  matrix. Spawn-capture проверяет наблюдаемые child argv:
  `--test-concurrency=2` для `unit` и `coverage`,
  `--test-concurrency=1` для `release`, неизменные test-file наборы и individual
  timeout. Неизменность parent-side `deadlineMs` проверяется отдельно через
  экспортированную `LANES` matrix либо существующее observable deadline
  behavior. До изменения registry targeted run должен показать mismatch только
  для прежних значений `unit` и `coverage`.
- [x] 2.2 В единственном lane registry изменить только `unit` и `coverage` на
  `concurrency: 2`, оставить `release` на 1; targeted supervisor test из 2.1
  завершается pass.
- [x] 2.3 Синхронизировать только существующие числовые упоминания concurrency
  в README и `AGENTS.md`, если они присутствуют; статический поиск подтверждает
  отсутствие противоречащих значений и второго registry.

## 3. Acceptance evidence

- [x] 3.1 Непосредственно перед первым acceptance lane в одной zsh-сессии
  включить `set -o pipefail`, затем вычислить и записать digest всех tracked и
  non-ignored untracked файлов pipeline
  `git ls-files --cached --others --exclude-standard -z | xargs -0 shasum -a 256 -- | shasum -a 256`.
  Pipeline завершается exit code `0` без read errors. Затем последовательно и
  в foreground выполнить
  `node scripts/run-node-tests.mjs unit`, `coverage` и `release`, дождавшись
  terminal verdict и финального TAP summary каждого. Сразу после последнего
  lane повторить ту же fail-closed digest pipeline; она завершается exit code
  `0` без read errors, и оба значения буквально совпадают.
- [x] 3.2 Для coverage сначала прочитать сохранённый `result.json`, затем
  последнее событие `test:coverage` в указанном `failures.jsonl`. Для каждого
  per-file элемента `lines`, `branches` и `functions` с нулевым `count`
  записать классификацию: осмысленный контракт, реалистичный failure path,
  действительно недостижимая defensive-ветвь либо мёртвый код. Первые два
  закрыть поведенческим тестом, мёртвый код удалить, а исключение defensive-кода
  локально обосновать; после исправлений полный manifest и все метрики не ниже
  90,00%.
- [x] 3.3 Любая source/test/spec-правка после pre-digest, включая исправления
  из 3.2, аннулирует evidence 3.1 и возвращает выполнение к полному циклу
  `digest → unit → coverage → release → digest`. Финальный цикл проходит без
  последующих содержательных правок; добавление его результатов в раздел
  verification evidence и отметка checkbox не меняют проверяемый snapshot.
- [x] 3.4 Выполнить `openspec validate --changes --strict`,
  `openspec validate --specs --strict`, `node scripts/check-openspec-semantics.mjs`
  и `git diff --check`; все проверки завершаются pass без baseline violation
  или нового requirement owner.

## Verification evidence

Planning admission prerequisite: `node --test tests/check-openspec-semantics.test.mjs`
завершился exit code 0 с 44/44 pass. `node scripts/check-openspec-semantics.mjs`
завершился exit code 0 и проверил 7 changes. Snapshot pipeline завершилась
exit code 0 на текущем дереве, а контролируемый missing-input сценарий — exit
code 1 с read error, подтвердив fail-closed `pipefail` contract.

Во время apply сюда добавляются targeted concurrency red/green, пути supervisor
artifacts, оба snapshot digest, coverage-классификация и terminal verdict каждой
acceptance-команды.

Targeted red: `node --test --test-name-pattern='lane matrix produces' tests/node-test-supervisor.test.mjs`
завершился exit code 1; mismatches возникли только для прежних concurrency
значений `unit` и `coverage`, а `release` case прошёл.

Targeted green: та же команда завершилась exit code 0 с 4/4 pass; child argv,
точные test-file sets, individual timeout и parent `deadlineMs` подтверждены
для всех трёх lanes.

Документация: статический поиск числовых concurrency-упоминаний не нашёл их в
README или `AGENTS.md`; согласованные значения существуют только в `LANES`,
contract-test и артефактах этого change, второго registry нет.

Финальная acceptance matrix выполнена последовательно и в foreground на одном
срезе. Полный pre/post digest совпал буквально:
`77f8229b6eedfcef0d50c0f269a12a59ba713cb8e77ff74f1da14d482363fa82`.
Дополнительный digest вне `openspec/changes/**` также совпал:
`02c363d384a39eafd8851e2b2e5888fa34cd8e854a8ca0e78fbdda6da0ed8160`.
Terminal verdicts и artifacts:

- `unit`: PASS, 89 104 ms,
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T09-05-46-715Z-unit-c5101691-a787-4e7a-9a92-920f49c84bba`;
- `coverage`: PASS, 103 302 ms, 335/335 tests,
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T09-07-15-898Z-coverage-62e4a7e1-5673-4a87-8b8c-c355744ef060`;
- `release`: PASS, 6 999 ms,
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T09-08-59-239Z-release-17a1b2a7-6f1b-43a3-973b-6c5959bd6cee`.

Coverage `result.json` прочитан первым: manifest полон (11/11), diagnostics
пусты, lines 99,8338%, branches 94,9495%, functions 98,9717%. Затем разобрано
последнее `test:coverage` событие. Классификация всех zero-count элементов:

- **Осмысленные CLI-контракты, инструментально недоступные import-driven
  coverage:** `check-openspec-semantics.mjs` lines 339-340/branch 338,
  `run-node-tests.mjs` branch 202 и `run-unit-coverage.mjs` lines 14-15/branch
  13. Они закрыты соответственно foreground-командами
  `node scripts/check-openspec-semantics.mjs`, всеми тремя supervisor lanes и
  отдельным `node scripts/run-unit-coverage.mjs` (PASS, 101 856 ms; artifact
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T09-09-44-631Z-coverage-de89316c-deea-4e66-a2cc-e5899ed8512a`).
- **Defensive-подветви без самостоятельного публичного результата:**
  `check-openspec-semantics.mjs` branches
  69,77,83,86,145 (малформированные/отсутствующие artifact-поля уже имеют
  отрицательные fixtures); `cursor-subagent-bootstrap.mjs` branches
  24,44,56,58,68,85,109,131,155,167,186,186,187,254,322,323,324,328,333,
  342,344,358,360,379,386,393,398,399,405,421,422,429,438,474,489,566,
  665,665,665 и anonymous functions 169,557,593,654 (fallback-операнды,
  повторная остановка и compensation callbacks за уже нормализующим
  `mutate`/admission contract); `cursor-subagent-mcp.mjs` branches
  22,59,61,116,119,120,121,123,123,124,128,133,137,138,153,158,173,231,
  233,237,240,247,251,270,300,302,311,311,319,340,352,354,355,368,371,
  375,402,430,433,440,449,490 (невозможные после admission варианты ACP,
  идемпотентные lifecycle guards и fallback-операнды уже проверяемых
  observable envelopes); `recording-mcp-proxy.mjs` branches 12,103
  (package-generated target и идемпотентный повтор stop);
  `run-node-tests.mjs` branches 50,100,173,179,179,180,182,186,189,192
  (fallback-форматирование заведомо валидированных reporter/supervisor
  envelopes). V8 учитывает short-circuit operands как отдельные counters, но
  они не вводят отдельный наблюдаемый контракт: malformed ACP callbacks
  покрывает `tests/runtime.test.mjs`, а compensation reread —
  `tests/bootstrap.test.mjs`. Тесты конкретной внутренней формы ради coverage
  не добавлялись.
- Реалистичных непроверенных failure paths и мёртвого кода в zero-count queue
  не найдено.

До финального цикла один ранний unit-прогон завершился timeout
`bootstrap.test.mjs` на 120 000 ms; изолированный файл прошёл за 98 840 ms, а
последующие полные unit-прогоны с неизменной policy завершились PASS. Риск
малого timeout headroom сохранён как наблюдение, но финальная стабильная matrix
прошла полностью.

Финальные gates: `openspec validate --changes --strict` — 2/2 changes pass;
`openspec validate --specs --strict` — 5/5 specs pass (только существующие INFO
о длине requirements); semantic gate — pass для 7 changes; `git diff --check` —
exit code 0 без вывода. Baseline violation и новый requirement owner не
появились.

Повторный verify исправил argv assertion: targeted contract-test сравнивает
полный child argv, включая порядок, reporters, coverage flags и manifest.
После этого финальная matrix снова прошла на literally equal digest
`32cc7c642b26d0f05f0795d45e1c9745661afc53326212cbf7f8d4e1c9577955`:
`unit` PASS 88 272 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T09-21-04-267Z-unit-ce9f7822-8548-49e3-8d5e-34dffc595fc5`),
`coverage` PASS 103 810 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T09-22-32-585Z-coverage-e9c5b41e-12cd-45c9-b334-3485362bd68f`),
`release` PASS 7 054 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T09-24-16-443Z-release-e369a92b-c677-445e-add5-9b0bf40fbec6`).
Coverage: 335/335, lines 99,8334%, branches 95,0911%, functions 98,9717%,
manifest 11/11 и diagnostics пусты.
