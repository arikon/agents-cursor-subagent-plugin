import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLiveOutcome, exactPermission, terminalAgentError } from './release-e2e-oracle-support.mjs';

test('live canary admits at most one exact-path permission', () => {
  const marker = '/tmp/exact-marker';
  const turn = { pending: [{ request_id: 'one', kind: 'permission', context: { locations: [{ path: { text: marker } }] } }] };
  assert.equal(exactPermission(turn, marker, false).request_id, 'one');
  assert.throws(() => exactPermission(turn, marker, true), /unexpected pending request/);
  assert.throws(() => exactPermission(turn, '/tmp/other', false), /outside the exact marker path/);
});

test('live result classifier covers every terminal outcome deterministically', () => {
  assert.deepEqual(classifyLiveOutcome({ enabled: false }), { status: 'skipped' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, failure: 'boom', closeSucceeded: true }), { status: 'integration_failure', message: 'boom' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, closeSucceeded: false }), { status: 'integration_failure', message: 'finally close failed' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, closeSucceeded: true, markerMatches: false }), { status: 'agent_behavior_mismatch' });
  assert.deepEqual(classifyLiveOutcome({ enabled: true, closeSucceeded: true, markerMatches: true }), { status: 'pass' });
  assert.equal(terminalAgentError({ result: { text: '\nError: RetriableError' } }), true);
  assert.equal(terminalAgentError({ result: { text: 'Created the marker.' } }), false);
});

