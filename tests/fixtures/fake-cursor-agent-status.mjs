#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (process.env.FAKE_CURSOR_AGENT_LOG) await appendFile(process.env.FAKE_CURSOR_AGENT_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_CURSOR_AGENT_PID_PATH) await appendFile(process.env.FAKE_CURSOR_AGENT_PID_PATH, `${process.pid}\n`);
if (process.env.FAKE_CURSOR_AGENT_BLOCK_ARGV === args.join(' ')) await new Promise(() => setInterval(() => {}, 1_000));
if (process.env.FAKE_CURSOR_AGENT_OVERFLOW_ARGV === args.join(' ')) process.stdout.write('x'.repeat(1_048_577));
else if (args.join(' ') === '--version') process.stdout.write(`${process.env.FAKE_CURSOR_AGENT_VERSION || '2026.08.25-3e8eec8'}\n`);
else if (args.join(' ') !== 'status --format json') {
  process.stderr.write(`unexpected Cursor Agent argv: ${args.join(' ')}\n`);
  process.exitCode = 2;
} else {
  const status = process.env.FAKE_CURSOR_AGENT_STATUS || 'authenticated';
  const documents = {
    authenticated: { status, isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true, userInfo: { email: 'fixture@example.invalid' } },
    unauthenticated: { status, isAuthenticated: false, hasAccessToken: false, hasRefreshToken: false, message: 'Not logged in' },
    'partially-authenticated': { status, isAuthenticated: false, hasAccessToken: true, hasRefreshToken: false, message: 'Partially authenticated (missing refresh token)' },
    error: { status, message: 'Status check error: fixture failure' },
  };
  process.stdout.write(JSON.stringify(documents[status] || { status }));
  if (status === 'error') process.exitCode = 1;
}
