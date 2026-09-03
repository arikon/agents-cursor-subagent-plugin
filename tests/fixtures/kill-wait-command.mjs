#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

await writeFile(process.env.KILL_WAIT_PID_PATH, String(process.pid));
if (process.env.KILL_WAIT_OVERFLOW === '1') process.stdout.write('x'.repeat(1024));
await new Promise(() => setInterval(() => {}, 1_000));
