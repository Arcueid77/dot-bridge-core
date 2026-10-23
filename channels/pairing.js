import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertPrivateFile, openPrivateDirectory } from '../packages/dot-bridge-platform/private-files.js';
import { windowsPrivateDestination, windowsWritePrivateFile } from '../packages/dot-bridge-platform/index.js';

const refused = () => new Error('Pairing destination is unavailable, unsafe or already exists.');
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);

// The nonce proves access to the operator's current enrollment session. Provider
// factories must still filter app/bot identity, one-to-one chat, self/bot and
// forwarded events before calling accept; live consumers never use this path.
export function createPairingChallenge({ ttlMs = 300_000, clock = Date.now, entropy = randomBytes } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000 || typeof clock !== 'function' || typeof entropy !== 'function') {
    throw new Error('Pairing challenge configuration is invalid.');
  }
  const issuedAt = clock();
  if (!Number.isSafeInteger(issuedAt)) throw new Error('Pairing challenge clock is invalid.');
  const nonce = entropy(16);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 16) throw new Error('Pairing challenge entropy is invalid.');
  const phrase = `dotbridge-pair:${nonce.toString('hex')}`;
  nonce.fill(0);
  const expected = Buffer.from(phrase);
  const expiresAt = issuedAt + ttlMs;
  let match;
  let cancelled = false;
  return Object.freeze({
    phrase,
    expiresAt,
    accept({ text, ownerId, conversationId, timestamp } = {}) {
      const now = clock();
      if (cancelled || match || !Number.isSafeInteger(now) || now < issuedAt || now >= expiresAt ||
          !identity(ownerId) || !identity(conversationId) || typeof text !== 'string' || Buffer.byteLength(text) !== expected.length ||
          (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < issuedAt - 30_000 || timestamp > now + 5000))) return false;
      if (!timingSafeEqual(Buffer.from(text), expected)) return false;
      match = Object.freeze({ ownerId, conversationId });
      return true;
    },
    result() { return match ? { ...match } : undefined; },
    cancel() { cancelled = true; expected.fill(0); },
  });
}

export function createOwnerPairing({ credentials, confirmStopped, createEnrollmentProvider, signal,
  ttlMs = 300_000, clock = Date.now, entropy = randomBytes, ...providerOptions }) {
  if (confirmStopped !== true || typeof createEnrollmentProvider !== 'function') throw new Error('Pairing requires confirmation that the existing consumer is stopped.');
  const challenge = createPairingChallenge({ ttlMs, clock, entropy });
  let work;
  return Object.freeze({
    phrase: challenge.phrase,
    expiresAt: challenge.expiresAt,
    waitForOwner() {
      return work ??= (async () => {
        if (signal?.aborted) throw new Error('Pairing was cancelled.');
        const controller = new AbortController();
        let resolve;
        let reject;
        const accepted = new Promise((yes, no) => { resolve = yes; reject = no; });
        // An early start failure must not leave the timer's rejection unhandled.
        accepted.catch(() => {});
        const abort = () => { controller.abort(); reject(new Error('Pairing was cancelled.')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(() => { controller.abort(); reject(new Error('Pairing expired. Run pairing again for a new phrase.')); }, Math.max(1, challenge.expiresAt - clock()));
        let provider;
        try {
          if (controller.signal.aborted) throw new Error('Pairing was cancelled.');
          provider = createEnrollmentProvider({ ...providerOptions, credentials, confirmStopped: true, signal: controller.signal,
            onPairingMessage: async message => { if (challenge.accept(message)) resolve(challenge.result()); },
          });
          await provider.start();
          return await accepted;
        } catch (error) {
          if (signal?.aborted) throw new Error('Pairing was cancelled.');
          if (clock() >= challenge.expiresAt) throw new Error('Pairing expired. Run pairing again for a new phrase.');
          throw new Error('Pairing could not complete. Check the application credentials and connection.');
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          challenge.cancel();
          controller.abort();
          try { await provider?.stop(); }
          catch { throw new Error('Pairing consumer could not stop cleanly. Check it is stopped before trying again.'); }
        }
      })();
    },
  });
}

export function assertPairingDestination(file) {
  let parent;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) throw refused();
    if (process.platform === 'win32') { windowsPrivateDestination(file); return; }
    parent = openPrivateDirectory(path.dirname(file));
    try { fs.lstatSync(`${parent.path}/${path.basename(file)}`); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw refused();
  } catch { throw refused(); }
  finally { parent?.close(); }
}

// Every writer requires an explicit confirmation at the CLI boundary. Atomic
// no-replace install keeps existing credentials intact, even if another process
// creates the destination after preflight. Data never crosses a public temp dir.
export function writePairedCredentials(file, value) {
  let bytes;
  let parent;
  let fd;
  let temporary;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !identity(value.ownerId) || !identity(value.conversationId)) throw refused();
    bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > 16_384) throw refused();
    assertPairingDestination(file);
    if (process.platform === 'win32') { windowsWritePrivateFile(file, bytes); return; }
    parent = openPrivateDirectory(path.dirname(file));
    temporary = `${parent.path}/.pairing-${randomUUID()}.tmp`;
    const target = `${parent.path}/${path.basename(file)}`;
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    assertPrivateFile(fs.fstatSync(fd), { maxBytes: 16_384 });
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    assertPrivateFile(fs.fstatSync(fd), { maxBytes: 16_384 });
    // link() is no-replace. The private temp link is removed immediately so the
    // installed file has exactly one link and passes the runtime's normal check.
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary); temporary = undefined;
    fs.fsyncSync(parent.fd);
  } catch { throw refused(); }
  finally {
    bytes?.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* never remove an existing target */ } }
    parent?.close();
  }
}
