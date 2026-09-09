import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, normalizeManifestBytes, treeHashV1 } from '../scripts/cursor-subagent-bootstrap.mjs';

test('canonical manifest normalization sorts objects recursively and preserves arrays', () => {
  const normalized = normalizeManifestBytes('{"z":{"b":2,"a":1},"version":"1.2.3+codex.old","a":[{"z":1,"a":2},1]}');
  assert.equal(normalized.baseVersion, '1.2.3');
  assert.equal(normalized.bytes.toString(), '{"a":[{"a":2,"z":1},1],"version":"1.2.3","z":{"a":1,"b":2}}');
  assert.throws(() => normalizeManifestBytes('{"version":"1.2.3+foreign.1"}'), { code: 'invalid_manifest' });
  for (const version of ['1.2.3-01', '1.2.3-a..b', '1.2.3-', '1.2.3+codex.', '01.2.3']) {
    assert.throws(() => normalizeManifestBytes(JSON.stringify({ version })), { code: 'invalid_manifest' }, version);
  }
  assert.equal(canonicalJson({ b: [2, 1], a: true }), '{"a":true,"b":[2,1]}');
  assert.throws(() => canonicalJson(undefined), { code: 'invalid_json' });
  assert.throws(() => normalizeManifestBytes('[]'), { code: 'invalid_manifest' });
  assert.throws(() => normalizeManifestBytes('{}'), { code: 'invalid_manifest' });
  assert.equal(normalizeManifestBytes('{"version":"1.2.3-rc.1"}').baseVersion, '1.2.3-rc.1');
});

test('treeHashV1 has a stable byte-framed golden vector', () => {
  assert.equal(treeHashV1([{ path: 'b', content: 'two' }, { path: 'a', content: 'one' }]), 'b7cfd8f25704e2e9e7d848116d1f8a90458415103d8972181996f5b8b815d1a7');
  assert.throws(() => treeHashV1([{ path: '../escape', content: '' }]), { code: 'invalid_hash_entry' });
  assert.throws(() => treeHashV1([{ path: 'same', content: '' }, { path: 'same', content: '' }]), { code: 'invalid_hash_entry' });
});
