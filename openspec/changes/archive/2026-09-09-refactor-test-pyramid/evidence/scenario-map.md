# Scenario map

This is change-local refactoring evidence. `scripts/run-node-tests.mjs` remains
the single executable membership owner.

| Source owner | Observable responsibility | Target level / final owner | Operation | Rationale |
| --- | --- | --- | --- | --- |
| `facade.test.mjs` | facade composition and validation | component | keep | injected dependencies; no process boundary |
| `model-discovery.test.mjs` | request validation, catalog parsing and loopback fake-ACP transport | integration | retain | fixture and child-process boundary are exercised |
| `cursor-skill-eval-component.test.mjs` | scenario/oracle validation with repository inventory reads and subprocess-admission checks | integration | retain | mixed dependency boundaries remain together |
| `cursor-skill-eval.test.mjs` | recording proxy transport, pipes, signals and evidence publication | integration | retain remainder | real child-process and filesystem boundaries |
| `eval-closeout.test.mjs` | closeout schema, atomic evidence helpers and publication | integration | retain | filesystem publication contract |
| `eval-closeout-cli.test.mjs` | closeout CLI publication | integration | move from closeout | real CLI child boundary |
| `coverage-audit.test.mjs` | raw coverage classification | component | keep | pure audit input/output contract |
| `node-test-reporter-v22.test.mjs` | reporter event normalization | component | keep | parser/format contract |
| `check-openspec-semantics.test.mjs` | semantic registry validation | component | keep | deterministic repository input validation |
| `node-test-supervisor.test.mjs` | runner admission, artifacts, child environment and terminal verdict | integration | keep | process spawning and filesystem lifecycle |
| `bootstrap-component.test.mjs` | manifest normalization and tree hashing | component | move from bootstrap | pure validation without package lifecycle |
| `bootstrap-{cli,adapter,lifecycle,recovery}.test.mjs` | package bootstrap validation, adapter, lifecycle and recovery | integration | split complete | independent subprocess/package groups run in isolated processes |
| `codex-app-server-client-component.test.mjs` | versioned protocol golden contracts | component | move from app-server client | recorded contract parsing without a child process |
| `codex-app-server-client.test.mjs` | app-server JSON-RPC client | integration | keep remainder | stdio protocol boundary |
| `mcp-smoke.test.mjs` | MCP tool surface | integration | keep | public transport boundary |
| `mcp-transport.test.mjs` | MCP transport lifecycle | integration | keep | real pipes and child closure |
| `runtime-{admission,interaction,callbacks-results,lifecycle}.test.mjs` | ACP session admission, interaction, callbacks/results and lifecycle | integration | keep, split complete | real fake-ACP child processes; cohesive groups remain process integration |
| `eval-matrix.test.mjs` | runner matrix, process artifacts and serial aggregation | integration | keep | process/filesystem orchestration |
| `run-cursor-skill-eval-component.test.mjs` | corpus materialization, oracle and child-result parser | component | move from eval runner | injected/pure scenario and evidence contracts |
| `run-cursor-skill-eval.test.mjs` | eval runner lifecycle and materialized evidence | integration | keep remainder | runner process checks remain |
| `release-e2e-component.test.mjs` | exact permission and terminal live-result classifier | component | move from release E2E | pure validation with no installed package |
| `release-e2e.test.mjs` | installed package E2E and release canary | release/eval | keep remainder | retain package path |
| `codex-client-oracle-component.test.mjs` | transcript/oracle and recovery projection | component | move from client integration | pure evidence classification with no Codex child |
| `codex-client-integration-component.test.mjs` | app-server argv/config and credential resolution | component | move from client integration | injected validation without process or filesystem boundary |
| `codex-client-integration.test.mjs` | provisioned real-Codex and hosted paths | eval | keep remainder | retain guarded/unguarded CLI paths |
| `claude-marketplace-canary.test.mjs` | real Claude marketplace install | focused eval/live | move | excluded from deterministic aggregate |

## Explicit exclusions from the deterministic baseline

- `credential-free Codex client observes only the package-bootstrap-installed skill` invokes an installed Codex CLI without an opt-in guard.
- `credential-free client integration completes the installed-skill MCP loop when provisioned`, hosted-Codex, release live model-discovery and Claude marketplace tests require explicit compatible eval/live routes.

No scenario is removed for speed. Any merge/remove requires a retained owner
for every material assertion and is recorded with its focused evidence.
