import fs from 'node:fs';
import path from 'node:path';
import { windowsPrivateDirectory, windowsReadPrivateFile, windowsPrivateDatabase } from './index.js';

// Linux descriptor-relative traversal: never follow a path component symlink.
// The final directory must belong to this process user and be exactly 0700.
export function openPrivateDirectory(directory, { create = false } = {}) {
  if (process.platform === 'win32') {
    try { return windowsPrivateDirectory(directory, { create }); }
    catch { throw new Error('Private directory is unavailable or unsafe'); }
  }
  let fd;
  try {
    if (process.platform !== 'linux' || !path.isAbsolute(directory) || path.normalize(directory) !== directory || !fs.constants.O_NOFOLLOW) throw new Error();
    fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    for (const part of directory.split('/').filter(Boolean)) {
      const target = `/proc/self/fd/${fd}/${part}`;
      if (create) { try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      const next = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = next;
    }
    const stat = fs.fstatSync(fd);
    if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw new Error();
    return { fd, path: `/proc/self/fd/${fd}`, close() { fs.closeSync(fd); } };
  } catch { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } throw new Error('Private directory is unavailable or unsafe'); }
}
export function assertPrivateFile(stat, { maxBytes = 4096, exactBytes } = {}) {
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 ||
      stat.size > maxBytes || (exactBytes !== undefined && stat.size !== exactBytes)) throw new Error('Private file is unavailable or unsafe');
}
export function readPrivateFile(file, options = {}) {
  if (process.platform === 'win32') {
    try { return windowsReadPrivateFile(file, options); }
    catch { throw new Error('Private file is unavailable or unsafe'); }
  }
  let parent, fd;
  try {
    if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Error();
    parent = openPrivateDirectory(path.dirname(file));
    fd = fs.openSync(`${parent.path}/${path.basename(file)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    assertPrivateFile(fs.fstatSync(fd), options);
    const maxBytes = options.maxBytes ?? 4096, buffer = Buffer.alloc(maxBytes + 1);
    let size = 0, read;
    while (size < buffer.length && (read = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += read;
    if (size > maxBytes || (options.exactBytes !== undefined && size !== options.exactBytes)) throw new Error();
    return buffer.subarray(0, size);
  } catch { throw new Error('Private file is unavailable or unsafe'); }
  finally { if (fd !== undefined) fs.closeSync(fd); parent?.close(); }
}

// SQLite opens WAL/SHM beside the database. Pin that directory for its lifetime
// and reject every existing database sidecar before SQLite can use it.
export function privateDatabasePath(file, { create = false } = {}) {
  if (process.platform === 'win32') {
    try { return windowsPrivateDatabase(file, { create }); }
    catch { throw new Error('Private database path is unavailable or unsafe'); }
  }
  let parent;
  try {
    if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Error();
    parent = openPrivateDirectory(path.dirname(file));
    const target = `${parent.path}/${path.basename(file)}`;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      let fd;
      try {
        fd = fs.openSync(target + suffix, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        assertPrivateFile(fs.fstatSync(fd), { maxBytes: Number.MAX_SAFE_INTEGER });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    if (create) {
      try { const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); fs.closeSync(fd); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return { path: target, close: () => parent.close() };
  } catch { parent?.close(); throw new Error('Private database path is unavailable or unsafe'); }
}
