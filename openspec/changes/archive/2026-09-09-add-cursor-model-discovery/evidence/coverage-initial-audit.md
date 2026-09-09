# Initial raw coverage audit

Snapshot: `2026-09-09T15-37-59-866Z-coverage-d3f13f71-67f6-4651-9ad0-f7c892b0733a`. Verdict **PARTIAL**: six tests failed, source drift diagnostic; aggregate percentages do not prove acceptance. Read result.json before the last test:coverage event. All raw zero points are retained below, including repeated counters and ignored-line residual branches. No dead code identified.

Historical rationale source: `evals/evidence/iux-release-2026-09-07/coverage-accepted-final/zero-counter-audit.json` and archived improve-interactive-acp-ux/coverage-review.md. Non-runtime entries reuse reviewed same-line logic; runtime points were inspected against current source. Runtime hash matches snapshot fb9b52e6 at audit; adapter has already drifted.

Required repairs/proof: model_tests owns adapter/discovery paths; stderr owner fixes failed runtime lane; extend version-probe inherited-pipe coverage (function 409). Then rerun full coverage on frozen source. This initial report is not an accepted final source-hash audit. Existing contract tests need no duplicate operand-only tests.

```json
{
  "total_zero_counters": 122,
  "counts": {
    "meaningful_contract": 36,
    "unreachable_defensive": 43,
    "realistic_failure": 29,
    "meaningful_contract_or_realistic_failure": 14
  },
  "counters": [
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 48,
      "raw_index": 14,
      "classification": "meaningful_contract",
      "disposition": "This zero operand belongs to the same closed digest-shape validation and pre-publication invalid-digest rejection exercised by malformed snapshot, source, and artifact digest inputs; candidate-18 and candidate-19 only reorder equivalent short-circuit counters."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 58,
      "raw_index": 18,
      "classification": "unreachable_defensive",
      "disposition": "Every assertIdentity caller supplies identityOnly output, or published added/removed already proven byte-for-byte equal to owner-generated identities, so an identity with unexpected fields cannot reach this defensive exact-fields guard."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 96,
      "raw_index": 78,
      "classification": "meaningful_contract",
      "disposition": "This zero operand belongs to the same closed source-file metadata validation and pre-publication rejection exercised by invalid source bytes and digest inputs; candidate-18 and candidate-19 only reorder equivalent short-circuit counters."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 152,
      "raw_index": 114,
      "classification": "unreachable_defensive",
      "disposition": "After exact raw file count and successful unique known-source mapping for every raw file, mapped.size must equal sources.files.length, so this defensive completeness failure cannot execute; only the raw sibling counter order changed from candidate-18."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 238,
      "raw_index": 160,
      "classification": "meaningful_contract",
      "disposition": "Canonical normalized previous-review ordering for unique paths is exercised in both directions, while duplicate source paths are rejected by the existing malformed snapshot/review owner; comparator equality compatibility has no separate public outcome."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 370,
      "raw_index": 256,
      "classification": "unreachable_defensive",
      "disposition": "Every evidence destination is a nonempty basename or fixed nonempty bundle filename inside outputDir, so relative(outputDir, path) cannot be empty and the basename fallback cannot execute."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 426,
      "raw_index": 337,
      "classification": "unreachable_defensive",
      "disposition": "strictArtifactRef admits basename-only refs, therefore resolve(artifactRoot, ref) is lexically inside artifactRoot and this defensive escape rejection cannot execute."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 429,
      "raw_index": 338,
      "classification": "unreachable_defensive",
      "disposition": "readRegular rejects symlinks and non-files before canonical containment; a basename child regular file resolves inside canonicalArtifactRoot, so this defensive canonical escape rejection cannot execute."
    },
    {
      "path": "scripts/check-openspec-semantics.mjs",
      "metric": "branches",
      "line": 627,
      "raw_index": 1,
      "classification": "unreachable_defensive",
      "disposition": "Coverage imports this module, so its direct CLI entrypoint is not entered. Foreground Node22 scripts/check-openspec-semantics.mjs from the frozen release snapshot passed for 11 changes; the CLI entrypoint has its local import-only exclusion rationale."
    },
    {
      "path": "scripts/codex-app-server-client.mjs",
      "metric": "branches",
      "line": 152,
      "raw_index": 100,
      "classification": "meaningful_contract",
      "disposition": "positioned timeout, confirmed-missing and late-final polling tests own returning the latest bounded capture at the deadline"
    },
    {
      "path": "scripts/codex-app-server-client.mjs",
      "metric": "branches",
      "line": 162,
      "raw_index": 104,
      "classification": "realistic_failure",
      "disposition": "turn-page deadline exhaustion maps to capture_timeout and is covered by the positioned slow-page test"
    },
    {
      "path": "scripts/codex-app-server-client.mjs",
      "metric": "branches",
      "line": 191,
      "raw_index": 122,
      "classification": "realistic_failure",
      "disposition": "item-page deadline exhaustion maps to capture_timeout and is covered by the positioned slow-page test"
    },
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "metric": "branches",
      "line": 451,
      "raw_index": 432,
      "classification": "unreachable_defensive",
      "disposition": "Admission at 424-432 requires mutually exclusive fixture_predicate shapes for inject-mode-protocol-error-once and reject-mode; their conjunction is rejected before this guard."
    },
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "metric": "branches",
      "line": 769,
      "raw_index": 634,
      "classification": "unreachable_defensive",
      "disposition": "Recovery normalization first validates contiguous turn_call_ranges covering every call index through validRecoveryContext at lines 709-720 and its entry guard at 743. Therefore findIndex at 768 cannot return -1 for an iterated call. This is the same-source defensive counter previously reviewed at occurrence 2; the immediately preceding audit recorded it as occurrence 3."
    },
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "metric": "branches",
      "line": 737,
      "raw_index": 896,
      "classification": "meaningful_contract",
      "disposition": "Recovery variations at tests/cursor-skill-eval.test.mjs:47-78 and 126-180 own missing/malformed argument proof and changed projections; an absent request has the same no-recovery outcome."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "lines",
      "line": 100,
      "raw_index": 99,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "lines",
      "line": 101,
      "raw_index": 100,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "lines",
      "line": 102,
      "raw_index": 101,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "branches",
      "line": 84,
      "raw_index": 31,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "branches",
      "line": 88,
      "raw_index": 33,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "branches",
      "line": 49,
      "raw_index": 77,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "branches",
      "line": 92,
      "raw_index": 129,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-model-adapter.mjs",
      "metric": "branches",
      "line": 94,
      "raw_index": 133,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 24,
      "raw_index": 8,
      "classification": "unreachable_defensive",
      "disposition": "bounded callers provide normalized strings"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 175,
      "raw_index": 114,
      "classification": "unreachable_defensive",
      "disposition": "Repeated killAndWait after killReason is set is an idempotence guard. The first timeout or output-limit event owns process termination, and existing package command timeout/output-limit tests verify bounded shutdown; a subsequent stop request adds no new admitted behavior."
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 387,
      "raw_index": 303,
      "classification": "unreachable_defensive",
      "disposition": "pathKind and canonical parent validation reject a symlinked or foreign managed root before this canonical-directory operand can decide"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 401,
      "raw_index": 352,
      "classification": "unreachable_defensive",
      "disposition": "preflight topology failures have BootstrapError code and message"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 437,
      "raw_index": 353,
      "classification": "unreachable_defensive",
      "disposition": "the admitted versioned mcp-check adapter always returns a bounded status message; preflight success and adapter-failure outcomes are tested"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 446,
      "raw_index": 354,
      "classification": "unreachable_defensive",
      "disposition": "the admitted versioned agent-status adapter always returns a bounded status message; authenticated, required and unknown outcomes are tested"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 497,
      "raw_index": 391,
      "classification": "unreachable_defensive",
      "disposition": "published recovery envelopes after adapter mutation always have a journal record"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 673,
      "raw_index": 556,
      "classification": "unreachable_defensive",
      "disposition": "parseArgs throws BootstrapError with a fixed error code, so the generic invalid-invocation fallback cannot decide"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "metric": "branches",
      "line": 673,
      "raw_index": 557,
      "classification": "unreachable_defensive",
      "disposition": "parseArgs throws BootstrapError with a fixed error code, so the generic invalid-invocation fallback cannot decide"
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "lines",
      "line": 927,
      "raw_index": 925,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "lines",
      "line": 928,
      "raw_index": 926,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "lines",
      "line": 929,
      "raw_index": 927,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "lines",
      "line": 930,
      "raw_index": 928,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "lines",
      "line": 933,
      "raw_index": 931,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "lines",
      "line": 934,
      "raw_index": 932,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 29,
      "raw_index": 15,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 86,
      "raw_index": 62,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 88,
      "raw_index": 63,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 101,
      "raw_index": 74,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 127,
      "raw_index": 91,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 130,
      "raw_index": 95,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 138,
      "raw_index": 105,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 140,
      "raw_index": 109,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 142,
      "raw_index": 111,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 143,
      "raw_index": 113,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 149,
      "raw_index": 117,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 159,
      "raw_index": 137,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 162,
      "raw_index": 143,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 163,
      "raw_index": 146,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 165,
      "raw_index": 149,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 168,
      "raw_index": 151,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 174,
      "raw_index": 157,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 180,
      "raw_index": 165,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 182,
      "raw_index": 167,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 183,
      "raw_index": 170,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 186,
      "raw_index": 175,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 238,
      "raw_index": 232,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 239,
      "raw_index": 234,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 271,
      "raw_index": 271,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 295,
      "raw_index": 276,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 322,
      "raw_index": 313,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 379,
      "raw_index": 334,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 392,
      "raw_index": 346,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 467,
      "raw_index": 403,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 481,
      "raw_index": 405,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 485,
      "raw_index": 409,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 554,
      "raw_index": 491,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 558,
      "raw_index": 492,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 565,
      "raw_index": 499,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 591,
      "raw_index": 534,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 593,
      "raw_index": 537,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 631,
      "raw_index": 566,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 636,
      "raw_index": 578,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 644,
      "raw_index": 581,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 648,
      "raw_index": 582,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 649,
      "raw_index": 583,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 669,
      "raw_index": 604,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 717,
      "raw_index": 649,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 757,
      "raw_index": 650,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 775,
      "raw_index": 684,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 778,
      "raw_index": 696,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 790,
      "raw_index": 702,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 918,
      "raw_index": 851,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 919,
      "raw_index": 853,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 921,
      "raw_index": 857,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 926,
      "raw_index": 861,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 932,
      "raw_index": 862,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 221,
      "raw_index": 929,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 224,
      "raw_index": 932,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; require passing rerun."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 741,
      "raw_index": 964,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 474,
      "raw_index": 969,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 471,
      "raw_index": 971,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; require passing rerun because initial suite failed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "functions",
      "line": 409,
      "raw_index": 76,
      "classification": "realistic_failure",
      "disposition": "GAP: probe child exit with inherited pipes invokes bounded fallback. Existing init inherited-pipe test is a different phase; extend version probe behavioral test."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "functions",
      "line": 738,
      "raw_index": 172,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "functions",
      "line": 739,
      "raw_index": 173,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "functions",
      "line": 759,
      "raw_index": 174,
      "classification": "meaningful_contract_or_realistic_failure",
      "disposition": "New model/discovery boundary; delegated to model_tests; requires fresh proof after its repairs."
    },
    {
      "path": "scripts/eval/finalize-cursor-skill-eval.mjs",
      "metric": "branches",
      "line": 158,
      "raw_index": 222,
      "classification": "unreachable_defensive",
      "disposition": "result.artifact_root is already equal to the required normalized nonempty process.artifact_root by guards at 144-156; the empty driver-stdout fallback arm cannot execute."
    },
    {
      "path": "scripts/eval/finalize-cursor-skill-eval.mjs",
      "metric": "branches",
      "line": 159,
      "raw_index": 223,
      "classification": "unreachable_defensive",
      "disposition": "result.artifact_root is already equal to the required normalized nonempty process.artifact_root by guards at 144-156; the empty driver-stderr fallback arm cannot execute."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "lines",
      "line": 142,
      "raw_index": 141,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "lines",
      "line": 143,
      "raw_index": 142,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "lines",
      "line": 144,
      "raw_index": 143,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "lines",
      "line": 145,
      "raw_index": 144,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "lines",
      "line": 146,
      "raw_index": 145,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "lines",
      "line": 235,
      "raw_index": 234,
      "classification": "unreachable_defensive",
      "disposition": "Owned artifact publishers create only regular files/directories."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "branches",
      "line": 24,
      "raw_index": 3,
      "classification": "meaningful_contract",
      "disposition": "Production evaluator selected by separate authenticated hosted matrix lane."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "branches",
      "line": 141,
      "raw_index": 52,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "branches",
      "line": 158,
      "raw_index": 55,
      "classification": "realistic_failure",
      "disposition": "Foreground interruption test eval-matrix.test.mjs 206-215 verifies exit130 and no partial aggregate; empty active-child set is scheduler arm."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "branches",
      "line": 192,
      "raw_index": 59,
      "classification": "unreachable_defensive",
      "disposition": "parseScenarioCorpus admits only nonempty corpus; empty-results rate is fail-closed guard."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "metric": "branches",
      "line": 234,
      "raw_index": 69,
      "classification": "unreachable_defensive",
      "disposition": "Owned artifact publishers create only regular files/directories."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 42,
      "raw_index": 13,
      "classification": "unreachable_defensive",
      "disposition": "All admitted request/response objects come from JSON.parse through parseFrame; JSON objects cannot have a null prototype."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 51,
      "raw_index": 20,
      "classification": "unreachable_defensive",
      "disposition": "The only compactPending caller checks Array.isArray(payload.pending) first, so the non-array fallback cannot execute."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 203,
      "raw_index": 125,
      "classification": "meaningful_contract",
      "disposition": "Partial-handshake test tests/cursor-skill-eval.test.mjs:764-796 proves invalid program path disables fixture injection and preserves the original request; an omitted final operand has the same outcome."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 216,
      "raw_index": 133,
      "classification": "realistic_failure",
      "disposition": "Backpressure tests at tests/cursor-skill-eval.test.mjs:655-683 and 994-1004 prove accepted output drains before exit; queued waiters at final callback depend on scheduling."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 227,
      "raw_index": 137,
      "classification": "realistic_failure",
      "disposition": "Existing backpressure tests own wait-for-output; entering the promise arm depends on child-close versus stdout-callback scheduling."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 230,
      "raw_index": 139,
      "classification": "realistic_failure",
      "disposition": "Publication-failure test tests/cursor-skill-eval.test.mjs:867-891 owns controlled teardown without unhandled error; later queued failures are idempotent re-entry at the same boundary."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 250,
      "raw_index": 151,
      "classification": "realistic_failure",
      "disposition": "SIGTERM, SIGKILL fallback and owner-loss tests at tests/cursor-skill-eval.test.mjs:1084-1114 own child termination; repeated stop is an idempotent teardown race."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 297,
      "raw_index": 167,
      "classification": "realistic_failure",
      "disposition": "Oversized-input tests at tests/cursor-skill-eval.test.mjs:961-979 own fail-closed input teardown; later buffered stdin discard is the same boundary."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "branches",
      "line": 309,
      "raw_index": 171,
      "classification": "realistic_failure",
      "disposition": "Oversized-provider-frame and publication-failure tests at tests/cursor-skill-eval.test.mjs:867-891 and 981-992 own absence of partial output/evidence; late buffered stdout belongs to that teardown boundary."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "metric": "functions",
      "line": 227,
      "raw_index": 22,
      "classification": "realistic_failure",
      "disposition": "Backpressure tests at tests/cursor-skill-eval.test.mjs:655-683 and 994-1004 own output-drain promise; resolver callback execution is scheduler-dependent."
    }
  ]
}
```

