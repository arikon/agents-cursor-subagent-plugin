#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_LIMITS = Object.freeze({ timeoutMs: 10_000, outputBytes: 1_048_576, messageBytes: 8_000 });
export const PACKAGE_IDS = Object.freeze({ marketplace: 'agents-cursor-subagent-plugin', plugin: 'agents-cursor-subagent-plugin' });
export const MARKER_NAME = '.agents-cursor-subagent-plugin.install.json';
const PLUGIN_RELATIVE = join('plugins', PACKAGE_IDS.plugin);
const CHECK_NAMES = ['node', 'codex_cli', 'managed_root', 'marketplace_registration', 'plugin_registration', 'mcp_config', 'agent_executable', 'agent_status'];
const ADAPTER_OPERATIONS = ['admit', 'help', 'marketplace-list', 'plugin-list', 'render', 'mcp-check', 'agent-status', 'canary-prompt', 'marketplace-add', 'marketplace-remove', 'plugin-add', 'plugin-remove'];

class BootstrapError extends Error {
  constructor(code, message, exitCode = 1) { super(message); this.code = code; this.exitCode = exitCode; }
}

const bounded = (value) => {
  const source = Buffer.from(String(value ?? ''), 'utf8').toString('utf8');
  if (Buffer.byteLength(source) <= PACKAGE_LIMITS.messageBytes) return source;
  const suffix = '...';
  const contentLimit = PACKAGE_LIMITS.messageBytes - Buffer.byteLength(suffix);
  let text = '';
  let textBytes = 0;
  for (const character of source) {
    const characterBytes = Buffer.byteLength(character);
    if (textBytes + characterBytes > contentLimit) break;
    text += character;
    textBytes += characterBytes;
  }
  return `${text}${suffix}`;
};
const fail = (code, message, exitCode = 1) => { throw new BootstrapError(code, bounded(message), exitCode); };
const invalid = (message) => fail('invalid_invocation', message, 2);
const inside = (candidate, root) => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
const overlaps = (left, right) => inside(left, right) || inside(right, left);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('invalid_json', 'canonical JSON cannot encode this value');
  return encoded;
}

