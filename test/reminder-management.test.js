import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  OwnerOutbox,
  nextOutboundTime,
  validateOutboundArguments,
  resolveReminderLocalTime,
} from '../channels/outbound.js';
import { ChannelStore } from '../channels/store.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const cipher = { key: Buffer.alloc(32, 73) };
  let now = Date.parse('2026-11-05T00:00:00Z');
  const sent = [];
  const options = {
    channel: 'telegram',
    db,
    enabled: true,
    available: () => true,
    clock: () => now,
    seal: (value, aad) => ChannelStore.prototype.seal.call(cipher, value, aad),
    open: (value, aad) => ChannelStore.prototype.open.call(cipher, value, aad),
    send: async (value) => {
      value.authorize();
      sent.push(value);
    },
  };
  t.after(() => db.close());
  return {
    box: new OwnerOutbox(options),
    options,
    sent,
    time: (value) => {
      now = Date.parse(value);
    },
  };
}
const reminder = (extra = {}) => ({
  conversation: 'owner',
  text: 'synthetic reminder',
  send_at: '2026-11-05T01:00:00Z',
  timezone: 'Asia/Singapore',
  repeat: 'daily',
  until: '2026-12-01T00:00:00Z',
  idempotency_key: 'synthetic-reminder',
  ...extra,
});

test('weekday recurrence skips weekends at the local wall time across DST', () => {
  const friday = Date.parse('2026-10-30T13:00:00Z');
  assert.equal(
    new Date(nextOutboundTime(friday, 'America/New_York', 'weekdays')).toISOString(),
    '2026-11-02T14:00:00.000Z',
  );
});

test('local reminder forms use the chosen timezone and reject a DST gap', () => {
  assert.equal(
    resolveReminderLocalTime('2026-11-06T09:00', 'Asia/Singapore'),
    '2026-11-06T01:00:00.000Z',
  );
  assert.equal(
    resolveReminderLocalTime('2026-11-01T01:30', 'America/New_York'),
    '2026-11-01T05:30:00.000Z',
  );
  assert.throws(() => resolveReminderLocalTime('2026-03-08T02:30', 'America/New_York'));
  assert.throws(() => resolveReminderLocalTime('2026-02-30T09:00', 'Asia/Singapore'));
});

test('paused creation is atomic and reminder lists page through active and completed records', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 23; index++)
    f.box.call(
      'schedule_telegram_message',
      reminder({ idempotency_key: 'draft-' + index, paused: true }),
    );
  f.time('2026-11-05T01:01:00Z');
  await f.box.tick();
  assert.equal(f.sent.length, 0);
  const first = f.box.call('list_telegram_scheduled_messages', {}),
    second = f.box.call('list_telegram_scheduled_messages', { offset: first.next_offset });
  assert.equal(first.messages.length, 20);
  assert.equal(second.messages.length, 3);
  assert.equal(second.next_offset, null);
  assert.equal(first.messages[0].status, 'paused');
});

test('interval reminders validate bounds, keep fixed intent deduplication and skip stale occurrences', async (t) => {
  const { box, time, sent } = fixture(t);
  const args = reminder({ repeat: 'interval', interval_minutes: 15 });
  const saved = box.call('schedule_telegram_message', args);
  assert.equal(saved.interval_minutes, 15);
  assert.throws(() => box.call('schedule_telegram_message', reminder({ repeat: 'interval' })));
  assert.throws(() =>
    validateOutboundArguments(
      'telegram',
      'schedule_telegram_message',
      reminder({ repeat: 'interval', interval_minutes: 4 }),
    ),
  );
  assert.throws(() => box.call('schedule_telegram_message', reminder({ interval_minutes: 15 })));
  time('2026-11-05T01:00:00Z');
  await box.tick();
  assert.equal(sent.length, 1);
  time('2026-11-25T06:01:00Z');
  await box.tick();
  assert.equal(sent.length, 1);
  const current = box.call('get_telegram_outbound', { outbound_id: saved.outbound_id });
  assert.equal(current.send_at, '2026-11-25T06:00:00.000Z');
  await box.tick();
  assert.equal(sent.length, 2);
  assert.equal(box.call('schedule_telegram_message', args).outbound_id, saved.outbound_id);
});

test('pause and resume survive reopen with revision checks, skip missed work and retain delivery history', async (t) => {
  const f = fixture(t),
    saved = f.box.call('schedule_telegram_message', reminder());
  const args = { outbound_id: saved.outbound_id, expected_revision: 1 };
  const paused = f.box.call('pause_telegram_scheduled_message', args);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.revision, 2);
  assert.equal(f.box.call('pause_telegram_scheduled_message', args).revision, 2);
  await f.box.close();
  const box = new OwnerOutbox(f.options);
  f.time('2026-11-10T02:00:00Z');
  await box.tick();
  assert.equal(f.sent.length, 0);
  assert.throws(() => box.call('resume_telegram_scheduled_message', args));
  const resumed = box.call('resume_telegram_scheduled_message', {
    outbound_id: saved.outbound_id,
    expected_revision: 2,
  });
  assert.equal(resumed.send_at, '2026-11-11T01:00:00.000Z');
  f.time('2026-11-11T01:00:00Z');
  await box.tick();
  assert.equal(f.sent.length, 1);
  const history = box.call('get_telegram_reminder_history', { outbound_id: saved.outbound_id });
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0].status, 'sent');
  assert.equal(JSON.stringify(history).includes('synthetic reminder'), false);
});

test('paused one-time work must be edited before a missed run can resume', (t) => {
  const f = fixture(t),
    saved = f.box.call('schedule_telegram_message', reminder({ repeat: 'once', until: null }));
  f.box.call('pause_telegram_scheduled_message', {
    outbound_id: saved.outbound_id,
    expected_revision: 1,
  });
  f.time('2026-11-06T00:00:00Z');
  assert.throws(() =>
    f.box.call('resume_telegram_scheduled_message', {
      outbound_id: saved.outbound_id,
      expected_revision: 2,
    }),
  );
  const { idempotency_key, ...replacement } = reminder({
    repeat: 'once',
    until: null,
    send_at: '2026-11-07T00:00:00Z',
  });
  const edited = f.box.call('update_telegram_scheduled_message', {
    ...replacement,
    outbound_id: saved.outbound_id,
    expected_revision: 2,
  });
  assert.equal(edited.status, 'paused');
  assert.equal(edited.revision, 3);
  assert.equal(
    f.box.call('resume_telegram_scheduled_message', {
      outbound_id: saved.outbound_id,
      expected_revision: 3,
    }).status,
    'active',
  );
});

test('a stale resume cannot mistake an unrelated edit for its own completed operation', (t) => {
  const f = fixture(t),
    saved = f.box.call('schedule_telegram_message', reminder({ paused: true }));
  const { idempotency_key, ...replacement } = reminder();
  f.box.call('update_telegram_scheduled_message', {
    ...replacement,
    outbound_id: saved.outbound_id,
    expected_revision: 1,
  });
  assert.throws(() =>
    f.box.call('resume_telegram_scheduled_message', {
      outbound_id: saved.outbound_id,
      expected_revision: 1,
    }),
  );
  const args = { outbound_id: saved.outbound_id, expected_revision: 2 };
  assert.equal(f.box.call('resume_telegram_scheduled_message', args).revision, 3);
  assert.equal(f.box.call('resume_telegram_scheduled_message', args).revision, 3);
});
