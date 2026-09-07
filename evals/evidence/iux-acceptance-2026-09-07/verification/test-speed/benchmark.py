import subprocess, pathlib, json, sys, re, hashlib, time, shutil, statistics
root = pathlib.Path('/Users/arikon/projects/codex-cursor-subagent-plugin')
out = root / 'evals/evidence/iux-acceptance-2026-09-07/verification/test-speed/final-series'
out.mkdir(parents=True, exist_ok=True)
group = sys.argv[1]
pattern = 'normalized outcome parity|each backup cleanup deletion boundary|rejected and timed-out compensation|reread failures preserve every|uncertain remove outcomes|reported successful no-op|never add compensation over|pre-commit publication rename faults|update and uninstall also return recovery_required|strict marker validation rejects every|negative, nonzero, partial and output-overflow mutators|registration reread failure during compensation'
args = {
 'bootstrap': ['unit', '--test', 'tests/bootstrap.test.mjs', '--test-name-pattern', pattern],
 'capture': ['unit', '--test', 'tests/codex-app-server-client.test.mjs'],
 'unit': ['unit'], 'coverage': ['coverage']
}[group]
count = 25 if group in ('bootstrap', 'capture') else 3
def inventory():
 paths = []
 for folder in ('scripts', 'tests', 'skills'):
  for p in sorted((root / folder).rglob('*')):
   if p.is_file(): paths.append(p)
 paths.extend(root / p for p in ('README.md', '.codex-plugin/plugin.json', 'evals/cursor-subagent-scenarios.v1.json'))
 return [{'path': str(p.relative_to(root)), 'mode': p.stat().st_mode, 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(paths)]
def digest():
 return hashlib.sha256(json.dumps(inventory(),sort_keys=True).encode()).hexdigest()
if (out / f'{group}.json').exists(): raise SystemExit('Refusing to overwrite an existing measured series')
initial_inventory = inventory()
initial = digest()
records = []
load = None
try:
 if group == 'capture':
  load = subprocess.Popen(['node', '-e', 'const end=Date.now()+180000; while(Date.now()<end){for(let i=0;i<100000;i++)Math.sqrt(i)}'])
 for index in range(1, count + 1):
  print(f'{group} {index}/{count}', flush=True)
  result = subprocess.run(['node', 'scripts/run-node-tests.mjs', *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
  print(result.stdout, end='', flush=True)
  match = re.search(r'artifacts: (.+)', result.stdout)
  record = {'index': index, 'exit_code': result.returncode, 'source_digest': initial, 'source_unchanged': digest() == initial, 'output': result.stdout}
  if match:
   artifact = pathlib.Path(match.group(1).strip())
   record['artifact_dir'] = str(artifact)
   record['result'] = json.loads((artifact / 'result.json').read_text())
   durable = out / group / f'run-{index:02}'
   durable.mkdir(parents=True, exist_ok=False)
   record['artifact_files'] = []
   for name in ('result.json', 'tap.txt', 'stderr.txt', 'failures.jsonl'):
    target = durable / name
    shutil.copy2(artifact / name, target)
    record['artifact_files'].append({'path':str(target.relative_to(out)), 'bytes':target.stat().st_size, 'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
   record['durable_artifact_dir'] = str(durable.relative_to(out))
  records.append(record)
  durations = [r['result']['duration_ms'] for r in records if 'result' in r]
  gates = {'series_complete':len(records)==count, 'all_passed':all(r['exit_code']==0 and r.get('result',{}).get('verdict')=='passed' for r in records), 'source_unchanged':all(r['source_unchanged'] for r in records)}
  if group == 'unit': gates.update({'median_at_most_60000_ms':statistics.median(durations)<=60000, 'maximum_at_most_70000_ms':max(durations)<=70000})
  temp = out / f'{group}.json.tmp'
  temp.write_text(json.dumps({'group': group, 'command': ['node','scripts/run-node-tests.mjs',*args], 'source_inventory':initial_inventory, 'controlled_load': 'one bounded CPU child' if load else None, 'median_ms':statistics.median(durations) if durations else None, 'maximum_ms':max(durations) if durations else None, 'gates':gates, 'runs': records}, indent=2) + '\n')
  temp.replace(out / f'{group}.json')
  if result.returncode or not record['source_unchanged']: sys.exit(1)
finally:
 if load:
  load.terminate(); load.wait()