export function normalizeManifestBytes(input) {
  let manifest;
  try { manifest = JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : String(input)); }
  catch { fail('invalid_manifest', 'plugin manifest is not valid JSON'); }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') fail('invalid_manifest', 'plugin manifest must be an object');
  const identifier = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
  const match = typeof manifest.version === 'string'
    ? manifest.version.match(new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+((?:[0-9A-Za-z-]+)(?:\\.[0-9A-Za-z-]+)*))?$`))
    : null;
  if (!match || (match[5] && !/^codex\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(match[5]))) fail('invalid_manifest', 'manifest version must be strict SemVer with no build metadata except +codex.*');
  const baseVersion = `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`;
  return { manifest: { ...manifest, version: baseVersion }, baseVersion, bytes: Buffer.from(canonicalJson({ ...manifest, version: baseVersion })) };
}

export function treeHashV1(entries) {
  const normalized = entries.map(({ path, content }) => ({ path, content: Buffer.isBuffer(content) ? content : Buffer.from(content) }));
  for (const entry of normalized) {
    if (typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/') || entry.path.split('/').includes('..')) fail('invalid_hash_entry', 'treeHashV1 path must be a safe relative POSIX path');
  }
  normalized.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (let index = 1; index < normalized.length; index += 1) if (normalized[index - 1].path === normalized[index].path) fail('invalid_hash_entry', 'duplicate treeHashV1 path');
  const hash = createHash('sha256');
  for (const entry of normalized) {
    const path = Buffer.from(entry.path, 'utf8');
    const pathLength = Buffer.alloc(8); pathLength.writeBigUInt64BE(BigInt(path.length));
    const contentLength = Buffer.alloc(8); contentLength.writeBigUInt64BE(BigInt(entry.content.length));
    hash.update(pathLength); hash.update(path); hash.update(contentLength); hash.update(entry.content);
  }
  return hash.digest('hex');
}

function assertAbsoluteSyntax(value, option) {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || normalize(value) !== value) invalid(`${option} must be an absolute normalized path`);
}

export function parseArgs(argv) {
  const operation = argv[0];
  if (!['install', 'update', 'uninstall', 'preflight'].includes(operation)) invalid('expected install, update, uninstall or preflight');
  const repeatable = '--allowed-workspace-root';
  const options = { allowedWorkspaceRoots: [] };
  const names = new Map([
    ['--source-root', 'sourceRoot'], ['--managed-marketplace-root', 'managedRoot'],
    ['--node-executable', 'nodeExecutable'], ['--codex-executable', 'codexExecutable'],
    ['--agent-executable', 'agentExecutable'],
  ]);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) invalid(`missing value for ${flag}`);
    if (flag === repeatable) options.allowedWorkspaceRoots.push(value);
    else {
      const name = names.get(flag); if (!name) invalid(`unknown option: ${flag}`);
      if (options[name] !== undefined) invalid(`duplicate option: ${flag}`);
      options[name] = value;
    }
  }
  const required = operation === 'uninstall'
    ? ['managedRoot', 'codexExecutable']
    : operation === 'preflight'
      ? ['managedRoot', 'nodeExecutable', 'codexExecutable']
      : ['sourceRoot', 'managedRoot', 'nodeExecutable', 'codexExecutable', 'agentExecutable'];
  for (const name of required) if (!options[name]) invalid(`missing required option: ${name}`);
  if (['install', 'update'].includes(operation) && options.allowedWorkspaceRoots.length === 0) invalid('at least one --allowed-workspace-root is required');
  for (const [name, value] of Object.entries(options)) {
    if (name === 'allowedWorkspaceRoots') for (const item of value) assertAbsoluteSyntax(item, '--allowed-workspace-root');
    else if (value !== undefined) assertAbsoluteSyntax(value, name);
  }
  return { operation, ...options };
}

async function canonicalDirectory(path, label) {
  try {
    const canonical = await realpath(path); const info = await lstat(path);
    if (!info.isDirectory() || canonical !== path) fail('topology_invalid', `${label} must be a canonical directory`);
    return canonical;
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    fail('topology_invalid', `${label} must be an existing canonical directory`);
  }
}

async function canonicalExecutable(path, label) {
  try {
    const canonical = await realpath(path); const info = await lstat(path);
    if (!info.isFile() || canonical !== path) fail('missing_dependency', `${label} must be a canonical regular executable`);
    await access(path, fsConstants.X_OK); return canonical;
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    fail('missing_dependency', `${label} must be a canonical regular executable`);
  }
}

export async function validateTopology(options, { requireSource = false, requireAgent = false } = {}) {
  const parent = dirname(options.managedRoot);
  await canonicalDirectory(parent, 'managed marketplace parent');
  const managedRoot = options.managedRoot;
  const stagingPath = `${managedRoot}.agents-cursor-subagent-plugin.staging`;
  const backupPath = `${managedRoot}.agents-cursor-subagent-plugin.backup`;
  const protectedRoots = [managedRoot, stagingPath, backupPath];
  const sourceRoot = requireSource ? await canonicalDirectory(options.sourceRoot, 'source root') : null;
  const allowedWorkspaceRoots = requireSource ? await Promise.all(options.allowedWorkspaceRoots.map((path) => canonicalDirectory(path, 'allowed workspace root'))) : [];
  const nodeExecutable = options.nodeExecutable ? await canonicalExecutable(options.nodeExecutable, 'node executable') : null;
  const codexExecutable = await canonicalExecutable(options.codexExecutable, 'codex executable');
  const agentExecutable = requireAgent || options.agentExecutable ? await canonicalExecutable(options.agentExecutable, 'agent executable') : null;
  for (const root of [sourceRoot, ...allowedWorkspaceRoots].filter(Boolean)) {
    for (const protectedRoot of protectedRoots) if (overlaps(root, protectedRoot)) fail('topology_invalid', `${root} overlaps managed publication topology`);
  }
  for (const executable of [nodeExecutable, codexExecutable, agentExecutable].filter(Boolean)) {
    for (const root of [sourceRoot, ...protectedRoots].filter(Boolean)) if (inside(executable, root)) fail('topology_invalid', `${executable} is inside a protected directory root`);
  }
  return { ...options, sourceRoot, allowedWorkspaceRoots, nodeExecutable, codexExecutable, agentExecutable, managedRoot, stagingPath, backupPath, installRoot: join(managedRoot, PLUGIN_RELATIVE) };
}

export async function runPackageCommand(command, args, { env = process.env, timeoutMs = PACKAGE_LIMITS.timeoutMs,
  outputBytes = PACKAGE_LIMITS.outputBytes, closeWaitMs = 1_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let killReason = null; let settled = false; let timer; let closeTimer;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(closeTimer); done(result); } };
    const killAndWait = (reason) => {
      if (killReason) return;
      killReason = reason; child.kill('SIGKILL');
      closeTimer = setTimeout(() => finish({ code: null, output: Buffer.concat(chunks).toString('utf8'),
        timeout: reason === 'timeout', overflow: reason === 'overflow', closeTimeout: true }), closeWaitMs);
    };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > outputBytes) killAndWait('overflow');
      else chunks.push(chunk);
    });
    child.on('error', (error) => finish({ code: null, output: '', error: error.message }));
    child.on('close', (code) => finish({ code, output: Buffer.concat(chunks).toString('utf8'),
      timeout: killReason === 'timeout', overflow: killReason === 'overflow' }));
    timer = setTimeout(() => killAndWait('timeout'), timeoutMs);
  });
}

function adapterCommand(env) {
  let command;
  try { command = JSON.parse(env.CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND || 'null'); } catch { fail('adapter_unavailable', 'invalid adapter command JSON'); }
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string') || !isAbsolute(command[0])) fail('adapter_unavailable', 'CURSOR_SUBAGENT_CODEX_ADAPTER_COMMAND must be an absolute command JSON array');
  return command;
}

function assertAdmission(result) {
  if (result.admitted !== true || typeof result.adapter_version !== 'string' || !result.adapter_version ||
      typeof result.codex_version !== 'string' || !result.codex_version) {
    fail('adapter_drift', 'adapter admission rejected this Codex version');
  }
  return result;
}

async function admitAdapter(codexExecutable, deps) {
  const admission = assertAdmission(await invokeAdapter('admit', { codex_executable: codexExecutable }, deps));
  const help = await invokeAdapter('help', { codex_executable: codexExecutable }, deps);
  if (help.adapter_version !== admission.adapter_version || help.codex_version !== admission.codex_version ||
      !Array.isArray(help.operations) || help.operations.length !== ADAPTER_OPERATIONS.length ||
      help.operations.some((operation, index) => operation !== ADAPTER_OPERATIONS[index])) fail('adapter_drift', 'adapter help does not match admitted version and operation surface');
  return admission;
}

async function invokeAdapter(operation, request, deps, { mutation = false } = {}) {
  const command = adapterCommand(deps.env); const result = await deps.runCommand(command[0], [...command.slice(1), operation, JSON.stringify(request)], { env: deps.env });
  if (result.timeout) fail(mutation ? 'unknown_mutation_outcome' : 'timeout', `adapter ${operation} timed out`);
  if (result.overflow) fail(mutation ? 'unknown_mutation_outcome' : 'output_limit', `adapter ${operation} exceeded output limit`);
  if (result.code !== 0) fail(mutation ? 'unknown_mutation_outcome' : 'adapter_failure', `adapter ${operation} failed: ${result.error || result.output || result.code}`);
  let parsed; try { parsed = JSON.parse(result.output); } catch { fail('adapter_drift', `adapter ${operation} returned invalid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('adapter_drift', `adapter ${operation} returned invalid shape`);
  return parsed;
}

