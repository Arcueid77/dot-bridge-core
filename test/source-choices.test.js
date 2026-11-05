import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ChannelStore } from '../channels/store.js';
import { SourceChoices, validateChoiceArguments, choiceDefinitions } from '../channels/choices.js';
import { OwnerOutbox } from '../channels/outbound.js';
import { createHash } from 'node:crypto';

function fixture(t, firstReminder) {
  const db = new DatabaseSync(':memory:'),
    cipher = { key: Buffer.alloc(32, 75) };
  t.after(() => db.close());
  let allowed = true;
  const options = {
    db,
    seal: (v, a) => ChannelStore.prototype.seal.call(cipher, v, a),
    open: (v, a) => ChannelStore.prototype.open.call(cipher, v, a),
    clock: () => 1000,
    authorize: (id) => {
      if (id !== 'source' || !allowed) throw Error('revoked');
    },
  };
  const choices = new SourceChoices(options),
    source = {
      id: 'source',
      senderId: 'owner',
      conversationId: 'chat',
      threadId: 'topic',
      expires: 100000,
    };
  const args = {
    message_id: 'source',
    text: 'Choose a report format',
    choices: [
      { id: 'pdf', label: 'PDF' },
      { id: 'txt', label: 'Text' },
    ],
    idempotency_key: 'one-choice',
  };
  if (firstReminder) args.choices[0].reminder = firstReminder;
  const plan = choices.create(source, args);
  choices.bindPrompt(source.id, 'bot-card-message');
  const input = {
    token: plan.choices[0].token,
    senderId: 'owner',
    conversationId: 'chat',
    threadId: 'topic',
    message: {
      id: 'bot-card-message',
      senderId: 'owner',
      conversationId: 'chat',
      threadId: 'topic',
      replyContext: { messageId: 12 },
      attachments: [],
    },
  };
  return {
    db,
    choices,
    options,
    args,
    source,
    plan,
    input,
    revoke: () => {
      allowed = false;
    },
  };
}

test('native choices bind actor, conversation and topic and accept one winner across duplicate callbacks', async (t) => {
  const f = fixture(t);
  assert.equal(
    f.choices.select({ ...f.input, message: { ...f.input.message, id: 'forwarded-card' } })
      .accepted,
    false,
  );
  for (const patch of [
    { senderId: 'someone' },
    { conversationId: 'other' },
    { threadId: 'other' },
    { token: 'db_' + 'a'.repeat(24) },
  ])
    assert.equal(f.choices.select({ ...f.input, ...patch }).accepted, false);
  assert.equal(f.choices.select(f.input).accepted, true);
  assert.equal(f.choices.select(f.input).accepted, true);
  assert.equal(f.choices.select({ ...f.input, token: f.plan.choices[1].token }).accepted, false);
  assert.equal(f.choices.result('source').selection.id, 'pdf');
  assert.equal(
    f.db.prepare('SELECT payload FROM dotbridge_choices').get().payload.includes('owner'),
    false,
  );
  const seen = [];
  await f.choices.dispatch(async (message) => {
    seen.push(message);
  });
  await f.choices.dispatch(async (message) => {
    seen.push(message);
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, '[选择 pdf] PDF');
  assert.equal(seen[0].replyContext.choiceSourceId, 'source');
});

test('a durably accepted selection resumes after restart and retains idempotent source identity', async (t) => {
  const f = fixture(t);
  f.choices.select(f.input);
  let inserted = false;
  await assert.rejects(
    f.choices.dispatch(async (message) => {
      assert.equal(message.id, 'bot-card-message');
      inserted = true;
      throw Error('crash after inbox persistence');
    }),
  );
  const reopened = new SourceChoices(f.options),
    sources = new Set(inserted ? ['bot-card-message'] : []);
  await reopened.dispatch(async (message) => {
    sources.add(message.id);
  });
  assert.equal(sources.size, 1);
  assert.equal(f.db.prepare('SELECT dispatched FROM dotbridge_choices').get().dispatched, 1);
});

test('choice payloads cannot smuggle recipients, URLs, duplicate IDs or different sender metadata', (t) => {
  const f = fixture(t);
  for (const patch of [
    { recipient: 'other' },
    { url: 'https://example.com' },
    {
      choices: [
        { id: 'same', label: 'one' },
        { id: 'same', label: 'two' },
      ],
    },
  ])
    assert.throws(() =>
      validateChoiceArguments('telegram', 'reply_telegram_choices', { ...f.args, ...patch }),
    );
  assert.equal(
    f.choices.select({ ...f.input, message: { ...f.input.message, senderId: 'other' } }).accepted,
    false,
  );
  f.revoke();
  assert.equal(f.choices.select(f.input).accepted, false);
  assert.equal(choiceDefinitions('qq').length, 1);
});

test('a reminder button resumes its bound draft once even after a crash following the control commit', async (t) => {
  const id = 'out_' + createHash('sha256').update('telegram:draft').digest('hex');
  const f = fixture(t, { outbound_id: id, expected_revision: 1, action: 'resume' });
  const box = new OwnerOutbox({
    ...f.options,
    channel: 'telegram',
    enabled: true,
    available: () => true,
    send: async () => {
      throw Error('must remain future');
    },
  });
  box.call('schedule_telegram_message', {
    conversation: 'owner',
    text: 'future',
    send_at: '1970-01-01T00:10:00Z',
    timezone: 'UTC',
    repeat: 'once',
    until: null,
    idempotency_key: 'draft',
    paused: true,
  });
  f.choices.select(f.input);
  await assert.rejects(
    f.choices.dispatch(
      async () => {},
      (action) => {
        box.call('resume_telegram_scheduled_message', {
          outbound_id: action.outbound_id,
          expected_revision: action.expected_revision,
        });
        throw Error('crash after commit');
      },
    ),
  );
  const received = [];
  await new SourceChoices(f.options).dispatch(
    async (message) => {
      received.push(message);
    },
    (action) =>
      box.call('resume_telegram_scheduled_message', {
        outbound_id: action.outbound_id,
        expected_revision: action.expected_revision,
      }),
  );
  assert.equal(box.call('get_telegram_outbound', { outbound_id: id }).revision, 2);
  assert.equal(received.length, 1);
  assert.ok(received[0].text.includes(id));
});
