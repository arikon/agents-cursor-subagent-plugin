# Bootstrap final zero-counter classification

Source: `evals/evidence/iux-acceptance-2026-09-07/verification/test-speed/final-series/coverage-zero-counters.json`,
the first final-series green coverage snapshot for
`scripts/cursor-subagent-bootstrap.mjs`. It reports no zero-count lines or
functions and exactly ten zero-count branch counters. Repeated line numbers
denote distinct raw counters and are retained explicitly.

| Zero branch | Classification | Evidence and disposition |
|---|---|---|
| 24 | `unreachable_defensive` | `bounded` accepts a nullish value defensively, while every admitted call supplies a normalized diagnostic string or `Error.message`. A direct private-helper test with null would not verify a supported bootstrap outcome. |
| 387 | `unreachable_defensive` | `preflightTopology` first proves the parent is canonical. A symlink at `managedRoot` is already `foreign` at line 386; an ancestor symlink is rejected by `canonicalDirectory(parent)`. Therefore `kind === 'directory'` with `realpath(managedRoot) !== managedRoot` cannot occur through admitted normalized input. |
| 401 | `unreachable_defensive` | The caught `preflightTopology` failures are `BootstrapError` values created by `fail`, with a nonempty `code` and `message`. The `||` fallback protects future/nonconforming errors; public file, symlink, and missing-parent topology failures already verify the emitted check. |
| 429 | `unreachable_defensive` | `listRegistrations` can fail only through `invokeAdapter` or its explicit shape check; both use `fail` and therefore supply a nonempty `BootstrapError.code`. The `adapter_failure` fallback cannot be reached through the admitted dependency contract. |
| 430 | `unreachable_defensive` | This is the second evaluation of the same `error.code || 'adapter_failure'` expression for the paired plugin-registration check. It has the same closed provenance as branch 429 and no independent observable behavior. |
| 437 | `unreachable_defensive` | The default MCP-check text is used only if a conforming adapter result omits `message`; admitted versioned adapters always return a message for both found and missing configuration. Existing ready, missing-config, and adapter-failure tests own the public statuses. |
| 446 | `unreachable_defensive` | The default agent-status text is used only if the admitted adapter omits `message`; the versioned adapter returns a message for authenticated, required, unknown, and version-drift results. Existing authentication-state tests cover the public outcomes. |
| 497 | `unreachable_defensive` | `journal.at(-1)?.operation || null` supports recovery before any adapter mutation. Current `recoveryEnvelope` paths after registration work have a journal entry; pre-registration publication failures either cleanly fail or expose their artifact path through a dedicated `BootstrapError`. Manufacturing an empty-journal `recoveryEnvelope` requires a private internal call or a filesystem race without an injectable public boundary. |
| 673 (two counters) | `unreachable_defensive` | `parseArgs` throws only `BootstrapError` through `invalid`, so `error.exitCode || 2` and `error.code || 'invalid_invocation'` cannot select their fallback arms. The former third counter, public `argv[0] || null`, is absent from this raw queue after the no-argument CLI regression covered it. |

No zero-count line or function remains. All ten residual branches are defensive
fallbacks or short-circuit details whose tests would require private injection
and would not add an observable supported contract.

## Supplemental closure

The five meaningful gaps are now covered through existing public scenarios:

- line 366: startup with an exact marketplace-only registration returns
  `recovery_required` without mutation;
- line 413: preflight with a missing Codex executable reports
  `missing_dependency`, leaves adapter-owned checks `not_checked`, and completes
  independent checks;
- line 482: a side-effect-only publication fault removes the backup marker before
  cleanup, which returns `cleanup_required` and preserves the foreign backup;
- line 574: an identical update returns `installed` and removes its staging tree;
- line 673: a no-argument CLI invocation returns exit 2 with `operation: null` and
  `invalid_invocation`.

Focused supervisor command:

```sh
node scripts/run-node-tests.mjs unit --test tests/bootstrap.test.mjs --test-name-pattern 'CLI returns one machine-readable invalid-invocation envelope|CLI preflight reports an absent managed installation without creating it|fake adapter drives portable install, identical no-op, update, preflight and uninstall|backup and registration recovery classification distinguishes owned deltas from foreign drift|pre-commit publication rename faults compensate install and update while uninstall commit fault is cleanup_required'
```

It passed 5/5 selected tests. Supervisor artifact:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-06T22-15-01-160Z-unit-089171c6-ec51-47ce-9fc6-ac8c97ea7ebd`.

The fresh final-series bootstrap work queue has no remaining meaningful untested
branch. Previously meaningful branches `366`, `413`, `482`, `574`, and the
`argv[0]` counter at `673` are absent from the exact current raw queue.
