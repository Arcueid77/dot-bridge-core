import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const coreRoot = fileURLToPath(new URL('../', import.meta.url));
const bridgePackage = /^(?:dot-bridge|@dot-bridge\/core|dot-(?:lark|qq|dingtalk|wecom|weixin|discord|telegram|line)-bridge)$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;

function text(file, limit = 4096) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return null;
    return fs.readFileSync(file, 'utf8').trim();
  } catch { return null; }
}

export function gitRevision(root) {
  try {
    const marker = path.join(root, '.git'), stat = fs.lstatSync(marker);
    if (stat.isSymbolicLink()) return null;
    const pointer = stat.isDirectory() ? null : text(marker);
    const directory = stat.isDirectory() ? marker : pointer?.startsWith('gitdir: ') ? path.resolve(root, pointer.slice(8)) : null;
    if (!directory) return null;
    const head = text(path.join(directory, 'HEAD'));
    if (revisionPattern.test(head ?? '')) return head;
    const reference = /^ref: (refs\/[^\x00-\x20\\]+)$/u.exec(head ?? '')?.[1];
    if (!reference || reference.split('/').some(part => !part || part === '.' || part === '..')) return null;
    const common = text(path.join(directory, 'commondir'));
    const directories = [directory, ...(common ? [path.resolve(directory, common)] : [])];
    for (const candidate of directories) {
      const value = text(path.join(candidate, reference));
      if (revisionPattern.test(value ?? '')) return value;
      const packed = text(path.join(candidate, 'packed-refs'), 1024 * 1024);
      const match = packed?.split('\n').find(line => line.slice(41) === reference);
      if (match && revisionPattern.test(match.slice(0, 40))) return match.slice(0, 40);
    }
  } catch {}
  return null;
}

export function packageRuntime(root) {
  const raw = text(path.join(root, 'package.json'), 1024 * 1024);
  if (!raw) return null;
  let packageInfo;
  try { packageInfo = JSON.parse(raw); } catch { return null; }
  if (!bridgePackage.test(packageInfo.name ?? '') || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(packageInfo.version ?? '')) return null;
  const git = gitRevision(root), exported = text(path.join(root, 'source-revision.txt'), 128);
  let dirty = null;
  if (git && (process.platform === 'win32' || fs.statSync(root).uid === process.getuid?.())) {
    const result = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'],
      {encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 65536, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
    if (result.status === 0) dirty = Boolean(result.stdout.trim());
  }
  return {package: packageInfo.name, version: packageInfo.version, revision: git ?? (revisionPattern.test(exported ?? '') ? exported : null),
    source_kind: git ? 'git' : revisionPattern.test(exported ?? '') ? 'archive' : 'unknown', worktree_dirty: dirty};
}

export function runtimeInfo() {
  const core = packageRuntime(coreRoot);
  let current = path.dirname(coreRoot), installation = core;
  for (let depth = 0; depth < 10; depth++) {
    const candidate = packageRuntime(current);
    if (candidate) installation = candidate;
    if (candidate?.package === 'dot-bridge' || path.dirname(current) === current) break;
    current = path.dirname(current);
  }
  return {...installation, core_version: core.version, core_revision: core.revision,
    node_version: process.versions.node, platform: process.platform, arch: process.arch};
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalValue(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function catalogFingerprint(tools, events) {
  const ordered = values => [...values].sort((first, second) => first.name.localeCompare(second.name, 'en'));
  return createHash('sha256').update(canonicalValue({tools: ordered(tools), events: ordered(events)})).digest('hex');
}
