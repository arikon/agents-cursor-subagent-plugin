## v1 Contract Baseline

**Goal.** Align release package identities with the repository name.

**Non-goals.** Prototype-install migration, new runtime APIs, new lifecycle or permissions.

**Public-invariant index.** `ID-1` → «Managed marketplace lifecycle»; `ID-2` → «Git marketplace публикует Claude Code plugin»; `ID-3` → «Claude Code plugin предоставляет существующий interactive workflow»; `ID-4` → «Bootstrap paths and publication topology».

**Owner map.** `cursor-plugin-distribution` owns managed package identity; `claude-code-plugin-distribution` owns Claude catalog identity. Runtime retains ownership of ACP semantics.

**Implementation-ready exit.** Both manifests and commands use the same IDs; existing package checks prove installation and discovery under the new name.

**Future-change candidates.** None required for this naming correction.

## Minimal repair

Only identifier and executable-name literals change in the indexed requirements.
Replacement digests record this transition without rewriting earlier archives.
