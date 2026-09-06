## MODIFIED Requirements

### Requirement: Lane selection и coverage scope
Supervisor MUST предоставлять документированные lanes `unit`, `coverage` и
`release`; каждый lane MUST иметь фиксированный список test files, concurrency
policy, individual timeout и deadline. `coverage` MUST измерять только точный
manifest product source scope, а не test files, и MUST публиковать lines,
branches и functions. Отсутствующий, новый незарегистрированный или не
появившийся в per-file report manifest source MUST завершать gate failure.
Coverage gate MUST не позволять снижать зафиксированный minimum baseline
90.00%; manifest-complete clean run MUST иметь не менее 90.00% по каждой
метрике. Повышение baseline требует отдельного change с воспроизводимым
contract evidence. Требования к качеству тестов определяются `AGENTS.md`.

This change additionally admits an `eval` lane with its own fixed test list,
concurrency policy, 420-second individual timeout and 600-second deadline.
`unit`, `coverage` and `release` scrub hosted/real-Codex/live opt-ins; `eval`
preserves only explicitly supplied opt-ins and MAY run only a focused admitted
integration/release test. The eval harness calls this lane instead of spawning
`node --test` or owning another timeout/kill/reporting lifecycle.

`unit`, `release` and `eval` MAY accept one or more lane-admitted canonical
`tests/*.test.mjs` selectors and one nonempty `--test-name-pattern`; the
selected invocation MUST retain the lane's child process group, deadline,
reporter and atomic artifact result and MUST fail when zero tests execute.
`coverage` MUST reject every focused selector both at its CLI boundary and in
exported supervisor invocation.

#### Scenario: Coverage run завершился на minimum baseline или выше
- **WHEN** coverage lane завершает test suite и metrics не ниже 90.00%
- **THEN** supervisor возвращает success и публикует coverage summary

#### Scenario: Coverage run снизил minimum baseline
- **WHEN** lines, branches или functions product source scope ниже
  зафиксированного minimum baseline 90.00%
- **THEN** supervisor возвращает failure с coverage diagnostics

#### Scenario: Release lane не смешивается с unit coverage
- **WHEN** пользователь запускает `release` lane
- **THEN** supervisor выполняет его отдельный тестовый набор и не приписывает
  его результат unit/coverage verdict

Каждый manifest source MUST иметь валидный положительный line denominator в
своём per-file report; агрегированные counters MUST NOT компенсировать
отсутствующий из denominator source. Branch/function denominator с нулевым
значением MUST быть явно классифицирован per-file. Legacy compatibility
entrypoint MUST иметь отдельную foreground verification, если его import-only
guard исключается из unit coverage; импорт exported helper не является
доказательством CLI contract.

#### Scenario: Source исчез из line denominator
- **WHEN** per-file report содержит manifest source с отсутствующим,
  нечисловым или нулевым line denominator
- **THEN** supervisor возвращает coverage gate failure независимо от
  агрегированных metrics

#### Scenario: Compatibility CLI проверен как процесс
- **WHEN** compatibility entrypoint сохраняется в продукте
- **THEN** отдельная foreground проверка подтверждает его CLI contract

#### Scenario: Focused unit test preserves supervisor evidence
- **WHEN** caller starts `unit --test tests/runtime.test.mjs --test-name-pattern "compact wait"`
- **THEN** supervisor forwards the selection and publishes the normal
  process-group, reporter and atomic artifact result

#### Scenario: Hosted eval preserves only explicit opt-in
- **WHEN** eval runner selects its admitted test through `eval` with an explicit
  hosted or real-Codex enable variable
- **THEN** supervisor preserves that opt-in for the child and owns the sole
  timeout, kill, TAP and artifact lifecycle

#### Scenario: Coverage selection is rejected before spawn
- **WHEN** a caller supplies a test selector or name pattern to `coverage`
- **THEN** supervisor returns `invalid_invocation` before spawning a child
