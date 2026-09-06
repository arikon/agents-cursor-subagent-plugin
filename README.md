# Codex Cursor Subagent Plugin

Prototype of a local Codex plugin that launches the installed `agent acp` and exposes it as an interactive subagent through MCP.

The plugin uses the Node.js runtime and Cursor Agent command available in the
environment where Codex runs. The portable managed installation remains a
separate package-canary mechanism; it does not require a source checkout
afterwards.

## Interaction model

`Codex → MCP plugin → Cursor ACP (stdio JSON-RPC)`

By default the plugin launches Cursor with sandboxing enabled and Smart Auto
(`--auto-review`), so Cursor may automatically run tool calls that it classifies
as safe. The repository/Git-marketplace MCP configuration sets Codex-side calls
not to prompt; the portable release canary instead uses the admitted adapter's
default elicitation path. Neither transport setting approves Cursor actions or
expands user authority. The plugin does not use file-based IPC or expose
unlisted raw Cursor CLI controls; exact exclusions remain version-specific
adapter/golden evidence. Agent mode can
create or replace regular UTF-8 files anywhere inside the selected `cwd`; this
is not an exact per-action policy engine or an OS sandbox.
Every write-capable delegation, and every file review narrower than the full
checkout, therefore carries the caller-held bounded authority in its Cursor
prompt as `AUTHORIZED_ACTIONS` plus an exact
`NO_SCOPE_EXPANSION` stop/report clause; this is coordination evidence, not
additional runtime enforcement.
An explicit per-session `model` is a nonempty base-model value without `[` or
`]`; bracketed Cursor parameter syntax is not accepted through this MCP
surface. `effort`, when supplied, is a nonempty `[A-Za-z0-9._-]+` token.
The primary workflow is
`cursor_delegate → cursor_wait`; questions, plans, and approval requests remain
pending until explicitly answered.

## Requirements

- runtime and portable installation: Node.js 18+;
- Cursor Agent (`agent`) installed and authenticated in the file-backed store
  used by the plugin:

  ```sh
  AGENT_CLI_CREDENTIAL_STORE=file agent login
  AGENT_CLI_CREDENTIAL_STORE=file agent status --format json
  ```

  The admitted adapter is pinned to `agent --version` =
  `2026.08.25-3e8eec8`; for a
  non-standard path, set `CURSOR_AGENT_COMMAND` in the MCP server environment;
- Codex with local plugin/MCP support.

The development verification lanes are pinned to Node.js 22.23.1. Run them with
that exact version:

```sh
node scripts/run-node-tests.mjs unit
node scripts/run-node-tests.mjs coverage
node scripts/run-node-tests.mjs release
```

Все команды запускаются в foreground и завершаются одним terminal verdict.
Успешный прогон печатает краткий итог; при любом ином verdict он печатает
диагностику текущего прогона и путь к artifacts. В этом каталоге находятся
`tap.txt`, `stderr.txt`, `failures.jsonl` и атомарно опубликованный `result.json`;
для расследования сначала прочитайте именно этот `result.json`, затем связанные
с ним файлы. `coverage` использует только product manifest, а `release` не
включает hosted/real-Codex opt-ins.

## Installation from GitHub

Install the plugin through a Git marketplace, using the standard Codex CLI
workflow:

```sh
codex plugin marketplace add arikon/codex-cursor-subagent-plugin --ref main
codex plugin add codex-cursor-subagent-plugin@codex-cursor-subagent-plugin
```

The first command registers a GitHub repository as a marketplace; the second
installs the plugin from its marketplace snapshot. Check the configured
marketplaces and installed plugins with:

```sh
codex plugin marketplace list --json
codex plugin list --json
```

Start a new Codex task after installing the plugin so Codex loads its skills
and MCP server. Updating an existing installation requires refreshing the
marketplace snapshot and then explicitly reinstalling the cached plugin:

```sh
codex plugin marketplace upgrade codex-cursor-subagent-plugin
codex plugin remove codex-cursor-subagent-plugin@codex-cursor-subagent-plugin
codex plugin add codex-cursor-subagent-plugin@codex-cursor-subagent-plugin
```

Start a new Codex task only after the final `plugin add` succeeds.

## Installation from Claude Code marketplace

