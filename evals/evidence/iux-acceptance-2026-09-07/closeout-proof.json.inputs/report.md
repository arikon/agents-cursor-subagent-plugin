# Cursor subagent: hosted eval matrix, 2026-09-06

This is a comparative reliability snapshot of the same frozen 24-scenario
corpus. It is not a release gate: the release gate is the `gpt-5.6-sol` / low
acceptance run. Every run used eight isolated workers and the same skill and
corpus digests (`digest_stable: true`).

| Model | Effort | Passed | Behavior mismatch | Integration failure | Pass rate | Wall time |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| gpt-5.6-sol | low | 24/24 | 0 | 0 | 100.0% | 4m 56s |
| gpt-5.6-terra | low | 14/24 | 7 | 3 | 58.3% | 4m 17s |
| gpt-5.6-terra | medium | 15/24 | 6 | 3 | 62.5% | 4m 24s |
| gpt-5.6-terra | high | 21/24 | 3 | 0 | 87.5% | 4m 49s |
| gpt-5.6-luna | low | 13/24 | 11 | 0 | 54.2% | 3m 29s |
| gpt-5.6-luna | medium | 12/24 | 10 | 2 | 50.0% | 8m 40s |
| gpt-5.6-luna | high | 15/24 | 9 | 0 | 62.5% | 6m 11s |

The two Luna/medium integration failures occurred while network connectivity
was intermittent, so they are reported separately and are not classified as
skill-behavior mismatches.

Reproduce a row with:

```sh
CURSOR_EVAL_HOSTED_CODEX=1 \
  node scripts/eval/run-cursor-skill-eval-matrix.mjs \
  <model> <low|medium|high> /private/tmp/cursor-eval-matrix-<name>.json
```

The runner emits `scenario_started`, periodic `scenario_progress`,
`scenario_completed`, and `matrix_completed` JSONL events. The JSON output
contains each scenario result and the frozen skill/corpus digests.
