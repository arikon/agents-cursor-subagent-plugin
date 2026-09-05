const stub = `export async function cli({ argv, processLike = process }) { processLike.stdout.write(JSON.stringify({ argv }) + '\\n'); return 0; }`;
const stubUrl = `data:text/javascript,${encodeURIComponent(stub)}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('run-node-tests.mjs')) return { shortCircuit: true, url: stubUrl };
  return nextResolve(specifier, context);
}
