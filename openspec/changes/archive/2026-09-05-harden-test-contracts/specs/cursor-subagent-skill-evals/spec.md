## ADDED Requirements

### Requirement: Eval transcript plumbing и process verdict
Eval harness MUST передавать pure scenario oracle фактическую bounded
упорядоченную MCP trace. Trace MUST сохранять порядок вызовов, opaque IDs,
успех/ошибку каждого вызова и факт отброшенных bound-ом вызовов. Harness MUST
NOT реконструировать ожидаемые observations из scenario program. Семантическая
классификация порядка, IDs, effects и close остаётся единственным owner
существующего requirement «Scenario program driver и pure scenario oracle».

Включённый eval с `integration_failure` или
`agent_behavior_mismatch` MUST напечатать один валидный `EvalResultV1` в stdout
и завершиться ненулевым exit code. Только `pass` и явно выключенный `skipped`
MUST завершаться с exit code `0`.

#### Scenario: Transcript передаётся без реконструкции
- **WHEN** harness передаёт trace в pure oracle
- **THEN** trace сохраняет фактически observed порядок, IDs, outcomes и
  dropped-call evidence без program-driven additions

#### Scenario: Включённый eval завершается ошибкой
- **WHEN** включённый eval классифицирован как `integration_failure` или
  `agent_behavior_mismatch`
- **THEN** stdout содержит один `EvalResultV1`, а процесс завершается nonzero

### Requirement: Изолированные и переносимые integration fixtures
Credential-free scripted provider MUST получать endpoint, назначенный ОС для
конкретного fixture, и клиент MUST использовать именно этот endpoint. Fixtures
MUST NOT полагаться на фиксированный общесистемный TCP port или shared mutable
state. Hosted-auth lane MUST принимать credential path через явную
конфигурацию либо portable home-directory resolution; отсутствие credentials
MUST давать ясный preflight result и MUST NOT обращаться к пути конкретного
разработчика.

#### Scenario: Два provider fixtures стартуют параллельно
- **WHEN** два credential-free fixtures запускаются одновременно
- **THEN** каждый использует свой endpoint и завершает без конфликта порта

#### Scenario: App-server использует fixture endpoint
- **WHEN** credential-free fixture запускает app-server на поддерживаемой
  версии Codex
- **THEN** version-specific custom provider направляет model requests к
  полученному loopback endpoint с совместимым wire API и MUST NOT fallback в
  remote OpenAI Responses API

#### Scenario: Hosted credentials отсутствуют
- **WHEN** hosted-auth lane не получил существующий credential path
- **THEN** lane возвращает ясный preflight diagnostic без machine-specific path
