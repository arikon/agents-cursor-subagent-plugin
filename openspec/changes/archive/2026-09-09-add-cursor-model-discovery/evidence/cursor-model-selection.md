# Installed Cursor model selection and presentation

Verified 2026-09-09 against Cursor CLI 2026.08.25-3e8eec8. Installed source: `/Users/arikon/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/7901.index.js`, bundled `model-selection/dist/index.js`; interactive picker: `89.index.js`, `src/components/model-picker-pager.tsx`. These are version-specific implementation observations, not public APIs.

The resolver filters variants matching supplied parameter values, then maximizes matching default parameter/value pairs; ties prefer the default itself, then provider order. Cursor additionally heals invalid values and can fall back to default. MD-6 reuses only constrained candidate selection: explicit invalid values and an empty candidate set remain errors.

Observed reason to use this algorithm instead of strict default overlay: the public catalog GPT-5.5 and GPT-5.4 defaults use context=1m, but fast=true variants use context=272k. Keeping the default context as a hard constraint would reject a supported fast request. Unspecified parameters may change to satisfy explicit constraints.

CLI initial model selection matches complete variant representations or legacy slugs; a partial tuple is not a general supported encoding. Initialization-only probes confirmed `grok-4.6[effort=medium,fast=true]`, `gpt-5.6-sol[context=1m,reasoning=medium,fast=false]`, and `gemini-3.8-flash[reasoning_effort=medium]`. Raw local artifacts: `/tmp/cursor-grok-medium-full-selection.json`, `/tmp/cursor-sol-medium-full-selection.json`, `/tmp/cursor-gemini-medium-full-selection.json`. The earlier partial Grok probe did not complete initialization. No prompt was sent in these probes.

Cursor reduces picker volume primarily by showing base models, not exploded variants. The interactive picker searches case-insensitively by ID/display name, moves default/Auto first, and paginates with at most ten entries. Parameters have a separate editor; single-choice enums are hidden. CLI model listing uses usable-model filtering and a local Bedrock condition. One ordinary catalog path excludes four historical model IDs; ACP uses a different path. These conditional exclusions are not a universal public catalog policy.

For MD-1, preserve all returned base models and provider order: the measured public response has 39 base models and 396 variants. Do not copy historical hardcoded exclusions or add ranking/pagination to MCP v1. The compact projection provides the same principal reduction without introducing another model-availability policy.

The public response contains full parameter definitions, variants, and `isDefault` markers; compact MCP output is our projection of it. Reviewer claims that a compact MCP result implies an equally compact upstream response are contradicted by `evidence/public-sdk-catalog.md` and `/tmp/cursor-public-model-catalog.json`.