async function listRegistrations(topology, deps) {
  const request = { codex_executable: topology.codexExecutable };
  const marketplaces = await invokeAdapter('marketplace-list', request, deps);
  const plugins = await invokeAdapter('plugin-list', request, deps);
  if (!Array.isArray(marketplaces.registrations) || !marketplaces.registrations.every((item) => item && typeof item.id === 'string' && typeof item.path === 'string') ||
      !Array.isArray(plugins.registrations) || !plugins.registrations.every((item) => item && typeof item.id === 'string' && typeof item.marketplace_id === 'string' && typeof item.source === 'string' && typeof item.version === 'string')) fail('adapter_drift', 'adapter list shape is incompatible');
  return { marketplaces: marketplaces.registrations, plugins: plugins.registrations };
}

function tupleState(registrations, topology, manifestVersion = null) {
  const marketplaces = registrations.marketplaces.filter((item) => item?.id === PACKAGE_IDS.marketplace);
  const plugins = registrations.plugins.filter((item) => item?.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace);
  if (marketplaces.length === 0 && plugins.length === 0) return 'absent';
  if (marketplaces.length === 1 && plugins.length === 1 && marketplaces[0].path === topology.managedRoot &&
      plugins[0].marketplace_id === PACKAGE_IDS.marketplace && plugins[0].source === topology.installRoot &&
      (manifestVersion === null || plugins[0].version === manifestVersion)) return 'exact';
  return 'foreign';
}

function isExactRegistrationDelta(registrations, topology, manifestVersion = null) {
  const marketplaces = registrations.marketplaces.filter((item) => item.id === PACKAGE_IDS.marketplace);
  const plugins = registrations.plugins.filter((item) => item.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace);
  const marketplaceAdmitted = marketplaces.length === 0 || (marketplaces.length === 1 && marketplaces[0].path === topology.managedRoot);
  const pluginAdmitted = plugins.length === 0 || (plugins.length === 1 && plugins[0].marketplace_id === PACKAGE_IDS.marketplace && plugins[0].source === topology.installRoot && (manifestVersion === null || plugins[0].version === manifestVersion));
  return marketplaceAdmitted && pluginAdmitted && ((marketplaces.length === 1) !== (plugins.length === 1));
}

function exactMarketplaceOnly(registrations, topology) {
  const marketplaces = registrations.marketplaces.filter((item) => item?.id === PACKAGE_IDS.marketplace);
  const plugins = registrations.plugins.filter((item) => item?.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace);
  return marketplaces.length === 1 && marketplaces[0].path === topology.managedRoot && plugins.length === 0;
}

function registrationCheck(name, matches, exact) {
  if (matches.length === 0) return check(name, 'fail', 'absent', `${name} is absent`);
  if (matches.length === 1 && exact(matches[0])) return check(name, 'pass', 'exact', `${name} is exact`);
  return check(name, 'fail', matches.length > 1 ? 'duplicate' : 'foreign', `${name} is foreign or duplicated`);
}

async function collectTree(root, { excludeMarker = false } = {}) {
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      if (excludeMarker && !prefix && name === MARKER_NAME) continue;
      const absolute = join(directory, name); const relativePath = prefix ? `${prefix}/${name}` : name; const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail('foreign_artifact', `unsupported artifact entry: ${relativePath}`);
      if (info.isDirectory()) await visit(absolute, relativePath); else entries.push({ path: relativePath, content: await readFile(absolute) });
    }
  }
  await visit(root); return entries;
}

async function collectPayload(sourceRoot) {
  const fixed = ['.codex-plugin/plugin.json', 'README.md', 'scripts/cursor-subagent-mcp.mjs', 'scripts/cursor-model-adapter.mjs', 'scripts/recording-mcp-proxy.mjs', 'scripts/cursor-subagent-bootstrap.mjs'];
  const entries = [];
  for (const path of fixed) {
    const absolute = join(sourceRoot, path); const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail('invalid_payload', `required regular payload file is missing: ${path}`);
    const content = path === '.codex-plugin/plugin.json' ? normalizeManifestBytes(await readFile(absolute)).bytes : await readFile(absolute);
    entries.push({ path, content });
  }
  const skillsRoot = join(sourceRoot, 'skills');
  const info = await lstat(skillsRoot).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) fail('invalid_payload', 'skills must be a regular directory');
  for (const entry of await collectTree(skillsRoot)) entries.push({ path: `skills/${entry.path}`, content: entry.content });
  return entries;
}

async function writePayload(stagingPath, sourceRoot, entries, payloadHash, topology, deps) {
  await mkdir(stagingPath);
  for (const entry of entries) {
    const destination = join(stagingPath, PLUGIN_RELATIVE, ...entry.path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    let content = entry.content;
    if (entry.path === '.codex-plugin/plugin.json') {
      const normalized = normalizeManifestBytes(content); normalized.manifest.version = `${normalized.baseVersion}+codex.${payloadHash}`; content = Buffer.from(canonicalJson(normalized.manifest));
    }
    await writeFile(destination, content);
    if (entry.path.startsWith('scripts/')) await chmod(destination, 0o755);
  }
  const rendered = await invokeAdapter('render', {
    managed_root: topology.managedRoot, install_root: topology.installRoot,
    codex_executable: topology.codexExecutable,
    node_executable: topology.nodeExecutable, agent_executable: topology.agentExecutable,
    allowed_workspace_roots: topology.allowedWorkspaceRoots,
  }, deps);
  if (!Array.isArray(rendered.files)) fail('adapter_drift', 'adapter render shape is incompatible');
  const renderedPaths = new Set();
  for (const file of rendered.files) {
    if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((part) => !part || part === '.' || part === '..') || typeof file.content_base64 !== 'string') fail('adapter_drift', 'adapter render file is invalid');
    const destination = resolve(stagingPath, ...file.path.split('/'));
    if (renderedPaths.has(file.path) || await lstat(destination).then(() => true).catch(() => false)) fail('adapter_drift', 'adapter render path duplicates or overrides payload');
    renderedPaths.add(file.path); const content = Buffer.from(file.content_base64, 'base64');
    if (content.toString('base64') !== file.content_base64) fail('adapter_drift', 'adapter render content is not canonical base64');
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content);
  }
}

