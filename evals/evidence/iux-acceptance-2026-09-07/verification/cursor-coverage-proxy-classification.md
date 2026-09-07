# Recording MCP proxy final zero-counter classification

Source queue:
`evals/evidence/iux-acceptance-2026-09-07/verification/test-speed/final-series/coverage-zero-counters.json`.

Deduplicated product path: `scripts/recording-mcp-proxy.mjs`.

The first final-series coverage run passed. For this product file the exact raw
queue contains no zero-count lines, eight zero-count branches at lines
`45,187,200,211,214,234,278,290`, and one zero-count anonymous function at line
`211`.

## Meaningful contract closed before this snapshot

- The former branch `101` was the public `cursor_read_result` default-offset path:
  `entry.request.offset ?? 0`. The regression suite proves sequential reads,
  explicit offset zero, restart, EOF, invalid pages, changed content and broken
  sequences. The first successful page in the aggregate black-box case now
  omits request `offset` while the valid response reports `payload.offset:0`;
  the following page proves the same compact sequential evidence as the
  explicit-zero path. The separate invalid response also continues to omit the
  request offset. No product repair was needed.

## Unreachable defensive branches

- Branch `45`: `compactPending` rejects a non-array, while its sole caller
  invokes it only after `Array.isArray(payload.pending)`. The fallback cannot be
  reached through the supported call path.
- Branch `187`: this counter is the `|| ''` fallback inside the last
  `isAbsolute(CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH || '')` handshake term. Complete
  absolute handshake and nonempty relative-path rejection are both covered.
  With a missing program variable, ordinary calls short-circuit on earlier
  absent handshake fields; forcing all earlier fields solely to reach the empty
  fallback adds no behavior beyond the covered relative-path rejection.
- Branch `214`: repeated `failProxy` entry is an idempotence guard for concurrent
  terminal races. The first failure destroys proxy input and stops the child;
  the guard has no separate supported output.
- Branch `234`: repeated `stopChild` entry is an idempotence guard. Child
  ownership loss, SIGTERM, and SIGKILL fallback are already behavior-tested.
- Branches `278` and `290`: late stdin/stdout data callbacks after proxy failure
  are discarded. Frame-failure tests prove fail-closed output and absence of a
  partial artifact; deterministically triggering these counters would expose
  event-loop scheduling rather than another public result.

## Realistic output-flush path already covered by behavior

- Branch `200`: resolve queued output-write waiters when the pending count
  reaches zero.
- Branch `211` and its zero-count anonymous function: create and resolve the
  waiter promise when the child `close` handler observes an output write still
  pending.

These counters describe one scheduler ordering inside the real output-flush
boundary. The suite already verifies both relevant observable outcomes:
publication waits until backpressured child output is consumed, and a
backpressured final response is fully flushed before exit. On the measured Node
runtime, the write callback completes before the child `close` handler calls
`waitForOutputWrites`, so the promise arm and its resolver remain at zero. This
is not an untested output-flush error: forcing that ordering would require a
private timing hook and would duplicate the existing behavior proof.

## Dead code

No residual whole line or function is dead. Branch `45` is locally redundant
defense; the remaining defensive branches protect asynchronous races or a
closed fault-handshake shape.

## Closure

Every zero counter in the exact current raw queue is classified. Branch `101`
is no longer a zero counter, confirming closure of the sole prior meaningful
missing path. No product repair is indicated by this final-series evidence.

Focused verification after the repair:

`node scripts/run-node-tests.mjs unit --test tests/cursor-skill-eval.test.mjs --test-name-pattern "recording proxy proves only an exact sequential full-result read through EOF"`

Result: `PASS unit` in 221 ms. Artifact directory:
`/var/folders/v3/dh1xwm491q99px47z44n4psm0000gn/T/codex-node-test-artifacts/2026-09-06T22-11-27-673Z-unit-388496f6-1f42-4ad2-810b-b2847439ea71`.


## Candidate 05 optional expected digest

The first passing candidate-05 coverage queue added branch 71, the omitted/empty expected-plugin digest path. This is a meaningful optional-evidence contract: provided roots must still be counted, but no match assertion may be invented without an expected digest, and raw paths must remain absent from evidence. One additional subprocess in the existing launch-metadata test now verifies exactly these outcomes; no product change or duplicate digest assertions were added. Targeted verification passed in 3492 ms and is retained at `candidate-05/proxy-unit/result.json`.
