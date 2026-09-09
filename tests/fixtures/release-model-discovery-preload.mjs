// Test-process dependency injection: installed product code keeps its production
// auth path and endpoint. Never consult real credentials or the network here.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const authPath = join(homedir(), '.cursor', 'auth.json');
const originalRead = promises.readFile;
const originalReadSync = fs.readFileSync;
const credential = JSON.stringify({ apiKey: 'release-fixture-key' });
promises.readFile = async (path, ...args) => String(path) === authPath
  ? credential : originalRead(path, ...args);
fs.readFileSync = (path, ...args) => String(path) === authPath
  ? credential : originalReadSync(path, ...args);
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://api.cursor.com/v1/models'
    || new Headers(options.headers).get('authorization') !== 'Bearer release-fixture-key') {
    throw new Error('unexpected release catalog request');
  }
  if (process.env.RELEASE_MODEL_DISCOVERY_FAILURE === '1') return new Response('', { status: 503 });
  const fixture = JSON.parse(await originalRead(process.env.RELEASE_MODEL_CATALOG, 'utf8'));
  return new Response(JSON.stringify(fixture.response), { status: 200 });
};
