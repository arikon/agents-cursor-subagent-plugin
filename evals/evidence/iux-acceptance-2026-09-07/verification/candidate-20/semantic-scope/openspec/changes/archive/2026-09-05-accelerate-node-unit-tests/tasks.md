## 1. Pre-change evidence

- [x] 1.1 До test-source правок на закреплённом Node 22 и неизменившемся tree
  собрать три foreground unit timings, сохранить artifact paths и вычислить
  median/range из `duration_ms` каждого атомарного `result.json`; каждый
  `node scripts/run-node-tests.mjs unit` завершает terminal pass.

## 2. Reference-only admission

- [x] 2.1 Добавить `accelerate-node-unit-tests` в semantic registry как
  reference-only change с owner-ссылкой `NTS-3` → «Lane selection и coverage scope»;
  проверить `node scripts/check-openspec-semantics.mjs` после полного набора artefacts.
- [x] 2.2 Запустить existing semantic-gate fixture tests и подтвердить, что
  reference-only admission, capability-delta rejection и owner traceability
  остаются покрыты: `node --test tests/check-openspec-semantics.test.mjs`.

## 3. Timeout fixture and acceptance evidence

- [x] 3.1 В «mutator timeout compensates…» передать existing test-only
  `runCommand` override с initial `timeoutMs: 1_000`, не меняя fixture
  environment, recovery assertions или product source; проверить targeted
  scenario командой `node --test --test-name-pattern='mutator timeout compensates' tests/bootstrap.test.mjs`.
- [x] 3.2 Повторить targeted команду из 3.1 25 раз последовательно; каждый run
  завершается pass, а assertions подтверждают observed partial mutation и
  compensation. При первом failure увеличить только test timeout либо
  откатить override, не меняя bootstrap/runtime product source; после каждого
  изменения timeout начать 25-run серию заново.
- [x] 3.3 На той же host/Node 22 конфигурации собрать три foreground unit
  timings, извлечь `duration_ms` из каждого `result.json` и сравнить median и
  range с 1.1; принять override только если median уменьшается минимум на 6 s
  и ниже всего pre-change range, иначе откатить override и зафиксировать
  результат как future candidate.
- [x] 3.4 Выполнить `node scripts/run-node-tests.mjs coverage`, сначала
  прочитать его `result.json`, затем последнее `test:coverage` в
  `failures.jsonl`; проверить complete manifest и классифицировать все
  zero-count lines, branches и functions по project policy.
- [x] 3.5 Выполнить `openspec validate accelerate-node-unit-tests --type change --strict --no-interactive`,
  `node scripts/check-openspec-semantics.mjs` и `git diff --check`; записать
  terminal verdicts и evidence paths в change artifacts. Перед acceptance
  проверить changed-file inventory: разрешены только OpenSpec artifacts,
  `tests/bootstrap.test.mjs`, semantic registry и его tests; diff для
  `scripts/cursor-subagent-bootstrap.mjs` и `scripts/run-node-tests.mjs`
  пуст, а lane policy не меняется.

## Verification evidence

Node `v22.23.1`; все timings взяты из `duration_ms` атомарных `result.json`.
Baseline unit runs: 113 776 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T13-31-11-421Z-unit-ea4b9784-647c-4989-97dc-f54edce3aa03`),
116 126 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T13-33-08-892Z-unit-a69f5b6d-efff-4deb-ba50-08ee07533712`)
и 90 967 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T13-35-10-102Z-unit-18bedec1-f99a-412e-94ac-562a51fe7854`): median 113 776 ms, range 90 967–116 126 ms.

После override `timeoutMs: 1_000` targeted scenario прошёл за 1 843 ms, а
25 последовательных targeted runs прошли без изменения timeout. Post-change
unit runs: 81 885 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T13-39-15-068Z-unit-b92752b0-b252-4910-bd5d-115fbe468a2a`),
81 567 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T13-40-41-795Z-unit-b5ac9903-e282-4e7a-b761-167d6b3a02e5`)
и 82 934 ms
(`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T13-42-06-982Z-unit-533d693b-037d-41ec-9b2b-069e078bea23`): median 81 885 ms, improvement 31 891 ms; acceptance performance gate пройден.

Coverage: PASS, 348/348, 96 527 ms;
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-05T13-43-43-451Z-coverage-6ba1ed90-a7c1-4998-8838-acccec395bf9`.
Manifest 12/12; lines 99.8638%, branches 94.7097%, functions 99.1131%;
diagnostics пусты. `result.json` прочитан до последнего `test:coverage` event.

Все zero counters из этого event классифицированы. Meaningful foreground CLI
entrypoint guards: `check-openspec-semantics.mjs` lines 390–391/branch 389 и
`run-unit-coverage.mjs` lines 14–15/branch 13; они покрываются отдельными
foreground invocation, а не import-driven coverage. Остальные zero counters
являются уже существовавшими defensive fallback/error branches, не меняющими
наблюдаемого контракта этой test-only правки: `check-openspec-semantics.mjs`
branches 190,69,77,83,86,107,134; `cursor-eval-scenario.mjs` 327;
`cursor-subagent-bootstrap.mjs` 24,44,56,58,68,85,109,131,155,167,186,187,
254,322,323,324,328,333,342,344,358,360,379,386,393,398,399,405,429,438,
474,489,566,665 and functions 169,557,593,654;
`cursor-subagent-mcp.mjs` 22,59,61,116,119,120,121,123,124,128,137,138,153,
158,173,231,233,237,240,247,251,270,300,302,311,319,340,352,354,355,368,
371,375,406,434,437,444,453,494; `recording-mcp-proxy.mjs` 12,103;
`run-cursor-skill-eval.mjs` 51,84,85,95,104,107,145,146,172,173,231,232,
233,236,250,251,252,276; `run-node-tests.mjs` 50,100,173,179,180,182,186,
189,192. New semantic-registry entry is executed by the green semantic gate;
no zero counter is introduced by this change.
