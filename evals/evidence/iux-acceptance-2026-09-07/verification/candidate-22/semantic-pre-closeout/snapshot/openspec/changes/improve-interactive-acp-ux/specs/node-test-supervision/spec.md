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

Only the `coverage` lane MUST bind its result to the tested product sources.
Before child spawn the supervisor reads every exact manifest source as raw bytes;
after observed child close it rereads the same paths. The coverage result MUST
publish one closed `coverage.sources` product-source proof
`{algorithm:"sha256",digest:{bytes,sha256},stable,files:[{path,bytes,sha256}]}`:
`files` contains every manifest-relative path exactly once in deterministic path
order with its nonnegative safe-integer byte length and lowercase SHA-256;
`digest.sha256` hashes canonical JSON of that ordered files array and
`digest.bytes` is the UTF-8 byte length of that exact JSON. `stable:true` means the after-close snapshot
matches the complete pre-spawn proof byte-for-byte. A read failure at either
boundary, missing/extra path or any byte drift MUST produce `coverage_gate`.
Other lanes do not publish this proof.

`scripts/audit-node-coverage.mjs <coverage-result.json> <output-dir>
[--previous <audit.json>] [--classifications <sidecar.json>]` MUST be the bounded
deterministic CLI for the complete raw zero-counter work queue. It reads the
last `test:coverage` event referenced by a coverage result with lane `coverage`,
`verdict:"passed"`, `terminal_cause:"close_0"`, child code `0`, null signal,
positive executed test count, empty `coverage.diagnostics` and a valid stable
`coverage.sources` proof. The referenced `failures.jsonl` MUST use a relative
artifact path, remain within the result artifact directory, be a regular file
and match its indexed byte length and SHA-256. Coverage owns one closed
`coverage.artifact_digests` with exact keys `failures`, `tap`, `stderr`, each a
`{bytes,sha256}` proof of the corresponding existing sibling artifact; the
auditor verifies these published digests before parsing or copying. The CLI atomically writes
`<output-dir>/zero-counters.json` and
`<output-dir>/zero-counter-audit.json`. It normalizes every zero-count line, branch and
function counter into deterministic path/metric/line order; `occurrence` is the
one-based position among counters with the same path, metric and line, so the
exact counter identity is `{path,metric,line,occurrence}`.

With `--previous`, a classification MAY be reused only when both the exact
counter identity and that source file's SHA-256 are unchanged. The audit MUST
report added, removed and unclassified identities. A classifications sidecar
may classify only current unclassified identities and MUST be rejected when it
contains duplicates, stale source hashes or identities absent from the current
queue. The CLI MUST NOT infer or assign semantic classifications; their meaning
remains owned by `AGENTS.md`. Audit verdict remains failure until the current
queue has no unclassified counter. This is one local artifact workflow, not a
registry or a source snapshot requirement for non-coverage lanes.
Coverage result, previous audit and classifications are explicit CLI inputs and
MAY reside in older sibling directories. Accepted data needed by the published
audit MUST be copied or normalized into the output bundle; its authoritative
references are relative, contained regular files with verified hashes and MUST
NOT retain the original absolute input paths or require a manual pre-copy.

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

#### Scenario: Product source drift invalidates coverage
- **WHEN** a manifest source cannot be read or changes between the pre-spawn
  snapshot and observed child close
- **THEN** coverage returns `coverage_gate` rather than accepting metrics from
  a different source state; when the closed proof can be formed, it records
  `coverage.sources.stable:false`

#### Scenario: Coverage audit reuses only exact classifications
- **WHEN** the audit compares a current raw zero queue with a previous audit and
  an optional classifications sidecar
- **THEN** it reuses only exact source-hash/counter-identity matches, reports
  added/removed/unclassified counters and fails until none remain unclassified
