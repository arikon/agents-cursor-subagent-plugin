# Official model catalog evidence

Verified 2026-09-09. Source: https://cursor.com/docs/sdk/typescript#cursormodelslist and https://cursor.com/docs/cloud-agent/api/endpoints#list-models; published @cursor/sdk1.0.31 implementation routes Cursor.models.list through listCloudModels and CloudApiClient.listModels to GET /v1/models.

Authorized live GET https://api.cursor.com/v1/models with Bearer apiKey read from ~/.cursor/auth.json returned HTTP200. Credentials were neither printed nor included in artifacts. Top-level {items};39 models396 variants. Present model fields: id/displayName/aliases/parameters/variants. Full credential-free local response /tmp/cursor-public-model-catalog.json. Compact serialization72679bytes; pretty artifact186294bytes, neither represents measured HTTP wire size. All38 IDs from preceding internal catalog snapshot appeared plus default.

Observed grok-4.6 effort values low/medium/high/xhigh, fast false/true,8 variants. Composer2.5 fast false/true. Model-specific parameter IDs also include reasoning/reasoning_effort/context/thinking/optimize_for; these are not aliases for effort. Public payload has no vendor/provider/isCursorModel field.

Auto: auto-smart has optimize_for values intelligence/balanced/cost, three variants, balanced marked isDefault:true. A separate default entry has alias auto and a parameterless default variant. Pre-implementation MCP launch has no optimize_for field; the later explicit user scope update below adds it to the planned contract.

Missing-apiKey recovery was selected by the user: obtain an API key and put it in apiKey field of ~/.cursor/auth.json. Previous public request using accessToken alone returned401 Invalid User API Key. No automatic fallback, login, key creation, or credential-file write is part of discovery.

This evidence supports the selected minimal projection id/name/effort/fast plus Auto optimize_for/default_optimize_for and official HTTP source. It does not promise completeness beyond the returned account catalog, parameter Cartesian-product validity, or future provider availability. Runtime tests will use a small synthetic schema fixture; this live account response is not a deterministic test corpus.

## Auto launch evidence after explicit scope expansion

User explicitly added discovery and launch of Auto strategies to this change. Installed Cursor2026.08.25-3e8eec8 accepted --model auto-smart[optimize_for=cost|balanced|intelligence] in three separate initialization-only probes. Each performed initialize/authenticate/session/new, no prompt. initialize clientCapabilities._meta.parameterizedModelPicker:true (Cursor-version-specific observation surface) exposed configOptions entry id optimize_for with matching currentValue cost/balanced/intelligence. Files: /tmp/cursor-acp-auto-cost-result.json, /tmp/cursor-acp-auto-balanced-result.json, /tmp/cursor-acp-auto-intelligence-result.json. Processes terminated after observation.

Legacy variant picker response for cost reported models.currentModelId auto-smart[optimize_for=balanced]; this did not reflect the actual parameterized selection. A canary must observe parameterized config rather than mistake the legacy default presentation for selected strategy. This metadata is adapter/fixture detail, not a new public MCP field.

Catalog default balanced is descriptive. Launch will require explicit optimize_for for auto-smart; no inferred default from list order or default variant. Current official SDK docs also recommend explicitly passing Router optimize_for.

Resume probe of the empty intelligence session after process shutdown, with cost selected on the new process, returned -32602 Session not found. Raw /tmp/cursor-acp-auto-resume-cost-result.json. This does not establish resume strategy preservation; implementation acceptance must use an existing persisted conversation. No prompt was sent to manufacture persistence. Root cause of empty-session load failure was not established (probe used a fresh temporary cwd).
