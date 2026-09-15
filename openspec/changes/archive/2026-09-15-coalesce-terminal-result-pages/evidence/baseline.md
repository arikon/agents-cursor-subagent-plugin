# Delivery baseline

The matrix under `measurements/` records three foreground baseline-main runs for
each fixture, at concurrency 1 on Node v26.8.2/darwin. Every run selects one
deterministic terminal-result-delivery scenario, executes it once, skips none,
and stores hashes, bytes and MCP wire sizes only.

| Fixture | Calls | Delivered text bytes | Serialized MCP JSON bytes |
|---|---:|---:|---:|
| Empty | 1 | 0 | 606 |
| ASCII 7,999 | 1 | 7,999 | 8,605 |
| Archived 8,353 | 3 | 16,352 | 18,056 |
| ASCII 16,353 | 4 | 24,353 | 25,969 |
| ASCII 18,000 | 4 | 26,000 | 27,616 |
| ASCII 18,001 | 4 | 26,001 | 27,617 |

The measurement fields are stable across the three runs per fixture: fixture/full-result
digest, runtime, skill, adapter, calls and wire bytes. Opaque terminal receipt
IDs are intentionally excluded from that comparison. Baseline runtime is
`8bde75690138820d0e41fb648ba9a88549b38cb9a9115a373f2abe4fb85fe5b5`; its
skill is `ae46e1d428ed3d518746fbf039929df23b256557075a3ac2bd06e35a9d3074fc`.
The original three 8,353-byte artifacts remain as historical evidence.

The old sequence is a terminal `cursor_wait` preview, then reads beginning at
offset zero while that preview is truncated. This metric excludes compact's
skill-body/request measurement and makes no token or latency claim.

Existing assertion owners: runtime page boundaries and retention are `tests/runtime-callbacks-results.test.mjs`; repeatable/pinned wait behavior and receipts are `tests/runtime-lifecycle.test.mjs`; public wire shape is `tests/mcp-transport.test.mjs`; delivered-page proof is `tests/cursor-skill-eval.test.mjs` plus `tests/codex-client-oracle-support.mjs`; installed composition and canary are `tests/codex-client-integration.test.mjs` and `tests/release-e2e.test.mjs`.
