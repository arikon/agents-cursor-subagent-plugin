# cursor-task-delegation Specification

## Purpose
Определяет тонкую Codex facade-операцию над нормативным runtime contract.

## Requirements

### Requirement: Высокоуровневое создание делегирования
`cursor_delegate({prompt,cwd,mode})` MUST call `cursor_start_session` exactly once
and call `cursor_send_prompt` exactly once only after its live result. It relies on these public runtime operations for
validation and allocation. It MUST not allocate a second session, retry
prompt after any dispatch failure, or maintain copied lifecycle metadata.
All validation/allocation semantics are owned by runtime
requirements «Response envelopes и фаза allocation» and «Публичный MCP tool
contract». Facade returns the unchanged runtime result or error. A start rejection
before session allocation remains the runtime error without cleanup; an allocated
init/spawn tombstone returns unchanged. With a live allocated session but prompt
rejection before turn allocation, facade closes once and returns that unchanged
runtime error.

#### Scenario: Ready session receives first prompt
- **WHEN** valid delegation starts
- **THEN** facade allocates one runtime session, sends one prompt and returns the unchanged runtime result

#### Scenario: Start or first prompt fails
- **WHEN** validation, initialization or dispatch fails
- **THEN** it returns the unchanged runtime error or result as applicable and does not create another session or prompt

### Requirement: Workspace discipline делегирования
`ask` and `plan` may use a canonical checkout. `agent` MUST receive an already
isolated worktree from the caller; facade documents this discipline but performs
no VCS inspection or worktree creation. Scope and callback permissions remain
the exclusive runtime owners.

#### Scenario: Пишущая задача
- **WHEN** Codex delegates `agent`
- **THEN** the documented caller contract requires an isolated worktree and facade forwards the supplied path unchanged to runtime validation

### Requirement: Skill workflow делегирования
The installed skill MUST use `cursor_delegate` as its primary start path and
`cursor_wait` for observation; it MUST not poll `cursor_session_status`. Every
answer includes the exact session, turn and request IDs. Protocol completion is
reported without a semantic-success claim. The skill closes every created session
idempotently in `finally`; low-level tools are documented only for advanced
diagnosis/recovery.

Для pending question skill MUST показать нормализованный вопрос и доступные
options и MUST NOT вызвать answer до отдельного user follow-up с выбором,
skip или cancel. Для pending plan skill MUST NOT отправить `accept` до явного
одобрения пользователя и MUST NOT отправить `reject` до явного отклонения или
отмены пользователя. Для permission, точно покрытого текущим поручением,
skill MUST использовать только `allow-once` без повторного подтверждения.
Для permission вне текущих полномочий skill MUST NOT отправлять answer до
явного follow-up; после него разрешены только `allow-once` или `reject-once`.
Расширение scope, destructive/external action или доступ к credentials MUST
NOT выводиться из неявного контекста.

#### Scenario: Интерактивное делегирование
- **WHEN** Cursor creates a pending request or completes a turn
- **THEN** the skill observes it with `cursor_wait`, addresses any answer by full IDs, and closes the session on every terminal path

#### Scenario: Question и plan ожидают явный выбор
- **WHEN** Cursor публикует question или plan
- **THEN** skill показывает нормализованный pending context и не отправляет
  answer до соответствующего explicit user follow-up

#### Scenario: Permission покрыт текущим поручением
- **WHEN** Cursor запрашивает действие, точно покрытое current user authority
- **THEN** skill отвечает только `allow-once` без дополнительного user turn

#### Scenario: Permission расширяет scope
- **WHEN** Cursor запрашивает действие вне current user authority, destructive,
  external или credential action
- **THEN** skill не отвечает до explicit user follow-up и использует только
  `allow-once` либо `reject-once` после него
