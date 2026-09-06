## Why

Интерактивное read-only ревью через Cursor ACP в реальной сессии потребовало
нескольких перезапусков: caller повторно использовал устаревший event cursor,
пытался ответить на permission с не подтверждённым `request_id` и передал
неподдерживаемый `mode: "review"`. Для выбора Grok пришлось временно менять
глобальную конфигурацию Cursor, хотя установленный CLI поддерживает per-session model selection.
Runtime уже
возвращает нужные snapshots, но контракт не делает продолжение и recovery
достаточно явными для потребителя tool results.

## What Changes

- Дополнить `cursor_wait` явным resume cursor, чтобы следующий wait не
  использовал устаревший `after_event_id` после timeout или события.
- Увеличить bounded lifetime одного turn с 10 минут до часа: длительная
  авторизованная реализация не должна терять work-in-progress из-за
  внутреннего deadline до terminal result.
- На `cursor_wait` timeout возвращать только delta progress digest активного
  turn из уже принятого ACP agent-message stream: компактный bounded excerpt
  и revision лишь после нового progress; без нового progress не повторять
  текст и не читать private Cursor transcript.
- Заменить повторяющий полный `WaitEnvelope` на sparse delta envelope: не
  дублировать session/turn snapshot, model/run-mode и пустые `null`/`[]` поля
  при каждом wait; полный retained snapshot остаётся только у explicit status.
- Распространить ту же экономию на mutation acknowledgements: `delegate`,
  prompt/answer/mode/cancel/close возвращают только продолжение workflow,
  а полный snapshot остаётся у start/resume bootstrap и explicit status.
- Сделать test-supervisor единственным Node test entrypoint и добавить ему
  focused `--test` и `--test-name-pattern` без обхода process/artifact contract.
- Для каждого нового operator-facing MCP/skill happy path добавить Codex
  behavior scenario eval с наблюдаемым tool/effect trace; package E2E отдельно
  доказывает установку байтов и discovery, но не смысл текста через substring.
- Нормализовать ACP JSON-RPC provider errors: сохранять bounded classified
  diagnostic вместо потери `error.code` и смешения provider rejection с
  transport failure, не раскрывая raw `error.data`.
- Не разрешать skill выводить delete authority из Cursor-created temporary
  artifact: returned/observed paths сохраняются и сообщаются
  пользователю, если exact/bounded deletion не была явно разрешена ранее;
  существующее разрешение не требует повторного подтверждения. Сам isolated
  worktree остаётся рекомендацией для write-capable delegation, а не
  обязательной runtime precondition.
- Не делать global Cursor allowlist или unlisted provider controls частью
  продукта; exact current-version exclusions остаются adapter/golden evidence.
- Добавить `plugin_dirs?: string[]` как confirmed per-session delivery surface
  для Cursor Agent Plugins: plugin может содержать both `skills/**/SKILL.md` и
  `mcp.json`. Runtime canonicalizes only local plugin roots and exact-forwards
  repeated `--plugin-dir`; не копирует skills и не принимает unadmitted raw
  provider configuration.
- Сделать подтверждённый ACP interaction surface пригодным не только для
  code-review и coding: явная смена `ask|plan|agent` в live session и compact
  события для admitted version-specific collaboration requests.
  Эти события передают только bounded user-facing metadata; image bytes,
  arbitrary prompt и raw provider payload не становятся MCP contract.
- Увеличить max `cursor_wait.timeout_ms` с 60 секунд до 3 минут; default 30
  секунд и minimum 1 секунда остаются прежними.
- Сделать ошибку answer-tool для неизвестного/stale pending request
  восстанавливаемой через безопасный summary текущего pending состояния без
  раскрытия его context.
- Определить компактный terminal receipt, который caller может вывести до
  idempotent close и использовать для проверки protocol completion.
