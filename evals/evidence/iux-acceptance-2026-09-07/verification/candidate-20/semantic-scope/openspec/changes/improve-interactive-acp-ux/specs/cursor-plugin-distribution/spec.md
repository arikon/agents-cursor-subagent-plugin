## MODIFIED Requirements

### Requirement: Managed marketplace lifecycle
Bootstrap SHALL publish the whole `managed_marketplace_root` as one artifact:
`M`, `M.codex-cursor-subagent-plugin.staging`, and
`M.codex-cursor-subagent-plugin.backup`. A complete prepared or published owned
root contains marketplace metadata, plugin tree and one atomically replaced marker
`.codex-cursor-subagent-plugin.install.json`. The marker moves with the root on
rename; cleanup and recovery remnants are classified only by the commit predicate
below. Перед первой мутацией bootstrap собирает complete managed root в staging.
Marker хранит format, IDs, manifest version и разные
SHA-256: `payload_hash` — canonical sorted POSIX paths/bytes allowlist:
`.codex-plugin/plugin.json` (base version без `+codex.*`), `README.md`,
`scripts/cursor-subagent-mcp.mjs`, `scripts/recording-mcp-proxy.mjs`,
`scripts/cursor-subagent-bootstrap.mjs`, `skills/**`; symlink/non-regular
allowlist entry отклоняется, всё вне allowlist не устанавливается и не влияет
на hash. `artifact_hash` — весь managed root `M`, включая marketplace metadata
и installed plugin tree, но без marker. Marketplace metadata and generated MCP
configuration are admitted only through a version-specific Codex adapter
fixture; that fixture owns their exact paths, documents and discovery shape.
Unknown, drifted или foreign state отклоняется до мутаций.
Перед add/remove bootstrap MUST сверить обе live tuples: marketplace ID → exact
canonical managed root и plugin ID → expected marketplace/source. Для fresh
install обе registrations absent; для update/uninstall обе exact. Mixed,
foreign или одна отсутствующая registration отклоняется до mutation.
Оба hash MUST использовать `treeHashV1`: entries сортируются по raw UTF-8 path
bytes, а SHA-256 получает
`u64be(path_byte_length)||path_utf8||u64be(content_byte_length)||content_bytes`;
обе длины — byte counts `uint64` big-endian, Unicode normalization не
применяется. Acceptance vectors belong to the golden test fixture, not this
product contract. For normalized manifest bytes, parse JSON, accept SemVer
without build metadata or with only `+codex.<suffix>` metadata, remove that
suffix to obtain base version and reject any other build metadata before
mutation; then serialize canonical UTF-8 JSON with recursively
lexicographically sorted object keys, preserved array order and no insignificant
whitespace. `payload_hash` domain is allowlisted paths relative to source root;
`artifact_hash` domain is paths relative to managed root excluding the marker.
These are the only two treeHashV1 domains.

Artifact role is derived only from its deterministic path (`M`, `M.staging`,
`M.backup`), not marker state. Same-invocation compensation history is internal;
the persisted marker records only the committed ownership predicate.
Classification is owned by the commit predicate, not artifact shape. With a
proven committed target, a deterministic backup is `cleanup_required` when it
has a valid owner marker regardless of old hash/remaining entries, or when it is
an empty markerless directory after marker-last cleanup. A corrupt marker or
non-empty markerless backup is foreign drift → `failed`. With no backup, the
proven target is `installed|absent`; invalid/unowned artifact, or an active root
that does not satisfy its commit predicate (including an owned marker with a
hash mismatch), is `failed`. `recovery_required` is reserved for a deterministic
owned staging or backup recovery artifact, or an exact registration delta that
proves interrupted compensation; complete absence is `absent`.
At a post-commit cleanup failure bootstrap returns `cleanup_required` and leaves
manual cleanup instructions; every later bootstrap invocation is no-mutation
until the artifact is removed manually. `recovery_required` remains
no-mutation/manual recovery. Commit predicate for install/update is valid
committed active marker, exact hashes and both exact registrations; for
uninstall it is absent active root and registrations. Marker classification
follows the single cleanup predicate above.

Install выполняется строго: precheck → stage complete root → publish root →
register marketplace → register plugin → verify (commit point). Update
выполняется: verify existing marketplace registration points to exact managed
root → validate old ownership → stage new root → unregister old plugin → move
old root to backup → publish new root → register plugin → verify (commit point)
→ post-commit backup cleanup; marketplace при update не перерегистрируется.
Uninstall выполняется: validate ownership → unregister plugin → unregister
marketplace → verify absence → move root to backup (commit point) → post-commit
backup cleanup. The common post-commit backup cleanup deletes contents, removes
the owner marker last, then removes the empty backup directory. До commit при
ошибке bootstrap после каждого successful или failed add/remove перечитывает
lists и компенсирует только observed delta. Успешная компенсация восстанавливает
прежнее состояние; неуспешная сохраняет root, backup и staging, возвращает
`recovery_required` с последним завершённым шагом. Удаление backup — post-commit
cleanup: ошибка в середине удаления не компенсируется, а возвращает `ok=false`,
`state=cleanup_required`, exit 1 и manual-cleanup path. Последующие bootstrap
вызовы не повторяют очистку автоматически.

