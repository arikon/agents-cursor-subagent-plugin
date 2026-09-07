## 1. Изолированный Codex eval harness

- [x] 1.1 Подтвердить version-specific adapter/golden fixture для persistent multi-turn Codex surface и exact skill-load evidence; при отсутствии admission классифицировать implementation blocker как `external_adapter_drift`, а eval run — как `integration_failure`.
- [x] 1.2 Реализовать «Разделённые eval lanes и evidence загрузки skill» credential-free client-integration lane через package-owned bootstrap/adapter/discovery helper; проверить, что isolated state не читает пользовательский Codex state и не создаёт второй installation/configuration path.
- [x] 1.3 Реализовать recording MCP proxy и bounded persistent evidence вне fixture root; проверить atomарную публикацию transcript, skill-load evidence, machine-readable final contract и fixture assertion при cleanup.

## 2. Сценарии поведения skill

- [x] 2.1 Реализовать «Сценарный контракт поведения и authority-aware interaction» для `client-happy`; проверить его facade reference, package discovery, skill-load evidence и expected client-integration claim.
- [x] 2.2 Реализовать `model-question` и `model-plan` из Scenario Matrix; проверить required follow-ups, opaque IDs и отсутствие answer observations до них согласно «Skill workflow делегирования».
- [x] 2.3 Реализовать `model-permission-covered` и `model-permission-expansion`; проверить prior-authority binding, отсутствие лишнего follow-up в covered case и обязательную эскалацию при scope expansion.
- [x] 2.4 Реализовать `model-semantic-failure`; проверить, что failed actual task outcome и честный Codex-reported outcome дают `pass`, а ложный success даёт `agent_behavior_mismatch`.

## 3. Outcome, CI и проверка контракта

- [x] 3.1 Реализовать «Outcome model и диагностические доказательства» с precedence `skipped → integration_failure → agent_behavior_mismatch → pass`; проверить collision cleanup/evidence failure и behavior mismatch.
- [x] 3.2 Добавить lifecycle tests Codex runner: spawn error, timeout, aggregate output cap, graceful stop, TERM→KILL и hung-close; проверить, что эти ошибки классифицируются как `integration_failure`.
- [x] 3.3 Подключить provisioned credential-free lane к Node test suite с explicit admitted Codex executable; проверить полный набор через `node --test` без Cursor credentials.
- [x] 3.4 Добавить `live-marker` как opt-in lane; проверить `skipped` в выключенном состоянии и `integration_failure` при cleanup failure.
- [x] 3.5 Добавить negative fixtures semantic gate для отсутствующего modified delta, orphaned authority rule, неполного EvalResultV1, unconditional transcript, `external_adapter_drift` в `eval_status`, неполной matrix и неточных owner references; затем выполнить `openspec validate --strict` и expanded `node scripts/check-openspec-semantics.mjs`, подтвердить coverage этого change и провести independent critic review.
