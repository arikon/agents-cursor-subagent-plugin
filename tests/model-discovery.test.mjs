import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Runtime } from '../scripts/cursor-subagent-mcp.mjs';

const golden = () => JSON.parse(readFileSync(new URL('./fixtures/cursor-model-catalog-1.0.31.json', import.meta.url), 'utf8'));
const jsonResponse = (value) => new Response(JSON.stringify(value));
function discovery(t, overrides = {}) {
  const runtime = new Runtime({ roots: [process.cwd()], readModelAuth: async () => '{"apiKey":"fixture-secret"}',
    fetchModels: async () => jsonResponse(golden().response), ...overrides });
  t.after(() => runtime.shutdown());
  return runtime;
}
const failed = { error_code: 'model_discovery_failed' };

test('discovery projects official golden schema, preserves provider order and ignores unknown fields', async (t) => {
  const fixture = golden();
  fixture.response.extra = { ignored: true };
  fixture.response.items[0].futureField = 'ignored';
  const runtime = discovery(t, { fetchModels: async () => jsonResponse(fixture.response) });
  assert.deepEqual(await runtime.call('cursor_list_models', {}), fixture.expected);
  assert.equal(runtime.sessions.size, 0);
});

test('discovery accepts only exact empty object before reading credentials or calling provider', async (t) => {
  const runtime = discovery(t, { readModelAuth: async () => assert.fail('credentials must not be read') });
  for (const input of [null, [], 'x', { cwd: process.cwd() }, { model: 'auto' }]) {
    await assert.rejects(runtime.call('cursor_list_models', input), { error_code: 'invalid_args' });
  }
});

