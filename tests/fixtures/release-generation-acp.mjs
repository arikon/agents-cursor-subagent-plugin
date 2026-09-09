import { writeFileSync } from 'node:fs';

// Package acceptance observes actual child termination across installation generations.
writeFileSync(process.env.RELEASE_ACP_PID_PATH, String(process.pid));
await import('./release-fake-acp.mjs');