async function readMarker(root) {
  try { return JSON.parse(await readFile(join(root, MARKER_NAME), 'utf8')); } catch { return null; }
}

const MARKER_KEYS = ['agent_executable', 'artifact_hash', 'format', 'manifest_version', 'marketplace_id', 'operation', 'payload_hash', 'plugin_id'];
function validMarkerShape(marker) {
  if (!marker || Array.isArray(marker) || typeof marker !== 'object' || Object.keys(marker).sort().join('\0') !== MARKER_KEYS.join('\0')) return false;
  if (marker.format !== 1 || !['install', 'update'].includes(marker.operation) || marker.marketplace_id !== PACKAGE_IDS.marketplace || marker.plugin_id !== PACKAGE_IDS.plugin) return false;
  if (!/^[0-9a-f]{64}$/.test(marker.payload_hash) || !/^[0-9a-f]{64}$/.test(marker.artifact_hash)) return false;
  if (typeof marker.agent_executable !== 'string' || !isAbsolute(marker.agent_executable) || normalize(marker.agent_executable) !== marker.agent_executable) return false;
  try {
    const normalized = normalizeManifestBytes(JSON.stringify({ version: marker.manifest_version }));
    return marker.manifest_version === `${normalized.baseVersion}+codex.${marker.payload_hash}`;
  } catch { return false; }
}

async function validOwnedRoot(root) {
  const marker = await readMarker(root); if (!validMarkerShape(marker)) return null;
  const hash = treeHashV1(await collectTree(root, { excludeMarker: true })); return hash === marker.artifact_hash ? marker : null;
}

async function pathKind(path) {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink() ? 'directory' : 'foreign'; } catch (error) { return error.code === 'ENOENT' ? 'absent' : 'foreign'; }
}

async function classify(topology, registrations) {
  const activeKind = await pathKind(topology.managedRoot); const stageKind = await pathKind(topology.stagingPath); const backupKind = await pathKind(topology.backupPath);
  if (stageKind !== 'absent' && backupKind !== 'absent') return { state: 'failed' };
  if (stageKind !== 'absent') return stageKind === 'directory' && await validOwnedRoot(topology.stagingPath)
    ? { state: 'recovery_required', staging_path: topology.stagingPath } : { state: 'failed' };
  if (backupKind !== 'absent') {
    if (backupKind === 'directory') {
      const activeMarker = activeKind === 'directory' ? await validOwnedRoot(topology.managedRoot) : null;
      const activeCommitted = activeMarker && tupleState(registrations, topology, activeMarker.manifest_version) === 'exact';
      const absentCommitted = activeKind === 'absent' && tupleState(registrations, topology) === 'absent';
      const entries = await readdir(topology.backupPath); const marker = await readMarker(topology.backupPath); const ownedBackup = validMarkerShape(marker);
      if ((activeCommitted || absentCommitted) && (ownedBackup || entries.length === 0)) return { state: 'cleanup_required', backup_path: topology.backupPath };
      if (ownedBackup) return { state: 'recovery_required', backup_path: topology.backupPath };
    }
    return { state: 'failed' };
  }
  if (activeKind === 'absent') {
    if (tupleState(registrations, topology) === 'absent') return { state: 'absent' };
    return { state: isExactRegistrationDelta(registrations, topology) ? 'recovery_required' : 'failed' };
  }
  if (activeKind !== 'directory') return { state: 'failed' };
  const marker = await validOwnedRoot(topology.managedRoot);
  if (marker && tupleState(registrations, topology, marker.manifest_version) === 'exact') return { state: 'installed', marker };
  if (marker && isExactRegistrationDelta(registrations, topology, marker.manifest_version)) return { state: 'recovery_required', marker };
  return { state: 'failed', marker };
}

const check = (name, status, code, message) => ({ name, status, code, message: bounded(message) });

async function executableCheck(name, path) {
  if (!path) return check(name, 'fail', 'missing_dependency', `${name} was not provided`);
  try { await canonicalExecutable(path, name); return check(name, 'pass', 'ok', `${name} is executable`); }
  catch (error) { return check(name, 'fail', error.code || 'missing_dependency', error.message); }
}

async function preflightTopology(managedRoot) {
  const parent = dirname(managedRoot); await canonicalDirectory(parent, 'managed marketplace parent');
  const kind = await pathKind(managedRoot);
  if (kind === 'foreign') fail('topology_invalid', 'managed root must be absent or a canonical directory');
  if (kind === 'directory' && await realpath(managedRoot) !== managedRoot) fail('topology_invalid', 'managed root must be canonical');
  return { managedRoot, stagingPath: `${managedRoot}.agents-cursor-subagent-plugin.staging`,
    backupPath: `${managedRoot}.agents-cursor-subagent-plugin.backup`, installRoot: join(managedRoot, PLUGIN_RELATIVE) };
}

async function preflightExecutable(name, path, topology) {
  const result = await executableCheck(name, path); if (result.status !== 'pass') return result;
  if ([topology.managedRoot, topology.stagingPath, topology.backupPath].some((root) => inside(path, root))) return check(name, 'fail', 'topology_invalid', `${name} is inside managed publication topology`);
  return result;
}

