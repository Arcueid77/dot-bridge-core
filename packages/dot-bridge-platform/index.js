import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows.py', import.meta.url));
const unavailable = code => Object.assign(new Error('Windows private object is unavailable or unsafe'), {
  code: ['acl', 'io', 'exists', 'missing', 'links', 'size', 'type', 'path', 'filesystem', 'identity', 'input', 'reparse'].includes(code) ? code : 'io',
});
let selectedPython;
function python() {
  if (selectedPython) return selectedPython;
  const explicit = process.env.DOT_BRIDGE_PYTHON;
  if (explicit) {
    if (!path.isAbsolute(explicit) || path.normalize(explicit) !== explicit || !fs.statSync(explicit).isFile()) throw unavailable();
    return selectedPython = explicit;
  }
  // Metadata-only discovery in standard existing uv installations; no download,
  // shell, PATH execution, environment dump, or package-cache initialization.
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const root = roaming && path.join(roaming, 'uv', 'python');
  if (root) {
    for (const name of fs.readdirSync(root).filter(name => /^cpython-\d/.test(name)).sort().reverse()) {
      const candidate = path.join(root, name, 'python.exe');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return selectedPython = candidate;
    }
  }
  throw new Error('Windows private-file support requires an existing Python 3 interpreter selected by DOT_BRIDGE_PYTHON');
}

function call(request) {
  if (process.platform !== 'win32') throw unavailable();
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  let raw;
  try {
    const child = spawnSync(python(), ['-B', '-I', '-S', helper, '--parent', String(process.pid)], {
      input: JSON.stringify(request), env, encoding: 'utf8', windowsHide: true,
      timeout: 15000, maxBuffer: 1100000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    raw = JSON.parse(child.stdout);
    if (child.error || child.status !== 0 || raw?.ok !== true || !raw.result || typeof raw.result !== 'object') {
      const error = unavailable(raw?.code);
      if (!child.error && child.status === 1 && raw?.ok === false && raw?.unchanged === true) error.unchanged = true;
      throw error;
    }
    return raw.result;
  } catch (error) { const safe = unavailable(error?.code); if (error?.unchanged === true) safe.unchanged = true; throw safe; }
}

function lease(result, digest) {
  if (!Array.isArray(result.handles) || !result.handles.length || result.handles.length > 1024 ||
      result.handles.some(item => !item || Object.keys(item).sort().join(',') !== 'handle,identity' ||
        !Number.isSafeInteger(item.handle) || item.handle <= 0 || !Array.isArray(item.identity) || item.identity.length !== 2 ||
        !/^[a-f0-9]{8}$/.test(item.identity[0]) || !/^[a-f0-9]{16}$/.test(item.identity[1])) ||
      new Set(result.handles.map(item => item.handle)).size !== result.handles.length ||
      (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))) throw unavailable();
  let closed = false;
  return { path: result.path, close() {
    if (closed) return;
    // Never retry an uncertain close: a numeric native handle may be reused.
    closed = true;
    try { call({ operation: 'close', handles: result.handles, ...(digest ? { digest } : {}) }); }
    catch (error) { if (error.unchanged === true) closed = false; throw error; }
  } };
}

export function windowsPrivateDirectory(directory, { create = false } = {}) {
  return lease(call({ operation: 'pin_directory', path: directory, create }));
}
export function windowsReadPrivateFile(file, { maxBytes = 4096, exactBytes } = {}) {
  const result = call({ operation: 'read', path: file, limit: maxBytes, ...(exactBytes === undefined ? {} : { exact: exactBytes }) });
  if (typeof result.data !== 'string') throw unavailable();
  const bytes = Buffer.from(result.data, 'base64');
  if (bytes.length > maxBytes || (exactBytes !== undefined && bytes.length !== exactBytes)) { bytes.fill(0); throw unavailable(); }
  return bytes;
}
export function windowsWritePrivateFile(file, data) {
  if (!Buffer.isBuffer(data) || data.length > 512000) throw unavailable();
  call({ operation: 'write_new', path: file, data: data.toString('base64') });
}
export function windowsPrivateDestination(file) {
  return call({ operation: 'destination', path: file }).path;
}
export function windowsPrivateMetadata(file, { directory = false, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  return call({ operation: 'inspect', path: file, directory, limit: maxBytes });
}
export function windowsPrivateDatabase(file, { create = false } = {}) {
  return lease(call({ operation: 'pin_database', path: file, create }));
}
export function windowsModeLock(directory, filename, record) {
  const parent = windowsPrivateDirectory(directory, { create: true });
  try {
    const bytes = Buffer.from(JSON.stringify(record));
    const result = call({ operation: 'lock', path: path.join(directory, filename), data: bytes.toString('base64') });
    return lease(result, result.digest).close;
  } finally { parent.close(); }
}

export const existingWindowsPython = python;
