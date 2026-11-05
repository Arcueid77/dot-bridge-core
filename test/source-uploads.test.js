import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChannelStore } from '../channels/store.js';
import { SourceUploads, UPLOAD_CHUNK_BYTES, validateUploadArguments } from '../channels/uploads.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:'),
    cipher = { key: Buffer.alloc(32, 74) };
  let allowed = true,
    now = 1000;
  t.after(() => db.close());
  const options = {
    channel: 'telegram',
    db,
    seal: (v, a) => ChannelStore.prototype.seal.call(cipher, v, a),
    open: (v, a) => ChannelStore.prototype.open.call(cipher, v, a),
    clock: () => now,
    authorize: (id) => {
      if (!allowed || id !== 'source') throw Error('revoked');
      return { id, expires: 100000 };
    },
  };
  return {
    uploads: new SourceUploads(options),
    options,
    db,
    revoke: () => {
      allowed = false;
    },
    time: (value) => {
      now = value;
    },
  };
}
const begin = (bytes) => ({
  message_id: 'source',
  type: 'file',
  name: 'report.txt',
  mime_type: 'text/plain',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  idempotency_key: 'generated-report',
});

test('generated file chunks remain encrypted, survive reopening and are replied once through the existing queue', (t) => {
  const f = fixture(t),
    data = Buffer.from('synthetic generated report\n'.repeat(13000));
  const args = begin(data),
    saved = f.uploads.call('begin_telegram_attachment_upload', args);
  assert.equal(f.uploads.call('begin_telegram_attachment_upload', args).upload_id, saved.upload_id);
  for (let offset = 0; offset < data.length; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = {
      upload_id: saved.upload_id,
      offset,
      data: data.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString('base64'),
    };
    const result = f.uploads.call('append_telegram_attachment_upload', chunk);
    assert.equal(
      f.uploads.call('append_telegram_attachment_upload', chunk).received_bytes,
      result.received_bytes,
    );
  }
  assert.equal(
    f.db.prepare('SELECT payload FROM dotbridge_uploads').get().payload.includes('report.txt'),
    false,
  );
  const reopened = new SourceUploads(f.options);
  assert.equal(
    reopened.call('finish_telegram_attachment_upload', { upload_id: saved.upload_id }).complete,
    true,
  );
  let sends = 0;
  const handlers = {
    queue: (id, media) => {
      assert.equal(id, 'source');
      assert.deepEqual(Buffer.from(media.data, 'base64'), data);
      sends++;
      return { message_id: id, status: 'pending' };
    },
    getReplyStatus: (id) => ({ message_id: id, status: 'uncertain' }),
  };
  const reply = { message_id: 'source', upload_id: saved.upload_id, idempotency_key: 'one-final' };
  assert.equal(
    reopened.call('reply_telegram_uploaded_attachment', reply, handlers).status,
    'pending',
  );
  assert.equal(
    reopened.call('reply_telegram_uploaded_attachment', reply, handlers).status,
    'uncertain',
  );
  assert.equal(sends, 1);
  assert.throws(() =>
    reopened.call(
      'reply_telegram_uploaded_attachment',
      { ...reply, idempotency_key: 'different' },
      handlers,
    ),
  );
});

test('offset, size, checksums, source ownership and authorization are checked before completing or sending', (t) => {
  const f = fixture(t),
    bytes = Buffer.from('small generated result'),
    saved = f.uploads.call('begin_telegram_attachment_upload', begin(bytes));
  assert.throws(() =>
    f.uploads.call('append_telegram_attachment_upload', {
      upload_id: saved.upload_id,
      offset: 1,
      data: bytes.toString('base64'),
    }),
  );
  assert.throws(() =>
    f.uploads.call('finish_telegram_attachment_upload', { upload_id: saved.upload_id }),
  );
  f.uploads.call('append_telegram_attachment_upload', {
    upload_id: saved.upload_id,
    offset: 0,
    data: Buffer.alloc(bytes.length, 1).toString('base64'),
  });
  assert.throws(() =>
    f.uploads.call('finish_telegram_attachment_upload', { upload_id: saved.upload_id }),
  );
  assert.throws(() =>
    f.uploads.call('reply_telegram_uploaded_attachment', {
      message_id: 'other',
      upload_id: saved.upload_id,
      idempotency_key: 'one',
    }),
  );
  f.revoke();
  assert.throws(() =>
    f.uploads.call('finish_telegram_attachment_upload', { upload_id: saved.upload_id }),
  );
  for (const patch of [
    { url: 'https://example.com' },
    { path: 'C:/report.txt' },
    { recipient: 'other' },
  ])
    assert.throws(() =>
      validateUploadArguments('telegram', 'begin_telegram_attachment_upload', {
        ...begin(bytes),
        ...patch,
      }),
    );
});

test('expired partial uploads are logically removed without altering queued reply state', (t) => {
  const f = fixture(t),
    bytes = Buffer.from('abandoned'),
    saved = f.uploads.call('begin_telegram_attachment_upload', begin(bytes));
  f.uploads.call('append_telegram_attachment_upload', {
    upload_id: saved.upload_id,
    offset: 0,
    data: bytes.toString('base64'),
  });
  f.time(100001);
  f.uploads.purge();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dotbridge_upload_chunks').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dotbridge_uploads').get().n, 0);
});
