#!/usr/bin/env node

process.env.CURSOR_EVAL_ADMITTED_CODEX_VERSION = '0.153.4';
await import('./codex-v01521-adapter.mjs');
