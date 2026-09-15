# Candidate delivery measurement

The matrix under `measurements/` records three foreground candidate-working-tree
runs for every baseline fixture and action order. Each ran on Node v26.8.2,
darwin, at concurrency 1, with one selected/executed deterministic scenario,
no skipped scenarios and no model invocation. The harness retains no fixture
text.

| Fixture | Baseline calls/text/wire | Candidate calls/text/wire |
|---|---:|---:|
| Empty | 1 / 0 / 606 | 1 / 0 / 817 |
| ASCII 7,999 | 1 / 7,999 / 8,605 | 1 / 7,999 / 8,819 |
| Archived 8,353 | 3 / 16,352 / 18,056 | 1 / 8,353 / 9,390 |
| ASCII 16,353 | 4 / 24,353 / 25,969 | 2 / 16,353 / 17,511 |
| ASCII 18,000 | 4 / 26,000 / 27,616 | 2 / 18,000 / 19,158 |
| ASCII 18,001 | 4 / 26,001 / 27,617 | 3 / 18,001 / 19,499 |

The measurement fields are stable across all three candidate runs per fixture:
fixture/full-result digest, runtime, skill, adapter, calls and wire bytes.
Opaque terminal receipt IDs are intentionally excluded from that comparison.
Candidate runtime is
`d9881182fdb7ab25d062beae9352ebd5605a20919ed9a36a638d16220dc30309`; its
skill is `1a3cf790bab6953aa8ca9c0c263119123270befc34c0c9bcaa9b70cb8532d11d`.

For every result at or below the 10,000-byte maximum, the candidate returns the
remaining result in the current page. The receipt retains its independent
preview digest and is not used as the full-result digest. These measurements
establish delivery-call and wire-byte differences only; they make no token or
latency claim.