test('discovery rereads only auth apiKey and fresh HTTP catalog, without redirects or retries', async (t) => {
  let count = 0;
  const runtime = discovery(t, {
    readModelAuth: async (path) => {
      assert.match(path, /[\\/]\.cursor[\\/]auth\.json$/);
      return JSON.stringify({ apiKey: `key-${++count}`, accessToken: 'must-not-use' });
    },
    fetchModels: async (url, options) => {
      assert.equal(String(url), 'https://api.cursor.com/v1/models');
      assert.equal(options.method, 'GET');
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer key-${count}`);
      assert.equal(options.redirect, 'error');
      const response = golden().response;
      response.items[0].displayName = `Свежая модель ${count}`;
      return jsonResponse(response);
    },
  });
  assert.equal((await runtime.call('cursor_list_models', {})).models[0].name, 'Свежая модель 1');
  assert.equal((await runtime.call('cursor_list_models', {})).models[0].name, 'Свежая модель 2');
  assert.equal(count, 2);
});

for (const [label, auth] of Object.entries({ missing: '{}', blank: '{"apiKey":"  "}', nonstring: '{"apiKey":123}', tokenOnly: '{"accessToken":"private"}', invalidJSON: '{private', nul: JSON.stringify({ apiKey: 'PRIVATE-key\0suffix' }), surrogate: JSON.stringify({ apiKey: 'PRIVATE-key\ud800' }) })) {
  test(`discovery ${label} auth fails safely and actionably`, async (t) => {
    const runtime = discovery(t, { readModelAuth: async () => auth, fetchModels: async () => assert.fail('no auth fallback') });
    await assert.rejects(runtime.call('cursor_list_models', {}), (error) => {
      assert.equal(error.error_code, 'model_discovery_failed');
      assert.match(error.message, /auth\.json/);
      assert.doesNotMatch(error.message, /private|suffix/i);
      return true;
    });
  });
}
for (const code of ['ENOENT', 'EACCES']) {
  test(`discovery ${code} auth read error hides exception details`, async (t) => {
    const runtime = discovery(t, { readModelAuth: async () => { throw Object.assign(new Error('PRIVATE PATH SECRET'), { code }); } });
    await assert.rejects(runtime.call('cursor_list_models', {}), (error) => {
      assert.equal(error.error_code, 'model_discovery_failed');
      assert.match(error.message, /auth\.json/);
      assert.doesNotMatch(error.message, /PRIVATE|SECRET/);
      return true;
    });
  });
}

test('HTTP and network failures hide bodies and exceptions and release admission for a later call', async (t) => {
  const responses = [() => new Response('SECRET response', { status: 401 }), () => { throw new Error('SECRET exception'); }, () => jsonResponse(golden().response)];
  const runtime = discovery(t, { fetchModels: async () => responses.shift()() });
  for (let i = 0; i < 2; i++) await assert.rejects(runtime.call('cursor_list_models', {}), (error) => {
    assert.equal(error.error_code, 'model_discovery_failed');
    assert.doesNotMatch(error.message, /SECRET|fixture-secret/);
    if (i === 0) assert.match(error.message, /401/);
    return true;
  });
  assert.deepEqual(await runtime.call('cursor_list_models', {}), golden().expected);
});

for (const [label, value] of [['invalid UTF-8', new Uint8Array([0xc3, 0x28])], ['invalid JSON', '{secret'], ['empty catalog', '{"items":[]}'], ['wrong top-level type', '[]']]) {
  test(`discovery rejects ${label} without partial catalog`, async (t) => {
    const runtime = discovery(t, { fetchModels: async () => new Response(value) });
    await assert.rejects(runtime.call('cursor_list_models', {}), failed);
  });
}

test('discovery rejects concurrent requests without queue and shutdown aborts the pending HTTP request', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  let signal;
  const runtime = discovery(t, { fetchModels: async (_url, options) => {
    calls++;
    signal = options.signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('SECRET abort')), { once: true }));
  } });
  const pending = runtime.call('cursor_list_models', {});
  const rejected = assert.rejects(pending, failed);
  await ready;
  await assert.rejects(runtime.call('cursor_list_models', {}), { error_code: 'resource_limit' });
  assert.equal(calls, 1);
  await runtime.shutdown();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(runtime.sessions.size, 0);
});

for (const cancelRejects of [false, true]) test(`streaming overflow releases reader and slot when cancellation ${cancelRejects ? 'rejects' : 'succeeds'}`, async (t) => {
  let cancelled = false;
  let call = 0;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
    cancel() { cancelled = true; if (cancelRejects) throw new Error('provider cancellation failed'); },
  });
  const runtime = discovery(t, { fetchModels: async () => {
    if (++call > 1) {
      const body = golden().response;
      body.ignored = 'x'.repeat(64_001);
      return jsonResponse(body);
    }
    return new Response(stream);
  } });
  await assert.rejects(runtime.call('cursor_list_models', {}), { error_code: 'resource_limit' });
  assert.equal(cancelled, true);
  await new Promise(setImmediate);
  assert.equal(stream.locked, false);
  assert.deepEqual(await runtime.call('cursor_list_models', {}), golden().expected);
});

for (const phase of ['credentials', 'headers', 'body']) {
  test(`total discovery deadline aborts stalled ${phase} and permits a later call`, async (t) => {
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    let first = true;
    let aborted = false;
    let cancelled = false;
    const stall = (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('SECRET timeout')); }, { once: true });
      entered();
    });
    const runtime = discovery(t, {
      readModelAuth: async (_path, { signal }) => first && phase === 'credentials' ? stall(signal) : '{"apiKey":"fixture"}',
      fetchModels: async (_url, { signal }) => {
        if (!first) return jsonResponse(golden().response);
        if (phase === 'headers') return stall(signal);
        return new Response(new ReadableStream({ start() { entered(); }, cancel() { cancelled = true; } }));
      },
    });
    const original = globalThis.setTimeout;
    let expire;
    globalThis.setTimeout = (callback, delay, ...args) => delay === 15_000 ? (expire = () => callback(...args), { unref() {} }) : original(callback, delay, ...args);
    try {
      const pending = runtime.call('cursor_list_models', {});
      const rejected = assert.rejects(pending, failed);
      await ready;
      assert.equal(typeof expire, 'function');
      expire();
      await rejected;
    } finally { globalThis.setTimeout = original; }
    assert.equal(phase === 'body' ? cancelled : aborted, true);
    first = false;
    assert.deepEqual(await runtime.call('cursor_list_models', {}), golden().expected);
  });
}

function launchRuntime(t, env = {}, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'model-selection-'));
  const log = join(directory, 'requests.jsonl');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = discovery(t, { env: { ...process.env, CURSOR_AGENT_COMMAND: process.execPath,
    CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))]),
    FAKE_ACP_PICKER_FROM_ARGV: '1', FAKE_ACP_FORBID_AUTHENTICATE: '1', FAKE_ACP_LOG: log, ...env }, ...overrides });
  return { runtime, directory, requests: () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } } };
}

for (const [model, knobs, encoded] of [
  ['grok-4.6', { effort: 'xhigh', fast: false }, 'grok-4.6[effort=xhigh,fast=false]'],
  ['gpt-5.5', { effort: 'extra-high', fast: true }, 'gpt-5.5[context=272k,reasoning=extra-high,fast=true]'],
  ['gemini-3.8-flash', { effort: 'low' }, 'gemini-3.8-flash[reasoning_effort=low]'],
  ['grok-4.6', {}, 'grok-4.6[effort=high,fast=true]'],
]) {
  test(`launch confirms ${model} complete variant and exact effort mapping`, async (t) => {
    const { runtime } = launchRuntime(t, { FAKE_ACP_REQUIRE_POLICY: '1', FAKE_ACP_EXPECT_MODEL_ARGV: JSON.stringify(['--model', encoded]) });
    const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model, ...knobs });
    assert.equal(result.session_state, 'live', JSON.stringify(result));
    assert.equal(result.model, model);
    for (const [key, value] of Object.entries(knobs)) assert.equal(result[key], value);
  });
}

test('launch preserves provider order when nondefault variants tie on default proximity', async (t) => {
  for (const contexts of [['small', 'large'], ['large', 'small']]) {
    await t.test(`provider order ${contexts.join(',')}`, async (t) => {
      const model = 'provider-order-fixture';
      const params = (context, fast) => [{ id: 'context', value: context }, { id: 'effort', value: 'medium' }, { id: 'fast', value: fast }];
      const response = { items: [{ id: model, displayName: 'Provider order fixture', parameters: [
        { id: 'context', values: ['default', 'small', 'large'].map((value) => ({ value })) },
        { id: 'effort', values: [{ value: 'medium' }] },
        { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
      ], variants: [
        { params: params('default', 'false'), isDefault: true },
        ...contexts.map((context) => ({ params: params(context, 'true') })),
      ] }] };
      const encoded = `${model}[context=${contexts[0]},effort=medium,fast=true]`;
      const { runtime } = launchRuntime(t, {
        FAKE_ACP_REQUIRE_POLICY: '1', FAKE_ACP_EXPECT_MODEL_ARGV: JSON.stringify(['--model', encoded]),
      }, { fetchModels: async () => jsonResponse(response) });
      const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model, fast: true });
      assert.equal(result.session_state, 'live', JSON.stringify(result));
      assert.equal(result.fast, true);
    });
  }
});

for (const strategy of ['cost', 'balanced', 'intelligence']) {
  test(`Auto ${strategy} is confirmed on start, delegate and persisted-session resume`, async (t) => {
    const { runtime, directory, requests } = launchRuntime(t);
    const persisted = join(directory, 'persisted.json');
    runtime.env.FAKE_ACP_PERSISTED_SESSION = persisted;
    const launch = { cwd: process.cwd(), mode: 'ask', model: 'auto-smart', optimize_for: strategy };
    const start = await runtime.call('cursor_start_session', launch);
    assert.equal(start.session_state, 'live', JSON.stringify(start));
    assert.equal(start.optimize_for, strategy);
    await runtime.call('cursor_close_session', { session_id: start.session_id });
    const originalStrategy = strategy === 'cost' ? 'intelligence' : 'cost';
    const delegated = await runtime.call('cursor_delegate', { ...launch, optimize_for: originalStrategy, prompt: 'Fixture persistence turn' });
    assert.equal(delegated.optimize_for, originalStrategy);
    assert.ok(delegated.turn_id);
    let terminal;
    for (let attempt = 0; attempt < 3; attempt++) {
      terminal = await runtime.call('cursor_wait', { session_id: delegated.session_id, turn_id: delegated.turn_id, timeout_ms: 1_000 });
      if (['completed', 'failed', 'cancelled', 'timed_out'].includes(terminal.turn_status)) break;
    }
    assert.equal(terminal.turn_status, 'completed');
    assert.equal(JSON.parse(readFileSync(persisted, 'utf8')).configOptions.find((o) => o.id === 'optimize_for').currentValue, originalStrategy);
    await runtime.call('cursor_close_session', { session_id: delegated.session_id });
    const resumed = await runtime.call('cursor_resume_session', { ...launch, cursor_session_id: delegated.cursor_session_id });
    assert.equal(resumed.session_state, 'live', JSON.stringify(resumed));
    assert.equal(resumed.optimize_for, strategy);
    assert.equal(resumed.cursor_session_id, delegated.cursor_session_id);
    assert.equal(requests().filter((r) => r.method === 'session/load').length, 1);
  });
}

for (const selection of [{ model: 'gpt-5-5' }, { model: 'grok' }, { model: 'grok-4.6', effort: 'extrahigh' },
  { model: 'auto-smart' }, { optimize_for: 'cost' }, { model: 'default', fast: false }, { model: 'auto', effort: 'low' },
  { model: 'grok-4.6', optimize_for: 'cost' }, { model: 'auto-smart', optimize_for: 'cheap' }]) {
  test(`invalid explicit selection ${JSON.stringify(selection)} has no allocation`, async (t) => {
    const { runtime, requests } = launchRuntime(t);
    await assert.rejects(runtime.call('cursor_delegate', { cwd: process.cwd(), mode: 'ask', prompt: 'must not send', ...selection }), { error_code: 'invalid_args' });
    assert.equal(runtime.sessions.size, 0);
    assert.deepEqual(requests(), []);
  });
}

for (const model of [undefined, 'auto', 'default']) {
  test(`default policy ${model} bypasses discovery without knobs`, async (t) => {
    const { runtime } = launchRuntime(t, {}, { fetchModels: async () => assert.fail('default launch must not lookup') });
    const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', ...(model ? { model } : {}) });
    assert.equal(result.session_state, 'live', JSON.stringify(result));
  });
}

const option = (id, currentValue) => ({ id, currentValue, type: 'select', category: id === 'model' ? 'model' : ['effort','reasoning','reasoning_effort'].includes(id) ? 'thought_level' : 'model_config' });
for (const [label, options] of [
  ['missing canonical', [option('effort', 'high'), option('fast', 'false')]],
  ['wrong canonical', [option('model', 'other'), option('effort', 'high'), option('fast', 'false')]],
  ['missing effort', [option('model', 'grok-4.6'), option('fast', 'false')]],
  ['wrong effort', [option('model', 'grok-4.6'), option('effort', 'low'), option('fast', 'false')]],
  ['missing false fast', [option('model', 'grok-4.6'), option('effort', 'high')]],
  ['wrong false fast', [option('model', 'grok-4.6'), option('effort', 'high'), option('fast', 'true')]],
]) {
  test(`actual selection ${label} fails init before delegate prompt and tears down`, async (t) => {
    const { runtime, requests } = launchRuntime(t, { FAKE_ACP_MODEL_SELECTION: JSON.stringify(options) });
    const result = await runtime.call('cursor_delegate', { cwd: process.cwd(), mode: 'ask', model: 'grok-4.6', effort: 'high', fast: false, prompt: 'must not send' });
    assert.equal(result.session_state, 'tombstone');
    assert.equal(result.failure_kind, 'init');
    assert.equal(result.active_turn, null);
    assert.equal(result.turn_id, undefined);
    assert.equal(runtime.live.size, 0);
    assert.equal(requests().some((r) => r.method === 'session/prompt'), false);
  });
}

for (const [label, mutate] of [
  ['duplicate IDs', (p) => p.items.push(p.items[0])],
  ['empty model ID', (p) => { p.items[0].id = ''; }],
  ['malformed name', (p) => { p.items[0].displayName = null; }],
  ['malformed aliases', (p) => { p.items[0].aliases = 'alias'; }],
  ['malformed parameters', (p) => { p.items[0].parameters = {}; }],
  ['duplicate parameter', (p) => p.items[0].parameters.push(p.items[0].parameters[0])],
  ['empty values', (p) => { p.items[0].parameters[0].values = []; }],
  ['duplicate values', (p) => p.items[0].parameters[0].values.push(p.items[0].parameters[0].values[0])],
  ['malformed value', (p) => { p.items[0].parameters[0].values[0].value = false; }],
  ['malformed optional name', (p) => { p.items[0].parameters[0].values[0].displayName = 1; }],
  ['invalid fast', (p) => { p.items[2].parameters[1].values[0].value = 'yes'; }],
  ['empty variants', (p) => { p.items[0].variants = []; }],
  ['malformed variant', (p) => { p.items[0].variants[0].params = null; }],
  ['malformed default', (p) => { p.items[0].variants[0].isDefault = 'true'; }],
  ['ambiguous default', (p) => { p.items[0].variants[0].isDefault = true; }],
  ['undeclared variant value', (p) => { p.items[0].variants[0].params[0].value = 'unlisted'; }],
  ['duplicate variant parameter', (p) => p.items[0].variants[0].params.push(p.items[0].variants[0].params[0])],
  ['missing declared parameter', (p) => { p.items[0].variants[0].params = []; }],
  ['ambiguous uniform effort', (p) => p.items[2].parameters.push({ id: 'reasoning', values: [{ value: 'low' }] })],
]) {
  test(`known malformed schema ${label} rejects entire discovery`, async (t) => {
    const payload = golden().response;
    mutate(payload);
    const runtime = discovery(t, { fetchModels: async () => jsonResponse(payload) });
    await assert.rejects(runtime.call('cursor_list_models', {}), failed);
  });
}

test('Auto without provider default omits default strategy rather than synthesizing one', async (t) => {
  const payload = golden().response;
  for (const variant of payload.items[0].variants) delete variant.isDefault;
  const runtime = discovery(t, { fetchModels: async () => jsonResponse(payload) });
  const result = await runtime.call('cursor_list_models', {});
  assert.equal(Object.hasOwn(result.models[0], 'default_optimize_for'), false);
});

test('no matching variant fails before allocation despite individually admitted parameter values', async (t) => {
  const payload = golden().response;
  payload.items[2].variants = payload.items[2].variants.filter((v) => !v.params.some((p) => p.id === 'effort' && p.value === 'xhigh'));
  const { runtime } = launchRuntime(t, {}, { fetchModels: async () => jsonResponse(payload) });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model: 'grok-4.6', effort: 'xhigh' }), { error_code: 'invalid_args' });
  assert.equal(runtime.sessions.size, 0);
});

test('canonical selection without default admits unique variant and rejects ambiguous variants', async (t) => {
  const payload = golden().response;
  const entry = payload.items[4];
  entry.variants.forEach((v) => { delete v.isDefault; });
  const { runtime } = launchRuntime(t, {}, { fetchModels: async () => jsonResponse(payload) });
  await assert.rejects(runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model: entry.id }), failed);
  assert.equal(runtime.sessions.size, 0);
  entry.variants = [entry.variants[0]];
  const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model: entry.id });
  assert.equal(result.session_state, 'live', JSON.stringify(result));
});

for (const actual of ['missing', 'wrong', 'correct']) {
  test(`hidden singleton ${actual} evidence obeys encoded-parameter verification`, async (t) => {
    const payload = golden().response;
    for (const variant of payload.items[4].variants) variant.params.push({ id: 'cyber', value: 'false' });
    const options = [option('model', 'gemini-3.8-flash'), option('reasoning_effort', 'high')];
    if (actual !== 'missing') options.push(option('cyber', actual === 'correct' ? 'false' : 'true'));
    const { runtime } = launchRuntime(t, { FAKE_ACP_MODEL_SELECTION: JSON.stringify(options) }, { fetchModels: async () => jsonResponse(payload) });
    const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model: 'gemini-3.8-flash', effort: 'high' });
    assert.equal(result.session_state, actual === 'wrong' ? 'tombstone' : 'live', JSON.stringify(result));
  });
}

for (const tool of ['cursor_start_session', 'cursor_resume_session']) {
  test(`shutdown concurrent with default ${tool} prevents allocation`, async (t) => {
    const { runtime } = launchRuntime(t);
    const pending = runtime.call(tool, { cwd: process.cwd(), mode: 'ask', ...(tool === 'cursor_resume_session' ? { cursor_session_id: 'persisted' } : {}) });
    const rejected = assert.rejects(pending, { error_code: 'protocol_error' });
    await runtime.shutdown();
    await rejected;
    await assert.rejects(runtime.call(tool, { cwd: process.cwd(), mode: 'ask', ...(tool === 'cursor_resume_session' ? { cursor_session_id: 'persisted' } : {}) }), { error_code: 'protocol_error' });
    assert.equal(runtime.sessions.size, 0);
  });
}

test('explicit null Auto strategy is not omission', async (t) => {
  const { runtime } = launchRuntime(t);
  await assert.rejects(runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', optimize_for: null }), { error_code: 'invalid_args' });
  assert.equal(runtime.sessions.size, 0);
});

for (const options of [[], [option('model', 'auto-smart')], [option('model', 'auto-smart'), option('optimize_for', 'balanced')]]) {
  test(`persisted resume rejects missing or mismatched selected strategy ${JSON.stringify(options)}`, async (t) => {
    const { runtime, directory, requests } = launchRuntime(t);
    runtime.env.FAKE_ACP_PERSISTED_SESSION = join(directory, 'persisted.json');
    const original = await runtime.call('cursor_delegate', { cwd: process.cwd(), mode: 'ask', model: 'auto-smart', optimize_for: 'intelligence', prompt: 'Persist fixture conversation' });
    let terminal;
    for (let attempt = 0; attempt < 3; attempt++) {
      terminal = await runtime.call('cursor_wait', { session_id: original.session_id, turn_id: original.turn_id, timeout_ms: 1_000 });
      if (terminal.turn_status === 'completed') break;
    }
    assert.equal(terminal.turn_status, 'completed');
    await runtime.call('cursor_close_session', { session_id: original.session_id });
    runtime.env.FAKE_ACP_MODEL_SELECTION = JSON.stringify(options);
    const loaded = await runtime.call('cursor_resume_session', { cwd: process.cwd(), mode: 'ask', cursor_session_id: original.cursor_session_id, model: 'auto-smart', optimize_for: 'cost' });
    assert.equal(loaded.session_state, 'tombstone');
    assert.equal(loaded.failure_kind, 'init');
    assert.equal(loaded.active_turn, null);
    assert.equal(runtime.live.size, 0);
    assert.equal(requests().filter((r) => r.method === 'session/load').length, 1);
  });
}

test('mismatch of encoded context fails even when caller did not explicitly choose it', async (t) => {
  const options = [option('model', 'gpt-5.5'), option('reasoning', 'medium'), option('fast', 'true'), option('context', '1m')];
  const { runtime } = launchRuntime(t, { FAKE_ACP_MODEL_SELECTION: JSON.stringify(options) });
  const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model: 'gpt-5.5', fast: true });
  assert.equal(result.session_state, 'tombstone');
  assert.equal(result.failure_kind, 'init');
});

test('Claude canonical default admits installed thought-level thinking evidence and hidden singleton omission', async (t) => {
  const evidence = golden().selectionEvidence.find((e) => e.result.configOptions.some((o) => o.id === 'thinking'));
  assert.ok(evidence, 'version-specific Claude selection evidence is required');
  const { runtime } = launchRuntime(t, { FAKE_ACP_MODEL_SELECTION: JSON.stringify(evidence.result.configOptions) });
  const model = evidence.result.configOptions.find((o) => o.id === 'model').currentValue;
  const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model });
  assert.equal(result.session_state, 'live', JSON.stringify(result));
});

test('HTTP 200 without body fails safely and frees discovery slot', async (t) => {
  let first = true;
  const runtime = discovery(t, { fetchModels: async () => first ? (first = false, new Response(null)) : jsonResponse(golden().response) });
  await assert.rejects(runtime.call('cursor_list_models', {}), failed);
  assert.deepEqual(await runtime.call('cursor_list_models', {}), golden().expected);
});

for (const status of [200, 503]) {
  test(`errored HTTP ${status} stream and rejected cancellation do not leak raw errors or admission`, async (t) => {
    let first = true;
    const runtime = discovery(t, { fetchModels: async () => {
      if (!first) return jsonResponse(golden().response);
      first = false;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE stream error')); } }), { status });
    } });
    await assert.rejects(runtime.call('cursor_list_models', {}), (error) => {
      assert.equal(error.error_code, 'model_discovery_failed');
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.deepEqual(await runtime.call('cursor_list_models', {}), golden().expected);
  });
}

test('HTTP response arriving after shutdown is cancelled even if transport ignored abort', async (t) => {
  let respond;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  const runtime = discovery(t, { fetchModels: async () => { started(); return new Promise((resolve) => { respond = resolve; }); } });
  const rejected = assert.rejects(runtime.call('cursor_list_models', {}), failed);
  await ready;
  await runtime.shutdown();
  await rejected;
  respond(new Response(new ReadableStream({ cancel() { cancelled(); return Promise.reject(new Error('PRIVATE late cancel')); } })));
  await cancellation;
  await assert.rejects(runtime.call('cursor_list_models', {}), failed);
});

for (const [label, options] of [
  ['missing config', null],
  ['duplicate canonical', [option('model', 'grok-4.6'), option('model', 'grok-4.6')]],
  ['wrong category', [{ ...option('model', 'grok-4.6'), category: 'model_config' }]],
  ['wrong type', [{ ...option('model', 'grok-4.6'), type: 'text' }]],
  ['invalid current value', [{ ...option('model', 'grok-4.6'), currentValue: 123 }]],
]) {
  test(`malformed selected evidence ${label} fails initialization`, async (t) => {
    const { runtime } = launchRuntime(t, { FAKE_ACP_MODEL_SELECTION: JSON.stringify(options) });
    const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model: 'grok-4.6' });
    assert.equal(result.session_state, 'tombstone');
    assert.equal(result.failure_kind, 'init');
  });
}

test('undeclared nonuniform variant parameter is ambiguous metadata', async (t) => {
  const payload = golden().response;
  payload.items[4].variants[0].params.push({ id: 'cyber', value: 'false' });
  const runtime = discovery(t, { fetchModels: async () => jsonResponse(payload) });
  await assert.rejects(runtime.call('cursor_list_models', {}), failed);
});

test('parameterless fixed canonical model launches without inventing variant encoding', async (t) => {
  const response = { items: [{ id: 'fixed-fixture', displayName: 'Fixed', variants: [{ params: [] }] }] };
  const { runtime } = launchRuntime(t, { FAKE_ACP_REQUIRE_POLICY: '1', FAKE_ACP_EXPECT_MODEL_ARGV: JSON.stringify(['--model', 'fixed-fixture']) }, { fetchModels: async () => jsonResponse(response) });
  const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask', model: 'fixed-fixture' });
  assert.equal(result.session_state, 'live');
});

for (const tool of ['cursor_start_session', 'cursor_resume_session']) {
  test(`${tool} uses existing file apiKey without interactive authenticate or modifying auth bytes`, async (t) => {
    const expected = { CURSOR_API_KEY: 'file-fixture-key', CURSOR_AUTH_TOKEN: null, AGENT_CLI_CREDENTIAL_STORE: 'memory' };
    let authPath;
    const { runtime, directory, requests } = launchRuntime(t, {
      CURSOR_API_KEY: 'inherited-other-key', CURSOR_AUTH_TOKEN: 'inherited-token', AGENT_CLI_CREDENTIAL_STORE: 'file',
      FAKE_ACP_EXPECT_AUTH_ENV: JSON.stringify(expected), FAKE_ACP_FORBID_AUTHENTICATE: '1', FAKE_ACP_REQUIRE_EXISTING_AUTH: '1',
    }, { readModelAuth: async () => readFileSync(authPath) });
    authPath = join(directory, 'auth.json');
    const bytes = Buffer.from('{\n  "apiKey": "file-fixture-key", "accessToken": "old-fixture-token", "other": 7\n}\n');
    writeFileSync(authPath, bytes);
    const result = await runtime.call(tool, { cwd: process.cwd(), mode: 'ask', ...(tool === 'cursor_resume_session' ? { cursor_session_id: 'existing-fixture' } : {}) });
    assert.equal(result.session_state, 'live', JSON.stringify(result));
    await runtime.call('cursor_close_session', { session_id: result.session_id });
    assert.deepEqual(readFileSync(authPath), bytes);
    assert.equal(runtime.env.CURSOR_API_KEY, 'inherited-other-key');
    assert.equal(runtime.env.CURSOR_AUTH_TOKEN, 'inherited-token');
    assert.equal(runtime.env.AGENT_CLI_CREDENTIAL_STORE, 'file');
    assert.equal(requests().some((r) => r.method === 'authenticate' || r.method === 'session/prompt'), false);
    assert.doesNotMatch(JSON.stringify(result), /file-fixture-key|inherited-token|inherited-other-key|old-fixture-token/);
  });
}

for (const authSource of ['token-only', 'missing-file']) {
  test(`${authSource} retains native child credential environment without login`, async (t) => {
    const expected = { CURSOR_API_KEY: 'inherited-key', CURSOR_AUTH_TOKEN: 'native-token', AGENT_CLI_CREDENTIAL_STORE: 'file' };
    const { runtime, requests } = launchRuntime(t, { ...expected, FAKE_ACP_EXPECT_AUTH_ENV: JSON.stringify(expected), FAKE_ACP_FORBID_AUTHENTICATE: '1' }, {
      readModelAuth: async () => {
        if (authSource === 'missing-file') throw Object.assign(new Error('PRIVATE missing file'), { code: 'ENOENT' });
        return '{"accessToken":"fixture-token"}';
      },
    });
    const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
    assert.equal(result.session_state, 'live', JSON.stringify(result));
    assert.equal(requests().some((r) => r.method === 'authenticate'), false);
  });
}

for (const tool of ['cursor_start_session', 'cursor_resume_session', 'cursor_delegate']) {
  test(`${tool} without credentials returns failure without interactive login or prompt`, async (t) => {
    const { runtime, requests } = launchRuntime(t, { CURSOR_API_KEY: '', CURSOR_AUTH_TOKEN: '',
      FAKE_ACP_FORBID_AUTHENTICATE: '1', FAKE_ACP_REQUIRE_EXISTING_AUTH: '1' }, {
      readModelAuth: async () => { throw Object.assign(new Error('PRIVATE no credentials'), { code: 'ENOENT' }); },
    });
    const result = await runtime.call(tool, { cwd: process.cwd(), mode: 'ask',
      ...(tool === 'cursor_resume_session' ? { cursor_session_id: 'existing-fixture' } : {}),
      ...(tool === 'cursor_delegate' ? { prompt: 'must not execute' } : {}) });
    assert.equal(result.session_state, 'tombstone');
    assert.equal(result.failure_kind, 'init');
    assert.equal(result.active_turn, null);
    assert.equal(result.provider_error.code, -32001);
    assert.equal(result.provider_error.message.text, 'authentication required');
    assert.equal(requests().some((r) => r.method === 'authenticate' || r.method === 'session/prompt'), false);
  });
}

for (const fault of ['malformed', 'unreadable', 'null', '[]', '123', '"PRIVATE"']) {
  test(`${fault} credential file fails before spawn and remains intact`, async (t) => {
    let authPath;
    const { runtime, directory, requests } = launchRuntime(t, { FAKE_ACP_FORBID_AUTHENTICATE: '1' }, {
      readModelAuth: async () => {
        if (fault === 'unreadable') throw Object.assign(new Error('PRIVATE credential read error'), { code: 'EACCES' });
        return readFileSync(authPath);
      },
      fetchModels: async () => assert.fail('invalid credentials must not reach HTTP'),
    });
    authPath = join(directory, 'auth.json');
    runtime.env.FAKE_ACP_PROCESS_LOG = join(directory, 'processes.log');
    const bytes = Buffer.from(['malformed', 'unreadable'].includes(fault) ? '{PRIVATE malformed credential bytes' : fault);
    writeFileSync(authPath, bytes);
    const result = await runtime.call('cursor_delegate', { cwd: process.cwd(), mode: 'ask', prompt: 'must not run' });
    assert.equal(result.session_state, 'tombstone');
    assert.equal(result.failure_kind, 'init');
    assert.equal(result.active_turn, null);
    assert.match(result.terminal_reason.text, /auth\.json/);
    assert.doesNotMatch(result.terminal_reason.text, /PRIVATE/);
    assert.deepEqual(readFileSync(authPath), bytes);
    assert.throws(() => readFileSync(runtime.env.FAKE_ACP_PROCESS_LOG), { code: 'ENOENT' });
    assert.deepEqual(requests(), []);
    await assert.rejects(runtime.call('cursor_list_models', {}), { error_code: 'model_discovery_failed' });
  });
}

for (const value of ['   ', '', null, false, 0, 123, {}, [], 'PRIVATE-key\0suffix', 'PRIVATE-key\ud800']) {
  test(`invalid present apiKey ${JSON.stringify(value)} fails before spawning credential-mutating CLI`, async (t) => {
    const { runtime, directory } = launchRuntime(t, {}, { readModelAuth: async () => JSON.stringify({ apiKey: value }) });
    runtime.env.FAKE_ACP_PROCESS_LOG = join(directory, 'processes.log');
    const result = await runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
    assert.equal(result.session_state, 'tombstone');
    assert.equal(result.failure_kind, 'init');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-key|suffix/);
    assert.throws(() => readFileSync(runtime.env.FAKE_ACP_PROCESS_LOG), { code: 'ENOENT' });
  });
}

for (const cause of ['deadline', 'shutdown']) {
  test(`startup auth read ${cause} aborts before process creation`, async (t) => {
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    let signal;
    const { runtime, directory } = launchRuntime(t, {}, { readModelAuth: async (_path, options) => {
      signal = options.signal;
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE aborted read')), { once: true }));
    } });
    runtime.env.FAKE_ACP_PROCESS_LOG = join(directory, 'processes.log');
    const original = globalThis.setTimeout;
    let expire;
    if (cause === 'deadline') globalThis.setTimeout = (callback, delay, ...args) => delay === 15_000
      ? (expire = () => callback(...args), { unref() {} }) : original(callback, delay, ...args);
    let result;
    try {
      const pending = runtime.call('cursor_start_session', { cwd: process.cwd(), mode: 'ask' });
      await ready;
      if (cause === 'deadline') expire();
      else await runtime.shutdown();
      result = await pending;
    } finally { globalThis.setTimeout = original; }
    assert.equal(result.session_state, 'tombstone');
    if (cause === 'deadline') assert.equal(result.failure_kind, 'init_timeout');
    assert.equal(signal.aborted, true);
    assert.throws(() => readFileSync(runtime.env.FAKE_ACP_PROCESS_LOG), { code: 'ENOENT' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  });
}
