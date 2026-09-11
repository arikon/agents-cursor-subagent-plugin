## Planning verdict

2026-09-10: независимый critic — OKAY, baseline_violation не обнаружены. Независимый architect подтвердил owners, минимальность, отсутствие новых требований и все классификации ниже. План готов к реализации; это не утверждение об экономии или прохождении будущего hosted acceptance.

## Findings

| Finding | Classification | Resolution |
|---|---|---|
| Первый provider request существующего fixture принадлежит warmup | implementation_concern | Design уточняет первый evaluated request для основной метрики, раздельный warmup и общий объём; task 1.4 |
| Pure measurement проверки не должны зависеть от real-Codex opt-in | implementation_concern | Design/tasks 1.2 оставляют pure checks на deterministic component уровне; integration владеет загрузкой/transport |
| Временное provider evidence удаляется при fixture cleanup | implementation_concern | Design/task 1.4 требуют экспорт safe aggregates и digests до cleanup |

Reference-only запись semantic registry и добавление reference labels в индекс archived facade owner признаны минимальными planning metadata: нормативный текст не меняется. Повторного lifecycle, registry сессий, measurement framework или новых dependencies нет.

## Verification

- `openspec validate compact-cursor-subagent-skill --strict`: pass; specs пропущены явно и обоснованно.
- `node scripts/check-openspec-semantics.mjs`: pass, 16 changes.
- `node scripts/run-node-tests.mjs unit --test tests/check-openspec-semantics.test.mjs`: pass, итоговый TAP 110 tests / 110 pass / 0 fail / 0 skipped, exit 0.
- `git diff --check`: pass.
- Эти planning-проверки предшествовали реализации; актуальные результаты приведены ниже.


## Implementation review (V2)

Независимый reviewer одобрил структуру skill и измерителя; после ремонта no-knobs доказанной новой потери operator instructions не найдено. Transitive import/read/spawn paths сверены с EVALUATOR_INPUTS: новый measurement helper включён, генерируемый launcher использует уже учтённый fake-acp; installed payload сохраняет отдельного package evidence owner. Signal-тест проверяет различные single/repeated termination paths и публикует readiness после установки обработчика.

| Finding | Classification | Resolution |
|---|---|---|
| «need no knobs» допускает неверное понимание default/auto | baseline_violation | Восстановлено явное omission effort/fast/optimize_for; focused hosted PASS, V2 diagnostic 27/27 PASS |
| Raw coverage выявил два неисполненных proxy fallback counters | implementation_concern | Существующий signal-тест дополнен single-signal cases, устранена readiness race; оба counters покрыты, полный unit 801/801 PASS |
| V2 initial-provider-failure и result-overflow не сообщают обязательное новое решение в final | implementation_concern | Исходные инструкции сохранены; semantic-report deviations сохранены в hosted review, aggregate oracle их не проверяет |
| V2 mode-protocol-recovery выдумывает необходимость нового решения для live-idle | implementation_concern | Исходная условная инструкция сохранена; это observed semantic-report deviation, не доказанная regression сокращения |
| Existing finalizer требует исторические task anchors 5.8–5.11 | implementation_concern | Архитектор подтвердил применимость main-spec closeout; фиктивные anchors запрещены, ручной отчёт не подменяет нормативную публикацию |

Raw coverage: evidence/coverage-audit-final/zero-counter-audit.json, 33 counters classified, 0 unclassified. Полные unit/release terminal artifacts сохранены в evidence/verification. Request measurement — evidence/measurement.md: 38,94% экономии фактических UTF-8 skill bytes, одинаковые requests/occurrences/tools bytes. Это не token/billing или hosted behavioral metric.

Семантическое acceptance и нормативный closeout пока не заявлены; текущие task checkboxes отражают эту границу.


## Acceptance repairs V3 — 2026-09-10

После явного пользовательского поручения «Внеси правки и добей Acceptance» baseline обновлён только для ранее предложенного --task-ids. Architect подтвердил authorized new_scope; oracle boundary остаётся implementation_concern, operator wording — минимальное прояснение существующего workflow.

Независимые static reviewer и architect не нашли material defects: один task-ID resolver/существующее completed_tasks, legacy default, tasks-last recovery; oracle использует существующий follow-up/index без второго policy owner; skill разделяет оба permission decisions, удерживает declared-stage wrapper и имеет один final-disclosure block. Два editorial замечания исправлены (индекс соответствующих owners и terminal scope canonical sentence).

Focused oracle14/14, finalizer16/16, полный unit804/804, coverage804/804, release14pass+1intentional skip. V3 raw audit33classified/0unclassified. Measurement-V3:35,33% экономии. Node syntax и diff checks PASS. Стандартный skill quick_validate.py не запустился из-за отсутствующего PyYaml в обоих доступных Python; package release подтвердил точный установленный payload, real-Codex client-integration — загрузку skill; простой frontmatter name/description отдельно прочитан вручную. LSP Transport closed не выдаётся за typecheck.

