import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BridgeError, OWNER, SERVICE_HEADER, loopback } from './common.js';
import { windowsReadPrivateFile } from '../packages/dot-bridge-platform/index.js';
export const digest = key => createHash('sha256').update(key).digest();
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
export function canonicalKey(key) { return typeof key === 'string' && keyPattern.test(key) && Buffer.from(key, 'base64url').toString('base64url') === key; }
export function readServiceKey(file, allowNewline = false) {
  if (process.platform === 'win32') {
    let bytes;
    try {
      bytes = windowsReadPrivateFile(file, { maxBytes: allowNewline ? 44 : 43 });
      const key = bytes.toString('utf8').replace(allowNewline ? /\n$/ : /$^/, '');
      if (!canonicalKey(key)) throw new Error();
      return key;
    } catch { throw new Error('Tunnel service credential file is unavailable or unsafe'); }
    finally { bytes?.fill(0); }
  }
  const opened = []; let bytes;
  try {
    if (process.platform !== 'linux' || typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || !fs.constants.O_NOFOLLOW) throw new Error();
    const parts = file.split('/').filter(Boolean), name = parts.pop();
    let directory = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); opened.push(directory);
    for (const part of parts) {
      directory = fs.openSync(`/proc/self/fd/${directory}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); opened.push(directory);
    }
    const parent = fs.fstatSync(directory);
    if (parent.uid !== process.getuid() || (parent.mode & 0o7777) !== 0o700) throw new Error();
    const fd = fs.openSync(`/proc/self/fd/${directory}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); opened.push(fd);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 ||
        (stat.size !== 43 && !(allowNewline && stat.size === 44))) throw new Error();
    // Bounded descriptor reads also reject files enlarged between fstat and read.
    bytes = Buffer.alloc(45);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const key = bytes.subarray(0, length).toString('utf8').replace(allowNewline ? /\n$/ : /$^/, '');
    if (!canonicalKey(key)) throw new Error();
    return key;
  } catch { throw new Error('Tunnel service credential file is unavailable or unsafe'); }
  finally { bytes?.fill(0); for (const fd of opened.reverse()) { try { fs.closeSync(fd); } catch { /* no credential-bearing error */ } } }
}
export function createAuthenticator(key) {
  if (!canonicalKey(key)) throw new Error('Invalid service credential');
  const expected = digest(key);
  return req => {
    const reject = () => { throw new BridgeError('Authentication required or rejected', { status: 401, code: -32012 }); };
    if (!loopback(req.socket?.remoteAddress)) reject();
    if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2) reject();
    let count = 0, rawKey;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] !== 'string' || typeof req.rawHeaders[i + 1] !== 'string') reject();
      const name = req.rawHeaders[i].toLowerCase();
      if (name === SERVICE_HEADER) { count++; rawKey = req.rawHeaders[i + 1]; }
    }
    const parsedCount = Object.keys(req.headers ?? {}).filter(name => name.toLowerCase() === SERVICE_HEADER).length;
    const key = req.headers?.[SERVICE_HEADER];
    if (count === 0 || parsedCount === 0) reject();
    if (count !== 1 || parsedCount !== 1) reject();
    if (!canonicalKey(key) || !canonicalKey(rawKey)) reject();
    const actual = digest(key);
    if (!timingSafeEqual(digest(rawKey), actual) || !timingSafeEqual(actual, expected)) reject();
    return { id: OWNER };
  };
}
