// Synthetic test trees only. Windows chmod does not restrict a DACL, so these
// fixtures create real private ACLs and use real ACL grants for negative tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsPrivateDirectory, windowsPrivateMetadata, existingWindowsPython } from './index.js';

const roots = new Set();
function fixtureRoot(file) {
  const absolute = path.resolve(file);
  const root = [...roots].find(root => absolute === root || absolute.startsWith(root + path.sep));
  if (!root) throw new Error('ACL test mutation outside registered synthetic Temp tree');
  return { root, path: absolute };
}
export function privateMkdtempSync(prefix) {
  if (process.platform !== 'win32') return fs.mkdtempSync(prefix);
  if (path.resolve(path.dirname(prefix)) !== path.resolve(os.tmpdir())) throw new Error('Synthetic fixtures require Temp');
  const directory = path.join(os.tmpdir(), `${path.basename(prefix)}bridge-synthetic-${randomUUID()}`);
  windowsPrivateDirectory(directory, { create: true }).close(); roots.add(directory); return directory;
}
export function fixtureChmodSync(file, mode) {
  if (process.platform !== 'win32') return fs.chmodSync(file, mode);
  const scope = fixtureRoot(file);
  const result = spawnSync(existingWindowsPython(), ['-B', '-I', '-S', fileURLToPath(new URL('./test-fixture-acl.py', import.meta.url))], {
    input: JSON.stringify({ ...scope, mode }), encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'].filter(key => process.env[key] !== undefined).map(key => [key,process.env[key]])),
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8192,
  });
  if (result.status !== 0 || JSON.parse(result.stdout)?.ok !== true) throw new Error('Synthetic ACL fixture setup failed');
}
export function privateMkdirSync(directory, options = {}) {
  if (process.platform !== 'win32') return fs.mkdirSync(directory, options);
  fixtureRoot(directory);
  windowsPrivateDirectory(path.resolve(directory), { create: true }).close();
  if (options.mode !== undefined && options.mode !== 0o700) fixtureChmodSync(directory, options.mode);
}
export function fixtureSymlinkSync(target, link, type) {
  if (process.platform !== 'win32') return fs.symlinkSync(target, link, type);
  fixtureRoot(link); fixtureRoot(target);
  // Junctions are actual reparse points without requiring symlink privilege.
  // They cover final-component and ancestor reparse refusal on this machine.
  return fs.symlinkSync(path.resolve(target), link, 'junction');
}
export function assertPrivateFixture(assert, file, mode) {
  if (process.platform !== 'win32') return assert.equal(fs.statSync(file).mode & 0o7777, mode);
  const metadata = windowsPrivateMetadata(file, { directory: mode === 0o700 });
  assert.equal(metadata.private, true); assert.equal(metadata.owner_matches, true);
  if (mode === 0o700) assert.equal(metadata.protected_dacl, true);
}

const cleanups = new WeakMap();
export function cleanupPrivateFixture(t, directory) {
  let entry = cleanups.get(t);
  if (!entry) {
    entry = { directories: [], disposers: [] }; cleanups.set(t, entry);
    t.after(async () => {
      let failure;
      for (const close of entry.disposers.reverse()) { try { await close(); } catch (error) { failure ??= error; } }
      for (const dir of entry.directories.reverse()) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { failure ??= error; } }
      if (failure) throw failure;
    });
  }
  entry.directories.push(directory);
}
export function beforeFixtureCleanup(t, close) {
  const entry = cleanups.get(t);
  if (!entry) throw new Error('Register fixture cleanup before its resource finalizers');
  entry.disposers.push(close);
}
