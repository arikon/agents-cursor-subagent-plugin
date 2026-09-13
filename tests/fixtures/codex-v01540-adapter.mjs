#!/usr/bin/env node

process.env.CURSOR_EVAL_ADMITTED_CODEX_VERSION = '0.154.0-alpha.6.2';
await import('./codex-v01521-adapter.mjs');
