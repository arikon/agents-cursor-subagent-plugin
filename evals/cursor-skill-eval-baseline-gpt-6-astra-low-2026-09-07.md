# Приёмочный baseline gpt-6-astra / low — 2026-09-07

**Приёмка пройдена: 78/78, все три serial runs успешны.**
Отдельная диагностика также прошла: 26/26. Concurrency — 12; каждый сценарий
в каждом run имеет ровно одну попытку, без скрытых повторов.

| Прогон | Успешно | Behavior mismatch | Integration failure | Время |
| --- | ---: | ---: | ---: | ---: |
| Diagnostic | 26/26 | 0 | 0 | 229 653 ms |
| Acceptance 1 | 26/26 | 0 | 0 | 222 240 ms |
| Acceptance 2 | 26/26 | 0 | 0 | 222 630 ms |
| Acceptance 3 | 26/26 | 0 | 0 | 230 316 ms |
| Acceptance total | 78/78 | 0 | 0 | 675 187 ms |

Candidate: `bb0cccadadf7bb404a254cf5addee64f6f691b2cbc10e18ec3dc302b4b01d0a7`.
Corpus, skill, evaluator, adapter, package payload и client совпадают между
diagnostic и всеми тремя приёмочными runs; initial/final digests стабильны.
Установленный Codex 0.153.4 подтвердил поддержку точной модели и effort через
`model/list`, а manifests подтверждают фактический запуск `gpt-6-astra`.

Проверены все 730 индексированных артефактов, точный набор из 26 сценариев в
каждом run, supervisor exit 0, полные final captures, отсутствие потери
transcript, публикация evidence и успешный cleanup.

- [JSON baseline с хешированными ссылками](cursor-skill-eval-baseline-gpt-6-astra-low-2026-09-07.json)
- [Полный результат приёмки](evidence/astra-low-acceptance-2026-09-07/acceptance/low.json)
- [Проверка целостности evidence](evidence/astra-low-acceptance-2026-09-07/verification.json)
- [План матрицы: восемь конфигураций](cursor-skill-eval-matrix.plan.v1.json)

Baseline относится к механике, evidence, восстановлению после ошибок и точной
доставке данных в зафиксированном corpus. Истинность свободного prose,
`reported_task_outcome`, `outcome_report` и `safety_disclosure` — `not_checked`.
Это отдельная приёмка на 26 сценариях; исторические сравнительные строки на
24 сценариях сохранены без изменения.
