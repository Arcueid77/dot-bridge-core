import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPairingChallenge, createOwnerPairing, assertPairingDestination, writePairedCredentials } from '../channels/pairing.js';
import { readPrivateFile } from '../packages/dot-bridge-platform/private-files.js';
import { privateMkdtempSync, cleanupPrivateFixture, assertPrivateFixture, fixtureChmodSync, fixtureSymlinkSync } from '../packages/dot-bridge-platform/test-fixtures.js';

test('pairing requires the complete new nonce, private identity and bounded fresh timestamp', () => {
  const now = 1_700_000_000_000;
  const challenge = createPairingChallenge({ clock: () => now, entropy: size => Buffer.alloc(size, 7) });
  assert.match(challenge.phrase, /^dotbridge-pair:[a-f0-9]{32}$/u);
  const event = { text: challenge.phrase, ownerId: 'fixture-owner', conversationId: 'fixture-chat', timestamp: now };
  for (const patch of [{ text: 'hello' }, { text: ' ' + challenge.phrase }, { text: challenge.phrase + '\n' },
    { ownerId: '' }, { ownerId: 'x'.repeat(257) }, { ownerId: '\uD800' }, { conversationId: 'bad\nidentity' },
    { timestamp: now - 30_001 }, { timestamp: now + 5001 }]) {
    assert.equal(challenge.accept({ ...event, ...patch }), false);
  }
  assert.equal(challenge.result(), undefined);
  assert.equal(challenge.accept(event), true);
  assert.deepEqual(challenge.result(), { ownerId: 'fixture-owner', conversationId: 'fixture-chat' });
  assert.equal(challenge.accept({ ...event, ownerId: 'another' }), false);
  const result = challenge.result(); result.ownerId = 'changed';
  assert.equal(challenge.result().ownerId, 'fixture-owner');
});

test('expired, cancelled and invalid-clock pairing cannot adopt the next sender', () => {
  let now = 100_000;
  const challenge = createPairingChallenge({ clock: () => now, ttlMs: 1000 });
  const event = { text: challenge.phrase, ownerId: 'owner', conversationId: 'chat' };
  now = 99_999; assert.equal(challenge.accept(event), false);
  now = 101_000; assert.equal(challenge.accept(event), false);
  now = 100_001; challenge.cancel(); assert.equal(challenge.accept(event), false);
  assert.throws(() => createPairingChallenge({ ttlMs: 600_000 }));
  assert.throws(() => createPairingChallenge({ entropy: () => Buffer.alloc(15) }));
});

test('pairing runner waits for the exact phrase and stops its dedicated consumer after success or cancellation', async () => {
  let handler;
  let stopped = 0;
  const createEnrollmentProvider = options => ({
    start: async () => { handler = options.onPairingMessage; },
    stop: async () => { stopped++; },
  });
  assert.throws(() => createOwnerPairing({ createEnrollmentProvider }));
  const pairing = createOwnerPairing({ createEnrollmentProvider, confirmStopped: true });
  let resolved = false;
  const waiting = pairing.waitForOwner().then(value => { resolved = true; return value; });
  await handler({ text: 'first sender', ownerId: 'wrong', conversationId: 'wrong' });
  assert.equal(resolved, false);
  await handler({ text: pairing.phrase, ownerId: 'fixture-owner', conversationId: 'fixture-chat' });
  assert.deepEqual(await waiting, { ownerId: 'fixture-owner', conversationId: 'fixture-chat' });
  assert.equal(stopped, 1);
  const controller = new AbortController();
  const cancelled = createOwnerPairing({ createEnrollmentProvider, confirmStopped: true, signal: controller.signal });
  const rejection = assert.rejects(cancelled.waitForOwner(), /cancelled/u);
  controller.abort(); await rejection;
  assert.equal(stopped, 2);
  const failedStop = createOwnerPairing({ confirmStopped: true, createEnrollmentProvider: options => ({
    start: async () => options.onPairingMessage({ text: failedStop.phrase, ownerId: 'owner', conversationId: 'chat' }),
    stop: async () => { throw new Error('fixture-secret'); },
  }) });
  await assert.rejects(failedStop.waitForOwner(), error => /stop cleanly/u.test(error.message) && !error.message.includes('fixture-secret'));
});

const supported = { skip: !['linux', 'win32'].includes(process.platform) };
function fixture(t) {
  const dir = privateMkdtempSync(path.join(os.tmpdir(), 'dot-pairing-'));
  cleanupPrivateFixture(t, dir);
  return { dir, file: path.join(dir, 'credentials.json') };
}
const credentials = { appKey: 'fixture-private-secret', ownerId: 'fixture-owner', conversationId: 'fixture-chat' };

test('credentials are atomically installed privately and never replace an existing file', supported, t => {
  const { file } = fixture(t);
  assertPairingDestination(file);
  writePairedCredentials(file, credentials);
  assertPrivateFixture(assert, file, 0o600);
  assert.deepEqual(JSON.parse(readPrivateFile(file).toString()), credentials);
  assert.equal(fs.statSync(file).nlink, 1);
  assert.throws(() => assertPairingDestination(file));
  assert.throws(() => writePairedCredentials(file, { ...credentials, appKey: 'replacement' }));
  assert.equal(JSON.parse(readPrivateFile(file).toString()).appKey, credentials.appKey);
});

test('unsafe parent ACL, existing hardlinks and reparse targets fail without disclosing credentials', supported, t => {
  const { dir, file } = fixture(t);
  const other = path.join(dir, 'other.json');
  writePairedCredentials(other, credentials);
  fs.linkSync(other, file);
  assert.throws(() => writePairedCredentials(file, credentials), error => !error.message.includes(credentials.appKey));
  fs.unlinkSync(file);
  const link = path.join(dir, 'linked');
  fixtureSymlinkSync(dir, link);
  assert.throws(() => writePairedCredentials(path.join(link, 'credentials.json'), credentials));
  fs.unlinkSync(link);
  fixtureChmodSync(dir, 0o755);
  assert.throws(() => writePairedCredentials(file, credentials));
  fixtureChmodSync(dir, 0o700);
});

test('writer refuses missing binding and oversized private JSON before creating a file', supported, t => {
  const { file } = fixture(t);
  assert.throws(() => writePairedCredentials(file, { appKey: 'fixture' }));
  assert.throws(() => writePairedCredentials(file, { ...credentials, appKey: 'x'.repeat(17000) }));
  assert.equal(fs.existsSync(file), false);
});
