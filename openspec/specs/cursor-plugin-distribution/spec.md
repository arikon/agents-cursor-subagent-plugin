# cursor-plugin-distribution Specification

## Purpose
Определяет воспроизводимую установку, проверку окружения и выпуск Cursor ACP-
плагина без машинно-специфичных путей в поставляемом контракте.

## Requirements

### Requirement: Переносимая настройка MCP
Плагин SHALL предоставлять bootstrap, который различает `source_root`, managed
`install_root`, `node_executable` и explicit `allowed_workspace_roots`.
Он копирует payload через staging; managed lifecycle и ownership определяются
следующим требованием. Затем использует admitted Codex adapter
для local-plugin registration. Config MUST запускать server из install root; source
checkout MUST не требоваться после установки.

#### Scenario: Переносимый запуск
- **WHEN** bootstrap завершил managed install
- **THEN** MCP config запускает server из managed plugin root, а не из source checkout

### Requirement: Managed marketplace lifecycle
Bootstrap SHALL publish the whole `managed_marketplace_root` as one artifact:
`M`, `M.agents-cursor-subagent-plugin.staging`, and
`M.agents-cursor-subagent-plugin.backup`. A complete prepared or published owned
root contains marketplace metadata, plugin tree and one atomically replaced marker
`.agents-cursor-subagent-plugin.install.json`. The marker moves with the root on
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

### Requirement: Bootstrap paths and publication topology
`scripts/cursor-subagent-bootstrap.mjs` is the only CLI entrypoint. `source_root`
and each allowed workspace root MUST be existing canonical directories;
`node_executable` and `agent_executable` MUST be canonical absolute regular
executables; managed marketplace root MUST be an absolute normalized path with
an existing canonical parent. Source root and managed root must be path-component
disjoint. The derived install root is
`<managed-root>/plugins/agents-cursor-subagent-plugin`; staging and backup are the
deterministic siblings `<managed-root>.agents-cursor-subagent-plugin.staging` and
`<managed-root>.agents-cursor-subagent-plugin.backup` in the managed-root parent. Their
publish/restore use rename only within this parent filesystem. `source_root` and
each allowed workspace root MUST be component-disjoint from `M`, staging and backup;
source and allowed roots may equal/overlap each other, and executable files are not
protected directory roots. The realpaths of `node_executable` and
`agent_executable` and `codex_executable` MUST be outside `source_root`, `M`,
staging and backup; `codex_executable` is bootstrap-only and is not persisted by
installed MCP configuration. Symlink/non-regular executable or missing managed-root
parent fails before mutation.

Generated MCP configuration artifact is an admitted adapter configuration rooted only in the
canonical installed payload, canonical Node, canonical Agent and canonical
allowed roots. Every artifact marker
is JSON with `{format:1,operation,payload_hash,artifact_hash,
manifest_version,marketplace_id,plugin_id,agent_executable}`; hashes are lowercase
SHA-256. The marker is atomically replaced at publication/commit and is excluded
from `artifact_hash`.

#### Scenario: Invalid topology
- **WHEN** a directory path is malformed or non-absolute
- **THEN** bootstrap returns invalid invocation, exit 2 before writing or invoking Codex mutation commands

#### Scenario: Семантически недопустимая topology
- **WHEN** a syntactically valid path has no required canonical parent, a source/workspace root overlaps M/staging/backup, or an executable realpath is inside source/M/staging/backup
- **THEN** preflight returns `not_ready`, exit 1; a mutator returns precheck failure, exit 1 before mutation

#### Scenario: Недоступная зависимость по корректному пути
- **WHEN** a required executable argument is syntactically valid and absolute, but its target is missing, non-regular or non-executable
- **THEN** the corresponding preflight check is `fail`, only dependent checks are `not_checked`, and preflight returns `state=not_ready`, exit 1 without mutation

#### Scenario: Отсутствующий Node runtime
- **WHEN** bootstrap не находит совместимый Node.js
- **THEN** он завершается с понятной диагностикой и не записывает частичную конфигурацию

### Requirement: Предflight готовности окружения
Плагин SHALL предоставлять read-only проверку Node.js, Cursor Agent, доступа к
команде `agent` и managed MCP-конфигурации. Проверка MUST ограничивать timeout
subprocess и различать exit-code и JSON error. Результат MUST быть машиночитаемым и
различать ready, missing dependency и `auth_state` из `authenticated`, `required`
или `unknown`.

Node.js MUST быть версии 18 или новее. Preflight выполняет только
`version`, `status`, `list`, `help` либо эквивалентную read-only introspection;
наличие `add/remove` проверяется через help/introspection, а исполняются они
только install/update/uninstall.