The same GitHub repository is a Claude Code marketplace. It requires `node` and
an authenticated Cursor Agent available as `agent` in `PATH`; set
`CURSOR_AGENT_COMMAND` in the Claude Code environment only when the command has
a non-standard location.

```sh
claude plugin marketplace add arikon/codex-cursor-subagent-plugin
claude plugin install cursor-acp-subagent@codex-cursor-subagent-plugin
```

Refresh the marketplace and installed plugin after a new Git revision, then
restart Claude Code to load the updated MCP server:

```sh
claude plugin marketplace update codex-cursor-subagent-plugin
claude plugin update cursor-acp-subagent@codex-cursor-subagent-plugin
```

Installing the plugin only makes the existing `cursor_*` MCP tools and
`cursor-subagent` skill available. It does not approve Cursor actions: questions,
plans, and out-of-scope, destructive, external, or credential-related permission
requests still require the same explicit authority as in Codex.

## Development usage

After installation, `cursor_delegate`, `cursor_wait`,
`cursor_answer_question`, `cursor_answer_plan`, `cursor_answer_permission`,
`cursor_send_prompt`, `cursor_set_mode`, and `cursor_close_session` form the
primary interactive workflow. `cursor_resume_session` attempts to resume a
provider conversation after a terminal close or idle expiry tombstones a live
wrapper. Provider acceptance of the retained ID does not prove that semantic
history was restored. When the next turn depends on earlier semantic context,
repeat its minimal bounded context and constraints; for critic/review work,
repeat the bounded baseline or snapshot with the new delta, or report the
result as unverifiable. The public runtime exposes no
active-turn steering tool, so an already supplied follow-up waits until the
current turn is terminal and uses `cursor_send_prompt` only after
`turn_status:"completed"` with `session_state:"live"`; other terminal states
require a new post-failure user decision.
`cursor_start_session`, `cursor_session_status`, and `cursor_cancel` are
advanced diagnosis/recovery tools.

Prefer the `cwd` of a separate verified worktree for tasks that may change files
or run concurrently. A canonical checkout is allowed when the user authorized
the changes and accepts the coordination risk. For a read-only task, explicitly
select `ask` and limit file review to the exact or bounded read/search scope the
user authorized; use checkout-wide scope only when it was already granted.
Before changing files, explicitly select `agent`. Keep a live
session across terminal turns with `cursor_send_prompt`, and use
`cursor_set_mode` only between turns. A change to launch-only
`model`/`effort`/`fast`/`plugin_dirs` instead closes the idle wrapper and
immediately calls explicit resume with the retained provider ID. Otherwise,
close when the delegated workflow is finished, abandoned, or irrecoverably
failed.

## Isolated portable installation

`scripts/cursor-subagent-bootstrap.mjs` is the sole entry point for an isolated
managed installation used by the package release canary. It accepts absolute,
canonical paths to the source root, managed marketplace root, Node.js, Codex,
Cursor Agent, and permitted workspace roots. The `preflight` command only
checks readiness; `install`, `update`, and `uninstall` operate through a
version-specific adapter. Run preflight before an actual registration; the live
Codex/Cursor canary is an explicit opt-in and does not replace deterministic
fake-fixture tests.

## Migrating to a new Codex version

The plugin and eval harness deliberately do not treat a new Codex version as
compatible by default. Admission and golden fixtures are currently pinned to
`codex-cli 0.152.1`; a version mismatch stops the managed installation or eval
as `external_adapter_drift` / `integration_failure` rather than producing an
implicit success.

To migrate to version `X.Y.Z`:

1. Obtain the release binary and source at tag `rust-vX.Y.Z`; verify
   `codex --version` using that exact binary.
2. Confirm from source or the actual interface the plugin CLI and JSON schema,
   `skills/list`, persistent `thread/start`/`thread/archive`/`turn/start`,
   explicit skill input, and `mcpServer/elicitation/request`.
3. Update the version-specific layer:
   `tests/fixtures/codex-v01521-adapter.mjs`,
   `tests/fixtures/codex-v01521-adapter.golden.json`, and
   `tests/fixtures/codex-app-server-v01521.golden.json`; rename them for the
   new version. Do not add version-conditional product logic to the MCP runtime
   or skill.
