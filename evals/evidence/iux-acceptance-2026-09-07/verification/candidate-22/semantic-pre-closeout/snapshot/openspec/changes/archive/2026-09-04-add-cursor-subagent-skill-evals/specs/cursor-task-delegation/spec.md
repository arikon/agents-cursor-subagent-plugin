## MODIFIED Requirements

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
