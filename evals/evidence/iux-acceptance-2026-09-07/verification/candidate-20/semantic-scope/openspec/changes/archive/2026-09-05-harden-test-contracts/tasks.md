## 1. Supervisor artifacts and coverage

- [x] 1.1 Реализовать «Диагностика текущего прогона без console шума»: унифицировать раннюю публикацию `result.json` для preflight и synchronous spawn failure; проверить через injected failure, что `runner_error`, infrastructure stage и текущие refs записаны атомарно.
- [x] 1.2 Реализовать `NTS-3` «Lane selection и coverage scope»: отклонять отсутствующий, нечисловой или нулевой line denominator manifest source и явно классифицировать branch/function zero totals; проверить mixed aggregate, который ранее маскировал исключённый source.
- [x] 1.3 Выполнить compatibility CLI как отдельный foreground process либо удалить wrapper; проверить CLI verdict и устранить только обоснованные raw coverage counters.

## 2. Eval evidence and portable fixtures

- [x] 2.1 Реализовать `EVAL-1` «Eval transcript plumbing и process verdict»: сохранять и передавать oracle фактическую упорядоченную MCP trace с outcome, IDs и dropped-call evidence; добавить regression tests на answer-before-pending, wrong ID, failed/extra call, operation-after-close и overflow.
- [x] 2.2 В составе `EVAL-1` сделать `run-cursor-skill-eval` nonzero для включённых `integration_failure` и `agent_behavior_mismatch`, сохранив единственный `EvalResultV1`; проверить process exit для каждого classifier branch.
- [x] 2.3 Реализовать `EVAL-2` «Изолированные и переносимые integration fixtures»: перевести fake provider на endpoint, назначенный ОС, передавать observed endpoint клиенту и доказать параллельную изоляцию двух fixtures.
- [x] 2.4 Убрать developer-specific hosted credential fallback; проверить явный путь, portable fallback и ясную preflight ошибку без credentials.
- [x] 2.5 Реализовать и проверить version-specific app-server provider adapter для credential-free loopback fixture; зафиксировать custom provider endpoint и wire API без remote fallback.

## 3. Contract verification

- [x] 3.1 Запустить `openspec validate --strict` и project semantic gate; проверить, что proposal, delta specs, design owner map и tasks согласованы.
- [x] 3.2 Запустить foreground `node scripts/run-node-tests.mjs unit`, `node scripts/run-node-tests.mjs coverage` и `node scripts/run-node-tests.mjs release`; прочитать raw coverage и закрыть каждый meaningful residual zero-count counter поведенческим тестом, удалением dead code либо документированной узкой exclusion для genuinely unreachable defensive code.
- [x] 3.3 Провести независимое review и классифицировать каждую находку относительно frozen v1 baseline; закрыть все `baseline_violation` минимальными правками.
