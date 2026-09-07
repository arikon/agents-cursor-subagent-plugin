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
`cursor_send_prompt`, `cursor_read_result`, `cursor_set_mode`, and `cursor_close_session` form the
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

Behavior acceptance keeps a visible rejected call in its audited transcript.
Within one Codex turn it may classify each disjoint rejected/corrected success
span of the same existing-session tool, with only contiguous successful pure
current-session status reads between them, as recovered for these finite classes: current session/turn
address, exact public wait cursors or an admitted mode. An intervening status
must be a pure current-session request without extra arguments. The corrected
call still passes normal trace, authority, effect and delivery checks.
Result-read offset and answer-shape repairs, launch/resume, prompt or request-ID
changes, excluded errors, overlapping or unfinished attempts, other interleaves/turns and
hidden argument changes remain failures.
An `unknown_request` remains a separate recovery: perform a fresh
`cursor_wait`, consume current pending context, and only then answer with the
returned request ID. Free-form report prose is not recovery evidence.

Terminal snapshots retain an 8 KB result preview. When `result.truncated:true`,
read `cursor_read_result` from offset zero through `next_offset` until `eof`
before reporting, sending a follow-up, or closing. The runtime retains the full
result up to 1 MiB; overflow fails explicitly with `terminal_result_limit`.

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
`codex-cli 0.153.4` (the historical 0.152.1 adapter remains available); a version mismatch stops the managed installation or eval
as `external_adapter_drift` / `integration_failure` rather than producing an
implicit success.

To migrate to version `X.Y.Z`:

1. Obtain the release binary and source at tag `rust-vX.Y.Z`; verify
   `codex --version` using that exact binary.
2. Confirm from source or the actual interface the plugin CLI and JSON schema,
   `skills/list`, persistent `thread/start`/`thread/archive`/`turn/start`,
   explicit skill input, and `mcpServer/elicitation/request`.
3. Update the version-specific layer:
   `tests/fixtures/codex-v01534-adapter.mjs`,
   `tests/fixtures/codex-v01534-adapter.golden.json`, and
   `tests/fixtures/codex-app-server-v01534.golden.json`; add fixtures for the
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