## Final complete raw audit

Source: `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T15-57-09-347Z-coverage-c1cb839d-7f64-404e-a270-c85e184ace6a`. Read `result.json` first, then the last `test:coverage` event. Coverage supervisor verdict is passed, child exit 0, 762 passed / 1 intentional skip / 0 failed, 17 manifest sources, no diagnostics. All current source SHA-256 values match the coverage snapshot.

All 101 residual raw zero counters are classified below (6 lines, 94 branches, 1 function). Adapter has no residual zero point. The version inherited-pipe timer and previously failing mode rejection paths now execute. No unowned meaningful contract or realistic failure path was identified; no dead code or new exclusion was introduced by this audit. Existing behavior owners avoid duplicate operand-only tests. The matrix default-driver branch remains an external hosted integration owner; this local audit does not independently prove the hosted gate.

Exact identities include source hash, metric, line and raw same-line occurrence; classifications apply to this frozen report, not future line shifts.

```json
{
  "verdict": "passed",
  "tests": {
    "tests": 763,
    "failed": 0,
    "passed": 762,
    "cancelled": 0,
    "skipped": 1,
    "todo": 0,
    "topLevel": 644,
    "suites": 0
  },
  "metrics": {
    "lines": 99.9064837905237,
    "branches": 98.2041772398985,
    "functions": 99.8875140607424
  },
  "zero_counters": 101,
  "classification_counts": {
    "meaningful_contract": 36,
    "unreachable_defensive": 42,
    "realistic_failure": 23
  },
  "unclassified": 0,
  "source_hashes_match": true,
  "counters": [
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 48,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "This zero operand belongs to the same closed digest-shape validation and pre-publication invalid-digest rejection exercised by malformed snapshot, source, and artifact digest inputs; candidate-18 and candidate-19 only reorder equivalent short-circuit counters."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 58,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Every assertIdentity caller supplies identityOnly output, or published added/removed already proven byte-for-byte equal to owner-generated identities, so an identity with unexpected fields cannot reach this defensive exact-fields guard."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 96,
      "occurrence": 4,
      "classification": "meaningful_contract",
      "disposition": "This zero operand belongs to the same closed source-file metadata validation and pre-publication rejection exercised by invalid source bytes and digest inputs; candidate-18 and candidate-19 only reorder equivalent short-circuit counters."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 152,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "After exact raw file count and successful unique known-source mapping for every raw file, mapped.size must equal sources.files.length, so this defensive completeness failure cannot execute; only the raw sibling counter order changed from candidate-18."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 370,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Every evidence destination is a nonempty basename or fixed nonempty bundle filename inside outputDir, so relative(outputDir, path) cannot be empty and the basename fallback cannot execute."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 426,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "strictArtifactRef admits basename-only refs, therefore resolve(artifactRoot, ref) is lexically inside artifactRoot and this defensive escape rejection cannot execute."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 429,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "readRegular rejects symlinks and non-files before canonical containment; a basename child regular file resolves inside canonicalArtifactRoot, so this defensive canonical escape rejection cannot execute."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 238,
      "occurrence": 4,
      "classification": "meaningful_contract",
      "disposition": "Canonical normalized previous-review ordering for unique paths is exercised in both directions, while duplicate source paths are rejected by the existing malformed snapshot/review owner; comparator equality compatibility has no separate public outcome."
    },
    {
      "path": "scripts/check-openspec-semantics.mjs",
      "source_sha256": "9328c5562f7575d6ca3df9668056c941851bc13cdce95c9baffdf2aa710810a1",
      "metric": "branches",
      "line": 627,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Coverage imports this module, so its direct CLI entrypoint is not entered. Foreground Node22 scripts/check-openspec-semantics.mjs from the frozen release snapshot passed for 11 changes; the CLI entrypoint has its local import-only exclusion rationale."
    },
    {
      "path": "scripts/codex-app-server-client.mjs",
      "source_sha256": "f5fa4850c7228aa9ed4b4a0661f2d1dbabae2ffe95ec86b98e3e0ffc36cf4200",
      "metric": "branches",
      "line": 152,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "positioned timeout, confirmed-missing and late-final polling tests own returning the latest bounded capture at the deadline"
    },
    {
      "path": "scripts/codex-app-server-client.mjs",
      "source_sha256": "f5fa4850c7228aa9ed4b4a0661f2d1dbabae2ffe95ec86b98e3e0ffc36cf4200",
      "metric": "branches",
      "line": 162,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "turn-page deadline exhaustion maps to capture_timeout and is covered by the positioned slow-page test"
    },
    {
      "path": "scripts/codex-app-server-client.mjs",
      "source_sha256": "f5fa4850c7228aa9ed4b4a0661f2d1dbabae2ffe95ec86b98e3e0ffc36cf4200",
      "metric": "branches",
      "line": 191,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "item-page deadline exhaustion maps to capture_timeout and is covered by the positioned slow-page test"
    },
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "source_sha256": "6804e403c718ee7a7aa9556ee99c163c27333ae6dc7fed412d25027b6bab8347",
      "metric": "branches",
      "line": 451,
      "occurrence": 3,
      "classification": "unreachable_defensive",
      "disposition": "Admission at 424-432 requires mutually exclusive fixture_predicate shapes for inject-mode-protocol-error-once and reject-mode; their conjunction is rejected before this guard."
    },
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "source_sha256": "6804e403c718ee7a7aa9556ee99c163c27333ae6dc7fed412d25027b6bab8347",
      "metric": "branches",
      "line": 769,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "Recovery normalization first validates contiguous turn_call_ranges covering every call index through validRecoveryContext at lines 709-720 and its entry guard at 743. Therefore findIndex at 768 cannot return -1 for an iterated call. This is the same-source defensive counter previously reviewed at occurrence 2; the immediately preceding audit recorded it as occurrence 3."
    },
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "source_sha256": "6804e403c718ee7a7aa9556ee99c163c27333ae6dc7fed412d25027b6bab8347",
      "metric": "branches",
      "line": 737,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Recovery variations at tests/cursor-skill-eval.test.mjs:47-78 and 126-180 own missing/malformed argument proof and changed projections; an absent request has the same no-recovery outcome."
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 24,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "bounded callers provide normalized strings"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 387,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "pathKind and canonical parent validation reject a symlinked or foreign managed root before this canonical-directory operand can decide"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 401,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "preflight topology failures have BootstrapError code and message"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 437,
      "occurrence": 6,
      "classification": "unreachable_defensive",
      "disposition": "the admitted versioned mcp-check adapter always returns a bounded status message; preflight success and adapter-failure outcomes are tested"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 446,
      "occurrence": 7,
      "classification": "unreachable_defensive",
      "disposition": "the admitted versioned agent-status adapter always returns a bounded status message; authenticated, required and unknown outcomes are tested"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 497,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "published recovery envelopes after adapter mutation always have a journal record"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 673,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "parseArgs throws BootstrapError with a fixed error code, so the generic invalid-invocation fallback cannot decide"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 673,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "parseArgs throws BootstrapError with a fixed error code, so the generic invalid-invocation fallback cannot decide"
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 175,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Repeated killAndWait after killReason is set is an idempotence guard. The first timeout or output-limit event owns process termination, and existing package command timeout/output-limit tests verify bounded shutdown; a subsequent stop request adds no new admitted behavior."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 29,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 86,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 88,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 101,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 127,
      "occurrence": 3,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 130,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 138,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 140,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 142,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 143,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 149,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 159,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 162,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 163,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 165,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 168,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 174,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 180,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 182,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 183,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 186,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 217,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Malformed question admission table owns rejection before pending publication."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 229,
      "occurrence": 6,
      "classification": "meaningful_contract",
      "disposition": "Plan callback wire forms and malformed callback table own bounded missing/alternate plan text."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 238,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 239,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 271,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 295,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 322,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 359,
      "occurrence": 3,
      "classification": "realistic_failure",
      "disposition": "Startup abort test (model-discovery.test.mjs startup auth read shutdown/deadline) owns no spawn after shutdown; this return is a same-boundary settlement race after awaited auth."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 361,
      "occurrence": 2,
      "classification": "realistic_failure",
      "disposition": "Version probe failure/deadline and startup shutdown tests own stable tombstone and no live session after interrupted startup. This state recheck is late successful probe settlement after shutdown, with no independent output."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 472,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 486,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 490,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 559,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 563,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 570,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 596,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 598,
      "occurrence": 2,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 636,
      "occurrence": 2,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 641,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 649,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 653,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 654,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 674,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 728,
      "occurrence": 3,
      "classification": "meaningful_contract",
      "disposition": "Discovery malformed auth table rejects nonobject JSON before HTTP; individual short-circuit operand shares same public error."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 781,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Discovery shutdown, stalled auth/fetch/body deadline, rejected cancellation and late HTTP response tests own cleanup and slot release across finally completion."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 802,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Shutdown concurrent with default start test owns refusal and no allocation; initial closed guard shares this contract."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 814,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Shutdown concurrent with default resume test owns refusal and no allocation; initial closed guard shares this contract."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 383,
      "occurrence": 2,
      "classification": "realistic_failure",
      "disposition": "Startup stderr stability, bounded split UTF-8 and inherited-pipe tests own diagnostic retention; late stderr after startup cannot change published startup diagnostic."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 799,
      "occurrence": 8,
      "classification": "meaningful_contract",
      "disposition": "Runtime tombstone capacity/retention tests own bounded deterministic eviction; tie ordering operand shares existing outcome."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 221,
      "occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 224,
      "occurrence": 3,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 479,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Normalized/previously admitted internal state, synchronous transport throw guard, repeated settlement, or above-frame filesystem bound; see source and previous runtime review. No exclusion added."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 476,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing runtime malformed callback, EPIPE/closed pipe, late callback, filesystem error, and set_mode rejection tests own outcome; final suite passed."
    },
    {
      "path": "scripts/eval/finalize-cursor-skill-eval.mjs",
      "source_sha256": "37d1ad9f912b499eb8d06a16acd0d183e9d62a03f2b5a34eab3a1ce9398e89bc",
      "metric": "branches",
      "line": 158,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "result.artifact_root is already equal to the required normalized nonempty process.artifact_root by guards at 144-156; the empty driver-stdout fallback arm cannot execute."
    },
    {
      "path": "scripts/eval/finalize-cursor-skill-eval.mjs",
      "source_sha256": "37d1ad9f912b499eb8d06a16acd0d183e9d62a03f2b5a34eab3a1ce9398e89bc",
      "metric": "branches",
      "line": 159,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "result.artifact_root is already equal to the required normalized nonempty process.artifact_root by guards at 144-156; the empty driver-stderr fallback arm cannot execute."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "lines",
      "line": 142,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "lines",
      "line": 143,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "lines",
      "line": 144,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "lines",
      "line": 145,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "lines",
      "line": 146,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "lines",
      "line": 235,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Owned artifact publishers create only regular files/directories."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "branches",
      "line": 24,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Production evaluator selected by separate authenticated hosted matrix lane."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "branches",
      "line": 141,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Fallback after assertEvalResultV1 on locally synthesized canonical integration_failure cannot execute in admitted flow."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "branches",
      "line": 158,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Foreground interruption test eval-matrix.test.mjs 206-215 verifies exit130 and no partial aggregate; empty active-child set is scheduler arm."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "branches",
      "line": 192,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "parseScenarioCorpus admits only nonempty corpus; empty-results rate is fail-closed guard."
    },
    {
      "path": "scripts/eval/run-cursor-skill-eval-matrix.mjs",
      "source_sha256": "df614f7e8c2770a8e796716a1f02c753da9ee918d24f47c9e8c9bb9b6f70cd3a",
      "metric": "branches",
      "line": 234,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Owned artifact publishers create only regular files/directories."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 42,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "All admitted request/response objects come from JSON.parse through parseFrame; JSON objects cannot have a null prototype."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 51,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "The only compactPending caller checks Array.isArray(payload.pending) first, so the non-array fallback cannot execute."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 203,
      "occurrence": 1,
      "classification": "meaningful_contract",
      "disposition": "Partial-handshake test tests/cursor-skill-eval.test.mjs:764-796 proves invalid program path disables fixture injection and preserves the original request; an omitted final operand has the same outcome."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 216,
      "occurrence": 2,
      "classification": "realistic_failure",
      "disposition": "Backpressure tests at tests/cursor-skill-eval.test.mjs:655-683 and 994-1004 prove accepted output drains before exit; queued waiters at final callback depend on scheduling."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 227,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Existing backpressure tests own wait-for-output; entering the promise arm depends on child-close versus stdout-callback scheduling."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 230,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Publication-failure test tests/cursor-skill-eval.test.mjs:867-891 owns controlled teardown without unhandled error; later queued failures are idempotent re-entry at the same boundary."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 250,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "SIGTERM, SIGKILL fallback and owner-loss tests at tests/cursor-skill-eval.test.mjs:1084-1114 own child termination; repeated stop is an idempotent teardown race."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 297,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Oversized-input tests at tests/cursor-skill-eval.test.mjs:961-979 own fail-closed input teardown; later buffered stdin discard is the same boundary."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "branches",
      "line": 309,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Oversized-provider-frame and publication-failure tests at tests/cursor-skill-eval.test.mjs:867-891 and 981-992 own absence of partial output/evidence; late buffered stdout belongs to that teardown boundary."
    },
    {
      "path": "scripts/recording-mcp-proxy.mjs",
      "source_sha256": "767158d64395dda4d5fff2a563ee72458cbdd778715d9997d0b4bfc312558a63",
      "metric": "functions",
      "line": 227,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Backpressure tests at tests/cursor-skill-eval.test.mjs:655-683 and 994-1004 own output-drain promise; resolver callback execution is scheduler-dependent."
    }
  ]
}
```

