import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {BridgeError} from '../router/common.js';
import {MAX_MEDIA_BYTES} from '../channels/media.js';
import {assertTrustedRuntimeFile, openAudioWorkLock} from './transcription.js';
import {protectedMediaProcess} from './media-process.js';
import {pcm16Wave, pcmWaveform} from './wav.js';

const PCM_BYTES_PER_SECOND = 16000 * 2;
export const MAX_SPEECH_SECONDS = 120;
export const MAX_M4A_SPEECH_SECONDS = 60;
// AAC needs space for encoder delay and padding in the final M4A duration.
const AAC_PADDING_BYTES = 2 * 1024 * 2;
const formats = {wav: {mimeType: 'audio/wav', name: 'voice.wav'},
  opus: {mimeType: 'audio/ogg', name: 'voice.ogg'}, mp3: {mimeType: 'audio/mpeg', name: 'voice.mp3'},
  amr: {mimeType: 'audio/amr', name: 'voice.amr'}, m4a: {mimeType: 'audio/mp4', name: 'voice.m4a'}};

function validateRuntime(env) {
  for (const name of ['espeak-ng', 'ffmpeg', 'prlimit', 'flock']) {
    const file = fs.realpathSync('/usr/bin/' + name);
    if (!file.startsWith('/usr/bin/')) throw new Error('Unexpected speech runtime.');
    assertTrustedRuntimeFile(file);
  }
  assertTrustedRuntimeFile(env.DOT_BRIDGE_AUDIO_GUARD);
}

export function speechConfiguration(env = process.env) {
  const mode = env.DOT_BRIDGE_SPEECH_SYNTHESIS ?? 'disabled';
  if (!['disabled', 'local-espeak'].includes(mode)) throw new BridgeError('Invalid speech synthesis configuration.');
  const voice = env.DOT_BRIDGE_SPEECH_VOICE ?? 'zh';
  if (!/^[A-Za-z][A-Za-z0-9_+-]{0,31}$/u.test(voice)) throw new BridgeError('Invalid local speech voice.');
  return {mode, voice};
}

export function createSpeechSynthesizer({env = process.env, platform = process.platform,
  validate = validateRuntime, execute = protectedMediaProcess, lock = openAudioWorkLock} = {}) {
  const {mode, voice} = speechConfiguration(env);
  let active = false, lastFailure = null;
  const ready = () => {
    if (mode !== 'local-espeak' || platform !== 'linux') return false;
    try { validate(env); return true; } catch { return false; }
  };
  return {
    status() { return {configured: mode === 'local-espeak', runtime_ready: ready(), busy: active, last_failure: lastFailure}; },
    async generate(text, {format = 'wav', authorize = () => {}, signal} = {}) {
      authorize();
      if (!ready()) throw new BridgeError('Protected local speech synthesis is unavailable.', {status: 409, code: -32016});
      if (active) throw new BridgeError('The local speech worker is busy.', {status: 429, code: -32013});
      if (typeof text !== 'string' || !text.trim() || text.length > 2000 || !text.isWellFormed() ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) || !Object.hasOwn(formats, format)) {
        throw new BridgeError('Speech text or output format is unsupported.');
      }
      let input, spoken, pcm, wave, encoded, lease, stage = 'synthesis';
      active = true;
      try {
        lease = lock(env);
        const options = {fd: lease.fd, signal, guardFile: env.DOT_BRIDGE_AUDIO_GUARD, timeout: 10000, limit: MAX_MEDIA_BYTES};
        input = Buffer.from(text + '\n');
        spoken = await execute('espeak-ng', ['--stdout', '-v', voice, '-s', '175', '--stdin'], input, options);
        authorize();
        stage = 'normalize';
        const maxSeconds=format==='m4a'?MAX_M4A_SPEECH_SECONDS:MAX_SPEECH_SECONDS;
        const pcmLimit=PCM_BYTES_PER_SECOND*maxSeconds-(format==='m4a'?AAC_PADDING_BYTES:0);
        pcm = await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
          '-i', 'pipe:0', '-t', String(maxSeconds+1), '-vn', '-map_metadata', '-1', '-threads', '1', '-ar', '16000', '-ac', '1',
          '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], spoken, {...options, limit: pcmLimit});
        if (!pcm.length || pcm.length > pcmLimit || pcm.length % 2) throw new Error('Speech duration exceeded.');
        wave = pcm16Wave(pcm);
        authorize();
        if (format === 'wav') {
          const data = wave;
          wave = undefined;
          lastFailure = null;
          return {...formats.wav, data};
        }
        stage = 'encode';
        const codecs = {
          opus: ['-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-f', 'ogg'],
          mp3: ['-c:a', 'libmp3lame', '-f', 'mp3'],
          amr: ['-ar', '8000', '-c:a', 'libopencore_amrnb', '-f', 'amr'],
          // With no explicit fragment flush, FFmpeg writes one complete movie
          // with a duration header, even when the output is a pipe.
          m4a: ['-c:a', 'aac', '-movflags', '+frag_custom', '-f', 'ipod'],
        };
        encoded = await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
          '-i', 'pipe:0', '-vn', '-map_metadata', '-1', '-threads', '1', ...codecs[format], 'pipe:1'], wave, options);
        authorize();
        if (!encoded.length || encoded.length > MAX_MEDIA_BYTES) throw new Error('Speech output exceeded its bound.');
        const data = encoded;
        encoded = undefined;
        lastFailure = null;
        return {...formats[format], data, ...(format === 'opus' ? {voice: {
          durationSeconds: pcm.length / PCM_BYTES_PER_SECOND, waveform: pcmWaveform(pcm).toString('base64'),
          sha256: createHash('sha256').update(data).digest('hex'),
        }} : {})};
      } catch (error) {
        if (error?.code === -32012) throw error;
        lastFailure = stage;
        throw new BridgeError('Protected local speech conversion failed.', {status: 503, code: -32016});
      } finally {
        input?.fill(0); spoken?.fill(0); pcm?.fill(0); wave?.fill(0); encoded?.fill(0);
        try { lease?.close(); } finally { active = false; }
      }
    },
  };
}