export async function preflight(options, deps) {
  const checks = new Map(); let topology;
  try { topology = await preflightTopology(options.managedRoot); checks.set('managed_root', check('managed_root', 'pass', 'ok', 'managed topology is valid')); }
  catch (error) { checks.set('managed_root', check('managed_root', 'fail', error.code || 'topology_invalid', error.message)); }
  const fallbackTopology = topology || { managedRoot: options.managedRoot, stagingPath: `${options.managedRoot}.agents-cursor-subagent-plugin.staging`, backupPath: `${options.managedRoot}.agents-cursor-subagent-plugin.backup` };
  const nodeBase = await preflightExecutable('node', options.nodeExecutable, fallbackTopology);
  if (nodeBase.status === 'pass') {
    const version = await deps.runCommand(options.nodeExecutable, ['--version'], { env: deps.env });
    const major = version.code === 0 && !version.overflow && !version.timeout ? Number(version.output.trim().match(/^v?(\d+)/)?.[1]) : NaN;
    checks.set('node', Number.isInteger(major) && major >= 18 ? check('node', 'pass', 'ok', `Node ${major}`) : check('node', 'fail', 'incompatible_version', 'Node 18 or newer is required'));
  } else checks.set('node', nodeBase);
  checks.set('agent_executable', await preflightExecutable('agent_executable', options.agentExecutable, fallbackTopology));
  let admitted = false;
  try {
    const executable = await preflightExecutable('codex_cli', options.codexExecutable, fallbackTopology);
    if (executable.status !== 'pass') fail(executable.code, executable.message);
    const result = await admitAdapter(options.codexExecutable, deps);
    if (topology) topology.codexExecutable = options.codexExecutable;
    admitted = true; checks.set('codex_cli', check('codex_cli', 'pass', 'ok', `admitted adapter ${result.adapter_version} for Codex ${result.codex_version}`));
  } catch (error) { checks.set('codex_cli', check('codex_cli', 'fail', error.code || 'adapter_failure', error.message)); }
  let registrations;
  if (admitted && topology) {
    try {
      registrations = await listRegistrations(topology, deps);
      const installedMarker = await validOwnedRoot(topology.managedRoot).catch(() => null);
      checks.set('marketplace_registration', registrationCheck('marketplace_registration',
        registrations.marketplaces.filter((item) => item.id === PACKAGE_IDS.marketplace), (item) => item.path === topology.managedRoot));
      checks.set('plugin_registration', registrationCheck('plugin_registration',
        registrations.plugins.filter((item) => item.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace),
        (item) => item.marketplace_id === PACKAGE_IDS.marketplace && item.source === topology.installRoot && item.version === installedMarker?.manifest_version));
    } catch (error) {
      checks.set('marketplace_registration', check('marketplace_registration', 'fail', error.code || 'adapter_failure', error.message));
      checks.set('plugin_registration', check('plugin_registration', 'fail', error.code || 'adapter_failure', error.message));
    }
  } else {
    checks.set('marketplace_registration', check('marketplace_registration', 'not_checked', 'prerequisite_failed', 'codex_cli prerequisite failed'));
    checks.set('plugin_registration', check('plugin_registration', 'not_checked', 'prerequisite_failed', 'codex_cli prerequisite failed'));
  }
  if (topology) {
    try { const result = await invokeAdapter('mcp-check', { managed_root: topology.managedRoot }, deps); checks.set('mcp_config', check('mcp_config', result.ok === true ? 'pass' : 'fail', result.ok === true ? 'ok' : 'config_missing', result.message || 'managed MCP config checked')); }
    catch (error) { checks.set('mcp_config', check('mcp_config', 'fail', error.code || 'adapter_failure', error.message)); }
  } else checks.set('mcp_config', check('mcp_config', 'not_checked', 'prerequisite_failed', 'managed_root prerequisite failed'));
  let authState = 'unknown';
  if (checks.get('agent_executable').status === 'pass') {
    try {
      const result = await invokeAdapter('agent-status', { agent_executable: options.agentExecutable }, deps);
      authState = result.verified === true && ['authenticated', 'required', 'unknown'].includes(result.auth_state) ? result.auth_state : 'unknown';
      const authenticated = result.ok === true && authState === 'authenticated';
      checks.set('agent_status', check('agent_status', authenticated ? 'pass' : 'fail', authenticated ? 'ok' : authState === 'required' ? 'auth_required' : 'auth_unknown', result.message || `authentication ${authState}`));
    } catch (error) { checks.set('agent_status', check('agent_status', 'fail', error.code || 'adapter_failure', error.message)); }
  } else checks.set('agent_status', check('agent_status', 'not_checked', 'prerequisite_failed', 'agent_executable prerequisite failed'));
  const ordered = CHECK_NAMES.map((name) => checks.get(name)); const ready = ordered.every((item) => item.status === 'pass');
  return { ok: ready, operation: 'preflight', state: ready ? 'ready' : 'not_ready', auth_state: authState, checks: ordered, error_code: ready ? null : 'preflight_failed', message: ready ? null : 'one or more preflight checks failed' };
}

async function mutate(operation, request, topology, deps) {
  let uncertain = null;
  try {
    const result = await invokeAdapter(operation, { codex_executable: topology.codexExecutable, ...request }, deps, { mutation: true });
    if (result.ok !== true) fail('unknown_mutation_outcome', `adapter ${operation} did not confirm success`);
  }
  catch (error) { uncertain = error; }
  const journalEntry = { operation, command_outcome: uncertain ? 'unknown' : 'success', observed: null };
  deps.journal.push(journalEntry);
  let registrations;
  try { registrations = await listRegistrations(topology, deps); }
  catch (error) {
    const recovery = new BootstrapError('recovery_required', `registration reread failed after ${operation}: ${error.message}`);
    recovery.lastCompletedStep = operation; throw recovery;
  }
  if (uncertain) uncertain.observed = registrations;
  journalEntry.observed = tupleState(registrations, topology);
  return { registrations, uncertain };
}

async function removeOwnedTree(path) { if (await validOwnedRoot(path)) await rm(path, { recursive: true }); }

