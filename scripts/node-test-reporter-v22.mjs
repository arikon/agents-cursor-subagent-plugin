// Node 22.23.1 test-runner event adapter.  It deliberately emits JSONL: the
// supervisor, rather than the reporter, owns artifact publication and verdicts.
const SUPERVISOR_EVENTS = new Set(['test:fail', 'test:summary', 'test:coverage']);

function json(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack, cause: json(value.cause) };
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, json(entry)]));
  return value;
}

export default async function* nodeTestReporter(source) {
  for await (const event of source) {
    if (!SUPERVISOR_EVENTS.has(event.type)) continue;
    yield `${JSON.stringify({ type: event.type, data: json(event.data) })}\n`;
  }
}
