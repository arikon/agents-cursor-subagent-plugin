#!/usr/bin/env node

if (process.env.FAKE_ACP_EXPECT_CODEX_HOME && process.env.CODEX_HOME !== process.env.FAKE_ACP_EXPECT_CODEX_HOME) {
  process.stderr.write('isolated CODEX_HOME was not propagated to ACP\n');
  process.exit(9);
}
await import('./fake-acp.mjs');
