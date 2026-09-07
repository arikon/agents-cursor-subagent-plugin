## 1. Bootstrap и managed lifecycle

- [x] 1.1 Implement portable MCP configuration, topology and hash domains from requirements «Переносимая настройка MCP», «Bootstrap paths and publication topology» and «Managed marketplace lifecycle»; test malformed invocation versus semantic topology precheck, containment of persisted and bootstrap executables, foreign registrations, golden hash vectors and recursive canonical JSON object sorting with preserved arrays.
- [x] 1.2 Implement install/update/uninstall state matrix, compensation and recovery classification from «Managed marketplace lifecycle» and «Внешний контракт bootstrap»; fault-inject every backup-cleanup deletion boundary, including immediately before and after marker removal.
- [x] 1.3 Implement read-only preflight and its check result schema from «Предflight готовности окружения»; test malformed invocation (exit 2) separately from a valid absolute missing/non-executable dependency (`not_ready`, exit 1), and use a command spy to prove no mutation command.
- [x] 1.4 Add version-specific Codex adapter golden fixtures for admitted marketplace/plugin discovery, help, successful add/remove, and nonzero/partial, mutator-timeout and output-cap-overflow outcomes followed by bounded list reread and compensation of the observed delta; unknown adapter versions fail admission before mutation.

## 2. Release evidence

- [x] 2.1 Reuse the runtime-owned fake ACP executable/fixtures and implement package discovery plus the credential-gated one-canary E2E from «Проверяемая чистая установка», consuming only runtime normalized context.
- [x] 2.2 Update README and run `node --test tests/*.test.mjs`, requirement «Согласованная версия поставки» manifest/version checks, bootstrap tests and the credential-gated gate.
