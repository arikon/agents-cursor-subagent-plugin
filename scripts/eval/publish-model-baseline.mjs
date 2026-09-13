#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../..');
const [model, date, evidenceSlug, ...matrixPaths] = process.argv.slice(2);
if (!model || !date || !evidenceSlug || matrixPaths.length === 0) {
  throw new Error('usage: node scripts/eval/publish-model-baseline.mjs <model> <YYYY-MM-DD> <evidence-slug> <matrix.json> [...]');
}

const digestFile = async (path) => {
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

const series = [];
for (const matrixPath of matrixPaths) {
  const absolute = resolve(repository, matrixPath);
  const summary = JSON.parse(await readFile(absolute, 'utf8'));
  const mismatchByScenario = {};
  for (const result of summary.results || []) {
    if (result.eval_status !== 'agent_behavior_mismatch') continue;
    mismatchByScenario[result.scenario_id] = (mismatchByScenario[result.scenario_id] || 0) + 1;
  }
  const file = await digestFile(absolute);
  series.push({
    effort: summary.effort,
    path: matrixPath,
    bytes: file.bytes,
    sha256: file.sha256,
    started_at: summary.started_at,
    finished_at: summary.finished_at,
    duration_ms: summary.duration_ms,
    concurrency: summary.concurrency,
    serial: summary.serial,
    complete: summary.complete !== false,
    stop_reason: summary.stop_reason ?? null,
    planned_total: summary.planned_total ?? null,
    not_started_total: summary.not_started_total ?? 0,
    runs: summary.runs,
    counts: summary.counts,
    pass_rate: summary.pass_rate,
    digest_stable: summary.digest_stable,
    mismatch_by_scenario: mismatchByScenario,
    corpus: summary.final?.corpus || summary.initial?.corpus,
    skill: summary.final?.skill || summary.initial?.skill,
    evaluator: summary.final?.evaluator || summary.initial?.evaluator,
  });
}

const greenCounts = (counts) => Number.isSafeInteger(counts?.total) && counts.total > 0
  && counts.pass === counts.total && ['agent_behavior_mismatch', 'integration_failure', 'skipped'].every((key) => counts[key] === 0);
const acceptedGreen = series.every((entry) => entry.complete && entry.digest_stable === true
  && entry.serial === 3 && greenCounts(entry.counts) && Array.isArray(entry.runs) && entry.runs.length === 3
  && entry.runs.every((run, index) => run.serial_index === index + 1 && run.complete !== false
    && run.digest_stable === true && greenCounts(run.counts) && run.counts.total === entry.runs[0].counts.total)
  && entry.runs.reduce((total, run) => total + run.counts.total, 0) === entry.counts.total);
const baseline = {
  schema_version: 1,
  kind: 'cursor-skill-eval-baseline',
  model,
  accepted_green: acceptedGreen,
  note: `English operator corpus serial×3 on compact-cursor-subagent-skill. Concurrency ${series[0]?.concurrency ?? 'unknown'}.`,
  captured_at: series.at(-1)?.finished_at,
  reference_root: '.',
  series,
};

const mdName = `cursor-skill-eval-baseline-${model}-${date}.md`;
const jsonName = `cursor-skill-eval-baseline-${model}-${date}.json`;
const jsonRel = jsonName;
const lines = [
  `# Hosted baseline ${model} — ${date}`,
  '',
  `Serial ×3, concurrency ${series[0]?.concurrency ?? 'unknown'}. ${acceptedGreen ? '**Все три запуска каждого effort прошли.**' : '**Baseline не принят: серия неполна или содержит ошибки.**'}`,
  `Machine-readable: [JSON](${jsonRel}).`,
  '',
  '| Effort | Матрица | Pass |',
  '| --- | --- | --- |',
];
for (const row of series) {
  const pass = `${row.counts.pass}/${row.counts.total}`;
  lines.push(`| ${row.effort} | [${basename(row.path)}](${row.path}) | ${pass} |`);
}
if (!acceptedGreen) {
  const mismatches = [...new Set(series.flatMap(({ mismatch_by_scenario: m }) => Object.keys(m)))];
  if (mismatches.length) lines.push('', `Mismatch scenarios: ${mismatches.map((id) => `\`${id}\``).join(', ')}.`);
}
lines.push('', 'Baseline относится к механике, evidence и точной доставке в зафиксированном corpus.', '`reported_task_outcome`, свободный prose и `safety_disclosure` — `not_checked`.', '');

await writeFile(resolve(repository, 'evals', jsonName), `${JSON.stringify(baseline, null, 2)}\n`);
await writeFile(resolve(repository, 'evals', mdName), `${lines.join('\n')}\n`);
process.stdout.write(`${mdName}\n${jsonName}\n`);
