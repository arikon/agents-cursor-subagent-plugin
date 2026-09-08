# Codex Cursor Subagent Plugin

Use Cursor Agent as an interactive subagent from Codex or Claude Code. Delegate
code investigation, reviews, planning, and implementation without manually
moving prompts and results between applications.

The plugin launches your installed Cursor Agent through ACP and exposes its
interactive session through MCP. You can follow progress, answer questions,
review plans, and continue with follow-up tasks.

## Contents

- [Requirements](#requirements)
- [Cursor Agent setup](#cursor-agent-setup)
- [Install in Codex](#install-in-codex)
- [Install in Claude Code](#install-in-claude-code)
- [Usage](#usage)
- [Permissions and scope](#permissions-and-scope)
- [Development](#development)

## Requirements

- runtime and portable installation: Node.js 18+;
- Cursor Agent (`cursor-agent`) installed and authenticated before using the plugin
  (see [Cursor Agent setup](#cursor-agent-setup) below);
- Codex with local plugin/MCP support, or Claude Code with plugin support.

## Cursor Agent setup

### Install the CLI

The plugin does not install Cursor Agent or sign you in. Install and authenticate
it under the same OS user and in the environment where Codex or Claude Code runs.
Follow the official [Cursor CLI installation guide](https://cursor.com/docs/cli/installation).
On macOS, Linux, or WSL:

```bash
curl https://cursor.com/install -fsS | bash
export PATH="$HOME/.local/bin:$PATH"
cursor-agent --version
```

Keep `~/.local/bin` on the host application's `PATH`, or set
`CURSOR_AGENT_COMMAND` to the absolute Agent executable path. The installer
provides the current CLI; this plugin currently admits only version
`2026.08.25-3e8eec8`, so check the version before use. A newer CLI requires an
adapter update as described under [adapter migration](docs/development.md#migrating-to-a-new-codex-version).

### Sign in with file-backed credentials

Sign in through the browser using the file-backed credential store:

```bash
AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login
AGENT_CLI_CREDENTIAL_STORE=file cursor-agent status --format json
```

Complete the browser login and confirm that the status command reports you as
authenticated before starting a delegated task. Both plugin configurations set
`AGENT_CLI_CREDENTIAL_STORE=file`, so use that same setting for login and status.
On macOS this selects file storage instead of Keychain. If you previously signed
in using Keychain, run the file-backed login above as well.

The official [Cursor authentication guide](https://cursor.com/docs/cli/reference/authentication)
explains browser login and status checks. The file-store environment variable is
an option of the supported Cursor Agent version used by this plugin; it is not
documented on that page.

## Install in Codex

Install the plugin through a Git marketplace, using the standard Codex CLI
workflow:

```bash
codex plugin marketplace add arikon/agents-cursor-subagent-plugin --ref main
codex plugin add codex-cursor-subagent-plugin@codex-cursor-subagent-plugin
```

The first command registers a GitHub repository as a marketplace; the second
installs the plugin from its marketplace snapshot. Check the configured
marketplaces and installed plugins with:

```bash
codex plugin marketplace list --json
codex plugin list --json
```

Start a new Codex task after installing the plugin so Codex loads its skills
and MCP server.

### Update the Codex plugin

Refresh the marketplace snapshot, then reinstall the cached plugin:

```bash
codex plugin marketplace upgrade codex-cursor-subagent-plugin
codex plugin remove codex-cursor-subagent-plugin@codex-cursor-subagent-plugin
codex plugin add codex-cursor-subagent-plugin@codex-cursor-subagent-plugin
```

Start a new Codex task only after the final `plugin add` succeeds.

## Install in Claude Code

The same GitHub repository is a Claude Code marketplace. It requires `node` and
an authenticated Cursor Agent available as `cursor-agent` in `PATH`; set
`CURSOR_AGENT_COMMAND` in the Claude Code environment only when the command has
a non-standard location.

```bash
claude plugin marketplace add arikon/agents-cursor-subagent-plugin
claude plugin install cursor-acp-subagent@codex-cursor-subagent-plugin
```

Restart Claude Code after installation to load the plugin.

### Update the Claude Code plugin

Refresh the marketplace and installed plugin after a new Git revision, then
restart Claude Code to load the updated MCP server:

```bash
claude plugin marketplace update codex-cursor-subagent-plugin
claude plugin update cursor-acp-subagent@codex-cursor-subagent-plugin
```

Installing the plugin only makes the existing `cursor_*` MCP tools and
`cursor-subagent` skill available. It does not approve Cursor actions: questions,
plans, and out-of-scope, destructive, external, or credential-related permission
requests still require the same explicit authority as in Codex.

## Usage

Ask the host assistant to delegate a bounded task to Cursor, for example:

> Ask Cursor to review `src/parser.ts` for correctness without changing files.

The bundled [cursor-subagent skill](skills/cursor-subagent/SKILL.md) guides the
assistant through delegation, permissions, follow-ups, and cleanup.

### Modes

| Mode | Use it for |
| --- | --- |
| `ask` | Read-only investigation, questions, diagnosis, and code review. |
| `plan` | Preparing a plan for approval. |
| `agent` | Implementation within the changes you authorized. |

### MCP tools

| Task | Tools |
| --- | --- |
| Delegate and follow progress | `cursor_delegate`, `cursor_wait` |
| Respond to pending requests | `cursor_answer_question`, `cursor_answer_plan`, `cursor_answer_permission` |
| Continue work between turns | `cursor_send_prompt`, `cursor_set_mode` |
| Read longer results | `cursor_read_result` |
| Resume or close a session | `cursor_resume_session`, `cursor_close_session` |
| Advanced diagnosis and recovery | `cursor_start_session`, `cursor_session_status`, `cursor_cancel` |

### Follow-ups and resume

`cursor_resume_session` attempts to resume a
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

### Reading complete results

Terminal snapshots retain an 8 KB result preview. When `result.truncated:true`,
read `cursor_read_result` from offset zero through `next_offset` until `eof`
before reporting, sending a follow-up, or closing. The runtime retains the full
result up to 1 MiB; overflow fails explicitly with `terminal_result_limit`.

### Workspace and session settings

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

## Permissions and scope

The local transport is Codex or Claude Code → MCP plugin → Cursor ACP
(stdio JSON-RPC).

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

## Development

See the [development guide](docs/development.md) for verification commands,
portable installation, behavior acceptance, and version-specific adapter migration.
