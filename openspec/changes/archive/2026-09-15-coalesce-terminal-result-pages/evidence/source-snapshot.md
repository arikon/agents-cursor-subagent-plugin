# Source snapshot before apply

- Date: 2026-09-15
- Delivery worktree source: `origin/main` at `ec83315d3bea5375cbb7bc5b630454f435564621`.
- `openspec validate coalesce-terminal-result-pages --strict`: passed.
- `node scripts/check-openspec-semantics.mjs`: passed for 17 changes. It verified the registered source/replacement digests for RP-1–RP-7 against the current main specs.
- `scripts/openspec-semantic-registry.mjs` contains both `compact-cursor-subagent-skill` and `coalesce-terminal-result-pages` registrations.

## Related compact change

`compact-cursor-subagent-skill` is on `codex/operator-skill` at `509d8e16` and has 18 of 21 tasks complete. Its remaining hosted acceptance and final independent review are not complete. It has an uncommitted skill edit and local evidence in its separate worktree; this change does not read from or modify that worktree during implementation.

The selected order is the permitted delivery-first path from the design: implement this runtime/wire change from current `main`; then compact must establish its baseline and candidate on this changed wire before a combined release acceptance. The two measurements remain separate until that final combination.

## Reconstructed delivery matrix

The original 8,353-byte artifacts were retained, but the acceptance matrix was
reconstructed on 2026-09-15 after verification found missing declared fixtures.
`baseline-main` materializes only the runtime, model adapter, skill and plugin
manifest from `ec83315d3bea5375cbb7bc5b630454f435564621` in a disposable
directory; its runtime and skill digests are recorded in every JSON artifact.
Both baseline and candidate use the same current deterministic fake-ACP adapter
(`d7161ac9fc959d5fd24b3877f88d38688ff23496321972d8cea4c16a46946ff6`) and
the same fixture/action sequence. This late reconstruction is evidence of the
declared delivery comparison, not a claim that it was captured before apply.