#### Scenario: Cachebuster update
- **WHEN** `payload_hash` меняется
- **THEN** staged manifest version MUST equal `<base-version>+codex.<payload_hash>` using the full lowercase SHA-256; source checkout is never modified, а старая version отклоняется до мутаций, новая переустанавливается и manifest/plugin list совпадают.

#### Scenario: Стабильный cachebuster
- **WHEN** bootstrap повторяется с тем же normalized payload либо меняется только generated config
- **THEN** manifest cachebuster не меняется; он меняется только при изменении canonical normalized payload

#### Scenario: Ownership drift
- **WHEN** managed root содержит unknown file или hash не совпадает
- **THEN** install/update/uninstall возвращает `state=failed` без удаления и без force override

#### Scenario: Ошибка до commit point
- **WHEN** fault injection завершает install, update или uninstall шаг до соответствующего commit point ошибкой
- **THEN** bootstrap выполняет обратные уже завершённые шаги; при успешной компенсации восстанавливает исходное состояние, иначе сохраняет recovery artifacts и возвращает `recovery_required` с последним завершённым шагом

#### Scenario: Ошибка post-commit cleanup
- **WHEN** fault injection прерывает удаление backup после commit point
- **THEN** bootstrap сохраняет уже установленное или удалённое целевое состояние, не запускает rollback и возвращает `ok=false`, `state=cleanup_required`, exit 1 и backup path

#### Scenario: Установка из нового checkout
- **WHEN** bootstrap получает source root, empty install root, Node и explicit workspace roots
- **THEN** создаётся конфигурация, запускающая MCP server из install root, а delegate может использовать workspace вне дерева plugin

#### Scenario: Исходный checkout исчез после установки
- **WHEN** source checkout переименован или недоступен после install
- **THEN** tools/list и delegate path продолжают работать из install root

### Requirement: Проверяемая чистая установка
Поставка MUST включать credential-free fresh install с injected fake ACP и
credential-gated live E2E на already authenticated host/profile with an
adapter-fixture isolated temporary Codex configuration root, fresh managed
install root and workspace. Fake ACP owns exact runtime wire conformance;
package owns discovery and one facade-level agent canary in a disposable
workspace. Node test process lifecycle is owned by `node-test-supervision`; the
admitted driver is `node scripts/run-node-tests.mjs release`, never a direct
`node --test` invocation.

Before hiding its temporary source copy, the package canary creates a disposable
workspace and derives one canonical `marker_path` inside it. The prompt requests
only create-or-replace of that regular marker with the exact bytes; the adapter
fixture builds its exact command safely. The driver first proves Codex discovery
with the defined marketplace/plugin lists, then reads the adapter-owned generated
MCP configuration artifact, starts its command/args and performs MCP
`initialize` → `notifications/initialized` → `tools/list`, asserting the complete
tool union `runtime tools ∪ {cursor_delegate}`. The canary uses `cursor_delegate`
then `cursor_wait`. If permission is pending, the driver allows once only if
normalized locations are nonempty and every location equals `marker_path`;
absent/other locations or any other pending request are rejected, closed and
reported as `integration_failure`. After the terminal turn the driver itself
verifies the canonical regular marker file and exact UTF-8 bytes
`CURSOR_AGENT_E2E_OK\n`; terminal observation is not evidence of command success.
The adapter fixture supplies a disjoint temporary configuration root without
changing Cursor credentials.

A credential-free fake ACP runs the runtime-owned fixtures and is the hard
deterministic release gate. Live E2E reports exactly `pass`,
`integration_failure`, `agent_behavior_mismatch` or `skipped`: `skipped` applies
only when the opt-in gate is disabled; `pass` requires an otherwise error-free
enabled run, `completed`, successful `finally` close and a canonical regular
marker with exact bytes; `agent_behavior_mismatch` is only `completed` with
successful inspection but an absent, non-regular or mismatched marker; every
other enabled outcome is `integration_failure`, including
bootstrap/discovery/MCP/facade/wait/answer/close, allocated init/spawn tombstone,
unexpected pending and driver/marker-inspection failure. It runs only when
`CURSOR_SUBAGENT_LIVE_E2E=1`; absent variable means skipped and cannot be release
evidence. No hidden retry exists.

#### Scenario: Чистая E2E-проверка
- **WHEN** release job запускается с удовлетворёнными зависимостями на already authenticated host/profile
- **THEN** supervisor запускает package canary с adapter-fixture isolated temporary Codex configuration root, а canary устанавливает payload, скрывает source checkout, доказывает discovery/tool union, выполняет один facade agent flow и независимо проверяет exact marker bytes; discovery или timeout дают `integration_failure`, отсутствие marker после protocol completion — `agent_behavior_mismatch`, finally закрывает созданную session
