import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechSynthesizer} from '../audio/synthesis.js';
import {pcm16Wave, pcmWaveform} from '../audio/wav.js';

const env = {DOT_BRIDGE_SPEECH_SYNTHESIS: 'local-espeak', DOT_BRIDGE_SPEECH_VOICE: 'zh', DOT_BRIDGE_AUDIO_GUARD: '/fixture/guard.so'};

test('local speech is disabled by default and rejects unsupported runtime configuration', async () => {
  let calls = 0;
  const disabled = createSpeechSynthesizer({env: {}, validate() {calls++;}});
  assert.equal(disabled.status().runtime_ready, false);
  await assert.rejects(disabled.generate('fixture'));
  assert.equal(calls, 0);
  assert.throws(() => createSpeechSynthesizer({env: {...env, DOT_BRIDGE_SPEECH_VOICE: '../../other'}}));
});

test('speech text travels only through stdin and bounded PCM becomes a complete WAV', async () => {
  const calls = [];
  let released = 0;
  const synthesizer = createSpeechSynthesizer({env, platform: 'linux', validate() {},
    lock: () => ({fd: 17, close() {released++;}}),
    execute: async (name, args, input, options) => {
      calls.push({name, args, input: input.toString(), options});
      return name === 'espeak-ng' ? Buffer.from('fixture waveform') : Buffer.alloc(32000, 0);
    }});
  const result = await synthesizer.generate('你好，fixture。');
  assert.equal(calls[0].name, 'espeak-ng');
  assert.equal(calls[0].args.includes('你好，fixture。'), false);
  assert.equal(calls[0].input, '你好，fixture。\n');
  assert.equal(calls[1].args.includes('-protocol_whitelist'), true);
  assert.equal(calls[0].options.fd, 17);
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.data.subarray(0, 4).toString(), 'RIFF');
  assert.equal(result.data.readUInt32LE(40), 32000);
  assert.equal(result.data.length, 32044);
  assert.equal(released, 1);
  assert.equal(synthesizer.status().last_failure, null);
});

test('duration and revocation failures release the worker and preserve fixed diagnostic stages', async () => {
  let released = 0;
  const synthesizer = createSpeechSynthesizer({env, platform: 'linux', validate() {},
    lock: () => ({fd: 1, close() {released++;}}),
    execute: async name => name === 'espeak-ng' ? Buffer.alloc(10) : Buffer.alloc(16000 * 2 * 120 + 2)});
  await assert.rejects(synthesizer.generate('fixture'));
  assert.equal(synthesizer.status().last_failure, 'normalize');
  assert.equal(synthesizer.status().busy, false);
  assert.equal(released, 1);
  let checks = 0;
  await assert.rejects(synthesizer.generate('fixture', {authorize() {if (++checks > 1) throw Object.assign(Error('revoked'), {code: -32012});}}), error => error.code === -32012);
  assert.equal(released, 2);
});

test('PCM waveform reflects actual amplitude and shares the existing mono WAV representation', () => {
  const pcm = Buffer.alloc(64000);
  for (let index = 32000; index < pcm.length; index += 2) pcm.writeInt16LE(16000, index);
  const waveform = pcmWaveform(pcm);
  assert.equal(waveform.length, 20);
  assert.equal(waveform[0], 0);
  assert.ok(waveform.at(-1) > 100);
  assert.equal(pcm16Wave(pcm).readUInt32LE(24), 16000);
  assert.throws(() => pcm16Wave(Buffer.alloc(1)));
});