## V1–V4 archive-readiness coverage audit

Read the new result first and audited the last raw `test:coverage` event: supervisor PASS, child exit 0, 766 passed / 1 intentional skip / 0 failed; no diagnostics. All 17 product source hashes still match the preceding final audit and the current files.

The complete residual set has 99 counters: 6 lines, 92 branches and 1 function. Exactly 92 identities retain their preceding classifications. The seven remaining identities were individually rechecked against source: digest/source validation, unique source-map completeness, normalized artifact containment, ACP load admission, and discovery cleanup. Their V8 same-line occurrence order changed; the explicit mapping below records the reviewed new identities rather than silently equating them. Nine old identities disappeared: seven are replaced by those occurrence mappings; question admission branch 217 and plan projection branch 229 now execute.

Apply the delta below to the preceding 101-counter matrix to reconstruct all 99 classifications. No product change, exclusion, dead code, unclassified point or new meaningful behavioral gap was found. Existing tests own the admitted contracts and failure outcomes. Hosted default-driver verification remains outside this coverage verdict.

```json
{
  "coverage_artifact": "/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T16-37-53-510Z-coverage-e8edf6d2-3512-4fd6-9feb-cd362df83018",
  "source_digest": {
    "bytes": 2314,
    "sha256": "101ba445d896b313f2013380d84de96f952d52eccb49913d84d0e88eea2b89e6"
  },
  "evidence_sha256": {
    "result.json": "ed86d3bb8c94e883d2852c06cf627989f10932ffa22bf591add904ceefb7f58a",
    "failures.jsonl": "7d99e5404c78ddde96eed44ec9dc242d82813c7ec5e65b92f3db2836126d5424",
    "tap.txt": "44822261c13ff08ef34dd0d5bba7ef73d0aab4d6a498118aa3bb67c3e63f6b36",
    "stderr.txt": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "tests": {
    "tests": 767,
    "failed": 0,
    "passed": 766,
    "cancelled": 0,
    "skipped": 1,
    "todo": 0,
    "topLevel": 646,
    "suites": 0
  },
  "metrics": {
    "lines": 99.9064837905237,
    "branches": 98.24253075571178,
    "functions": 99.8875140607424
  },
  "zero_counters": 99,
  "retained_exact_classifications": 92,
  "reclassified_occurrence_changes": [
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 48,
      "occurrence": 3,
      "previous_occurrence": 2,
      "classification": "meaningful_contract",
      "disposition": "This zero operand belongs to the same closed digest-shape validation and pre-publication invalid-digest rejection exercised by malformed snapshot, source, and artifact digest inputs; candidate-18 and candidate-19 only reorder equivalent short-circuit counters."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 96,
      "occurrence": 5,
      "previous_occurrence": 4,
      "classification": "meaningful_contract",
      "disposition": "This zero operand belongs to the same closed source-file metadata validation and pre-publication rejection exercised by invalid source bytes and digest inputs; candidate-18 and candidate-19 only reorder equivalent short-circuit counters."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 152,
      "occurrence": 2,
      "previous_occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "After exact raw file count and successful unique known-source mapping for every raw file, mapped.size must equal sources.files.length, so this defensive completeness failure cannot execute; only the raw sibling counter order changed from candidate-18."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 426,
      "occurrence": 2,
      "previous_occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "strictArtifactRef admits basename-only refs, therefore resolve(artifactRoot, ref) is lexically inside artifactRoot and this defensive escape rejection cannot execute."
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "source_sha256": "ac8e2c5b48a5e7188dad793c0178bc0531f5ca168cbef147b7f087a1fbd2a4b7",
      "metric": "branches",
      "line": 429,
      "occurrence": 3,
      "previous_occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "readRegular rejects symlinks and non-files before canonical containment; a basename child regular file resolves inside canonicalArtifactRoot, so this defensive canonical escape rejection cannot execute."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 127,
      "occurrence": 2,
      "previous_occurrence": 3,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 781,
      "occurrence": 2,
      "previous_occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Discovery shutdown, stalled auth/fetch/body deadline, rejected cancellation and late HTTP response tests own cleanup and slot release across finally completion."
    }
  ],
  "removed_raw_identities": [
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 48,
      "occurrence": 2
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 96,
      "occurrence": 4
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 152,
      "occurrence": 1
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 426,
      "occurrence": 1
    },
    {
      "path": "scripts/audit-node-coverage.mjs",
      "metric": "branches",
      "line": 429,
      "occurrence": 2
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 127,
      "occurrence": 3
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 217,
      "occurrence": 1
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 229,
      "occurrence": 6
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "metric": "branches",
      "line": 781,
      "occurrence": 1
    }
  ],
  "classification_counts": {
    "realistic_failure": 23,
    "unreachable_defensive": 42,
    "meaningful_contract": 34
  },
  "unclassified": 0,
  "new_behavioral_gaps": []
}
```

