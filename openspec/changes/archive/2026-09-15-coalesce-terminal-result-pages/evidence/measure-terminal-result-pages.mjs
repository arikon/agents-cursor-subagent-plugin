import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const defaultFixturePath = fileURLToPath(new URL('../../archive/2026-09-09-add-cursor-model-discovery/evidence/cursor-verification.md', import.meta.url));
const defaultServer = fileURLToPath(new URL('../../../../scripts/cursor-subagent-mcp.mjs', import.meta.url));
const defaultFakeAcp = fileURLToPath(new URL('../../../../tests/fixtures/fake-acp.mjs', import.meta.url));
const defaultSkillPath = fileURLToPath(new URL('../../../../skills/cursor-subagent/SKILL.md', import.meta.url));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]; const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined || options.has(key)) throw new Error('usage: node measure-terminal-result-pages.mjs --output <absolute-json-path> [--fixture-file <absolute-path> | --fixture-bytes <non-negative-integer>] [--fixture-name <name>] [--server <absolute-path>] [--skill <absolute-path>] [--adapter <absolute-path>] [--adapter-program <absolute-path>] [--subject <label>]');
  options.set(key, value);
}
const output = options.get('--output') ?? null;
const fixtureFile = options.get('--fixture-file') ?? (options.has('--fixture-bytes') ? null : defaultFixturePath);
const fixtureBytes = options.get('--fixture-bytes') ?? null;
if (!output || (fixtureFile !== null) === (fixtureBytes !== null)) throw new Error('choose exactly one fixture source');
const parsedFixtureBytes = fixtureBytes === null ? null : Number(fixtureBytes);
if (parsedFixtureBytes !== null && (!Number.isSafeInteger(parsedFixtureBytes) || parsedFixtureBytes < 0)) throw new Error('fixture bytes must be a non-negative safe integer');
const fixtureName = options.get('--fixture-name') ?? (fixtureFile ? 'archived-8353' : `ascii-${parsedFixtureBytes}`);
const server = options.get('--server') ?? defaultServer;
const fakeAcp = options.get('--adapter') ?? defaultFakeAcp;
const skillPath = options.get('--skill') ?? defaultSkillPath;
const adapterProgram = options.get('--adapter-program') ?? null;
const subject = options.get('--subject') ?? 'working-tree';
for (const key of options.keys()) {
  if (!['--output', '--fixture-file', '--fixture-bytes', '--fixture-name', '--server', '--skill', '--adapter', '--adapter-program', '--subject'].includes(key)) throw new Error(`unknown option ${key}`);
}

