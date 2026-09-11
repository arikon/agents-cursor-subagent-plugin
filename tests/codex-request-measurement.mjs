// Eval-only Responses request measurement. Never retain request text or paths.
import { createHash } from 'node:crypto';

export function measureSkillRequest(request, skill) {
  if (typeof skill !== 'string' || skill.length === 0) throw new Error('measurement requires nonempty installed skill');
  let contextBytes = 0; let occurrences = 0;
  const visit = (value) => {
    if (typeof value === 'string') {
      contextBytes += Buffer.byteLength(value);
      let offset = 0;
      while ((offset = value.indexOf(skill, offset)) !== -1) { occurrences += 1; offset += skill.length; }
    } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  // Installed Responses interface: instructions and input carry model context;
  // tools are measured separately and cannot establish skill loading.
  visit(request.instructions); visit(request.input);
  if (occurrences === 0) throw new Error('installed skill body missing from request context');
  const bytes = Buffer.byteLength(skill);
  return { skill_sha256: createHash('sha256').update(skill).digest('hex'), skill_body_bytes: bytes,
    skill_occurrences: occurrences, skill_bytes: bytes * occurrences,
    other_context_string_bytes: contextBytes - bytes * occurrences,
    tools_json_bytes: Buffer.byteLength(JSON.stringify(request.tools ?? [])) };
}

export function summarizeSkillRequests(requests) {
  if (!requests.length || !requests.some(({ phase }) => phase === 'evaluated')) throw new Error('evaluated request measurement missing');
  const sum = (rows) => ({ requests: rows.length,
    ...Object.fromEntries(['skill_occurrences', 'skill_bytes', 'other_context_string_bytes', 'tools_json_bytes']
      .map((key) => [key, rows.reduce((total, row) => total + row[key], 0)])) });
  return { warmup: sum(requests.filter(({ phase }) => phase === 'warmup')),
    first_evaluated_request: requests.find(({ phase }) => phase === 'evaluated'),
    evaluated: sum(requests.filter(({ phase }) => phase === 'evaluated')), total: sum(requests) };
}