5. Run the authenticated model lane in its isolated temporary `CODEX_HOME`.
   Acceptance requires `gpt-5.6-terra` at both `high` and `medium`. First run a
   diagnostic matrix, then three serial runs per configuration on the same
   unchanged candidate. Use a new durable output directory for each invocation:

   ```sh
   CURSOR_EVAL_HOSTED_CODEX=1 node scripts/eval/run-cursor-skill-eval-matrix.mjs \
     gpt-5.6-terra high "$PWD/evals/evidence/diagnostic-high/result.json"
   ```

   The matrix runs eight isolated scenarios concurrently by default and emits
   `scenario_started`, a `scenario_progress` heartbeat every 30 seconds for
   each active scenario, and `scenario_completed` for each corpus row. Set
   `CURSOR_EVAL_MATRIX_CONCURRENCY=1..16` to tune the pool size. Its atomic JSON
   result contains per-scenario evidence references, attempts, durations,
   verdict counts, pass rate, and a candidate manifest binding the corpus,
   installed skill/package, evaluator inputs, adapter, and client version.
   Each scenario has exactly one attempt per run; failures are retained.
   The artifact index uses relative paths and hashes so the complete bundle can
   be moved and inspected without its original temporary installation.
   After repairing diagnostic failures, freeze the candidate and run:

   ```sh
   CURSOR_EVAL_HOSTED_CODEX=1 CURSOR_EVAL_MATRIX_SERIAL=3 \
     node scripts/eval/run-cursor-skill-eval-matrix.mjs \
     gpt-5.6-terra high "$PWD/evals/evidence/acceptance-high/result.json"
   CURSOR_EVAL_HOSTED_CODEX=1 CURSOR_EVAL_MATRIX_SERIAL=3 \
     node scripts/eval/run-cursor-skill-eval-matrix.mjs \
     gpt-5.6-terra medium "$PWD/evals/evidence/acceptance-medium/result.json"
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

   All three runs of each configuration must pass every admitted model scenario
   with identical candidate digests. Counts come from the current corpus.
   The [baseline](evals/cursor-skill-eval-matrix-baseline-2026-09-06.json)
   preserves historical comparisons alongside acceptance evidence; an old green
   row or a single successful run cannot establish the current baseline.

   Acceptance checks tool execution, effects and delivery of explicitly
   requested scenario data: result markers, questions, visible choices and
   plans. Test markers belong only to the corpus and fixtures; the installed
   skill contains no eval-specific phrases or response-language requirement.
   Each model turn must deliver a nonempty final answer, even when no exact
   data check applies. Captured answers remain in evidence, but free-form semantic correctness is
   `not_checked`; actual execution success never implies reported success.
   A green baseline therefore establishes functional acceptance, not the
   truthfulness of every sentence or a free-form disclosure of incompleteness
   in the assistant's answer. The former
   `omit-events-lost` prose-disclosure mutation is outside this acceptance
   contract; its historical evidence does not establish a current gate.

   Preserve a single `EvalResultV1` and bounded evidence. An
   `agent_behavior_mismatch` result measures the model's instruction following;
   it is not grounds for weakening adapter admission.

   Before freezing the candidate, audit the last successful coverage result.
   The audit remains failing while any raw zero counter lacks a current explicit
   classification; reuse is accepted only for the same product-source hash and
   counter identity:

   ```sh
   node scripts/audit-node-coverage.mjs <coverage-result.json> <output-dir> \
     [--previous <audit.json>] [--classifications <sidecar.json>]
   ```

   The command writes `zero-counters.json` and `zero-counter-audit.json` in the
   output directory. Optional prior audit and classification inputs may come
   from older sibling directories; accepted proof is copied or normalized into
   the portable output bundle, so no manual pre-copy is required.

   After the diagnostic and both three-run series pass on the frozen candidate,
   publish closeout with the deterministic finalizer:

   ```sh
   node scripts/eval/finalize-cursor-skill-eval.mjs \
     --freeze <frozen-inputs.json> \
     --diagnostic <highserial1.json> \
     --high <highserial3.json> \
     --medium <mediumserial3.json> \
     --coverage-audit <zero-counter-audit.json> \
     --baseline <existingbaseline.json> \
     --report <existingMarkdown.md> \
     --tasks <tasks.md> \
     --output <acceptance-bundle-root/closeout-proof.json>
   ```

   It validates the candidate, scenario evidence, relative artifact hashes,
   captures, publication, cleanup and coverage audit before updating the
   additive baseline and Markdown history. It writes task checkboxes last and
   never archives the OpenSpec change or supplies reviewer approval. The proof
   file's parent is the common portable bundle root; the new freeze uses only
   contained relative references, while earlier freezes remain immutable
   historical evidence.
   Freeze creation also revalidates all current coverage sources, requires the
   exact `coverage.sources.digest`, a nonempty exact overlap with the evaluator
   inventory, and a root-relative reference to `zero-counter-audit.json`.
   Re-evaluating a saved trace is diagnostic only and never rewrites its original
   verdict. A new baseline still requires fresh high and medium three-run series
   on the frozen candidate.
6. After deterministic checks pass, upgrade the Git marketplace snapshot,
   remove the currently cached installation, and add the plugin again using
   the exact update sequence above.

Cursor Agent adapter migration is separate and fail-closed. Before changing
`CURSOR_ADAPTER_VERSION` or argument encoding, capture `agent --version` and
`agent --help`, update the versioned Agent golden fixture, and run the focused
runtime/release tests. The version-specific adapter owns the admitted encoding;
a different installed Agent version terminates initialization rather than being
treated as implicitly compatible.
