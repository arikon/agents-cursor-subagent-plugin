# Codex Cursor Subagent Plugin

Prototype of a local Codex plugin that launches the installed `agent acp` and exposes it as an interactive subagent through MCP.

The plugin uses the Node.js runtime and Cursor Agent command available in the
environment where Codex runs. The portable managed installation remains a
separate package-canary mechanism; it does not require a source checkout
afterwards.

## Interaction model

`Codex → MCP plugin → Cursor ACP (stdio JSON-RPC)`

The plugin does not use `cursor-agent --yolo`, file-based IPC, or automatic command approval. The primary workflow is `cursor_delegate → cursor_wait`; questions, plans, and approval requests remain pending until explicitly answered.

## Requirements

- Node.js 18+;
- Cursor Agent (`agent`) installed and authenticated with `agent login`; for a non-standard path, set `CURSOR_AGENT_COMMAND` in the MCP server environment;
- Codex with local plugin/MCP support.

For local verification:

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

Start a new Codex task after installing or updating the plugin so Codex loads
its skills and MCP server. To update the marketplace snapshot later, run:

```sh
codex plugin marketplace upgrade codex-cursor-subagent-plugin
```

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

After installation, `cursor_delegate` is the primary tool; the answer tools
and `cursor_wait` form the interactive workflow. The advanced runtime API only
includes `cursor_start_session`, `cursor_send_prompt`, `cursor_session_status`,
and `cursor_cancel`.

Pass the `cwd` of a separate worktree for every task that may change files. For
a read-only task, explicitly select `ask`; before changing files, explicitly
select `agent`.

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
   node --test tests/bootstrap.test.mjs tests/codex-app-server-client.test.mjs
   node --test tests/cursor-skill-eval.test.mjs \
     tests/run-cursor-skill-eval.test.mjs \
     tests/codex-client-integration.test.mjs
   openspec validate add-cursor-subagent-skill-evals --strict
   node scripts/check-openspec-semantics.mjs
   ```

5. In a separate temporary `CODEX_HOME`, run the authenticated model lane:

   ```sh
   CURSOR_EVAL_HOSTED_CODEX=1 node scripts/run-cursor-skill-eval.mjs model-question
   ```

   Preserve a single `EvalResultV1` and bounded evidence. An
   `agent_behavior_mismatch` result measures the model's instruction following;
   it is not grounds for weakening adapter admission.
6. After deterministic checks pass, upgrade the Git marketplace snapshot and
   reinstall the plugin using the commands above.
