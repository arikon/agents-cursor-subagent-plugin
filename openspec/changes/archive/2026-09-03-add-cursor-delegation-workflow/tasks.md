## 1. Facade

- [x] 1.1 Implement `cursor_delegate` as one start-and-first-prompt composition according to requirement «Высокоуровневое создание делегирования»; fake ACP tests prove one session/one prompt after live start, no pre-turn wait, no retry, idempotent close after live pre-turn rejection and unchanged runtime results/errors.
- [x] 1.2 Update skill/README with requirements «Workspace discipline делегирования» and «Skill workflow делегирования»: use `cursor_delegate → cursor_wait`, full IDs and idempotent `finally` close; link runtime advanced tools.

## 2. Проверка

- [x] 2.1 Run `node --test tests/*.test.mjs` and facade fake-ACP integration; test the skill's `cursor_delegate → cursor_wait` path (no status polling), full IDs in answers, and idempotent `finally` close. Package change owns credential-gated live E2E.
