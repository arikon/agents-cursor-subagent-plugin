// Cursor public SDK 1.0.31 catalog and CLI 2026.08.25-3e8eec8 picker adapter.
// Schema evidence and a credential-free golden belong to this version boundary.
export class ModelAdapterError extends Error {
  constructor(error_code, message) { super(message); this.error_code = error_code; }
}
const bad = () => { throw new ModelAdapterError('model_discovery_failed', 'Invalid Cursor model catalog metadata'); };
const invalid = () => { throw new ModelAdapterError('invalid_args', 'Unsupported canonical model or model parameter combination'); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' && v.length > 0 && Buffer.from(v).toString('utf8') === v;
function optionalName(v) { if (v !== undefined && !string(v)) bad(); }
export function parseModelCatalog(payload) {
  if (!object(payload) || !Array.isArray(payload.items) || !payload.items.length) bad();
  const seen = new Set();
  const entries = payload.items.map((item) => {
    if (!object(item) || !string(item.id) || !string(item.displayName) || seen.has(item.id)) bad();
    seen.add(item.id);
    if (item.aliases !== undefined && (!Array.isArray(item.aliases) || !item.aliases.every(string))) bad();
    if (item.parameters !== undefined && !Array.isArray(item.parameters)) bad();
    const definitions = new Map();
    for (const def of item.parameters ?? []) {
      if (!object(def) || !string(def.id) || definitions.has(def.id) || !Array.isArray(def.values) || !def.values.length) bad();
      optionalName(def.displayName);
      const values = [];
      for (const value of def.values) {
        if (!object(value) || !string(value.value) || values.includes(value.value)) bad();
        optionalName(value.displayName); values.push(value.value);
      }
      definitions.set(def.id, values);
    }
    const efforts = ['effort', 'reasoning', 'reasoning_effort'].filter((id) => definitions.has(id));
    if (efforts.length > 1) bad();
    const effortId = efforts[0];
    if (definitions.has('fast') && !definitions.get('fast').every((v) => ['false', 'true'].includes(v))) bad();
    if (!Array.isArray(item.variants) || !item.variants.length) bad();
    const variants = item.variants.map((variant) => {
      if (!object(variant) || !Array.isArray(variant.params) || (variant.isDefault !== undefined && typeof variant.isDefault !== 'boolean')) bad();
      optionalName(variant.displayName);
      const ids = new Set();
      const params = variant.params.map((param) => {
        if (!object(param) || !string(param.id) || !string(param.value) || ids.has(param.id) || (definitions.has(param.id) && !definitions.get(param.id).includes(param.value))) bad();
        ids.add(param.id); return { id: param.id, value: param.value };
      });
      if (![...definitions.keys()].every((id) => ids.has(id))) bad();
      return { params, isDefault: variant.isDefault === true };
    });
    // Public catalog omits hidden singleton definitions (observed cyber=false).
    // Preserve their complete wire values, but reject ambiguous undeclared fields.
    for (const param of variants.flatMap((v) => v.params)) {
      if (!definitions.has(param.id) && !variants.every((v) => v.params.some((p) => p.id === param.id && p.value === param.value))) bad();
    }
    const defaults = variants.filter((v) => v.isDefault);
    if (defaults.length > 1) bad();
    const publicModel = { id: item.id, name: item.displayName };
    if (effortId) publicModel.effort = definitions.get(effortId);
    if (definitions.has('fast')) publicModel.fast = definitions.get('fast').map((v) => v === 'true');
    if (item.id === 'auto-smart' && definitions.has('optimize_for')) {
      publicModel.optimize_for = definitions.get('optimize_for');
      if (defaults.length) publicModel.default_optimize_for = defaults[0].params.find((p) => p.id === 'optimize_for').value;
    }
    return { model: item.id, definitions, effortId, variants, defaultVariant: defaults[0], publicModel };
  });
  return { models: entries.map((e) => e.publicModel), entries };
}
export function resolveModelSelection(catalog, launch) {
  const entry = catalog.entries.find((e) => e.model === launch.model);
  if (!entry) invalid();
  const constraints = [];
  for (const [field, id] of [['effort', entry.effortId], ['fast', 'fast'], ['optimize_for', 'optimize_for']]) {
    if (launch[field] == null) continue;
    const value = String(launch[field]);
    if (!id || !entry.definitions.get(id)?.includes(value)) invalid();
    constraints.push({ id, value });
  }
  const matches = (params, constraint) => params.some((p) => p.id === constraint.id && p.value === constraint.value);
  const candidates = entry.variants.filter((v) => constraints.every((c) => matches(v.params, c)));
  if (!candidates.length) invalid();
  let selected;
  if (!entry.defaultVariant) { if (candidates.length !== 1) bad(); selected = candidates[0]; }
  else {
    const score = (v) => entry.defaultVariant.params.filter((p) => matches(v.params, p)).length;
    selected = candidates.reduce((best, v) => score(v) > score(best) || (score(v) === score(best) && v.isDefault) ? v : best);
  }
  return { model: entry.model, params: selected.params, explicitIds: constraints.map((c) => c.id),
    encoded: selected.params.length ? `${entry.model}[${selected.params.map((p) => `${p.id}=${p.value}`).join(',')}]` : entry.model };
}
export function verifyModelSelection(result, selection) {
  const mismatch = () => { throw new ModelAdapterError('protocol_error', 'Cursor did not confirm the requested model selection'); };
  if (!Array.isArray(result?.configOptions)) mismatch();
  const options = result.configOptions;
  const actual = (id, category) => {
    const found = options.filter((o) => o?.id === id);
    if (found.length > 1) mismatch();
    if (!found.length) return undefined;
    if (found[0].category !== category || found[0].type !== 'select' || !string(found[0].currentValue)) mismatch();
    return found[0].currentValue;
  };
  if (actual('model', 'model') !== selection.model) mismatch();
  for (const param of selection.params) {
    const value = actual(param.id, ['effort', 'reasoning', 'reasoning_effort', 'thinking'].includes(param.id) ? 'thought_level' : 'model_config');
    if ((value === undefined && selection.explicitIds.includes(param.id)) || (value !== undefined && value !== param.value)) mismatch();
  }
}