- `cursor_start_session`, `cursor_delegate` и `cursor_resume_session` принимают
  и exactly forward per-session `model?`, `effort?` и `fast?`; requested model
  по умолчанию — `auto`, но echo не является provider-confirmed resolved model;
  exact CLI encoding остаётся в
  version-specific adapter/golden. Глобальная Cursor-конфигурация
  не изменяется; неподтверждённый CLI contract `auto_optimize_for`
  исключается из v1.
- Добавить явное `cursor_resume_session` для продолжения ранее созданной
  Cursor-сессии по публично возвращённому opaque Cursor session ID, без чтения
  private archive или автоматического fallback на новую сессию.
- Дополнить установленный skill готовыми границами `file review` и
  `snapshot review`, допустимым `mode` и обязательным state handoff между
  wait/answer.
- Возвращать complete normalized pending context непосредственно из
  `cursor_wait`, не вынуждая основной workflow опрашивать diagnostic status.
- Добавить budgeted critic-review workflow: компактный manifest/digest,
  delta-only follow-up и bounded wait backoff без повторной передачи полного
  неизменённого snapshot.
- Сохранять live Cursor session между terminal turns для следующих user
  follow-ups и многоэтапных ревью; закрывать её только при завершении,
  abandonment/cancel, irrecoverable failure либо смене launch-only settings с
  immediate explicit resume по ранее возвращённому provider ID.
- Terminal `cursor_wait` — единственный штатный delivery path result;
  последующие progress envelopes и любой close compact: не повторяют большой
  terminal result, а возвращают только state, IDs и receipt. Полный retained
  snapshot доступен по явному status для диагностики.
- Зафиксировать отсутствие active-turn steering в pinned Cursor ACP: уже
  переданный follow-up ждёт terminality и использует обычный
  `cursor_send_prompt` только после `completed + live`; terminal failure
  требует нового user decision. Несуществующий private wire method не
  добавляется.
- Добавить `cursor_set_mode({session_id,mode})` для явно выбранного перехода
  между Q&A, планированием и agent work в уже живой Cursor conversation. Это
  forwards только admitted adapter mode operation, не создаёт новую session/turn и
  не подменяет permission boundary.
- Публиковать admitted Cursor nonblocking extension requests как compact events
  и делать одну synchronous empty-result response attempt, пока transport
  writable, без гарантии delivery acknowledgement:
  todo-state, completed subagent task и image suggestion. Они дают operator
  progress на длительных сценариях, не требуют answer и не являются
  доказательством semantic completion.

## Capabilities

### New Capabilities

- Нет.

### Modified Capabilities

- `cursor-acp-session-runtime`: уточнить диагностические envelopes ожидания,
  recovery answer-tools, bounded terminal receipt, per-session model и
  explicit Cursor-session resume, mode transition, compact collaboration
  extension requests/progress events.
- `cursor-task-delegation`: уточнить workflow skill для read-only review и
  передачи точных IDs/cursor между интерактивными шагами, а также facade
  forwarding optional model parameters и recovery follow-up после active turn.
- `node-test-supervision`: добавить dedicated eval lane и focused selector,
  сохраняя единый foreground process/report/artifact lifecycle и fail-closed
  результат при нуле выполненных тестов.
- `cursor-subagent-skill-evals`: расширить закрытый corpus и trace grammar
  behavior-сценариями file review, snapshot review и same-session multi-turn
  review, не перенося в eval harness semantics facade или runtime.
- `cursor-plugin-distribution`: сохранить package-owned clean-install canary,
  но запускать его только через owner `node-test-supervision`, без direct
  `node --test` обхода.

## Impact

- `scripts/cursor-subagent-mcp.mjs`, `skills/cursor-subagent/SKILL.md`,
  `evals/cursor-subagent-scenarios.v1.json` и runtime/facade/eval tests.
- Публичные успешные и error MCP envelopes получают additive bounded поля и
  explicit resume; зависимостей, автоматических permission decisions,
  global Cursor-config writes или сетевых вызовов не появляется.