## Inventory-closure final snapshot

The final supervisor result was read before its last raw coverage event: PASS, exit 0, 766 passed / 1 intentional skip / 0 failed, no diagnostics. All 17 current product hashes match. Only `cursor-skill-eval.mjs` changed since the V1–V4 snapshot; it remains fully covered with no residual counters.

All 101 residual points are classified (6 lines, 94 branches, 1 function). The preceding 99-counter matrix retains 96 exact identities. Three same-line occurrence changes were rechecked; two reappearing bootstrap fallback operands at 429/430 were inspected through their typed error producers and classified unreachable defensive. Apply the explicit delta below to the preceding matrix. There are no new meaningful gaps or exclusions; hosted evidence remains a separate gate.

```json
{
  "coverage_artifact": "/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-09T16-43-12-332Z-coverage-94922a89-1f12-49bc-94ff-f4d6121fd0ac",
  "source_digest": {
    "bytes": 2314,
    "sha256": "e684465d4584332eb326ae8bb8d11ae37d1bb392d20e8a98b0b981311827364f"
  },
  "changed_source": {
    "path": "scripts/cursor-skill-eval.mjs",
    "bytes": 9910,
    "sha256": "5cd8efa25f3e89466669fdd459a384d30b69529866930461bfcfcd3310d4b297"
  },
  "current_source_hashes_match": true,
  "evidence_sha256": {
    "result.json": "84bf519a84d5f714d68ddb3881db30cc9a0d85eb88915c3474d40a7bd47a2c31",
    "failures.jsonl": "5c811eb15019b1f6c5f7ac0864526e95592264d85e5792349a6af63825b3490a",
    "tap.txt": "a285c630681d8c2b3f1ead38b39c7b7ed04cadaf2651d65d59a54621b667e041",
    "stderr.txt": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "tests": {
    "tests": 767,
    "failed": 0,
    "passed": 766,
    "cancelled": 0,
    "skipped": 1,
    "todo": 0,
    "topLevel": 646,
    "suites": 0
  },
  "metrics": {
    "lines": 99.9065129323777,
    "branches": 98.20452771272443,
    "functions": 99.8875140607424
  },
  "zero_counters": 101,
  "retained_exact_classifications": 96,
  "added_classifications": [
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "source_sha256": "6804e403c718ee7a7aa9556ee99c163c27333ae6dc7fed412d25027b6bab8347",
      "metric": "branches",
      "line": 451,
      "occurrence": 2,
      "classification": "unreachable_defensive",
      "disposition": "Admission at 424-432 requires mutually exclusive fixture_predicate shapes for inject-mode-protocol-error-once and reject-mode; their conjunction is rejected before this guard."
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 429,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Registration list failures are normalized by invokeAdapter/listRegistrations to BootstrapError with a nonempty code; validOwnedRoot failures are caught locally. Therefore the missing error.code fallback cannot decide in the admitted command runner flow. Malformed registration and list failure tests own the surrounding fail-closed diagnostics."
    },
    {
      "path": "scripts/cursor-subagent-bootstrap.mjs",
      "source_sha256": "7e119121ad8483dd97a98b3bd7a97939ac233b7c2b052211a7fe9591ef7a0e84",
      "metric": "branches",
      "line": 430,
      "occurrence": 1,
      "classification": "unreachable_defensive",
      "disposition": "Registration list failures are normalized by invokeAdapter/listRegistrations to BootstrapError with a nonempty code; validOwnedRoot failures are caught locally. Therefore the missing error.code fallback cannot decide in the admitted command runner flow. Malformed registration and list failure tests own the surrounding fail-closed diagnostics."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 127,
      "occurrence": 3,
      "classification": "meaningful_contract",
      "disposition": "Existing runtime invalid adapter/collaboration/pending tables, eviction, closed-runtime and set_mode tests own outcome; final suite passed."
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 781,
      "occurrence": 1,
      "classification": "realistic_failure",
      "disposition": "Discovery shutdown, stalled auth/fetch/body deadline, rejected cancellation and late HTTP response tests own cleanup and slot release across finally completion."
    }
  ],
  "removed_raw_identities": [
    {
      "path": "scripts/cursor-eval-scenario.mjs",
      "source_sha256": "6804e403c718ee7a7aa9556ee99c163c27333ae6dc7fed412d25027b6bab8347",
      "metric": "branches",
      "line": 451,
      "occurrence": 3
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 127,
      "occurrence": 2
    },
    {
      "path": "scripts/cursor-subagent-mcp.mjs",
      "source_sha256": "039f8449388b97de48bc032438fb2a11448c15cc8d075eb9b6b2149638de285e",
      "metric": "branches",
      "line": 781,
      "occurrence": 2
    }
  ],
  "classification_counts": {
    "realistic_failure": 23,
    "meaningful_contract": 34,
    "unreachable_defensive": 44
  },
  "unclassified": 0,
  "new_behavioral_gaps": []
}
```
