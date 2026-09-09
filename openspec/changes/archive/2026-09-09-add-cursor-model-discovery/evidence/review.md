# Planning review, 2026-09-09

Current user-approved baseline: official models API using apiKey from ~/.cursor/auth.json; minimal effort/fast projection plus Auto optimize_for/default_optimize_for and explicit strategy on start/delegate/resume; bounded startup stderr in same change. No implementation completion claimed.

Native critic verdict OKAY on extended Auto baseline: no baseline_violation. Architect confirmed owner boundaries, minimality, and required strategy echo in existing envelopes. Earlier typo erroneously treating known schema as failure repaired to schema violation; evidence artifact added. Both repairs local, no new entity or lifecycle owner.

Open implementation_concern: actual strategy on session/load requires persisted conversation verification. Initialization-only sessions could not be loaded in probe; task2.1 now explicitly covers changed strategy after load and excludes Session not found from PASS evidence. Three new-session strategies confirmed individually via installed parameterized config observation. Legacy variant metadata mismatch remains version-specific adapter evidence, not a public MCP field.

Strict validation PASS. Full semantic gate has one pre-existing unrelated failure in simplify-task-state-wait: invalid modified capability cursor-subagent-skill-evals/Сценарный контракт поведения и authority-aware interaction. No new errors from this change; do not claim global semantic PASS.

User requested approximately half of subsequent session reviews through installed Cursor skill with Cursor Grok4.6/medium. First delegation used canonical catalog base grok-4.6 and effort medium, ask mode and bounded read-only scope. It failed before a turn: failure_kind init, terminal_reason null. Failed allocation closed idempotently. This was not a review verdict. Subsequent review used the complete supported selection with fast=true (observed provider default) and completed; result fully read, session closed.

## MD-6 review and architect adjudication

Cursor Grok4.6/medium returned REVISE with 21 findings on the candidate. Architect checked all findings against the current baseline and raw API/installed-interface evidence. Final classifications below supersede the critic's preliminary categories; they do not expand scope.

| Finding | Classification | Disposition |
| --- | --- | --- |
| 1 | external_adapter_drift | Raw public API proves full variants; retain source and fixture task. |
| 2 | external_adapter_drift | Exact provider keys/encoding belong to adapter evidence and fixture. |
| 3 | overengineering | No second normative owner exists; reject additional resolver layer. |
| 4 | external_adapter_drift | Default marker proven; unique candidate may work without default. |
| 5 | implementation_concern | Preserve caller-vs-metadata taxonomy; metadata errors must not misdirect to key repair. |
| 6 | baseline_violation | Repaired: actual selection verification explicitly applies to explicit-selection branch; preserve existing default policy on resume. |
| 7 | external_adapter_drift | auto-smart is a proven catalog ID; no separate reserved bypass. |
| 8 | implementation_concern | Presence of false already normative; verify behavior. |
| 9 | implementation_concern | Bracketed input already excluded; test complete internal encoding. |
| 10 | implementation_concern | Shared projection/resolver already required; one scenario owner. |
| 11 | implementation_concern | Accepted mismatch of any encoded parameter with evidence; require evidence only for canonical/explicit fields. |
| 12 | implementation_concern | Authoritative new/load response within existing init deadline; no invented polling. |
| 13 | implementation_concern | Shared HTTP bounds apply to launch; HTTP has no stderr stream. |
| 14 | implementation_concern | Teardown failure test preserves no-live/no-prompt. |
| 15 | implementation_concern | Family fixtures and realistic failure paths in task 2.4, no duplicated matrix. |
| 16 | external_adapter_drift | Exact selection metadata stays in fixture. |
| 17 | external_adapter_drift | Detect normalization by evidence, without policy engine. |
| 18 | new_scope | No public hidden-parameter bag. |
| 19 | new_scope | No offline cache, in-session switching or inference identity promise. |
| 20 | overengineering | Reject proposed Auto bypass: it would duplicate tuple construction. |
| 21 | external_adapter_drift | Hidden parameter names explain observed cases, not universal schema. |

Architect approved constrained selection instead of strict default overlay: the latter rejects valid fast=true GPT variants. Both requested local verification clarifications were applied. Evidence: `cursor-model-selection.md`. A final independent Cursor review receives the updated baseline and the previously missing raw-source evidence.

Final Cursor Grok4.6/medium verdict: **OKAY**, no baseline_violation. Full final verdict is `cursor-final-review.md`; result fully read and allocation closed. Three implementation_concern findings are covered in task 2.4: ID-only default resolution/failure fixture, whole-operation mapping ambiguity (no partial catalog), encoded-versus-actual comparison. The suggested alternate slug bypass is not adopted because it changes MD-6; no new runtime path is needed. Planning strict validation passes; global semantic readiness remains blocked only by the unrelated existing change noted above.

Architect final confirmation: **OKAY**. All three final findings retain implementation_concern classification; task-only additions are minimal, preserve the single owner and introduce no new scope. This confirms the specification review, not implementation completion or global semantic PASS.