4. Add a negative admission test for the old fixture and run:

   ```sh
   node scripts/run-node-tests.mjs unit --test tests/bootstrap.test.mjs --test tests/codex-app-server-client.test.mjs
   node scripts/run-node-tests.mjs unit --test tests/cursor-skill-eval.test.mjs --test tests/run-cursor-skill-eval.test.mjs
   node scripts/run-node-tests.mjs eval --test tests/codex-client-integration.test.mjs
   openspec validate improve-interactive-acp-ux --strict
   node scripts/check-openspec-semantics.mjs
   CURSOR_EVAL_REAL_CODEX=1 node scripts/run-cursor-skill-eval.mjs client-happy
   ```

5. In a separate temporary `CODEX_HOME`, run the authenticated model lane. The
   default release-acceptance configuration is `gpt-5.6-sol` with `low`
   reasoning effort:

   ```sh
   node scripts/eval/run-cursor-skill-eval-matrix.mjs \
     gpt-5.6-sol low /tmp/cursor-eval-sol-low.json
   ```

   The matrix runs eight isolated scenarios concurrently by default and emits
   `scenario_started`, a `scenario_progress` heartbeat every 30 seconds for
   each active scenario, and `scenario_completed` for each corpus row. Set
   `CURSOR_EVAL_MATRIX_CONCURRENCY=1..16` to tune the pool size. Its atomic JSON
   result contains per-scenario evidence references, attempts, durations,
   verdict counts, pass rate, and before/after skill and corpus digests. An
   integration failure is retried once and both attempts remain visible; an
   agent behavior mismatch is not retried or converted to infrastructure
   failure. Use the same frozen digests for comparative model runs, for example:

   ```sh
   node scripts/eval/run-cursor-skill-eval-matrix.mjs \
     gpt-5.6-terra medium /tmp/cursor-eval-terra-medium.json
   ```

   To run a saved multi-model plan, use the suite runner. It persists one
   atomic result per model/effort row next to the aggregate summary. By
   default it runs three rows concurrently (up to 24 scenario workers); set
   `CURSOR_EVAL_SUITE_CONCURRENCY=1..3` to tune that budget.

   ```sh
   CURSOR_EVAL_HOSTED_CODEX=1 \
     node scripts/eval/run-cursor-skill-eval-suite.mjs \
     evals/cursor-skill-eval-matrix.plan.v1.json \
     /private/tmp/cursor-skill-eval-suite.json
   ```

   The committed [baseline](evals/cursor-skill-eval-matrix-baseline-2026-09-06.json)
   records the first seven-row comparison. It is descriptive, not a release
   threshold: only the `gpt-5.6-sol`/`low` row is the acceptance gate.

   Paired mutation sensitivity is checked separately. The invocation first records a
   fresh passing baseline, then installs a copy of the skill with its
   `events_lost` safety instruction removed. It passes only when the mutated run
   produces exactly the corpus-owned `reported-outcome-mismatch` and links the
   baseline evidence. This single stochastic hosted-model pair records an
   associated behavior difference; without fixed-seed deterministic replay or
   replicated controls it does not prove causality:

   ```sh
   CURSOR_EVAL_HOSTED_CODEX=1 CURSOR_EVAL_HOSTED_MODEL=gpt-5.6-sol \
     CURSOR_EVAL_HOSTED_REASONING_EFFORT=low CURSOR_EVAL_SKILL_SENSITIVITY=omit-events-lost \
     node scripts/run-cursor-skill-eval.mjs model-events-lost
   ```

   Preserve a single `EvalResultV1` and bounded evidence. An
   `agent_behavior_mismatch` result measures the model's instruction following;
   it is not grounds for weakening adapter admission.
6. After deterministic checks pass, upgrade the Git marketplace snapshot,
   remove the currently cached installation, and add the plugin again using
   the exact update sequence above.

Cursor Agent adapter migration is separate and fail-closed. Before changing
`CURSOR_ADAPTER_VERSION` or argument encoding, capture `agent --version` and
`agent --help`, update the versioned Agent golden fixture, and run the focused
runtime/release tests. The version-specific adapter owns the admitted encoding;
a different installed Agent version terminates initialization rather than being
treated as implicitly compatible.
