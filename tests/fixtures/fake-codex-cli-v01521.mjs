#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2); const statePath = process.env.FAKE_CODEX_CLI_STATE;
if (process.env.FAKE_CODEX_CLI_LOG) await appendFile(process.env.FAKE_CODEX_CLI_LOG, `${JSON.stringify(args)}\n`);
const load = async () => JSON.parse(await readFile(statePath, 'utf8').catch(() => '{"marketplaces":[],"installed":[]}'));
const save = (state) => writeFile(statePath, JSON.stringify(state)); const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
if (args[0] === '--version') out(process.env.FAKE_CODEX_CLI_VERSION || 'codex-cli 0.152.1\n');
else if (args.join(' ') === 'plugin --help') out('add list marketplace remove\n');
else if (args.join(' ') === 'login status') { process.stderr.write(process.env.FAKE_CODEX_LOGIN_STATUS || 'Logged in using ChatGPT'); process.exitCode = Number(process.env.FAKE_CODEX_LOGIN_EXIT || 0); }
else {
  const state = await load();
  if (args.join(' ') === 'plugin marketplace list --json') out({ marketplaces: state.marketplaces });
  else if (args.join(' ') === 'plugin list --json' ||
    args.join(' ') === 'plugin list --marketplace agents-cursor-subagent-plugin --json') out({ installed: state.installed, available: [] });
  else if (args.slice(0, 3).join(' ') === 'plugin marketplace add') { state.marketplaces = [{ name: 'agents-cursor-subagent-plugin', root: args[3] }]; await save(state); out({ marketplaceName: 'agents-cursor-subagent-plugin' }); }
  else if (args.slice(0, 3).join(' ') === 'plugin marketplace remove') { state.marketplaces = []; await save(state); out({ marketplaceName: args[3] }); }
  else if (args.slice(0, 2).join(' ') === 'plugin add') { const [name, marketplaceName] = args[2].split('@'); const root = state.marketplaces[0].root; const manifest = JSON.parse(await readFile(`${root}/plugins/${name}/.codex-plugin/plugin.json`, 'utf8')); state.installed = [{ name, marketplaceName, version: manifest.version, source: { source: 'local', path: `${root}/plugins/${name}` } }]; await save(state); out({ name, marketplaceName, version: manifest.version }); }
  else if (args.slice(0, 2).join(' ') === 'plugin remove') { const [name, marketplaceName] = args[2].split('@'); state.installed = []; await save(state); out({ name, marketplaceName }); }
  else { process.stderr.write(`unexpected argv: ${args.join(' ')}`); process.exitCode = 2; }
}
