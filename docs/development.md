# Development guide

[Back to README](../README.md)

## Verification

The development verification lanes are pinned to Node.js 22.23.1. Run them with
that exact version:

```bash
node scripts/run-node-tests.mjs unit
node scripts/run-node-tests.mjs coverage
node scripts/run-node-tests.mjs release
```

Run commands in the foreground and wait for the terminal verdict. A failed run
prints diagnostics and an artifact directory containing `tap.txt`, `stderr.txt`,
`failures.jsonl`, and the atomic `result.json`. Read `result.json` first, then its
referenced files. Coverage includes only the product manifest; the release lane
excludes hosted and real-Codex opt-ins.

## Behavior acceptance

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

   ```bash
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

   ```bash
   CURSOR_EVAL_HOSTED_CODEX=1 node scripts/eval/run-cursor-skill-eval-matrix.mjs \
     gpt-5.6-terra high "$PWD/evals/evidence/diagnostic-high/result.json"
   ```

   The matrix runs twelve isolated scenarios concurrently by default and emits
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

   ```bash
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

   ```bash
   CURSOR_EVAL_HOSTED_CODEX=1 \
     node scripts/eval/run-cursor-skill-eval-suite.mjs \
     evals/cursor-skill-eval-matrix.plan.v1.json \
     /private/tmp/cursor-skill-eval-suite.json
   ```

   All three runs of each configuration must pass every admitted model scenario
   with identical candidate digests. Counts come from the current corpus.
   The [baseline](../evals/cursor-skill-eval-matrix-baseline-2026-09-06.json)
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

   On a managed hosted failure, inspect `hosted-failure-*.json` under the
   attempt's `evidence/` directory before diagnosing a timeout. The harness
   saves bounded compact MCP and fake-ACP safe traces plus app-server metadata
   before fixture cleanup, with explicit `captured`, `truncated`, `missing` and
   `read_error` statuses. Partial JSON is preserved as captured content; the
   `truncated` status denotes the byte cap. The failure diagnostic starts with
   the file path, size and SHA-256;
   the matrix artifact index retains the file. Direct runs use
   `CURSOR_EVAL_EVIDENCE_ROOT` or the system temporary directory's
   `cursor-eval-evidence/` directory. Copy direct-run diagnostics to durable
   storage before OS temporary-file cleanup. A publication failure is reported
   alongside the original error; abrupt process loss can leave no sidecar.
   This file is diagnostic only and does not establish a passed eval or a new
   accepted candidate. Existing frozen baselines retain their original inputs.

   Before freezing the candidate, audit the last successful coverage result.
   The audit remains failing while any raw zero counter lacks a current explicit
   classification; reuse is accepted only for the same product-source hash and
   counter identity:

   ```bash
   node scripts/audit-node-coverage.mjs <coverage-result.json> <output-dir> \
     [--previous <audit.json>] [--classifications <sidecar.json>]
   ```

   The command writes `zero-counters.json` and `zero-counter-audit.json` in the
   output directory. Optional prior audit and classification inputs may come
   from older sibling directories; accepted proof is copied or normalized into
   the portable output bundle, so no manual pre-copy is required.

   After the diagnostic and both three-run series pass on the frozen candidate,
   publish closeout with the deterministic finalizer:

   ```bash
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
   the [Codex update sequence](../README.md#update-the-codex-plugin).

Cursor Agent adapter migration is separate and fail-closed. Before changing
`CURSOR_ADAPTER_VERSION` or argument encoding, capture `cursor-agent --version` and
`cursor-agent --help`, update the versioned Agent golden fixture, and run the focused
runtime/release tests. The version-specific adapter owns the admitted encoding;
a different installed Agent version terminates initialization rather than being
treated as implicitly compatible.