const digest = (value) => ({ bytes: Buffer.byteLength(value, 'utf8'), sha256: createHash('sha256').update(value, 'utf8').digest('hex') });
const fixture = fixtureFile ? await readFile(fixtureFile, 'utf8') : 'x'.repeat(parsedFixtureBytes);
const skill = await readFile(skillPath, 'utf8');
const child = spawn(process.execPath, [server], {
  env: { ...process.env, CURSOR_AGENT_COMMAND: process.execPath,
    CURSOR_SUBAGENT_ADAPTER_ARGS: JSON.stringify([fakeAcp]), CURSOR_SUBAGENT_ALLOWED_ROOTS: JSON.stringify([root]),
    FAKE_ACP_REQUIRE_POLICY: '1', FAKE_ACP_RESULT: fixture,
    ...(adapterProgram === null ? {} : { CURSOR_EVAL_FAKE_ACP_PROGRAM_PATH: adapterProgram }) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buffered = '';
const pending = new Map();
let childStderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { childStderr += chunk; });
child.stdout.on('data', (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) break;
    const raw = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
    const message = JSON.parse(raw); const deferred = pending.get(message.id);
    if (deferred) { pending.delete(message.id); deferred.resolve({ raw, message }); }
  }
});
child.on('exit', (code, signal) => {
  const error = new Error(`measurement MCP exited before response: ${JSON.stringify({ code, signal, stderr: childStderr })}`);
  for (const deferred of pending.values()) deferred.reject(error);
  pending.clear();
});
let nextId = 1;
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => { if (error) { pending.delete(id); reject(error); } });
});
const tool = async (name, args) => {
  const response = await request('tools/call', { name, arguments: args });
  if (response.message.result?.isError) throw new Error(`${name}: ${response.message.result.content?.[0]?.text}`);
  return { wire_json_bytes: Buffer.byteLength(response.raw, 'utf8'), response: JSON.parse(response.message.result.content[0].text) };
};
let closeRequested = false;
try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'measurement', version: '1' } });
  const session = (await tool('cursor_start_session', { cwd: root, mode: 'ask' })).response;
  const turn = (await tool('cursor_send_prompt', { session_id: session.session_id, prompt: 'Return the fixture verbatim.' })).response;
  let terminal;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const waited = await tool('cursor_wait', { session_id: session.session_id, turn_id: turn.turn_id, timeout_ms: 1_000 });
    if (!['running', 'waiting_for_input'].includes(waited.response.turn_status)) { terminal = waited; break; }
  }
  if (!terminal || terminal.response.turn_status !== 'completed') throw new Error('fixture turn did not complete');
  const delivery = [];
  const first = terminal.response.result_page ?? terminal.response.result;
  if (!first) throw new Error('completed terminal response has no result');
  delivery.push({ tool: 'cursor_wait', wire_json_bytes: terminal.wire_json_bytes, text: first.text, sha256: first.sha256 ?? null,
    eof: first.eof ?? !first.truncated, next_offset: first.next_offset ?? null, total_bytes: first.total_bytes ?? digest(fixture).bytes });
  let page = first;
  while (page.eof === false || page.truncated === true) {
    const read = await tool('cursor_read_result', { session_id: session.session_id, turn_id: turn.turn_id,
      ...(page.next_offset === null || page.next_offset === undefined ? {} : { offset: page.next_offset }) });
    page = read.response;
    delivery.push({ tool: 'cursor_read_result', wire_json_bytes: read.wire_json_bytes, text: page.text, sha256: page.sha256,
      eof: page.eof, next_offset: page.next_offset, total_bytes: page.total_bytes });
  }
  const deliveredText = delivery.map(({ text: value }) => value).join('');
  const completeText = terminal.response.result_page
    ? deliveredText
    : (delivery.length === 1 ? first.text : delivery.slice(1).map(({ text: value }) => value).join(''));
  if (completeText !== fixture) throw new Error(`complete text differs from fixture: ${JSON.stringify({ complete: digest(completeText), fixture: digest(fixture), calls: delivery.map(({ tool: name, text: value }) => ({ tool: name, ...digest(value) })) })}`);
  const result = { format: 1, subject, scope: 'terminal result delivery only; deterministic fake ACP; no model invocation',
    environment: { node: process.version, platform: process.platform, concurrency: 1 },
    scenarios: { selected: ['terminal-result-delivery'], executed: 1, skipped: 0 },
    fixture: { name: fixtureName, source: fixtureFile === null ? 'generated-ascii' : 'archived-model-discovery-cursor-verification', ...digest(fixture) },
    runtime: { path: 'scripts/cursor-subagent-mcp.mjs', ...(digest(await readFile(server, 'utf8'))) },
    skill: { path: 'skills/cursor-subagent/SKILL.md', ...digest(skill) },
    adapter: { path: 'tests/fixtures/fake-acp.mjs', ...(digest(await readFile(fakeAcp, 'utf8'))) },
    terminal_receipt: terminal.response.terminal_receipt,
    delivery: delivery.map(({ text: value, ...entry }) => ({ ...entry, text_bytes: digest(value).bytes })),
    totals: { delivery_calls: delivery.length, text_bytes: digest(deliveredText).bytes,
      serialized_mcp_json_bytes: delivery.reduce((sum, entry) => sum + entry.wire_json_bytes, 0), full_result_sha256: digest(completeText).sha256 },
  };
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`); await rename(temporary, output);
  process.stdout.write(`${JSON.stringify(result.totals)}\n`);
  await tool('cursor_close_session', { session_id: session.session_id }); closeRequested = true;
} finally {
  if (!closeRequested) child.kill('SIGTERM');
  child.kill('SIGTERM');
}
