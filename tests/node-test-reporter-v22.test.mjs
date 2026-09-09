import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import nodeTestReporter from '../scripts/node-test-reporter-v22.mjs';

async function* events(...items) {
  yield* items;
}

async function render(...items) {
  const chunks = [];
  for await (const chunk of nodeTestReporter(events(...items))) chunks.push(chunk);
  return chunks.join('');
}

test('reporter replays the Node 22.23.1 golden events as ordered supervisor JSONL', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./fixtures/node-test-reporter-v22.23.1.golden.json', import.meta.url),
    'utf8',
  ));
  const output = await render(...fixture.input_events);

  assert.deepEqual(
    output.trimEnd().split('\n').map((line) => JSON.parse(line)),
    fixture.expected_records,
  );
  assert.equal(output.endsWith('\n'), true);
});

test('reporter preserves actionable Error diagnostics in event payloads', async () => {
  const rootCause = new TypeError('invalid frame');
  const failure = new Error('request failed', { cause: rootCause });

  const output = await render({
    type: 'test:fail',
    data: {
      name: 'handles request',
      details: { error: failure },
      related: [rootCause],
    },
  });
  const record = JSON.parse(output);

  assert.equal(record.type, 'test:fail');
  assert.equal(record.data.name, 'handles request');
  assert.deepEqual(
    {
      name: record.data.details.error.name,
      message: record.data.details.error.message,
      cause: {
        name: record.data.details.error.cause.name,
        message: record.data.details.error.cause.message,
      },
      related: {
        name: record.data.related[0].name,
        message: record.data.related[0].message,
      },
    },
    {
      name: 'Error',
      message: 'request failed',
      cause: { name: 'TypeError', message: 'invalid frame' },
      related: { name: 'TypeError', message: 'invalid frame' },
    },
  );
  assert.match(record.data.details.error.stack, /Error: request failed/);
  assert.match(record.data.details.error.cause.stack, /TypeError: invalid frame/);
});