Preflight emits all eight checks exactly once: `node`, `codex_cli`, `managed_root`,
`marketplace_registration`, `plugin_registration`, `mcp_config`, `agent_executable`,
`agent_status`. Each is `{name,status,code,message}`, status exactly
`pass|fail|not_checked`, code/message bounded. `marketplace_registration` and
`plugin_registration` depend on `codex_cli`; `mcp_config` depends on `managed_root`;
`agent_status` depends on `agent_executable`; the other checks are independent. A
failed prerequisite makes only its dependents `not_checked`. `codex_cli` performs
adapter admission before any bootstrap mutation; an unknown adapter version or
incompatible read-only shape makes it fail and its registration dependents
`not_checked`. Exact argv, version and JSON fields are fixture-local.
All eight checks are required for ready. `agent_status` interprets only successful
fixture-local authentication response as `authenticated`, `required` or `unknown`.
Every child command has package-owned timeout 10 000 ms.
Its envelope is exactly `{ok,operation:"preflight",state,auth_state,checks,error_code:null|string,message:null|string}`.
Node compatibility and agent authentication are interpreted only through their
admitted version-specific fixtures; the normalized outcomes are `authenticated`,
`required` and `unknown`.

#### Scenario: Cursor не авторизован
- **WHEN** Cursor Agent доступен, но аутентификация не завершена
- **THEN** предflight возвращает `auth_state=required` только при подтверждённом сигнале; иначе возвращает `unknown` и требует live E2E для подтверждения

### Requirement: Внешний контракт bootstrap
Поставка SHALL предоставить один bootstrap CLI с subcommands
`install|update|uninstall|preflight`. `install` и `update` MUST требовать
`--source-root`, `--managed-marketplace-root`, `--node-executable`, `--codex-executable` и
`--agent-executable` и минимум один повторяемый `--allowed-workspace-root <absolute-path>`;
`uninstall` MUST требовать `--managed-marketplace-root` и `--codex-executable`;
`preflight` MUST принимать managed root, `--node-executable`, `--codex-executable`
and optional
`--agent-executable`; отсутствие даёт deterministic not-ready без PATH/home fallback. Every
path value MUST be syntactically absolute; a missing required option or a
malformed/non-absolute value is invalid invocation. After parsing, a missing,
non-regular or non-executable target is its corresponding preflight failure: only
its dependents are `not_checked`, `preflight` returns `not_ready`/exit 1, and a
mutator fails its precheck with exit 1 before mutation. `install_root` MUST быть
производным от managed root.
`state` MUST быть ровно одним из `installed|absent|ready|not_ready|failed|recovery_required|cleanup_required`.
Каждый вызов MUST вернуть один JSON envelope с `ok`, `operation`, `state` и при
ошибке bounded `error_code`/`message`; exit 0 означает success/ready, 1 —
operational failure/not-ready, 2 — invalid invocation.
Recovery envelope MUST включать nullable canonical absolute `backup_path`,
`staging_path`; `backup_path` обязателен при `cleanup_required`.
`--codex-executable` is required for every Codex-touching subcommand and MUST be
canonical absolute regular executable. Adapter admission MUST succeed before every
mutation; its exact argv, version and JSON fields belong only to its golden fixture.
Package capture has one 1 048 576 UTF-8-byte cap for stdout/stderr JSON and
diagnostic text. Overflow of read-only admission/list is `output_limit` before
mutation; overflow or timeout of a mutator is an unknown command outcome followed
by bounded list reread and compensation of the observed delta. Each exit-0 stdout
contains exactly one bounded JSON value; every mutation is followed by its
corresponding list and ownership is derived only from that output.

| Initial state | install | update | uninstall |
|---|---|---|---|
| absent | install | `failed` | no-op `absent` |
| owned identical | no-op `installed` | no-op `installed` | uninstall |
| owned different | `failed` (use update) | update | uninstall |
| recovery artifact | `recovery_required`, no mutation | same | same |
| cleanup backup | `cleanup_required`, no mutation | same | same |
| foreign/drift/partial | `failed`, no mutation | same | same |

For `cleanup backup`, every later invocation returns `cleanup_required` without
mutation and gives the deterministic manual-cleanup path.

| Исход | `ok` / `state` / exit |
|---|---|
| install/update success или no-op | true / `installed` / 0 |
| uninstall success или no-op | true / `absent` / 0 |
| preflight ready | true / `ready` / 0 |
| preflight not ready | false / `not_ready` / 1 |
| precheck или operation failure с успешной компенсацией | false / `failed` / 1 |
| незавершённая компенсация | false / `recovery_required` / 1 |
| post-commit cleanup failure | false / `cleanup_required` / 1 |
| invalid invocation | false / `failed` / 2 |

#### Scenario: Некорректный вызов bootstrap
- **WHEN** обязательный аргумент subcommand отсутствует или значение malformed
- **THEN** CLI не меняет файловую или Codex state, возвращает JSON error и exit 2

### Requirement: Согласованная версия поставки
Версия manifest SHALL быть единственным источником версии MCP server.
Release-проверка MUST отклонять рассогласованные наблюдаемые версии.

#### Scenario: Несовпадающие версии
- **WHEN** manifest и server объявляют разные версии
- **THEN** release-проверка завершается ошибкой до публикации плагина

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
