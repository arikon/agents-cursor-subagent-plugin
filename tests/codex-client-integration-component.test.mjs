import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureProviderAppServerArgs, hostedAppServerConfig, resolveHostedAuthFile } from './codex-client-oracle-support.mjs';

test('credential-free app-server adapter pins the custom provider to the observed fixture endpoint', () => {
  assert.deepEqual(fixtureProviderAppServerArgs('http://127.0.0.1:43123/'), [
    'app-server', '--stdio', '-c', 'features.apps=true', '-c', 'model_provider="fixture_ollama"',
    '-c', 'model="qwen2.5-coder:7b"', '-c', 'model_providers.fixture_ollama.name="Fixture Ollama"',
    '-c', 'model_providers.fixture_ollama.base_url="http://127.0.0.1:43123/v1"',
    '-c', 'model_providers.fixture_ollama.wire_api="responses"',
  ]);
});

test('hosted app-server config safely pins an explicit model and effort', () => {
  assert.deepEqual(hostedAppServerConfig({ CURSOR_EVAL_HOSTED_MODEL: 'gpt-5.6-terra', CURSOR_EVAL_HOSTED_REASONING_EFFORT: 'medium' }), {
    args: ['app-server', '--stdio', '-c', 'features.apps=true', '-c', 'model="gpt-5.6-terra"', '-c', 'model_reasoning_effort="medium"'],
    model: { provider: null, name: 'gpt-5.6-terra' },
  });
  assert.throws(() => hostedAppServerConfig({ CURSOR_EVAL_HOSTED_MODEL: 'bad[value]' }), /HOSTED_MODEL is invalid/);
});

test('hosted credential resolution supports explicit and portable paths with a clear missing preflight', async () => {
  const seen = [];
  const accessFile = async (path) => { seen.push(path); };
  assert.equal(await resolveHostedAuthFile({ CURSOR_EVAL_AUTH_FILE: '/fixture/auth.json' }, { access: accessFile, homedir: () => '/portable/home' }), '/fixture/auth.json');
  assert.equal(await resolveHostedAuthFile({}, { access: accessFile, homedir: () => '/portable/home' }), '/portable/home/.codex/auth.json');
  await assert.rejects(resolveHostedAuthFile({}, { access: async () => { throw new Error('missing'); }, homedir: () => '/portable/home' }),
    (error) => /set CURSOR_EVAL_AUTH_FILE/.test(error.message) && !error.message.includes('/portable/home'));
  assert.deepEqual(seen, ['/fixture/auth.json', '/portable/home/.codex/auth.json']);
});

