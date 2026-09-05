import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const reporterPath = process.argv[3];

if (mode === 'descendant') {
  process.send?.({ type: 'descendant-ready', pid: process.pid });
  setInterval(() => {}, 1_000);
} else if (mode === 'owned-parent' || mode === 'sibling') {
  let descendant = null;
  if (mode === 'owned-parent') {
    descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const descendantPid = await new Promise((resolve, reject) => {
      descendant.once('error', reject);
      descendant.once('message', (message) => {
        if (message?.type === 'descendant-ready') resolve(message.pid);
      });
    });
    await writeFile(reporterPath, `${JSON.stringify({
      type: 'test:summary',
      data: { tests: 1, passed: 0, failed: 1 },
    })}\n`);
    process.send?.({ type: 'ready', pid: process.pid, descendantPid });
  } else {
    process.send?.({ type: 'ready', pid: process.pid });
  }

  process.on('message', (message) => {
    if (message?.type === 'ping') process.send?.({ type: 'pong', pid: process.pid });
  });
  setInterval(() => {}, 1_000);
} else {
  process.stderr.write(`unsupported fixture mode: ${mode}\n`);
  process.exitCode = 2;
}
