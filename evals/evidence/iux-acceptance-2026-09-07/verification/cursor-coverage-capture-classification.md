# Codex app-server client final zero-counter classification

Source: `verification/test-speed/final-series/coverage-zero-counters.json`, the
first final-series green coverage queue for the frozen source candidate. It
reports no zero-count lines or functions and three zero-count branches for
`scripts/codex-app-server-client.mjs`. Line numbers refer to that snapshot.

| Zero branch | Classification | Evidence and disposition |
|---|---|---|
| 152 | `observable_contract_already_owned` | The second deadline check avoids one zero-delay loop before returning the latest `turn_not_found`, `turn_not_terminal`, or `confirmed_missing` capture. The loop-entry deadline check returns the same public record. Existing absent, nonterminal, and late-final tests own those observable outcomes; forcing the timing between the two checks would assert scheduler placement rather than another contract. |
| 162 | `realistic_failure_already_owned` | Per-turn-page remaining-time exhaustion maps to `capture_timeout`. The positioned slow turns-page test proves the public deadline, source, and error-code contract through the real request timer. Hitting this exact pre-request guard would assert a private clock-call boundary rather than another outcome. |
| 191 | `realistic_failure_already_owned` | Per-item-page remaining-time exhaustion maps to `capture_timeout`. The positioned slow items-page test proves the public deadline, `thread/items/list` source, and error code through the real request timer. A separate assertion on this exact guard would duplicate that behavior. |

No zero-count line or function remains. No branch is dead code and no coverage
exclusion is justified. All three counters map to tested public outcomes and
should not receive private clock-call tests.

## Supplemental closure

- The former heterogeneous-item branch, now at line 202, is covered by the
  existing paginated-final scenario: its first
  item page contains a realistic non-agent `reasoning` item followed by
  commentary, and the second page still yields the exact final.
- The constructor now accepts narrow `now` and `sleep` dependencies used only by
  capture polling; production defaults remain `Date.now` and a `setTimeout`
  promise. Late, confirmed-missing, and nonterminal tests initialize their real
  transports and advance a deterministic capture clock, so process startup and
  scheduler load cannot choose the semantic outcome. The slow-page test also
  initializes both transports, then positions its deterministic capture clock so
  the real 100 ms request timer begins at the intended slow turns/items RPC; the
  fixture responds after 500 ms. This preserves the real transport timeout proof
  without letting process startup select the failure source.
- Targeted supervisor command:
  `node scripts/run-node-tests.mjs unit --test tests/codex-app-server-client.test.mjs`
  -> PASS, 38/38 tests, artifact
  `/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-06T22-38-37-186Z-unit-dd246a29-6509-4e94-a6a0-e88088036b5a`.

The first final-series coverage queue confirms that the heterogeneous-item
branch is covered and that the final client work queue has no remaining
meaningful untested branch.