Новых transitive dependencies нет: oracle уже входит в EVALUATOR_INPUTS; finalizer отдельно связан coverage source digest. Все17 coverage sources проверены до V3 freeze. Новая diagnostic27/27PASS; semantic review и serial acceptance фиксируются отдельно.

## V4/V5 acceptance refinement

V4 high automatic/manual 81/81; medium automatic 81/81 but manual review found omitted new-decision disclosure in two overflow finals. V4 therefore remains rejected; all evidence retained in hosted/semantic-report-review-v4.md.

V5 minimally separates unavailable-page incompleteness from failed `terminal_result_limit` and references the existing failed branch. Independent architect classifies this as `implementation_concern`, with no duplicate recovery rule or runtime change. Focused hosted overflow and semantic review pass. Fresh request measurement: 33.6652% reduction, three bound PASS runs; release passes. All 17 coverage sources match V3 byte-for-byte, and all 40 evaluator entries match the frozen V5 manifest. Architect reviewed changed import/read/spawn paths and separate package/coverage evidence owners; no missing transitive input or new architectural blocker found. Final series acceptance is recorded separately.

## Safe prompt mismatch diagnostics

V7 preflight rejects one of twelve cases before a full matrix. The actual action and report pass, but required fragment 0 does not match; hash-only evidence cannot explain why. Architect classifies a minimal fixture-only diagnostic extension as `implementation_concern`. Existing case-folded substring `matched` and forbidden checks remain unchanged. Missing-fragment events add only lexical boolean/index hints; no prompt, actual text, token strings or paths are persisted. Formatting normalization can erase meaningful exact-content differences, and token presence cannot prove order; neither is acceptance evidence. Existing integration projection already preserves the diagnostic event; fake-acp remains in the single EVALUATOR_INPUTS with no new dependency.

The existing real-process test owner was extended with seven diagnostic/privacy cases, preserving earlier assertions. Focused supervisor PASS 1/1, 866ms. Full deterministic/coverage/package verification is reopened because fixture/test inputs changed; old results remain historical. No new operator wording is justified until the bounded diagnostic reproduction supplies evidence.

## V8 verification follow-up

V8 passes the twelve-case authority preflight and independent semantic review; measurement retains 31.9653% reduction. Full unit/coverage pass, but the raw coverage audit identifies one additional meaningful zero counter: runEval's capture_incomplete classification. Existing tests check the scenario oracle and parser, not this final runner outcome. A pure regression at the existing component owner is required before closing the audit; product logic and hosted inputs are unchanged. This preserves the distinction between an aggregate coverage pass and examined behavioral coverage.

V8 regression completed: final unit805/805 and coverage805/805 pass. Raw audit coverage-audit-v8-final publishes33 classified counters,0unclassified,17/17 verified source hashes; capture_incomplete is now exercised. Lines99.9233%,branches99.5039%,functions100%. Final artifacts are verification-v8-final/unit and coverage; unchanged release/measurement bindings remain verification-v8/release and measurement-comparison-v8.json. A skill-only wording edit does not justify another full unit/coverage cycle: rerun dependent checks only, preserving unaffected evidence. The intermediate full repeat after V8 wording alone was unnecessary; later full runs were required by the added regression test. Frozen hosted V8 starts only after these gates and preflight12/12 pass.

## V10 bounded stopping point

V8 high completes81/81 but medium79/81 plus a manual caller-close omission rejects that candidate. V9 and V10 introduce architect-approved local instruction repairs for inline delta/prompt assembly and allocation response routing. Their complete focused gates remain rejected: V9 one and V10 two material allocation cleanup/report failures out of twelve despite automatic12/12. All six V10 critic trials pass. Independent architect review finds no remaining structural ambiguity or evidence-backed minimal repair; retain V10 without claiming accepted behavior. Additional speculative prose, unchanged-candidate retries and weakened baseline are not justified. V10 measurement30.011121114229734% reduction and package release pass. No runtime/test/non-skill evaluator inputs changed after final V8 deterministic verification, so unaffected verdicts are retained; the changed skill alone changes the evaluator digest. Full V10 diagnostic/baseline and success finalizer are not run. Tasks3.4/3.5 stay open; current evidence/acceptance.md records this model-instruction-following blocker and separates historical versions.

## A/B and extra-close baseline update

User-authorized diagnostic A/B (`model-initial-provider-failure`, 3× high/medium, original vs V10) did not prove a compaction regression: 12/12 automatic, 0 retry/resume, original close 6/6, candidate 5/6, new-decision report 12/12 in this sample. Frozen baseline now drops extra caller close after an init/spawn tombstone without `turn_id`; runtime already owns that terminalization. No-retry stays an `expected_trace` behavior check. New-decision stays a user-report requirement; `outcome_report` remains `not_checked` because `REPORT_CATEGORIES` is only `interaction`. Expanding that evaluator surface is outside this baseline.

V11 request-level measurement is 13191 bytes, 30.14% reduction, three bound client-happy PASS. Focused allocation 6/6 automatic with 0 retry; one medium trial omitted new-decision (review note). Diagnostic high is 26/27: `model-active-followup` double-delegate, unrelated to allocation close. Serial high/medium was not started. Tasks 3.4/3.5 stay open.
