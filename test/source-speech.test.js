import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceSpeech} from '../channels/speech.js';

function fixture() {
  let plan, state = 'none', calls = 0, allowed = true;
  const records = [];
  const speech = new SourceSpeech({channel: 'qq',
    authorize: () => {if (!allowed) throw Error('revoked');},
    existing: () => plan,
    status: id => ({message_id: id, status: state}),
    begin() {}, recordResult: (_id, text) => records.push(text),
    queue: (_id, value) => {plan = {digest: value.speechRequestDigest};state = 'pending';},
    synthesizer: {status: () => ({configured: true, runtime_ready: true, busy: false, last_failure: null}),
      generate: async () => {calls++;return {data: Buffer.from('synthetic audio'), name: 'voice.wav', mimeType: 'audio/wav'};}}});
  return {speech, records, calls: () => calls, state: value => {state = value;}, revoke: () => {allowed = false;}};
}

test('speech queues one stored plan and retries inspect it without regenerating audio', async () => {
  const f = fixture(), args = {message_id: 'source', text: 'Generated answer', idempotency_key: 'one-answer'};
  const results = await Promise.all([f.speech.reply(args), f.speech.reply(args)]);
  assert.ok(results.every(value => value.status === 'pending'));
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.records, ['Generated answer']);
  f.state('uncertain');
  assert.equal((await f.speech.reply(args)).status, 'uncertain');
  assert.equal(f.calls(), 1);
  await assert.rejects(f.speech.reply({...args, text: 'Different answer'}));
  f.revoke();
  await assert.rejects(f.speech.reply(args));
});

test('an earlier uncertain native reply prevents a new speech conversion or delivery', async () => {
  const f = fixture();
  f.state('uncertain');
  const result = await f.speech.reply({message_id: 'source', text: 'Generated answer', idempotency_key: 'one-answer'});
  assert.equal(result.status, 'uncertain');
  assert.equal(f.calls(), 0);
  assert.equal(f.records.length, 0);
});