async function publicationRename(from, to, name, deps) {
  await deps.fault(`publication:before-${name}`, { from, to });
  await rename(from, to);
  await deps.fault(`publication:after-${name}`, { from, to });
}

async function cleanupBackup(topology, deps) {
  const marker = await readMarker(topology.backupPath); if (!validMarkerShape(marker)) fail('cleanup_required', 'backup marker is not owned');
  for (const name of await readdir(topology.backupPath)) if (name !== MARKER_NAME) {
    await deps.fault(`cleanup:before-entry:${name}`, join(topology.backupPath, name));
    await rm(join(topology.backupPath, name), { recursive: true });
    await deps.fault(`cleanup:after-entry:${name}`, join(topology.backupPath, name));
  }
  await deps.fault('cleanup:before-marker', join(topology.backupPath, MARKER_NAME));
  await rm(join(topology.backupPath, MARKER_NAME));
  await deps.fault('cleanup:after-marker', join(topology.backupPath, MARKER_NAME));
  await deps.fault('cleanup:before-directory', topology.backupPath);
  await rm(topology.backupPath, { recursive: true });
}

const recoveryEnvelope = (operation, topology, message, journal = []) => ({
  ok: false, operation, state: 'recovery_required', error_code: 'recovery_required', message: bounded(message),
  backup_path: null, staging_path: null, last_completed_step: journal.at(-1)?.operation || null,
});

async function prepareStage(topology, deps, operation) {
  const entries = await collectPayload(topology.sourceRoot); const payloadHash = treeHashV1(entries);
  await writePayload(topology.stagingPath, topology.sourceRoot, entries, payloadHash, topology, deps);
  const artifactHash = treeHashV1(await collectTree(topology.stagingPath, { excludeMarker: true }));
  const normalized = normalizeManifestBytes(entries.find((entry) => entry.path === '.codex-plugin/plugin.json').content);
  const marker = { format: 1, operation, payload_hash: payloadHash, artifact_hash: artifactHash,
    manifest_version: `${normalized.baseVersion}+codex.${payloadHash}`, marketplace_id: PACKAGE_IDS.marketplace,
    plugin_id: PACKAGE_IDS.plugin, agent_executable: topology.agentExecutable };
  await writeFile(join(topology.stagingPath, MARKER_NAME), canonicalJson(marker)); return marker;
}

async function prepareOwnedStage(topology, deps, operation) {
  try { return await prepareStage(topology, deps, operation); }
  catch (error) {
    let cleanupError = null;
    try { await rm(topology.stagingPath, { recursive: true, force: true }); }
    catch (caught) { cleanupError = caught; }
    if (await pathKind(topology.stagingPath) !== 'absent') {
      const recovery = new BootstrapError('recovery_required',
        `stage preparation failed and owned staging cleanup failed: ${cleanupError?.message || error.message}`);
      recovery.stagingPath = topology.stagingPath;
      throw recovery;
    }
    throw error;
  }
}

async function operate(parsed, deps) {
  const topology = await validateTopology(parsed, { requireSource: parsed.operation !== 'uninstall', requireAgent: parsed.operation !== 'uninstall' });
  await admitAdapter(topology.codexExecutable, deps);
  let registrations = await listRegistrations(topology, deps); const current = await classify(topology, registrations);
  if (current.state === 'cleanup_required' || current.state === 'recovery_required') return { ok: false, operation: parsed.operation, state: current.state, error_code: current.state, message: 'manual recovery is required', backup_path: current.backup_path || null, staging_path: current.staging_path || null };
  if (current.state === 'failed') fail('state_drift', 'managed artifact or registration state is foreign or inconsistent');
  if (parsed.operation === 'install' && current.state === 'installed') {
    const staged = await prepareOwnedStage(topology, deps, 'install');
    await removeOwnedTree(topology.stagingPath);
    if (staged.payload_hash === current.marker.payload_hash && staged.artifact_hash === current.marker.artifact_hash) return { ok: true, operation: 'install', state: 'installed', error_code: null, message: null };
    fail('update_required', 'an owned different payload requires update');
  }
  if (parsed.operation === 'update' && current.state === 'absent') fail('not_installed', 'update requires an owned installation');
  if (parsed.operation === 'uninstall' && current.state === 'absent') return { ok: true, operation: 'uninstall', state: 'absent', error_code: null, message: null };

  if (parsed.operation === 'install') {
    const prepared = await prepareOwnedStage(topology, deps, 'install');
    try { await publicationRename(topology.stagingPath, topology.managedRoot, 'install-stage-to-active', deps); }
    catch {
      await removeOwnedTree(topology.stagingPath); await removeOwnedTree(topology.managedRoot);
      if (await pathKind(topology.stagingPath) !== 'absent' || await pathKind(topology.managedRoot) !== 'absent') return recoveryEnvelope('install', topology, 'install publication compensation left an owned artifact', deps.journal);
      fail('install_failed', 'install publication failed before registration');
    }
    let outcome = await mutate('marketplace-add', { id: PACKAGE_IDS.marketplace, path: topology.managedRoot }, topology, deps);
    const marketplace = outcome.registrations.marketplaces.find((item) => item.id === PACKAGE_IDS.marketplace);
    const pluginBeforeAdd = outcome.registrations.plugins.find((item) => item.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace);
    if (marketplace?.path !== topology.managedRoot || pluginBeforeAdd || outcome.uncertain) {
      if ((marketplace && marketplace.path !== topology.managedRoot) || pluginBeforeAdd) return recoveryEnvelope('install', topology, 'marketplace add observed a foreign registration delta', deps.journal);
      const compensation = marketplace ? await mutate('marketplace-remove', { id: PACKAGE_IDS.marketplace }, topology, deps).catch(() => null) : outcome;
      if (!compensation || tupleState(compensation.registrations, topology) !== 'absent') return recoveryEnvelope('install', topology, 'marketplace add compensation did not restore the initial state', deps.journal);
      await removeOwnedTree(topology.managedRoot); fail('install_failed', `marketplace registration failed: ${outcome.uncertain?.message || 'observed registration did not match'}`);
    }
    outcome = await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: prepared.manifest_version }, topology, deps);
    if (tupleState(outcome.registrations, topology, prepared.manifest_version) !== 'exact' || outcome.uncertain) {
      const observedPlugins = outcome.registrations.plugins.filter((item) => item.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace);
      const observedExact = observedPlugins.length === 1 && observedPlugins[0].marketplace_id === PACKAGE_IDS.marketplace && observedPlugins[0].source === topology.installRoot && observedPlugins[0].version === prepared.manifest_version;
      if (observedPlugins.length && !observedExact) return recoveryEnvelope('install', topology, 'plugin add observed a foreign registration delta', deps.journal);
      if (observedExact) await mutate('plugin-remove', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace }, topology, deps).catch(() => null);
      const compensation = await mutate('marketplace-remove', { id: PACKAGE_IDS.marketplace }, topology, deps).catch(() => null);
      if (!compensation || tupleState(compensation.registrations, topology) !== 'absent') return recoveryEnvelope('install', topology, 'plugin add compensation did not restore the initial state', deps.journal);
      await removeOwnedTree(topology.managedRoot); fail('install_failed', 'plugin registration failed');
    }
    return { ok: true, operation: 'install', state: 'installed', error_code: null, message: null };
  }

  if (parsed.operation === 'update') {
    const staged = await prepareOwnedStage(topology, deps, 'update');
    if (staged.payload_hash === current.marker.payload_hash && staged.artifact_hash === current.marker.artifact_hash) { await removeOwnedTree(topology.stagingPath); return { ok: true, operation: 'update', state: 'installed', error_code: null, message: null }; }
    let outcome = await mutate('plugin-remove', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace }, topology, deps);
    if (outcome.uncertain) {
      const observed = outcome.registrations.plugins.filter((item) => item.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace);
      const unchanged = tupleState(outcome.registrations, topology, current.marker.manifest_version) === 'exact';
      if (!unchanged && !exactMarketplaceOnly(outcome.registrations, topology)) {
        return recoveryEnvelope('update', topology, 'uncertain plugin removal observed foreign registration state', deps.journal);
      }
      const compensation = !unchanged && observed.length === 0
        ? await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: current.marker.manifest_version }, topology, deps).catch(() => null)
        : outcome;
      await removeOwnedTree(topology.stagingPath);
      if (!compensation || tupleState(compensation.registrations, topology, current.marker.manifest_version) !== 'exact') return recoveryEnvelope('update', topology, 'uncertain plugin removal compensation did not restore the prior state', deps.journal);
      fail('update_failed', 'plugin removal outcome was uncertain');
    }
    if (tupleState(outcome.registrations, topology, current.marker.manifest_version) === 'exact') {
      await removeOwnedTree(topology.stagingPath); fail('update_failed', 'old plugin removal failed');
    }
    if (!exactMarketplaceOnly(outcome.registrations, topology)) {
      return recoveryEnvelope('update', topology, 'plugin removal observed foreign, duplicate or coupled registration state', deps.journal);
    }
    try {
      await publicationRename(topology.managedRoot, topology.backupPath, 'update-active-to-backup', deps);
      await publicationRename(topology.stagingPath, topology.managedRoot, 'update-stage-to-active', deps);
    } catch {
      const active = await validOwnedRoot(topology.managedRoot);
      if (active && active.artifact_hash !== current.marker.artifact_hash) await removeOwnedTree(topology.managedRoot);
      if (await pathKind(topology.backupPath) === 'directory' && await pathKind(topology.managedRoot) === 'absent') await rename(topology.backupPath, topology.managedRoot).catch(() => {});
      await removeOwnedTree(topology.stagingPath);
      const observed = await listRegistrations(topology, deps).catch(() => null);
      if (!observed || !exactMarketplaceOnly(observed, topology)) return recoveryEnvelope('update', topology, 'update publication failure observed foreign registration state', deps.journal);
      const compensation = await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: current.marker.manifest_version }, topology, deps).catch(() => null);
      if (!compensation || tupleState(compensation.registrations, topology, current.marker.manifest_version) !== 'exact' || await pathKind(topology.backupPath) !== 'absent' || !await validOwnedRoot(topology.managedRoot)) return recoveryEnvelope('update', topology, 'update publication compensation did not restore the prior state', deps.journal);
      fail('update_failed', 'update publication failed before commit');
    }
    outcome = await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: staged.manifest_version }, topology, deps);
    if (tupleState(outcome.registrations, topology, staged.manifest_version) !== 'exact' || outcome.uncertain) {
      const exactNew = tupleState(outcome.registrations, topology, staged.manifest_version) === 'exact';
      if (!exactNew && !exactMarketplaceOnly(outcome.registrations, topology)) return recoveryEnvelope('update', topology, 'new plugin add observed foreign registration state', deps.journal);
      if (exactNew) {
        const removed = await mutate('plugin-remove', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace }, topology, deps).catch(() => null);
        if (!removed || !exactMarketplaceOnly(removed.registrations, topology)) return recoveryEnvelope('update', topology, 'new plugin compensation did not produce the expected single delta', deps.journal);
      }
      await removeOwnedTree(topology.managedRoot); await rename(topology.backupPath, topology.managedRoot);
      const compensation = await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: current.marker.manifest_version }, topology, deps).catch(() => null);
      if (!compensation || tupleState(compensation.registrations, topology, current.marker.manifest_version) !== 'exact') return recoveryEnvelope('update', topology, 'update compensation did not restore the prior registration state', deps.journal);
      fail('update_failed', 'new plugin registration failed');
    }
    try { await cleanupBackup(topology, deps); } catch (error) { return { ok: false, operation: 'update', state: 'cleanup_required', error_code: 'cleanup_required', message: bounded(`remove backup manually: ${error.message}`), backup_path: topology.backupPath, staging_path: null }; }
    return { ok: true, operation: 'update', state: 'installed', error_code: null, message: null };
  }

  let outcome = await mutate('plugin-remove', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace }, topology, deps);
  if (outcome.uncertain) {
    const observed = outcome.registrations.plugins.filter((item) => item.id === PACKAGE_IDS.plugin && item.marketplace_id === PACKAGE_IDS.marketplace);
    const unchanged = tupleState(outcome.registrations, topology, current.marker.manifest_version) === 'exact';
    if (!unchanged && !exactMarketplaceOnly(outcome.registrations, topology)) {
      return recoveryEnvelope('uninstall', topology, 'uncertain plugin removal observed foreign registration state', deps.journal);
    }
    const compensation = !unchanged && observed.length === 0
      ? await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: current.marker.manifest_version }, topology, deps).catch(() => null)
      : outcome;
    if (!compensation || tupleState(compensation.registrations, topology, current.marker.manifest_version) !== 'exact') return recoveryEnvelope('uninstall', topology, 'uncertain plugin removal compensation did not restore the prior state', deps.journal);
    fail('uninstall_failed', 'plugin removal outcome was uncertain');
  }
  if (tupleState(outcome.registrations, topology, current.marker.manifest_version) === 'exact') fail('uninstall_failed', 'plugin removal failed');
  if (!exactMarketplaceOnly(outcome.registrations, topology)) {
    return recoveryEnvelope('uninstall', topology, 'plugin removal observed foreign, duplicate or coupled registration state', deps.journal);
  }
  outcome = await mutate('marketplace-remove', { id: PACKAGE_IDS.marketplace }, topology, deps);
  if (outcome.uncertain) {
    if (!exactMarketplaceOnly(outcome.registrations, topology)) return recoveryEnvelope('uninstall', topology, 'uncertain marketplace removal observed coupled or foreign registration state', deps.journal);
    const compensation = await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: current.marker.manifest_version }, topology, deps).catch(() => null);
    if (!compensation || tupleState(compensation.registrations, topology, current.marker.manifest_version) !== 'exact') return recoveryEnvelope('uninstall', topology, 'uninstall compensation did not restore the prior registration state', deps.journal);
    fail('uninstall_failed', 'marketplace removal outcome was uncertain');
  }
  if (tupleState(outcome.registrations, topology) !== 'absent') {
    if (!exactMarketplaceOnly(outcome.registrations, topology)) return recoveryEnvelope('uninstall', topology, 'marketplace removal observed foreign registration state', deps.journal);
    const compensation = await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: current.marker.manifest_version }, topology, deps).catch(() => null);
    if (!compensation || tupleState(compensation.registrations, topology, current.marker.manifest_version) !== 'exact') return recoveryEnvelope('uninstall', topology, 'uninstall compensation did not restore the prior registration state', deps.journal);
    fail('uninstall_failed', 'marketplace removal failed');
  }
  try { await publicationRename(topology.managedRoot, topology.backupPath, 'uninstall-active-to-backup', deps); }
  catch {
    if (await pathKind(topology.backupPath) === 'directory' && await pathKind(topology.managedRoot) === 'absent') {
      return { ok: false, operation: 'uninstall', state: 'cleanup_required', error_code: 'cleanup_required', message: 'remove backup manually', backup_path: topology.backupPath, staging_path: null };
    }
    const marketplace = await mutate('marketplace-add', { id: PACKAGE_IDS.marketplace, path: topology.managedRoot }, topology, deps).catch(() => null);
    const plugin = marketplace && await mutate('plugin-add', { id: PACKAGE_IDS.plugin, marketplace_id: PACKAGE_IDS.marketplace, source: topology.installRoot, version: current.marker.manifest_version }, topology, deps).catch(() => null);
    if (!plugin || tupleState(plugin.registrations, topology, current.marker.manifest_version) !== 'exact') return recoveryEnvelope('uninstall', topology, 'uninstall publication compensation did not restore registrations', deps.journal);
    fail('uninstall_failed', 'uninstall publication failed before commit');
  }
  try { await cleanupBackup(topology, deps); } catch (error) { return { ok: false, operation: 'uninstall', state: 'cleanup_required', error_code: 'cleanup_required', message: bounded(`remove backup manually: ${error.message}`), backup_path: topology.backupPath, staging_path: null }; }
  return { ok: true, operation: 'uninstall', state: 'absent', error_code: null, message: null };
}

export async function runBootstrap(argv, overrides = {}) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { return { exitCode: error.exitCode || 2, envelope: { ok: false, operation: argv[0] || null, state: 'failed', error_code: error.code || 'invalid_invocation', message: bounded(error.message) } }; }
  const deps = { runCommand: overrides.runCommand || runPackageCommand, env: overrides.env || process.env,
    fault: overrides.fault || (async () => {}), journal: [] };
  try {
    const envelope = parsed.operation === 'preflight' ? await preflight(parsed, deps) : await operate(parsed, deps);
    return { exitCode: envelope.ok ? 0 : 1, envelope };
  } catch (error) {
    const recovery = error.code === 'cleanup_required' ? 'cleanup_required' : error.code === 'recovery_required' ? 'recovery_required' : 'failed';
    return { exitCode: error.exitCode || 1, envelope: { ok: false, operation: parsed.operation, state: recovery, error_code: error.code || 'internal_error', message: bounded(error.message), ...(recovery !== 'failed' ? { backup_path: error.backupPath || null, staging_path: error.stagingPath || null, last_completed_step: error.lastCompletedStep || deps.journal.at(-1)?.operation || null } : {}) } };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runBootstrap(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.envelope)}\n`); process.exitCode = result.exitCode;
}
